/**
 * The session store is written once per window, not once per change (2026-10-05).
 *
 * Every addMessage / incrementTurn used to rewrite ALL sessions synchronously as pretty-printed
 * JSON on the event loop, and stringify the changed one a second time for Redis — several times per
 * tool round, each write growing with every session's whole history. A change now marks the store
 * dirty, one async write per ~250 ms carries the window, only the sessions that changed are
 * serialized again, and the Redis mirror sends that same text once per flush.
 *
 * Each test below fails when its half of that is reverted: an immediate write per change, an
 * eager re-serialization of every session, or a mirror that ignores a delete.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeSpy = vi.hoisted(() => vi.fn());
/** writeGate: every async write waits for it. tornWrites: a write lands half its text, then fails. */
const writeControl = vi.hoisted(() => ({ writeGate: Promise.resolve() as Promise<void>, tornWrites: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const writeFile = (async (...args: Parameters<typeof actual.writeFile>) => {
    writeSpy(...args);
    await writeControl.writeGate;
    if (writeControl.tornWrites) {
      const text = String(args[1]);
      await actual.writeFile(args[0], text.slice(0, Math.floor(text.length / 2)), "utf8");
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    }
    return actual.writeFile(...args);
  }) as typeof actual.writeFile;
  return { ...actual, writeFile, default: { ...actual, writeFile } };
});

const redisSaves = vi.hoisted(() => vi.fn(async (_id: string, _json: string, _updatedAtMs: number) => undefined));
vi.mock("../agent/session-redis.js", () => ({
  saveSessionToRedis: (id: string, json: string, updatedAtMs: number) => redisSaves(id, json, updatedAtMs),
  loadSessionFromRedis: async () => null,
  deleteSessionFromRedis: async () => undefined,
  loadAllSessionsFromRedis: async () => [],
}));

let tempDir: string;
let storePath: string;

/** The store writes that went to this test's file (other modules may write elsewhere). Each goes
 *  to a temp file beside the store, renamed over it. */
const storeWrites = () => writeSpy.mock.calls.filter((args) => String(args[0]).startsWith(storePath));

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-session-store-"));
  storePath = join(tempDir, "sessions.json");
  process.env["SAI_SESSION_STORE"] = storePath;
  writeControl.writeGate = Promise.resolve();
  writeControl.tornWrites = false;
  writeSpy.mockClear();
  redisSaves.mockClear();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env["SAI_SESSION_STORE"];
  rmSync(tempDir, { recursive: true, force: true });
});

describe("coalesced session-store writes", () => {
  it("N rapid changes produce ONE file write, after the window, compact, holding all of them", async () => {
    vi.useFakeTimers();
    const store = await import("../agent/session.js");
    const session = store.createSession({ channel: "test", workspacePath: tempDir, systemPrompt: "You are a test agent." });
    for (let i = 0; i < 20; i += 1) session.addMessage({ role: i % 2 === 0 ? "user" : "assistant", content: `message ${i}` });
    session.incrementTurn();

    // Nothing has been written yet: the window is still open.
    await vi.advanceTimersByTimeAsync(249);
    expect(storeWrites()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await store.flushSessionStore(); // nothing pending: waits for the write in flight
    expect(storeWrites()).toHaveLength(1);

    const text = readFileSync(storePath, "utf8");
    expect(text).not.toContain("\n  "); // no pretty-printing
    const saved = JSON.parse(text) as { sessions: Array<{ id: string; history: unknown[]; turnCount: number }> };
    expect(saved.sessions).toHaveLength(1);
    expect(saved.sessions[0]!.history).toHaveLength(20);
    expect(saved.sessions[0]!.turnCount).toBe(1);

    // The Redis mirror: once for the window, with the same text the file holds.
    expect(redisSaves).toHaveBeenCalledTimes(1);
    expect(redisSaves.mock.calls[0]![0]).toBe(session.id);
    expect(JSON.parse(redisSaves.mock.calls[0]![1])).toEqual(saved.sessions[0]);
    expect(redisSaves.mock.calls[0]![2]).toBe(session.getUpdatedAt().getTime());

    // And the window closes: no second write follows.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(storeWrites()).toHaveLength(1);
  });

  it("flushSessionStore writes the open window at once (the shutdown path), and a fresh process loads it", async () => {
    const store = await import("../agent/session.js");
    const session = store.createSession({ channel: "test", workspacePath: tempDir, systemPrompt: "You are a test agent." });
    session.addMessage({ role: "user", content: "keep me" });
    await store.flushSessionStore();
    expect(storeWrites()).toHaveLength(1);

    // The timer the change armed was taken by the flush: nothing more is written.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(storeWrites()).toHaveLength(1);

    vi.resetModules();
    const reloaded = await import("../agent/session.js");
    const restored = reloaded.getSessionRecord(session.id);
    expect(restored?.getHistory().map((m) => m.content)).toEqual(["keep me"]);
  });

  it("serializes again only the sessions that changed", async () => {
    const store = await import("../agent/session.js");
    const changed = store.createSession({ channel: "test", workspacePath: tempDir, systemPrompt: "A." });
    const quiet = store.createSession({ channel: "test", workspacePath: tempDir, systemPrompt: "B." });
    await store.flushSessionStore();

    const toRecord = vi.spyOn(store.AgentSession.prototype, "toRecord");
    changed.addMessage({ role: "user", content: "only this one moved" });
    await store.flushSessionStore();

    expect(toRecord.mock.contexts).toEqual([changed]);
    // The untouched session is still in the file, from its cached text.
    const saved = JSON.parse(readFileSync(storePath, "utf8")) as { sessions: Array<{ id: string }> };
    expect(saved.sessions.map((s) => s.id)).toEqual([changed.id, quiet.id]);
    expect(redisSaves.mock.calls.map((call) => call[0])).toEqual([changed.id, quiet.id, changed.id]);
  });

  it("an exit while the async write is still in flight leaves that snapshot on disk (review 2026-10-05)", async () => {
    // Taking the snapshot clears the dirty flag, and the exit hook used to write only a dirty
    // store: process.exit() during the mkdir/write window dropped the snapshot entirely.
    const store = await import("../agent/session.js");
    let release!: () => void;
    writeControl.writeGate = new Promise<void>((resolve) => { release = resolve; });
    const session = store.createSession({ channel: "test", workspacePath: tempDir, systemPrompt: "A." });
    session.addMessage({ role: "user", content: "written at exit" });
    const inFlight = store.flushSessionStore();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(storeWrites()).toHaveLength(1); // the async write has started...
    expect(existsSync(storePath)).toBe(false); // ...and not landed

    // What process.exit() runs, synchronously: nothing asynchronous completes after it.
    const exitFlush = (globalThis as unknown as Record<symbol, (() => void) | undefined>)[Symbol.for("starlingai.sessionStore.exitFlush")];
    exitFlush!();
    const saved = JSON.parse(readFileSync(storePath, "utf8")) as { sessions: Array<{ history: Array<{ content: string }> }> };
    expect(saved.sessions[0]!.history.map((m) => m.content)).toEqual(["written at exit"]);

    release();
    await inFlight;
  });

  it("a write torn half-way leaves the previous store intact (temp file + rename) and no temp file behind", async () => {
    const store = await import("../agent/session.js");
    const session = store.createSession({ channel: "test", workspacePath: tempDir, systemPrompt: "A." });
    session.addMessage({ role: "user", content: "first" });
    await store.flushSessionStore();
    const before = readFileSync(storePath, "utf8");

    writeControl.tornWrites = true;
    session.addMessage({ role: "user", content: "second" });
    await store.flushSessionStore();

    expect(storeWrites()).toHaveLength(2);
    expect(readFileSync(storePath, "utf8")).toBe(before);
    expect(readdirSync(tempDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not mirror a session deleted before the window closed", async () => {
    const store = await import("../agent/session.js");
    const doomed = store.createSession({ channel: "test", workspacePath: tempDir, systemPrompt: "A." });
    await store.flushSessionStore();
    redisSaves.mockClear();

    doomed.addMessage({ role: "user", content: "about to be deleted" });
    store.deleteSession(doomed.id);
    await store.flushSessionStore();

    expect(redisSaves).not.toHaveBeenCalled();
    expect((JSON.parse(readFileSync(storePath, "utf8")) as { sessions: unknown[] }).sessions).toEqual([]);
  });
});
