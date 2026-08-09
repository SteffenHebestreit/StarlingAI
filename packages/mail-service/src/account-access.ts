/**
 * Per-user account access control for the mail-service (mail + calendar +
 * contacts all share the same account credentials).
 *
 * The gateway forwards the authenticated user as the `X-Sai-User` header
 * (derived from the verified JWT; the shared service token bounds trust to the
 * gateway). An account's `allowedUsers` list, when non-empty, restricts it to
 * those users. Empty/unset = shared by design.
 *
 * A caller with NO header is denied access to a BOUND account. It previously was
 * allowed, which meant the restriction could be bypassed by simply omitting the
 * header — an access list that anyone can opt out of is not an access list. This
 * matches the core guard (`guardrails/resource-access.ts`), which fails closed for
 * an explicitly bound resource when the caller is unidentified.
 *
 * Unbound accounts are unaffected: no header, no list, still shared.
 */
import { HTTPException } from "hono/http-exception";
import type { MailAccountConfig } from "./types.js";

export function accountAllowsUser(account: MailAccountConfig, user: string | undefined): boolean {
  const allowed = account.allowedUsers;
  if (!allowed || allowed.length === 0) return true;   // unbound: shared, by design
  if (!user) return false;                             // bound + unidentified: deny
  const u = user.toLowerCase();
  return allowed.some((a) => a.toLowerCase() === u);
}

/** Resolve an account by id, enforcing per-user access. 404 if unknown, 403 if denied. */
export function getAccount(accounts: MailAccountConfig[], accountId: string, user?: string): MailAccountConfig {
  const account = accounts.find((entry) => entry.id === accountId);
  if (!account) {
    throw new HTTPException(404, { message: `Unknown account: ${accountId}` });
  }
  if (!accountAllowsUser(account, user)) {
    throw new HTTPException(403, { message: `Account '${accountId}' is restricted to specific users and not available to the current user.` });
  }
  return account;
}
