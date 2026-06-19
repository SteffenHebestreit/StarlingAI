import { describe, expect, it } from "vitest";
import { buildLeanSynthesisPrompt, buildSynthesisRequiredDirective } from "../agent/runtime.js";

/**
 * S1 of staged orchestration: the TERMINAL forced-synthesis call has no tools, so
 * it gets a compact synthesis-only prompt instead of the ~24.7K orchestrator
 * monolith. The prompt must KEEP the synthesis-critical rules (grounding, full
 * coverage, no-truncation) while DROPPING routing/tooling machinery, and stay lean.
 */
describe("buildLeanSynthesisPrompt", () => {
  it("keeps synthesis-critical rules and drops routing/tool boilerplate, and is lean", () => {
    const p = buildLeanSynthesisPrompt();
    const lower = p.toLowerCase();

    // Terminal framing — this call cannot route or delegate.
    expect(lower).toContain("no tools");
    expect(lower).toMatch(/do not plan, route, delegate/);
    // Grounding / anti-hallucination.
    expect(lower).toContain("never substitute");
    // Full coverage of multi-item / multi-source evidence.
    expect(lower).toContain("every item");
    expect(lower).toContain("every source");
    // Anti-truncation (incl. the German term the base prompt guards against).
    expect(lower).toContain("abgeschnitten");
    expect(lower).toMatch(/truncat|cut off/);
    // Language mirroring + output format.
    expect(lower).toContain("user's language");
    expect(lower).toContain("markdown");

    // Genuinely lean — the whole point (well under the ~24.7K monolith).
    expect(p.length).toBeLessThan(2000);
    // ...and free of the routing/swarm machinery the monolith carries.
    expect(lower).not.toContain("search_agents");
    expect(lower).not.toContain("delegate_to_agent");
    expect(lower).not.toContain("orchestration strategy");
  });

  it("includes the assistant name only when provided", () => {
    expect(buildLeanSynthesisPrompt({ assistantName: "Luna" })).toContain('you are "Luna"');
    expect(buildLeanSynthesisPrompt()).not.toContain("If asked your name");
  });
});

/**
 * Honesty floor (audit 0dc158ad): a source-sensitive turn whose research came back
 * partial/thin must NOT get the "copy the exact names and numbers from the evidence"
 * directive — that oversells empty evidence and the model fabricates specifics (it
 * claimed an analog mic has an I2S interface). The directive selection is pure here.
 */
describe("buildSynthesisRequiredDirective", () => {
  it("standard path: instructs synthesis from the grounded evidence blocks", () => {
    const d = buildSynthesisRequiredDirective({});
    expect(d).toContain("[SYNTHESIS REQUIRED]");
    expect(d).toContain("grounded evidence blocks");
    expect(d.toLowerCase()).toContain("copy the exact names");
  });

  it("artifact path: a SHORT completion summary that lists the attached files", () => {
    const d = buildSynthesisRequiredDirective({ artifactPaths: ["app/index.html", "report.pdf"] });
    expect(d).toContain("attached to this message as files");
    expect(d).toContain("app/index.html");
    expect(d).toContain("report.pdf");
    expect(d.toLowerCase()).toContain("short final answer");
    // Must NOT carry the "copy exact names/numbers" framing — there is no evidence block to copy.
    expect(d.toLowerCase()).not.toContain("copy the exact names");
  });

  it("partial-evidence path: an HONESTY directive that forbids asserting unverified specifics", () => {
    const d = buildSynthesisRequiredDirective({ partialEvidence: true });
    expect(d).toContain("did NOT complete");
    expect(d).toContain("UNVERIFIED");
    expect(d.toLowerCase()).toContain("never invent a value");
    // Crucially, the fabrication-inducing "copy the exact names and numbers" instruction is GONE.
    expect(d.toLowerCase()).not.toContain("copy the exact names");
    // It still asks for a useful answer, not a refusal (never dead-end).
    expect(d.toLowerCase()).toContain("most useful answer");
  });

  it("artifacts win over partial-evidence (a built deliverable is summarised, not hedged)", () => {
    const d = buildSynthesisRequiredDirective({ artifactPaths: ["deck.html"], partialEvidence: true });
    expect(d).toContain("attached to this message as files");
    expect(d).not.toContain("did NOT complete");
  });
});
