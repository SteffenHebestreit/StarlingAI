import { describe, expect, it } from "vitest";
import { oneShotCriteriaVerifyIsRedundant } from "../agent/turn-finalize-guards.js";

/**
 * riskGatedQA's one-shot criteria verification and the QA delivery loop check the same acceptance
 * criteria; with the loop on, the one-shot was a second full-context synthesis (30–90 s on the
 * single GPU) whose verdict the loop then re-derived.
 */
describe("riskGatedQA one-shot verification vs the QA delivery loop", () => {
  it("is redundant only when the loop will check the same criteria", () => {
    expect(oneShotCriteriaVerifyIsRedundant(true, 3)).toBe(true);
    expect(oneShotCriteriaVerifyIsRedundant(true, 0)).toBe(false);   // the loop is a no-op without criteria
    expect(oneShotCriteriaVerifyIsRedundant(false, 3)).toBe(false);  // loop off: the one-shot is the only check
  });
});
