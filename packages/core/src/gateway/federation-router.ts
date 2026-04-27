/**
 * Federation HTTP routes — exposed only when `federation.enabled` is true in
 * config.  Inbound auth is HMAC JWT (HS256) over the shared secret, NOT the
 * regular user-facing JWT.  Routes:
 *
 *   GET  /api/federation/health        — peer probe, returns instanceId + uptime
 *   GET  /api/federation/capabilities  — advertises agents + tier-1/2 tool surface
 *   POST /api/federation/delegate      — runs a sub-agent locally on behalf of a peer
 *
 * The peer enforces its own tool tiers, agent allowlist, and humanInLoopSteps —
 * federation never bypasses local guardrails.
 */
import type { Hono } from "hono";
import { getConfig } from "../config/loader.js";
import {
  verifyFederationToken,
  getFederationConfig,
  FEDERATION_PROTOCOL_VERSION,
  type FederationCapability,
  type FederationDelegateResponse,
} from "../federation/index.js";
import { ToolTier, getToolTier } from "../guardrails/tool-tiers.js";
import { getAllTools } from "../tools/registry.js";
import { runSubAgentWithStats } from "../agent/sub-agent.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";

const log = childLogger("federation:router");

const STARTED_AT = Date.now();

interface DelegateBody {
  agentName?: unknown;
  task?: unknown;
  context?: unknown;
  originSessionId?: unknown;
  timeoutMs?: unknown;
}

/**
 * Mount /api/federation/* on the gateway.  Safe to call unconditionally —
 * each route checks federation.enabled at request time and returns 404 when
 * disabled, so flipping the config flag at runtime takes effect without a
 * restart.
 */
export function mountFederationRoutes(app: Hono): void {
  // Health probe — used by remote peers to verify we are reachable.
  app.get("/api/federation/health", async (c) => {
    const config = getFederationConfig();
    if (!config.enabled) return c.json({ error: "federation disabled" }, 404);

    const token = extractBearer(c.req.header("Authorization"));
    const verified = await verifyFederationToken(token);
    if (!verified) {
      logAudit("federation_auth_failed", { route: "health" }, { severity: "warn" });
      return c.json({ error: "Unauthorized" }, 401);
    }

    return c.json({
      ok: true,
      instanceId: config.instanceId,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      uptimeMs: Date.now() - STARTED_AT,
    });
  });

  // Capability advertisement — agents + tier 1/2 tools the peer may delegate to.
  app.get("/api/federation/capabilities", async (c) => {
    const config = getFederationConfig();
    if (!config.enabled) return c.json({ error: "federation disabled" }, 404);

    const token = extractBearer(c.req.header("Authorization"));
    const verified = await verifyFederationToken(token);
    if (!verified) {
      logAudit("federation_auth_failed", { route: "capabilities" }, { severity: "warn" });
      return c.json({ error: "Unauthorized" }, 401);
    }

    const capability = buildCapabilitySnapshot();
    logAudit("federation_capabilities_served", { peer: verified.issuer, agents: capability.agents.length, tools: capability.toolNames.length });
    return c.json(capability);
  });

  // Inbound delegation — run the named sub-agent locally and return the result.
  app.post("/api/federation/delegate", async (c) => {
    const config = getFederationConfig();
    if (!config.enabled) return c.json({ error: "federation disabled" }, 404);

    const token = extractBearer(c.req.header("Authorization"));
    const verified = await verifyFederationToken(token);
    if (!verified) {
      logAudit("federation_auth_failed", { route: "delegate" }, { severity: "warn" });
      return c.json({ error: "Unauthorized" }, 401);
    }

    let body: DelegateBody;
    try {
      body = await c.req.json<DelegateBody>();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" } satisfies FederationDelegateResponse, 400);
    }

    const agentName = typeof body.agentName === "string" ? body.agentName.trim() : "";
    const task = typeof body.task === "string" ? body.task : "";
    const context = typeof body.context === "string" ? body.context : undefined;
    const originSessionId = typeof body.originSessionId === "string" ? body.originSessionId : undefined;
    const timeoutMs = typeof body.timeoutMs === "number" && body.timeoutMs > 0
      ? Math.min(body.timeoutMs, config.delegationTimeoutMs)
      : config.delegationTimeoutMs;

    if (!agentName || !task) {
      return c.json({ ok: false, error: "agentName and task are required" } satisfies FederationDelegateResponse, 400);
    }

    // Honor exposeAgents allowlist when configured.  Empty list = all agents.
    if (config.exposeAgents.length > 0 && !config.exposeAgents.includes(agentName)) {
      logAudit("federation_delegate_denied", { peer: verified.issuer, agentName, reason: "not in exposeAgents allowlist" }, { severity: "warn" });
      return c.json({ ok: false, error: `agent '${agentName}' is not exposed via federation` } satisfies FederationDelegateResponse, 403);
    }

    const subAgentCfg = getConfig().subAgents[agentName];
    if (!subAgentCfg) {
      return c.json({ ok: false, error: `unknown agent '${agentName}'` } satisfies FederationDelegateResponse, 404);
    }

    const remoteSessionId = `fed:${verified.issuer}:${originSessionId ?? "anon"}:${Date.now()}`;
    logAudit("federation_request_received", {
      peer: verified.issuer,
      agentName,
      originSessionId: originSessionId ?? null,
      remoteSessionId,
      taskPreview: task.slice(0, 240),
      timeoutMs,
    }, { sessionId: remoteSessionId });

    try {
      const result = await runSubAgentWithStats({
        agentName,
        task,
        context,
        parentSessionId: remoteSessionId,
        workspacePath: getConfig().workspacePath,
        turnTimeoutOverrideMs: timeoutMs,
      });
      logAudit("federation_request_completed", {
        peer: verified.issuer,
        agentName,
        remoteSessionId,
        terminalState: result.stats.terminalState ?? null,
        toolCount: result.stats.toolCount,
        iterations: result.stats.iterations,
        promptTokens: result.stats.usage.promptTokens,
        completionTokens: result.stats.usage.completionTokens,
      }, { sessionId: remoteSessionId });
      return c.json({
        ok: true,
        output: result.output,
        remoteSessionId,
        stats: {
          terminalState: result.stats.terminalState,
          iterations: result.stats.iterations,
          toolCount: result.stats.toolCount,
          toolNames: result.stats.toolNames,
          usage: result.stats.usage,
          model: result.stats.model,
        },
      } satisfies FederationDelegateResponse);
    } catch (err) {
      const message = (err as Error).message;
      log.error({ err: message, agentName, remoteSessionId }, "federation delegation failed");
      logAudit("federation_request_failed", { peer: verified.issuer, agentName, remoteSessionId, error: message }, { sessionId: remoteSessionId, severity: "error" });
      return c.json({ ok: false, error: message, remoteSessionId } satisfies FederationDelegateResponse, 500);
    }
  });
}

function extractBearer(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function buildCapabilitySnapshot(): FederationCapability {
  const config = getConfig();
  const fedConfig = config.federation;
  const agentNames = fedConfig.exposeAgents.length > 0
    ? fedConfig.exposeAgents.filter((name) => config.subAgents[name])
    : Object.keys(config.subAgents);

  const agents = agentNames.map((name) => {
    const cfg = config.subAgents[name];
    return {
      name,
      description: cfg?.description,
      capabilities: cfg?.capabilities ?? [],
      tags: cfg?.tags ?? [],
    };
  });

  // Only advertise tier 1/2 tools — tier 3+ require admin consent and are
  // not appropriate to expose across instance boundaries.
  const toolNames = getAllTools()
    .map((t) => t.name)
    .filter((name) => {
      const tier = getToolTier(name).tier;
      return tier === ToolTier.ZERO_READ_ONLY || tier === ToolTier.ONE_WRITE || tier === ToolTier.TWO_EXECUTE;
    })
    .sort();

  return {
    instanceId: fedConfig.instanceId,
    version: "0.7.0",
    protocolVersion: FEDERATION_PROTOCOL_VERSION,
    agents,
    toolNames,
    generatedAt: new Date().toISOString(),
  };
}
