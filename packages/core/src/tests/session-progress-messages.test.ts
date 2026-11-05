import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, resetSessionsForTests } from "../agent/session.js";
import { runWithRequestContext } from "../runtime/request-context.js";

/**
 * A TURN'S PROGRESS MESSAGES ARE SHOWN, NEVER READ BY THE MODEL (agent/session.ts
 * SessionProgressMessage). They are kept beside the history: a line written while a tool runs
 * would land between the assistant's tool calls and their results, and the results would be
 * dropped from the very turn. The transcript shows each where the live page did, before its turn's
 * answer.
 */
const WRAPPER = "[USER STEERING — sent mid-turn] The user added the following while you were working.\n";
const steered = (id: string, text: string) => ({
  role: "user" as const,
  content: `${WRAPPER}- ${text}`,
  metadata: { midTurn: true, midTurnSource: "user", steering: [{ id, text }] },
});
const delegation = (id: string) => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id, type: "function", function: { name: "delegate_to_agent", arguments: "{}" } }],
}) as never;
const result = (callId: string, content = "done") => ({ role: "tool", content, tool_call_id: callId }) as never;
const inTurn = <T>(requestId: string, write: () => T): T => runWithRequestContext({ chatRequestId: requestId }, write);

const makeSession = () => new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
const shape = (session: AgentSession) => session.toTranscript()
  .map((entry) => [entry.role, entry.content, entry.requestId, entry.progress ?? false]);

describe("a turn's progress messages", () => {
  let clock = Date.parse("2026-11-05T10:00:00.000Z");
  /** Each write a second after the last, so the order by time is the order written. */
  const tick = () => { clock += 1_000; vi.setSystemTime(clock); };
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(clock); });
  afterEach(() => { vi.useRealTimers(); resetSessionsForTests(); });

  /** A turn that recorded a plan, ran one step and answered, posting two progress messages. */
  function plannedTurn(session: AgentSession, requestId = "req-a"): void {
    inTurn(requestId, () => {
      session.addMessage({ role: "user", content: "chart and report, please" }); tick();
      session.addMessage(delegation("call-1")); tick();
      session.addProgressMessage({ kind: "plan", text: "Here's my plan:\n1. Chart" }); tick();
      session.addMessage(result("call-1", "chart written")); tick();
      session.addProgressMessage({ kind: "step", text: "Step 1 of 1 is done: Chart." }); tick();
      session.addMessage({ role: "assistant", content: "Here is your chart." }); tick();
    });
  }

  it("are shown before their turn's answer, in order, and kept across a save and load", () => {
    const session = makeSession();
    plannedTurn(session);

    expect(shape(session)).toEqual([
      ["user", "chart and report, please", "req-a", false],
      ["assistant", "Here's my plan:\n1. Chart", "req-a", true],
      ["assistant", "Step 1 of 1 is done: Chart.", "req-a", true],
      ["assistant", "Here is your chart.", "req-a", false],
    ]);
    const ids = session.toTranscript().filter((entry) => entry.progress).map((entry) => entry.id);
    expect(ids.every((id) => id.startsWith(`${session.id}:p:`))).toBe(true);

    const loaded = AgentSession.fromRecord(JSON.parse(JSON.stringify(session.toRecord())));
    expect(loaded.toTranscript()).toEqual(session.toTranscript());
  });

  it("are not in what the model reads, and the tool results around them stay with their calls", () => {
    const session = makeSession();
    plannedTurn(session);

    const collapsed = JSON.stringify(session.getCollapsedHistory());
    expect(collapsed).not.toContain("Here's my plan");
    expect(collapsed).not.toContain("Step 1 of 1");
    expect(collapsed).toContain("chart written");
    expect(session.getHistory().map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(session.toTranscript().find((entry) => entry.toolCalls)?.toolCalls?.[0]?.result).toBe("chart written");
    expect(session.toSummary().preview).toBe("Here is your chart.");
  });

  it("show a running turn's lines after its request, before the entry still being written", () => {
    const session = makeSession();
    inTurn("req-a", () => {
      session.addMessage({ role: "user", content: "chart, please" }); tick();
      session.addMessage(delegation("call-1")); tick();
      session.addProgressMessage({ kind: "bridge", text: "Let me see which tools I need." }); tick();
    });
    expect(shape(session)).toEqual([
      ["user", "chart, please", "req-a", false],
      ["assistant", "Let me see which tools I need.", "req-a", true],
      ["assistant", "", "req-a", false],
    ]);
  });

  it("go with their own part of a steered turn, and after a mid-turn message whose part has not answered yet", () => {
    const session = makeSession();
    inTurn("req-b", () => {
      session.addMessage({ role: "user", content: "render the harbour" }); tick();
      session.addMessage(delegation("call-1")); tick();
      session.addProgressMessage({ kind: "step", text: "The render is done." }); tick();
      session.addMessage(result("call-1")); tick();
      session.addMessage(steered("steer-1", "and a hat")); tick();
      session.addProgressMessage({ kind: "plan", text: "Adding the hat." }); tick();
    });
    expect(shape(session)).toEqual([
      ["user", "render the harbour", "req-b", false],
      ["assistant", "The render is done.", "req-b", true],
      ["assistant", "", "req-b", false],
      ["user", "and a hat", "req-b", false],
      ["assistant", "Adding the hat.", "req-b", true],
    ]);

    inTurn("req-b", () => { session.addMessage({ role: "assistant", content: "Done, with a hat." }); tick(); });
    expect(shape(session).slice(3)).toEqual([
      ["user", "and a hat", "req-b", false],
      ["assistant", "Adding the hat.", "req-b", true],
      ["assistant", "Done, with a hat.", "req-b", false],
    ]);
  });

  it("stay with their own turn when a superseded turn writes late", () => {
    const session = makeSession();
    inTurn("req-a", () => {
      session.addMessage({ role: "user", content: "first" }); tick();
      session.addMessage(delegation("call-1")); tick();
    });
    inTurn("req-b", () => { session.addMessage({ role: "user", content: "second" }); tick(); });
    inTurn("req-a", () => { session.addProgressMessage({ kind: "step", text: "Old step done." }); tick(); });
    inTurn("req-b", () => { session.addMessage({ role: "assistant", content: "Second answered." }); tick(); });

    expect(shape(session)).toEqual([
      ["user", "first", "req-a", false],
      ["assistant", "Old step done.", "req-a", true],
      ["assistant", "", "req-a", false],
      ["user", "second", "req-b", false],
      ["assistant", "Second answered.", "req-b", false],
    ]);
  });

  it("are cleared with a reset and cut with a rewind", () => {
    const session = makeSession();
    plannedTurn(session, "req-a");
    plannedTurn(session, "req-b");
    expect(session.getProgressMessages()).toHaveLength(4);

    // Rewind to before the second turn's request: its two lines go with it.
    session.rewindBeforeIndex(4);
    expect(session.getProgressMessages().map((message) => message.requestId)).toEqual(["req-a", "req-a"]);
    expect(shape(session).filter(([, , , progress]) => progress)).toHaveLength(2);

    session.reset();
    expect(session.getProgressMessages()).toEqual([]);
    expect(session.toRecord()).not.toHaveProperty("progressMessages");
  });
});
