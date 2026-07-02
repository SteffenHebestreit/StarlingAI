import { describe, expect, it } from "vitest";
import { taskGraphResultIsFailure } from "../agent/runtime.js";
import { extendDeadlineForDelegationWait, DELEGATION_WAIT_CEILING_MS } from "../agent/delegation-budget.js";
import { clampSubAgentTimeoutToRemaining } from "../agent/sub-agent.js";
import { shouldWarnLowEffortBigPlan } from "../tools/turn-plan-tool.js";
import { runWithEffortContext, effectiveSubAgentTurnSloMs } from "../runtime/effort-context.js";

// Structural decision helpers behind the run e3cf6c22 fixes (a low-effort deep-research + paper +
// slides + notes mission that timed out, then back-filled a fabricated "verified" paper).

describe("D2 — taskGraphResultIsFailure (run_task_graph failure visibility)", () => {
  it("is a failure when any node failed", () => {
    expect(taskGraphResultIsFailure({ completed: ["research"], failed: ["paper"], blocked: [] })).toBe(true);
  });
  it("is a failure when any node was blocked (by a failed dependency)", () => {
    expect(taskGraphResultIsFailure({ completed: ["research"], failed: [], blocked: ["slides", "notes"] })).toBe(true);
  });
  it("is NOT a failure for a fully successful graph", () => {
    expect(taskGraphResultIsFailure({ completed: ["a", "b"], failed: [], blocked: [] })).toBe(false);
  });
  it("is NOT a failure for a non-graph result (no completed array) — scopes to genuine graphs", () => {
    expect(taskGraphResultIsFailure({ delegationOutcome: "failure" })).toBe(false); // a delegate result, not a graph
    expect(taskGraphResultIsFailure({})).toBe(false);
  });
});

describe("D3 — clampSubAgentTimeoutToRemaining (parent-remaining-budget clamp)", () => {
  const now = 1_000_000;
  it("clamps a sub-agent budget down to the parent's remaining time", () => {
    // Parent has 90s left; the sub-agent's own resolved budget is 600s → clamp to 90s.
    expect(clampSubAgentTimeoutToRemaining(600_000, now + 90_000, now)).toBe(90_000);
  });
  it("never RAISES a budget that is already under the remaining time", () => {
    // Sub-agent wants 45s, parent has 90s left → keep 45s (a clamp only reduces).
    expect(clampSubAgentTimeoutToRemaining(45_000, now + 90_000, now)).toBe(45_000);
  });
  it("applies the floor so a nearly-exhausted turn still gives a chance to synthesize", () => {
    // Only 5s left, but the floor is 30s → the specialist gets 30s (parent signal still caps wall-clock).
    expect(clampSubAgentTimeoutToRemaining(600_000, now + 5_000, now)).toBe(30_000);
    // Deadline already passed → still the floor, never negative/zero.
    expect(clampSubAgentTimeoutToRemaining(600_000, now - 10_000, now)).toBe(30_000);
  });
  it("passes through unchanged with no deadline or an unbounded (0) budget", () => {
    expect(clampSubAgentTimeoutToRemaining(600_000, undefined, now)).toBe(600_000);
    expect(clampSubAgentTimeoutToRemaining(0, now + 90_000, now)).toBe(0); // 0 = unbounded, left alone
  });
});

describe("D5 — extendDeadlineForDelegationWait (exclude child-wait from the turn budget)", () => {
  const base = 1_000_000;
  const ceiling = base + 600_000; // 10 min out
  it("pushes the deadline out by the delegation-wait duration", () => {
    expect(extendDeadlineForDelegationWait(base, 48_000, ceiling)).toBe(base + 48_000);
  });
  it("accumulates across successive delegations (caller passes the updated deadline)", () => {
    const after1 = extendDeadlineForDelegationWait(base, 30_000, ceiling);
    const after2 = extendDeadlineForDelegationWait(after1, 30_000, ceiling);
    expect(after2).toBe(base + 60_000);
  });
  it("never pushes past the absolute ceiling (hung/unbounded child can't run forever)", () => {
    expect(extendDeadlineForDelegationWait(base, 5_000_000, ceiling)).toBe(ceiling);
  });
  it("leaves the deadline unchanged for a non-positive wait", () => {
    expect(extendDeadlineForDelegationWait(base, 0, ceiling)).toBe(base);
    expect(extendDeadlineForDelegationWait(base, -100, ceiling)).toBe(base);
  });
  it("exposes a 30-minute default ceiling constant", () => {
    expect(DELEGATION_WAIT_CEILING_MS).toBe(1_800_000);
  });
});

describe("D5a — effort-scaled leaf child budget", () => {
  it("a LOW-effort child gets a short (90s) default budget, not the flat 600s", () => {
    expect(runWithEffortContext("low", () => effectiveSubAgentTurnSloMs())).toBe(90_000);
  });
  it("a HIGH-effort child keeps a long (600s) budget", () => {
    expect(runWithEffortContext("high", () => effectiveSubAgentTurnSloMs())).toBe(600_000);
  });
});

describe("D4 — shouldWarnLowEffortBigPlan (upfront doomed-plan advisory)", () => {
  it("warns for a high-risk, 3+-delegate plan at LOW effort (the e3cf6c22 shape)", () => {
    expect(shouldWarnLowEffortBigPlan("low", "high", 4)).toBe(true);
    expect(shouldWarnLowEffortBigPlan("low", "high", 3)).toBe(true);
  });
  it("does NOT warn when any structural condition is missing", () => {
    expect(shouldWarnLowEffortBigPlan("low", "high", 2)).toBe(false);   // too few delegate steps
    expect(shouldWarnLowEffortBigPlan("low", "low", 4)).toBe(false);    // not high risk
    expect(shouldWarnLowEffortBigPlan("high", "high", 4)).toBe(false);  // enough budget
    expect(shouldWarnLowEffortBigPlan("medium", "high", 4)).toBe(false);
    expect(shouldWarnLowEffortBigPlan(undefined, "high", 4)).toBe(false);
  });
});
