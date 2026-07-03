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
import { searchWorkspace } from "../tools/workspace-search.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { withExtractedContext, withSpan } from "../observability/tracing.js";

const log = childLogger("federation:router");

const STARTED_AT = Date.now();

interface DelegateBody {
  agentName?: unknown;
  task?: unknown;
  context?: unknown;
  originSessionId?: unknown;
  timeoutMs?: unknown;
}

interface SearchBody {
  query?: unknown;
  maxResults?: unknown;
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
    // A token minted for health/capabilities must not authorize code-executing
    // delegation — the `purpose` claim is otherwise decorative.
    if (verified.purpose !== "delegate") {
      logAudit("federation_auth_failed", { route: "delegate", reason: "wrong-purpose", purpose: verified.purpose }, { severity: "warn" });
      return c.json({ error: "token purpose does not permit delegation" }, 403);
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

    // Extract inbound trace context (W3C traceparent) so spans produced by
    // runSubAgentWithStats become children of the calling instance's span.
    const inboundHeaders: Record<string, string> = {};
    for (const k of ["traceparent", "tracestate", "baggage"]) {
      const v = c.req.header(k);
      if (v) inboundHeaders[k] = v;
    }

    try {
      const result = await withExtractedContext(inboundHeaders, () =>
        withSpan(`federation.inbound ${agentName}`, {
          "starlingai.federation.peer": verified.issuer,
          "starlingai.federation.agent": agentName,
          "starlingai.federation.streaming": false,
        }, () => runSubAgentWithStats({
          agentName,
          task,
          context,
          parentSessionId: remoteSessionId,
          workspacePath: getConfig().workspacePath,
          turnTimeoutOverrideMs: timeoutMs,
        })),
      );
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

  // Known-peers advertisement — used by the transitive discovery loop.
  // Returns the union of configured peers + currently-reachable discovered
  // peers (id + url + tags only — no secrets and no capability snapshots).
  // The trust gate is the same federation HMAC, so a caller already proves
  // they hold the shared secret before learning who else holds it.
  app.get("/api/federation/peers-known", async (c) => {
    const config = getFederationConfig();
    if (!config.enabled) return c.json({ error: "federation disabled" }, 404);

    const token = extractBearer(c.req.header("Authorization"));
    const verified = await verifyFederationToken(token);
    if (!verified) {
      logAudit("federation_auth_failed", { route: "peers-known" }, { severity: "warn" });
      return c.json({ error: "Unauthorized" }, 401);
    }

    const { listAllKnownPeers } = await import("../federation/index.js");
    const known = listAllKnownPeers().map((p) => ({
      id: p.id,
      url: p.url,
      tags: p.tags,
      source: p.source,
    }));
    return c.json({ instanceId: config.instanceId, peers: known });
  });

  // Workspace search — runs the peer's local workspace_search and returns
  // ranked snippets to the broadcaster for cross-instance retrieval.
  app.post("/api/federation/search", async (c) => {
    const config = getFederationConfig();
    if (!config.enabled) return c.json({ error: "federation disabled" }, 404);

    const token = extractBearer(c.req.header("Authorization"));
    const verified = await verifyFederationToken(token);
    if (!verified) {
      logAudit("federation_auth_failed", { route: "search" }, { severity: "warn" });
      return c.json({ error: "Unauthorized" }, 401);
    }

    let body: SearchBody;
    try {
      body = await c.req.json<SearchBody>();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }

    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) return c.json({ ok: false, error: "query is required" }, 400);
    const requestedMax = typeof body.maxResults === "number" && body.maxResults > 0 ? body.maxResults : 10;
    const maxResults = Math.min(30, Math.max(1, Math.floor(requestedMax)));

    const startedAt = Date.now();
    const matches = searchWorkspace(getConfig().workspacePath, query, maxResults);
    const durationMs = Date.now() - startedAt;
    logAudit("federation_search_served", { peer: verified.issuer, query: query.slice(0, 80), maxResults, matched: matches.length, durationMs });
    return c.json({
      ok: true,
      instanceId: getFederationConfig().instanceId,
      matches,
      durationMs,
    });
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
    version: "0.7.1",
    protocolVersion: FEDERATION_PROTOCOL_VERSION,
    agents,
    toolNames,
    generatedAt: new Date().toISOString(),
  };
}
