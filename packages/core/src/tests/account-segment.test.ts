import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testAccount, testAccountId } from "./support/test-account.js";

/**
 * Per-account storage derives from the account id (S2 of the account-id design).
 *
 * Every user-scoped store took its bucket from the username (safeUserSegment of the JWT `sub`), so
 * an account deleted and created again under the same name, and an identity-provider subject that
 * claimed a released name, read and wrote what the one before left there. The identity now travels
 * whole from the boundary (the account id with the name), the bucket is the id, and a name that
 * reaches the derivation without its account fails loudly instead of guessing. A tool call never
 * pairs one identity's name with another's account.
 */

const warnings = vi.hoisted(() => [] as Array<{ logger: string; fields: Record<string, unknown>; msg: string }>);
vi.mock("../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logger.js")>();
  const quiet = () => undefined;
  const make = (name: string): Record<string, unknown> => ({
    trace: quiet, debug: quiet, info: quiet, error: quiet, fatal: quiet,
    warn: (fields: unknown, msg?: unknown) => {
      warnings.push({ logger: name, fields: (fields ?? {}) as Record<string, unknown>, msg: String(msg ?? "") });
    },
    child: () => make(name),
  });
  return { ...actual, childLogger: (name: string) => make(name) };
});

const FILE_DIR = mkdtempSync(join(tmpdir(), "starlingai-account-segment-"));
const CONFIG_PATH = join(FILE_DIR, "starlingai.json");
let workspace = "";

async function loadModules() {
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: "a".repeat(40) } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_SESSION_STORE"] = join(FILE_DIR, "sessions.json");
  process.env["SAI_AUDIT_LOG"] = join(FILE_DIR, "audit.jsonl");
  const loader = await import("../config/loader.js");
  const context = await import("../runtime/request-context.js");
  const scope = await import("../runtime/user-scope.js");
  const accounts = await import("../runtime/accounts.js");
  const registry = await import("../runtime/account-registry.js");
  const auth = await import("../gateway/auth.js");
  const tools = await import("../tools/registry.js");
  const sessions = await import("../agent/session.js");
  return { loader, context, scope, accounts, registry, auth, tools, sessions };
}

let mods: Awaited<ReturnType<typeof loadModules>>;

beforeAll(async () => {
  mods = await loadModules();
});

afterAll(() => {
  mods.loader.resetConfigForTests();
  for (const key of ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_SESSION_STORE", "SAI_AUDIT_LOG"]) delete process.env[key];
  rmSync(FILE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  warnings.length = 0;
});

/** Writes this test's configuration and loads it; a fresh workspace each time. */
function configure(auth: Record<string, unknown>, registry?: Record<string, unknown>): void {
  workspace = mkdtempSync(join(FILE_DIR, "ws-"));
  if (registry) {
    mkdirSync(join(workspace, ".starlingai"), { recursive: true });
    writeFileSync(join(workspace, ".starlingai", "accounts.json"), JSON.stringify(registry), "utf8");
  }
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: "a".repeat(40) }, workspacePath: workspace, auth }), "utf8");
  mods.loader.resetConfigForTests();
  mods.loader.loadConfig();
  mods.registry.resetAccountRegistryForTests();
}

/** The user-memory bucket a token's caller resolves to, the way every /api request derives it. */
async function bucketOf(token: string, base: string): Promise<string | null> {
  const user = await mods.auth.authenticatedUserFromToken(token);
  if (!user) return null;
  return mods.context.runWithRequestContext({ identity: mods.auth.callerIdentity(user) }, () => mods.scope.userScopedDir(base));
}

const SECOND_ALICE_ID = `alice-${"7".repeat(16)}`;

describe("an account's storage is keyed by its id", () => {
  it("gives an account deleted and created again under the same name a bucket of its own", async () => {
    const base = join(FILE_DIR, "user-memory");
    const first = testAccount("alice");
    configure({ enabled: true, users: [first.record] });
    const firstToken = await mods.auth.createToken("alice", first.claims);
    const firstBucket = await bucketOf(firstToken, base);
    expect(firstBucket).toBe(resolve(base, "users", first.id));

    // Deleted, and created again under the same name: a new id.
    configure({ enabled: true, users: [{ ...first.record, id: SECOND_ALICE_ID }] });
    const secondToken = await mods.auth.createToken("alice", { role: "operator", aid: SECOND_ALICE_ID });
    const secondBucket = await bucketOf(secondToken, base);
    expect(secondBucket).toBe(resolve(base, "users", SECOND_ALICE_ID));
    expect(secondBucket).not.toBe(firstBucket);
    // Neither is the bucket the username derives to, where the data from before ids sits.
    expect([firstBucket, secondBucket]).not.toContain(resolve(base, "users", mods.scope.safeUserSegment("alice")));

    // A session the new account opens works in the new account's root.
    const caller = await mods.auth.authenticatedUserFromToken(secondToken);
    const session = mods.sessions.createSession({ channel: "webchat", ...mods.auth.callerIdentity(caller) });
    expect(session.getWorkspacePath()).toBe(resolve(workspace, "users", SECOND_ALICE_ID));
    mods.sessions.deleteSession(session.id);
  });

  it("gives an identity-provider subject that claims a released name a bucket of its own", async () => {
    const base = join(FILE_DIR, "user-memory");
    const now = "2026-10-09T00:00:00.000Z";
    const entry = (id: string, subject: string, extra: Record<string, unknown>) => ({
      id, issuer: "https://idp.example.test", subject, username: "alice", firstSeenAt: now, lastSeenAt: now, ...extra,
    });
    // "Alice" signed in first, was retired and her name released; "alice", another person, then
    // signed in under it.
    const formerId = `oidc-${"1".repeat(16)}`;
    const currentId = `oidc-${"2".repeat(16)}`;
    configure(
      { enabled: true, provider: "oidc", oidc: { issuer: "https://idp.example.test", clientId: "sai" }, users: [] },
      {
        version: 1,
        bootstrapSubs: [],
        accounts: [
          entry(formerId, "subject-of-Alice", { status: "retired", retiredAt: now, usernameReleased: true }),
          entry(currentId, "subject-of-alice", { status: "active" }),
        ],
      },
    );
    expect(await bucketOf(await mods.auth.createToken("alice", { role: "operator", aid: formerId }), base)).toBeNull();
    const bucket = await bucketOf(await mods.auth.createToken("alice", { role: "operator", aid: currentId }), base);
    expect(bucket).toBe(resolve(base, "users", currentId));
    expect(mods.scope.segmentFor({ userId: "alice", account: formerId })).toBe(formerId);
    expect(bucket).not.toBe(resolve(base, "users", formerId));
  });

  it("treats a token from the empty-store window as an instance credential, whose sessions run turns", async () => {
    configure({ enabled: true, users: [] });
    const caller = await mods.auth.authenticatedUserFromToken(await mods.auth.createToken("admin", { role: "admin" }));
    expect(mods.auth.callerIdentity(caller)).toEqual({ userId: "admin", principal: "bootstrap" });
    const session = mods.sessions.createSession({ channel: "webchat", ...mods.auth.callerIdentity(caller) });
    expect(session.isLegacy()).toBe(false);
    expect(session.getWorkspacePath()).toBe(resolve(workspace, "users", mods.scope.safeUserSegment("admin")));
    mods.sessions.deleteSession(session.id);
    // With one operator a caller is its name alone, as before.
    configure({ enabled: false, users: [] });
    expect(mods.auth.callerIdentity(await mods.auth.authenticatedUserFromToken(await mods.auth.createToken("admin", { role: "admin" }))))
      .toEqual({ userId: "admin" });
  });

  it("refuses an account id that is not segment-shaped rather than joining it into a path", () => {
    configure({ enabled: true, users: [testAccount("alice").record] });
    expect(() => mods.scope.segmentFor({ userId: "alice", account: "../../etc" })).toThrow(/not an account id/);
  });
});

describe("the identity guard", () => {
  it("refuses to derive storage from a name an account holds when no account came with it", () => {
    // zed's id is what the name "eve" derives to, as an extension provider's account ids are.
    configure({
      enabled: true,
      users: [testAccount("alice").record, { ...testAccount("zed").record, id: mods.accounts.safeUserSegment("eve") }],
    });
    const { segmentFor, userScopedDir, AccountNotThreadedError } = mods.scope;
    expect(() => segmentFor({ userId: "alice" })).toThrow(AccountNotThreadedError);
    expect(() => segmentFor({ userId: "ALICE" })).toThrow(AccountNotThreadedError);
    expect(() => segmentFor({ userId: "eve" })).toThrow(/derives to an account's id/);
    expect(() => segmentFor({ userId: "carol\u0007" })).toThrow(/control characters/);
    expect(() => userScopedDir("/base", { userId: "alice" })).toThrow(AccountNotThreadedError);
    // A name no account holds is a principal's, in the bucket its name always had.
    expect(segmentFor({ userId: "carol" })).toBe(mods.scope.safeUserSegment("carol"));
    // With its kind, a principal never meets the guard, even under an account's name.
    expect(segmentFor({ userId: "alice", principal: "bootstrap" })).toBe(mods.scope.safeUserSegment("alice"));
    expect(segmentFor({ userId: "alice", account: testAccountId("alice") })).toBe(testAccountId("alice"));
  });

  it("holds a name an identity-provider account holds, a retired one's too, until it is released", () => {
    const now = "2026-10-09T00:00:00.000Z";
    configure({ enabled: true, users: [] }, {
      version: 1,
      bootstrapSubs: [],
      accounts: [{ id: `oidc-${"3".repeat(16)}`, issuer: "https://idp", subject: "s", username: "bob@example.com", status: "retired", retiredAt: now, firstSeenAt: now, lastSeenAt: now }],
    });
    expect(() => mods.scope.segmentFor({ userId: "Bob@Example.com" })).toThrow(/identity-provider account/);
  });

  it("never runs with multi-user auth off: one operator, one shared store", () => {
    configure({ enabled: false, users: [testAccount("alice").record] });
    expect(mods.scope.segmentFor({ userId: "alice" })).toBeUndefined();
    expect(mods.scope.userScopedDir("/base", { userId: "alice" })).toBe("/base");
  });

  it("logs the refusal when a record is stamped for an identity that was not threaded", () => {
    configure({ enabled: true, users: [testAccount("alice").record] });
    const stamped = mods.context.runWithRequestContext({ identity: { userId: "alice" } }, () => mods.scope.recordAccount());
    expect(stamped).toBeUndefined();
    expect(warnings).toEqual([expect.objectContaining({
      logger: "runtime:user-scope",
      fields: expect.objectContaining({ userId: "alice" }),
      msg: expect.stringMatching(/carries no account and nobody can read it/),
    })]);
    // Threaded, it stamps the account and logs nothing.
    warnings.length = 0;
    const account = testAccountId("alice");
    expect(mods.context.runWithRequestContext({ identity: { userId: "alice", account } }, () => mods.scope.recordAccount())).toBe(account);
    expect(warnings).toEqual([]);
  });
});

describe("a tool call acts as one identity, never two", () => {
  // A read-only tool's name (an unknown name is blocked); this module graph registers no real tool.
  const PROBE = "read_file";
  const seen: Array<{ segment: string | undefined; identity: unknown }> = [];

  beforeAll(() => {
    mods.tools.registerTool({
      name: PROBE,
      description: "test probe",
      parameters: { type: "object", properties: {} },
      async execute() {
        seen.push({ segment: mods.scope.segmentFor(), identity: mods.context.currentIdentity() });
        return { success: true, output: "ok" };
      },
    });
  });

  beforeEach(() => {
    seen.length = 0;
  });

  it("runs a workflow principal's call in the principal's bucket inside an account's turn", async () => {
    configure({ enabled: true, users: [testAccount("alice").record] });
    const alice = { userId: "alice", account: testAccountId("alice") };
    const workflow = { userId: "workflow:nightly-report", principal: "synthetic" as const };
    await mods.context.runWithRequestContext({ identity: alice }, async () => {
      // Threaded whole.
      await mods.tools.executeTool(PROBE, {}, { sessionId: "s", workspacePath: workspace, userId: workflow.userId, identity: workflow });
      // Only its name threaded: still never alice's account.
      await mods.tools.executeTool(PROBE, {}, { sessionId: "s", workspacePath: workspace, userId: workflow.userId });
      // Naming the turn's own user, or nobody: the turn's identity, whole.
      await mods.tools.executeTool(PROBE, {}, { sessionId: "s", workspacePath: workspace, userId: "alice" });
      await mods.tools.executeTool(PROBE, {}, { sessionId: "s", workspacePath: workspace });
    });
    const principalBucket = mods.scope.safeUserSegment("workflow:nightly-report");
    expect(seen.map((call) => call.segment)).toEqual([principalBucket, principalBucket, alice.account, alice.account]);
    expect(seen[0]!.identity).toEqual(workflow);
    expect(seen[1]!.identity).toEqual({ userId: "workflow:nightly-report" });
    expect(seen[2]!.identity).toEqual(alice);
  });

  it("refuses a call that names an account's username without the account, inside another identity", async () => {
    configure({ enabled: true, users: [testAccount("alice").record, testAccount("bob").record] });
    const bob = { userId: "bob", account: testAccountId("bob") };
    const result = await mods.context.runWithRequestContext({ identity: bob }, () =>
      mods.tools.executeTool(PROBE, {}, { sessionId: "s", workspacePath: workspace, userId: "alice" }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/carries no account id or principal kind/);
    expect(seen).toEqual([]);
  });
});
