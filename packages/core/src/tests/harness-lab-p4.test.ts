import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { harnessFingerprint, readNightlyState, readRunId, ReplayCache, writeNightlyState, writeRunId } from "../harness-lab/replay.js";
import { createPacer, LabBudgetSpent, lastLiveMessageAt, parseDuration } from "../harness-lab/yield.js";
import { coversChange, emitProposal, LAB_ASSISTANT_AGENT, pendingLabTargets, supersedeCoveredProposals } from "../harness-lab/proposal.js";
import { createConversationConfigProposal, getConversationConfigProposal, type ConversationPromptChange } from "../agent/config-assistant-proposals.js";
import { runCycle, DEFAULT_CYCLE, type CycleDeps } from "../harness-lab/cycle.js";
import type { GateDecision } from "../harness-lab/gate.js";
import type { HarnessTask } from "../harness-lab/task-schema.js";
import type { LabRunRecord } from "../harness-lab/turn-runner.js";

/**
 * The lab's nightly operation (P4): a run goes on where a spent budget stopped it, gives way to live
 * use, and does not propose again what a pending proposal already answers.
 */

const dirs: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("going on with an earlier run", () => {
  it("serves what a step recorded, and runs it only once", async () => {
    const out = tmp("lab-replay-");
    let runs = 0;
    const step = async () => { runs += 1; return { reply: `run ${runs}` }; };
    const first = new ReplayCache(out, "fp");
    expect(await first.through("attempt", { task: "t", attempt: 1 }, step)).toEqual({ reply: "run 1" });
    const second = new ReplayCache(out, "fp");
    expect(await second.through("attempt", { task: "t", attempt: 1 }, step)).toEqual({ reply: "run 1" });
    expect(await second.through("attempt", { task: "t", attempt: 2 }, step)).toEqual({ reply: "run 2" });
    expect(runs).toBe(2);
    expect(second.stats).toEqual({ served: 1, recorded: 1 });
  });

  it("serves nothing recorded against other prompts", async () => {
    const out = tmp("lab-replay-");
    await new ReplayCache(out, harnessFingerprint({ main_assistant: "A." })).through("call", "k", async () => "old");
    expect(await new ReplayCache(out, harnessFingerprint({ main_assistant: "A. And a rule applied since." })).through("call", "k", async () => "new")).toBe("new");
    // The order of the prompts does not matter, their text does.
    expect(harnessFingerprint({ a: "1", b: "2" })).toBe(harnessFingerprint({ b: "2", a: "1" }));
  });

  it("records nothing for a step that threw, and reads a torn record as a miss", async () => {
    const out = tmp("lab-replay-");
    const cache = new ReplayCache(out, "fp");
    await expect(cache.through("attempt", "k", async () => { throw new LabBudgetSpent(1); })).rejects.toBeInstanceOf(LabBudgetSpent);
    expect(readdirSync(join(out, "replay"))).toEqual([]);
    await cache.through("attempt", "k2", async () => "whole");
    const [file] = readdirSync(join(out, "replay"));
    writeFileSync(join(out, "replay", file!), '{"value": "cut sh', "utf8");
    expect(await new ReplayCache(out, "fp").through("attempt", "k2", async () => "again")).toBe("again");
  });

  it("keeps the run's id and the nightly state", () => {
    const out = tmp("lab-run-");
    expect(readRunId(out)).toBeNull();
    writeRunId(out, "run-1");
    writeRunId(out, "run-2");
    expect(readRunId(out)).toBe("run-1");
    const root = tmp("lab-nightly-");
    expect(readNightlyState(root)).toEqual({});
    writeNightlyState(root, { unfinished: out, pausedAt: "2026-10-22T03:00:00.000Z" });
    expect(readNightlyState(root)).toEqual({ unfinished: out, pausedAt: "2026-10-22T03:00:00.000Z" });
  });
});

describe("giving way to live use", () => {
  const row = (type: string, timestamp: string) => `${JSON.stringify({ id: "x", timestamp, type, data: {} })}\n`;

  it("reads the newest message_received from the end of the live log", () => {
    const log = join(tmp("lab-audit-"), "audit.jsonl");
    expect(lastLiveMessageAt(log)).toBeNull();
    writeFileSync(log, `ived","timestamp":"2026-10-22T02:59:00.000Z"}\n`, "utf8");
    appendFileSync(log, row("message_received", "2026-10-22T02:00:00.000Z"));
    appendFileSync(log, row("message_received", "2026-10-22T02:40:00.000Z"));
    // Batched sinks write out of order: a later line can carry an older time.
    appendFileSync(log, row("message_received", "2026-10-22T02:10:00.000Z"));
    appendFileSync(log, row("turn_scorecard", "2026-10-22T02:50:00.000Z"));
    // Another event that only mentions the type in its data is not a message.
    appendFileSync(log, `${JSON.stringify({ id: "y", timestamp: "2026-10-22T02:55:00.000Z", type: "guardrail_flagged", data: { after: "message_received" } })}\n`);
    expect(lastLiveMessageAt(log)).toBe(Date.parse("2026-10-22T02:40:00.000Z"));
  });

  it("waits while someone wrote within the quiet window, and goes on once it is quiet", async () => {
    const log = join(tmp("lab-audit-"), "audit.jsonl");
    writeFileSync(log, row("message_received", "2026-10-22T03:00:00.000Z"), "utf8");
    let clock = Date.parse("2026-10-22T03:02:00.000Z");
    const slept: number[] = [];
    const pacer = createPacer({ auditFile: log, quietWindowMs: 10 * 60_000, pollMs: 60_000, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } });
    await pacer.beforeAttempt();
    expect(slept).toHaveLength(8);
    expect(clock).toBe(Date.parse("2026-10-22T03:10:00.000Z"));
    expect(pacer.stats).toEqual({ waits: 1, waitedMs: 8 * 60_000 });
    // Quiet now: the next attempt starts at once.
    await pacer.beforeAttempt();
    expect(slept).toHaveLength(8);
  });

  it("stops before a new attempt once the budget is spent, also while it waits", async () => {
    let clock = 0;
    const spent = createPacer({ quietWindowMs: 0, budgetMs: 60_000, now: () => clock });
    await spent.beforeAttempt();
    clock = 60_000;
    await expect(spent.beforeAttempt()).rejects.toBeInstanceOf(LabBudgetSpent);

    const log = join(tmp("lab-audit-"), "audit.jsonl");
    writeFileSync(log, row("message_received", new Date(0).toISOString()), "utf8");
    clock = 0;
    const busy = createPacer({ auditFile: log, quietWindowMs: 10 * 60_000, budgetMs: 3 * 60_000, now: () => clock, sleep: async (ms) => { clock += ms; } });
    await expect(busy.beforeAttempt()).rejects.toBeInstanceOf(LabBudgetSpent);
  });

  it("reads durations", () => {
    expect(parseDuration("4h")).toBe(4 * 3_600_000);
    expect(parseDuration("90m")).toBe(90 * 60_000);
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("30")).toBe(30 * 60_000);
    expect(parseDuration("soon")).toBeNull();
  });
});

describe("a task a pending proposal answers", () => {
  const task = (id: string): HarnessTask => ({ id, title: id, origin: "manual", tags: [], domain: "general", role: "both", requires: [], turns: [{ message: `Handle ${id}.` }] });
  const failed = (taskId: string, arm: string, attempt: number): LabRunRecord => ({
    taskId, arm, attempt, sessionId: `${taskId}-${attempt}`, durationMs: 1, stubbedCalls: [],
    turns: [{ message: `Handle ${taskId}.`, status: "ok", reply: "x", durationMs: 1, toolCalls: [], events: [], artifacts: [], checkFailures: ["a check failed"], checked: true }],
  });

  it("is not taken as a target by the screen", async () => {
    const logged: string[] = [];
    const deps: CycleDeps = {
      runAttempt: async (t, arm, attempt) => failed(t.id, arm.name, attempt),
      complete: async () => JSON.stringify({ keepBase: true, reason: "nothing to change" }),
      basePrompts: () => ({ main_assistant: "Base." }),
      log: (line) => logged.push(line),
    };
    const result = await runCycle([task("answered"), task("open")], { ...DEFAULT_CYCLE, skipTargets: new Map([["answered", "has a pending lab proposal (p1): decide on it first"]]) }, deps);
    expect(result.targets).toEqual(["open"]);
    expect(logged).toContain("not a target: answered has a pending lab proposal (p1): decide on it first");
  });
});

describe("pending lab proposals", () => {
  const RULE = "Diagram requests (Mermaid, flowcharts, sequence diagrams) go to diagram_designer, which owns generate_mermaid_diagram.";
  const SAME_RULE = "Send every Mermaid, flowchart or sequence diagram request to diagram_designer: it owns generate_mermaid_diagram.";
  const OTHER_RULE = "When a mail search finds nothing, say which mailbox and which time range were searched.";
  const append = (prompt: string, agentName = "main_assistant"): ConversationPromptChange => ({ agentName, strategy: "append", prompt, rationale: "r" });
  const file = (ws: string, changes: ConversationPromptChange[], tags: string[] = [], assistantAgent = LAB_ASSISTANT_AGENT) => createConversationConfigProposal(ws, {
    status: "pending", mode: "prompt", request: "r", summary: "s", assistantAgent, configChanges: [], promptChanges: changes, validations: [], tags: ["harness-lab", ...tags],
  });

  it("covers an older change that says the same in other words, or replaces the same prompt version", () => {
    expect(coversChange([append(SAME_RULE)], append(RULE))).toBe(true);
    expect(coversChange([append(OTHER_RULE)], append(RULE))).toBe(false);
    expect(coversChange([append(SAME_RULE, "researcher")], append(RULE))).toBe(false);
    const replace = (prompt: string, baseSha256: string): ConversationPromptChange => ({ agentName: "coder", strategy: "replace", prompt, rationale: "r", baseSha256 });
    expect(coversChange([replace("v3", "base-1")], replace("v2", "base-1"))).toBe(true);
    expect(coversChange([replace("v3", "base-2")], replace("v2", "base-1"))).toBe(false);
  });

  it("supersedes an older pending lab proposal the new one covers, and no other", () => {
    const ws = tmp("lab-proposals-");
    const covered = file(ws, [append(RULE)]);
    const unrelated = file(ws, [append(OTHER_RULE)]);
    const human = file(ws, [append(RULE)], [], "config_assistant");
    const newer = file(ws, [append(`${SAME_RULE}\n${OTHER_RULE.replace("nothing", "no mail")}`)]);
    expect(supersedeCoveredProposals(ws, newer).sort()).toEqual([covered.id, unrelated.id].sort());
    expect(getConversationConfigProposal(ws, covered.id)).toMatchObject({ status: "rejected", tags: expect.arrayContaining([`superseded-by:${newer.id}`]) });
    expect(getConversationConfigProposal(ws, covered.id)!.feedbackHistory.at(-1)!.notes).toMatch(/Superseded by harness-lab proposal/);
    // A proposal the config assistant made for a person is never the lab's to retire.
    expect(getConversationConfigProposal(ws, human.id)!.status).toBe("pending");
    expect(getConversationConfigProposal(ws, newer.id)!.status).toBe("pending");
  });

  it("leaves a pending lab proposal alone when the new one covers only part of it", () => {
    const ws = tmp("lab-proposals-");
    const both = file(ws, [append(`${RULE}\n${OTHER_RULE}`)]);
    const newer = file(ws, [append(SAME_RULE)]);
    expect(supersedeCoveredProposals(ws, newer)).toEqual([]);
    expect(getConversationConfigProposal(ws, both.id)!.status).toBe("pending");
  });

  it("names the tasks it was won on, and those tasks are skipped while it is pending", () => {
    const ws = tmp("lab-proposals-");
    const gate = {
      verdict: "accept", evidence: "deterministic", reasons: [], unscoredRate: 0, signTestP: null,
      tallies: [
        { taskId: "e2e.mermaid", role: "target", wins: 3, losses: 0, ties: 0, unscored: 0, selectorWins: 0, selectorLosses: 0 },
        { taskId: "e2e.docx", role: "guard", wins: 0, losses: 0, ties: 3, unscored: 0, selectorWins: 0, selectorLosses: 0 },
      ],
    } as unknown as GateDecision;
    const edit = { id: "INV-1", editor: "INV", op: "append_rule", target: "main_assistant", scope: "procedure", text: RULE, moment: "M2", why: "w" } as const;
    const emitted = emitProposal({ liveWorkspacePath: ws, runId: "r1", basePrompts: { main_assistant: "Base." }, edits: [edit], composerRows: [], gate });
    expect(emitted).toMatchObject({ proposal: { tags: expect.arrayContaining(["task:e2e.mermaid"]) }, superseded: [] });
    expect((emitted as { proposal: { tags: string[] } }).proposal.tags).not.toContain("task:e2e.docx");
    expect([...pendingLabTargets(ws).keys()]).toEqual(["e2e.mermaid"]);
  });
});
