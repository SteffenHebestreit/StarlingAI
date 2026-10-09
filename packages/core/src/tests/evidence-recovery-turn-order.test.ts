import { describe, expect, it } from "vitest";
import { beginFactTurn, writeSharedFact } from "../swarm/memory.js";
import { formatSharedFactsForFinalSynthesis, getSharedFactsEvidenceForFinalSynthesis } from "../agent/evidence-recovery.js";

/**
 * The shared-facts backstops list the evidence for the answer to THIS question. Sorted by key
 * alone, a prior turn's facts came first and filled the budget — the facts-side twin of the
 * cross-turn deliverable replay.
 */
describe("shared-facts recovery — this turn's findings come first", () => {
  const sid = `turn-order-${Date.now()}`;

  it("ranks a current-turn key ahead of a prior-turn key that sorts before it", async () => {
    await writeSharedFact(sid, "a_prior_turn_finding", "The previous question was about the Alps: the highest road pass is at 2,770 m.");
    beginFactTurn(sid);
    await writeSharedFact(sid, "z_this_turn_finding", "The current question is about Bavaria: the beer garden opens at 11:00.");

    const evidence = (await getSharedFactsEvidenceForFinalSynthesis(sid))?.evidence ?? "";
    expect(evidence.indexOf("z_this_turn_finding")).toBeGreaterThanOrEqual(0);
    expect(evidence.indexOf("a_prior_turn_finding")).toBeGreaterThanOrEqual(0);
    expect(evidence.indexOf("z_this_turn_finding")).toBeLessThan(evidence.indexOf("a_prior_turn_finding"));

    const formatted = await formatSharedFactsForFinalSynthesis(sid);
    expect(formatted.indexOf("z_this_turn_finding")).toBeLessThan(formatted.indexOf("a_prior_turn_finding"));
  });
});
