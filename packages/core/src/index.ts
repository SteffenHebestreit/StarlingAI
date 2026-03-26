import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, watchConfig } from "./config/loader.js";
import { initProviders } from "./providers/index.js";
import { initPostgresAudit } from "./audit/postgres.js";
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
import { initSceneJobStore, shutdownSceneJobStore } from "./agent/jobs.js";
import { startSceneJobWorker, stopSceneJobWorker } from "./agent/scene-worker.js";
import { startSwarmBus, stopSwarmBus } from "./swarm/bus.js";
import { startAutonomousBidding, stopAutonomousBidding } from "./swarm/bidding.js";
import { startBidderWorker, stopBidderWorker } from "./swarm/bidder-worker.js";

// Import tools to register them (side-effect imports)
import "./tools/filesystem.js";
import "./tools/shell.js";
import "./tools/ssh.js";
import "./tools/ssh-upload.js";
import "./tools/ssh-download.js";
import "./tools/service-check.js";
import "./tools/ansible.js";
import "./tools/ansible-task.js";
import "./tools/proxmox.js";
import "./tools/terraform.js";
import "./tools/credentials.js";
import "./tools/sub-agent.js";
import "./tools/memory.js";
import "./tools/workspace-search.js";
import "./tools/web.js";
import "./tools/multimodal.js";
import "./tools/pentest.js";
import { syncWebhookTools } from "./tools/webhooks.js";

const log = childLogger("main");

export async function main() {
  log.info("StarlingAI starting...");
  const embeddedSceneWorkerEnabled = process.env["SAI_DISABLE_EMBEDDED_SCENE_WORKER"] !== "1";

  // Load and validate config
  const config = loadConfig();
  log.info({ model: config.agents.defaults.model.primary }, "Config loaded");

  // Initialize Postgres audit sink (optional)
  await initPostgresAudit();

  // Initialize durable scene-job storage before worker startup.
  await initSceneJobStore();

  // Check LLM provider health
  await initProviders();
  await syncModelEndpointRuntimeStatus();

  // Validate approval routing configuration
  syncApprovalRuntimeStatus();

  // Register config-driven webhook tools (must run after config is loaded)
  syncWebhookTools();

  // Connect configured MCP servers and bridge their tools
  await initMcpServers();

  // Start gateway (WS + REST)
  const gateway = createGateway();
  await gateway.start();

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

  // Watch config for hot reload
  watchConfig((newConfig, changedSections) => {
    log.info({ model: newConfig.agents.defaults.model.primary, changedSections }, "Config reloaded");
    void (async () => {
      markRuntimeComponentAttempt("config_reload");
      try {
        if (changedSections.includes("providers") || changedSections.includes("_initial")) {
          await initProviders();
        }
        if (["providers", "agents", "subAgents", "retrieval", "guardrails", "multimodal", "_initial"].some((section) => changedSections.includes(section))) {
          await syncModelEndpointRuntimeStatus();
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
    stopWarden();
    if (embeddedSceneWorkerEnabled) {
      await stopSceneJobWorker();
    }
    stopAutonomousBidding();
    stopBidderWorker();
    await stopSwarmBus();
    await stopManagedChannels();
    await gateway.stop();
    await shutdownSceneJobStore();
    await shutdownMcpServers();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  log.info(
    { wsPort: config.gateway.port },
    `StarlingAI ready — ws://localhost:${config.gateway.port}/ws`
  );

  // Print a login token to the logs on first start so the user can access the dashboard
  try {
    const token = await createToken("admin", { role: "admin" });
    log.info(`\n${"─".repeat(60)}\nGateway token (copy to dashboard login):\n${token}\n${"─".repeat(60)}`);
  } catch {
    log.warn("Could not generate login token — ensure SAI_JWT_SECRET is set");
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
