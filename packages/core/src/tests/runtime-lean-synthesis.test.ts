import { describe, expect, it } from "vitest";
import { buildLeanSynthesisPrompt } from "../agent/runtime.js";

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
