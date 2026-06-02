import { describe, expect, it } from "vitest";
import {
  isContextlessValidationFollowUp,
  buildEffectiveResearchSubject,
  buildSourceSensitiveOriginalRequestTask,
  buildCanonicalSourceSensitiveDelegationTask,
} from "../agent/source-sensitive-delegation.js";
import { taskRequiresExternalResearch } from "../tools/sub-agent.js";

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

/**
 * The source-sensitive delegation preamble is the routing query for undirected
 * source-sensitive delegations. It must (a) lead with web-research/gather framing
 * so embedding routing picks the researcher (primary gatherer), not source_verifier
 * (a draft checker) — validated against the live nomic model — and (b) still carry
 * the SOURCE-SENSITIVE DELEGATION marker (with its SLICE/GRAPH NODE label) that the
 * three detectors key on, plus the verification discipline (a correctness invariant).
 */
describe("source-sensitive delegation preamble — research-framed + detector markers", () => {
  const userMessage = "Welche Schnittstelle hat das Infineon IM73A135V01 und brauche ich einen externen ADC am ESP32-S3?";

  for (const [name, build] of [
    ["original-request task", (m: string, label?: string) => buildSourceSensitiveOriginalRequestTask(m, label)],
    ["canonical parent task", (m: string, label?: string) => buildCanonicalSourceSensitiveDelegationTask(m, label)],
  ] as const) {
    it(`${name}: leads with web-research framing and keeps the detector markers`, () => {
      const task = build(userMessage);
      // Routing signal: research/gather framing appears before the verification discipline.
      expect(task).toContain("WEB RESEARCH TASK");
      expect(task.indexOf("WEB RESEARCH TASK")).toBeLessThan(task.indexOf("SOURCE-SENSITIVE DELEGATION"));
      // Detector marker preserved → source-sensitive enforcement + gate still fire.
      expect(task).toContain("SOURCE-SENSITIVE DELEGATION:");
      expect(taskRequiresExternalResearch(task)).toBe(true);
      // Verification discipline retained (topic-agnostic wording — the preamble no longer
      // uses hardware-flavored "official or vendor"; it confirms against "authoritative or
      // official" sources). Both builders share this phrase.
      expect(task.toLowerCase()).toContain("authoritative or official source");
      // Scope cap present: stay on the named subject, a handful of sources, then stop.
      expect(task.toLowerCase()).toContain("stay tightly scoped");
      expect(task).toContain(userMessage);
    });

    it(`${name}: preserves the SLICE label for the slice detector`, () => {
      const task = build(userMessage, "SLICE 2/3");
      expect(task).toContain("SOURCE-SENSITIVE DELEGATION SLICE 2/3:");
    });
  }
});
