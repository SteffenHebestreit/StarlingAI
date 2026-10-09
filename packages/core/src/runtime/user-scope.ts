/**
 * Per-user partitioning of the durable "user"-scope stores (user memory, the
 * dialectic user-model, and the personality override).
 *
 * Multi-user auth (Wave A) authenticates a user and stamps `ctx.userId` onto the
 * request context, but historically every user-scope store resolved to a SINGLE
 * shared path — so two logged-in operators shared one memory / user-model /
 * personality. These helpers key those stores by the ambient authenticated user
 * so each account gets its own bucket, while staying fully back-compatible:
 * when no userId is present (single-operator / auth-disabled — the default) the
 * store stays at its original shared path unchanged.
 */
import { resolve } from "node:path";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { PRODUCT } from "../product/index.js";
import { currentIdentity, currentUserScopeSegment } from "./request-context.js";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import {
  ACCOUNT_ID_RE,
  principalSegment,
  safeUserSegment,
  sameAccountId,
  type Identity,
  type PrincipalKind,
} from "./accounts.js";
import { accountRegistryEntries, accountRegistryUsernameHolder } from "./account-registry.js";
import { USERS_SUBDIR } from "../tools/workspace-zones.js";

const log = childLogger("runtime:user-scope");

// The formula lives with the account ids (runtime/accounts.ts), which the config schema imports
// to validate them; this module imports the config, so it could not. Same function, same output.
export { safeUserSegment };

/** Per-user partitioning only applies under active multi-user auth. */
function partitioningEnabled(): boolean {
  return getConfig().auth?.enabled === true;
}

/**
 * Partition a user-scope store directory by the ambient (or given) identity.
 * `<base>/users/<segment>/` when multi-user auth is on AND there is someone to partition by;
 * `<base>` unchanged otherwise — so single-operator / auth-disabled installs (the default) keep
 * their original shared path (fully back-compat). Pass an explicit identity (e.g. a session's) to
 * target that identity's bucket instead of the ambient one.
 */
export function userScopedDir(base: string, who: Identity | undefined = currentIdentity()): string {
  const segment = segmentFor(who);
  return segment ? resolve(base, USERS_SUBDIR, segment) : base;
}

/**
 * Thrown when work that names a username, but neither the account nor the principal kind it
 * belongs to, would derive storage from that name, and the name is one an account holds.
 *
 * Every account's storage is keyed by its immutable id, and every principal's (a bootstrap token,
 * a channel sender, a scene run) by its raw name. An identity that carries only a name is one some
 * entry point did not thread whole. For most names that is harmless (a principal's bucket is the
 * one its name always had), but for an account's username it is the bucket the account kept
 * before ids existed, or the one a deleted account of that name left behind. Rather than read or
 * write it on a guess, the derivation fails, loudly, and only there.
 */
export class AccountNotThreadedError extends Error {
  readonly userId: string;

  constructor(userId: string, reason: string) {
    super(`The identity '${userId}' carries no account id or principal kind, and that name ${reason}: no storage is derived from it`);
    this.name = "AccountNotThreadedError";
    this.userId = userId;
  }
}

/**
 * Why `raw` may not stand for a principal under multi-user auth, or undefined when it may.
 *
 * A name is held when a builtin account has it, when an identity-provider account holds it in any
 * status (a retired one's too, until an admin releases it; while the registry cannot be read every
 * name counts as held), or when the segment its raw name derives to is an account's id. A name
 * with control characters is never one. Names compare without case: a mail address or an IdP
 * username is the same person in any case, and the closed direction is to refuse it.
 */
export function reservedUsernameProblem(raw: string): string | undefined {
  // eslint-disable-next-line no-control-regex -- control characters are what is refused here
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "holds control characters";
  const name = raw.trim().toLowerCase();
  const roster = getConfig().auth?.users ?? [];
  if (roster.some((user) => user.username.toLowerCase() === name)) return "is a builtin account's username";
  const holder = accountRegistryUsernameHolder(name);
  if (holder === "unreadable") return "cannot be checked against the account registry, which cannot be read";
  if (holder) return "is held by an identity-provider account";
  const segment = principalSegment(raw);
  const ids = [
    ...roster.flatMap((user) => (user.id ? [user.id] : [])),
    ...accountRegistryEntries().map((entry) => entry.id),
  ];
  if (ids.some((id) => sameAccountId(id, segment))) return "derives to an account's id";
  return undefined;
}

/**
 * THE ONE RULE for which on-disk bucket an identity's user-scoped storage lives in, or `undefined`
 * when the storage stays shared. Every user-scoped store, path, record stamp and graph tenant
 * derives from it.
 *
 *   1. multi-user auth off            -> undefined (one operator, one shared store; unchanged)
 *   2. a sweep's pre-resolved segment -> that segment, verbatim (never re-derived: the hash is lossy)
 *   3. an account                     -> its id, which IS its segment
 *   4. a principal                    -> the segment its raw name always had
 *   5. a name with no kind            -> the same, unless the name is an account's: then
 *                                        AccountNotThreadedError (reservedUsernameProblem)
 *   6. nobody                         -> undefined
 *
 * `undefined` covers both ways partitioning can be off: auth disabled, and auth enabled with
 * nobody in the context. Gating on the auth FLAG alone would send an unattended run, an inbound
 * MCP call or any other path with no ambient user into a `users/undefined`-shaped bucket, or split
 * one logical store across two locations depending on which entry point wrote it.
 *
 * An account id comes from a store that validated it (the roster, the account registry, a session
 * record written from one). One that is not segment-shaped is refused rather than joined into a
 * path.
 */
export function segmentFor(who: Identity | undefined = currentIdentity()): string | undefined {
  if (!partitioningEnabled()) return undefined;
  const preResolved = currentUserScopeSegment();
  if (preResolved) return preResolved;
  if (!who) return undefined;
  if (who.account) {
    if (!ACCOUNT_ID_RE.test(who.account)) throw new Error(`'${who.account}' is not an account id`);
    return who.account;
  }
  if (!who.userId) return undefined;
  if (who.principal) return principalSegment(who.userId);
  const problem = reservedUsernameProblem(who.userId);
  if (problem) throw new AccountNotThreadedError(who.userId, problem);
  return principalSegment(who.userId);
}

/**
 * The identity of a principal: a bootstrap token, a channel sender, an A2A peer, a scene, job or
 * workflow run. The kind is recorded only under multi-user auth, where it decides storage and
 * ownership; with one operator there is neither, and every record stays exactly as it was written
 * before kinds existed. A config that cannot be read counts as multi-user.
 */
export function principalIdentity(raw: string, kind: PrincipalKind): Identity {
  let multiUser = true;
  try {
    multiUser = partitioningEnabled();
  } catch { /* fail closed: keep the kind */ }
  return multiUser ? { userId: raw, principal: kind } : { userId: raw };
}

/**
 * The identity a call acts as, given the identity it was handed (`own`, from a ToolContext or run
 * options) and the ambient one: the ambient identity when the call names nobody or the same name,
 * else the call's own, whole. Never one field from each: a `workflow:<x>` name paired with the
 * ambient account would read and write that account's storage. When both name the same user, the
 * one that carries a kind wins, the ambient first.
 */
export function pairedIdentity(own: Identity | undefined, ambient: Identity | undefined = currentIdentity()): Identity | undefined {
  if (!own?.userId) return ambient ?? own;
  if (own.userId !== ambient?.userId) return own;
  return ambient.account || ambient.principal ? ambient : own;
}

/** Whether an identity names a user but neither an account nor a principal kind: written before
 *  account ids existed, or by a path that did not thread one. */
export function isLegacyIdentity(who: Identity | undefined): boolean {
  return Boolean(who?.userId) && !who?.account && !who?.principal;
}

/** Whether multi-user auth is on, for a decision about whose a record is. A config that cannot be
 *  read counts as multi-user: identities are compared, never names. */
export function multiUserAuthActive(): boolean {
  try {
    return partitioningEnabled();
  } catch {
    return true;
  }
}

/** Whether a record names an owner at all. One that names none (auth-off history, a webhook run)
 *  stays open wherever such records were open. */
export function recordHasOwner(owner: Identity | undefined): owner is Identity {
  return owner !== undefined && (owner.userId !== undefined || owner.account !== undefined);
}

/**
 * Whether `caller` owns a record written for `owner`: THE ONE RULE every ownership check uses (a
 * session, a job, a knowledge base, a mission, a schedule, an MCP or A2A binding, a question a
 * turn asked).
 *
 * Every such check compared usernames, so an account deleted and created again under the same name
 * owned everything the old one left, and a channel sender or a bootstrap token whose raw name was
 * an account's username owned that account's records. Under multi-user auth the comparison is by
 * identity now:
 *
 * - a record of an account is the caller's when the caller is that account (by id);
 * - a record of a principal when the caller is the same principal: the same kind and the same name;
 * - a record that names a user but no kind predates account ids and is no caller's: whoever it was
 *   written for, a guess by name would hand it to the next person given that name. Callers that
 *   exempt admins let an admin reach it, and nobody else;
 * - a record that names nobody is no caller's either (callers decide whether such records stay
 *   open, recordHasOwner).
 *
 * With one operator there are no kinds, and a record is the caller's by name, exactly as every
 * check compared before. A config that cannot be read counts as multi-user: identities, not names.
 */
export function ownsRecord(caller: Identity | undefined, owner: Identity | undefined): boolean {
  if (!caller || !recordHasOwner(owner)) return false;
  if (!multiUserAuthActive()) return owner.userId !== undefined && caller.userId === owner.userId;
  if (owner.account) return caller.account !== undefined && sameAccountId(caller.account, owner.account);
  if (owner.principal) {
    return caller.account === undefined && caller.principal === owner.principal
      && caller.userId !== undefined && caller.userId === owner.userId;
  }
  return false;
}

/** The `users` directory name, shared with the workspace zone resolver. */
export { USERS_SUBDIR };

/**
 * The base of the per-user state files (the dialectic user-model, the personality override) before
 * partitioning: `$SAI_USER_MEMORY_PATH`, else `~/.starlingai/state`.
 */
export function userStateBaseDir(): string {
  return process.env["SAI_USER_MEMORY_PATH"]?.trim()
    ? resolve(process.env["SAI_USER_MEMORY_PATH"])
    : resolve(homedir(), PRODUCT.stateDirName, "state");
}

// ── Records of a store every account writes to ────────────────────────────────
// The agent outcome ledger and flow memory are one file for the whole deployment. Each record
// carries the user-scope segment of the account it was written for (never the raw user id), so a
// reader that shows a record's text can keep to the caller's own.

/** The segment to stamp on a record written now: under multi-user auth that of `who`, or of the
 *  ambient identity when none is given; none otherwise. None too when the config cannot be read;
 *  such a record is then shown to no one. An identity that was not threaded (the guard in
 *  segmentFor) is logged: the record it stamps none on becomes invisible, which must not be
 *  silent. */
export function recordAccount(who?: Identity): string | undefined {
  try {
    return segmentFor(who);
  } catch (err) {
    if (err instanceof AccountNotThreadedError) {
      log.warn({ err, userId: err.userId }, "A record was written for an identity with no account or principal kind; it carries no account and nobody can read it");
    }
    return undefined;
  }
}

/** Whose records the current request may read. */
export interface RecordReader {
  /** Multi-user auth is off: every record is the one operator's. */
  all: boolean;
  /** The caller's segment under multi-user auth; absent when the request has no user. */
  segment?: string;
}

/**
 * Every record with multi-user auth off; under it the caller's own, and none when the request has
 * no user. A config that cannot be read counts as multi-user with no user: nothing is shown.
 */
export function recordReader(): RecordReader {
  try {
    if (!partitioningEnabled()) return { all: true };
    const segment = segmentFor();
    return segment ? { all: false, segment } : { all: false };
  } catch (err) {
    if (err instanceof AccountNotThreadedError) {
      log.warn({ err, userId: err.userId }, "A reader with no account or principal kind is shown no account's records");
    }
    return { all: false };
  }
}

/** Whether a record written for `account` is the reader's to see. A record with no account is
 *  visible only with multi-user auth off. */
export function canReadRecord(reader: RecordReader, account: string | undefined): boolean {
  return reader.all || (reader.segment !== undefined && account === reader.segment);
}

/**
 * The per-user store segments that exist under `<base>/users` — for background
 * drivers / admin surfaces that must enumerate every user's bucket rather than
 * only the ambient one. Returns the on-disk (already-safe) segment names.
 *
 * A dot-directory is never a bucket: no segment starts with a dot, and `users/.retired` holds the
 * archived buckets of deleted accounts, which no sweep may write to again.
 */
export function listUserScopeSegments(base: string): string[] {
  try {
    return readdirSync(resolve(base, USERS_SUBDIR), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
