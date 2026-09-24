/**
 * Sub-agents API + assistant-personality + config-assistant/flow-memory routes, extracted
 * verbatim from the gateway god-file (gateway/index.ts createGateway()). Closure-free: the two
 * band-private zod schemas (MainAssistantPersonalityRequestSchema, FlowMemoryCreateSchema) were
 * createGateway closure consts used ONLY by these routes, so they move into the registrar body
 * with identical scope. Config via getConfig() (the cached singleton the closure captured).
 * Registered by createGateway() via registerSubAgentRoutes(app).
 */
import type { Hono } from "hono";
import { z } from "zod";
import { getConfig, previewConfigUpdate, updateConfig } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import { verifyToken, extractBearerToken, authenticatedUser, userHasRole } from "./auth.js";
import type { Context } from "hono";
import { childLogger } from "../logger.js";
import { PRODUCT } from "../product/index.js";
import { resolveAgentRouting } from "../tools/sub-agent.js";
import { appendFlowMemoryEntry, readFlowMemoryEntries } from "../agent/flow-memory.js";
import { listConversationConfigProposals } from "../agent/config-assistant-proposals.js";
import { agentModelSecretDestinations, maskConfigSecrets, refuseMovedSecrets, resolveSecretPlaceholders } from "./config-secrets.js";
import { secretEndpointContext } from "./secret-endpoint-context.js";
import {
  MainAssistantPersonalityEditableSchema,
  loadMainAssistantPersonality,
  resetMainAssistantPersonality,
  saveMainAssistantPersonality,
  clearMainAssistantPersonalityOverride,
} from "../personality/service.js";

const log = childLogger("gateway:sub-agent-routes");

export function registerSubAgentRoutes(app: Hono): void {
    // State-changing routes (sub-agent model, personality, flow-memory) require the
    // operator role — a read-only viewer must not mutate persisted swarm state or
    // redirect LLM traffic. Returns a 401/403 Response to short-circuit, or null when
    // authorized. (Pre-Wave-B tokens with no role claim normalize to "operator", so
    // legacy operator tokens keep working.)
    const requireOperator = async (c: Context): Promise<Response | null> => {
      const user = await authenticatedUser(c.req.header("Authorization"));
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      if (!userHasRole(user, "operator")) return c.json({ error: "Operator role required" }, 403);
      return null;
    };
    // Editing/resetting the SHARED global personality is an instance-wide admin
    // action under multi-user auth (a regular operator only edits their own
    // per-user override). Auth off → single operator → allowed.
    const requireGlobalAdmin = async (c: Context): Promise<Response | null> => {
      if (!getConfig().auth?.enabled) return null;
      const user = await authenticatedUser(c.req.header("Authorization"));
      if (!userHasRole(user, "admin")) return c.json({ error: "Admin role required to manage the global personality" }, 403);
      return null;
    };

    const MainAssistantPersonalityRequestSchema = MainAssistantPersonalityEditableSchema.extend({
      reason: z.string().trim().min(1).max(400).optional(),
    });
    const FlowMemoryCreateSchema = z.object({
      scope: z.enum(["setup", "enhancement", "prompt", "workflow"]),
      request: z.string().min(1).max(4000),
      summary: z.string().min(1).max(1200),
      assistantAgent: z.string().min(1).optional(),
      targetAgent: z.string().min(1).optional(),
      actions: z.array(z.string().min(1).max(240)).default([]),
      outcome: z.enum(["proposed", "applied", "success", "failure", "partial", "rejected"]),
      lesson: z.string().min(1).max(800).optional(),
      tags: z.array(z.string().min(1).max(40)).default([]),
    });

  // ── Sub-agents API ────────────────────────────────────────────────────────
  // GET   /api/agents            — list all configured sub-agents with their model config
  // PATCH /api/agents/:name/model — change a sub-agent's model config, saved to the config overlay

  // Every signed-in account can read this, so a sub-agent's key goes out masked (see config-secrets.ts).
  app.get("/api/agents", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const cfg = getConfig();
    const agents = Object.entries(cfg.subAgents ?? {}).map(([name, agent]) => ({
      name,
      description: agent.description,
      capabilities: agent.capabilities,
      tags: agent.tags,
      model: maskConfigSecrets(agent.model ?? {}),
      maxIterations: agent.maxIterations,
    }));
    return c.json(agents);
  });

  app.get("/api/agents/resolve", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const query = String(c.req.query("query") ?? "").trim();
    if (!query) return c.json({ error: "query is required" }, 400);

    const rawMinConfidence = String(c.req.query("minConfidence") ?? "medium");
    const minConfidence = rawMinConfidence === "high" || rawMinConfidence === "low"
      ? rawMinConfidence
      : "medium";

    return c.json(await resolveAgentRouting(query, { minConfidence }));
  });

  app.patch("/api/agents/:name/model", async (c) => {
    const denied = await requireOperator(c);
    if (denied) return denied;
    const name = c.req.param("name");
    if (!getConfig().subAgents?.[name]) return c.json({ error: `Agent '${name}' not found` }, 404);
    let body: Record<string, unknown>;
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    // SAVED, like every other settings change. It was patched into the loaded config only, so the
    // next save of any other setting, or a config file change, reloaded it from disk: the field
    // showed the patch until then and went back without a word, and the other saves' moved-key
    // rule, judged on the loaded config, read that going back as a key moving and refused them
    // (r3 A-security #1). So it is judged, like them, on the config as it loads from disk.
    let before: Config;
    try {
      before = previewConfigUpdate(() => {});
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
    const agent = before.subAgents?.[name];
    // Loaded but not saved: an A2A peer's skill, which the A2A client adds at runtime and which runs
    // remotely, on no model of ours.
    if (!agent) return c.json({ error: `Agent '${name}' is not in the saved config (an agent bridged from an A2A peer runs on the peer's model)` }, 409);
    const allowed = ["primary", "baseUrl", "apiKey", "temperature", "maxTokens", "topP", "topK", "minP", "repeatPenalty", "seed", "contextWindow", "enableThinking", "reasoningEffort"];
    // NULL MEANS CLEAR. A UI field emptied to "derive it per request" has no value to send,
    // and `undefined` does not survive JSON.stringify — the body arrived as `{}` and this loop
    // left the old pin in place, so the affordance could be used exactly once, to set it.
    // An empty model is no model, so it clears too: kept as "", it overrode the default's model with
    // nothing, and now that the patch is saved, for good (r4 A-security #1).
    // A masked key stands for the stored one, and a key goes only where it already went unless
    // this body typed it in: the same rule as the settings pages, over the whole config, because a
    // sub-agent with an endpoint of its own and no key of its own is sent the DEFAULT key there.
    const restored = resolveSecretPlaceholders(body, agent.model ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    const cleared: string[] = [];
    for (const key of allowed) {
      if (!(key in restored)) continue;
      const value = restored[key];
      if (value === null || (key === "primary" && typeof value === "string" && !value.trim())) cleared.push(key);
      else patch[key] = value;
    }
    const applyPatch = (raw: Record<string, unknown>) => {
      const subAgents = (raw["subAgents"] as Record<string, unknown> | undefined) ?? {};
      const saved = (subAgents[name] as Record<string, unknown> | undefined) ?? {};
      const model = { ...((saved["model"] as Record<string, unknown> | undefined) ?? {}), ...patch };
      for (const key of cleared) delete model[key];
      raw["subAgents"] = { ...subAgents, [name]: { ...saved, model } };
    };
    // A value the schema refuses (maxTokens under its floor, a baseUrl that is no URL) is refused
    // here; patched in memory it was taken as it came.
    let after: Config;
    try {
      after = previewConfigUpdate(applyPatch);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    const moved = refuseMovedSecrets(
      agentModelSecretDestinations(secretEndpointContext(before)),
      { subAgents: { [name]: { model: body } } },
      before,
      after,
    );
    if (!moved.ok) return c.json({ error: moved.error, details: { field: moved.field } }, 400);
    let updated: Config;
    try {
      updated = updateConfig(applyPatch);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
    log.info({ agent: name, patch: maskConfigSecrets(patch), cleared }, "Sub-agent model config saved");
    return c.json({ name, model: maskConfigSecrets(updated.subAgents[name]?.model ?? {}) });
  });

  // GET /api/agents/outcomes — per-agent execution stats from agent_outcomes.ndjson
  app.get("/api/agents/outcomes", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const { readFileSync, existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const workspacePath = getConfig().workspacePath;
    const outcomesFile = resolve(workspacePath, `${PRODUCT.stateDirName}/agent_outcomes.ndjson`);

    if (!existsSync(outcomesFile)) return c.json({ agents: [], totalEntries: 0 });

    type OutcomeRow = { ts: string; agent: string; task: string; outcome: string; iterations: number; totalTokens: number; lesson?: string };
    let entries: OutcomeRow[];
    try {
      entries = readFileSync(outcomesFile, "utf-8")
        .trim().split("\n").filter(Boolean)
        .map(line => { try { return JSON.parse(line) as OutcomeRow; } catch { return null; } })
        .filter((e): e is OutcomeRow => e !== null);
    } catch {
      return c.json({ agents: [], totalEntries: 0 });
    }

    const statsMap = new Map<string, { success: number; failure: number; partial: number; totalTokens: number; totalIterations: number; calls: number; latestLesson?: string; lastSeen: string }>();
    for (const e of entries) {
      const s = statsMap.get(e.agent) ?? { success: 0, failure: 0, partial: 0, totalTokens: 0, totalIterations: 0, calls: 0, lastSeen: "" };
      (s[e.outcome as "success" | "failure" | "partial"] as number)++;
      s.calls++;
      s.totalTokens += e.totalTokens ?? 0;
      s.totalIterations += e.iterations ?? 0;
      if (e.lesson) s.latestLesson = e.lesson;
      if (!s.lastSeen || e.ts > s.lastSeen) s.lastSeen = e.ts;
      statsMap.set(e.agent, s);
    }

    const agents = [...statsMap.entries()].map(([name, s]) => ({
      name,
      calls: s.calls,
      success: s.success,
      failure: s.failure,
      partial: s.partial,
      successRate: s.calls > 0 ? Math.round((s.success / s.calls) * 100) : 0,
      avgTokens: s.calls > 0 ? Math.round(s.totalTokens / s.calls) : 0,
      avgIterations: s.calls > 0 ? Math.round((s.totalIterations / s.calls) * 10) / 10 : 0,
      latestLesson: s.latestLesson,
      lastSeen: s.lastSeen,
    })).sort((a, b) => b.calls - a.calls);

    return c.json({ agents, totalEntries: entries.length });
  });

  app.get("/api/flow-memory", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 50;
    const entries = readFlowMemoryEntries(getConfig().workspacePath, limit).reverse();
    return c.json({ entries, totalEntries: entries.length });
  });

  app.post("/api/flow-memory", async (c) => {
    const denied = await requireOperator(c);
    if (denied) return denied;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = FlowMemoryCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid flow-memory entry", details: parsed.error.flatten() }, 400);
    }

    const entry = appendFlowMemoryEntry(getConfig().workspacePath, parsed.data);
    return c.json(entry, 201);
  });

  app.get("/api/config-assistant/proposals", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.trunc(limitRaw))) : 50;
    const proposals = listConversationConfigProposals(getConfig().workspacePath, limit);
    return c.json({ proposals, totalEntries: proposals.length });
  });

  app.get("/api/personality", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    return c.json(loadMainAssistantPersonality());
  });

  app.put("/api/personality", async (c) => {
    const denied = await requireOperator(c);
    if (denied) return denied;
    // ?scope=global edits the SHARED persona (admin); default edits the caller's override.
    const wantGlobal = c.req.query("scope") === "global";
    if (wantGlobal) {
      const adminDenied = await requireGlobalAdmin(c);
      if (adminDenied) return adminDenied;
    }
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const parsed = MainAssistantPersonalityRequestSchema.parse(body);
      const profile = saveMainAssistantPersonality(parsed, {
        updatedBy: "user",
        reason: parsed.reason,
        global: wantGlobal,
        revisionBase: loadMainAssistantPersonality().revision,
      });
      return c.json(profile);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/personality/reset", async (c) => {
    const denied = await requireOperator(c);
    if (denied) return denied;
    // ?scope=global resets the SHARED persona to default (admin).
    if (c.req.query("scope") === "global") {
      const adminDenied = await requireGlobalAdmin(c);
      if (adminDenied) return adminDenied;
      return c.json(resetMainAssistantPersonality("user", "Reset global from dashboard", { global: true }));
    }
    // Otherwise "reset" clears the caller's OVERRIDE → fall back to the global
    // persona. With no override (single-operator, or already global), reset the
    // base persona to the built-in default.
    if (clearMainAssistantPersonalityOverride()) {
      return c.json(loadMainAssistantPersonality());
    }
    return c.json(resetMainAssistantPersonality("user", "Reset from dashboard"));
  });
}
