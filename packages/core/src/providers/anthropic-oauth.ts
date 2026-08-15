/**
 * Anthropic subscription OAuth — the "Connect Claude" browser-verification
 * flow, the same PKCE login Claude Code's `claude setup-token` / `/login` uses.
 * It produces a Claude Pro/Max subscription access+refresh token pair, so the
 * swarm can run on Claude billed against the subscription instead of API
 * pay-per-use.
 *
 * Credential safety: the resulting tokens are Anthropic's OWN credentials.
 * They are encrypted at rest in the existing AES-256-GCM credential store
 * (credentials/store.ts) and only ever leave the process as the `Authorization`
 * header on requests to Anthropic. They are never placed in a model prompt and
 * never sent to any other provider — the encrypted store is being used for
 * exactly what it exists for.
 *
 * This is a reverse-engineered, Claude-Code-scoped flow (not part of the
 * public Anthropic API), hence the fixed client id and the Claude Code system
 * identity the Messages API requires for subscription tokens — see
 * providers/anthropic.ts. Using it from a third-party app is at the operator's
 * discretion; the API-key path (providers.anthropic.apiKey) remains the
 * officially-sanctioned alternative.
 */

import { createHash, randomBytes } from "node:crypto";
import { childLogger } from "../logger.js";
import { getCredential, setCredential, deleteCredential } from "../credentials/store.js";

const log = childLogger("anthropic-oauth");

// Public, well-known Claude Code OAuth client (PKCE, no secret).
export const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// claude.ai issues SUBSCRIPTION-scoped grants (Pro/Max); platform.claude.com
// would bill the API org instead — we want the subscription here.
export const ANTHROPIC_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const ANTHROPIC_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// Manual code-paste flow: Anthropic's callback page renders the code for the
// operator to copy back into the dashboard. Robust regardless of where the
// gateway runs (behind NAT, in Docker, browser on another device).
export const ANTHROPIC_OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
export const ANTHROPIC_OAUTH_SCOPES = "org:create_api_key user:profile user:inference";

/** Credential-store key the encrypted token set lives under. */
const TOKEN_STORE_KEY = "anthropic_oauth";
/** Refresh proactively this far ahead of expiry so snapshots never go stale mid-call. */
const REFRESH_SKEW_MS = 120_000;

export interface AnthropicPkcePair {
  verifier: string;
  challenge: string;
}

export interface AnthropicTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 PKCE pair: random verifier + its S256 challenge. */
export function generatePkce(): AnthropicPkcePair {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Opaque CSRF/correlation value echoed back on the callback. */
export function generateOAuthState(): string {
  return base64Url(randomBytes(32));
}

export function buildAuthorizeUrl(challenge: string, state: string): string {
  const url = new URL(ANTHROPIC_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("code", "true"); // manual code-paste flow
  url.searchParams.set("client_id", ANTHROPIC_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", ANTHROPIC_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", ANTHROPIC_OAUTH_SCOPES);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

function toTokenSet(json: Record<string, unknown>, previousRefresh?: string): AnthropicTokenSet {
  const accessToken = typeof json["access_token"] === "string" ? json["access_token"] : "";
  // A refresh response may omit refresh_token — keep the prior one when so.
  const refreshToken = typeof json["refresh_token"] === "string" ? json["refresh_token"] : (previousRefresh ?? "");
  const expiresInSec = typeof json["expires_in"] === "number" ? json["expires_in"] : 3600;
  if (!accessToken || !refreshToken) {
    throw new Error("Anthropic OAuth token response missing access_token or refresh_token");
  }
  return { accessToken, refreshToken, expiresAt: Date.now() + expiresInSec * 1000 };
}

/** A token-endpoint failure, carrying just enough to decide whether retrying is futile. */
export class AnthropicOAuthError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(`Anthropic OAuth token request failed (HTTP ${status}${code ? `, ${code}` : ""})`);
    this.name = "AnthropicOAuthError";
  }
}

/** The OAuth2 `error` field only — a short enum like "invalid_grant", never the body. */
function extractOAuthErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const direct = parsed["error"];
    if (typeof direct === "string") return direct;
    if (direct && typeof direct === "object") {
      const nested = (direct as Record<string, unknown>)["type"] ?? (direct as Record<string, unknown>)["code"];
      if (typeof nested === "string") return nested;
    }
  } catch { /* not JSON — nothing safe to extract */ }
  return null;
}

/**
 * Whether a refresh can never succeed again, as opposed to failing right now.
 *
 * A dead refresh token answers 400 `invalid_grant` forever, so retrying it every four
 * minutes is not resilience — it is a permanent log fire that also hides real outages.
 * A 5xx or a network error is the opposite case and must keep retrying.
 */
export function isUnrecoverableOAuthFailure(err: unknown): boolean {
  if (!(err instanceof AnthropicOAuthError)) return false;
  if (err.code && ["invalid_grant", "invalid_client", "unauthorized_client", "invalid_request"].includes(err.code)) {
    return true;
  }
  return err.status === 400 || err.status === 401 || err.status === 403;
}

async function postToken(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // Don't echo the raw body verbatim into an error that may be logged widely —
    // it can contain token material on some error shapes. The short OAuth `error`
    // code is safe and is the difference between "retry later" and "this will never
    // work again", so it is extracted on its own.
    const code = extractOAuthErrorCode(text);
    log.warn({ status: res.status, code }, "Anthropic OAuth token endpoint returned an error");
    throw new AnthropicOAuthError(res.status, code);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("Anthropic OAuth token endpoint returned a non-JSON response");
  }
}

/**
 * Exchange the authorization code from the callback page for a token set.
 * The pasted code is `code#state`; we accept either the full string or a bare
 * code (with the original `state` as fallback).
 */
export async function exchangeAuthorizationCode(
  pastedCode: string,
  expectedState: string,
  verifier: string,
): Promise<AnthropicTokenSet> {
  const [code, stateFromCode] = pastedCode.trim().split("#");
  const json = await postToken({
    grant_type: "authorization_code",
    code,
    state: stateFromCode || expectedState,
    client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    redirect_uri: ANTHROPIC_OAUTH_REDIRECT_URI,
    code_verifier: verifier,
  });
  return toTokenSet(json);
}

export async function refreshAccessToken(refreshToken: string): Promise<AnthropicTokenSet> {
  const json = await postToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: ANTHROPIC_OAUTH_CLIENT_ID,
  });
  return toTokenSet(json, refreshToken);
}

// ─── Persisted token store (encrypted at rest) ───────────────────────────────

export function loadStoredTokenSet(): AnthropicTokenSet | null {
  try {
    const raw = getCredential(TOKEN_STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AnthropicTokenSet>;
    if (typeof parsed.accessToken === "string" && typeof parsed.refreshToken === "string" && typeof parsed.expiresAt === "number") {
      return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresAt: parsed.expiresAt };
    }
    return null;
  } catch (err) {
    log.error({ err }, "Failed to load stored Anthropic OAuth token set");
    return null;
  }
}

export function storeTokenSet(set: AnthropicTokenSet): void {
  setCredential(TOKEN_STORE_KEY, JSON.stringify(set));
  // A newly stored grant is the one thing that can undo a permanent failure, so the
  // latch clears here rather than requiring a restart after reconnecting.
  resetAnthropicRefreshFailure();
}

export function clearStoredTokenSet(): void {
  deleteCredential(TOKEN_STORE_KEY);
}

export function hasStoredOAuthToken(): boolean {
  return loadStoredTokenSet() !== null;
}

let _refreshInFlight: Promise<AnthropicTokenSet> | null = null;

/**
 * Return a non-expired access token, refreshing (once, even under concurrent
 * callers) when within the skew window. Returns null when nothing is connected.
 * On refresh failure the existing token is returned so a transient blip yields
 * a clear downstream 401 ("reconnect") rather than a confusing internal error.
 */
export async function getValidAccessToken(): Promise<string | null> {
  const current = loadStoredTokenSet();
  if (!current) return null;
  if (Date.now() < current.expiresAt - REFRESH_SKEW_MS) return current.accessToken;

  const inFlight = _refreshInFlight ?? (_refreshInFlight = (async () => {
    try {
      const next = await refreshAccessToken(current.refreshToken);
      storeTokenSet(next);
      log.info("Refreshed Anthropic OAuth access token");
      return next;
    } finally {
      _refreshInFlight = null;
    }
  })());

  try {
    return (await inFlight).accessToken;
  } catch (err) {
    // The current token is still returned so a transient blip surfaces downstream as a
    // clear 401 rather than an internal error. But a refusal that can never succeed is
    // recorded here, because this is the only place a refresh failure is observed —
    // the background refresher cannot see it, by design.
    if (isUnrecoverableOAuthFailure(err)) {
      noteUnrecoverableRefreshFailure(err);
    } else {
      log.error({ err }, "Anthropic OAuth token refresh failed — returning current token");
    }
    return current.accessToken;
  }
}

// ─── Background refresher ─────────────────────────────────────────────────────
// Keeps the stored snapshot fresh so containerized sub-agent dispatches (which
// capture a token snapshot at resolve time) never hand out an expiring token.

let _refreshTimer: ReturnType<typeof setInterval> | null = null;
/** Set when the stored grant is dead. Retrying it cannot help; only reconnecting can. */
let _refreshDisabledReason: string | null = null;

/** Why the refresher is not running, for the runtime status surface. null = healthy. */
export function anthropicRefreshDisabledReason(): string | null {
  return _refreshDisabledReason;
}

/** Clear the disabled latch — called after a successful reconnect stores a new grant. */
export function resetAnthropicRefreshFailure(): void {
  _refreshDisabledReason = null;
}

/** Latch a permanently refused grant, and say so exactly once. */
function noteUnrecoverableRefreshFailure(err: unknown): void {
  if (_refreshDisabledReason) return;
  _refreshDisabledReason =
    err instanceof AnthropicOAuthError && err.code ? err.code : "invalid_grant";
  log.error(
    { code: _refreshDisabledReason },
    "Anthropic OAuth grant is no longer valid — background refresh disabled. "
      + "Reconnect Claude in the dashboard (or re-run `claude setup-token` and set "
      + "CLAUDE_CODE_OAUTH_TOKEN) to restore it.",
  );
}

/**
 * Keep the stored token fresh, but only while that can accomplish something.
 *
 * Two conditions, and both were missing. The refresher started whenever a token file
 * existed, so a deployment that had once connected Claude and then moved to a local
 * model kept refreshing a credential nothing would ever use. And when the grant died it
 * kept trying every four minutes forever: an expired refresh token answers 400
 * `invalid_grant` permanently, so each attempt logged a warning that would never stop
 * and buried real problems underneath it.
 *
 * `shouldRun` is supplied by the caller because whether Anthropic is in use is a config
 * question, and this module deliberately knows nothing about config.
 */
export function startAnthropicTokenRefresher(
  shouldRun: () => boolean = () => true,
  intervalMs = 4 * 60_000,
): void {
  if (_refreshTimer) return;
  _refreshTimer = setInterval(() => {
    if (_refreshDisabledReason) return;
    // Re-checked every tick, not just at startup: connecting Claude, switching the
    // active preset, or reloading config must take effect without a restart.
    if (!shouldRun() || !hasStoredOAuthToken()) return;
    // getValidAccessToken records a permanently refused grant in the latch above; it
    // never rejects, so there is nothing to catch here beyond an unexpected throw.
    void getValidAccessToken().catch(() => undefined);
  }, intervalMs);
  _refreshTimer.unref?.();
}

export function stopAnthropicTokenRefresher(): void {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}
