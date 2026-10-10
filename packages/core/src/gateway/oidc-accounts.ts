/**
 * Which account an identity-provider sign-in is.
 *
 * The OIDC callback used to sign a person in as whatever username the ID token claimed. Two IdP
 * subjects whose claims lowercase alike were one account, a person who changed the claim became
 * whoever had that name, and an account the IdP retired kept working until its token expired. Here
 * the subject decides: its first sign-in mints an account id and freezes the username, every later
 * sign-in is that account under that name, and a name another account holds is refused.
 *
 * All of it runs in one synchronous block after the token exchange, the registry write included, so
 * two callbacks for one name that finish together cannot both claim it.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig } from "../config/loader.js";
import { getAllSessions } from "../agent/session.js";
import { userMemoryBaseDir } from "../memory/service.js";
import { DEFAULT_BOOTSTRAP_SUB, newOidcAccountId, safeUserSegment, sameAccountId } from "../runtime/accounts.js";
import {
  accountRegistryBootstrapSubs,
  accountRegistryEntries,
  accountRegistryEntryBySubject,
  accountRegistryUsernameHolder,
  changeAccountRegistry,
  type AccountRegistryEntry,
} from "../runtime/account-registry.js";
import { builtinTombstoneHolder } from "../runtime/account-tombstones.js";
import { USERS_SUBDIR, isLegacyIdentity, userStateBaseDir } from "../runtime/user-scope.js";
import { OidcSignInRefused, type OidcIdentity, type OidcRefusalCode } from "./oidc.js";

/**
 * Whether data was stored under this username before account ids existed: a per-user directory
 * named for it in any of the three bases, or a session from before ids that names it. Such data is
 * not handed to whoever signs in with the name first; the account waits for an admin (the migration
 * adopts it, or the admin declines it and the data stays where it is). A session that names an
 * account is that account's, not the name's: a retired account's chats, its name released, do not
 * hold the next subject who claims the name.
 *
 * A bootstrap token's name does not count. Its data stays the bootstrap token's: an IdP user called
 * "admin" (the shipped realm has one) starts empty, apart from the token's `admin` bucket.
 */
export function hasLegacyAccountData(username: string): boolean {
  const name = username.toLowerCase();
  if (name === DEFAULT_BOOTSTRAP_SUB || accountRegistryBootstrapSubs().some((sub) => sub.toLowerCase() === name)) return false;
  const segment = safeUserSegment(name);
  const bases = [getConfig().workspacePath, userMemoryBaseDir(), userStateBaseDir()];
  if (bases.some((base) => existsSync(resolve(base, USERS_SUBDIR, segment)))) return true;
  return getAllSessions({ includeArchived: true }).some((session) => session.userId?.toLowerCase() === name && isLegacyIdentity(session.identity()));
}

/**
 * Why a username is not free for a new identity-provider subject, or undefined when it is: the reason
 * the log gets, and the code the login screen gets.
 */
function usernameUnavailable(username: string): { reason: string; code: OidcRefusalCode } | undefined {
  const holder = accountRegistryUsernameHolder(username);
  if (holder === "unreadable") return { reason: "the account registry cannot be read", code: "accounts_unreadable" };
  if (holder) return { reason: `held by account ${holder.id}`, code: "username_held" };
  // Mixed mode: builtin accounts sign in under provider "oidc" too, and a name is one person's.
  if (getConfig().auth.users.some((user) => user.username.toLowerCase() === username)) return { reason: "held by a builtin account", code: "username_held" };
  // A deleted builtin account's name stays held: the grants an admin wrote for it name it still, and
  // a subject that claimed it would hold them.
  const tombstone = builtinTombstoneHolder(username);
  if (tombstone === "unreadable") return { reason: "the account tombstones cannot be read", code: "accounts_unreadable" };
  if (tombstone) return { reason: "held by a deleted builtin account", code: "username_held" };
  return undefined;
}

/** A fresh OIDC account id that neither the registry nor the roster holds. */
function mintOidcAccountId(): string {
  const held = [
    ...accountRegistryEntries().map((entry) => entry.id),
    ...getConfig().auth.users.flatMap((user) => (user.id ? [user.id] : [])),
  ];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = newOidcAccountId();
    if (!held.some((other) => sameAccountId(other, id))) return id;
  }
  throw new Error("could not mint an account id that no other account holds");
}

export interface OidcSignInAccount {
  entry: AccountRegistryEntry;
  /** The IdP now claims a different username than the frozen one; an admin may approve it. */
  usernameChangeRequested?: string;
  /** This sign-in created the entry. */
  created: boolean;
}

/**
 * The account this sign-in is, creating it on a subject's first sign-in. Synchronous from the first
 * lookup to the registry write. Throws OidcSignInRefused when the person may not sign in now, and a
 * plain error when the registry cannot be written (nothing is created then).
 */
export function resolveOidcSignIn(identity: OidcIdentity, now: Date = new Date()): OidcSignInAccount {
  const at = now.toISOString();
  const known = accountRegistryEntryBySubject(identity.issuer, identity.subject);
  if (known) {
    if (known.status === "pending") {
      throw new OidcSignInRefused(
        "auth_oidc_account_refused",
        "migration_pending",
        `OIDC account ${known.id} is waiting for the account migration`,
        known.username,
      );
    }
    if (known.status === "retired") {
      throw new OidcSignInRefused("auth_oidc_account_refused", "account_retired", `OIDC account ${known.id} is retired`, known.username);
    }
    // The username stays the frozen one. A different claim is recorded for an admin to approve:
    // grants written for a name must not move because someone edited their own profile. A claim
    // back at the frozen name withdraws the request.
    const requested = identity.username !== known.username ? identity.username : undefined;
    const entry = changeAccountRegistry((doc) => {
      const target = doc.accounts.find((candidate) => candidate.id === known.id)!;
      target.lastSeenAt = at;
      if (requested) target.requestedUsername = requested;
      else delete target.requestedUsername;
      return structuredClone(target);
    });
    return { entry, created: false, ...(requested ? { usernameChangeRequested: requested } : {}) };
  }

  const unavailable = usernameUnavailable(identity.username);
  if (unavailable) {
    throw new OidcSignInRefused(
      "auth_oidc_username_conflict",
      unavailable.code,
      `OIDC username '${identity.username}' is ${unavailable.reason}`,
      identity.username,
    );
  }
  const legacy = hasLegacyAccountData(identity.username);
  const fresh: AccountRegistryEntry = {
    id: mintOidcAccountId(),
    issuer: identity.issuer,
    subject: identity.subject,
    username: identity.username,
    status: legacy ? "pending" : "active",
    firstSeenAt: at,
    lastSeenAt: at,
    ...(legacy ? { legacy: { segment: safeUserSegment(identity.username) } } : {}),
  };
  changeAccountRegistry((doc) => { doc.accounts.push(fresh); });
  if (legacy) {
    throw new OidcSignInRefused(
      "auth_oidc_account_refused",
      "migration_pending",
      `OIDC account ${fresh.id} for '${fresh.username}' has data from before account ids and waits for the account migration`,
      fresh.username,
    );
  }
  return { entry: fresh, created: true };
}
