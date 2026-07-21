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
  const payload = await verifyToken(token);
  if (!payload || typeof payload.sub !== "string") return null;
  const username = payload.sub;

  // Under active multi-user auth, re-check the account against the live user
  // store on EVERY request — a signed token is only as good as an account that
  // still exists. This makes deleting a user (or changing their role) take effect
  // immediately, instead of the token staying valid for its full TTL (~24h). With
  // auth disabled (single-operator) there is no user store, so the token's own
  // claims are authoritative — the bootstrap/god-token path, unchanged.
  if (getConfig().auth?.enabled === true) {
    const provider = getExtensionAuthProvider();
    if (provider) {
      const record = provider.getUserById(username);
      if (!record) return null; // account removed/disabled in the extension store
      return { username, role: normalizeRole(record.role), displayName: record.displayName };
    }
    // OIDC users are authenticated by the external IdP and are NOT in auth.users[]
    // (that store backs only the builtin username/password provider). Their session
    // token was minted from IdP claims validated at the OIDC callback, so those
    // claims are authoritative — fall through to the token-claims path below rather
    // than rejecting for "no local account".
    // TRADEOFF: unlike the builtin path above, this does NOT re-check a live store, so
    // disabling/role-changing an OIDC user in the IdP only takes effect when their token
    // expires (≤ TTL), not immediately. Documented in docs/iam-sso-oidc.md ("revocation
    // lag"); shorten the OIDC token lifetime if prompt off-boarding matters.
    if (getConfig().auth.provider !== "oidc") {
      const users = getConfig().auth.users;
      const record = users.find((u) => u.username === username);
      if (record) {
        return { username, role: normalizeRole(record.role), displayName: record.displayName };
      }
      // Two token classes legitimately resolve via their own claims here:
      //  - Bootstrap admin tokens (CLI-minted via `sai token`; role claim "admin",
      //    which POST /api/auth/users can never assign). They are TTL-bound
      //    instance credentials independent of the user store: the operator who
      //    boots a fresh deployment must be able to create the first account and
      //    KEEP administering in the same session (more users, prompts, models).
      //    Revoke one early by rotating the JWT secret.
      //  - Any signed token while the store has ZERO accounts (the bootstrap
      //    window documented in config/gateway/30-auth.jsonc) — without it the
      //    deployment is locked out of ever creating the first account.
      // Everything else with an unresolvable sub is a deleted/disabled account
      // and is revoked immediately by the live-store re-check.
      const isBootstrapAdmin = normalizeRole(payload["role"]) === "admin";
      if (!isBootstrapAdmin && users.length > 0) {
        return null; // account deleted from config
      }
    }
  }

  return {
    username,
    role: normalizeRole(payload["role"]),
    displayName: typeof payload["displayName"] === "string" ? (payload["displayName"] as string) : undefined,
  };
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
