import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Defect 5 (run 3959f3ac): a turn that hit the gateway watchdog archived its session,
 * and the user's next message came back as "Session not found: <id>" — the partial work
 * the timeout path had just preserved was unreachable. The timeout now parks the session
 * ("timeout" archive reason) instead of ending it, and chat.send un-parks it.
 *
 * These are behavioural tests driven through RpcConnection, not unit tests of the
 * predicate: the previous fixes in this area shipped WITH passing unit tests while the
 * wiring stayed inert. Each assertion below fails if either half of the wiring is
 * reverted (archive reason, or the resumeArchived resolve).
 */

const TURN_TIMEOUT_SYNTHESIS_GRACE_MS = 65_000;

let tempDir: string;

function makeSocket(sent: Array<Record<string, unknown>>) {
  return {
    readyState: 1,
    send(payload: string) {
      sent.push(JSON.parse(payload) as Record<string, unknown>);
    },
  };
}

describe("timed-out session resumption", () => {
  beforeEach(() => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-session-resume-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      gateway: { jwtSecret: "t".repeat(32), turnTimeoutMs: 30_000 },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    // Keep the session store out of the repo/home state dir.
    process.env["SAI_SESSION_STORE"] = join(tempDir, "sessions.json");
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unmock("../agent/runtime.js");
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_SESSION_STORE"];

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();

    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("accepts a follow-up after a turn timeout and keeps the timed-out turn's artifacts in context", async () => {
    vi.useFakeTimers();

    // The timed-out turn: it writes a deliverable (recorded on the session as an
    // artifact-bearing assistant message) and then never finishes.
    const runTurn = vi.fn(({ session, userMessage }: {
      session: { addMessage: (m: Record<string, unknown>) => void };
      userMessage: string;
    }) => {
      session.addMessage({ role: "user", content: userMessage });
      if (userMessage === "build the game") {
        session.addMessage({
          role: "assistant",
          content: "wrote generated/tetris25d/game.js",
          metadata: { attachments: [{ filename: "game.js", relativePath: "generated/tetris25d/game.js" }] },
        });
      }
      return new Promise(() => {});
    });

    vi.doMock("../agent/runtime.js", () => ({
      runTurn,
      buildTimeoutDeliveryMessage: vi.fn(() => ({
        response: "⏱️ This turn hit its time budget.\n\nA partial deliverable was saved this turn:\n- generated/tetris25d/game.js",
        recoveredAssistantText: false,
      })),
    }));

    const sent: Array<Record<string, unknown>> = [];
    const [{ RpcConnection }, session] = await Promise.all([
      import("../gateway/rpc.js"),
      import("../agent/session.js"),
    ]);

    const active = session.createSession({ channel: "webchat" });
    const connection = new RpcConnection(makeSocket(sent) as never);

    await connection.handleMessage(JSON.stringify({
      id: "req-build",
      method: "chat.send",
      params: { sessionId: active.id, requestId: "turn-1", message: "build the game" },
    }));

    await vi.advanceTimersByTimeAsync(30_000 + TURN_TIMEOUT_SYNTHESIS_GRACE_MS);

    // The watchdog fired: parked, not ended.
    expect(session.getSession(active.id)).toBeUndefined();
    expect(session.getSessionRecord(active.id)?.isArchived()).toBe(true);

    // The follow-up the user actually sent.
    await connection.handleMessage(JSON.stringify({
      id: "req-continue",
      method: "chat.send",
      params: { sessionId: active.id, requestId: "turn-2", message: "continue" },
    }));

    const response = sent.find((event) => event["id"] === "req-continue");
    expect(response?.["ok"]).toBe(true);
    expect(String(response?.["error"] ?? "")).not.toContain("Session not found");

    // It is the SAME session, live again...
    expect(session.getSession(active.id)).toBeDefined();
    expect(runTurn).toHaveBeenCalledTimes(2);
    const secondTurnArgs = (runTurn.mock.calls[1] as unknown[])[0] as { session: { id: string } };
    expect(secondTurnArgs.session.id).toBe(active.id);

    // ...and the timed-out turn's work is still in context for the continuation:
    // the artifact the sub-agent produced, and the recovered timeout delivery.
    const history = session.getSessionRecord(active.id)!.getHistory();
    const artifactMessage = history.find((m) =>
      Array.isArray((m.metadata as Record<string, unknown> | undefined)?.["attachments"]));
    expect(artifactMessage).toBeDefined();
    expect(JSON.stringify(artifactMessage!.metadata)).toContain("generated/tetris25d/game.js");
    expect(history.some((m) => typeof m.content === "string" && m.content.includes("partial deliverable was saved"))).toBe(true);
    expect(history.some((m) => m.role === "user" && m.content === "continue")).toBe(true);

    // The mechanism that made the above possible: the watchdog parked it as "timeout",
    // and the resume cleared the archive rather than minting a new session.
    expect(session.getSessionRecord(active.id)?.getArchivedReason()).toBeUndefined();

    connection.close({ abortInFlightTurns: true });
  });

  it("does NOT resurrect a session the user ended on purpose, and says why it is gone", async () => {
    vi.doMock("../agent/runtime.js", () => ({
      runTurn: vi.fn(() => new Promise(() => {})),
      buildTimeoutDeliveryMessage: vi.fn(() => ({ response: "", recoveredAssistantText: false })),
    }));

    const sent: Array<Record<string, unknown>> = [];
    const [{ RpcConnection }, session] = await Promise.all([
      import("../gateway/rpc.js"),
      import("../agent/session.js"),
    ]);

    const ended = session.createSession({ channel: "webchat" });
    session.archiveSession(ended.id); // explicit end — "manual"
    const connection = new RpcConnection(makeSocket(sent) as never);

    await connection.handleMessage(JSON.stringify({
      id: "req-ended",
      method: "chat.send",
      params: { sessionId: ended.id, requestId: "turn-ended", message: "continue" },
    }));

    const endedResponse = sent.find((event) => event["id"] === "req-ended");
    expect(endedResponse?.["ok"]).toBe(false);
    expect(String(endedResponse?.["error"])).toContain("Session not found");
    // Honest about WHICH benign cause applies rather than implying the id never existed.
    expect(String(endedResponse?.["error"])).toContain("archived (manual)");

    // A pruned session names pruning; an id this gateway never saw says so.
    const pruned = session.createSession({ channel: "webchat" });
    session.archiveSession(pruned.id);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 10_000));
    expect(session.pruneArchivedSessions(1, 0)).toBeGreaterThanOrEqual(1);
    vi.useRealTimers();
    expect(session.describeMissingSession(pruned.id)).toContain("pruned");
    expect(session.describeMissingSession("00000000-0000-0000-0000-000000000000")).toContain("no record");
  });

  it("keeps a timed-out session on the long retention instead of the short ephemera TTL", async () => {
    const session = await import("../agent/session.js");

    const timedOut = session.createSession({ channel: "webchat" });
    session.archiveSession(timedOut.id, "timeout");
    const worker = session.createSession({ channel: "scene:worker" });
    session.archiveSession(worker.id, "manual");

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 10_000));
    // ttlMs 1ms reclaims the ephemeral worker; idleRetentionMs 0 = keep resumable ones.
    expect(session.pruneArchivedSessions(1, 0)).toBe(1);
    vi.useRealTimers();

    expect(session.getSessionRecord(worker.id)).toBeUndefined();
    expect(session.getSessionRecord(timedOut.id)).toBeDefined();
  });
});
