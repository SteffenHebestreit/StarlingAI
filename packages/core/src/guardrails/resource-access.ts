/**
 * Per-user resource ownership guard.
 *
 * Shared resources (mail accounts, stored site credentials, compute nodes) are
 * global by default. When multi-user auth is enabled, an operator can bind a
 * resource to specific users via an `allowedUsers` list; this helper is the
 * single decision point every tool uses to enforce that binding.
 *
 * Rules:
 * - allowedUsers empty / unset  → shared resource, everyone may use it.
 *   (Unbound is shared BY DESIGN; private-by-default would need a per-resource
 *   owner model — a separate feature.)
 * - allowedUsers set + no user:
 *     · multi-user auth OFF → single-operator / token mode, allow (back-compat).
 *     · multi-user auth ON  → FAIL CLOSED: a restricted resource must never leak
 *       to an unauthenticated / user-less caller under active auth.
 * - allowedUsers set + a user, multi-user auth OFF → allow IFF allowedUsers includes the name.
 * - allowedUsers set + a user, multi-user auth ON → allow IFF an entry matches the caller's
 *   identity (aclEntryMatches):
 *     · `account:<id>`   — the account with that id;
 *     · `principal:<raw>` — a channel sender, A2A peer or scene/job/workflow run with that name;
 *     · a bare name      — the account whose username it is, or a bootstrap token with that `sub`
 *                          (an instance credential, as before). Never a principal.
 *
 * A bare entry matched any identity whose raw name was the same string: a mail From address, a
 * Telegram id, an A2A peer's `sub`, or an account created again under a deleted one's name. Names
 * of principals are chosen by whoever sends them, so a principal now needs an entry of its own.
 *
 * Names and ids are compared case-insensitively (auth lowercases usernames).
 */
import { getConfig } from "../config/loader.js";
import { sameAccountId, type Identity } from "../runtime/accounts.js";

export interface OwnedResource {
  /** Usernames permitted to use this resource. Empty/undefined = shared. */
  allowedUsers?: string[] | null;
}

/** The prefix of an `allowedUsers` entry that names an account by its id. */
export const ACL_ACCOUNT_PREFIX = "account:";
/** The prefix of an `allowedUsers` entry that names a principal by its raw name. */
export const ACL_PRINCIPAL_PREFIX = "principal:";

function multiUserAuth(): boolean {
  try {
    return getConfig().auth?.enabled === true;
  } catch {
    return true; // fail closed: match identities, never bare names
  }
}

/**
 * Whether one `allowedUsers` entry grants a caller under multi-user auth. A caller with a name and
 * no kind is a principal here, as it is for storage (runtime/user-scope.ts segmentFor): it matches
 * only a `principal:` entry.
 */
export function aclEntryMatches(entry: string, who: Identity): boolean {
  const value = entry.trim();
  const lower = value.toLowerCase();
  if (lower.startsWith(ACL_ACCOUNT_PREFIX)) {
    return who.account !== undefined && sameAccountId(value.slice(ACL_ACCOUNT_PREFIX.length).trim(), who.account);
  }
  const name = who.userId?.toLowerCase();
  if (name === undefined) return false;
  if (lower.startsWith(ACL_PRINCIPAL_PREFIX)) {
    return who.account === undefined && who.principal !== "bootstrap"
      && lower.slice(ACL_PRINCIPAL_PREFIX.length).trim() === name;
  }
  return (who.account !== undefined || who.principal === "bootstrap") && lower === name;
}

export function canAccessResource(who: Identity | undefined, resource: OwnedResource | undefined | null): boolean {
  const allowed = resource?.allowedUsers;
  if (!allowed || allowed.length === 0) return true; // shared / unbound resource
  if (!multiUserAuth()) {
    // One operator: by name, exactly as before.
    const userId = who?.userId;
    if (!userId) return true;
    const u = userId.toLowerCase();
    return allowed.some((a) => a.toLowerCase() === u);
  }
  if (!who?.userId && !who?.account) return false; // bound + no user under auth: closed
  return allowed.some((entry) => aclEntryMatches(entry, who));
}

/**
 * Filter a list of owned resources to those the user may access.
 */
export function filterAccessibleResources<T extends OwnedResource>(who: Identity | undefined, resources: readonly T[]): T[] {
  return resources.filter((r) => canAccessResource(who, r));
}

/**
 * Standard denial message for a resource the user is not permitted to use.
 * Deliberately does not leak whether the resource exists beyond its id.
 */
export function resourceDeniedMessage(kind: string, id: string): string {
  return `Access to ${kind} '${id}' is restricted to specific users and is not available to the current user.`;
}
