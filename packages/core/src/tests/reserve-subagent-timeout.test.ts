import { describe, expect, it } from "vitest";
import { reserveSubAgentTimeout } from "../tools/sub-agent.js";

/**
 * A delegated sub-agent inherits the parent turn budget as its OWN hard timeout, so
 * one slow node can consume 100% of the turn and starve the orchestrator of time to
 * synthesize + deliver (audit b6f8336e: a 19.6-min research graph ate a 20-min turn;
 * the finished answer was dropped and the session archived). reserveSubAgentTimeout
 * carves a synthesis-headroom reserve out of the budget — and is a strict no-op until
 * the reserve knob is set.
 */
describe("reserveSubAgentTimeout", () => {
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

  it("never drops below the floor even with a huge reserve", () => {
    expect(reserveSubAgentTimeout(120_000, 200_000)).toBe(60_000); // default floor
    expect(reserveSubAgentTimeout(120_000, 200_000, 30_000)).toBe(30_000); // custom floor
  });

  it("treats a negative reserve as identity", () => {
    expect(reserveSubAgentTimeout(600_000, -5)).toBe(600_000);
  });
});
