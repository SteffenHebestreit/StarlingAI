import { describe, expect, it } from "vitest";
import { buildDynamicTurnGuidance } from "../agent/intent-classifier.js";
import { renderUserProfileEvidence } from "../agent/user-profile-prefetch.js";

const guidance = (msg: string) => buildDynamicTurnGuidance(msg, "orchestration_only");

describe("userOwnFacts detection", () => {
  it("fires on the audited German CV/Lead-Dev fit question", () => {
    // The exact message that produced the toolCalls=0 admit-without-retrieve failure.
    expect(guidance("Wäre ich eine gute Besetzung für GenAI-Projekte als Lead-Dev")?.userOwnFacts).toBe(true);
  });

  it("fires when the user asks about access to their own CV / project list", () => {
    expect(guidance("Hast du keinen Zugriff auf mein CV oder Projektliste?")?.userOwnFacts).toBe(true);
  });

  it("fires on English self-referential background / skill / fit questions", () => {
    expect(guidance("what's my background in machine learning?")?.userOwnFacts).toBe(true);
    expect(guidance("do I have experience with Kubernetes?")?.userOwnFacts).toBe(true);
    expect(guidance("would I be a good fit for this role?")?.userOwnFacts).toBe(true);
    expect(guidance("habe ich genug Erfahrung als Lead-Dev?")?.userOwnFacts).toBe(true);
  });

  // Generalization guard (no overfit to the audited prompt's vocabulary): framings
  // the example never used must still fire on the STRUCTURE, not on memorized words.
  it("generalizes across vocabulary the audited prompt never used", () => {
    expect(guidance("Bin ich qualifiziert für eine Data-Science-Stelle?")?.userOwnFacts).toBe(true); // adjective stem
    expect(guidance("Do you know what skills I have?")?.userOwnFacts).toBe(true); // subject-after-verb "I have"
    expect(guidance("What are my strengths as a developer?")?.userOwnFacts).toBe(true);
    expect(guidance("Wie sieht mein beruflicher Werdegang aus?")?.userOwnFacts).toBe(true);
    expect(guidance("Am I a strong candidate for a PM position?")?.userOwnFacts).toBe(true);
    expect(guidance("Reicht meine Erfahrung für eine Architektenrolle?")?.userOwnFacts).toBe(true);
  });

  it("does NOT fire on questions about the ASSISTANT's own capabilities", () => {
    expect(guidance("was kannst du alles?")?.userOwnFacts).toBeFalsy();
    expect(guidance("what can you do?")?.userOwnFacts).toBeFalsy();
  });

  it("does NOT fire on first-person turns with no profile/identity context (no keyword overfire)", () => {
    expect(guidance("can I use my API key here?")?.userOwnFacts).toBeFalsy();
    expect(guidance("what is my account balance?")?.userOwnFacts).toBeFalsy();
    expect(guidance("my code doesn't compile, fix it")?.userOwnFacts).toBeFalsy();
    expect(guidance("would I be able to deploy this today?")?.userOwnFacts).toBeFalsy();
  });

  it("injects a retrieve-first directive naming recall_context into the guidance prompt", () => {
    const g = guidance("habe ich genug Erfahrung als Lead-Dev?");
    expect(g?.userOwnFacts).toBe(true);
    expect(g?.prompt).toMatch(/recall_context/);
    expect(g?.prompt).toMatch(/invalid until you have looked|Never invent a profile/);
  });
});

describe("renderUserProfileEvidence", () => {
  it("returns '' when BOTH sources hard-error (could not look — keep on-demand digest)", () => {
    expect(renderUserProfileEvidence(null, null)).toBe("");
  });

  it("renders a confirmed-empty marker when retrieval ran but found nothing", () => {
    const out = renderUserProfileEvidence([], []);
    expect(out).toMatch(/found NOTHING/i);
    expect(out).toMatch(/no stored information/i);
    expect(out).toMatch(/Do NOT invent a profile/);
  });

  it("renders memory records + document excerpts as authoritative evidence", () => {
    const out = renderUserProfileEvidence(
      [{ scope: "user", kind: "fact", subject: "role", content: "Senior backend engineer, 8 years" }],
      [{ title: "cv.pdf", documentId: "doc1", text: "Led a GenAI platform team; Python, Go, Kubernetes." }],
    );
    expect(out).toMatch(/authoritative/i);
    expect(out).toMatch(/Senior backend engineer/);
    expect(out).toMatch(/cv\.pdf/);
    expect(out).toMatch(/GenAI platform/);
  });

  it("renders only the section that has data", () => {
    const out = renderUserProfileEvidence([], [{ title: "resume.md", documentId: "d", text: "10 years Rust." }]);
    expect(out).toMatch(/resume\.md/);
    expect(out).not.toMatch(/Stored memory about this user/);
  });
});
