import { describe, expect, it } from "vitest";
import { runCycle, DEFAULT_CYCLE, type CycleDeps } from "../harness-lab/cycle.js";
import type { LabArm } from "../harness-lab/arm.js";
import type { HarnessTask } from "../harness-lab/task-schema.js";
import type { LabRunRecord } from "../harness-lab/turn-runner.js";

/**
 * A whole lab cycle on stubbed turns and a stubbed model: the screen finds the failing task, the INV
 * editor's rule fixes it in its probes, the composer keeps it, the paired comparison wins, and the
 * gate decides on the targets and the guard set.
 */

const RULE = "State every total you computed, with its unit.";

function task(id: string, role: HarnessTask["role"]): HarnessTask {
  return { id, title: id, origin: "manual", tags: [], domain: "general", role, requires: [], turns: [{ message: `Please handle request ${id}.` }] };
}

function run(taskId: string, arm: LabArm, attempt: number, failures: string[]): LabRunRecord {
  return {
    taskId, arm: arm.name, attempt, sessionId: `${taskId}-${arm.name}-${attempt}`, durationMs: 1, stubbedCalls: [],
    turns: [{
      message: `Please handle request ${taskId}.`, status: "ok", reply: failures.length ? "Here it is." : "Total: 12 kg.", durationMs: 1,
      toolCalls: [], events: [], artifacts: [], checkFailures: failures, checked: true,
    }],
  };
}

function deps(opts: { guardRegresses?: boolean; secondProbeBreaks?: boolean } = {}): CycleDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    basePrompts: () => ({ main_assistant: "Answer in the user's language.", researcher: "You research." }),
    log: () => undefined,
    runAttempt: async (t, arm, attempt) => {
      const withRule = arm.mainAssistantInstructions?.includes(RULE) === true;
      calls.push(`${t.id}:${arm.name}:${attempt}`);
      if (t.id === "t-fail") {
        // The rule fixes the first probe and breaks the second: nothing delivered at all.
        if (withRule && opts.secondProbeBreaks && attempt === 2) {
          const broken = run(t.id, arm, attempt, []);
          broken.turns[0]!.reply = "";
          return broken;
        }
        return run(t.id, arm, attempt, withRule ? [] : ["reply does not include \"total\""]);
      }
      if (t.id === "g1" && withRule && opts.guardRegresses) return run(t.id, arm, attempt, ["reply is in the wrong language"]);
      return run(t.id, arm, attempt, []);
    },
    complete: async (role, system, user) => {
      if (role === "editor") {
        return system.includes("You own HOW")
          ? JSON.stringify({ edits: [{ op: "append_rule", target: "main_assistant", scope: "completion", text: RULE, moment: "M2", why: "The reply named no total." }] })
          : JSON.stringify({ keepBase: true, reason: "the deliverable's shape was right" });
      }
      if (role === "composer") {
        const ids = [...new Set(user.match(/INV-[\w.-]+-\d+/g) ?? [])];
        return JSON.stringify({ rows: ids.map((id) => ({ decision: "kept", edit: id, evidence: "both probes delivered the total" })) });
      }
      return JSON.stringify({ criterion: "delivery", winner: "tie", reason: "same" });
    },
  };
}

const corpus = [task("t-fail", "both"), task("t-ok", "both"), task("g1", "guard"), task("g2", "guard")];

describe("a harness-lab cycle", () => {
  it("improves the failing task and passes the gate on deterministic evidence", async () => {
    const d = deps();
    const result = await runCycle(corpus, DEFAULT_CYCLE, d);
    expect(result.targets).toEqual(["t-fail"]);
    // A task that can be either and is not a target guards too.
    expect(result.guards).toEqual(["t-ok", "g1", "g2"]);
    const [work] = result.tasks;
    expect(work?.outcome).toBe("win");
    expect(work?.editors.map((e) => e.outcome.kind)).toEqual(["edits", "keep_base"]);
    expect(work?.composed?.rows.map((r) => r.decision)).toEqual(["kept"]);
    // The composer kept the INV candidate whole: its probes stand in for the composed harness.
    expect(d.calls.filter((c) => c.startsWith("t-fail:composed"))).toEqual([]);
    expect(result.merged.map((e) => e.text)).toEqual([RULE]);
    expect(result.gate).toMatchObject({ verdict: "accept", evidence: "deterministic" });
    // Guards that tied were run once; the target, which differed, three times.
    expect(d.calls.filter((c) => c.startsWith("g1:gate-candidate"))).toHaveLength(1);
    expect(d.calls.filter((c) => c.startsWith("t-fail:gate-candidate"))).toHaveLength(3);
    expect(result.health.editorValidEdits).toBe(1);
  });

  it("rejects the candidate when a guard regresses", async () => {
    const result = await runCycle(corpus, DEFAULT_CYCLE, deps({ guardRegresses: true }));
    expect(result.tasks[0]?.outcome).toBe("win");
    expect(result.gate?.verdict).toBe("reject");
    expect(result.gate?.reasons.join()).toMatch(/guard g1 lost/);
  });

  it("a candidate that wins one pair and loses another does not win its task", async () => {
    const result = await runCycle(corpus, DEFAULT_CYCLE, deps({ secondProbeBreaks: true }));
    expect(result.tasks[0]).toMatchObject({ outcome: "keep_base" });
    expect(result.tasks[0]?.reason).toMatch(/1 won, 1 lost/);
    expect(result.merged).toEqual([]);
  });

  it("keeps the base when no editor proposes anything", async () => {
    const d = deps();
    const keep: CycleDeps = { ...d, complete: async () => JSON.stringify({ keepBase: true, reason: "noise" }) };
    const result = await runCycle(corpus, DEFAULT_CYCLE, keep);
    expect(result.tasks[0]).toMatchObject({ outcome: "keep_base", reason: "both editors kept the base" });
    expect(result.merged).toEqual([]);
    expect(result.gate).toBeUndefined();
  });
});
