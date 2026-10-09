import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_ID_RE } from "../runtime/accounts.js";
import { testAccountId } from "./support/test-account.js";

/**
 * Creating and deleting accounts was operator-only, and operator is every account's default role.
 * Sessions, the per-user workspace and memory are keyed by username, so any account could delete
 * "alice", create "alice" again with its own password, sign in, and be her — past the admin-only
 * session rule. Under OIDC it did not even need the delete: SSO users are not in auth.users, so a
 * local "alice" passed the duplicate check and became the SSO user "alice".
 *
 * These tests mount the REAL routes (gateway/user-routes.ts), not a copy.
 */

const DUMMY_HASH = "$2b$10$0123456789abcdefghijklmno";

function account(username: string, role: string, id: string = testAccountId(username)): Record<string, unknown> {
  return { username, role, passwordHash: DUMMY_HASH, createdAt: "2026-01-01T00:00:00Z", id };
}

const tempDirs: string[] = [];
let tempDir: string | null = null;

function writeConfig(auth: Record<string, unknown>): string {
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-user-routes-"));
  tempDirs.push(tempDir);
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({ gateway: { jwtSecret: "u".repeat(40) }, workspacePath: tempDir, auth }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = configPath;
  process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
  return tempDir;
}

async function boot(auth: Record<string, unknown>) {
  writeConfig(auth);
  vi.resetModules();
  const [{ registerUserRoutes }, authModule, loader, session] = await Promise.all([
    import("../gateway/user-routes.js"),
    import("../gateway/auth.js"),
    import("../config/loader.js"),
    import("../agent/session.js"),
  ]);
  const app = new Hono();
  registerUserRoutes(app);
  // An account's token names its id, as /api/auth/login mints it; a name with no record gets a
  // bootstrap token, as `sai token` mints it.
  const tokenFor = async (username: string, role: string) => {
    const id = loader.getConfig().auth.users.find((u) => u.username === username)?.id;
    return `Bearer ${await authModule.createToken(username, id ? { role, aid: id } : { role, bst: true })}`;
  };
  const create = async (as: string, username: string) => app.request("/api/auth/users", {
    method: "POST",
    headers: { Authorization: as, "content-type": "application/json" },
    body: JSON.stringify({ username, password: "long-enough-password" }),
  });
  const remove = async (as: string, username: string) => app.request(`/api/auth/users/${username}`, {
    method: "DELETE",
    headers: { Authorization: as },
  });
  const resetPassword = async (as: string, username: string, password: string) => app.request(`/api/auth/users/${username}`, {
    method: "PATCH",
    headers: { Authorization: as, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const usernames = () => loader.getConfig().auth.users.map((u) => u.username);
  const passwordHashOf = (username: string) => loader.getConfig().auth.users.find((u) => u.username === username)?.passwordHash;
  const idOf = (username: string) => loader.getConfig().auth.users.find((u) => u.username === username)?.id;
  return { app, tokenFor, create, remove, resetPassword, usernames, passwordHashOf, idOf, session, authModule };
}

afterEach(async () => {
  // The audit write is asynchronous: let it land before its directory goes.
  const audit = await import("../audit/logger.js");
  await audit.flushAuditLog();
  const session = await import("../agent/session.js");
  session.resetSessionsForTests();
  const loader = await import("../config/loader.js");
  loader.resetConfigForTests();
  const auth = await import("../gateway/auth.js");
  auth.resetAuthStateForTests();
  delete process.env["SAI_CONFIG_PATH"];
  delete process.env["SAI_MUTABLE_CONFIG_PATH"];
  delete process.env["SAI_AUDIT_LOG"];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  tempDir = null;
  vi.resetModules();
});

describe("account management is admin-only", () => {
  it("refuses an operator both halves of the take-over: deleting an account and creating one", async () => {
    const { tokenFor, create, remove, usernames } = await boot({
      enabled: true,
      users: [account("alice", "operator"), account("bob", "operator")],
    });
    const bob = await tokenFor("bob", "operator");
    expect((await remove(bob, "alice")).status).toBe(403);
    expect((await create(bob, "mallory")).status).toBe(403);
    expect(usernames()).toEqual(["alice", "bob"]);
  });

  it("lets an admin create and delete accounts", async () => {
    const { tokenFor, create, remove, usernames } = await boot({
      enabled: true,
      users: [account("root", "admin"), account("alice", "operator")],
    });
    const root = await tokenFor("root", "admin");
    expect((await create(root, "carol")).status).toBe(200);
    expect(usernames()).toEqual(["root", "alice", "carol"]);
    expect((await remove(root, "carol")).status).toBe(200);
    expect(usernames()).toEqual(["root", "alice"]);
  });

  it("still creates the first account with the bootstrap token, auth on or off", async () => {
    // `sai token` mints { sub: "admin", role: "admin", bst: true }: a bootstrap token, which resolves
    // with no accounts yet and after.
    const enabled = await boot({ enabled: true, users: [] });
    expect((await enabled.create(await enabled.tokenFor("admin", "admin"), "steffen")).status).toBe(200);
    expect(enabled.usernames()).toEqual(["steffen"]);

    // With auth off the gateway prints the same kind of token; the first account switches auth on.
    const disabled = await boot({ enabled: false, users: [] });
    expect((await disabled.create(await disabled.tokenFor("admin", "admin"), "steffen")).status).toBe(200);
    const loader = await import("../config/loader.js");
    expect(loader.getConfig().auth.enabled).toBe(true);
  });

  it("does not count an admin out of the last-operator floor", async () => {
    // Counting only role "operator" refused to delete a viewer from a roster of one admin.
    const { tokenFor, remove, usernames } = await boot({
      enabled: true,
      users: [account("root", "admin"), account("viewer1", "viewer")],
    });
    expect((await remove(await tokenFor("root", "admin"), "viewer1")).status).toBe(200);
    expect(usernames()).toEqual(["root"]);
  });

  it("refuses to delete the last admin, even with operators left", async () => {
    // Only an admin can manage accounts and no route makes one, so this left only `sai token`.
    const { tokenFor, remove, usernames } = await boot({
      enabled: true,
      users: [account("root", "admin"), account("alice", "operator")],
    });
    const refused = await remove(await tokenFor("root", "admin"), "root");
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("last admin");
    expect(usernames()).toEqual(["root", "alice"]);
  });

  it("deletes an admin while another admin remains", async () => {
    const { tokenFor, remove, usernames } = await boot({
      enabled: true,
      users: [account("root", "admin"), account("second", "admin"), account("alice", "operator")],
    });
    expect((await remove(await tokenFor("root", "admin"), "second")).status).toBe(200);
    expect(usernames()).toEqual(["root", "alice"]);
  });
});

/**
 * Re-creating an account whose name owns sessions is refused, so a forgotten password had no fix
 * short of editing the config file. An admin sets a new one instead.
 */
describe("an admin resets a password", () => {
  it("stores a new hash that the new password verifies against", async () => {
    const { tokenFor, resetPassword, passwordHashOf, authModule } = await boot({
      enabled: true,
      users: [account("root", "admin"), account("alice", "operator")],
    });
    const reset = await resetPassword(await tokenFor("root", "admin"), "Alice", "brand-new-password");
    expect(reset.status).toBe(200);
    const hash = passwordHashOf("alice")!;
    expect(hash).not.toBe(DUMMY_HASH);
    expect(await authModule.verifyPassword("brand-new-password", hash)).toBe(true);
  });

  it("is admin-only, validates like account creation, and needs an existing account", async () => {
    const { tokenFor, resetPassword, passwordHashOf } = await boot({
      enabled: true,
      users: [account("root", "admin"), account("alice", "operator"), account("bob", "operator")],
    });
    // An operator resetting another operator's password is the take-over the admin gate closed.
    expect((await resetPassword(await tokenFor("bob", "operator"), "alice", "bob-knows-this")).status).toBe(403);
    const root = await tokenFor("root", "admin");
    expect((await resetPassword(root, "alice", "short")).status).toBe(400);
    expect((await resetPassword(root, "nobody", "long-enough-password")).status).toBe(404);
    expect(passwordHashOf("alice")).toBe(DUMMY_HASH);
  });
});

describe("a new account never takes a name someone else already holds", () => {
  it("refuses a username that owns sessions, archived ones included", async () => {
    const { tokenFor, create, usernames, session } = await boot({ enabled: true, users: [account("root", "admin")] });
    // alice's account was deleted; her conversations were not.
    const hers = session.createSession({ channel: "webchat", workspacePath: tempDir!, userId: "alice" });
    session.archiveSession(hers.id);
    const root = await tokenFor("root", "admin");
    const refused = await create(root, "alice");
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("owns sessions");
    expect((await create(root, "dave")).status).toBe(200);
    expect(usernames()).toEqual(["root", "dave"]);
  });

  it("creates no local account while the identity provider owns the usernames", async () => {
    const { tokenFor, create, usernames, app } = await boot({ enabled: true, provider: "oidc", users: [] });
    const admin = await tokenFor("admin", "admin");
    const refused = await create(admin, "alice");
    expect(refused.status).toBe(409);
    expect(usernames()).toEqual([]);
    // The roster says so, for the Users page to hide account creation.
    const roster = await app.request("/api/auth/users", { headers: { Authorization: admin } });
    expect(((await roster.json()) as { provider: string }).provider).toBe("oidc");
  });
});

/**
 * Per-account storage is keyed by an immutable account id, not the username: the id is minted when
 * the account is created and must survive every later change to the roster. The DELETE route
 * rewrote every remaining record with five named fields, so each delete stripped every other
 * account's id.
 */
describe("account ids", () => {
  const ALICE_ID = "alice-0123456789abcdef";
  const ROOT_ID = "root-fedcba9876543210";
  const ledgerLines = (): Array<Record<string, unknown>> => {
    const path = join(tempDir!, ".starlingai", "account-migrations.ndjson");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  it("mints a random id for a new account and records it in the account ledger", async () => {
    const { tokenFor, create, remove, idOf } = await boot({ enabled: true, users: [account("root", "admin", ROOT_ID)] });
    const root = await tokenFor("root", "admin");
    expect((await create(root, "carol")).status).toBe(200);
    const first = idOf("carol");
    expect(first).toMatch(ACCOUNT_ID_RE);
    expect(first).toMatch(/^carol-[0-9a-f]{16}$/);
    const [created] = ledgerLines();
    expect(created).toEqual({ event: "created", id: first, username: "carol", at: expect.any(String) });

    // A name deleted and created again is a new account: a new id, so none of the old storage.
    expect((await remove(root, "carol")).status).toBe(200);
    expect((await create(root, "carol")).status).toBe(200);
    const second = idOf("carol");
    expect(second).toMatch(ACCOUNT_ID_RE);
    expect(second).not.toBe(first);
    expect(ledgerLines().map((entry) => entry["id"])).toEqual([first, second]);
  });

  it("creates no account when the id cannot be recorded", async () => {
    const { tokenFor, create, usernames } = await boot({ enabled: true, users: [account("root", "admin", ROOT_ID)] });
    // The state directory is a file: the ledger cannot be written.
    writeFileSync(join(tempDir!, ".starlingai"), "not a directory");
    const refused = await create(await tokenFor("root", "admin"), "carol");
    expect(refused.status).toBe(500);
    expect(usernames()).toEqual(["root"]);
  });

  it("keeps every other account's id when one is deleted", async () => {
    const { tokenFor, remove, idOf, usernames } = await boot({
      enabled: true,
      users: [account("root", "admin", ROOT_ID), account("alice", "operator", ALICE_ID), account("bob", "operator", "bob-1111111111111111")],
    });
    expect((await remove(await tokenFor("root", "admin"), "bob")).status).toBe(200);
    expect(usernames()).toEqual(["root", "alice"]);
    expect(idOf("alice")).toBe(ALICE_ID);
    expect(idOf("root")).toBe(ROOT_ID);
  });

  it("keeps the id when an admin sets a new password", async () => {
    const { tokenFor, resetPassword, idOf } = await boot({
      enabled: true,
      users: [account("root", "admin", ROOT_ID), account("alice", "operator", ALICE_ID)],
    });
    expect((await resetPassword(await tokenFor("root", "admin"), "alice", "brand-new-password")).status).toBe(200);
    expect(idOf("alice")).toBe(ALICE_ID);
  });
});
