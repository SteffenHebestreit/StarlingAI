/**
 * OpenID Connect (Keycloak) identity backend.
 *
 * Selected via `auth.provider = "oidc"`. Provides:
 *   - Human SSO: PKCE authorization-code flow (buildLoginUrl → handleCallback),
 *     mapping the IdP's roles onto our operator/viewer/admin and returning an
 *     identity the gateway mints OUR session JWT from (rest of the system unchanged).
 *   - Machine A2A: a cached client-credentials service token for OUTBOUND peer
 *     calls, and JWKS validation of INBOUND peer tokens (peers trust the same issuer).
 *
 * Built on the spec-correct `openid-client` (v6) for the OAuth flows and `jose`
 * for inbound JWKS validation. Discovery is lazy + cached per issuer+clientId.
 */
import * as oidc from "openid-client";
import { Agent, fetch as undiciFetch } from "undici";
import { createRemoteJWKSet, jwtVerify, customFetch as joseCustomFetch, type JWTPayload } from "jose";
import { getConfig } from "../config/loader.js";
import { resolveSecretRef } from "../tools/infrastructure-shared.js";
import { childLogger } from "../logger.js";
import type { AuthRole, OidcConfig } from "../config/schema.js";
import { normalizeRole } from "./auth.js";

const log = childLogger("gateway:oidc");

export const OIDC_CALLBACK_PATH = "/api/auth/oidc/callback";

export interface OidcIdentity {
  username: string;
  role: AuthRole;
  displayName?: string;
  email?: string;
}

// ── Discovery (cached) ─────────────────────────────────────────────────────────

let _discovery: { key: string; config: oidc.Configuration } | null = null;

function oidcConfig(): OidcConfig {
  const cfg = getConfig().auth.oidc;
  if (!cfg) throw new Error("auth.provider is 'oidc' but auth.oidc is not configured");
  return cfg;
}

// DEV-only: a fetch bound to an undici dispatcher that skips TLS verification,
// used ONLY for OIDC requests when auth.oidc.insecureSkipTlsVerify is set (e.g. a
// Keycloak behind an internal/self-signed CA the container doesn't trust). Scoped
// here via customFetch — it never affects the process's other TLS traffic.
let _insecureDispatcher: Agent | null = null;
function insecureOidcFetch(): typeof undiciFetch {
  if (!_insecureDispatcher) _insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  const dispatcher = _insecureDispatcher;
  return ((input, init) => undiciFetch(input, { ...init, dispatcher })) as typeof undiciFetch;
}

/** Discover (and cache) the issuer configuration for the active OIDC settings. */
export async function getOidcDiscovery(): Promise<oidc.Configuration> {
  const cfg = oidcConfig();
  const clientSecret = cfg.clientSecret ? resolveSecretRef(cfg.clientSecret) : undefined;
  const key = `${cfg.issuer}|${cfg.clientId}`;
  if (_discovery && _discovery.key === key) return _discovery.config;
  const insecure = cfg.insecureSkipTlsVerify;
  const config = await oidc.discovery(
    new URL(cfg.issuer),
    cfg.clientId,
    clientSecret,
    undefined,
    // @ts-expect-error undici fetch is fetch-compatible; the type signatures differ slightly
    insecure ? { [oidc.customFetch]: insecureOidcFetch() } : undefined,
  );
  if (insecure) {
    // Reuse the insecure fetch for the token + JWKS requests the Configuration makes.
    // @ts-expect-error undici fetch is fetch-compatible; the type signatures differ slightly
    config[oidc.customFetch] = insecureOidcFetch();
    log.warn({ issuer: cfg.issuer }, "OIDC TLS verification DISABLED (auth.oidc.insecureSkipTlsVerify) — DEV ONLY");
  }
  _discovery = { key, config };
  log.info({ issuer: cfg.issuer, clientId: cfg.clientId }, "OIDC issuer discovered");
  return config;
}

/** Test-only: drop the cached discovery + service token. */
export function _resetOidcForTests(): void {
  _discovery = null;
  _serviceToken = null;
  _jwks = null;
}

// ── Human SSO (authorization-code + PKCE) ───────────────────────────────────────

export interface OidcLoginStart {
  /** The IdP authorization URL to redirect the browser to. */
  url: string;
  /** PKCE verifier + state to stash server-side (keyed by a login id) for the callback. */
  codeVerifier: string;
  state: string;
}

/** The gateway's public base URL (configured publicUrl, else the request origin). */
export function oidcPublicBase(requestOrigin?: string): string {
  return (oidcConfig().publicUrl ?? getConfig().gateway.publicUrl ?? requestOrigin ?? "").replace(/\/$/, "");
}

/** Redirect URI the IdP calls back — `{publicBase}/api/auth/oidc/callback`. */
export function oidcRedirectUri(requestOrigin?: string): string {
  return `${oidcPublicBase(requestOrigin)}${OIDC_CALLBACK_PATH}`;
}

// ── Login-state store (PKCE verifier + state survive the IdP redirect) ──────────
// Keyed by the anti-CSRF `state`, which round-trips through the IdP, so no cookie
// is needed. Short TTL; single-use (consumed on callback).
interface LoginStateEntry { codeVerifier: string; createdAt: number; }
const _loginStates = new Map<string, LoginStateEntry>();
const LOGIN_STATE_TTL_MS = 600_000; // 10 minutes

export function stashLoginState(state: string, codeVerifier: string): void {
  const cutoff = Date.now() - LOGIN_STATE_TTL_MS;
  for (const [k, v] of _loginStates) if (v.createdAt < cutoff) _loginStates.delete(k);
  _loginStates.set(state, { codeVerifier, createdAt: Date.now() });
}

/** Consume the stored verifier for `state` (single-use). Null if missing/expired. */
export function takeLoginState(state: string): string | null {
  const entry = _loginStates.get(state);
  if (!entry) return null;
  _loginStates.delete(state);
  return Date.now() - entry.createdAt > LOGIN_STATE_TTL_MS ? null : entry.codeVerifier;
}

/** Build the IdP login URL (PKCE S256 + anti-CSRF state). */
export async function buildLoginUrl(requestOrigin?: string): Promise<OidcLoginStart> {
  const cfg = oidcConfig();
  const config = await getOidcDiscovery();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: oidcRedirectUri(requestOrigin),
    scope: cfg.scopes.join(" "),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  }).href;
  return { url, codeVerifier, state };
}

/**
 * Complete the callback: exchange the code, validate the ID token, and map the
 * IdP identity + roles onto an OidcIdentity the gateway mints our JWT from.
 * Throws on any validation failure (the caller returns 401).
 */
export async function handleCallback(
  currentUrl: string,
  codeVerifier: string,
  expectedState: string,
): Promise<OidcIdentity> {
  const cfg = oidcConfig();
  const config = await getOidcDiscovery();
  const tokens = await oidc.authorizationCodeGrant(config, new URL(currentUrl), {
    pkceCodeVerifier: codeVerifier,
    expectedState,
  });
  const claims = tokens.claims();
  if (!claims) throw new Error("OIDC token response carried no ID-token claims");
  return identityFromClaims(cfg, claims);
}

/** Map validated token claims → our identity (username + role), enforcing role mapping. */
function identityFromClaims(cfg: OidcConfig, claims: JWTPayload): OidcIdentity {
  const username = pickClaim(claims, cfg.usernameClaim) ?? (typeof claims.sub === "string" ? claims.sub : undefined);
  if (!username) throw new Error(`OIDC token missing username claim '${cfg.usernameClaim}'`);
  const roles = extractRoles(claims, cfg.rolesClaim);
  const role = mapRole(cfg, roles);
  if (!role) throw new Error(`OIDC user '${username}' has no mapped role (${roles.join(", ") || "no roles"}) and no defaultRole`);
  const displayName = pickClaim(claims, "name") ?? pickClaim(claims, "preferred_username");
  const email = pickClaim(claims, "email");
  return { username: username.toLowerCase(), role, displayName, email };
}

/** admin → operator → viewer (most-privileged listed role wins); else defaultRole. */
export function mapRole(cfg: OidcConfig, roles: string[]): AuthRole | null {
  const has = (list: string[]) => list.some((r) => roles.includes(r));
  const m = cfg.roleMapping;
  if (has(m.admin)) return "admin";
  if (has(m.operator)) return "operator";
  if (has(m.viewer)) return "viewer";
  return m.defaultRole ? normalizeRole(m.defaultRole) : null;
}

/** Read a possibly dotted claim path (e.g. "realm_access.roles") as a string. */
function pickClaim(claims: JWTPayload, path: string): string | undefined {
  const v = readPath(claims, path);
  return typeof v === "string" ? v : undefined;
}

/** Read the roles array at a dotted claim path (Keycloak: realm_access.roles). */
function extractRoles(claims: JWTPayload, path: string): string[] {
  const v = readPath(claims, path);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function readPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

// ── Machine A2A (client-credentials outbound + JWKS inbound) ─────────────────────

let _serviceToken: { token: string; expiresAt: number } | null = null;

/**
 * A cached OIDC client-credentials service token for OUTBOUND A2A calls. Refreshed
 * ~30s before expiry. Requires a confidential client (clientSecret) — throws otherwise.
 */
export async function getA2aServiceToken(): Promise<string> {
  const cfg = oidcConfig();
  if (!cfg.a2a.enabled) throw new Error("auth.oidc.a2a.enabled is false — no A2A service token");
  const now = Date.now();
  if (_serviceToken && _serviceToken.expiresAt - 30_000 > now) return _serviceToken.token;
  const config = await getOidcDiscovery();
  const params: Record<string, string> = {};
  if (cfg.scopes.length) params["scope"] = cfg.scopes.join(" ");
  if (cfg.a2a.audience) params["audience"] = cfg.a2a.audience;
  const tokens = await oidc.clientCredentialsGrant(config, params);
  if (!tokens.access_token) throw new Error("OIDC client-credentials grant returned no access_token");
  const ttlMs = (typeof tokens.expires_in === "number" ? tokens.expires_in : 300) * 1000;
  _serviceToken = { token: tokens.access_token, expiresAt: now + ttlMs };
  return _serviceToken.token;
}

let _jwks: { key: string; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

async function getJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const config = await getOidcDiscovery();
  const jwksUri = config.serverMetadata().jwks_uri;
  if (!jwksUri) throw new Error("OIDC issuer advertises no jwks_uri");
  if (_jwks && _jwks.key === jwksUri) return _jwks.jwks;
  const jwks = createRemoteJWKSet(
    new URL(jwksUri),
    // @ts-expect-error undici fetch is fetch-compatible; the type signatures differ slightly
    oidcConfig().insecureSkipTlsVerify ? { [joseCustomFetch]: insecureOidcFetch() } : undefined,
  );
  _jwks = { key: jwksUri, jwks };
  return jwks;
}

/**
 * Validate an INBOUND A2A bearer token against the issuer's JWKS (signature,
 * issuer, and — when configured — audience). Returns the claims, or null on any
 * failure. Never throws.
 */
export async function verifyInboundA2aToken(token: string): Promise<JWTPayload | null> {
  try {
    const cfg = oidcConfig();
    const jwks = await getJwks();
    const { payload } = await jwtVerify(token, jwks, {
      issuer: cfg.issuer,
      ...(cfg.a2a.audience ? { audience: cfg.a2a.audience } : {}),
    });
    return payload;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "Inbound A2A token failed JWKS validation");
    return null;
  }
}
