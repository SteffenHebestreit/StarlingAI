import "dotenv/config";
import { initTracing, shutdownTracing } from "./observability/tracing.js";
import { startCostAggregator, stopCostAggregator } from "./observability/cost.js";
import { startTimeseriesTelemetry, stopTimeseriesTelemetry } from "./observability/telemetry.js";
import { logSecretHygiene } from "./observability/secret-hygiene.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, watchConfig, getConfig } from "./config/loader.js";
import { buildAgentIndex } from "./providers/embeddings.js";
import { getEmbeddingProvider, initProviders } from "./providers/index.js";
import { initPostgresAudit } from "./audit/postgres.js";
import { flushAuditLog } from "./audit/logger.js";
import { createGateway } from "./gateway/index.js";
import { createToken } from "./gateway/auth.js";
import { childLogger } from "./logger.js";
import { initMcpServers, shutdownMcpServers, syncMcpServers } from "./mcp/registry.js";
import { stopManagedChannels, syncAllChannels } from "./channels/runtime.js";
import { runChannelHealthChecks } from "./channels/registry.js";
import { markRuntimeComponentAttempt, markRuntimeComponentFailure, markRuntimeComponentSuccess } from "./runtime/status.js";
import { syncModelEndpointRuntimeStatus } from "./runtime/model-endpoints.js";
import { syncApprovalRuntimeStatus } from "./approval/status.js";
import { startWarden, stopWarden } from "./agent/warden.js";
import { startEventLoopMonitor, stopEventLoopMonitor } from "./observability/event-loop-monitor.js";
import { startProviderActivityMonitor, stopProviderActivityMonitor } from "./observability/provider-activity-monitor.js";
import { startRecoveryMetrics, stopRecoveryMetrics } from "./observability/recovery-metrics.js";
import { initSceneJobStore, shutdownSceneJobStore } from "./agent/jobs.js";
import { startSceneJobWorker, stopSceneJobWorker } from "./agent/scene-worker.js";
import { initSessionRedis, startSessionPruner, stopSessionPruner } from "./agent/session.js";
import { startCacheWarmer, stopCacheWarmer } from "./agent/cache-warmer.js";
import { closeSessionRedis } from "./agent/session-redis.js";
import { syncConfiguredJobTriggers } from "./runtime/job-triggers.js";
import { rehydrateScheduledTasks } from "./runtime/scheduled-task-runner.js";
import { startSwarmBus, stopSwarmBus } from "./swarm/bus.js";
import { startAutonomousBidding, stopAutonomousBidding } from "./swarm/bidding.js";
import { startBidderWorker, stopBidderWorker } from "./swarm/bidder-worker.js";

// Ephemeral store + dynamic tools
import { initEphemeralStore, registerEphemeralCleanupCron, shutdownEphemeralStore } from "./runtime/ephemeral-store/index.js";
import { loadDynamicTools, watchDynamicToolsDirectory, shutdownDynamicTools } from "./tools/dynamic-tools.js";
import { loadPlugins, watchPluginsDirectory, stopPluginWatcher } from "./plugin/loader.js";
import { loadCoreExtensions, runExtensionBoot, runExtensionShutdown } from "./extension/loader.js";
import { loadCheckpointsFromDisk } from "./swarm/checkpoints.js";
import { closeGraphDb } from "./db/neo4j.js";
import { initGraphSchema } from "./db/graph-schema.js";
import { initVectorStore, closeVectorStore } from "./db/vector-store.js";
import { startGraphJobs } from "./runtime/graph-jobs.js";
import { loadPersistedSessions } from "./agent/tool-dev-session.js";
import { loadPersistedGaps } from "./agent/self-improve.js";

// Register all built-in tools (side-effect imports, via the shared barrel so the
// gateway and the offline eval harnesses register an identical tool surface).
import "./tools/register-builtins.js";
import "./personality/service.js";
import { syncWebhookTools } from "./tools/webhooks.js";

import { stopAllCronJobs } from "./runtime/scheduler.js";
import { PRODUCT } from "./product/index.js";

const log = childLogger("main");

/**
 * Boot the gateway process: loads config, starts the Postgres audit sink,
 * MemGraph schema bootstrap, scene-job store, Redis session cache, LLM
 * provider health checks, webhook sync, retrieval/runtime daemons, the
 * embedded scene worker (unless `SAI_DISABLE_EMBEDDED_SCENE_WORKER=1`), and
 * finally the HTTP + WebSocket listeners on `config.gateway.port`.
 *
 * Called from the package entrypoint; not expected to return before the
 * process exits. Side effects include binding sockets, writing to the
 * filesystem, and connecting to every configured backing service.
 */
export async function main() {
  log.info(`${PRODUCT.name} starting...`);
  const embeddedSceneWorkerEnabled = process.env["SAI_DISABLE_EMBEDDED_SCENE_WORKER"] !== "1";

  // Surface missing/weak/placeholder secrets before they break things downstream
  // (JWT signing falls back to a random per-boot secret; the credential store
  // throws on first use). One warning per finding so the operator can fix and
  // restart without parsing exceptions.
  logSecretHygiene();

  // Load and validate config
  const config = loadConfig();
  log.info({ model: config.agents.defaults.model.primary }, "Config loaded");

  // Bootstrap OpenTelemetry tracing as early as possible so subsequent
  // initialization steps inherit the tracing context.  No-op when disabled.
  await initTracing(config.tracing);

  // Cost aggregator subscribes to audit events; safe to start unconditionally
  // (handler is a no-op when cost.enabled is false).
  startCostAggregator();

  // Mirror system metrics (LLM usage/cost, tool latency, sub-agent runs) into
  // QuestDB as durable time-series; no-op when QUESTDB_URL is unset.
  startTimeseriesTelemetry();

  // Initialize Postgres audit sink (optional)
  await initPostgresAudit();

  // Bootstrap MemGraph schema (indexes + vector index) — safe to call when unavailable
  await initGraphSchema();

  // Initialize durable scene-job storage before worker startup.
  await initSceneJobStore();

  // Seed in-process session cache from Redis (multi-instance session sharding).
  await initSessionRedis();

  // Check LLM provider health
  await initProviders();
  await syncModelEndpointRuntimeStatus();

  // Initialize the unified pgvector semantic store (probes the embedding model
  // for its dimension, so it must run after providers). Re-attempts lazily on
  // first use if the model is not ready yet; no-op without pgvector.
  await initVectorStore();

  // Validate approval routing configuration
  syncApprovalRuntimeStatus();

  // Register config-driven webhook tools (must run after config is loaded)
  syncWebhookTools();

  // Connect configured MCP servers and bridge their tools
  await initMcpServers();

  // Initialize ephemeral data stores (Redis, Postgres)
  await initEphemeralStore();
  registerEphemeralCleanupCron();

  // Load self-developed dynamic tools and start hot-deploy watcher
  loadDynamicTools();
  watchDynamicToolsDirectory();

  // Load third-party plugin packages from the configured plugins directory.
  // Errors during a single plugin's load are non-fatal — the loader logs
  // them and continues so a broken plugin can't take down the gateway.
  if (config.plugins?.enabled !== false) {
    try {
      const result = await loadPlugins();
      if (result.loaded > 0 || result.rejected > 0) {
        log.info({ loaded: result.loaded, rejected: result.rejected }, "Plugin SDK loader complete");
      }
      // Watch for new plugins added at runtime so operators can drop a
      // .mjs file into the plugins directory without restarting.
      watchPluginsDirectory();
    } catch (err) {
      log.warn({ err }, "Plugin SDK loader threw — continuing without plugins");
    }
  }

  // Load first-party core extensions (src/extensions/<name>/ — fork-owned
  // domain packages; see extension/index.ts). Registration adds their tools,
  // tiers, roles, guardrail hooks, and audit events; boot hooks then run their
  // async init (db schemas, knowledge loads). Both phases are per-extension
  // fault-isolated, so a broken extension cannot take down the gateway.
  try {
    const ext = await loadCoreExtensions();
    if (ext.loaded > 0 || ext.failed > 0) {
      log.info({ loaded: ext.loaded, failed: ext.failed, dir: ext.dir }, "Core extension loader complete");
    }
    await runExtensionBoot();
  } catch (err) {
    log.warn({ err }, "Core extension loader threw — continuing without extensions");
  }

  // Recover persisted dev sessions, capability gaps, and task checkpoints
  await loadPersistedSessions();
  await loadPersistedGaps();
  loadCheckpointsFromDisk(getConfig().workspacePath);

  // Pre-warm tool embeddings now that every loader (built-ins, MCP bridge,
  // plugins, dynamic tools) has registered.  The first `rerankToolsForTask`
  // call in a live turn is otherwise a thundering herd against the embedding
  // provider; warming up here amortizes that cost into startup.
  try {
    const { warmToolEmbeddings } = await import("./tools/registry.js");
    const warm = await warmToolEmbeddings();
    if (warm.warmed > 0 || warm.skipped > 0) {
      log.info(
        { warmed: warm.warmed, skipped: warm.skipped, durationMs: warm.durationMs },
        "Tool embeddings warmed",
      );
      const { logAudit } = await import("./audit/logger.js");
      logAudit("tool_embeddings_warmed", {
        warmed: warm.warmed,
        skipped: warm.skipped,
        durationMs: warm.durationMs,
        source: "startup",
      });
    }
  } catch (err) {
    log.warn({ err }, "Tool embedding warm-up failed — continuing with lazy embeddings");
  }

  // Start the event-loop lag monitor before the gateway accepts traffic so any
  // main-thread stall (the real "gateway went unhealthy during a long local-model
  // call" cause) is measured and audited from the first request.
  startEventLoopMonitor();
  // In-flight provider visibility: is the remote LLM producing tokens, still
  // processing the prompt, or stalled? (The provider runs on a separate machine.)
  startProviderActivityMonitor();
  // Count which orchestration recovery nets actually fire (audit-stream subscriber)
  // so dead scaffolding can be retired with evidence. Persisted across restarts —
  // "this net hasn't fired in N weeks" is only meaningful when redeploys don't
  // reset the clock. (The scene worker stays in-memory: it can share this cwd, and
  // two writers would clobber each other's stats file.)
  startRecoveryMetrics({ persist: true });

  // Start gateway (WS + REST)
  const gateway = createGateway();
  await gateway.start();

  syncConfiguredJobTriggers(config.gateway.turnTimeoutMs);
  // Re-activate runtime-created standing-agent schedules persisted to disk so they
  // survive a restart (boot-only — config reload re-syncs config triggers, not these).
  rehydrateScheduledTasks();

  // Start the scene-job worker after the API is ready unless an external worker is managing the queue.
  if (embeddedSceneWorkerEnabled) {
    await startSceneJobWorker();
  } else {
    log.info("Embedded scene worker disabled; expecting an external scene worker process");
  }

  // Start and reconcile dashboard-managed channels
  await syncAllChannels();

  // Channel health check interval (60s)
  const healthInterval = setInterval(() => { void runChannelHealthChecks(); }, 60_000);

  // Start swarm event bus (Redis Pub/Sub with in-process fallback)
  await startSwarmBus();

  // Start first-pass autonomous bidding over the swarm bus
  startAutonomousBidding();

  // Start long-running bidder worker (independent autonomous bidding process)
  await startBidderWorker();

  // Start Warden — background anomaly monitor
  startWarden();

  // Start the archived-session pruner (gateway.sessionTtlMs / agents.sessionPruneIntervalMs)
  // so ended sessions don't accumulate unbounded in the store + Redis.
  startSessionPruner();

  // Ensure the upload bucket exists when using S3 storage (SeaweedFS starts empty).
  // Fire-and-forget so a slow/absent object store never blocks boot.
  void import("./storage/object-store.js").then(({ ensureUploadBucket }) => ensureUploadBucket()).catch(() => undefined);

  // Prompt-cache warm-keeper (agents.performance.promptCacheWarmKeeper, default off):
  // keep the orchestrator's base-prompt KV prefix warm during idle so the first turn
  // after boot / a delegating turn doesn't pay the cold prefill. No-op when disabled.
  startCacheWarmer();

  // Start the Skill Library self-improvement driver — periodically retires low
  // performers, archives duplicates, and promotes proven skills to scenes.
  if (getConfig().skillLibrary.enabled) {
    const { startSkillImprovementDriver } = await import("./skills/driver.js");
    startSkillImprovementDriver();
  }

  // Start the sleep-time memory consolidation driver — periodic idle pass that
  // compacts near-duplicate durable memory and backfills missing embeddings.
  if (getConfig().memory.sleepTimeConsolidation) {
    const { startMemoryConsolidationDriver } = await import("./memory/driver.js");
    startMemoryConsolidationDriver();
  }

  // Start the capability-gap → tool-development driver. Detection (recordCapabilityGap)
  // always runs, but the consumer that drives "proposed" gaps into ToolDevSessions was
  // never started — a severed loop. It self-guards on selfImprovement.enabled and unref()s,
  // so this is a no-op while the feature is off.
  if (getConfig().selfImprovement.enabled) {
    const { startSelfImprovementDriver } = await import("./agent/self-improve.js");
    startSelfImprovementDriver();
  }

  // Start transitive federation peer discovery (no-op when disabled)
  const { startPeerDiscovery } = await import("./federation/index.js");
  startPeerDiscovery();

  // Start public A2A client — pulls each configured peer's agent card and
  // registers every advertised skill as a virtual sub-agent.  No-op when
  // a2a.enabled is false.
  try {
    const { startA2AClient } = await import("./a2a/client.js");
    await startA2AClient();
  } catch (err) {
    log.warn({ err }, "A2A client failed to start — peer skills will be unavailable");
  }

  // Start MemGraph background jobs (centrality, community detection, similarity links)
  startGraphJobs();

  // Watch config for hot reload
  watchConfig((newConfig, changedSections) => {
    log.info({ model: newConfig.agents.defaults.model.primary, changedSections }, "Config reloaded");
    void (async () => {
      markRuntimeComponentAttempt("config_reload");
      try {
        if (changedSections.includes("providers") || changedSections.includes("_initial")) {
          await initProviders();
        }
        if (!changedSections.includes("providers") && !changedSections.includes("_initial") && (changedSections.includes("agents") || changedSections.includes("subAgents"))) {
          const embeddingModel = newConfig.agents.defaults.model.embeddingModel;
          if (embeddingModel) {
            buildAgentIndex(newConfig.subAgents ?? {}, getEmbeddingProvider(), embeddingModel).catch(() => undefined);
          }
        }
        if (["providers", "agents", "subAgents", "retrieval", "guardrails", "multimodal", "_initial"].some((section) => changedSections.includes(section))) {
          // Fire-and-forget: this probes every provider chain + embeddings/vision/
          // reranker/guard with 10s timeouts under Promise.all, so awaiting it inside
          // the reload handler stalls hot-reload up to 10s behind an unreachable
          // endpoint. It only feeds the health dashboard (own markRuntimeComponent
          // marks), so let it settle in the background. Boot call (above) stays awaited.
          void syncModelEndpointRuntimeStatus().catch(() => undefined);
        }
        if (changedSections.includes("jobs") || changedSections.includes("scenes") || changedSections.includes("_initial")) {
          syncConfiguredJobTriggers(newConfig.gateway.turnTimeoutMs);
        }
        syncApprovalRuntimeStatus();
        if (changedSections.includes("webhooks") || changedSections.includes("_initial")) {
          syncWebhookTools();
        }
        if (changedSections.includes("mcp") || changedSections.includes("_initial")) {
          await syncMcpServers();
        }
        if (changedSections.includes("channels") || changedSections.includes("_initial")) {
          await syncAllChannels();
        }
        markRuntimeComponentSuccess("config_reload", { model: newConfig.agents.defaults.model.primary, changedSections });
      } catch (err) {
        markRuntimeComponentFailure("config_reload", err, { model: newConfig.agents.defaults.model.primary });
      }
    })();
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, "Shutting down...");
    clearInterval(healthInterval);
    stopCacheWarmer();
    stopEventLoopMonitor();
    stopProviderActivityMonitor();
    stopRecoveryMetrics();
    stopWarden();
    stopSessionPruner();
    try {
      const { stopSkillImprovementDriver } = await import("./skills/driver.js");
      stopSkillImprovementDriver();
    } catch {
      // best-effort
    }
    try {
      const { stopMemoryConsolidationDriver } = await import("./memory/driver.js");
      stopMemoryConsolidationDriver();
    } catch {
      // best-effort
    }
    try {
      const { stopAnthropicTokenRefresher } = await import("./providers/anthropic-oauth.js");
      stopAnthropicTokenRefresher();
    } catch {
      // best-effort
    }
    const { stopPeerDiscovery } = await import("./federation/index.js");
    stopPeerDiscovery();
    try {
      const { stopA2AClient } = await import("./a2a/client.js");
      stopA2AClient();
    } catch {
      // best-effort
    }
    if (embeddedSceneWorkerEnabled) {
      await stopSceneJobWorker();
    }
    stopAutonomousBidding();
    stopBidderWorker();
    await stopSwarmBus();
    await stopManagedChannels();
    await gateway.stop();
    await shutdownSceneJobStore();
    try {
      const { shutdownMcpHttpSessions } = await import("./mcp/server-http.js");
      await shutdownMcpHttpSessions();
    } catch {
      // best-effort
    }
    await shutdownMcpServers();
    shutdownDynamicTools();
    await runExtensionShutdown();
    stopPluginWatcher();
    stopCostAggregator();
    stopTimeseriesTelemetry();
    await shutdownEphemeralStore();
    await closeGraphDb();
    await closeVectorStore();
    stopAllCronJobs();
    await flushAuditLog();
    await closeSessionRedis();
    try {
      const { closeRedis } = await import("./guardrails/redis-client.js");
      await closeRedis();
    } catch {
      // best-effort
    }
    await shutdownTracing();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Survive a stray un-awaited rejection instead of letting it crash the whole
  // gateway (and every in-flight turn). A rejection is logged with context and
  // swallowed; an uncaught exception is logged then triggers a graceful shutdown
  // (the process is in an unknown state, so exit diagnosably rather than limp on).
  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason instanceof Error ? reason : new Error(String(reason)) }, "Unhandled promise rejection — swallowed to keep the gateway alive");
  });
  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "Uncaught exception — shutting down gracefully");
    void shutdown("uncaughtException");
  });

  log.info(
    { wsPort: config.gateway.port },
    `${PRODUCT.name} ready — ws://localhost:${config.gateway.port}/ws`
  );

  // Single-operator convenience: when multi-user auth is OFF, print a bootstrap
  // admin token so the operator can reach the dashboard. When auth is ENABLED, do
  // NOT mint a standing max-privilege token — it would bypass the whole RBAC/user
  // system and can't be revoked without rotating the JWT secret (which logs
  // everyone out). Operators log in with a configured account instead.
  if (getConfig().auth?.enabled !== true) {
    try {
      const token = await createToken("admin", { role: "admin" });
      log.info(`\n${"─".repeat(60)}\nGateway token (auth is OFF — copy to dashboard login):\n${token}\n${"─".repeat(60)}`);
    } catch {
      log.warn("Could not generate login token — ensure SAI_JWT_SECRET is set");
    }
  } else {
    log.info("Multi-user auth is enabled — log in with a configured account (no bootstrap token is printed).");
  }
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return resolve(entrypoint) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  main().catch(err => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
}
