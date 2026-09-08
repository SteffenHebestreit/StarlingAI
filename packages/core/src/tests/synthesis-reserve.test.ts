import { describe, expect, it } from "vitest";
import { resolveSynthesisReserveMs } from "../agent/sub-agent-turn-budget.js";

/**
 * A DEADLINE PROMISE SIZED BY A CONSTANT IS ONLY KEPT ON A FAST MODEL.
 *
 * The reserve exists so a run can WRITE ITS ANSWER before the hard wall. It was
 * `max(30s, min(75s, budget * 0.33))`, and its own comment named the assumption: 75 s was
 * chosen so synthesis could fire "even when the last tool round took 30-40 s".
 *
 * Session 3f15dc63 — a "what is the weather tomorrow" turn — is what happens when one call
 * costs more than the whole reserve. researcher held the complete forecast in shared facts at
 * 528 s, entered synthesis with 75 s reserved, and its synthesis call spent 121.8 s in PREFILL
 * ALONE (159.5 s total, 18,140-token prompt, deepseek-v4-flash, which cannot reuse KV state).
 * The reserve expired mid-prefill, the agent returned `partial`, and its parent then spent
 * another 283.9 s re-synthesising an answer that already existed. 20.1 minutes for a forecast
 * that was ready at 8.8.
 */
describe("synthesis reserve is sized from the run's own latency", () => {
  const MIN = 60_000;

  it("keeps the old 75s behaviour on a fast deployment", () => {
    // Calls of 8-30 s: the constant floor still wins, so nothing changes where nothing was broken.
    for (const slowestModelCallMs of [0, 8_000, 20_000, 30_000]) {
      expect(resolveSynthesisReserveMs({ turnTimeoutMs: 600_000, slowestModelCallMs })).toBe(75_000);
    }
  });

  it("reserves enough for the call that actually blew the deadline", () => {
    // The measured synthesis call: 159.5 s. The reserve must exceed it, not sit at 75 s.
    const reserve = resolveSynthesisReserveMs({ turnTimeoutMs: 600_000, slowestModelCallMs: 159_547 });
    expect(reserve).toBeGreaterThan(159_547);
    expect(reserve).toBe(Math.round(159_547 * 1.25));
  });

  it("would have let session 3f15dc63 finish instead of timing out", () => {
    // The run's slowest call before synthesis was 159.5 s; the deadline was 600 s. Under the old
    // constant, synthesis began at 525 s with 75 s left and needed 159.5 — impossible. Now it
    // begins early enough that the call fits inside the budget.
    const budget = 600_000;
    const reserve = resolveSynthesisReserveMs({ turnTimeoutMs: budget, slowestModelCallMs: 159_547 });
    const synthesisStartsAt = budget - reserve;
    expect(synthesisStartsAt + 159_547).toBeLessThanOrEqual(budget);
  });

  it("never lets the reserve eat the work it exists to summarise", () => {
    // A pathologically slow call must not reserve the whole budget — that is a deadline
    // problem, not a reserve problem, and it belongs in turnTimeoutMs.
    const budget = 600_000;
    for (const slowestModelCallMs of [400_000, 600_000, 5_000_000]) {
      const reserve = resolveSynthesisReserveMs({ turnTimeoutMs: budget, slowestModelCallMs });
      expect(reserve).toBeLessThanOrEqual(Math.round(budget * 0.6));
      expect(reserve).toBeGreaterThan(0);
    }
  });

  it("still honours the 30s floor on a short budget", () => {
    expect(resolveSynthesisReserveMs({ turnTimeoutMs: MIN, slowestModelCallMs: 0 })).toBe(30_000);
  });

  // NOTE: there is deliberately no test for a negative measurement. The Math.max(0, ...) guard
  // in the implementation is over-determined — Math.max(constantFloor, ...) already absorbs any
  // negative — so a test for it passes with the guard removed and proves nothing.
});
