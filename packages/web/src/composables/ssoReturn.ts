/**
 * What an identity-provider (SSO) sign-in hands the dashboard on its way back.
 *
 * The gateway's OIDC callback redirects here with the session token in the URL fragment
 * (`#sai_token=`), or, when the sign-in ends without one, a short code (`#sai_error=`): why it was
 * refused, or `sso_failed` for anything else. The login screen shows the message for the code. Text
 * from the URL is never shown: an unknown code gets the generic message, so a crafted link cannot
 * put its own words on the login screen.
 *
 * Deliberately free of Vue and of the store, so it can be exercised on its own.
 */

const SSO_FAILED = "SSO sign-in failed. Try again; if it keeps failing, an administrator can find the reason in the gateway log.";

/** One message per code the gateway sends (OidcRefusalCode in core's gateway/oidc.ts, and sso_failed). */
const SSO_ERROR_MESSAGES = new Map<string, string>([
  [
    "migration_pending",
    "Your account is waiting for the account migration: it has data from before account ids. An administrator must run the migration (pnpm sai migrate-account-ids) before you can sign in.",
  ],
  ["account_retired", "This account has been retired and can no longer sign in. Ask an administrator if you need access again."],
  ["username_held", "Your username is already held by another account, so this sign-in was refused. An administrator must resolve it."],
  [
    "username_invalid",
    "Your username at the identity provider cannot be used here: it may contain only letters, digits and . _ @ + -, and must start with a letter or digit.",
  ],
  ["email_unverified", "Your email address is not verified at the identity provider. Verify it there, then sign in again."],
  ["accounts_unreadable", "Sign-in is unavailable: the gateway cannot read its account records. An administrator must repair them."],
  ["sso_failed", SSO_FAILED],
]);

export interface SsoReturn {
  /** The session token of a sign-in that succeeded. */
  token?: string;
  /** Why the sign-in ended without a token, as the gateway's code. */
  errorCode?: string;
}

/** The token or the refusal code a location hash carries, or null when it carries neither. */
export function readSsoReturn(hash: string): SsoReturn | null {
  const fragment = hash.replace(/^#/, "");
  if (!fragment.includes("sai_token=") && !fragment.includes("sai_error=")) return null;
  const params = new URLSearchParams(fragment);
  const token = params.get("sai_token");
  const errorCode = params.get("sai_error");
  return { ...(token ? { token } : {}), ...(errorCode !== null ? { errorCode } : {}) };
}

/** The message the login screen shows for a code: the generic one for a code it does not know. */
export function ssoErrorMessage(code: string): string {
  return SSO_ERROR_MESSAGES.get(code) ?? SSO_FAILED;
}
