import { describe, expect, it } from "vitest";
import { resolveDelegationCeilingMs, resolveSoftDeadlineOffsetMs, resolveTurnBudgetMs } from "../agent/sub-agent-turn-budget.js";

/**
 * The E18 wrap-up nudge must land BEFORE the hard deadline that will abort the run.
 *
 * The hard deadline is resolved in agent/sub-agent.ts as min(callerBudget, the agent's
 * own numeric turnTimeoutMs) — a caller budget is a ceiling, not a grant. The soft
 * deadline is derived here, in a different module, from what used to be only the caller
 * budget. Two derivations of the same quantity in two places is how they drifted: once
 * the hard side took the minimum, every agent declaring less than 0.7x the turn had a
 * soft deadline BEHIND its hard one, and the nudge silently never fired.
 *
 * These assert the ordering directly rather than the arithmetic, so the test fails if
 * either side moves.
 */
const DEFAULT_TURN_MS = 1_800_000; // gateway.turnTimeoutMs default, what rpc.ts passes down

describe("resolveTurnBudgetMs — a caller budget is a ceiling, not a grant", () => {
  it("takes the SMALLER of the caller's turn budget and the agent's own declaration", () => {
    // gateway/rpc.ts sets turnTimeoutOverrideMs on every turn, so without this an agent's
    // own turnTimeoutMs was overwritten on every delegated run and the knob was inert.
    expect(resolveTurnBudgetMs({ callerCeilingMs: DEFAULT_TURN_MS, agentTurnTimeout: 900_000 })).toBe(900_000);
    expect(resolveTurnBudgetMs({ callerCeilingMs: 300_000, agentTurnTimeout: 900_000 })).toBe(300_000);
  });

  it("leaves the EPHEMERAL path exactly where it always was", () => {
    // The precedence above was once justified as the fix for run f08195d2's ephemeral,
    // on the theory that its declared 300_000 was being replaced by a ~1.5M caller value.
    // That was false: tools/ephemeral-agent-factory.ts passes turnTimeoutMs only inside
    // inlineConfig and never passes turnTimeoutOverrideMs, so there is no caller ceiling
    // on that path and BOTH the old and the new rule resolve 300_000. Pinned so the false
    // diagnosis is not re-derived from the code.
    expect(resolveTurnBudgetMs({ callerCeilingMs: undefined, agentTurnTimeout: 300_000 })).toBe(300_000);
  });

  it("keeps 0 and undefined distinct — explicitly unbounded is not 'no information'", () => {
    expect(resolveTurnBudgetMs({ callerCeilingMs: undefined, agentTurnTimeout: "unbound" })).toBe(0);
    expect(resolveTurnBudgetMs({ callerCeilingMs: 0, agentTurnTimeout: 900_000 })).toBe(0);
    expect(resolveTurnBudgetMs({ callerCeilingMs: undefined, agentTurnTimeout: undefined })).toBeUndefined();
    // "unbound" declares no self-limit, so a caller ceiling still stands alone over it.
    expect(resolveTurnBudgetMs({ callerCeilingMs: DEFAULT_TURN_MS, agentTurnTimeout: "unbound" })).toBe(DEFAULT_TURN_MS);
  });
});

const hardDeadlineMs = (caller: number | undefined, declared: number | "unbound" | undefined): number =>
  resolveTurnBudgetMs({ callerCeilingMs: caller, agentTurnTimeout: declared }) ?? Number.MAX_SAFE_INTEGER;

describe("resolveSoftDeadlineOffsetMs", () => {
  it("fires before the hard deadline for every agent in the shipped budget range", () => {
    // coder 900_000, researcher 600_000, tool_developer 360_000, content_writer 1_500_000.
    for (const declared of [360_000, 600_000, 900_000, 1_500_000]) {
      const soft = resolveSoftDeadlineOffsetMs(DEFAULT_TURN_MS, declared);
      const hard = hardDeadlineMs(DEFAULT_TURN_MS, declared);
      expect(soft, `declared ${declared} must be nudged before it is aborted`).toBeLessThan(hard);
    }
  });

  it("is 70% of whichever budget actually binds", () => {
    expect(resolveSoftDeadlineOffsetMs(DEFAULT_TURN_MS, 900_000)).toBe(630_000); // agent binds
    expect(resolveSoftDeadlineOffsetMs(600_000, 900_000)).toBe(420_000); // caller binds
    expect(resolveSoftDeadlineOffsetMs(DEFAULT_TURN_MS, undefined)).toBe(1_260_000); // no declaration
  });

  it("treats a NON-BOUND as out of reach, never as the smallest bound", () => {
    // "unbound" = the agent declared no self-limit. A caller budget of 0 = max effort
    // disabled the turn timeout. Taking a minimum against either collapses the soft
    // deadline to now and nudges "wrap up" into iteration 1 of an unleashed run.
    expect(resolveSoftDeadlineOffsetMs(DEFAULT_TURN_MS, "unbound")).toBe(1_260_000);
    expect(resolveSoftDeadlineOffsetMs(0, 900_000)).toBeGreaterThan(86_400_000);
    expect(resolveSoftDeadlineOffsetMs(0, "unbound")).toBeGreaterThan(86_400_000);
    expect(resolveSoftDeadlineOffsetMs(undefined, undefined)).toBe(42_000); // 70% of the 60s fallback
  });

  it("stays proportional when a synthesis reserve is carved out", () => {
    // The no-parent-deadline arm of the resolver — what the delegation site computes for a
    // caller that states a budget but no deadline.
    const reserved = resolveDelegationCeilingMs({
      callerBudgetMs: DEFAULT_TURN_MS, parentDeadlineMs: undefined, nowMs: 0, synthesisReserveMs: 300_000,
    });
    expect(reserved).toBe(1_500_000);
    // The agent's own 900_000 still binds; the reserve only lowers the ceiling.
    expect(resolveSoftDeadlineOffsetMs(reserved, 900_000)).toBe(630_000);
    expect(resolveSoftDeadlineOffsetMs(reserved, undefined)).toBe(1_050_000);
  });
});
