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
import {
  ANTHROPIC_MODEL_CHOICES,
  fetchAnthropicModelChoices,
  forgetAnthropicOutputLimits,
  isAnthropicOAuthCredential,
  type AnthropicModelChoice,
} from "../providers/anthropic.js";
import { resolveProviderEndpointForModel } from "../providers/index.js";
import { getValidAccessToken } from "../providers/anthropic-oauth.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";

const log = childLogger("gateway:model-preset");

/**
 * Last successful LIVE listing, if any. Process-local and deliberately not
 * persisted: a restart re-asks Anthropic rather than serving a catalogue from a
 * previous deployment, which is the staleness this whole path exists to fix.
 *
 * The GET serves this when present so opening the dashboard does not spend an
 * upstream call per visit; the explicit refresh always bypasses it.
 */
let liveModelChoices: { choices: AnthropicModelChoice[]; refreshedAt: string } | null = null;

/**
 * Whether this process has already attempted a listing, successfully or not.
 *
 * Without this the feature would be a MANUAL button and nothing more: the cache
 * has exactly one writer, so every gateway boot would serve the hand-maintained
 * fallback until a human happened to click Refresh. That is not removing the
 * staleness, only adding an escape hatch for it. The first GET therefore warms
 * the catalogue itself.
 *
 * The flag is what stops that becoming an upstream call per dashboard visit when
 * listing is not permitted at all: an inference-scoped subscription token 403s
 * here and would do so every single time. One attempt per process, then the
 * button is the retry.
 */
let listingAttempted = false;

/** Forget the catalogue. Called wherever the credential behind it can change. */
function invalidateLiveModelChoices(): void {
  liveModelChoices = null;
  listingAttempted = false;
  // The learned output ceilings came from the same listing and are scoped to the
  // same entitlements, so they go with it.
  forgetAnthropicOutputLimits();
}

/**
 * Resolve the credential the Claude provider itself would use, so the listing is
 * scoped to exactly the models the swarm can actually call. A connected
 * subscription is read through getValidAccessToken (refreshing if due) rather
 * than off the stored snapshot, which may be expired.
 */
async function resolveAnthropicListingCredential(): Promise<{ credential: string; baseUrl: string; oauthMode: boolean } | null> {
  const config = getConfig();
  const model = config.providers.anthropic?.defaultModel ?? "claude-sonnet-4-6";
  const endpoint = resolveProviderEndpointForModel(`anthropic/${model}`, {}, config);
  const stored = loadStoredTokenSet();
  const managedOAuth = stored !== null && endpoint.apiKey === stored.accessToken;
  const credential = managedOAuth ? (await getValidAccessToken()) ?? "" : endpoint.apiKey;
  if (!credential) return null;
  // OR the sniff in rather than trusting `managedOAuth` alone: a manually pasted
  // providers.anthropic.authToken is a subscription token that this browser flow
  // knows nothing about, and an explicit `false` here would bypass the prefix
  // check and send it as x-api-key, which the API rejects.
  const oauthMode = managedOAuth || isAnthropicOAuthCredential(credential);
  return { credential, baseUrl: endpoint.baseUrl, oauthMode };
}

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
      // A different account has different entitlements; the cached catalogue
      // belongs to whoever was connected before.
      invalidateLiveModelChoices();
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
    // The first read of the process warms the catalogue, so the picker is live
    // by default rather than only after someone finds the Refresh button.
    // Failures are quiet here: the built-in list is a complete answer, and the
    // user did not ask for a refresh, they opened a dialog.
    if (!listingAttempted) {
      listingAttempted = true;
      try {
        const resolved = await resolveAnthropicListingCredential();
        if (resolved) {
          const choices = await fetchAnthropicModelChoices(resolved);
          liveModelChoices = { choices, refreshedAt: new Date().toISOString() };
        }
      } catch (err) {
        log.debug({ err }, "Initial Anthropic model listing failed - serving the built-in list");
      }
    }
    return c.json({
      model: config.providers.anthropic?.defaultModel ?? "claude-sonnet-4-6",
      choices: liveModelChoices?.choices ?? ANTHROPIC_MODEL_CHOICES,
      source: liveModelChoices ? "live" : "builtin",
      refreshedAt: liveModelChoices?.refreshedAt ?? null,
    });
  });

  // Re-ask Anthropic which models this credential can use. POST, not GET,
  // because it spends an upstream call — the plain GET stays free.
  app.post("/api/models/anthropic/model/refresh", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);

    const resolved = await resolveAnthropicListingCredential();
    if (!resolved) {
      // No credential is not an error the user can act on by retrying. A
      // catalogue already fetched stays on screen rather than being discarded,
      // the same choice the error path below makes and for the same reason.
      return c.json({
        choices: liveModelChoices?.choices ?? ANTHROPIC_MODEL_CHOICES,
        source: liveModelChoices ? "live" : "builtin",
        refreshedAt: liveModelChoices?.refreshedAt ?? null,
        warning: "No Anthropic credential configured — connect a subscription or set an API key.",
      });
    }

    try {
      const choices = await fetchAnthropicModelChoices(resolved);
      liveModelChoices = { choices, refreshedAt: new Date().toISOString() };
      listingAttempted = true;
      logAudit("anthropic_models_refreshed", { count: choices.length, oauthMode: resolved.oauthMode });
      return c.json({ choices, source: "live", refreshedAt: liveModelChoices.refreshedAt });
    } catch (err) {
      // The documented reason this list was static: inference-scoped subscription
      // tokens may not be permitted to call /v1/models. Say so rather than
      // failing the request — the built-in list plus free-text entry still works.
      const message = err instanceof Error ? err.message : String(err);
      const cached = liveModelChoices;
      log.warn({ err }, "Anthropic model listing failed");
      // The warning has to describe what is actually on screen. Saying "showing
      // the built-in list" while returning source:"live" with a cached catalogue
      // told the user the opposite of what the same response rendered.
      return c.json({
        choices: cached?.choices ?? ANTHROPIC_MODEL_CHOICES,
        source: cached ? "live" : "builtin",
        refreshedAt: cached?.refreshedAt ?? null,
        ...(cached ? { stale: true } : {}),
        warning: cached
          ? `Could not refresh from Anthropic (${message}). Still showing the list fetched earlier, which may be out of date.`
          : `Could not list models from Anthropic (${message}). Showing the built-in list; any model id can still be typed in.`,
      });
    }
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
      choices: liveModelChoices?.choices ?? ANTHROPIC_MODEL_CHOICES,
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
    // The catalogue was scoped to the credential that just went away;
    // continuing to serve it as source:"live" is exactly the dressed-up
    // staleness this path exists to remove.
    invalidateLiveModelChoices();
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
