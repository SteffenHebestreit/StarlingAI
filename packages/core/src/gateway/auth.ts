import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";

import { PRODUCT } from "../product/index.js";
import { getExtensionRole, getExtensionAuthProvider } from "../extension/index.js";
import { extensionAccountId, sameAccountId, type PrincipalKind } from "../runtime/accounts.js";
import {
  accountRegistryEntryById,
  accountRegistryHoldsAccounts,
  recordAccountRegistryBootstrapSub,
} from "../runtime/account-registry.js";

const log = childLogger("gateway:auth");
const BCRYPT_ROUNDS = 12;

// Cached secret so we only hit the filesystem once per process
let _jwtSecret: Uint8Array | null = null;

// Rate limiting for auth failures — per IP
const failureCounts = new Map<string, { count: number; firstFailAt: number }>();
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 300_000; // 5 minutes
const MAX_TRACKED_IPS = 10_000; // Prevent OOM DoS by bounding map size
const JWT_SECRET_PATH = resolveJwtSecretPath();

// Periodically prune expired entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of failureCounts) {
    if (now - entry.firstFailAt > FAILURE_WINDOW_MS) {
      failureCounts.delete(ip);
    }
  }
}, FAILURE_WINDOW_MS).unref();

function getJwtSecret(): Uint8Array {
  if (_jwtSecret) return _jwtSecret;

  // 1. Prefer explicit env var (allows overriding in CI / production)
  const envSecret = process.env["SAI_JWT_SECRET"];
  if (envSecret && envSecret.length >= 32) {
    _jwtSecret = new TextEncoder().encode(envSecret);
    return _jwtSecret;
  }

  // 2. Respect validated config value when no env override is present
  const configSecret = getConfig().gateway.jwtSecret;
  if (configSecret && configSecret.length >= 32) {
    _jwtSecret = new TextEncoder().encode(configSecret);
    return _jwtSecret;
  }

  // 3. Fall back to persisted auto-generated secret file
  try {
    const stored = readFileSync(JWT_SECRET_PATH, "utf8").trim();
    if (stored.length >= 32) {
      _jwtSecret = new TextEncoder().encode(stored);
      return _jwtSecret;
    }
  } catch {
    // File doesn't exist yet — generate below
  }

  // 4. Generate a fresh cryptographically random secret and persist it
  const generated = randomBytes(32).toString("hex"); // 64-char hex
  try {
    mkdirSync(dirname(JWT_SECRET_PATH), { recursive: true });
    writeFileSync(JWT_SECRET_PATH, generated, { mode: 0o600 }); // owner-read-only
    log.info({ path: JWT_SECRET_PATH }, "Generated and saved new JWT secret");
  } catch (err) {
    log.warn({ err }, "Could not persist JWT secret — tokens will not survive restart");
  }
  _jwtSecret = new TextEncoder().encode(generated);
  return _jwtSecret;
}

export async function createToken(
  userId: string,
  claims?: Record<string, unknown>,
  expiresIn: string | number = "24h",
): Promise<string> {
  return new SignJWT({ sub: userId, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(getJwtSecret());
}

/**
 * Verify a SESSION token. A token carrying a `scope` claim is a narrow
 * capability token (e.g. a fork's single-resource media token), not a session:
 * it must never pass the general auth gates, so it is rejected here and only
 * accepted by `verifyScopedToken` at the route that owns its scope. Without
 * this, a leaked scoped token would work as a full bearer credential on every
 * `verifyToken`-gated route for its TTL.
 */
export async function verifyToken(token: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    if (payload.scope !== undefined) return null; // capability token, not a session
    return payload;
  } catch {
    return null;
  }
}

/**
 * Verify a scoped CAPABILITY token minted via `createToken(uid, { scope, ... })`.
 * Returns the payload only when the signature is valid AND the token's `scope`
 * claim equals `scope` — a session token (no scope) or a different scope is
 * rejected, so one capability can never be replayed as another.
 */
export async function verifyScopedToken(token: string, scope: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    if (payload.scope !== scope) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function checkAuthRateLimit(ip: string): { allowed: boolean; retriesRemaining: number } {
  const now = Date.now();
  const entry = failureCounts.get(ip);

  if (!entry || now - entry.firstFailAt > FAILURE_WINDOW_MS) {
    return { allowed: true, retriesRemaining: MAX_FAILURES };
  }

  if (entry.count >= MAX_FAILURES) {
    return { allowed: false, retriesRemaining: 0 };
  }

  return { allowed: true, retriesRemaining: MAX_FAILURES - entry.count };
}

export function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = failureCounts.get(ip);
  if (!entry || now - entry.firstFailAt > FAILURE_WINDOW_MS) {
    if (failureCounts.size >= MAX_TRACKED_IPS) {
      // Very crude eviction to prevent memory exhaustion
      const firstKey = failureCounts.keys().next().value;
      if (firstKey) failureCounts.delete(firstKey);
    }
    failureCounts.set(ip, { count: 1, firstFailAt: now });
  } else {
    entry.count++;
  }

  logAudit("auth_failure", { ip }, { severity: "warn" });
  log.warn({ ip }, "Auth failure recorded");
}

export function clearAuthFailures(ip: string): void {
  failureCounts.delete(ip);
}

/**
 * Extract bearer token from Authorization header.
 * Returns null if missing or malformed.
 */
export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

/**
 * Role identifier. Upstream ships "viewer" (read-only), "operator" (full
 * per-user access), and "admin" (operator + instance-wide administration, e.g.
 * editing the shared global personality). Core extensions register additional
 * roles (with ranks) via their manifest — see extension/index.ts. Unknown role
 * claims normalize to "operator" for pre-Wave-B token compatibility.
 */
export type AuthRole = string;

/** Built-in role ranks; extension roles carry their own rank in the registry. */
const BUILTIN_ROLE_RANKS: Record<string, number> = { viewer: 10, operator: 50, admin: 90 };

/** Rank for any known role name; unknown roles rank as -1 (never sufficient). */
export function roleRank(role: string): number {
  const builtin = BUILTIN_ROLE_RANKS[role];
  if (builtin !== undefined) return builtin;
  return getExtensionRole(role)?.rank ?? -1;
}

export interface AuthenticatedUser {
  username: string;
  role: AuthRole;
  displayName?: string;
  /** Under multi-user auth, the account id the token was bound to and the store still holds. */
  account?: string;
  /** Under multi-user auth, set instead of `account` for a bootstrap token: an instance credential,
   *  never an account, whatever its `sub`. */
  principal?: PrincipalKind;
}

export function normalizeRole(value: unknown): AuthRole {
  if (typeof value === "string" && (value in BUILTIN_ROLE_RANKS || getExtensionRole(value))) return value;
  // Unknown / missing role claims default to operator — matches the legacy
  // single-operator behavior so unupgraded tokens keep working until expiry.
  return "operator";
}

/**
 * Extract the authenticated user from a request's Authorization header.
 * Returns null when the header is missing, the token is invalid, or the
 * token's `sub` is not a string.  Used by route handlers that need to
 * audit per-user attribution; routes that only need to gate access can
 * keep using `verifyToken(extractBearerToken(...))`.
 *
 * Tokens minted before Wave B (no `role` claim) default to operator —
 * matches the legacy single-operator behavior so unupgraded tokens keep
 * working until they expire.
 */
export async function authenticatedUser(authHeader: string | null | undefined): Promise<AuthenticatedUser | null> {
  const token = extractBearerToken(authHeader);
  if (!token) return null;
  return authenticatedUserFromToken(token);
}

/**
 * The same for a bare token: one that rides in a query string or a cookie, where a browser cannot
 * set a header (an iframe preview, a served site, a WebSocket handshake).
 */
export async function authenticatedUserFromToken(token: string): Promise<AuthenticatedUser | null> {
  const payload = await verifyToken(token);
  if (!payload || typeof payload.sub !== "string") return null;
  const username = payload.sub;

  // With auth disabled (single-operator) there is no user store, so the token's own claims are
  // authoritative — the bootstrap/god-token path, unchanged.
  if (getConfig().auth?.enabled !== true) {
    return {
      username,
      role: normalizeRole(payload["role"]),
      displayName: typeof payload["displayName"] === "string" ? (payload["displayName"] as string) : undefined,
    };
  }
  return resolveCaller(username, {
    aid: payload[ACCOUNT_ID_CLAIM],
    bst: payload[BOOTSTRAP_CLAIM],
    role: payload["role"],
    displayName: payload["displayName"],
  }, { recordBootstrapSub: true });
}

/** The claim that binds a session token to the account id it was minted for. */
export const ACCOUNT_ID_CLAIM = "aid";
/** The claim that marks a bootstrap token (`sai token`, the setup wizard): an instance credential. */
export const BOOTSTRAP_CLAIM = "bst";

/**
 * Checks a caller resolved earlier against the store again, synchronously: an open WebSocket asks
 * before every message it handles and every event it pushes. Null when the account is gone, retired,
 * renamed, or holds another id now; otherwise the caller with its role as the store has it now.
 */
export function revalidateAuthenticatedUser(user: AuthenticatedUser): AuthenticatedUser | null {
  if (getConfig().auth?.enabled !== true) return user;
  return resolveCaller(user.username, {
    aid: getExtensionAuthProvider() ? undefined : user.account,
    bst: user.principal === "bootstrap" ? true : undefined,
    role: user.role,
    displayName: user.displayName,
  }, { recordBootstrapSub: false });
}

interface CallerClaims {
  aid: unknown;
  bst: unknown;
  role: unknown;
  displayName: unknown;
}

/**
 * Who a token is under multi-user auth, re-checked against the live stores on EVERY request: a
 * signed token is only as good as an account that still exists, so deleting an account or changing
 * its role takes effect at once instead of at the token's expiry (~24h).
 *
 * A token names its account by id (`aid`), not by username alone. A username outlives its account:
 * an account deleted and created again under the same name, or an identity-provider subject whose
 * claimed name another subject had first, would otherwise be signed in as the one before. The id is
 * random and minted once, so a token can only reach the account it was minted for, and only while
 * that account still holds the username in the token's `sub`.
 */
function resolveCaller(username: string, claims: CallerClaims, opts: { recordBootstrapSub: boolean }): AuthenticatedUser | null {
  const displayName = typeof claims.displayName === "string" ? claims.displayName : undefined;
  const provider = getExtensionAuthProvider();
  if (provider) {
    // An extension store's own id is the token's `sub` and is already immutable, so it is the
    // account; the `aid` and `bst` claims mean nothing here and are ignored (its login strips them).
    // Bootstrap tokens are not supported under an extension store, as before.
    const record = provider.getUserById(username);
    if (!record) return null; // account removed/disabled in the extension store
    return { username, role: normalizeRole(record.role), displayName: record.displayName, account: extensionAccountId(username) };
  }

  // A token carries one of the two claims; one carrying both was not minted here.
  if (claims.aid !== undefined && claims.bst !== undefined) return null;
  if (claims.aid !== undefined) {
    return typeof claims.aid === "string" ? resolveAccountCaller(username, claims.aid, claims.role, displayName) : null;
  }
  if (claims.bst !== undefined) {
    if (claims.bst !== true) return null;
    // A bootstrap token is an instance credential: minted with the JWT secret by whoever holds the
    // host (`sai token`, the setup wizard), it is never an account, whatever its `sub` names. It is
    // not refused when an account has that username (the shipped identity-provider realm's own user
    // is "admin", the default bootstrap `sub`): the two are different kinds, and never one bucket.
    // TTL-bound; revoke one early by rotating the JWT secret.
    if (opts.recordBootstrapSub) recordAccountRegistryBootstrapSub(username);
    return { username, role: normalizeRole(claims.role), displayName, principal: "bootstrap" };
  }
  // A token with neither claim was minted before account ids, or by hand. It resolves by its own
  // claims only while the deployment holds no account at all (the bootstrap window documented in
  // config/gateway/30-auth.jsonc): without that the first account could never be created.
  if (accountStoreIsEmpty()) {
    return { username, role: normalizeRole(claims.role), displayName };
  }
  return null;
}

/** No builtin account and no identity-provider account: the bootstrap window. A registry that
 *  cannot be read keeps the window shut. */
function accountStoreIsEmpty(): boolean {
  return getConfig().auth.users.length === 0 && !accountRegistryHoldsAccounts();
}

const _sharedIdsReported = new Set<string>();

function resolveAccountCaller(username: string, aid: string, roleClaim: unknown, displayName: string | undefined): AuthenticatedUser | null {
  const record = getConfig().auth.users.find((user) => user.id !== undefined && sameAccountId(user.id, aid));
  const entry = accountRegistryEntryById(aid);
  if (record && entry) {
    // One id held by a builtin account and an identity-provider account: one bucket for two people.
    // Neither signs in until an admin resolves it.
    if (!_sharedIdsReported.has(aid.toLowerCase())) {
      _sharedIdsReported.add(aid.toLowerCase());
      log.error({ account: aid }, "An account id is held by both a builtin account and an identity-provider account; neither can sign in");
    }
    return null;
  }
  if (record) {
    // Builtin accounts, also under provider "oidc" (mixed mode): the record still holds the id and
    // the name. Role and display name are read from it now, not from the token.
    if (record.username !== username) return null;
    return { username, role: normalizeRole(record.role), displayName: record.displayName, account: record.id };
  }
  // Identity-provider accounts only while that provider is configured. The role is the one the IdP
  // granted at sign-in (the registry holds none), as before.
  if (entry && getConfig().auth.provider === "oidc" && entry.status === "active" && entry.username === username) {
    return { username, role: normalizeRole(roleClaim), displayName, account: entry.id };
  }
  return null;
}

/**
 * Why a builtin account cannot sign in now, or undefined when it can. Its record needs an id (the
 * account migration assigns one to an account that predates ids), and that id must be its alone.
 */
export function builtinSignInProblem(record: { id?: string }): string | undefined {
  if (!record.id) return "This account has no account id yet: an admin runs `sai migrate-account-ids`";
  if (accountRegistryEntryById(record.id)) return "This account's id is also held by another account: an admin resolves it";
  return undefined;
}

/**
 * Returns true when `user` holds the required role or higher.  In Wave B
 * the only hierarchy is `operator > viewer`.  Use to gate mutating /
 * administrative routes — viewers should be able to read everything but
 * not initiate state changes.
 */
export function userHasRole(user: AuthenticatedUser | null, required: AuthRole): boolean {
  if (!user) return false;
  const requiredRank = roleRank(required);
  if (requiredRank < 0) return false; // unknown requirement — fail closed
  return roleRank(user.role) >= requiredRank;
}

export function resetAuthStateForTests(): void {
  _jwtSecret = null;
  failureCounts.clear();
  _sharedIdsReported.clear();
}

function resolveJwtSecretPath(): string {
  const explicit = process.env["SAI_JWT_SECRET_PATH"];
  if (explicit?.trim()) return resolve(explicit.trim());

  const workspaceSecret = resolve(process.cwd(), PRODUCT.stateDirName, ".jwt_secret");
  const homeSecret = resolve(homedir(), PRODUCT.stateDirName, ".jwt_secret");

  if (existsSync(workspaceSecret)) return workspaceSecret;
  if (existsSync(homeSecret)) return homeSecret;
  return workspaceSecret;
}
