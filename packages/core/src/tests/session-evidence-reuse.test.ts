import { describe, expect, it } from "vitest";
import {
  shouldNudgeSessionEvidenceReuse,
  buildSessionEvidenceReuseNudge,
} from "../agent/runtime.js";

/**
 * Reuse-don't-re-research (audit 17f53ed0): a refinement of a deliverable already
 * produced this session ("Mache ein ordentliches Angebot") re-ran a 15-minute research
 * mission whose evidence was still in the conversation. The gate is purely structural —
 * substantial prior delegated evidence + no new URL — and the nudge is a soft, conditional
 * directive, so genuinely-new follow-ups still research.
 */
const EVIDENCE = (chars: number, itemCount = 4) => ({ evidence: "x".repeat(chars), itemCount });

describe("shouldNudgeSessionEvidenceReuse", () => {
  it("fires for a short refinement when substantial prior evidence exists and no new URL", () => {
    expect(shouldNudgeSessionEvidenceReuse({
      enabled: true,
      narrowReuseAlreadyFired: false,
      priorEvidence: EVIDENCE(6516),
      userMessage: "Mache ein ordentliches Angebot",
    })).toBe(true);
  });

  it("is OFF when the flag is disabled (default)", () => {
    expect(shouldNudgeSessionEvidenceReuse({
      enabled: false,
      narrowReuseAlreadyFired: false,
      priorEvidence: EVIDENCE(6516),
      userMessage: "Mache ein ordentliches Angebot",
    })).toBe(false);
  });

  it("defers to the narrow source-sensitive reuse path when it already fired (no double-injection)", () => {
    expect(shouldNudgeSessionEvidenceReuse({
      enabled: true,
      narrowReuseAlreadyFired: true,
      priorEvidence: EVIDENCE(6516),
      userMessage: "ja passt so",
    })).toBe(false);
  });

  it("does NOT fire without substantial prior evidence (no prior research this session)", () => {
    expect(shouldNudgeSessionEvidenceReuse({
      enabled: true,
      narrowReuseAlreadyFired: false,
      priorEvidence: null,
      userMessage: "Mache ein ordentliches Angebot",
    })).toBe(false);
    // A one-liner is not a research deliverable worth reusing.
    expect(shouldNudgeSessionEvidenceReuse({
      enabled: true,
      narrowReuseAlreadyFired: false,
      priorEvidence: EVIDENCE(120),
      userMessage: "Mache ein ordentliches Angebot",
    })).toBe(false);
  });

  it("does NOT fire when the new message carries a URL (a fresh fetch target = new work)", () => {
    expect(shouldNudgeSessionEvidenceReuse({
      enabled: true,
      narrowReuseAlreadyFired: false,
      priorEvidence: EVIDENCE(6516),
      userMessage: "und jetzt das hier: https://www.freelancermap.de/projekt/anderes",
    })).toBe(false);
  });
});

describe("buildSessionEvidenceReuseNudge", () => {
  it("is a lean, conditional reuse directive (no evidence dump — it is already in history)", () => {
    const nudge = buildSessionEvidenceReuseNudge(EVIDENCE(6516, 5));
    expect(nudge).toContain("[SESSION EVIDENCE]");
    expect(nudge).toContain("do NOT re-run the research");
    expect(nudge).toContain("5 item(s)");
    expect(nudge).toMatch(/~7KB/); // 6516 chars ≈ 7KB
    // Conditional escape clause so genuinely-new facts still get researched.
    expect(nudge).toContain("ONLY for specific facts the existing evidence does not already cover");
    // Lean: it does not paste the 6.5KB of evidence back into the prompt.
    expect(nudge.length).toBeLessThan(600);
  });
});
