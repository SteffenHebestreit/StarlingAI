import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTurnOptions, TurnOutput } from "../agent/turn-types.js";
import type { UserInputOutcome, UserInputRequest } from "../agent/user-input.js";

const runTurnMock = vi.hoisted(() => vi.fn<(opts: RunTurnOptions) => Promise<TurnOutput>>());
const timeoutRecovery = vi.hoisted(() => ({ fails: false }));

// The turn is stubbed: what these pin is who may drive, stop and watch a turn over the WebSocket.
vi.mock("../agent/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/runtime.js")>();
  return {
    ...actual,
    runTurn: runTurnMock,
    // The timeout's bare error status is reached only when putting the best answer together throws.
    buildTimeoutDeliveryMessage: (...args: Parameters<typeof actual.buildTimeoutDeliveryMessage>) => {
      if (timeoutRecovery.fails) throw new Error("history unreadable");
      return actual.buildTimeoutDeliveryMessage(...args);
    },
  };
});

const TURN_TIMEOUT_SYNTHESIS_GRACE_MS = 65_000;

/**
 * A chat turn belongs to its session, not to the socket that started it: a reloaded page or a
 * second tab can see which turn runs, stop it, and supersede it — and only for its own sessions.
 */
describe("rpc turns across connections", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-rpc-turn-ownership-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      gateway: { jwtSecret: "t".repeat(32), turnTimeoutMs: 30_000 },
      effort: { default: "high" },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
  });

  afterEach(async () => {
    vi.useRealTimers();
    runTurnMock.mockReset();
    timeoutRecovery.fails = false;
    const [session, { userInputBroker }, { turnSteeringManager }, configLoader] = await Promise.all([
      import("../agent/session.js"),
      import("../agent/user-input-broker.js"),
      import("../agent/turn-steering.js"),
      import("../config/loader.js"),
    ]);
    userInputBroker.resetForTests();
    turnSteeringManager.resetForTests();
    for (const active of session.getAllSessions()) session.endSession(active.id);
    configLoader.resetConfigForTests();
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
    // Fresh modules per test: the process-wide turn registry starts empty.
    vi.resetModules();
  });

  type Sent = Array<Record<string, unknown>>;
  function mockWs(): { readyState: number; send(p: string): void; sent: Sent } {
    const sent: Sent = [];
    return { readyState: 1, send(p: string) { sent.push(JSON.parse(p) as Record<string, unknown>); }, sent };
  }

  const turnOutput = (extra: Partial<TurnOutput> = {}): TurnOutput => ({
    response: "Done.",
    toolCallsExecuted: 0,
    guardrailEvents: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    blocked: false,
    ...extra,
  });

  const settingsRequest = (timeoutMs = 60_000): UserInputRequest<{ count: number }> => ({
    kind: "image_settings",
    title: "Image settings",
    payload: {},
    timeoutMs,
    validate: () => ({ ok: true, value: { count: 1 } }),
  });

  async function setup() {
    const [{ RpcConnection, steerChatTurn }, session, broker, requestContext, steering, audit, boundary] = await Promise.all([
      import("../gateway/rpc.js"),
      import("../agent/session.js"),
      import("../agent/user-input-broker.js"),
      import("../runtime/request-context.js"),
      import("../agent/turn-steering.js"),
      import("../audit/logger.js"),
      import("../agent/turn-boundary.js"),
    ]);
    const chat = session.createSession({ channel: "webchat", userId: "alice" });
    const connect = (userId: string, role = "operator") => {
      const ws = mockWs();
      const conn = new RpcConnection(ws as never, userId, role);
      let n = 0;
      const call = async (method: string, params: Record<string, unknown>) => {
        const id = `${method}-${n++}`;
        await conn.handleMessage(JSON.stringify({ id, method, params }));
        return ws.sent.find((event) => event["type"] === "rpc.response" && event["id"] === id) as { ok: boolean; payload?: Record<string, unknown>; error?: string };
      };
      const eventsOf = (type: string) => ws.sent.filter((event) => event["type"] === type).map((event) => event["data"] as Record<string, unknown>);
      const statusOf = (requestId: string, status: string) => eventsOf("status")
        .find((data) => data["requestId"] === requestId && data["status"] === status);
      return { ws, conn, call, eventsOf, statusOf };
    };
    const askFromSpecialist = <T>(opts: RunTurnOptions, request: UserInputRequest<T>): Promise<UserInputOutcome<T>> =>
      requestContext.runWithRequestContext(
        { ...(opts.userInput ? { userInput: opts.userInput } : {}) },
        () => broker.bindRequestUserInput({ requesterSessionId: `sub:${opts.session.id}:image_creator:1`, sourceAgent: "image_creator" }),
      )(request);
    return {
      chat, connect, askFromSpecialist, session, requestContext, boundary, steerChatTurn,
      broker: broker.userInputBroker, steering: steering.turnSteeringManager, logAudit: audit.logAudit,
      recordUnconsumedSteering: steering.recordUnconsumedSteering,
    };
  }

  it("Stop from a page that reconnected stops the turn and closes its question; nobody else's Stop does", async () => {
    const { chat, connect, askFromSpecialist } = await setup();
    let signal: AbortSignal | undefined;
    let outcome: UserInputOutcome<{ count: number }> | undefined;
    runTurnMock.mockImplementation((opts) => {
      signal = opts.signal;
      void askFromSpecialist(opts, settingsRequest()).then((settled) => { outcome = settled; });
      return new Promise<TurnOutput>(() => { /* parked on the question */ });
    });
    const first = connect("alice");
    await first.call("chat.send", { sessionId: chat.id, message: "render the harbour", requestId: "req-1" });
    await vi.waitFor(() => expect(first.eventsOf("agent.user_input_needed")).toHaveLength(1));
    first.conn.close();

    // Another account, and an unknown turn: nothing is stopped, and the reply says so.
    const other = connect("mallory");
    expect((await other.call("chat.cancel", { requestId: "req-1" })).payload).toEqual({ cancelled: false, requestId: "req-1", known: false });
    const reloaded = connect("alice");
    expect((await reloaded.call("chat.cancel", { requestId: "req-unknown" })).payload).toEqual({ cancelled: false, requestId: "req-unknown", known: false });
    expect(signal!.aborted).toBe(false);
    expect(outcome).toBeUndefined();

    // The owner's reloaded page holds no controller for the turn, and its Stop stops it anyway.
    expect((await reloaded.call("chat.cancel", { requestId: "req-1" })).payload).toEqual({ cancelled: true, requestId: "req-1", known: true });
    expect(signal!.aborted).toBe(true);
    await vi.waitFor(() => expect(outcome).toMatchObject({ outcome: "cancelled", reason: "turn_aborted" }));
    // A second Stop finds it already stopped.
    expect((await reloaded.call("chat.cancel", { requestId: "req-1" })).payload).toEqual({ cancelled: false, requestId: "req-1", known: true });
  });

  it("an admin's Stop reaches another user's turn", async () => {
    const { chat, connect } = await setup();
    let signal: AbortSignal | undefined;
    runTurnMock.mockImplementation((opts) => {
      signal = opts.signal;
      return new Promise<TurnOutput>(() => { /* running */ });
    });
    const owner = connect("alice");
    await owner.call("chat.send", { sessionId: chat.id, message: "render", requestId: "req-admin" });
    const admin = connect("root", "admin");
    expect((await admin.call("chat.cancel", { requestId: "req-admin" })).payload).toEqual({ cancelled: true, requestId: "req-admin", known: true });
    expect(signal!.aborted).toBe(true);
  });

  it("names the running turn, and a send from another tab supersedes it instead of running beside it", async () => {
    const { chat, connect, steering } = await setup();
    const signals: Record<string, AbortSignal> = {};
    runTurnMock.mockImplementation(async (opts) => {
      const requestId = opts.userInput!.turnId;
      signals[requestId] = opts.signal!;
      const token = steering.markTurnActive(opts.session.id, opts.steeringToken);
      await new Promise<void>((resolve) => opts.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return turnOutput({
        blocked: true,
        response: "Request cancelled or timed out",
        unconsumedSteering: steering.closeTurn(opts.session.id, token).map(({ id, text }) => ({ id, text })),
      });
    });

    const tabA = connect("alice");
    const sentAt = Date.now();
    await tabA.call("chat.send", { sessionId: chat.id, message: "render the harbour", requestId: "req-a" });
    expect(steering.enqueue(chat.id, "make it blue", "steer-blue-01").queued).toBe(true);

    const tabB = connect("alice");
    const got = (await tabB.call("session.get", { sessionId: chat.id })).payload!;
    expect(got["activeTurn"]).toBe(true);
    expect(got["activeTurnRequestId"]).toBe("req-a");
    expect(got["activeTurnStartedAt"]).toBeGreaterThanOrEqual(sentAt);
    expect(got["activeTurnStartedAt"]).toBeLessThanOrEqual(Date.now());

    await tabB.call("chat.send", { sessionId: chat.id, message: "also add a caption", requestId: "req-b" });
    expect(signals["req-a"]!.aborted).toBe(true);
    // The superseded turn reports what it had queued on its own status, to its own tab.
    await vi.waitFor(() => expect(tabA.statusOf("req-a", "blocked")).toBeDefined());
    expect(tabA.statusOf("req-a", "blocked")!["unconsumedSteering"]).toEqual([{ id: "steer-blue-01", text: "make it blue" }]);
    // And nowhere else: pushed as well, they showed as undelivered on every open page while the
    // starting tab sent them on by itself, and a Resend sent them twice (review of round 4, B #1).
    expect(tabA.eventsOf("agent.unread_steering")).toEqual([]);
    expect(tabB.eventsOf("agent.unread_steering")).toEqual([]);
    // The new turn runs alone and owns the session now.
    expect(signals["req-b"]!.aborted).toBe(false);
    const after = (await tabA.call("session.get", { sessionId: chat.id })).payload!;
    expect(after["activeTurnRequestId"]).toBe("req-b");
    // Its own tab received them, so the session keeps nothing back.
    expect(after["unreadSteering"]).toBeUndefined();
  });

  it("keeps what a turn never read for its session when its tab is gone, and shows it to the owner only", async () => {
    // Review of round 1, B #5: the leftovers rode the final status to the socket that started the
    // turn. After a reload that socket is gone, and a message sent from the reloaded page stayed
    // "Queued" there for good.
    const { chat, connect, steering } = await setup();
    runTurnMock.mockImplementation(async (opts) => {
      const token = steering.markTurnActive(opts.session.id, opts.steeringToken);
      await new Promise<void>((resolve) => opts.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return turnOutput({
        blocked: true,
        response: "Request cancelled or timed out",
        unconsumedSteering: steering.closeTurn(opts.session.id, token).map(({ id, text }) => ({ id, text })),
      });
    });
    const tabA = connect("alice");
    await tabA.call("chat.send", { sessionId: chat.id, message: "render the harbour", requestId: "req-a" });
    tabA.ws.readyState = 3;
    tabA.conn.close();
    const reloaded = connect("alice");
    expect(steering.enqueue(chat.id, "make it blue", "steer-blue-01").queued).toBe(true);
    // The reloaded page sends before the turn read the message, and supersedes it.
    await reloaded.call("chat.send", { sessionId: chat.id, message: "also add a caption", requestId: "req-b" });

    const unread = [{ id: "steer-blue-01", text: "make it blue", requestId: "req-a" }];
    await vi.waitFor(async () => {
      expect((await reloaded.call("session.get", { sessionId: chat.id })).payload!["unreadSteering"]).toEqual(unread);
    });
    expect((await connect("root", "admin").call("session.get", { sessionId: chat.id })).payload!["unreadSteering"]).toEqual(unread);
    expect((await connect("mallory").call("session.get", { sessionId: chat.id })).ok).toBe(false);
    // A connection with no identity reads the transcript, but these are the owner's own words.
    const anonymous = (await connect("").call("session.get", { sessionId: chat.id })).payload!;
    expect(anonymous["transcript"]).toBeDefined();
    expect(anonymous["unreadSteering"]).toBeUndefined();

    // The next turn of the session drops them: the conversation has moved past them.
    await reloaded.call("chat.send", { sessionId: chat.id, message: "thanks", requestId: "req-c" });
    expect((await reloaded.call("session.get", { sessionId: chat.id })).payload!["unreadSteering"]).toBeUndefined();
  });

  it("tells a Stop for a turn that just ended apart from one this process never had", async () => {
    // Review of round 1, B #3: `cancelled: false` read the same for both, and the web's fallback
    // then stopped the session by its id — the turn that had replaced the one it meant.
    const { chat, connect } = await setup();
    let next: AbortSignal | undefined;
    runTurnMock
      .mockImplementationOnce(async () => turnOutput())
      .mockImplementationOnce((opts) => {
        next = opts.signal;
        return new Promise<TurnOutput>(() => { /* running */ });
      });
    const tab = connect("alice");
    await tab.call("chat.send", { sessionId: chat.id, message: "render", requestId: "req-done" });
    await vi.waitFor(() => expect(tab.statusOf("req-done", "ok")).toBeDefined());
    await tab.call("chat.send", { sessionId: chat.id, message: "and a caption", requestId: "req-next" });

    const reloaded = connect("alice");
    expect((await reloaded.call("chat.cancel", { requestId: "req-done" })).payload).toEqual({ cancelled: false, requestId: "req-done", known: true });
    expect(next!.aborted).toBe(false);
    // Nobody else learns that it existed.
    expect((await connect("mallory").call("chat.cancel", { requestId: "req-done" })).payload).toEqual({ cancelled: false, requestId: "req-done", known: false });
  });

  it("remembers an ended turn for ten minutes, not for the life of the process", async () => {
    // Review of round 2, B #3: nothing pinned the expiry.
    vi.useFakeTimers();
    const { chat, connect } = await setup();
    runTurnMock.mockImplementation(async () => turnOutput());
    const tab = connect("alice");
    await tab.call("chat.send", { sessionId: chat.id, message: "render", requestId: "req-done" });
    await vi.advanceTimersByTimeAsync(0);
    expect(tab.statusOf("req-done", "ok")).toBeDefined();
    const stop = async () => (await connect("alice").call("chat.cancel", { requestId: "req-done" })).payload;

    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1_000);
    expect(await stop()).toEqual({ cancelled: false, requestId: "req-done", known: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await stop()).toEqual({ cancelled: false, requestId: "req-done", known: false });
  });

  it("remembers at most a thousand ended turns, and forgets the oldest first", async () => {
    // Review of round 2, B #3: nothing pinned the cap.
    const { chat, connect } = await setup();
    runTurnMock.mockImplementation(async () => turnOutput());
    const tab = connect("alice");
    for (let index = 0; index <= 1_000; index += 1) {
      await tab.call("chat.send", { sessionId: chat.id, message: "render", requestId: `req-${String(index).padStart(4, "0")}` });
    }
    await vi.waitFor(() => expect(tab.statusOf("req-1000", "ok")).toBeDefined());
    const known = async (requestId: string) => (await tab.call("chat.cancel", { requestId })).payload!["known"];
    expect(await known("req-0000")).toBe(false);
    expect(await known("req-0001")).toBe(true);
    expect(await known("req-1000")).toBe(true);
  }, 30_000);

  it("keeps what a failed turn never read when its tab is gone", async () => {
    // Review of round 2, B #3: only a turn that finished was pinned; the error path could send its
    // status straight at the closed socket and keep nothing.
    const { chat, connect, steering, recordUnconsumedSteering } = await setup();
    let fail: (err: Error) => void = () => undefined;
    runTurnMock.mockImplementation((opts) => new Promise<TurnOutput>((_resolve, reject) => {
      const token = steering.markTurnActive(opts.session.id, opts.steeringToken);
      fail = (err) => {
        // As the runtime does: what it never drained rides on the error it rethrows.
        recordUnconsumedSteering(err, steering.closeTurn(opts.session.id, token));
        reject(err);
      };
    }));
    const tabA = connect("alice");
    await tabA.call("chat.send", { sessionId: chat.id, message: "render the harbour", requestId: "req-fail" });
    expect(steering.enqueue(chat.id, "make it blue", "steer-blue-01").queued).toBe(true);
    tabA.ws.readyState = 3;
    tabA.conn.close();
    fail(new Error("provider unreachable"));

    const reloaded = connect("alice");
    await vi.waitFor(async () => {
      expect((await reloaded.call("session.get", { sessionId: chat.id })).payload!["unreadSteering"])
        .toEqual([{ id: "steer-blue-01", text: "make it blue", requestId: "req-fail" }]);
    });
  });

  it.each([
    ["with the best answer it had", false],
    ["when not even that could be put together", true],
  ])("keeps what a timed-out turn never read when its tab is gone, %s", async (_case, recoveryFails) => {
    // Review of round 2, B #3: neither of the watchdog's final statuses was pinned.
    vi.useFakeTimers();
    timeoutRecovery.fails = recoveryFails;
    const { chat, connect, session, steering } = await setup();
    runTurnMock.mockImplementation((opts) => {
      steering.markTurnActive(opts.session.id, opts.steeringToken);
      return new Promise<TurnOutput>(() => { /* silent until the watchdog parks it */ });
    });
    const tabA = connect("alice");
    await tabA.call("chat.send", { sessionId: chat.id, message: "render the harbour", requestId: "req-slow", effort: "medium" });
    expect(steering.enqueue(chat.id, "make it blue", "steer-blue-01").queued).toBe(true);
    tabA.ws.readyState = 3;
    tabA.conn.close();
    // A 30 s budget and the synthesis grace.
    await vi.advanceTimersByTimeAsync(30_000 + TURN_TIMEOUT_SYNTHESIS_GRACE_MS + 1_000);
    expect(session.getSessionRecord(chat.id)?.isArchived()).toBe(true);

    const got = (await connect("alice").call("session.get", { sessionId: chat.id })).payload!;
    // Which status it was: only a recovered answer is saved to the transcript.
    const transcript = got["transcript"] as Array<Record<string, unknown>>;
    expect(transcript.some((entry) => String(entry["content"]).includes("time budget"))).toBe(!recoveryFails);
    // Saved by the watchdog, outside the turn, and still named for it.
    if (!recoveryFails) expect(transcript.find((entry) => String(entry["content"]).includes("time budget"))!["requestId"]).toBe("req-slow");
    expect(got["unreadSteering"]).toEqual([{ id: "steer-blue-01", text: "make it blue", requestId: "req-slow" }]);
  });

  it("hands what the stopped turn left unread to the send that starts the next one", async () => {
    // Review of round 2, B #5: the web stops its turn with chat.cancel and only then sends. A turn
    // that unwound in between kept its leftovers for the session, its tab being gone, and the next
    // start dropped them at once: shown to nobody.
    const { chat, connect, steering } = await setup();
    runTurnMock.mockImplementation(async (opts) => {
      const token = steering.markTurnActive(opts.session.id, opts.steeringToken);
      await new Promise<void>((resolve) => opts.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return turnOutput({
        blocked: true,
        response: "Request cancelled or timed out",
        unconsumedSteering: steering.closeTurn(opts.session.id, token).map(({ id, text }) => ({ id, text })),
      });
    });
    const tabA = connect("alice");
    await tabA.call("chat.send", { sessionId: chat.id, message: "render the harbour", requestId: "req-a" });
    expect(steering.enqueue(chat.id, "make it blue", "steer-blue-01").queued).toBe(true);
    tabA.ws.readyState = 3;
    tabA.conn.close();

    const reloaded = connect("alice");
    await reloaded.call("chat.cancel", { requestId: "req-a" });
    await vi.waitFor(() => expect(steering.unreadOf(chat.id)).toHaveLength(1));
    const sent = await reloaded.call("chat.send", { sessionId: chat.id, message: "also add a caption", requestId: "req-b" });
    expect(sent.payload).toEqual({
      accepted: true,
      requestId: "req-b",
      unreadSteering: [{ id: "steer-blue-01", text: "make it blue", requestId: "req-a" }],
    });
    // Handed over once.
    expect((await reloaded.call("session.get", { sessionId: chat.id })).payload!["unreadSteering"]).toBeUndefined();

    // They are the owner's own words: a connection with no identity starts the turn but is not given them.
    await reloaded.call("chat.cancel", { requestId: "req-b" });
    await vi.waitFor(() => expect(reloaded.statusOf("req-b", "blocked")).toBeDefined());
    steering.keepUnread(chat.id, "req-b", [{ id: "steer-hat-0001", text: "and a hat" }]);
    const anonymous = await connect("").call("chat.send", { sessionId: chat.id, message: "thanks", requestId: "req-c" });
    expect(anonymous.payload).toEqual({ accepted: true, requestId: "req-c" });
  });

  /** A turn that hears its Stop only when the test lets it unwind, as one deep in a tool does. */
  function slowToUnwind(steering: Awaited<ReturnType<typeof setup>>["steering"]) {
    const unwind: Record<string, () => void> = {};
    runTurnMock.mockImplementation(async (opts) => {
      const token = steering.markTurnActive(opts.session.id, opts.steeringToken);
      await new Promise<void>((resolve) => { unwind[opts.userInput!.turnId] = resolve; });
      return turnOutput({
        blocked: true,
        response: "Request cancelled or timed out",
        unconsumedSteering: steering.closeTurn(opts.session.id, token).map(({ id, text }) => ({ id, text })),
      });
    });
    return unwind;
  }

  it("pushes what a stopped turn left unread to the session's open pages when it unwinds after the next send", async () => {
    // Review of round 3, B #1: the stopped turn unwound after the next send had started, so that
    // send's reply had nothing to hand back yet, and the page learned of the message only from the
    // reply to the send after it — a whole turn late.
    const { chat, connect, steering } = await setup();
    const unwind = slowToUnwind(steering);
    const tabA = connect("alice");
    await tabA.call("chat.send", { sessionId: chat.id, message: "render the harbour", requestId: "req-a" });
    expect(steering.enqueue(chat.id, "make it blue", "steer-blue-01").queued).toBe(true);
    tabA.ws.readyState = 3;
    tabA.conn.close();

    const reloaded = connect("alice");
    await reloaded.call("session.get", { sessionId: chat.id });
    const admin = connect("root", "admin");
    await admin.call("session.get", { sessionId: chat.id });
    expect((await reloaded.call("chat.cancel", { requestId: "req-a" })).payload).toMatchObject({ cancelled: true });
    const sent = await reloaded.call("chat.send", { sessionId: chat.id, message: "also add a caption", requestId: "req-b" });
    expect(sent.payload).toEqual({ accepted: true, requestId: "req-b" });
    expect(reloaded.eventsOf("agent.unread_steering")).toEqual([]);

    unwind["req-a"]!();
    const pushed = [{ sessionId: chat.id, messages: [{ id: "steer-blue-01", text: "make it blue", requestId: "req-a" }] }];
    await vi.waitFor(() => expect(reloaded.eventsOf("agent.unread_steering")).toEqual(pushed));
    expect(admin.eventsOf("agent.unread_steering")).toEqual(pushed);
    // Still kept for a page that loads the session later.
    expect((await connect("alice").call("session.get", { sessionId: chat.id })).payload!["unreadSteering"])
      .toEqual(pushed[0]!.messages);

    // A turn whose tab is gone but which left nothing unread pushes nothing.
    reloaded.ws.readyState = 3;
    unwind["req-b"]!();
    await vi.waitFor(async () => expect((await admin.call("gateway.status", { requestId: "req-b" })).payload!["activeTurn"]).toBe(false));
    expect(admin.eventsOf("agent.unread_steering")).toEqual(pushed);
  });

  it("does not push them to a page with no identity, though its own send put it on the session", async () => {
    // They are the owner's own words, as in session.get: a connection with no identity may drive a
    // turn on the chat, and that attaches it to the session's events.
    const { chat, connect, steering } = await setup();
    const unwind = slowToUnwind(steering);
    const tabA = connect("alice");
    await tabA.call("chat.send", { sessionId: chat.id, message: "render the harbour", requestId: "req-a" });
    expect(steering.enqueue(chat.id, "make it blue", "steer-blue-01").queued).toBe(true);
    tabA.ws.readyState = 3;
    tabA.conn.close();

    const anonymous = connect("");
    await anonymous.call("chat.send", { sessionId: chat.id, message: "also add a caption", requestId: "req-b" });
    const reloaded = connect("alice");
    await reloaded.call("session.get", { sessionId: chat.id });

    unwind["req-a"]!();
    await vi.waitFor(() => expect(reloaded.eventsOf("agent.unread_steering")).toHaveLength(1));
    expect(anonymous.eventsOf("agent.unread_steering")).toEqual([]);
  });

  it.each([
    ["reset", "session.reset", {}],
    ["rewound", "session.rewind", { historyIndex: 0 }],
    ["deleted", "session.delete", {}],
  ])("forgets what the chat's turns left unread once it is %s", async (_case, method, extra) => {
    // Review of round 2, B #4: after a reset every session.get brought them back into the emptied
    // chat as undelivered, with a Resend, until the next turn or an hour later.
    const { chat, connect, steering } = await setup();
    chat.addMessage({ role: "user", content: "render the harbour" });
    steering.keepUnread(chat.id, "req-a", [{ id: "steer-blue-01", text: "make it blue" }]);
    const tab = connect("alice");
    expect((await tab.call("session.get", { sessionId: chat.id })).payload!["unreadSteering"]).toHaveLength(1);
    expect((await tab.call(method, { sessionId: chat.id, ...extra })).ok).toBe(true);
    expect(steering.unreadOf(chat.id)).toEqual([]);
  });

  it.each([
    ["reset", "session.reset", {}],
    ["rewound", "session.rewind", { historyIndex: 0 }],
    ["deleted", "session.delete", {}],
  ])("neither keeps nor pushes what a stopped turn left unread when it unwinds after the chat was %s", async (_case, method, extra) => {
    // Review of round 4, B #2: the turn kept them again after they were dropped, and pushed them at
    // once into the chat that had just been emptied.
    const { chat, connect, steering } = await setup();
    const unwind = slowToUnwind(steering);
    chat.addMessage({ role: "user", content: "render the harbour" });
    const tabA = connect("alice");
    await tabA.call("chat.send", { sessionId: chat.id, message: "render the harbour", requestId: "req-a" });
    expect(steering.enqueue(chat.id, "make it blue", "steer-blue-01").queued).toBe(true);
    tabA.ws.readyState = 3;
    tabA.conn.close();

    const reloaded = connect("alice");
    await reloaded.call("session.get", { sessionId: chat.id });
    expect((await reloaded.call("chat.cancel", { requestId: "req-a" })).payload).toMatchObject({ cancelled: true });
    expect((await reloaded.call(method, { sessionId: chat.id, ...extra })).ok).toBe(true);

    unwind["req-a"]!();
    // The gateway's own handler on the turn runs before this await returns.
    await runTurnMock.mock.results[0]!.value;
    expect(reloaded.eventsOf("agent.unread_steering")).toEqual([]);
    expect(steering.unreadOf(chat.id)).toEqual([]);
  });

  it("lists on its own final status what the turn never read, though the chat was reset while it ran", async () => {
    // Turn-ids review, R1: the reset cleared the running turn's queue. A Reset does not stop the
    // turn and the page keeps the message it steered into it, so with the turn's final status no
    // longer listing it, the page showed it "Queued" for good.
    const { chat, connect, steering, steerChatTurn } = await setup();
    let finish!: () => void;
    runTurnMock.mockImplementation(async (opts) => {
      const token = steering.markTurnActive(opts.session.id, opts.steeringToken);
      await new Promise<void>((resolve) => { finish = resolve; });
      return turnOutput({
        response: "Rendered.",
        unconsumedSteering: steering.closeTurn(opts.session.id, token).map(({ id, text }) => ({ id, text })),
      });
    });
    const tab = connect("alice");
    await tab.call("chat.send", { sessionId: chat.id, message: "render the harbour", requestId: "req-a" });
    expect(steerChatTurn(chat.id, "make it blue", "steer-blue-01", "req-a").steered).toBe(true);
    // The web's Reset: session.reset, then the session is loaded again, and the turn runs on.
    expect((await tab.call("session.reset", { sessionId: chat.id })).ok).toBe(true);
    expect((await tab.call("session.get", { sessionId: chat.id })).payload!["activeTurnRequestId"]).toBe("req-a");
    expect(steerChatTurn(chat.id, "typed after the reset", "steer-after-01", "req-a").steered).toBe(true);

    finish();
    await runTurnMock.mock.results[0]!.value;
    expect(tab.statusOf("req-a", "ok")!["unconsumedSteering"]).toEqual([
      { id: "steer-blue-01", text: "make it blue" },
      { id: "steer-after-01", text: "typed after the reset" },
    ]);
    // Its own page has them: the session keeps and pushes nothing.
    expect(tab.eventsOf("agent.unread_steering")).toEqual([]);
    expect(steering.unreadOf(chat.id)).toEqual([]);
  });

  it("keeps and pushes what was steered into a running turn after the chat was reset", async () => {
    // Review of round 5, B #1: the refusal covered the whole turn, so a message typed into it after
    // the reset was neither kept nor pushed, and stayed "Queued" on the page that sent it.
    const { chat, connect, steering, steerChatTurn } = await setup();
    const unwind = slowToUnwind(steering);
    const tabA = connect("alice");
    await tabA.call("chat.send", { sessionId: chat.id, message: "render the harbour", requestId: "req-a" });
    expect(steerChatTurn(chat.id, "make it blue", "steer-blue-01", "req-a").steered).toBe(true);
    tabA.ws.readyState = 3;
    tabA.conn.close();

    const reloaded = connect("alice");
    await reloaded.call("session.get", { sessionId: chat.id });
    // A reset does not stop the turn, and the page may go on steering it.
    expect((await reloaded.call("session.reset", { sessionId: chat.id })).ok).toBe(true);
    expect(steerChatTurn(chat.id, "typed after the reset", "steer-after-01", "req-a").steered).toBe(true);

    unwind["req-a"]!();
    await runTurnMock.mock.results[0]!.value;
    const kept = [{ id: "steer-after-01", text: "typed after the reset", requestId: "req-a" }];
    expect(reloaded.eventsOf("agent.unread_steering")).toEqual([{ sessionId: chat.id, messages: kept }]);
    expect(steering.unreadOf(chat.id)).toEqual(kept);
  });

  it("steers only the turn a message was typed into, and names the running one when that turn is over", async () => {
    // The web told turns apart by their text. A page still showing a turn another tab had replaced
    // steered the replacement, and its message sat under a turn that page never ran.
    const { chat, connect, steering, steerChatTurn } = await setup();
    const unwind = slowToUnwind(steering);
    const tabA = connect("alice");
    await tabA.call("chat.send", { sessionId: chat.id, message: "render the harbour", requestId: "req-a" });
    expect(runTurnMock.mock.calls[0]![0].requestId).toBe("req-a");
    expect(steerChatTurn(chat.id, "make it blue", "steer-blue-01", "req-a")).toEqual({ steered: true, active: true, id: "steer-blue-01" });

    const tabB = connect("alice");
    await tabB.call("chat.send", { sessionId: chat.id, message: "also add a caption", requestId: "req-b" });
    const ended = { steered: false, active: true, activeTurnRequestId: "req-b", error: "The turn this was typed into has ended." };
    expect(steerChatTurn(chat.id, "and a hat", "steer-hat-0001", "req-a")).toEqual({ ...ended, replaced: true, replacedBy: "req-b" });
    // A turn this process never ran is no different, but nothing replaced it.
    expect(steerChatTurn(chat.id, "and a hat", "steer-hat-0001", "req-unknown")).toEqual(ended);
    expect(steerChatTurn(chat.id, "and a scarf", "steer-scarf-01", "req-b")).toEqual({ steered: true, active: true, id: "steer-scarf-01" });
    // Without an id, whichever turn holds the session takes it, as before.
    expect(steerChatTurn(chat.id, "and gloves", "steer-glove-01")).toEqual({ steered: true, active: true, id: "steer-glove-01" });

    unwind["req-a"]!();
    unwind["req-b"]!();
    await Promise.all(runTurnMock.mock.results.map((result) => result.value));
    expect(tabA.statusOf("req-a", "blocked")!["unconsumedSteering"]).toEqual([{ id: "steer-blue-01", text: "make it blue" }]);
    expect(tabB.statusOf("req-b", "blocked")!["unconsumedSteering"]).toEqual([
      { id: "steer-scarf-01", text: "and a scarf" },
      { id: "steer-glove-01", text: "and gloves" },
    ]);
    expect(steerChatTurn(chat.id, "and a hat", "steer-hat-0001", "req-b"))
      .toEqual({ steered: false, active: false, error: "The turn this was typed into has ended." });
    // Turn-ids review, LOW 2: with nothing running, a turn another tab replaced read like one that
    // ended, and the page sent the message on by itself as a new turn.
    expect(steerChatTurn(chat.id, "and a hat", "steer-hat-0001", "req-a"))
      .toEqual({ steered: false, active: false, replaced: true, replacedBy: "req-b", error: "The turn this was typed into has ended." });
  });

  it("takes a message typed into a stopped turn that is still unwinding, and hands it back on its status", async () => {
    // Deliberate: session.get no longer names a stopped turn, but its steering stays open until it
    // has unwound, and what it did not read comes back on its final status as before.
    const { chat, connect, steering, steerChatTurn } = await setup();
    const unwind = slowToUnwind(steering);
    const tab = connect("alice");
    await tab.call("chat.send", { sessionId: chat.id, message: "render the harbour", requestId: "req-a" });
    expect((await tab.call("chat.cancel", { requestId: "req-a" })).payload).toMatchObject({ cancelled: true });
    expect((await tab.call("session.get", { sessionId: chat.id })).payload!["activeTurnRequestId"]).toBeUndefined();
    expect(steerChatTurn(chat.id, "make it blue", "steer-blue-01", "req-a")).toEqual({ steered: true, active: true, id: "steer-blue-01" });

    unwind["req-a"]!();
    await runTurnMock.mock.results[0]!.value;
    expect(tab.statusOf("req-a", "blocked")!["unconsumedSteering"]).toEqual([{ id: "steer-blue-01", text: "make it blue" }]);
  });

  it.each([
    ["at the end of the history", 1],
    ["past it", 5],
  ])("keeps what the chat's turns left unread when a rewind %s cuts nothing", async (_case, historyIndex) => {
    // Review of round 3, B #2: the unread messages were dropped whether or not the rewind removed
    // anything, so a rewind that cut nothing threw away what the person had typed.
    const { chat, connect, steering } = await setup();
    chat.addMessage({ role: "user", content: "render the harbour" });
    steering.keepUnread(chat.id, "req-a", [{ id: "steer-blue-01", text: "make it blue" }]);
    const tab = connect("alice");
    expect((await tab.call("session.rewind", { sessionId: chat.id, historyIndex })).payload).toEqual({ rewound: true, historyIndex });
    expect(chat.getHistory()).toHaveLength(1);
    expect(steering.unreadOf(chat.id)).toEqual([{ id: "steer-blue-01", text: "make it blue", requestId: "req-a" }]);
  });

  it("refuses a send under a request id that is still running", async () => {
    // Review of round 1, B #6: the second turn took the registry entry over, so the first could
    // no longer be stopped from a reloaded page, and both ran on one history.
    const { chat, connect } = await setup();
    const signals: AbortSignal[] = [];
    runTurnMock.mockImplementation((opts) => {
      signals.push(opts.signal!);
      return new Promise<TurnOutput>(() => { /* running */ });
    });
    const first = connect("alice");
    await first.call("chat.send", { sessionId: chat.id, message: "render", requestId: "req-same" });
    const second = connect("alice");
    expect((await second.call("chat.send", { sessionId: chat.id, message: "render again", requestId: "req-same" })).ok).toBe(false);
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    expect(signals[0]!.aborted).toBe(false);
    // The id still names the first turn: a Stop from a reloaded page reaches it.
    first.conn.close();
    expect((await connect("alice").call("chat.cancel", { requestId: "req-same" })).payload).toMatchObject({ cancelled: true });
    expect(signals[0]!.aborted).toBe(true);
  });

  it("refuses a request id that is not an id", async () => {
    // Turn-ids review, INFO 3: the id is saved on every history message the turn writes, and any
    // string was taken.
    const { chat, connect } = await setup();
    runTurnMock.mockImplementation(async () => turnOutput());
    const tab = connect("alice");
    for (const requestId of ["r".repeat(65), "req a", "../req-a", "", "req-a\n"]) {
      expect(await tab.call("chat.send", { sessionId: chat.id, message: "render", requestId }))
        .toMatchObject({ ok: false, error: "Error: requestId must be 1 to 64 characters of A-Za-z0-9_-" });
    }
    expect(runTurnMock).not.toHaveBeenCalled();
    // The web's ids, the eval runner's UUIDs, the longest allowed, and a server id when none is given.
    for (const requestId of ["k3j5h2l9x0q", "0b5e1c2a-7f3d-4e8b-9a6c-2d1f0e9b8a7c", "r".repeat(64), undefined]) {
      expect((await tab.call("chat.send", { sessionId: chat.id, message: "render", ...(requestId ? { requestId } : {}) })).ok).toBe(true);
    }
    expect(runTurnMock).toHaveBeenCalledTimes(4);
  });

  it("says what time it is on the server when it answers session.get", async () => {
    // A question first seen in openUserInputs after a reload carries server deadlines; the page
    // counts them down on its own clock, which needs the skew.
    const { chat, connect } = await setup();
    const before = Date.now();
    const got = (await connect("alice").call("session.get", { sessionId: chat.id })).payload!;
    expect(got["serverNow"]).toBeGreaterThanOrEqual(before);
    expect(got["serverNow"]).toBeLessThanOrEqual(Date.now());
  });

  it("does not hold a turn for a wait an earlier --auto turn left open", async () => {
    // Review of round 1, B #7: an --auto turn has no question channel, so its waits named no turn,
    // and one it left open held every later turn of the session up to the 24 h ceiling.
    vi.useFakeTimers();
    const { chat, connect, session, broker } = await setup();
    runTurnMock
      .mockImplementationOnce((opts) => {
        // A handoff whose tool never hears the Stop.
        broker.beginHumanWait(`sub:${opts.session.id}:browser_agent:1`);
        return new Promise<TurnOutput>(() => { /* stopped below */ });
      })
      .mockImplementationOnce(() => new Promise<TurnOutput>(() => { /* silent */ }));
    const tab = connect("alice");
    await tab.call("chat.send", { sessionId: chat.id, message: "log in --auto", requestId: "req-first", effort: "medium" });
    await tab.call("chat.cancel", { requestId: "req-first" });
    await tab.call("chat.send", { sessionId: chat.id, message: "fetch the invoices --auto", requestId: "req-second", effort: "medium" });
    const archived = () => session.getSessionRecord(chat.id)?.isArchived() === true;
    // A 30 s budget and the synthesis grace: a silent turn is parked on time.
    await vi.advanceTimersByTimeAsync(30_000 + TURN_TIMEOUT_SYNTHESIS_GRACE_MS + 1_000);
    expect(archived()).toBe(true);
  });

  it("ends a pending ask_user with the Stop, so its wait holds no clock after it", async () => {
    const { chat, connect } = await setup();
    let answer: string | undefined;
    runTurnMock.mockImplementation((opts) => {
      void opts.inputCallback!("Which region?", undefined, 600_000).then((given) => { answer = given; });
      return new Promise<TurnOutput>(() => { /* parked on the question */ });
    });
    const tab = connect("alice");
    await tab.call("chat.send", { sessionId: chat.id, message: "plan the trip", requestId: "req-ask" });
    await vi.waitFor(() => expect(tab.eventsOf("agent.input_needed")).toHaveLength(1));
    await tab.call("chat.cancel", { requestId: "req-ask" });
    await vi.waitFor(() => expect(answer).toBe(""));
  });

  it("answers a settings change with the defaulted settings session.get shows", async () => {
    const { chat, connect } = await setup();
    const tab = connect("alice");
    // A chat without an effort of its own runs at the configured default, and says so.
    const cleared = await tab.call("session.updateSettings", { sessionId: chat.id, effort: "default" });
    expect(cleared.payload!["settings"]).toEqual({ effort: "high", imageSettingsPrompt: "ask" });
    const updated = await tab.call("session.updateSettings", { sessionId: chat.id, imageSettingsPrompt: "auto" });
    expect(updated.payload!["settings"]).toEqual({ effort: "high", imageSettingsPrompt: "auto" });
    expect((await tab.call("session.get", { sessionId: chat.id })).payload!["settings"]).toEqual(updated.payload!["settings"]);
  });

  it("streams audit events only for sessions the connection may see", async () => {
    const { chat, connect, session, logAudit } = await setup();
    const bobs = session.createSession({ channel: "webchat", userId: "bob" });
    const alice = connect("alice");
    const mallory = connect("mallory");
    const admin = connect("root", "admin");
    for (const tab of [alice, mallory, admin]) await tab.call("audit.subscribe", {});

    logAudit("tool_call_requested", { tool: "write_file", args: { content: "alice's draft" } }, { sessionId: chat.id });
    logAudit("tool_call_requested", { tool: "generate_image", args: { prompt: "a harbour" } }, { sessionId: `sub:${chat.id}:image_creator:1790153205322` });
    logAudit("tool_call_requested", { tool: "web_search", args: {} }, { sessionId: `workflow:sub:${chat.id}:researcher:1:deep_dive:0b5e` });
    logAudit("tool_call_requested", { tool: "write_file", args: { content: "bob's draft" } }, { sessionId: bobs.id });
    logAudit("config_proposal_applied", { key: "gateway" }, {});

    const seen = (tab: ReturnType<typeof connect>) => tab.eventsOf("audit.event").map((event) => String(event["sessionId"] ?? "-"));
    expect(seen(alice)).toEqual([chat.id, `sub:${chat.id}:image_creator:1790153205322`, `workflow:sub:${chat.id}:researcher:1:deep_dive:0b5e`]);
    expect(seen(mallory)).toEqual([]);
    expect(seen(admin)).toEqual([chat.id, `sub:${chat.id}:image_creator:1790153205322`, `workflow:sub:${chat.id}:researcher:1:deep_dive:0b5e`, bobs.id, "-"]);
  });

  it("names the text the transcript keeps for the part a steering message cut off", async () => {
    const { chat, connect, steering, boundary } = await setup();
    runTurnMock.mockImplementation(async (opts) => {
      const s = opts.session;
      s.addMessage({ role: "user", content: opts.userMessage });
      const token = steering.markTurnActive(s.id, opts.steeringToken);
      const fold = (iteration: number) => {
        const taken = steering.drain(s.id, token).map(({ id, text }) => ({ id, text }));
        s.addMessage({
          role: "user",
          content: `${boundary.STEERING_PREFIX} ${taken.map((entry) => entry.text).join("\n")}`,
          metadata: {
            [boundary.MID_TURN_USER_MESSAGE_METADATA]: true,
            [boundary.MID_TURN_SOURCE_METADATA]: "user",
            [boundary.STEERING_METADATA]: taken,
          },
        });
        opts.onSteeringConsumed?.({ messages: taken, iteration, at: s.getHistory().at(-1)!.timestamp });
      };
      // A part with text beside its tool call, then one with none.
      s.addMessage({ role: "assistant", content: "Found three candidates, checking prices next.", tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } }] });
      s.addMessage({ role: "tool", content: "three results", tool_call_id: "c1" });
      steering.enqueue(s.id, "only under 50 euros", "steer-price-01");
      fold(1);
      s.addMessage({ role: "assistant", content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "web_search", arguments: "{}" } }] });
      s.addMessage({ role: "tool", content: "one result", tool_call_id: "c2" });
      steering.enqueue(s.id, "and in blue", "steer-blue-02");
      fold(2);
      s.addMessage({ role: "assistant", content: "The blue one at 42 euros." });
      steering.closeTurn(s.id, token);
      return turnOutput({ response: "The blue one at 42 euros." });
    });
    const tab = connect("alice");
    await tab.call("chat.send", { sessionId: chat.id, message: "find me a lamp", requestId: "req-seg" });
    await vi.waitFor(() => expect(tab.statusOf("req-seg", "ok")).toBeDefined());

    const cuts = tab.eventsOf("agent.steering_consumed").map((event) => event["segmentText"]);
    const transcript = (await tab.call("session.get", { sessionId: chat.id })).payload!["transcript"] as Array<Record<string, unknown>>;
    const parts = transcript.filter((entry) => entry["role"] === "assistant" && entry["continued"] === true).map((entry) => entry["content"]);
    expect(cuts).toEqual(["Found three candidates, checking prices next.", ""]);
    expect(parts).toEqual([cuts[0], cuts[1]]);
  });

  it("passes over a replaced turn's late write when it names the text before a steering cut", async () => {
    // Turn-ids review, LOW 1: a superseded turn still unwinding wrote just ahead of the cut, and the
    // live segment showed its words as this turn's, where a reload passes them over.
    const { chat, connect, steering, boundary, requestContext } = await setup();
    runTurnMock.mockImplementation((opts) => requestContext.runWithRequestContext({ chatRequestId: opts.requestId! }, async () => {
      const s = opts.session;
      s.addMessage({ role: "user", content: opts.userMessage });
      const token = steering.markTurnActive(s.id, opts.steeringToken);
      s.addMessage({ role: "assistant", content: "Found three candidates, checking prices next.", tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } }] });
      s.addMessage({ role: "tool", content: "three results", tool_call_id: "c1" });
      // The turn this one replaced, unwinding, writes its last words under its own id.
      s.addMessage({ role: "assistant", content: "Rendered the old harbour.", requestId: "req-old" });
      steering.enqueue(s.id, "only under 50 euros", "steer-price-01");
      const taken = steering.drain(s.id, token).map(({ id, text }) => ({ id, text }));
      s.addMessage({
        role: "user",
        content: `${boundary.STEERING_PREFIX} ${taken.map((entry) => entry.text).join("\n")}`,
        metadata: {
          [boundary.MID_TURN_USER_MESSAGE_METADATA]: true,
          [boundary.MID_TURN_SOURCE_METADATA]: "user",
          [boundary.STEERING_METADATA]: taken,
        },
      });
      opts.onSteeringConsumed?.({ messages: taken, iteration: 1, at: s.getHistory().at(-1)!.timestamp });
      s.addMessage({ role: "assistant", content: "The blue one at 42 euros." });
      steering.closeTurn(s.id, token);
      return turnOutput({ response: "The blue one at 42 euros." });
    }));
    const tab = connect("alice");
    await tab.call("chat.send", { sessionId: chat.id, message: "find me a lamp", requestId: "req-seg" });
    await vi.waitFor(() => expect(tab.statusOf("req-seg", "ok")).toBeDefined());

    const cuts = tab.eventsOf("agent.steering_consumed").map((event) => event["segmentText"]);
    expect(cuts).toEqual(["Found three candidates, checking prices next."]);
    const transcript = (await tab.call("session.get", { sessionId: chat.id })).payload!["transcript"] as Array<Record<string, unknown>>;
    const parts = transcript.filter((entry) => entry["role"] === "assistant" && entry["continued"] === true).map((entry) => entry["content"]);
    expect(parts).toEqual(cuts);
  });

  it("does not read a long answer as silence: a turn producing right up to its question survives it", async () => {
    // Review #13: the credit moved the deadline but not the liveness beat, so the first check after
    // a 400 s answer measured the whole wait as silence and parked a turn that was working.
    vi.useFakeTimers();
    const { chat, connect, askFromSpecialist, session, broker } = await setup();
    runTurnMock.mockImplementation((opts) => {
      setTimeout(() => opts.onChunk?.("working on it"), 88_000);
      setTimeout(() => { void askFromSpecialist(opts, settingsRequest(900_000)); }, 89_000);
      return new Promise<TurnOutput>(() => { /* renders on, silently, after the answer */ });
    });
    const tab = connect("alice");
    // Medium effort: this config defaults to high, whose own budget is 40 minutes.
    await tab.call("chat.send", { sessionId: chat.id, message: "render", requestId: "req-long", effort: "medium" });
    const archived = () => session.getSessionRecord(chat.id)?.isArchived() === true;

    await vi.advanceTimersByTimeAsync(89_000 + 400_000);
    const inputId = String(tab.eventsOf("agent.user_input_needed")[0]!["inputId"]);
    await broker.respond(inputId, {}, { userId: "alice", isAdmin: false });
    // The deadline was 95 s; credited by the 400 s wait it is 495 s, and the turn spoke at 88 s.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(archived()).toBe(false);

    // Still a watchdog: a turn that stays quiet after the answer is parked in time.
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_SYNTHESIS_GRACE_MS + 300_000);
    expect(archived()).toBe(true);
  });

  it("holds for a person only up to the absolute ceiling", async () => {
    // Review #29: the hold branch re-armed forever, where the liveness branch stops at 24 h.
    vi.useFakeTimers();
    const { chat, connect, session, broker, requestContext } = await setup();
    runTurnMock.mockImplementation((opts) => {
      requestContext.runWithRequestContext({ ...(opts.userInput ? { userInput: opts.userInput } : {}) }, () => {
        broker.beginHumanWait(`sub:${opts.session.id}:browser_agent:1`); // never answered
      });
      return new Promise<TurnOutput>(() => { /* parked on the handoff */ });
    });
    const tab = connect("alice");
    await tab.call("chat.send", { sessionId: chat.id, message: "log in", requestId: "req-captcha", effort: "medium" });
    const archived = () => session.getSessionRecord(chat.id)?.isArchived() === true;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(archived()).toBe(false);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(archived()).toBe(true);
  }, 30_000);
});
