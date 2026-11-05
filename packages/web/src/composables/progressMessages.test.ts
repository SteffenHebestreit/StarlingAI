import { describe, expect, it } from "vitest";
import { dropRunningTail, markRunningTail, mergeHydrated, sameMessage, type HydrationMessage } from "./hydration";
import { placeProgressMessage, progressMessageFromEvent } from "./progressMessage";
import { recoveryVerdict, savedEnding } from "./turnRecovery";
import { latestTurn, type SegmentMessage } from "./turnSegments";
import { lastAssistantMessage, turnOutcome } from "../speech/turnOutcome";
import { TurnNarrator } from "../speech/turnNarrator";

/**
 * A TURN'S PROGRESS MESSAGES ARE NEVER ITS ANSWER (stores/gateway.ts ChatMessage.progress).
 * A running turn posts its plan and each finished step as messages of their own, before the
 * bubble it is still writing. Everything that looks for "the turn's last assistant message" —
 * the reload merge, the recovery of a turn the page lost, the voice reading the answer — must pass
 * over them, and a reload while the turn runs must keep them.
 */
type Message = HydrationMessage & SegmentMessage & { blocked?: boolean; stopped?: boolean };
const at = new Date("2026-11-05T10:00:00Z");
const user = (id: string, content: string, requestId = "req-1"): Message => ({ id, role: "user", content, requestId, timestamp: at });
const progress = (id: string, content: string, requestId = "req-1"): Message => ({ id, role: "assistant", content, requestId, progress: true, timestamp: at });
const answer = (id: string, content: string, requestId = "req-1"): Message => ({ id, role: "assistant", content, requestId, timestamp: at });
const streaming = (): Message => ({ id: "streaming", role: "assistant", content: "", requestId: "req-1", timestamp: at });

describe("a progress message arriving live", () => {
  it("becomes its own message before the live bubble, in arrival order, once", () => {
    const list: Array<{ id: string }> = [user("u1", "chart and report"), streaming()];
    const plan = progressMessageFromEvent({ requestId: "req-1", id: "s:p:1", kind: "plan", text: " Here's my plan\n1. Chart ", timestamp: "2026-11-05T10:00:03Z" })!;
    const step = progressMessageFromEvent({ requestId: "req-1", id: "s:p:2", kind: "step", text: "Step 1 of 1 is done." })!;
    expect(plan).toMatchObject({ role: "assistant", progress: true, requestId: "req-1", content: "Here's my plan\n1. Chart" });
    expect(placeProgressMessage(list, plan)).toBe(true);
    expect(placeProgressMessage(list, step)).toBe(true);
    expect(placeProgressMessage(list, { ...plan })).toBe(false);
    expect(list.map((message) => message.id)).toEqual(["u1", "s:p:1", "s:p:2", "streaming"]);
  });

  it("carries nothing without an id or words, and goes last with no live bubble", () => {
    expect(progressMessageFromEvent({ id: "s:p:1", text: "  " })).toBeNull();
    expect(progressMessageFromEvent({ text: "Plan" })).toBeNull();
    const list: Array<{ id: string }> = [user("u1", "q")];
    placeProgressMessage(list, progressMessageFromEvent({ id: "s:p:9", text: "late" })!);
    expect(list.map((message) => message.id)).toEqual(["u1", "s:p:9"]);
  });
});

describe("progress messages across a reload", () => {
  it("are told apart from an answer with the same words", () => {
    expect(sameMessage(progress("s:p:1", "Plan: 1. Chart"), answer("s:3", "Plan: 1. Chart"))).toBe(false);
    expect(sameMessage(progress("s:p:1", "Plan: 1. Chart"), progress("s:p:1", "Plan:  1. Chart"))).toBe(true);
  });

  it("stay when a running turn's tail is dropped, and are never marked as segments", () => {
    const transcript = [user("s:0", "chart and report"), progress("s:p:1", "Here's my plan"), answer("s:1", "")];
    expect(dropRunningTail(transcript, { requestId: "req-1" }).map((entry) => entry.id)).toEqual(["s:0", "s:p:1"]);
    expect(markRunningTail(transcript).map((entry) => Boolean(entry.continued))).toEqual([false, false, true]);
  });

  it("keep one copy each, in order, above the live bubble, when the page reads the transcript mid-turn", () => {
    // The page got the plan live; the step was posted while it was reconnecting.
    const local = [user("u-local", "chart and report"), progress("s:p:1", "Here's my plan"), streaming()];
    const fetched = dropRunningTail(
      [user("s:0", "chart and report"), progress("s:p:1", "Here's my plan"), progress("s:p:2", "Step 1 of 2 is done"), answer("s:1", "")],
      { requestId: "req-1" },
    );
    const merged = mergeHydrated(fetched, local, { knownBefore: new Set(local.map((message) => message.id)), sameSession: true });
    expect(merged.map((message) => message.id)).toEqual(["u-local", "s:p:1", "s:p:2", "streaming"]);
  });
});

describe("progress messages are no answer", () => {
  it("to the recovery of a turn the page lost: a turn stopped after its plan has not answered", () => {
    const transcript = [user("s:0", "chart and report"), progress("s:p:1", "Here's my plan")];
    expect(savedEnding(transcript, { requestId: "req-1" })).toBe("unclear");
    expect(recoveryVerdict({ activeTurn: false, transcript, totalMessages: 2, baselineTotalMessages: 1, requestId: "req-1" })).toBe("lost");
    const answered = [...transcript, answer("s:1", "Here is your chart.")];
    expect(savedEnding(answered, { requestId: "req-1" })).toBe("answer");
    expect(recoveryVerdict({ activeTurn: false, transcript: answered, totalMessages: 3, baselineTotalMessages: 1, requestId: "req-1" })).toBe("landed");
    // With no word from the server, a progress message at the end is not a landed answer either.
    expect(recoveryVerdict({ transcript, totalMessages: 2, baselineTotalMessages: 1, requestId: "req-1" })).toBe("unknown");
  });

  it("to the recovery of a turn whose entries name no turn, where a progress message can come last", () => {
    const unnamed = (message: Message): Message => { const { requestId: _dropped, ...rest } = message; return rest as Message; };
    const transcript = [
      unnamed(user("s:0", "chart and report")),
      { ...unnamed(answer("s:1", "")), toolCalls: [{ name: "delegate_to_agent", result: "done" }] } as Message,
      unnamed(progress("s:p:1", "Step 1 of 2 is done")),
    ];
    expect(recoveryVerdict({ transcript, totalMessages: 3, baselineTotalMessages: 1, openerText: "chart and report" })).toBe("unknown");
  });

  it("to the page's own note on a failed turn: the note stays beside the turn's plan", () => {
    const note: Message = { ...answer("note-1", "⚠️ The model did not answer."), pageOnly: true, blocked: true };
    const local = [user("u1", "chart and report"), note];
    const fetched = [user("s:0", "chart and report"), progress("s:p:1", "Here's my plan")];
    const merged = mergeHydrated(fetched, local, { knownBefore: new Set(local.map((message) => message.id)), sameSession: true });
    expect(merged.map((message) => message.id)).toContain("note-1");
    expect(merged.map((message) => message.id)).toContain("s:p:1");
  });

  it("to the voice: a turn stopped after its plan reads nothing aloud", () => {
    const messages = [user("u1", "q"), answer("a1", "earlier answer"), user("u2", "chart"), progress("p1", "Here's my plan")];
    expect(lastAssistantMessage(messages)?.id).toBe("a1");
    expect(turnOutcome(messages, "a1")).toEqual({ kind: "silent" });
  });

  it("but they belong to the newest turn, which stays in view with them", () => {
    const messages = [user("u1", "q"), answer("a1", "old"), user("u2", "chart"), progress("p1", "plan"), progress("p2", "step"), answer("a2", "done")];
    const turn = latestTurn(messages);
    expect(turn.start).toBe(2);
    expect([...turn.assistantIds].sort()).toEqual(["a2", "p1", "p2"]);
  });
});

describe("the narrator after a progress message was spoken", () => {
  it("does not announce the same kind of work again, and counts the silence from it", () => {
    const narrator = new TurnNarrator(0, { firstAfterMs: 0, minGapMs: 1_000, stillWorkingAfterMs: 5_000 });
    narrator.noteSpoken(100, "planning");
    // A plan step shows up: the plan was already told in the turn's own words.
    expect(narrator.observe({ now: 2_000, steps: [{ id: "t1", kind: "tool", name: "record_plan" }] })).toBeNull();
    // Another kind of work is still announced.
    expect(narrator.observe({ now: 3_500, steps: [{ id: "t2", kind: "tool", name: "web_search" }] })).toEqual({ kind: "milestone", milestone: "searching" });
  });
});
