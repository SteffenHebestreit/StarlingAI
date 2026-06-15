import { describe, expect, it } from "vitest";
import {
  isContextlessValidationFollowUp,
  isAffirmativeContinuationFollowUp,
  isReferentialSubjectFollowUp,
  buildEffectiveResearchSubject,
  buildSourceSensitiveOriginalRequestTask,
  buildSourceSensitiveCoordinatorTask,
  buildCanonicalSourceSensitiveDelegationTask,
  deriveSourceSensitiveDelegationFocus,
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
 * Regression: session 64ccceb3 (2026-06-09). Turn 1 names the subject ("iSAQB
 * CPSA-F Zertifizierung"); turn 2 is a NEW imperative that references it without
 * naming it ("Recherchiere einen Fragekatalog … für DIESE Zertifizierung").
 * Neither the validation nor the affirmative detector fired, so the bare turn-2
 * message was delegated and the researcher confabulated CompTIA Security+ — five
 * minutes of the wrong certification. A referential follow-up must fold the prior
 * subject in. Detection is generic deixis (demonstratives / pro-forms), not a
 * topic-keyword bag.
 */
/**
 * audit 1740fb0c: a research-then-build request was flattened by the source-sensitive
 * enforcement into the research-only "gather and STOP and report" frame and pinned to a
 * lone researcher, so the build never ran. When the orchestrator LLM instead CHOOSES a
 * coordinator, the enforcement must give it a frame that lets it decompose+build, not the
 * gather-and-stop frame. (The decision to use a coordinator is the LLM's; this just stops
 * the autopilot sabotaging it — no message keyword-matching.)
 */
describe("source-sensitive frames: researcher (gather+stop) vs coordinator (decompose+build)", () => {
  const req = "Recherchiere einen Fragekatalog und erstelle dann eine WebApp dafür.";
  it("the lone-researcher frame tells it to gather and STOP", () => {
    const t = buildSourceSensitiveOriginalRequestTask(req);
    expect(t).toContain("STOP and report");
    expect(t).toContain("Original user request:");
  });
  it("the coordinator frame tells it to decompose and BUILD, not stop after research", () => {
    const t = buildSourceSensitiveCoordinatorTask(req);
    expect(t).not.toContain("STOP and report");
    expect(/build|produce/i.test(t)).toBe(true);
    expect(t).toContain("Original user request:");
    expect(t).toContain(req);
  });
});

describe("referential-subject follow-up handling", () => {
  it("detects a new imperative that references an unnamed earlier subject", () => {
    expect(isReferentialSubjectFollowUp("Recherchiere einen Fragekatalog der mich auf die Prüfung vorbereiten kann\nErstelle dann eine WebApp zum Lernen für diese Zertifizierung")).toBe(true);
    expect(isReferentialSubjectFollowUp("build a quiz for this certification")).toBe(true);
    expect(isReferentialSubjectFollowUp("erstelle eine Übungs-App dafür")).toBe(true);
    expect(isReferentialSubjectFollowUp("research that exam's domains")).toBe(true);
  });

  it("does not flag a self-contained request that names its own subject", () => {
    expect(isReferentialSubjectFollowUp("research the CompTIA Security+ SY0-701 exam objectives and cite sources")).toBe(false);
    expect(isReferentialSubjectFollowUp("erstelle eine Lernplattform für die iSAQB CPSA-F Zertifizierung")).toBe(false);
  });

  it("folds the prior turn's named subject into a referential follow-up", () => {
    const subject = buildEffectiveResearchSubject(
      "Recherchiere einen Fragekatalog der mich auf die Prüfung vorbereiten kann\nErstelle dann eine WebApp zum Lernen für diese Zertifizierung",
      "Ich möchte die iSAQB - CPSA-F (Certified Professional for Software Architecture - Foundation Level) Zertifizierung abschließen und brauche eine Lernplattform",
    );
    expect(subject).toContain("Original topic to research");
    expect(subject).toContain("iSAQB");
    expect(subject).toContain("CPSA-F");
    expect(subject).toContain("do NOT substitute a different");
  });
});

/**
 * Regression: session 0834b791 (2026-06-08). A staged request — turn 1 names the
 * subject ("iSAQB CPSA-F Lernplattform"), turn 3 is a bare affirmative
 * continuation ("ja, suche online und dann erstelle die lernplattform"). The
 * source-sensitive rewrite anchored on the turn-3 message alone, dropping the
 * subject, so the researcher chased generic "create an online LMS" vendors
 * (Moodle/Teachable/COACHY) instead of CPSA-F. An affirmative/go-ahead reply
 * must have the prior turn's subject folded in, exactly like a validation
 * follow-up.
 */
describe("affirmative continuation follow-up handling", () => {
  it("detects short affirmative / go-ahead continuations", () => {
    expect(isAffirmativeContinuationFollowUp("ja, suche online und dann erstelle die lernplattform")).toBe(true);
    expect(isAffirmativeContinuationFollowUp("beides")).toBe(true);
    expect(isAffirmativeContinuationFollowUp("okay, start now")).toBe(true);
    expect(isAffirmativeContinuationFollowUp("dann los; ran an die arbeit")).toBe(true);
    expect(isAffirmativeContinuationFollowUp("yes, do it")).toBe(true);
    expect(isAffirmativeContinuationFollowUp("mach das")).toBe(true);
  });

  it("does not flag self-contained requests (incl. ones that merely start with an action verb)", () => {
    expect(isAffirmativeContinuationFollowUp("research the best LLM for 3D-printing enclosures")).toBe(false);
    expect(isAffirmativeContinuationFollowUp("find the latest datasheet for the INMP441 microphone")).toBe(false);
    expect(isAffirmativeContinuationFollowUp("start a postgres docker container on port 5432")).toBe(false);
    // Long message that merely opens with "ja," carries its own subject — not folded.
    expect(
      isAffirmativeContinuationFollowUp(
        "ja, und recherchiere bitte ausführlich die genaue Stromaufnahme des ESP32-S3 im Deep-Sleep sowie die Latenz beim Aufwachen",
      ),
    ).toBe(false);
  });

  it("folds the prior turn's subject into an affirmative continuation", () => {
    const subject = buildEffectiveResearchSubject(
      "ja, suche online und dann erstelle die lernplattform",
      "Ich möchte die iSAQB CPSA-F Zertifizierung abschließen und brauche eine Lernplattform mit Fragekatalog und Multiple-Choice-Antworten",
      "Verstanden. Du suchst eine Lernplattform für die iSAQB CPSA-F-Prüfung mit einem vollständigen Fragekatalog.",
    );
    expect(subject).toContain("ja, suche online");
    expect(subject).toContain("Original topic to research");
    expect(subject).toContain("iSAQB CPSA-F");
    // Not phrased as a validation of the prior answer.
    expect(subject).not.toContain("Prior answer to validate");
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
      // Verification discipline retained as ONE general instruction (the old
      // hardware-flavored rulebook — "establish the subject's real identity", the
      // I²S-mic example — was stripped as overfit; session d251793b). Both builders
      // share the validate-before-truth line + the unverified-marking clause.
      expect(task.toLowerCase()).toContain("validate every claim");
      expect(task.toLowerCase()).toContain("unverified");
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

/**
 * Wrapper idempotency (audit ce8e2128): the top-level rewrite wraps the user request in
 * the full source-discipline rulebook; when a coordinator then fans out, the pre-evidence
 * slice enforcement wrapped that ALREADY-WRAPPED parent again — each researcher slice
 * carried the ~1.6KB boilerplate twice, Russian-doll "Parent task:" nesting, and a
 * duplicated focus block. Pure prefill latency + instruction dilution on the slow local
 * model. Re-wrapping must emit the SLIM frame: routing lead + marker + parent verbatim.
 */
describe("source-sensitive wrapper idempotency — no Russian-doll boilerplate", () => {
  const userMessage =
    "Recherchiere einen Fragekatalog der mich auf die Prüfung vorbereiten kann. Erstelle dann eine WebApp zum Lernen für diese Zertifizierung.";
  const focus = deriveSourceSensitiveDelegationFocus("slice task wording", userMessage)!;

  it("re-wrapping an already-wrapped parent emits the rulebook ONCE, not twice", () => {
    const parent = buildSourceSensitiveOriginalRequestTask(userMessage, undefined, focus);
    const slice = buildCanonicalSourceSensitiveDelegationTask(parent, "SLICE 1/2", focus);
    // Detector invariants hold on the slim frame.
    expect(slice).toContain("SOURCE-SENSITIVE DELEGATION SLICE 1/2:");
    expect(slice).toContain("WEB RESEARCH TASK");
    expect(taskRequiresExternalResearch(slice)).toBe(true);
    // The parent (with the user message) is embedded verbatim.
    expect(slice).toContain(userMessage);
    // The discipline appears exactly ONCE (from the parent), never re-emitted.
    expect(slice.split("Validate every claim").length - 1).toBe(1);
    expect(slice.split("Stay tightly scoped").length - 1).toBe(1);
    // The focus block is NOT duplicated.
    expect(slice.split("Focus for this slice").length - 1).toBe(1);
    // The slim frame adds only a small constant overhead over the parent.
    expect(slice.length).toBeLessThan(parent.length + 600);
  });

  it("a plain (unwrapped) parent still gets the full discipline rulebook", () => {
    const t = buildCanonicalSourceSensitiveDelegationTask(userMessage, "SLICE 2/2", focus);
    expect(t).toContain("SOURCE-SENSITIVE DELEGATION SLICE 2/2:");
    expect(t).toContain("Validate every claim");
    expect(t.toLowerCase()).toContain("stay tightly scoped");
  });
});
