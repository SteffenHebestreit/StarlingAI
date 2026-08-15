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
 * Unbound accounts are shared either way, by design.
 */
import { HTTPException } from "hono/http-exception";
import type { MailAccountConfig } from "./types.js";

function requireIdentifiedUser(): boolean {
  return (process.env["SAI_MAIL_REQUIRE_IDENTIFIED_USER"] ?? "").trim().toLowerCase() === "true";
}

export function accountAllowsUser(account: MailAccountConfig, user: string | undefined): boolean {
  const allowed = account.allowedUsers;
  if (!allowed || allowed.length === 0) return true;          // unbound: shared, by design
  if (!user) return !requireIdentifiedUser();                 // ambiguous: deployment decides
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
