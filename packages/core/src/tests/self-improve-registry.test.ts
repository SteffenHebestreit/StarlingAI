import { describe, expect, it, beforeEach } from "vitest";
import {
  listCapabilityGaps,
  getCapabilityGap,
  resetSelfImprovementForTests,
  buildToolProposalPrompt,
  rejectImprovement,
  markImprovementSubmitted,
} from "../agent/self-improve.js";
import { createToolDevSession } from "../agent/tool-dev-session.js";

// The pure, side-effect-free read/build helpers of the self-improvement registry (recordCapabilityGap
// is config-gated + may reach the LLM, so it is exercised elsewhere).
describe("self-improvement registry read helpers", () => {
  beforeEach(() => resetSelfImprovementForTests());

  it("starts empty and returns undefined for an unknown gap id", () => {
    expect(listCapabilityGaps()).toEqual([]);
    expect(getCapabilityGap("does-not-exist")).toBeUndefined();
  });

  it("buildToolProposalPrompt renders a tool-architect prompt that embeds the gap", () => {
    const prompt = buildToolProposalPrompt({
      id: "gap-1",
      description: "convert a heic image to png",
      detectedAt: new Date("2026-07-02T00:00:00Z").toISOString(),
      failureCount: 3,
      failurePatterns: ["convert a heic image to png"],
      status: "detected",
    });
    expect(typeof prompt).toBe("string");
    expect(prompt.toLowerCase()).toContain("tool architect");
    expect(prompt).toContain("heic");
  });

  it("rejectImprovement / markImprovementSubmitted run without a matching gap (safe no-op path)", () => {
    const session = createToolDevSession({
      toolName: "cov_reject_tool",
      description: "d",
      parametersSchema: {},
      sessionId: "sess-selfimp",
    });
    // No capability gap is linked to this session → gap-status updates are safe no-ops.
    expect(() => rejectImprovement(session, "tester")).not.toThrow();
    expect(() => markImprovementSubmitted("sess-selfimp")).not.toThrow();
  });
});
