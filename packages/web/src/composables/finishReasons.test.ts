import { describe, expect, it } from "vitest";
import { ITERATION_STOP_FINISH_REASONS, finishReasonNeedsAttention } from "./finishReasons";

/**
 * The chat's warning chip on a turn that did not end on its own. It looked for "max_iterations",
 * which the runtime never sends: a turn that ran out of tool iterations finishes with
 * max_tool_iterations, and one a loop brake ended with tool_streak_across_iterations or
 * iteration_tool_set_repeat (packages/core/src/agent/runtime.ts), and none of them got the chip.
 */
describe("the finish reasons the chat calls out", () => {
  it("include the iteration cap and both loop brakes, as the runtime names them", () => {
    for (const reason of ["max_tool_iterations", "tool_streak_across_iterations", "iteration_tool_set_repeat"]) {
      expect(finishReasonNeedsAttention(reason)).toBe(true);
      expect(ITERATION_STOP_FINISH_REASONS.has(reason)).toBe(true);
    }
    expect(finishReasonNeedsAttention("timeout")).toBe(true);
  });

  it("leave a turn that ended on its own alone", () => {
    for (const reason of ["stop", "length", "tool_calls", "single_deliverable_relayed", "", undefined, null]) {
      expect(finishReasonNeedsAttention(reason)).toBe(false);
    }
  });
});
