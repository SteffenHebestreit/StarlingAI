import { describe, expect, it } from "vitest";
import { isFanOut, stepOutcome, stepTitle, stepsFromToolCalls, type TurnStep } from "./turnSteps";

/**
 * A FOLDED record_plan IS A PLAN RUN (orchestration.planRoundFold, 2026-10-05).
 *
 * With the fold on, the runtime runs the recorded plan inside the record_plan call and hands back
 * execute_plan's report under record_plan's name. The row has to read like execute_plan's — how
 * many steps ran, how many failed — and its specialists' progress needs a row to land on, live and
 * after a reload.
 */
const PLAN_ARGS = {
  objective: "compare two recorders",
  steps: [
    { id: "s1", description: "research A", kind: "delegate" },
    { id: "s2", description: "research B", kind: "delegate" },
    { id: "s3", description: "summarise", kind: "direct" },
  ],
};

const step = (overrides: Partial<TurnStep>): TurnStep => ({
  id: "call_plan",
  kind: "tool",
  name: "record_plan",
  depth: 0,
  status: "done",
  startedAt: 0,
  args: PLAN_ARGS,
  ...overrides,
});

describe("turn steps — a folded record_plan", () => {
  it("is a progress host for the specialists its plan runs", () => {
    expect(isFanOut({ name: "record_plan" })).toBe(true);
    expect(isFanOut({ name: "execute_plan" })).toBe(true);
    expect(isFanOut({ name: "delegate_to_agent" })).toBe(false);
  });

  it("summarises the run like execute_plan, failed steps included", () => {
    const folded = step({ metadata: { stepCount: 3, riskTier: "low", planExecution: true, steps: 3, done: 2, failed: 1 } });
    expect(stepOutcome(folded)).toBe("2/3 done · 1 failed");
    expect(stepTitle(folded)).toBe("Planned and ran 3 steps");
  });

  it("keeps the planning summary for a record_plan that only recorded", () => {
    const recorded = step({ metadata: { stepCount: 3, riskTier: "low" } });
    expect(stepOutcome(recorded)).toBe("3 steps · risk low");
    expect(stepTitle(recorded)).toBe("Planned 3 steps");
  });

  it("reads the same after a reload from the transcript", () => {
    const [reloaded] = stepsFromToolCalls({
      id: "m1",
      toolCalls: [{
        name: "record_plan",
        args: PLAN_ARGS,
        result: "Plan recorded (3 steps, risk: low) and EXECUTED in this same call …",
        metadata: { stepCount: 3, riskTier: "low", planExecution: true, steps: 3, done: 3, failed: 0 },
      }],
    });
    expect(stepOutcome(reloaded!)).toBe("3/3 done");
  });
});
