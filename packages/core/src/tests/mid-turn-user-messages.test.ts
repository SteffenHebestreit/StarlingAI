import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../agent/session.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { findRecentDelegateEvidence } from "../agent/interrupted-delegation-evidence.js";
import { collectTurnArtifactAttachments } from "../agent/runtime.js";
import { currentTurnStartIndex, startsTurn } from "../agent/turn-boundary.js";

/**
 * Mid-turn steering and the oversight redirect are injected as `role: "user"` messages so the
 * model treats them as the user's words — but they arrive INSIDE a turn. Every reader that keyed
 * "the current turn" on the last user-role message cut the turn there: the plan report was clipped
 * on the very turn answering from it, the recovery backstops dropped this turn's pre-steering
 * evidence, and the turn's own artifacts went missing from the verification gate. Those messages
 * now carry `metadata.midTurn`; a turn starts at a user message without it.
 */
const STEERING = {
  role: "user" as const,
  content: "[USER STEERING — sent mid-turn] Also cover Slovenia.",
  metadata: { midTurn: true },
};
const UNMARKED_STEERING = { role: "user" as const, content: STEERING.content };

const makeSession = () => new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });

describe("mid-turn user messages do not end the turn", () => {
  it("startsTurn / currentTurnStartIndex read the marker", () => {
    expect(startsTurn({ role: "user" })).toBe(true);
    expect(startsTurn(STEERING)).toBe(false);
    expect(startsTurn({ role: "assistant" })).toBe(false);
    expect(currentTurnStartIndex([{ role: "user" }, { role: "assistant" }, STEERING])).toBe(0);
    expect(currentTurnStartIndex([{ role: "user" }, { role: "assistant" }, UNMARKED_STEERING])).toBe(2);
  });

  it("keeps the 12K plan report on the turn that is answering from it after a steering message", () => {
    const build = (steering: typeof STEERING | typeof UNMARKED_STEERING) => {
      const session = makeSession();
      session.addMessage({ role: "user", content: "compare the regions" });
      session.addMessage({
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "execute_plan", arguments: "{}" } }],
      } as never);
      session.addMessage({ role: "tool", content: "STEP s1 result: " + "x".repeat(6_000), tool_call_id: "call-1" } as never);
      session.addMessage(steering);
      return session.getCollapsedHistory().map((m) => String(m.content)).join("\n");
    };
    expect(build(STEERING)).toContain("x".repeat(5_000));          // still this turn: the whole report
    expect(build(UNMARKED_STEERING)).not.toContain("x".repeat(5_000)); // the control: an unmarked user message ends it
  });

  it("keeps a transient note visible across a steering message", () => {
    const session = makeSession();
    session.addMessage({ role: "user", content: "do the thing" });
    session.addMessage({ role: "system", content: "[USER INTERACTION OWNERSHIP] The main assistant owns all user-facing interaction." });
    session.addMessage(STEERING);
    expect(session.hasTransientNoteThisTurn("[USER INTERACTION OWNERSHIP]")).toBe(true);
  });

  it("the current-turn evidence backstop still sees this turn's pre-steering delegated evidence", () => {
    // Above the backstop's 400-character floor for a completed delegation, and structured enough
    // to score — this is what a real research result looks like.
    const evidence = "Delegated result from researcher — TASK COMPLETED.\nObserved evidence:\n"
      + "- The Vršič pass reaches 1,611 m and is open from early May to late October.\n"
      + "- The Soča valley has 14 registered campsites; the largest holds 320 pitches.\n"
      + "- Bled charges 6 EUR per day for lakeside parking, 3 EUR after 18:00.\n"
      + "- The Triglav park hut network lists 21 huts with 1,300 beds in total.\n"
      + "- The Kranjska Gora chairlifts run until 18:00 in summer, 16:00 in September.\n"
      + "- Rail from Ljubljana to Bled takes 40 minutes and runs hourly until 21:00.\n";
    const history = (steering: typeof STEERING | typeof UNMARKED_STEERING) => [
      { role: "user", content: "plan the trip" },
      { role: "tool", content: evidence, metadata: { agentName: "researcher", delegationSucceeded: true, delegationOutcome: "success" } },
      steering,
    ];
    expect(findRecentDelegateEvidence(history(STEERING), { scopeToCurrentTurn: true })).not.toBeNull();
    expect(findRecentDelegateEvidence(history(UNMARKED_STEERING), { scopeToCurrentTurn: true })).toBeNull();
  });

  it("this turn's artifacts are still this turn's after a steering message", () => {
    const build = (steering: typeof STEERING | typeof UNMARKED_STEERING) => {
      const session = makeSession();
      session.addMessage({ role: "user", content: "build the report" });
      session.addMessage({ role: "tool", content: "written", tool_call_id: "call-1", metadata: { filename: "report.pdf", outputPath: "out/report.pdf" } } as never);
      session.addMessage(steering);
      return collectTurnArtifactAttachments(session);
    };
    expect(build(STEERING)).toHaveLength(1);
    expect(build(UNMARKED_STEERING)).toHaveLength(0);
  });
});

/**
 * On reload a steered turn is split the way it looked live: the part before the message, the
 * message, the part after it. The history keeps the model-facing wrapper and the whole turn's
 * swarm state and files on the final answer; the transcript shows the person's words only, and
 * each part only what happened inside it.
 */
describe("a steered turn in the transcript", () => {
  afterEach(() => { vi.useRealTimers(); });

  const WRAPPER = "[USER STEERING — sent mid-turn] The user added the following while you were working. "
    + "Take it into account in the REMAINING steps of this turn: adjust course, drop now-irrelevant work, and prioritise it. "
    + "Do not restart from scratch or re-do already-completed steps.\n";
  const steered = (messages: Array<{ id: string; text: string }>) => ({
    role: "user" as const,
    content: WRAPPER + messages.map((message) => `- ${message.text}`).join("\n"),
    metadata: { midTurn: true, midTurnSource: "user", steering: messages },
  });
  const delegation = (id: string) => ({
    role: "assistant",
    content: "",
    tool_calls: [{ id, type: "function", function: { name: "delegate_to_agent", arguments: JSON.stringify({ agentName: "image_creator" }) } }],
  }) as never;
  const imageResult = (callId: string, file: string) => ({
    role: "tool",
    content: `Saved generated/images/${file}`,
    tool_call_id: callId,
    metadata: { agentName: "image_creator", artifacts: [{ outputPath: `generated/images/${file}`, filename: file, sourceTool: "generate_image" }] },
  }) as never;
  /** Pins the clock so the history timestamps are known. */
  const clockAt = (time: string) => vi.setSystemTime(new Date(`2026-09-23T${time}.000Z`));

  it("shows each message the person sent as their own words, never the wrapper, and marks where the turn went on", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const session = makeSession();
    clockAt("10:00:00"); session.addMessage({ role: "user", content: "render the harbour" });
    clockAt("10:00:01"); session.addMessage(delegation("call-1"));
    clockAt("10:00:30"); session.addMessage(imageResult("call-1", "a.png"));
    clockAt("10:00:40"); session.addMessage(steered([
      { id: "steer-aaa-001", text: "nimm das qwen model" },
      { id: "steer-aaa-002", text: "und mach es realer" },
    ]));
    clockAt("10:01:20"); session.addMessage({ role: "assistant", content: "Done." });

    const transcript = session.toTranscript();
    expect(transcript.map((entry) => [entry.role, entry.content, entry.midTurn, entry.steeringId])).toEqual([
      ["user", "render the harbour", undefined, undefined],
      ["assistant", "", undefined, undefined],
      ["user", "nimm das qwen model", true, "steer-aaa-001"],
      ["user", "und mach es realer", true, "steer-aaa-002"],
      ["assistant", "Done.", undefined, undefined],
    ]);
    expect(transcript[2]!.id).toBe(`${session.id}:3`);
    expect(transcript[3]!.id).toBe(`${session.id}:3+1`);
    expect(JSON.stringify(transcript)).not.toContain("USER STEERING");
    expect(transcript.map((entry) => entry.continued)).toEqual([undefined, true, undefined, undefined, undefined]);
    expect(transcript.map((entry) => entry.segmentStartedAt)).toEqual([undefined, undefined, undefined, undefined, "2026-09-23T10:00:40.000Z"]);
  });

  it("previews a turn that is still running with the person's words", () => {
    const session = makeSession();
    session.addMessage({ role: "user", content: "render the harbour" });
    session.addMessage(steered([{ id: "steer-bbb-001", text: "nimm das qwen model" }]));
    expect(session.toSummary().preview).toBe("nimm das qwen model");
  });

  it("reads a message saved before the steering metadata existed from its wrapper", () => {
    const session = makeSession();
    session.addMessage({ role: "user", content: "compare the regions" });
    session.addMessage({ role: "user", content: WRAPPER + "- also cover Slovenia\n- skip Croatia", metadata: { midTurn: true } });
    session.addMessage({ role: "user", content: WRAPPER + "- one message\nwith a second line", metadata: { midTurn: true } });
    const shown = session.toTranscript().filter((entry) => entry.midTurn).map((entry) => entry.content);
    expect(shown).toEqual(["also cover Slovenia", "skip Croatia", "one message\nwith a second line"]);
  });

  it("leaves the oversight redirect out, so the parts around it read as one", () => {
    for (const metadata of [{ midTurn: true, midTurnSource: "oversight" }, { midTurn: true }]) {
      const session = makeSession();
      session.addMessage({ role: "user", content: "build the site" });
      session.addMessage(delegation("call-1"));
      session.addMessage(imageResult("call-1", "a.png"));
      session.addMessage({ role: "user", content: "[OVERSIGHT — max-effort progress check] A progress monitor judged this turn is not converging.", metadata });
      expect(session.toSummary().preview).not.toContain("OVERSIGHT");
      session.addMessage(delegation("call-2"));
      session.addMessage(imageResult("call-2", "b.png"));
      session.addMessage({ role: "assistant", content: "Built it." });

      const transcript = session.toTranscript();
      expect(transcript.map((entry) => entry.role)).toEqual(["user", "assistant"]);
      expect(transcript[1]!.toolCalls).toHaveLength(2);
      expect(transcript[1]!.continued).toBeUndefined();
      expect(JSON.stringify(transcript)).not.toContain("OVERSIGHT");
    }
  });

  it("gives each part only the specialist attempts that started inside it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const attempt = (startedAt: string, status: "completed" | "failed") => ({
      agentName: "image_creator", status, startedAt: `2026-09-23T${startedAt}.000Z`,
    });
    const swarmState = {
      objective: "render the harbour",
      startedAt: "2026-09-23T10:00:00.000Z",
      updatedAt: "2026-09-23T10:01:20.000Z",
      tasks: {
        before: { id: "before", title: "fast render", status: "completed", dependsOn: [], attempts: [attempt("10:00:02", "completed")] },
        after: { id: "after", title: "qwen render", status: "completed", dependsOn: [], attempts: [attempt("10:00:42", "completed")] },
        retried: {
          id: "retried", title: "upscale", status: "completed", dependsOn: [],
          attempts: [attempt("10:00:05", "failed"), attempt("10:00:45", "completed")],
          totals: { attempts: 2, toolCount: 2, iterations: 2, promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0 },
        },
      },
    };
    const session = makeSession();
    clockAt("10:00:00"); session.addMessage({ role: "user", content: "render the harbour" });
    clockAt("10:00:01"); session.addMessage(delegation("call-1"));
    clockAt("10:00:30"); session.addMessage(imageResult("call-1", "a.png"));
    clockAt("10:00:40"); session.addMessage(steered([{ id: "steer-ccc-001", text: "nimm das qwen model" }]));
    clockAt("10:00:41"); session.addMessage(delegation("call-2"));
    clockAt("10:01:10"); session.addMessage(imageResult("call-2", "b.png"));
    clockAt("10:01:20"); session.addMessage({ role: "assistant", content: "Rendered with Qwen.", metadata: { swarmState } });

    const [, before, , after] = session.toTranscript();
    const startsOf = (entry: typeof before) => Object.fromEntries(Object.entries(entry!.swarmState?.tasks ?? {})
      .map(([key, task]) => [key, task.attempts.map((a) => a.startedAt.slice(11, 19))]));
    expect(startsOf(before)).toEqual({ before: ["10:00:02"], retried: ["10:00:05"] });
    expect(startsOf(after)).toEqual({ after: ["10:00:42"], retried: ["10:00:45"] });
    // A task split across parts reads as each part's own attempt, without the whole task's totals.
    expect(before!.swarmState!.tasks["retried"]!.status).toBe("failed");
    expect(before!.swarmState!.tasks["retried"]!.totals).toBeUndefined();
    // The saved record stays whole.
    const saved = session.getHistory().at(-1)!.metadata!["swarmState"] as typeof swarmState;
    expect(saved.tasks.retried.attempts).toHaveLength(2);
  });

  it("does not list an earlier part's files again on the answer after the message", () => {
    const session = makeSession();
    session.addMessage({ role: "user", content: "render the harbour" });
    session.addMessage(delegation("call-1"));
    session.addMessage(imageResult("call-1", "a.png"));
    session.addMessage(steered([{ id: "steer-ddd-001", text: "now write the caption" }]));
    // The answer pins the WHOLE turn's files, as persistAssistantTurnState does, plus one no tool
    // call of this transcript recorded.
    const attachments = [...collectTurnArtifactAttachments(session), { filename: "caption.md", relativePath: "out/caption.md" }];
    session.addMessage({ role: "assistant", content: "Here is the caption.", metadata: { attachments } });

    const transcript = session.toTranscript();
    const answer = transcript.at(-1)!;
    expect(answer.content).toBe("Here is the caption.");
    expect(answer.attachments?.map((attachment) => attachment.filename)).toEqual(["caption.md"]);
    // The earlier part still shows its image, through its own tool call.
    expect(transcript[1]!.toolCalls?.[0]?.metadata?.["artifacts"]).toBeDefined();
    expect((session.getHistory().at(-1)!.metadata!["attachments"] as unknown[])).toHaveLength(2);
  });
});

/**
 * Each transcript entry names the chat.send turn it belongs to. The web told turns apart by their
 * text, and a second tab re-sending the same words left a message "Queued" under the wrong turn.
 */
describe("which turn a transcript entry belongs to", () => {
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
  const result = (callId: string) => ({ role: "tool", content: "done", tool_call_id: callId }) as never;
  const inTurn = (requestId: string, write: () => void) => runWithRequestContext({ chatRequestId: requestId }, write);

  it("names the turn that wrote each entry: a steering message by the turn that read it, a superseded turn's late write by its own", () => {
    const session = makeSession();
    inTurn("req-a", () => {
      session.addMessage({ role: "user", content: "render the harbour" });
      session.addMessage(delegation("call-1"));
      session.addMessage(result("call-1"));
    });
    // Another tab's send superseded it; the old turn unwinds after the new one has started.
    inTurn("req-b", () => {
      session.addMessage({ role: "user", content: "also add a caption" });
      session.addMessage(delegation("call-2"));
      session.addMessage(result("call-2"));
    });
    inTurn("req-a", () => session.addMessage({ role: "assistant", content: "Stopped before the render finished." }));
    inTurn("req-b", () => {
      session.addMessage(steered("steer-hat-0001", "and a hat"));
      session.addMessage({ role: "assistant", content: "Captioned, with a hat." });
    });

    const transcript = session.toTranscript();
    expect(transcript.map((entry) => [entry.role, entry.content, entry.requestId, entry.continued])).toEqual([
      ["user", "render the harbour", "req-a", undefined],
      ["assistant", "", "req-a", undefined],
      ["user", "also add a caption", "req-b", undefined],
      // The steered turn goes on after its own part, not after the other turn's late write.
      ["assistant", "", "req-b", true],
      ["assistant", "Stopped before the render finished.", "req-a", undefined],
      ["user", "and a hat", "req-b", undefined],
      ["assistant", "Captioned, with a hat.", "req-b", undefined],
    ]);
    expect(transcript[5]!.steeringId).toBe("steer-hat-0001");
  });

  it("keeps each entry's turn across a save and load, and names none for history saved before it", () => {
    const session = makeSession();
    inTurn("req-a", () => {
      session.addMessage({ role: "user", content: "render the harbour" });
      session.addMessage(steered("steer-blue-01", "make it blue"));
      session.addMessage({ role: "assistant", content: "Rendered in blue." });
    });
    const loaded = AgentSession.fromRecord(JSON.parse(JSON.stringify(session.toRecord())));
    expect(loaded.toTranscript().map((entry) => entry.requestId)).toEqual(["req-a", "req-a", "req-a"]);

    const legacy = session.toRecord();
    legacy.history = legacy.history.map(({ requestId: _dropped, ...message }) => message);
    const before = AgentSession.fromRecord(legacy).toTranscript();
    expect(before.map((entry) => entry.content)).toEqual(["render the harbour", "make it blue", "Rendered in blue."]);
    expect(before.filter((entry) => "requestId" in entry)).toEqual([]);
  });
});
