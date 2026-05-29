import { describe, expect, it } from "vitest";
import { isContextlessValidationFollowUp, buildEffectiveResearchSubject } from "../agent/source-sensitive-delegation.js";

/**
 * Regression: session 3a35cff0 (2026-05-29). The user asked "research online and
 * validate your response" as a follow-up. The source-sensitive enforcement
 * delegated the bare message to mission_coordinator, which had no topic and
 * bounced with "what should I research?" — then the orchestrator fabricated a
 * "validated" answer. The fix folds the prior turn's topic + answer into the
 * delegated subject.
 */
describe("contextless validation follow-up handling", () => {
  it("detects follow-ups that refer to the prior answer", () => {
    expect(isContextlessValidationFollowUp("research online and validate your response")).toBe(true);
    expect(isContextlessValidationFollowUp("validate your response")).toBe(true);
    expect(isContextlessValidationFollowUp("is that still correct?")).toBe(true);
    expect(isContextlessValidationFollowUp("stimmt das noch?")).toBe(true);
    expect(isContextlessValidationFollowUp("verify the above")).toBe(true);
  });

  it("does not flag self-contained requests that carry their own topic", () => {
    expect(isContextlessValidationFollowUp("research the best LLM for 3D-printing enclosures")).toBe(false);
    expect(isContextlessValidationFollowUp("find the latest datasheet for the INMP441 microphone")).toBe(false);
  });

  it("folds the prior topic and answer into a contextless follow-up", () => {
    const subject = buildEffectiveResearchSubject(
      "research online and validate your response",
      "research the best llm to generate 3d models for 3d-printing cases",
      "Kurzantwort: Es gibt kein einzelnes LLM ... Claude 3.5 Sonnet -> OpenSCAD.",
    );
    expect(subject).toContain("research online and validate your response");
    expect(subject).toContain("Original topic to research");
    expect(subject).toContain("best llm to generate 3d models");
    expect(subject).toContain("Prior answer to validate");
    expect(subject).toContain("Claude 3.5 Sonnet");
  });

  it("leaves a self-contained request untouched", () => {
    const msg = "research the best LLM for 3D-printing enclosures and cite sources";
    expect(buildEffectiveResearchSubject(msg, "older unrelated request", "older answer")).toBe(msg);
  });

  it("returns the message unchanged when there is no prior context to fold in", () => {
    const msg = "validate your response";
    expect(buildEffectiveResearchSubject(msg, undefined, undefined)).toBe(msg);
  });
});
