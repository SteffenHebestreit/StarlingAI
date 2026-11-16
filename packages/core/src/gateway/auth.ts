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
import { extensionAccountId, sameAccountId, type Identity, type PrincipalKind } from "../runtime/accounts.js";
import { principalIdentity } from "../runtime/user-scope.js";
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
 * roles (with ranks) via their manifest — see extension/index.ts. Under
 * multi-user auth a role that neither core nor a loaded extension declares
 * signs nobody in (declaredRole); a token with no role claim, minted before
 * roles (Wave B), counts as operator (normalizeRole).
 */
export type AuthRole = string;

/** Built-in role ranks; extension roles carry their own rank in the registry. */
const BUILTIN_ROLE_RANKS: Readonly<Record<string, number>> = { viewer: 10, operator: 50, admin: 90 };

/** The rank of a built-in role. Own keys only: "constructor" or "toString" is no built-in role. */
function builtinRoleRank(role: string): number | undefined {
  return Object.hasOwn(BUILTIN_ROLE_RANKS, role) ? BUILTIN_ROLE_RANKS[role] : undefined;
}

/** Rank for any known role name; unknown roles rank as -1 (never sufficient). */
export function roleRank(role: string): number {
  const builtin = builtinRoleRank(role);
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

/**
 * The identity a resolved caller acts as, whole: its username with its account id, or with the
 * bootstrap kind. Under multi-user auth a caller with neither holds a token from the empty-store
 * window, which no account can hold: an instance credential like a bootstrap token, and it acts as
 * one (a name alone would be a session from before account ids, which runs no turn). With one
 * operator the caller is its username alone, as every caller was before account ids. The caller
 * itself is left as it resolved, so the window still shuts on an open socket.
 */
export function callerIdentity(user: AuthenticatedUser | null | undefined): Identity | undefined {
  if (!user) return undefined;
  if (user.account) return { userId: user.username, account: user.account };
  if (user.principal) return { userId: user.username, principal: user.principal };
  return principalIdentity(user.username, "bootstrap");
}

/**
 * The role `value` names when core or a loaded extension declares it, else undefined: a typo, the
 * role of an extension that failed to load or is no longer installed, or a value that is no role
 * name at all. Such a role grants nothing. Under multi-user auth an account or a token that holds
 * one signs in nowhere (resolveCaller, the sign-in routes); it used to sign in as operator, so an
 * extension that failed to load turned every account holding one of its roles into an operator.
 */
export function declaredRole(value: unknown): AuthRole | undefined {
  if (typeof value !== "string") return undefined;
  return builtinRoleRank(value) !== undefined || getExtensionRole(value) ? value : undefined;
}

/**
 * The role a token's `role` claim stands for: a declared role as it is, and operator for a token
 * with no role claim at all, minted before roles (Wave B), as it always has. Undefined for a claim
 * naming a role that nobody declares, which every caller of this refuses. A role read from a store
 * (an account's record) has no such default: see {@link declaredRole}.
 */
export function normalizeRole(value: unknown): AuthRole | undefined {
  return value === undefined ? "operator" : declaredRole(value);
}

/**
 * The role a token's claim stands for with auth off: there is one operator and no user store, the
 * token's own claims are authoritative, and a role nobody declares counts as operator, as it always
 * has. Never under multi-user auth, which refuses such a role.
 */
export function singleOperatorRole(value: unknown): AuthRole {
  return normalizeRole(value) ?? "operator";
}

/** Who held a refused role, as the error line names them: an account id or a principal's kind, never a name. */
export interface RoleHolder {
  account?: string;
  principal?: PrincipalKind;
  /** Where the role was read, when no account holds it (the identity provider's default role). */
  source?: string;
}

/** What the sign-in routes answer an account whose role nobody declares, after its password. */
export const UNDECLARED_ROLE_REFUSAL =
  "This account's role is not known to this gateway: an admin changes the account's role, or restores the extension that declares it";

const UNDECLARED_ROLE_LOG =
  "Sign-in refused: the role is declared by neither core nor any loaded extension. An extension that declares it may have failed to load (see the extension loader's errors at boot) or is no longer installed; the account stays locked out until its role is changed or that extension loads again";

/** The (holder, role) pairs already logged, so a socket that asks before every message logs once. */
const _undeclaredRolesReported = new Set<string>();
/** Bounds the set: the roles come from the stores and from signed tokens, but a gateway runs for months. */
const MAX_UNDECLARED_ROLE_REPORTS = 1_000;

function describeRole(role: unknown): string {
  if (typeof role === "string") return role.length > 64 ? `${role.slice(0, 64)}…` : role;
  return role === undefined ? "(none)" : `(${role === null ? "null" : typeof role})`;
}

/**
 * Logs at error level that a role neither core nor any loaded extension declares kept a caller from
 * signing in: once per process for each holder and role, as an open socket asks before every
 * message and every pushed event. The line names the role and the account id (or the principal's
 * kind), nothing else of the account, and no part of the token.
 */
export function reportUndeclaredRole(role: unknown, holder: RoleHolder = {}): void {
  const shown = describeRole(role);
  const key = [holder.account?.toLowerCase() ?? "", holder.principal ?? "", holder.source ?? "", shown].join("\u0000");
  if (_undeclaredRolesReported.has(key)) return;
  if (_undeclaredRolesReported.size >= MAX_UNDECLARED_ROLE_REPORTS) _undeclaredRolesReported.clear();
  _undeclaredRolesReported.add(key);
  log.error({ role: shown, ...holder }, UNDECLARED_ROLE_LOG);
}

/** Refuses a caller whose role nobody declares: logs it (reportUndeclaredRole) and resolves to no caller. */
function refuseUndeclaredRole(role: unknown, holder: RoleHolder): null {
  reportUndeclaredRole(role, holder);
  return null;
}

/**
 * Why an account that gave the right password still may not sign in because of its role, or
 * undefined when core or a loaded extension declares that role. The refusal is logged
 * (reportUndeclaredRole). For the sign-in routes under multi-user auth: a token minted anyway would
 * be refused on its first use (resolveCaller).
 */
export function signInRoleProblem(role: unknown, holder: RoleHolder): string | undefined {
  if (declaredRole(role) !== undefined) return undefined;
  reportUndeclaredRole(role, holder);
  return UNDECLARED_ROLE_REFUSAL;
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
 * working until they expire. Under multi-user auth a role claim naming a
 * role that nobody declares resolves to null, as does a stored one.
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
  // authoritative — the bootstrap/god-token path, unchanged (a role nobody declares included).
  if (getConfig().auth?.enabled !== true) {
    return {
      username,
      role: singleOperatorRole(payload["role"]),
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
 * renamed, holds another id now, or holds a role that nobody declares now; otherwise the caller with
 * its role as the store has it now.
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

/**
 * The role the store holds for an account now, for work done for it that carries no role of its own
 * (a queued job, a scheduled run, a turn nobody sent). A builtin account's record holds one, and so
 * does an extension auth provider's user. An identity-provider account's is the role the IdP granted
 * at its latest sign-in, which the account registry records (AccountRegistryEntry.grantedRole): the
 * IdP grants it at each sign-in, and between two sign-ins that is the latest word on it. Null when
 * the account no longer signs in (gone, retired, renamed, its id held by another, or its role one
 * that nobody declares). Undefined when the store holds no role for it (an identity-provider
 * account whose entry predates that record), when the identity names no account, or with auth off.
 */
export function storedAccountRole(identity: Pick<Identity, "userId" | "account">): AuthRole | null | undefined {
  const account = identity.account;
  if (getConfig().auth?.enabled !== true || !identity.userId || !account) return undefined;
  // The role claim only stands in: a store that holds the account's role answers with that one.
  const live = revalidateAuthenticatedUser({ username: identity.userId, account, role: "viewer" });
  if (!live?.account || !sameAccountId(live.account, account)) return null;
  const roleIsStored = getExtensionAuthProvider() !== null
    || getConfig().auth.users.some((user) => user.id !== undefined && sameAccountId(user.id, account));
  if (roleIsStored) return live.role;
  const granted = accountRegistryEntryById(account)?.grantedRole;
  if (granted === undefined) return undefined;
  // A granted role that nobody declares now (an extension that no longer loads) signs nobody in.
  return declaredRole(granted) ?? null;
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
 *
 * The role must be one that core or a loaded extension declares (declaredRole), whichever store or
 * claim it comes from; a caller holding any other resolves to null, as a deleted account does, and
 * the refusal is logged (reportUndeclaredRole). Every surface that resolves a caller through here
 * then refuses it the way it refuses a revoked token. A role nobody declares was mapped to operator,
 * so when an extension failed to load, each account holding one of its roles signed in as an
 * operator. Only a token with no role claim keeps its default, operator (normalizeRole).
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
    const account = extensionAccountId(username);
    // The role the store holds, which has no default: a record without one names no role.
    const role = declaredRole(record.role);
    if (!role) return refuseUndeclaredRole(record.role, { account });
    return { username, role, displayName: record.displayName, account };
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
    // TTL-bound; revoke one early by rotating the JWT secret. A role claim nobody declares refuses
    // it before its subject is recorded.
    const role = normalizeRole(claims.role);
    if (!role) return refuseUndeclaredRole(claims.role, { principal: "bootstrap" });
    if (opts.recordBootstrapSub) recordAccountRegistryBootstrapSub(username);
    return { username, role, displayName, principal: "bootstrap" };
  }
  // A token with neither claim was minted before account ids, or by hand. It resolves by its own
  // claims only while the deployment holds no account at all (the bootstrap window documented in
  // config/gateway/30-auth.jsonc): without that the first account could never be created. An
  // extension store's token is one of these once that extension no longer loads: its role claim
  // must still be declared.
  if (accountStoreIsEmpty()) {
    const role = normalizeRole(claims.role);
    if (!role) return refuseUndeclaredRole(claims.role, {});
    return { username, role, displayName };
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
    const role = declaredRole(record.role);
    if (!role) return refuseUndeclaredRole(record.role, { account: record.id });
    return { username, role, displayName: record.displayName, account: record.id };
  }
  // Identity-provider accounts only while that provider is configured. The role is the one the IdP
  // granted at sign-in (the registry holds none), as before.
  if (entry && getConfig().auth.provider === "oidc" && entry.status === "active" && entry.username === username) {
    const role = normalizeRole(roleClaim);
    if (!role) return refuseUndeclaredRole(roleClaim, { account: entry.id });
    return { username, role, displayName, account: entry.id };
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
  _undeclaredRolesReported.clear();
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
