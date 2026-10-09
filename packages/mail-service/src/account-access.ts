/**
 * Per-user account access control for the mail-service (mail + calendar +
 * contacts all share the same account credentials).
 *
 * The gateway forwards the authenticated user as the `X-Sai-User` header
 * (derived from the verified JWT; the shared service token bounds trust to the
 * gateway). An account's `allowedUsers` list, when non-empty, restricts it to
 * those users. Empty/unset = shared by design.
 *
 * A missing header is ambiguous: it means "auth is off, so there is no user" on a
 * single-operator install, and "the header was dropped" on a multi-user one. Only
 * the deployment knows which, so `requireIdentifiedUser` decides. It mirrors the
 * core guard (`guardrails/resource-access.ts`), which resolves the same ambiguity by
 * consulting `auth.enabled`.
 *
 *   off (default) — no header is allowed, preserving single-user installs;
 *   on            — a BOUND account denies an unidentified caller, so the
 *                   restriction cannot be bypassed by simply omitting the header.
 *
 * Set SAI_MAIL_REQUIRE_IDENTIFIED_USER=true wherever gateway auth is enabled.
 *
 * Entries name an account, a principal or a name (entryNamesCaller); the gateway forwards the
 * caller in the matching form (X-Sai-User, X-Sai-Account).
 * Unbound accounts are shared either way, by design — except with the users an
 * accounts file names in `isolatedUsers` (LiveAccounts marks each shared account
 * `withheldFrom` them): they see only the accounts that name them.
 */
import { HTTPException } from "hono/http-exception";
import type { MailAccountConfig } from "./types.js";

function requireIdentifiedUser(): boolean {
  return (process.env["SAI_MAIL_REQUIRE_IDENTIFIED_USER"] ?? "").trim().toLowerCase() === "true";
}

/**
 * Who is asking, as the gateway forwards it: `X-Sai-User` (an account's username, a bootstrap
 * token's `sub`, or `principal:<raw>` for a channel sender, an A2A peer or a scene/job run) and,
 * for an account, `X-Sai-Account` (its immutable id).
 */
export interface MailCaller {
  user?: string;
  account?: string;
}

/** The caller a request names. */
export function mailCaller(header: (name: string) => string | undefined): MailCaller {
  const user = header("x-sai-user")?.trim();
  const account = header("x-sai-account")?.trim();
  return { ...(user ? { user } : {}), ...(account ? { account } : {}) };
}

const ACCOUNT_PREFIX = "account:";

/**
 * Whether one `allowedUsers` / `isolatedUsers` entry names the caller. Three forms:
 *
 *   account:<id>     the account with that immutable id (X-Sai-Account);
 *   principal:<raw>  that principal, which the gateway forwards as `principal:<raw>`;
 *   <name>           the account whose username it is, or a bootstrap token with that `sub`.
 *
 * A bare name used to match whatever raw name a caller carried, so a mail From address or a
 * Telegram id equal to a listed username was granted that account. The gateway now forwards a
 * principal with its prefix, which a bare entry never equals. Compared without case.
 */
export function entryNamesCaller(entry: string, caller: MailCaller): boolean {
  const value = entry.trim().toLowerCase();
  if (value.startsWith(ACCOUNT_PREFIX)) {
    return caller.account !== undefined && caller.account.toLowerCase() === value.slice(ACCOUNT_PREFIX.length).trim();
  }
  return caller.user !== undefined && caller.user.toLowerCase() === value;
}

function identified(caller: MailCaller): boolean {
  return caller.user !== undefined || caller.account !== undefined;
}

/** A caller given as its `X-Sai-User` value alone, or as a whole. */
function asCaller(caller: MailCaller | string | undefined): MailCaller {
  if (typeof caller !== "string") return caller ?? {};
  const user = caller.trim();
  return user ? { user } : {};
}

export function accountAllowsUser(account: MailAccountConfig, given: MailCaller | string | undefined): boolean {
  const caller = asCaller(given);
  const allowed = account.allowedUsers;
  if (!allowed || allowed.length === 0) {                     // unbound: shared, by design…
    // …but not with an isolated user
    return !identified(caller) || !account.withheldFrom?.some((entry) => entryNamesCaller(entry, caller));
  }
  if (!identified(caller)) return !requireIdentifiedUser();   // ambiguous: deployment decides
  return allowed.some((entry) => entryNamesCaller(entry, caller));
}

/** Resolve an account by id, enforcing per-user access. 404 if unknown, 403 if denied. */
export function getAccount(accounts: MailAccountConfig[], accountId: string, caller?: MailCaller | string): MailAccountConfig {
  const account = accounts.find((entry) => entry.id === accountId);
  if (!account) {
    throw new HTTPException(404, { message: `Unknown account: ${accountId}` });
  }
  if (!accountAllowsUser(account, caller)) {
    throw new HTTPException(403, { message: `Account '${accountId}' is restricted to specific users and not available to the current user.` });
  }
  return account;
}
