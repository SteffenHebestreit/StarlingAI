import { describe, expect, it } from "vitest";
import { buildDynamicTurnGuidance } from "../agent/intent-classifier.js";
import { renderUserProfileEvidence } from "../agent/user-profile-prefetch.js";

const guidance = (msg: string) => buildDynamicTurnGuidance(msg, "orchestration_only");

describe("userOwnFacts detection", () => {
  // De-lexicalization (cleanup/lean-base): the userOwnFacts keyword tables
  // (FIRST_PERSON_SELF_PATTERNS / SELF_IDENTITY_CONTEXT_TERMS / SELF_FIT_QUALITY_PATTERNS)
  // were deleted and the flag now DEFAULTS OFF — the swarm decides from the roster
  // + tools + the LLM's semantic read whether a turn needs the user's own profile.
  // The 5 "fires on <self-referential phrasing>" tests asserted that deleted keyword
  // detection and were removed. The "does NOT fire" guards below still hold (the flag
  // is off), so they stay as a regression fence against a keyword pile being re-added.

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

  // Dedup: on a userOwnFacts turn the per-turn RAG is the single doc source, so the
  // prefetch renders memory only and never re-emits the CV chunks.
  it("omits the documents section when docs are handled by [DOCUMENT CONTEXT]", () => {
    const out = renderUserProfileEvidence(
      [{ scope: "user", kind: "fact", subject: "role", content: "Senior engineer" }],
      [{ title: "cv.pdf", documentId: "d", text: "SHOULD NOT APPEAR HERE" }],
      { docsHandledElsewhere: true, documentsAlreadyInjected: true },
    );
    expect(out).toMatch(/Senior engineer/);
    expect(out).not.toMatch(/SHOULD NOT APPEAR HERE/);
    expect(out).not.toMatch(/Excerpts from documents/);
  });

  it("returns '' (no marker) when memory is empty but the per-turn RAG already injected the CV", () => {
    expect(renderUserProfileEvidence([], null, { docsHandledElsewhere: true, documentsAlreadyInjected: true })).toBe("");
  });

  it("emits the confirmed-empty marker when memory empty AND no docs were injected anywhere", () => {
    const out = renderUserProfileEvidence([], null, { docsHandledElsewhere: true, documentsAlreadyInjected: false });
    expect(out).toMatch(/found NOTHING/i);
  });

  // Existence/access question: the CV reranks negative so no excerpt is injected, but the
  // user DOES have documents on file — the marker must acknowledge them, never deny access,
  // and must NOT leak/fabricate their content (only titles are known).
  it("acknowledges documents on file when retrieval was empty but the corpus has the user's docs", () => {
    const out = renderUserProfileEvidence([], null, {
      docsHandledElsewhere: true,
      documentsAlreadyInjected: false,
      availableDocuments: [{ title: "CV_Hebestreit_2026.pdf" }, { title: "Projektliste_Hebestreit_2026.pdf" }],
    });
    expect(out).toMatch(/CV_Hebestreit_2026\.pdf/);
    expect(out).toMatch(/Projektliste_Hebestreit_2026\.pdf/);
    expect(out).toMatch(/Do NOT claim you have no access/i);
    expect(out).toMatch(/Do NOT invent their contents/i);
    expect(out).not.toMatch(/found NOTHING/i); // must NOT use the truly-empty wording
  });

  it("flags an outdated (invalidated) document so the model doesn't imply it can read it", () => {
    const out = renderUserProfileEvidence([], null, {
      docsHandledElsewhere: true,
      documentsAlreadyInjected: false,
      availableDocuments: [{ title: "old-resume.pdf", invalidated: true }, { title: "current-resume.pdf" }],
    });
    expect(out).toMatch(/old-resume\.pdf \(marked outdated — content not retrievable\)/);
    expect(out).toMatch(/current-resume\.pdf/);
    expect(out).not.toMatch(/current-resume\.pdf \(marked outdated/); // the fresh doc is NOT flagged
  });

  it("still emits the truly-empty marker when there are no documents on file at all", () => {
    const out = renderUserProfileEvidence([], null, {
      docsHandledElsewhere: true,
      documentsAlreadyInjected: false,
      availableDocuments: [],
    });
    expect(out).toMatch(/found NOTHING/i);
  });
});
