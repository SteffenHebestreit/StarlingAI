/**
 * Restoring the session store never loses a record (2026-10-09).
 *
 * The load was one `try` around the whole loop: a record that did not restore aborted it, the
 * sessions after it never loaded, and the next flush (which writes the whole store) dropped all of
 * them. A file that did not parse was overwritten by the first flush the same way. Each record now
 * restores on its own and one that does not is written back as it was read; a file that cannot be
 * read as a store is set aside before anything can write over it. A store that restores whole
 * flushes exactly the text it always did.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redisSaves = vi.hoisted(() => vi.fn(async (_id: string, _json: string, _updatedAtMs: number) => undefined));
vi.mock("../agent/session-redis.js", () => ({
  saveSessionToRedis: (id: string, json: string, updatedAtMs: number) => redisSaves(id, json, updatedAtMs),
  loadSessionFromRedis: async () => null,
  deleteSessionFromRedis: async () => undefined,
  loadAllSessionsFromRedis: async () => [],
}));

/** When set, renaming the store aside fails, as a file another process holds open would. */
const fsControl = vi.hoisted(() => ({ failRenameOf: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const renameSync = ((from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
    if (fsControl.failRenameOf !== null && String(from) === fsControl.failRenameOf) {
      throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    }
    return actual.renameSync(from, to);
  }) as typeof actual.renameSync;
  return { ...actual, renameSync, default: { ...actual, renameSync } };
});

let tempDir: string;
let storePath: string;

function record(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    channel: "webchat",
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:05:00.000Z",
    systemPrompt: "You are a test agent.",
    workspacePath: tempDir,
    turnCount: 1,
    history: [{ role: "user", content: `hello from ${id}`, timestamp: "2026-10-01T10:01:00.000Z" }],
    ...overrides,
  };
}

function writeStore(records: Array<Record<string, unknown>>): void {
  writeFileSync(storePath, `${JSON.stringify({ sessions: records })}\n`, "utf8");
}

const storedIds = (): string[] => (JSON.parse(readFileSync(storePath, "utf8")) as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
const setAside = (): string[] => readdirSync(tempDir).filter((name) => name.startsWith("sessions.json.unreadable-"));

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-session-restore-"));
  storePath = join(tempDir, "sessions.json");
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({ gateway: { jwtSecret: "s".repeat(40) }, workspacePath: tempDir }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = configPath;
  process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
  process.env["SAI_SESSION_STORE"] = storePath;
  fsControl.failRenameOf = null;
  redisSaves.mockClear();
  vi.resetModules();
});

afterEach(async () => {
  const audit = await import("../audit/logger.js");
  await audit.flushAuditLog();
  const loader = await import("../config/loader.js");
  loader.resetConfigForTests();
  fsControl.failRenameOf = null;
  for (const key of ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_AUDIT_LOG", "SAI_SESSION_STORE"]) delete process.env[key];
  rmSync(tempDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("restoring the session store", () => {
  it("restores the records around one that does not, and writes that one back byte for byte", async () => {
    // `history: 5` makes AgentSession.fromRecord throw (it spreads the history).
    const bad = record("bad", { history: 5 });
    writeStore([record("first"), bad, record("after")]);
    const store = await import("../agent/session.js");
    expect(store.getSession("first")).toBeDefined();
    expect(store.getSession("after")).toBeDefined();
    expect(store.getSession("bad")).toBeUndefined();

    store.getSession("first")!.addMessage({ role: "assistant", content: "a change, so the store is written" });
    await store.flushSessionStore();
    expect(storedIds()).toEqual(["first", "after", "bad"]);
    expect(readFileSync(storePath, "utf8")).toContain(JSON.stringify(bad));
  });

  it("keeps a record whose dates do not parse, and keeps writing the store", async () => {
    // It restores, but writing it back throws (Invalid Date has no ISO string): every flush threw.
    const undated = record("undated", { createdAt: "not a date" });
    writeStore([record("first"), undated]);
    const store = await import("../agent/session.js");
    expect(store.getSession("undated")).toBeUndefined();

    store.createSession({ channel: "webchat", workspacePath: tempDir, systemPrompt: "You are a test agent.", sessionId: "new" });
    await store.flushSessionStore();
    expect(storedIds()).toEqual(["first", "new", "undated"]);
    expect(readFileSync(storePath, "utf8")).toContain(JSON.stringify(undated));
  });

  it("drops a record that did not restore once a live session holds its id", async () => {
    writeStore([record("bad", { history: 5 })]);
    const store = await import("../agent/session.js");
    store.createSession({ channel: "webchat", workspacePath: tempDir, systemPrompt: "You are a test agent.", sessionId: "bad" });
    await store.flushSessionStore();
    expect(storedIds()).toEqual(["bad"]);
    store.deleteSession("bad");
    await store.flushSessionStore();
    expect(storedIds()).toEqual([]);
  });

  it("sets aside a file that does not parse, or is not a store, before anything writes", async () => {
    for (const unreadable of ["{\"sessions\":[{\"id\":\"cut off", "{\"sessions\":{\"id\":\"not a list\"}}"]) {
      rmSync(storePath, { force: true });
      for (const name of setAside()) rmSync(join(tempDir, name));
      writeFileSync(storePath, unreadable, "utf8");
      vi.resetModules();
      const store = await import("../agent/session.js");
      const [aside] = setAside();
      expect(aside).toMatch(/^sessions\.json\.unreadable-\d{8}T\d{6}Z$/);
      expect(readFileSync(join(tempDir, aside!), "utf8")).toBe(unreadable);

      store.createSession({ channel: "webchat", workspacePath: tempDir, systemPrompt: "You are a test agent.", sessionId: "new" });
      await store.flushSessionStore();
      expect(storedIds()).toEqual(["new"]);
      expect(readFileSync(join(tempDir, aside!), "utf8")).toBe(unreadable);
      store.resetSessionsForTests();
      await store.flushSessionStore();
    }
  });

  it("writes nothing over a file it could neither read nor set aside; Redis still mirrors", async () => {
    const unreadable = "{\"sessions\":[{\"id\":\"cut off";
    writeFileSync(storePath, unreadable, "utf8");
    fsControl.failRenameOf = storePath;
    const store = await import("../agent/session.js");
    expect(setAside()).toEqual([]);

    store.createSession({ channel: "webchat", workspacePath: tempDir, systemPrompt: "You are a test agent.", sessionId: "new" });
    await store.flushSessionStore();
    expect(readFileSync(storePath, "utf8")).toBe(unreadable);
    expect(redisSaves.mock.calls.map(([id]) => id)).toEqual(["new"]);
  });

  it("flushes a store that restores whole as exactly the text it was", async () => {
    const writer = await import("../agent/session.js");
    for (const id of ["one", "two"]) {
      const session = writer.createSession({ channel: "webchat", workspacePath: tempDir, systemPrompt: "You are a test agent.", sessionId: id });
      session.addMessage({ role: "user", content: `hello ${id}` });
    }
    writer.archiveSession("two");
    await writer.flushSessionStore();
    const text = readFileSync(storePath, "utf8");

    vi.resetModules();
    const reader = await import("../agent/session.js");
    // (Listed newest first by updatedAt, which may or may not differ by a millisecond: compare sets.)
    expect(reader.getAllSessions({ includeArchived: true }).map((s) => s.id).sort()).toEqual(["one", "two"]);
    // A structural change and its undo: the store is written, with nothing in it changed.
    reader.createSession({ channel: "webchat", workspacePath: tempDir, systemPrompt: "You are a test agent.", sessionId: "transient" });
    reader.deleteSession("transient");
    await reader.flushSessionStore();
    expect(readFileSync(storePath, "utf8")).toBe(text);
    expect(existsSync(`${storePath}.unreadable`)).toBe(false);
    expect(setAside()).toEqual([]);
  });
});
