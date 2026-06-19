import { describe, expect, it } from "vitest";
import { selectStandoutSemanticMatches } from "../tools/workflow-catalog.js";

/**
 * The discovery capsule (staged orchestration S4) must surface a workflow ONLY when
 * its embedding score is a genuine outlier from the ~0.5 baseline — never steer the
 * model into a deliverable-shape workflow the request did not clearly call for
 * (audit 7839e153: an audio-hardware design request was wrongly routed into a
 * slide-deck job). These vectors are the REAL semantic scores observed in-container.
 */
const v = (semanticScore: number, name: string) => ({ semanticScore, name });

describe("selectStandoutSemanticMatches", () => {
  it("surfaces NOTHING when the whole band is the ~0.5 baseline (audio-design request)", () => {
    // Observed: meeting_briefing 0.556, onboarding 0.548, … all clustered, gap≈0.008.
    const ranked = [
      v(0.556, "meeting_briefing_packet"), v(0.548, "onboarding_packet"), v(0.531, "source_backed_paper"),
      v(0.528, "content_pipeline"), v(0.521, "onboarding_delivery"), v(0.507, "incident_response"),
      v(0.503, "deck_research"), v(0.501, "release_broadcast"),
    ];
    expect(selectStandoutSemanticMatches(ranked)).toEqual([]);
  });

  it("surfaces the clear standout (explicit presentation request)", () => {
    // Observed: sourced_presentation 0.631 with a 0.065 gap to the 0.566 baseline.
    const ranked = [
      v(0.631, "sourced_presentation"), v(0.566, "research_visual_digest"), v(0.562, "deep_research"),
      v(0.561, "content_creation"), v(0.547, "release_notes_draft"), v(0.541, "security_audit"),
    ];
    const out = selectStandoutSemanticMatches(ranked);
    expect(out.map((c) => c.name)).toEqual(["sourced_presentation"]);
  });

  it("admits a small cluster of equally-strong matches that break away from the baseline", () => {
    const ranked = [v(0.70, "a"), v(0.695, "b"), v(0.50, "c"), v(0.49, "d")];
    expect(selectStandoutSemanticMatches(ranked).map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("surfaces nothing when even the top is below the absolute quality floor", () => {
    const ranked = [v(0.40, "a"), v(0.20, "b")]; // a big gap, but 0.40 is too weak to trust
    expect(selectStandoutSemanticMatches(ranked)).toEqual([]);
  });

  it("surfaces nothing when everything is uniformly high (no discrimination)", () => {
    const ranked = [v(0.71, "a"), v(0.70, "b"), v(0.70, "c")]; // flat band, no break
    expect(selectStandoutSemanticMatches(ranked)).toEqual([]);
  });

  it("returns [] on an empty list", () => {
    expect(selectStandoutSemanticMatches([])).toEqual([]);
  });
});
