/**
 * A restored session's working root comes from its identity, never from a guess (S2).
 *
 * The restore handed a stored root back through userWorkspaceRoot with the record's username, which
 * re-derived the bucket from the name and stripped only the levels of that same name. An account's
 * record now restores to the account's own bucket, whatever username segment it was stored under
 * and however it nested; a record written before account ids (a userId and no kind) keeps the root
 * it was stored with, since any other would be derived from the name; a principal's record
 * restores to its own segment. With multi-user auth off every record keeps its stored root.
 *
 * A turn on a session from before account ids is refused under multi-user auth: it would need an
 * identity to derive storage from, and for that session the identity would be a guess.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testAccount, testAccountId } from "./support/test-account.js";

vi.mock("../agent/session-redis.js", () => ({
  saveSessionToRedis: async () => undefined,
  loadSessionFromRedis: async () => null,
  deleteSessionFromRedis: async () => undefined,
  loadAllSessionsFromRedis: async () => [],
  getChannelSessionId: async () => null,
  setChannelSessionId: async () => undefined,
}));

let tempDir: string;
let workspace: string;
let storePath: string;

function record(id: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    channel: "webchat",
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:05:00.000Z",
    systemPrompt: "You are a test agent.",
    turnCount: 1,
    history: [{ role: "user", content: `hello from ${id}`, timestamp: "2026-10-01T10:01:00.000Z" }],
    ...overrides,
  };
}

function writeConfig(authEnabled: boolean): void {
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    gateway: { jwtSecret: "r".repeat(40) },
    workspacePath: workspace,
    auth: { enabled: authEnabled, users: [testAccount("alice").record] },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = configPath;
}

function writeStore(records: Array<Record<string, unknown>>): void {
  writeFileSync(storePath, `${JSON.stringify({ sessions: records })}\n`, "utf8");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-restore-root-"));
  workspace = join(tempDir, "workspace");
  storePath = join(tempDir, "sessions.json");
  process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
  process.env["SAI_SESSION_STORE"] = storePath;
  vi.resetModules();
});

afterEach(async () => {
  const audit = await import("../audit/logger.js");
  await audit.flushAuditLog();
  (await import("../config/loader.js")).resetConfigForTests();
  for (const key of ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_AUDIT_LOG", "SAI_SESSION_STORE"]) delete process.env[key];
  rmSync(tempDir, { recursive: true, force: true });
  vi.resetModules();
});

const ALICE = testAccountId("alice");

describe("restoring a session's working root", () => {
  it("restores an account's session to the account's bucket, never nesting", async () => {
    writeConfig(true);
    const { safeUserSegment } = await import("../runtime/accounts.js");
    const nameSegment = safeUserSegment("alice");
    const legacyNested = join(workspace, "users", nameSegment, "users", nameSegment);
    writeStore([
      // Stored under the username's segment (as written before ids, then stamped with the account).
      record("stamped", { userId: "alice", account: ALICE, workspacePath: join(workspace, "users", nameSegment) }),
      // Nested by an earlier restore.
      record("nested", { userId: "alice", account: ALICE, workspacePath: join(workspace, "users", ALICE, "users", ALICE) }),
      // A channel principal's.
      record("channel", { channel: "telegram", userId: "555", principal: "channel", workspacePath: join(workspace, "users", "x-0000000000000000") }),
      // From before account ids: kept as stored, nesting and all.
      record("legacy", { userId: "alice", workspacePath: legacyNested }),
    ]);
    const store = await import("../agent/session.js");
    expect(store.getSession("stamped")!.getWorkspacePath()).toBe(resolve(workspace, "users", ALICE));
    expect(store.getSession("nested")!.getWorkspacePath()).toBe(resolve(workspace, "users", ALICE));
    expect(store.getSession("channel")!.getWorkspacePath()).toBe(resolve(workspace, "users", safeUserSegment("555")));
    expect(store.getSession("legacy")!.getWorkspacePath()).toBe(legacyNested);
    expect(store.getSession("stamped")!.identity()).toEqual({ userId: "alice", account: ALICE });
    expect(store.getSession("legacy")!.isLegacy()).toBe(true);
    expect(store.getSession("stamped")!.isLegacy()).toBe(false);
  });

  it("keeps every stored root with multi-user auth off", async () => {
    writeConfig(false);
    const stored = join(workspace, "users", "alice-1111111111111111");
    writeStore([
      record("stamped", { userId: "alice", account: ALICE, workspacePath: stored }),
      record("legacy", { userId: "alice", workspacePath: stored }),
    ]);
    const store = await import("../agent/session.js");
    expect(store.getSession("stamped")!.getWorkspacePath()).toBe(stored);
    expect(store.getSession("legacy")!.getWorkspacePath()).toBe(stored);
  });

  it("persists the identity's kind, and nothing new for a session that has none", async () => {
    writeConfig(true);
    const store = await import("../agent/session.js");
    store.createSession({ sessionId: "acct", channel: "webchat", userId: "alice", account: ALICE });
    store.createSession({ sessionId: "bot", channel: "telegram", userId: "555", principal: "channel" });
    store.createSession({ sessionId: "nobody", channel: "webchat", workspacePath: workspace });
    await store.flushSessionStore();
    const saved = (JSON.parse(readFileSync(storePath, "utf8")) as { sessions: Array<Record<string, unknown>> }).sessions;
    const byId = new Map(saved.map((entry) => [entry["id"], entry]));
    expect(byId.get("acct")).toMatchObject({ userId: "alice", account: ALICE, workspacePath: resolve(workspace, "users", ALICE) });
    expect(byId.get("acct")).not.toHaveProperty("principal");
    expect(byId.get("bot")).toMatchObject({ userId: "555", principal: "channel" });
    expect(byId.get("nobody")).not.toHaveProperty("account");
    expect(byId.get("nobody")).not.toHaveProperty("principal");
  });
});

describe("a turn on a session from before account ids", () => {
  it("is refused under multi-user auth, and runs with auth off", async () => {
    writeConfig(true);
    writeStore([
      record("legacy", { userId: "alice", workspacePath: join(workspace, "users", "alice-2222222222222222") }),
      record("stamped", { userId: "alice", account: ALICE, workspacePath: join(workspace, "users", ALICE) }),
      record("ownerless", { workspacePath: workspace }),
    ]);
    const store = await import("../agent/session.js");
    const { prepareLegacySession, LEGACY_SESSION_REFUSAL } = await import("../agent/turn-prepare.js");
    expect(prepareLegacySession(store.getSession("legacy")!)).toMatchObject({ blocked: true, response: LEGACY_SESSION_REFUSAL });
    expect(prepareLegacySession(store.getSession("stamped")!)).toBeNull();
    expect(prepareLegacySession(store.getSession("ownerless")!)).toBeNull();

    writeConfig(false);
    const loader = await import("../config/loader.js");
    loader.resetConfigForTests();
    loader.loadConfig();
    expect(prepareLegacySession(store.getSession("legacy")!)).toBeNull();
  });
});
