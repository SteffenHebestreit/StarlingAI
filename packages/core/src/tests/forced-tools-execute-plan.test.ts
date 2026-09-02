import { describe, expect, it } from "vitest";
import { filterForcedOrchestrationTools } from "../agent/runtime.js";

/**
 * A forced orchestration iteration keeps only the tools that advance the turn. execute_plan is
 * the one that advances a planned turn the most, and it was missing: the model recorded a plan,
 * was forced to delegate, and had to re-issue the plan's first step by hand.
 */
describe("forced orchestration iteration — execute_plan advances a planned turn", () => {
  it("keeps execute_plan and still drops the no-op escape hatches", () => {
    const kept = filterForcedOrchestrationTools([
      { name: "execute_plan" },
      { name: "record_plan" },
      { name: "memory_store" },
      { name: "delegate_to_agent" },
    ]).map((t) => t.name);
    expect(kept).toEqual(["execute_plan", "delegate_to_agent"]);
  });
});
