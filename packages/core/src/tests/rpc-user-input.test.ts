import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTurnOptions, TurnOutput } from "../agent/turn-types.js";
import type { UserInputOutcome, UserInputRequest } from "../agent/user-input.js";

const runTurnMock = vi.hoisted(() => vi.fn<(opts: RunTurnOptions) => Promise<TurnOutput>>());

// The turn is stubbed: what these pin is the bridge between a tool's question and the dashboard.
vi.mock("../agent/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/runtime.js")>()),
  runTurn: runTurnMock,
}));

const TURN_TIMEOUT_SYNTHESIS_GRACE_MS = 65_000;

/**
 * A tool's structured question over the dashboard's WebSocket: it reaches the socket that started
 * the turn, survives that socket closing, is listed for the reloaded page, answers only for the
 * session's owner, rejects a bad answer without closing, and ends with the turn.
 */
describe("rpc structured user input", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-rpc-user-input-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({ gateway: { jwtSecret: "t".repeat(32), turnTimeoutMs: 30_000 } }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
  });

  afterEach(async () => {
    vi.useRealTimers();
    runTurnMock.mockReset();
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
    // Fresh modules per test: the watchdog case reads the turn budget from this test's config.
    vi.resetModules();
  });

  type Sent = Array<Record<string, unknown>>;
  function mockWs(): { readyState: number; send(p: string): void; sent: Sent } {
    const sent: Sent = [];
    return { readyState: 1, send(p: string) { sent.push(JSON.parse(p) as Record<string, unknown>); }, sent };
  }

  const turnOutput = (): TurnOutput => ({
    response: "Done.",
    toolCallsExecuted: 0,
    guardrailEvents: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    blocked: false,
  });

  /** A render-settings question with a count of 1-5 and one previewable candidate. */
  const settingsRequest = (timeoutMs = 60_000): UserInputRequest<{ count: number }> => ({
    kind: "image_settings",
    title: "Image settings",
    payload: { baseCandidates: [{ id: "cand-1", label: "harbour.png" }] },
    timeoutMs,
    validate: (raw) => {
      const count = (raw as { settings?: { count?: unknown } }).settings?.count;
      return typeof count === "number" && count >= 1 && count <= 5
        ? { ok: true, value: { count }, summary: `${count} images` }
        : { ok: false, errors: [{ field: "settings.count", message: "between 1 and 5" }] };
    },
    preview: (candidateId) => candidateId === "cand-1" ? { dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 640, height: 480 } : null,
  });

  async function setup() {
    const [{ RpcConnection }, session, broker, requestContext] = await Promise.all([
      import("../gateway/rpc.js"),
      import("../agent/session.js"),
      import("../agent/user-input-broker.js"),
      import("../runtime/request-context.js"),
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
      return { ws, conn, call, eventsOf };
    };
    /** What a specialist's tool does inside the turn: bound under the context runTurn would set. */
    const askFromSpecialist = <T>(opts: RunTurnOptions, request: UserInputRequest<T>): Promise<UserInputOutcome<T>> =>
      requestContext.runWithRequestContext(
        { ...(opts.userInput ? { userInput: opts.userInput } : {}) },
        () => broker.bindRequestUserInput({ requesterSessionId: `sub:${opts.session.id}:image_creator:1`, sourceAgent: "image_creator" }),
      )(request);
    return { chat, connect, askFromSpecialist, session, broker: broker.userInputBroker };
  }

  it("round-trips across a reload: listed, owner-only, validated, answered, resolved", async () => {
    const { chat, connect, askFromSpecialist } = await setup();
    let outcome: UserInputOutcome<{ count: number }> | undefined;
    runTurnMock.mockImplementation(async (opts) => {
      outcome = await askFromSpecialist(opts, settingsRequest());
      return turnOutput();
    });

    const first = connect("alice");
    await first.call("chat.send", { sessionId: chat.id, message: "render the harbour", requestId: "req-1" });
    await vi.waitFor(() => expect(first.eventsOf("agent.user_input_needed")).toHaveLength(1));
    const needed = first.eventsOf("agent.user_input_needed")[0]!;
    expect(needed).toMatchObject({ requestId: "req-1", sessionId: chat.id, kind: "image_settings", title: "Image settings", sourceAgent: "image_creator", timeoutMs: 60_000 });
    const inputId = String(needed["inputId"]);

    // The page reloads: the old socket closes, and the question does not close with it.
    first.conn.close();
    const reloaded = connect("alice");
    const got = await reloaded.call("session.get", { sessionId: chat.id });
    expect((got.payload!["openUserInputs"] as Array<Record<string, unknown>>).map((entry) => entry["inputId"])).toEqual([inputId]);

    // Another account cannot read the session, so it sees no question, and cannot answer one —
    // operator is not admin.
    const other = connect("mallory");
    const otherView = await other.call("session.get", { sessionId: chat.id });
    expect(otherView.ok).toBe(false);
    expect(String(otherView.error)).toContain("not found");
    expect((await other.call("userInput.respond", { inputId, answer: { settings: { count: 2 } } })).payload)
      .toEqual({ ok: false, errors: [{ field: "inputId", message: "expired" }] });

    // Opening the form extends the deadline; the preview serves only the payload's own ids.
    const held = await reloaded.call("userInput.hold", { inputId });
    expect(Date.parse(String(held.payload!["expiresAt"]))).toBeGreaterThanOrEqual(Date.parse(String(needed["expiresAt"])));
    expect((await reloaded.call("userInput.preview", { inputId, candidateId: "cand-1" })).payload).toMatchObject({ width: 640, height: 480 });
    expect((await reloaded.call("userInput.preview", { inputId, candidateId: "/etc/passwd" })).ok).toBe(false);

    // A bad answer is refused field by field and the question stays open.
    expect((await reloaded.call("userInput.respond", { inputId, answer: { settings: { count: 9 } } })).payload)
      .toEqual({ ok: false, errors: [{ field: "settings.count", message: "between 1 and 5" }] });
    expect(outcome).toBeUndefined();

    expect((await reloaded.call("userInput.respond", { inputId, answer: { settings: { count: 3 } } })).payload).toEqual({ ok: true });
    await vi.waitFor(() => expect(outcome).toMatchObject({ outcome: "configured", value: { count: 3 } }));
    // The reloaded page hears the question close, though the turn's other events went to the old socket.
    expect(reloaded.eventsOf("agent.user_input_resolved")).toEqual([
      { requestId: "req-1", sessionId: chat.id, inputId, outcome: "configured", summary: "3 images" },
    ]);
    expect((await reloaded.call("userInput.respond", { inputId, answer: { settings: { count: 4 } } })).payload)
      .toEqual({ ok: false, errors: [{ field: "inputId", message: "expired" }] });
  });

  it("an admin may answer a question in another user's turn", async () => {
    const { chat, connect, askFromSpecialist } = await setup();
    let outcome: UserInputOutcome<{ count: number }> | undefined;
    runTurnMock.mockImplementation(async (opts) => {
      outcome = await askFromSpecialist(opts, settingsRequest());
      return turnOutput();
    });
    const owner = connect("alice");
    await owner.call("chat.send", { sessionId: chat.id, message: "render the harbour", requestId: "req-2" });
    await vi.waitFor(() => expect(owner.eventsOf("agent.user_input_needed")).toHaveLength(1));
    const inputId = String(owner.eventsOf("agent.user_input_needed")[0]!["inputId"]);

    const admin = connect("root", "admin");
    expect((await admin.call("userInput.respond", { inputId, answer: { settings: { count: 1 } } })).payload).toEqual({ ok: true });
    await vi.waitFor(() => expect(outcome).toMatchObject({ outcome: "configured", value: { count: 1 } }));
  });

  it("settles the question when the turn ends, and when the turn is cancelled", async () => {
    const { chat, connect, askFromSpecialist } = await setup();
    const left: Array<Promise<UserInputOutcome<{ count: number }>>> = [];
    // A tool that asked and was abandoned by its run: the turn finishes without the answer.
    runTurnMock.mockImplementationOnce(async (opts) => {
      left.push(askFromSpecialist(opts, settingsRequest()));
      return turnOutput();
    });
    const tab = connect("alice");
    await tab.call("chat.send", { sessionId: chat.id, message: "render", requestId: "req-end" });
    await expect(left[0]!).resolves.toMatchObject({ outcome: "cancelled", reason: "turn_aborted" });
    expect(tab.eventsOf("agent.user_input_resolved")[0]).toMatchObject({ requestId: "req-end", outcome: "cancelled", reason: "turn_aborted" });

    const parked: Array<Promise<UserInputOutcome<{ count: number }>>> = [];
    runTurnMock.mockImplementationOnce((opts) => {
      parked.push(askFromSpecialist(opts, settingsRequest()));
      return new Promise<TurnOutput>(() => { /* the run is parked on the question */ });
    });
    await tab.call("chat.send", { sessionId: chat.id, message: "render again", requestId: "req-stop" });
    await vi.waitFor(() => expect(parked).toHaveLength(1));
    await tab.call("chat.cancel", { requestId: "req-stop" });
    await expect(parked[0]!).resolves.toMatchObject({ outcome: "cancelled", reason: "turn_aborted" });
  });

  it("--auto has nobody to ask: the question is answered auto / no_channel at once", async () => {
    const { chat, connect, askFromSpecialist } = await setup();
    let outcome: UserInputOutcome<{ count: number }> | undefined;
    runTurnMock.mockImplementation(async (opts) => {
      outcome = await askFromSpecialist(opts, settingsRequest());
      return turnOutput();
    });
    const tab = connect("alice");
    await tab.call("chat.send", { sessionId: chat.id, message: "render --auto", requestId: "req-auto" });
    await vi.waitFor(() => expect(outcome).toEqual({ outcome: "auto", reason: "no_channel", waitedMs: 0 }));
    expect(tab.eventsOf("agent.user_input_needed")).toHaveLength(0);
  });

  it("ask_user's question carries its clamped deadline, and a late answer is told it expired", async () => {
    const { chat, connect } = await setup();
    let answered: string | undefined;
    runTurnMock.mockImplementation(async (opts) => {
      answered = await opts.inputCallback!("Which region?", ["North", "South"], 5);
      return turnOutput();
    });
    const tab = connect("alice");
    await tab.call("chat.send", { sessionId: chat.id, message: "plan the trip", requestId: "req-ask" });
    await vi.waitFor(() => expect(tab.eventsOf("agent.input_needed")).toHaveLength(1));
    const question = tab.eventsOf("agent.input_needed")[0]!;
    // 5 ms is not a question anyone can answer: held at the 10 s floor, and the card is told when.
    expect(question["timeoutMs"]).toBe(10_000);
    expect(Date.parse(String(question["expiresAt"]))).toBeGreaterThan(Date.now() + 5_000);

    expect((await tab.call("input.respond", { inputId: question["inputId"], answer: "South" })).payload).toEqual({ ok: true });
    await vi.waitFor(() => expect(answered).toBe("South"));
    expect((await tab.call("input.respond", { inputId: question["inputId"], answer: "North" })).payload)
      .toEqual({ ok: false, errors: [{ field: "inputId", message: "expired" }] });
  });

  it("the gateway watchdog holds while the person answers and credits the wait afterwards", async () => {
    vi.useFakeTimers();
    const { chat, connect, askFromSpecialist, session, broker } = await setup();
    let outcome: UserInputOutcome<{ count: number }> | undefined;
    runTurnMock.mockImplementation((opts) => {
      void askFromSpecialist(opts, settingsRequest(900_000)).then((settled) => { outcome = settled; });
      return new Promise<TurnOutput>(() => { /* a turn that never finishes on its own */ });
    });
    const tab = connect("alice");
    await tab.call("chat.send", { sessionId: chat.id, message: "render", requestId: "req-watch" });
    const inputId = String(tab.eventsOf("agent.user_input_needed")[0]!["inputId"]);
    const archived = () => session.getSessionRecord(chat.id)?.isArchived() === true;

    // Past the turn budget and its synthesis grace: a silent turn would be parked here.
    await vi.advanceTimersByTimeAsync(30_000 + TURN_TIMEOUT_SYNTHESIS_GRACE_MS + 5_000);
    expect(archived()).toBe(false);

    // The person answers 200 s in; the deadline moves by those 200 s, so the turn is still owed
    // the time it had when the question went up.
    await vi.advanceTimersByTimeAsync(100_000);
    await broker.respond(inputId, { settings: { count: 2 } }, { userId: "alice", isAdmin: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toMatchObject({ outcome: "configured" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(archived()).toBe(false);

    // The watchdog itself still works once nobody is being waited on.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(archived()).toBe(true);
  });
});
