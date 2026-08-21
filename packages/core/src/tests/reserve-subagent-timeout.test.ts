import { describe, expect, it } from "vitest";
import { resolveDelegationCeilingMs } from "../agent/sub-agent-turn-budget.js";

/**
 * The no-parent-deadline arm of the delegation resolver, which is what the old
 * `reserveSubAgentTimeout` wrapper forwarded to. The wrapper is gone — it had no production
 * caller left once the delegation site started calling the resolver directly — so these
 * assertions now name the function that actually runs, rather than a three-line shim in front
 * of it. Every number below is unchanged.
 */
const reserveSubAgentTimeout = (
  parentBudgetMs: number | undefined,
  reserveMs: number,
  floorMs = 60_000,
): number | undefined => resolveDelegationCeilingMs({
  callerBudgetMs: parentBudgetMs,
  parentDeadlineMs: undefined,
  nowMs: 0,
  synthesisReserveMs: reserveMs,
  floorMs,
});

/**
 * A delegated sub-agent inherits the parent turn budget as its OWN hard timeout, so
 * one slow node can consume 100% of the turn and starve the orchestrator of time to
 * synthesize + deliver (audit b6f8336e: a 19.6-min research graph ate a 20-min turn;
 * the finished answer was dropped and the session archived). The resolver carves a
 * synthesis-headroom reserve out of the budget — and is a strict no-op until the reserve
 * knob is set.
 */
describe("resolveDelegationCeilingMs — the no-parent-deadline arm", () => {
  it("is identity when the reserve is 0 (the config default — zero behavior change)", () => {
    expect(reserveSubAgentTimeout(1_200_000, 0)).toBe(1_200_000);
  });

  it("passes through an absent/unbounded budget untouched", () => {
    expect(reserveSubAgentTimeout(undefined, 90_000)).toBeUndefined();
    expect(reserveSubAgentTimeout(0, 90_000)).toBe(0);
    expect(reserveSubAgentTimeout(Number.POSITIVE_INFINITY, 90_000)).toBe(Number.POSITIVE_INFINITY);
    expect(reserveSubAgentTimeout(Number.NaN, 90_000)).toBeNaN();
  });

  it("reserves the margin off the parent budget (the b6f8336e fix)", () => {
    // 20-min turn, 90s synthesis reserve → sub-agent hard-stops at 18.5 min, leaving
    // the orchestrator 90s to finalize before the gateway watchdog (budget+grace) fires.
    expect(reserveSubAgentTimeout(1_200_000, 90_000)).toBe(1_110_000);
  });

  it("a reserve larger than the budget can no longer gut it — it takes a share, not a slab", () => {
    // Was: 120,000 − 200,000 is negative, so the child collapsed to the 60,000 floor (or to a
    // custom one). A reserve is headroom for the parent, and headroom that exceeds the whole
    // budget is a statement about the parent's needs, not about the child's — so
    // MAX_SYNTHESIS_RESERVE_FRACTION bounds it at a quarter of what is there and the child keeps
    // 90,000. The floor is still the backstop; it is simply no longer the normal outcome.
    expect(reserveSubAgentTimeout(120_000, 200_000)).toBe(90_000);
    expect(reserveSubAgentTimeout(120_000, 200_000)!).toBeGreaterThanOrEqual(60_000); // default floor
    // A custom floor still binds when it sits ABOVE the fractional result.
    expect(reserveSubAgentTimeout(40_000, 200_000, 30_000)).toBe(30_000);
  });

  it("treats a negative reserve as identity", () => {
    expect(reserveSubAgentTimeout(600_000, -5)).toBe(600_000);
  });
});
