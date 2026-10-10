import { describe, expect, it } from "vitest";
import { readSsoReturn, ssoErrorMessage } from "./ssoReturn";

/**
 * What the login screen tells a person whose SSO sign-in the gateway refused.
 *
 * The gateway's OIDC callback refused a sign-in (an account waiting for the account migration, a
 * held name, a retired account) and redirected back with `#sai_error=`, which the dashboard threw
 * away: the person saw only that SSO did not work. The callback now sends a short code, and the
 * login screen shows the message for it.
 */

/** The login screen's message for the hash the gateway redirected back with. */
function loginMessage(hash: string): string | undefined {
  const sso = readSsoReturn(hash);
  return sso?.errorCode === undefined ? undefined : ssoErrorMessage(sso.errorCode);
}

describe("the login screen after an SSO sign-in", () => {
  it("says an account waits for the account migration and that an administrator runs it", () => {
    const message = loginMessage("#sai_error=migration_pending")!;
    expect(message).toMatch(/waiting for the account migration/);
    expect(message).toMatch(/administrator must run/i);
    expect(message).toContain("pnpm sai migrate-account-ids");
  });

  it("shows a message of its own for every refusal the gateway sends", () => {
    const generic = ssoErrorMessage("sso_failed");
    const codes = ["email_unverified", "username_invalid", "username_held", "accounts_unreadable", "migration_pending", "account_retired"];
    const messages = codes.map((code) => loginMessage(`#sai_error=${code}`)!);
    for (const [index, message] of messages.entries()) expect(message, codes[index]).not.toBe(generic);
    expect(new Set(messages).size).toBe(codes.length);
    expect(loginMessage("#sai_error=account_retired")).toMatch(/retired/);
    expect(loginMessage("#sai_error=username_held")).toMatch(/held by another account/);
    expect(loginMessage("#sai_error=email_unverified")).toMatch(/not verified/);
  });

  it("never shows text from the URL: a code it does not know gets the generic message", () => {
    const crafted = loginMessage(`#sai_error=${encodeURIComponent("Your session expired, call +1 555 0100")}`)!;
    expect(crafted).toBe(ssoErrorMessage("sso_failed"));
    expect(crafted).not.toContain("555");
    expect(loginMessage("#sai_error=toString")).toBe(ssoErrorMessage("sso_failed"));
  });

  it("takes a successful sign-in's token and shows nothing", () => {
    expect(readSsoReturn("#sai_token=header.payload.signature")).toEqual({ token: "header.payload.signature" });
    expect(loginMessage("#sai_token=header.payload.signature")).toBeUndefined();
    expect(readSsoReturn("")).toBeNull();
    expect(readSsoReturn("#/chat")).toBeNull();
  });
});
