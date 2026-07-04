/**
 * Model-preset switch (dashboard "Local ⇄ Claude") + Claude subscription OAuth.
 *
 *   GET/POST /api/models/preset            — read / activate a model preset
 *   /api/models/anthropic/oauth/{status,start,complete,disconnect} — PKCE login
 *   GET/POST /api/models/anthropic/model   — pick the Claude model for the preset
 *
 * Extracted verbatim from gateway/index.ts (god-file seam). Closure-free — all
 * helpers are module-level imports. The Anthropic OAuth token is the user's own
 * credential: encrypted at rest, only ever sent to Anthropic as the auth header.
 */
import type { Hono } from "hono";
import { verifyToken, extractBearerToken } from "./auth.js";
import { getConfig, updateConfig } from "../config/loader.js";
import { getActiveModelPreset, listModelPresets } from "../providers/index.js";
import {
  generatePkce,
  generateOAuthState,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  storeTokenSet,
  clearStoredTokenSet,
  loadStoredTokenSet,
} from "../providers/anthropic-oauth.js";
import { ANTHROPIC_MODEL_CHOICES } from "../providers/anthropic.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";

const log = childLogger("gateway:model-preset");

export function registerModelPresetRoutes(app: Hono): void {
  // ── Model presets: the dashboard "Local ⇄ Claude" switch ───────────────────
  // GET returns the configured default model, the switchable presets (incl.
  // the implicit "claude" preset when providers.anthropic is credentialed),
  // and which one is active. POST activates a preset (or null → back to the
  // configured default) and persists the choice in the runtime overlay.
  app.get("/api/models/preset", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const config = getConfig();
    const active = getActiveModelPreset(config);
    return c.json({
      active: active?.name ?? null,
      activePrimary: active?.preset.primary ?? null,
      defaultPrimary: config.agents.defaults.model.primary,
      scope: config.agents.defaults.modelPresetScope ?? "all",
      presets: listModelPresets(config),
    });
  });

  app.post("/api/models/preset", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // Accepts { preset?: string | null, scope?: "all" | "unspecified" | "coordinator_qa" }.
    // At least one field must be present; each is applied to the runtime overlay independently, so
    // the scope can be changed without re-selecting the preset (and vice versa).
    const hasPreset = typeof body === "object" && body !== null && "preset" in body;
    const hasScope = typeof body === "object" && body !== null && "scope" in body;
    if (!hasPreset && !hasScope) {
      return c.json({ error: "Body must include 'preset' and/or 'scope'" }, 400);
    }
    const requested = (body as { preset?: unknown }).preset;
    if (hasPreset && requested !== null && typeof requested !== "string") {
      return c.json({ error: "'preset' must be a string or null" }, 400);
    }
    const PRESET_SCOPES = ["all", "unspecified", "coordinator_qa"] as const;
    const requestedScope = (body as { scope?: unknown }).scope;
    if (hasScope && (typeof requestedScope !== "string" || !PRESET_SCOPES.includes(requestedScope as typeof PRESET_SCOPES[number]))) {
      return c.json({ error: `'scope' must be one of ${PRESET_SCOPES.join(", ")}` }, 400);
    }

    const config = getConfig();
    const previous = config.agents.defaults.activeModelPreset ?? null;
    const previousScope = config.agents.defaults.modelPresetScope ?? "all";
    if (hasPreset && typeof requested === "string" && !listModelPresets(config).some((p) => p.name === requested)) {
      return c.json({ error: `Unknown model preset '${requested}'` }, 400);
    }

    const updated = updateConfig((raw) => {
      const agents = (raw["agents"] as Record<string, unknown> | undefined) ?? {};
      const defaults = (agents["defaults"] as Record<string, unknown> | undefined) ?? {};
      const nextDefaults = { ...defaults };
      // "" (falsy → no active preset) instead of delete: the runtime overlay is
      // a diff against the base config, so a deletion could not switch the
      // preset off if the base config ever sets one.
      if (hasPreset) nextDefaults["activeModelPreset"] = requested ?? "";
      if (hasScope) nextDefaults["modelPresetScope"] = requestedScope;
      raw["agents"] = { ...agents, defaults: nextDefaults };
    });

    const active = getActiveModelPreset(updated);
    logAudit("model_preset_switched", {
      from: previous,
      to: active?.name ?? null,
      primary: active?.preset.primary ?? updated.agents.defaults.model.primary,
      scopeFrom: previousScope,
      scopeTo: updated.agents.defaults.modelPresetScope ?? "all",
    });

    return c.json({
      active: active?.name ?? null,
      activePrimary: active?.preset.primary ?? null,
      defaultPrimary: updated.agents.defaults.model.primary,
      scope: updated.agents.defaults.modelPresetScope ?? "all",
      presets: listModelPresets(updated),
    });
  });

  // ── Claude subscription OAuth (browser verification) ───────────────────────
  // Same PKCE login Claude Code uses. `start` returns the authorize URL + the
  // PKCE verifier/state held by the dashboard (the OAuth client); `complete`
  // exchanges the pasted code for a token set, encrypted at rest in the
  // credential store. The token is Anthropic's own credential — never put in a
  // prompt, only sent to Anthropic as the auth header.
  app.get("/api/models/anthropic/oauth/status", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const stored = loadStoredTokenSet();
    return c.json({
      connected: stored !== null,
      expiresAt: stored ? new Date(stored.expiresAt).toISOString() : null,
    });
  });

  app.post("/api/models/anthropic/oauth/start", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const { verifier, challenge } = generatePkce();
    const state = generateOAuthState();
    return c.json({
      authorizeUrl: buildAuthorizeUrl(challenge, state),
      verifier,
      state,
    });
  });

  app.post("/api/models/anthropic/oauth/complete", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    let body: { code?: unknown; verifier?: unknown; state?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body.code !== "string" || typeof body.verifier !== "string" || typeof body.state !== "string") {
      return c.json({ error: "Body must be { code, verifier, state }" }, 400);
    }
    if (!body.code.trim()) return c.json({ error: "Authorization code is required" }, 400);

    try {
      const tokenSet = await exchangeAuthorizationCode(body.code, body.state, body.verifier);
      storeTokenSet(tokenSet);
      logAudit("anthropic_oauth_connected", { expiresAt: new Date(tokenSet.expiresAt).toISOString() });
      return c.json({ connected: true, expiresAt: new Date(tokenSet.expiresAt).toISOString() });
    } catch (err) {
      log.error({ err }, "Anthropic OAuth code exchange failed");
      return c.json({ error: err instanceof Error ? err.message : "Token exchange failed" }, 400);
    }
  });

  // ── Claude model selection for the implicit "claude" preset ───────────────
  // The dashboard picker writes providers.anthropic.defaultModel (runtime
  // overlay). A curated list is served because subscription tokens may not be
  // scoped for /v1/models; free-text ids are accepted for anything newer.
  app.get("/api/models/anthropic/model", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const config = getConfig();
    return c.json({
      model: config.providers.anthropic?.defaultModel ?? "claude-sonnet-4-6",
      choices: ANTHROPIC_MODEL_CHOICES,
    });
  });

  app.post("/api/models/anthropic/model", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    let body: { model?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model || model.length > 100 || !/^[a-z0-9][a-z0-9.:_-]*$/i.test(model)) {
      return c.json({ error: "Body must be { model: \"claude-...\" } (bare Anthropic model id)" }, 400);
    }

    const previous = getConfig().providers.anthropic?.defaultModel ?? "claude-sonnet-4-6";
    const updated = updateConfig((raw) => {
      const providers = (raw["providers"] as Record<string, unknown> | undefined) ?? {};
      const anthropic = (providers["anthropic"] as Record<string, unknown> | undefined) ?? {};
      raw["providers"] = { ...providers, anthropic: { ...anthropic, defaultModel: model } };
    });

    logAudit("model_preset_switched", { claudeModelFrom: previous, claudeModelTo: model });

    const active = getActiveModelPreset(updated);
    return c.json({
      model,
      choices: ANTHROPIC_MODEL_CHOICES,
      // Refresh payload for the preset pill (tooltip/active primary may change).
      active: active?.name ?? null,
      activePrimary: active?.preset.primary ?? null,
      defaultPrimary: updated.agents.defaults.model.primary,
      presets: listModelPresets(updated),
    });
  });

  app.post("/api/models/anthropic/oauth/disconnect", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    // If the active preset is the implicit Claude one, fall back to local so the
    // swarm doesn't strand on an unauthenticated cloud model.
    const wasActive = getActiveModelPreset(getConfig());
    clearStoredTokenSet();
    if (wasActive?.name === "claude") {
      updateConfig((raw) => {
        const agents = (raw["agents"] as Record<string, unknown> | undefined) ?? {};
        const defaults = (agents["defaults"] as Record<string, unknown> | undefined) ?? {};
        raw["agents"] = { ...agents, defaults: { ...defaults, activeModelPreset: "" } };
      });
    }
    logAudit("anthropic_oauth_disconnected", {});
    return c.json({ connected: false });
  });
}
