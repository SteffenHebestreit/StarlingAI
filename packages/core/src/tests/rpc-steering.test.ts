import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTurnOptions, TurnOutput } from "../agent/turn-types.js";

const runTurnMock = vi.hoisted(() => vi.fn<(opts: RunTurnOptions) => Promise<TurnOutput>>());

// The turn itself is stubbed: what these tests pin is what the RPC bridge does around it.
vi.mock("../agent/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/runtime.js")>()),
  runTurn: runTurnMock,
}));

/**
 * Mid-turn steering over the dashboard's WebSocket: the bridge opens steering before the
 * runtime is through its start-up, forwards which messages the loop took, and hands back on
 * the final status whatever it never took, so the client can send those on.
 */
describe("rpc chat.send and mid-turn steering", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-rpc-steering-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({ gateway: { jwtSecret: "t".repeat(32), turnTimeoutMs: 30_000 } }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
  });

  afterEach(async () => {
    runTurnMock.mockReset();
    const [session, { turnSteeringManager }, configLoader] = await Promise.all([
      import("../agent/session.js"),
      import("../agent/turn-steering.js"),
      import("../config/loader.js"),
    ]);
    turnSteeringManager.resetForTests();
    for (const active of session.getAllSessions()) session.endSession(active.id);
    configLoader.resetConfigForTests();
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  function mockWs(): { readyState: number; send(p: string): void; sent: Array<Record<string, unknown>> } {
    const sent: Array<Record<string, unknown>> = [];
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

  /** A promise the test settles by hand, standing in for the turn's start-up or its work. */
  function gate(): { wait: Promise<void>; open: () => void } {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => { open = resolve; });
    return { wait, open };
  }

  async function setup() {
    const [{ RpcConnection }, session, steering] = await Promise.all([
      import("../gateway/rpc.js"),
      import("../agent/session.js"),
      import("../agent/turn-steering.js"),
    ]);
    const chat = session.createSession({ channel: "webchat" });
    const ws = mockWs();
    const conn = new RpcConnection(ws as never);
    const send = (requestId: string) => conn.handleMessage(JSON.stringify({
      id: `send-${requestId}`, method: "chat.send", params: { sessionId: chat.id, message: "render the harbour", requestId },
    }));
    const statusOf = (requestId: string, status: string) => ws.sent.find((event) => event["type"] === "status"
      && (event["data"] as Record<string, unknown>)["requestId"] === requestId
      && (event["data"] as Record<string, unknown>)["status"] === status)?.["data"] as Record<string, unknown> | undefined;
    return { conn, ws, chat, send, statusOf, steering: steering.turnSteeringManager, recordUnconsumedSteering: steering.recordUnconsumedSteering };
  }

  it("takes a message sent while the turn is still starting up, and reports which ones the loop took", async () => {
    const { conn, ws, chat, send, statusOf, steering } = await setup();
    const startUp = gate();
    const work = gate();
    runTurnMock.mockImplementation(async (opts) => {
      await startUp.wait; // the runtime's awaits before it marks the turn active
      const token = steering.markTurnActive(opts.session.id, opts.steeringToken);
      const taken = steering.drain(opts.session.id, token).map(({ id, text }) => ({ id, text }));
      opts.onSteeringConsumed?.({ messages: taken, iteration: 0, at: "2026-09-23T10:00:40.000Z" });
      opts.onStatus?.({ phase: "steering", message: "Folding in your mid-turn message…", iteration: 0 });
      await work.wait;
      return turnOutput({ unconsumedSteering: steering.closeTurn(opts.session.id, token).map(({ id, text }) => ({ id, text })) });
    });

    await send("req-1");
    // Before the runtime has started, a steer already joins this turn instead of failing — the
    // failure made the client send it as a new message, which cancelled the turn.
    expect(steering.isTurnActive(chat.id)).toBe(true);
    expect(steering.enqueue(chat.id, "nimm das qwen model", "early-steer-01").queued).toBe(true);
    await conn.handleMessage(JSON.stringify({ id: "get-1", method: "session.get", params: { sessionId: chat.id } }));
    const got = ws.sent.find((event) => event["type"] === "rpc.response" && event["id"] === "get-1") as { payload: Record<string, unknown> };
    expect(got.payload["activeTurn"]).toBe(true);

    startUp.open();
    await vi.waitFor(() => expect(ws.sent.some((event) => event["type"] === "agent.steering_consumed")).toBe(true));
    const consumedAt = ws.sent.findIndex((event) => event["type"] === "agent.steering_consumed");
    const statusAt = ws.sent.findIndex((event) => event["type"] === "status" && (event["data"] as Record<string, unknown>)["status"] === "steering");
    expect(consumedAt).toBeLessThan(statusAt);
    expect(ws.sent[consumedAt]!["data"]).toEqual({
      requestId: "req-1",
      iteration: 0,
      at: "2026-09-23T10:00:40.000Z",
      discardedDraft: false,
      messages: [{ id: "early-steer-01", text: "nimm das qwen model" }],
      // Nothing written before the cut: the part it ends shows no text.
      segmentText: "",
    });

    // Sent after the loop's last look at the queue: it comes back on the final status.
    steering.enqueue(chat.id, "und mach es realer", "late-steer-01");
    work.open();
    await vi.waitFor(() => expect(statusOf("req-1", "ok")).toBeDefined());
    expect(statusOf("req-1", "ok")!["unconsumedSteering"]).toEqual([{ id: "late-steer-01", text: "und mach es realer" }]);
    expect(steering.isTurnActive(chat.id)).toBe(false);
  });

  it("puts what a failed turn never took on the error status", async () => {
    const { send, statusOf, steering, recordUnconsumedSteering } = await setup();
    const startUp = gate();
    runTurnMock.mockImplementationOnce(async (opts) => {
      const token = steering.markTurnActive(opts.session.id, opts.steeringToken);
      await startUp.wait;
      const err = new Error("provider timed out");
      recordUnconsumedSteering(err, steering.closeTurn(opts.session.id, token));
      throw err;
    });
    await send("req-2");
    steering.enqueue((runTurnMock.mock.calls[0]![0]).session.id, "try the other region", "fail-steer-01");
    startUp.open();
    await vi.waitFor(() => expect(statusOf("req-2", "error")).toBeDefined());
    expect(statusOf("req-2", "error")!["unconsumedSteering"]).toEqual([{ id: "fail-steer-01", text: "try the other region" }]);
  });

  it("hands back what was queued for a turn that failed before it got going", async () => {
    const { chat, send, statusOf, steering } = await setup();
    const startUp = gate();
    runTurnMock.mockImplementationOnce(async () => {
      await startUp.wait;
      throw new Error("could not load the turn plan");
    });
    await send("req-3");
    steering.enqueue(chat.id, "use the qwen model", "early-fail-01");
    startUp.open();
    await vi.waitFor(() => expect(statusOf("req-3", "error")).toBeDefined());
    expect(statusOf("req-3", "error")!["unconsumedSteering"]).toEqual([{ id: "early-fail-01", text: "use the qwen model" }]);
    // And the armed turn does not linger as a live turn.
    expect(steering.isTurnActive(chat.id)).toBe(false);
  });
});
