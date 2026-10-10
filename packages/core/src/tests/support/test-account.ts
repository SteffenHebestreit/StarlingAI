/**
 * Accounts for tests that run under multi-user auth.
 *
 * A session token resolves only when it names its account by id (the `aid` claim) and the roster
 * record still holds that id and username; a bootstrap token carries `bst`. Tests that write a
 * roster and mint tokens directly use these, so the record and the token agree.
 *
 * The id is derived from the username, so a test can name it before the record exists. Production
 * ids are random (runtime/accounts.ts); this is a fixture, never a formula the gateway uses.
 */
import { createHash } from "node:crypto";
import { accountIdSlug } from "../../runtime/accounts.js";

/** A bcrypt-shaped hash no password verifies against: for records whose tokens are minted directly. */
export const DUMMY_PASSWORD_HASH = "$2b$10$0123456789abcdefghijklmno";

/** The fixed test id of `username`'s account. */
export function testAccountId(username: string): string {
  return `${accountIdSlug(username)}-${createHash("sha256").update(`test-account:${username}`).digest("hex").slice(0, 16)}`;
}

export interface TestAccount {
  id: string;
  /** The roster record, ready for `auth.users`. */
  record: Record<string, unknown>;
  /** The claims a session token for this account carries (pass to createToken with the username). */
  claims: Record<string, unknown>;
}

/** A roster record and its token claims for `username` with `role`. */
export function testAccount(username: string, role = "operator", extra: Record<string, unknown> = {}): TestAccount {
  const id = testAccountId(username);
  return {
    id,
    record: { username, role, passwordHash: DUMMY_PASSWORD_HASH, createdAt: "2026-01-01T00:00:00Z", id, ...extra },
    claims: { role, aid: id, ...(typeof extra["displayName"] === "string" ? { displayName: extra["displayName"] } : {}) },
  };
}

/** The claims of a bootstrap token (`sai token`): an instance credential, never an account. */
export function bootstrapClaims(role = "admin"): Record<string, unknown> {
  return { role, bst: true };
}
