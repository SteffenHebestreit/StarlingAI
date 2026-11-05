import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptPhrasing,
  createTurnProgressReporter,
  delegationMilestone,
  fixedProgressText,
  phrasingMessages,
  progressBridgeTargets,
  type ProgressPhraser,
  type TurnProgressKind,
  type TurnProgressFacts,
} from "../agent/turn-progress.js";

/**
 * PROGRESS MESSAGES: what a running turn tells the person while it works (agent/turn-progress.ts).
 * A long turn showed its plan and its steps only as a step list and a status line that kept being
 * replaced; it now posts the plan and each finished step as messages of their own, in order, worded
 * by a fast model when it is quick and from fixed sentences when it is not.
 */
const STEPS = [
  { id: "s1", description: "HTML bar chart of the six months", agent: "chart_designer" },
  { id: "s2", description: "One-page Word report (.docx) with three findings", agent: "content_writer" },
];
const PLAN: TurnProgressFacts = { kind: "plan", revised: false, steps: STEPS };
const STEP_DONE: TurnProgressFacts = {
  kind: "step",
  step: STEPS[0]!,
  position: 1,
  total: 2,
  outcome: "done",
  result: "The chart shows June at 27,600 EUR, the highest month.",
  files: ["sales-chart.html"],
  running: [],
  next: STEPS[1]!,
};
const BRIDGE: TurnProgressFacts = { kind: "bridge", request: "What's on my calendar tomorrow?", reachingFor: ["calendar_list_events"] };

describe("the fixed wording", () => {
  it("lists the plan and says, per step, what is done, what runs now and what is next", () => {
    expect(fixedProgressText(PLAN, "English")).toBe(
      "Here's my plan:\n1. HTML bar chart of the six months (chart_designer)\n2. One-page Word report (.docx) with three findings (content_writer)",
    );
    expect(fixedProgressText(STEP_DONE, "English")).toBe(
      "Step 1 of 2 is done: HTML bar chart of the six months. Result: sales-chart.html. Next: One-page Word report (.docx) with three findings.",
    );
    expect(fixedProgressText({ ...STEP_DONE, next: undefined, running: [STEPS[1]!] }, "English"))
      .toContain("Now running: One-page Word report (.docx) with three findings.");
  });

  it("says when the plan is through, and what a failed step was", () => {
    const last: TurnProgressFacts = { ...STEP_DONE, step: STEPS[1]!, position: 2, files: undefined, next: undefined };
    expect(fixedProgressText(last, "English")).toBe(
      "Step 2 of 2 is done: One-page Word report (.docx) with three findings. All steps are through; I'm putting the answer together.",
    );
    const failed: TurnProgressFacts = { ...last, outcome: "failed", reason: "generate_docx was refused." };
    expect(fixedProgressText(failed, "English")).toBe(
      "Step 2 of 2 didn't work: One-page Word report (.docx) with three findings (generate_docx was refused). I'm working out how to deal with that.",
    );
  });

  it("is German for a German turn and English for every other language", () => {
    expect(fixedProgressText(PLAN, "German")).toMatch(/^So gehe ich vor:\n1\. HTML bar chart/);
    expect(fixedProgressText({ ...PLAN, revised: true }, "German")).toMatch(/^Ich habe den Plan angepasst:/);
    expect(fixedProgressText(STEP_DONE, "German")).toBe(
      "Schritt 1 von 2 ist erledigt: HTML bar chart of the six months. Ergebnis: sales-chart.html. Als Nächstes: One-page Word report (.docx) with three findings.",
    );
    expect(fixedProgressText(BRIDGE, "French")).toBe("Let me see which tools and specialists I need for this.");
  });
});

describe("what the model writes is taken only when it can be", () => {
  it("takes a short message, and puts the plan's list under the plan's line", () => {
    expect(acceptPhrasing(BRIDGE, "\"Let me check your calendar.\"")).toBe("Let me check your calendar.");
    expect(acceptPhrasing(PLAN, "Two steps, and here they are:")).toBe(
      "Two steps, and here they are:\n1. HTML bar chart of the six months (chart_designer)\n2. One-page Word report (.docx) with three findings (content_writer)",
    );
    expect(acceptPhrasing(STEP_DONE, "The chart is ready (sales-chart.html), June peaks at 27,600 EUR. Now the Word report."))
      .toContain("27,600");
  });

  it("takes a plan's first line only, so a model that writes the list out again does not show it twice", () => {
    const repeated = "Ich arbeite gerade an deinem Auftrag:\n1. HTML bar chart of the six months (chart_designer)\n2. One-page Word report (.docx) with three findings (content_writer)";
    const taken = acceptPhrasing(PLAN, repeated)!;
    expect(taken.split("\n")[0]).toBe("Ich arbeite gerade an deinem Auftrag:");
    expect(taken.match(/HTML bar chart/g)).toHaveLength(1);
  });

  it("refuses a number the facts do not hold, markup, a reasoning block, a second paragraph or a long text", () => {
    expect(acceptPhrasing(STEP_DONE, "The chart is ready; sales grew 42% overall.")).toBeNull();
    expect(acceptPhrasing(BRIDGE, "<think>hm</think> Let me check.")).toBeNull();
    expect(acceptPhrasing(BRIDGE, "```\nLet me check.\n```")).toBeNull();
    expect(acceptPhrasing(STEP_DONE, "Done.\n\nNow the report.")).toBeNull();
    expect(acceptPhrasing(BRIDGE, `Let me check ${"very ".repeat(40)}carefully.`)).toBeNull();
    expect(acceptPhrasing(BRIDGE, "   ")).toBeNull();
  });

  it("asks in the person's language, with only the facts", () => {
    const [system, user] = phrasingMessages(STEP_DONE, "German");
    expect(system!.content).toContain("Write in German.");
    expect(user!.content).toContain("Step 1 of 2 finished: HTML bar chart of the six months");
    expect(user!.content).toContain("Next: One-page Word report");
  });

  it("names a delegation by its specialist, each target once", () => {
    expect(progressBridgeTargets([
      { name: "delegate_to_agent", arguments: { agentName: "researcher" } },
      { name: "web_search", arguments: {} },
      { name: "web_search" },
    ])).toEqual(["delegate_to_agent (researcher)", "web_search"]);
  });
});

describe("the reporter", () => {
  let delivered: Array<{ kind: string; text: string }>;
  const deliver = (message: { kind: TurnProgressKind; text: string }) => {
    delivered.push(message);
    return { id: `m${delivered.length}` };
  };
  beforeEach(() => { delivered = []; });
  afterEach(() => { vi.useRealTimers(); });

  it("sends the messages in the order they were reported, however long each one's wording takes", async () => {
    const delays: Record<string, number> = { plan: 30, step: 0 };
    const phrase: ProgressPhraser = async (facts) => {
      await new Promise((resolve) => setTimeout(resolve, delays[facts.kind] ?? 0));
      return facts.kind === "plan" ? "My plan:\n1. a" : "Chart done.";
    };
    const reporter = createTurnProgressReporter({ deliver, language: "English", phrase, phrasingTimeoutMs: 1_000, bridgeDelayMs: 0 });
    reporter.report(PLAN);
    reporter.report(STEP_DONE);
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    await reporter.close();
    expect(delivered).toEqual([{ kind: "plan", text: "My plan:\n1. a" }, { kind: "step", text: "Chart done." }]);
  });

  it("sends the fixed wording when the model is too slow, fails or writes something unusable", async () => {
    const reporter = createTurnProgressReporter({
      deliver,
      language: "English",
      phrase: (facts, _fixed, _language, signal) => new Promise((resolve, reject) => {
        if (facts.kind === "plan") signal.addEventListener("abort", () => reject(new Error("aborted")));
        else if (facts.kind === "step") reject(new Error("model down"));
        else resolve(null);
      }),
      phrasingTimeoutMs: 20,
      bridgeDelayMs: 0,
    });
    reporter.report(PLAN);
    reporter.report(STEP_DONE);
    reporter.report(BRIDGE);
    await reporter.close();
    expect(delivered.map((m) => m.text)).toEqual([
      fixedProgressText(PLAN, "English"),
      fixedProgressText(STEP_DONE, "English"),
      fixedProgressText(BRIDGE, "English"),
    ]);
  });

  it("at the turn's end sends what is still waiting in its fixed wording, before it returns", async () => {
    let asked = 0;
    const reporter = createTurnProgressReporter({
      deliver,
      language: "English",
      phrase: (_facts, _fixed, _language, signal) => new Promise((_resolve, reject) => {
        asked += 1;
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
      phrasingTimeoutMs: 60_000,
      bridgeDelayMs: 0,
    });
    reporter.report(PLAN);
    await vi.waitFor(() => expect(asked).toBe(1));
    reporter.report(STEP_DONE);
    await reporter.close();
    // The plan's wording was cut off; the step behind it was never sent to the model.
    expect(asked).toBe(1);
    expect(delivered.map((m) => m.text)).toEqual([fixedProgressText(PLAN, "English"), fixedProgressText(STEP_DONE, "English")]);
    reporter.report(STEP_DONE);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(delivered).toHaveLength(2);
  });

  it("holds the bridge line back, sends it once, and drops it when the plan or the turn's end comes first", async () => {
    vi.useFakeTimers();
    const quick = createTurnProgressReporter({ deliver, language: "English", phrasingTimeoutMs: 1_000, bridgeDelayMs: 2_500 });
    quick.scheduleBridge({ ...BRIDGE, kind: "bridge" });
    await vi.advanceTimersByTimeAsync(1_000);
    await quick.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(delivered).toEqual([]);

    const planned = createTurnProgressReporter({ deliver, language: "English", phrasingTimeoutMs: 1_000, bridgeDelayMs: 2_500 });
    planned.scheduleBridge({ ...BRIDGE, kind: "bridge" });
    planned.report(PLAN);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(delivered.map((m) => m.kind)).toEqual(["plan"]);

    delivered = [];
    const slow = createTurnProgressReporter({ deliver, language: "English", phrasingTimeoutMs: 1_000, bridgeDelayMs: 2_500 });
    slow.scheduleBridge({ ...BRIDGE, kind: "bridge" });
    slow.scheduleBridge({ ...BRIDGE, kind: "bridge" });
    await vi.advanceTimersByTimeAsync(3_000);
    slow.scheduleBridge({ ...BRIDGE, kind: "bridge" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(delivered.map((m) => m.kind)).toEqual(["bridge"]);
  });

  it("posts nothing more once the turn is stopped", async () => {
    const turn = new AbortController();
    const reporter = createTurnProgressReporter({ deliver, language: "English", phrasingTimeoutMs: 1_000, bridgeDelayMs: 0, signal: turn.signal });
    reporter.report(PLAN);
    await new Promise((resolve) => setTimeout(resolve, 5));
    turn.abort();
    reporter.report(STEP_DONE);
    await reporter.close();
    expect(delivered.map((m) => m.kind)).toEqual(["plan"]);
  });
});

/**
 * MILESTONES: a turn without a plan, or a coordinator that records none, tells where it is by its
 * specialists coming back. Held back until the turn has run a while, gathered when they come back
 * close together, with who is still working, and never after the turn's end.
 */
describe("milestones", () => {
  let delivered: Array<{ kind: string; text: string }>;
  const deliver = (message: { kind: TurnProgressKind; text: string }) => {
    delivered.push(message);
    return { id: `m${delivered.length}` };
  };
  const finish = (agent: string, extra: Record<string, unknown> = {}): TurnProgressFacts => ({ kind: "milestone", finished: [{ agent, outcome: "done", ...extra }] });
  beforeEach(() => { delivered = []; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("are worded with who finished, what it made, and who is still working", () => {
    expect(fixedProgressText({ kind: "milestone", finished: [{ agent: "researcher", outcome: "done", files: ["notes.md"] }], running: ["content_writer"] }, "English"))
      .toBe("researcher is done (notes.md). Still working: content_writer.");
    expect(fixedProgressText({ kind: "milestone", finished: [{ agent: "researcher", outcome: "done" }, { agent: "browser_agent", outcome: "failed" }], running: [] }, "German"))
      .toBe("researcher ist fertig; browser_agent kam nicht durch.");
  });

  it("come from a delegation a specialist answered, not one refused before any ran or served from the turn's own findings", () => {
    expect(delegationMilestone({ success: true, output: "Found 3 sources.", metadata: { agentName: "researcher", artifacts: [{ path: "generated/notes.md" }] } }))
      .toEqual({ kind: "milestone", finished: [{ agent: "researcher", outcome: "done", result: "Found 3 sources.", files: ["notes.md"] }] });
    expect(delegationMilestone({ success: false, error: "timed out", metadata: { agentName: "browser_agent" } }))
      .toEqual({ kind: "milestone", finished: [{ agent: "browser_agent", outcome: "failed", result: "timed out" }] });
    expect(delegationMilestone({ success: false, error: "budget exhausted", metadata: {} })).toBeNull();
    expect(delegationMilestone({ success: true, output: "x", metadata: { agentName: "researcher", reusedFromSessionMemory: true } })).toBeNull();
  });

  it("wait until the turn has run a while, and gather the finishes that come close together", async () => {
    const reporter = createTurnProgressReporter({ deliver, language: "English", phrasingTimeoutMs: 1_000, bridgeDelayMs: 0, milestoneAfterMs: 20_000, milestoneGapMs: 15_000 });
    reporter.noteSpecialist({ agentName: "researcher", kind: "started" });
    reporter.noteSpecialist({ agentName: "image_creator", kind: "started" });
    reporter.noteSpecialist({ agentName: "content_writer", kind: "started" });
    await vi.advanceTimersByTimeAsync(5_000);
    reporter.noteSpecialist({ agentName: "researcher", kind: "completed" });
    reporter.report(finish("researcher"));
    await vi.advanceTimersByTimeAsync(10_000);
    // A quick lookup's turn would have ended by now: nothing was told before 20 s.
    expect(delivered).toEqual([]);
    reporter.noteSpecialist({ agentName: "image_creator", kind: "completed" });
    reporter.report(finish("image_creator", { files: ["harbour.png"] }));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(delivered.map((m) => m.text)).toEqual(["researcher is done; image_creator is done (harbour.png). Still working: content_writer."]);

    // The next finish waits out the gap after that message.
    reporter.noteSpecialist({ agentName: "content_writer", kind: "completed" });
    reporter.report(finish("content_writer"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(delivered).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(delivered.at(-1)!.text).toBe("content_writer is done.");
    await reporter.close();
  });

  it("tell a second run of the same specialist as still working when the first comes back", async () => {
    const reporter = createTurnProgressReporter({ deliver, language: "English", phrasingTimeoutMs: 1_000, bridgeDelayMs: 0, milestoneAfterMs: 0, milestoneGapMs: 0 });
    reporter.noteSpecialist({ agentName: "researcher", kind: "started" });
    reporter.noteSpecialist({ agentName: "researcher", kind: "started" });
    reporter.noteSpecialist({ agentName: "researcher", kind: "completed" });
    reporter.report(finish("researcher"));
    await vi.advanceTimersByTimeAsync(10);
    expect(delivered.map((m) => m.text)).toEqual(["researcher is done. Still working: researcher."]);
    await reporter.close();
  });

  it("are not told once the turn ends: the answer comes next", async () => {
    const reporter = createTurnProgressReporter({ deliver, language: "English", phrasingTimeoutMs: 1_000, bridgeDelayMs: 0, milestoneAfterMs: 20_000, milestoneGapMs: 15_000 });
    reporter.report(finish("researcher"));
    await vi.advanceTimersByTimeAsync(5_000);
    await reporter.close();
    await vi.advanceTimersByTimeAsync(30_000);
    reporter.report(finish("content_writer"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(delivered).toEqual([]);
  });
});

/**
 * STILL ON IT: a specialist working alone for minutes left the chat silent between the first line
 * and the answer (two minutes in the lab). After a quiet minute the turn says who is working and
 * what they just did, a few times at most.
 */
describe("still on it", () => {
  let delivered: Array<{ kind: string; text: string }>;
  const deliver = (message: { kind: TurnProgressKind; text: string }) => {
    delivered.push(message);
    return { id: `m${delivered.length}` };
  };
  beforeEach(() => { delivered = []; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const make = () => createTurnProgressReporter({
    deliver, language: "English", phrasingTimeoutMs: 1_000, bridgeDelayMs: 0,
    workingAfterMs: 60_000, maxWorking: 2, isCoordinator: (agent) => agent.endsWith("_coordinator"),
  });

  it("says after a quiet minute who is working and their latest action, and stops at the most allowed", async () => {
    const reporter = make();
    reporter.noteSpecialist({ agentName: "mission_coordinator", kind: "started" });
    reporter.noteSpecialist({ agentName: "researcher", kind: "started" });
    reporter.noteSpecialist({ agentName: "researcher", kind: "tool_start", toolName: "web_fetch" });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    // The coordinator hands out the work: the one doing it is named.
    expect(delivered.map((m) => m.text)).toEqual(["Still on it: researcher is reading a web page."]);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(delivered).toHaveLength(2);
    await reporter.close();
  });

  it("counts the quiet from the last message, and says nothing while nobody works", async () => {
    const reporter = make();
    reporter.noteSpecialist({ agentName: "researcher", kind: "started" });
    await vi.advanceTimersByTimeAsync(40_000);
    reporter.report({ kind: "plan", revised: false, steps: STEPS });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(delivered.map((m) => m.kind)).toEqual(["plan"]);
    reporter.noteSpecialist({ agentName: "researcher", kind: "completed" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(delivered.map((m) => m.kind)).toEqual(["plan"]);
    await reporter.close();
  });

  it("names the coordinator when it is the only one working", () => {
    expect(fixedProgressText({ kind: "working", working: [{ agent: "mission_coordinator" }], elapsedSeconds: 70 }, "German"))
      .toBe("Ich bin noch dran: mission_coordinator arbeitet.");
    expect(fixedProgressText({ kind: "working", working: [{ agent: "researcher", doing: "web_fetch" }, { agent: "chart_designer", doing: "generate_chart_html" }, { agent: "coder", doing: "mcp__custom_tool" }], elapsedSeconds: 75 }, "German"))
      .toBe("Ich bin noch dran: researcher liest eine Webseite; chart_designer zeichnet ein Diagramm; coder arbeitet.");
  });
});

describe("a milestone under a coordinator", () => {
  it("does not name the coordinator as still working while it hands out the work", async () => {
    vi.useFakeTimers();
    const delivered: string[] = [];
    const reporter = createTurnProgressReporter({
      deliver: (message) => { delivered.push(message.text); }, language: "English", phrasingTimeoutMs: 1_000, bridgeDelayMs: 0,
      milestoneAfterMs: 0, milestoneGapMs: 0, isCoordinator: (agent) => agent.endsWith("_coordinator"),
    });
    reporter.noteSpecialist({ agentName: "mission_coordinator", kind: "started" });
    reporter.noteSpecialist({ agentName: "researcher", kind: "started" });
    reporter.noteSpecialist({ agentName: "chart_designer", kind: "started" });
    reporter.noteSpecialist({ agentName: "researcher", kind: "completed" });
    reporter.report({ kind: "milestone", finished: [{ agent: "researcher", outcome: "done" }] });
    await vi.advanceTimersByTimeAsync(10);
    expect(delivered).toEqual(["researcher is done. Still working: chart_designer."]);
    await reporter.close();
    vi.useRealTimers();
  });
});
