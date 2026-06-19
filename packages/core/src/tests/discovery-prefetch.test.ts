import { describe, expect, it } from "vitest";
import { formatDiscoveryCapsule } from "../agent/discovery-prefetch.js";

/**
 * S4 of staged orchestration: the up-front capability prefetch renders a compact,
 * soft-hint capsule of candidate agents + workflows. The async prefetch itself needs
 * the live agent registry + embeddings; the PURE formatter (the only new presentation
 * logic) is covered deterministically here.
 */
describe("formatDiscoveryCapsule", () => {
  it("returns empty string when there is nothing to inject", () => {
    expect(formatDiscoveryCapsule([], [])).toBe("");
  });

  it("lists agents with confidence + a one-line description and frames it as a soft head start", () => {
    const out = formatDiscoveryCapsule(
      [{ name: "researcher", description: "Web research and sourcing", confidence: "high" }],
      [],
    );
    expect(out).toContain("[CAPABILITY CANDIDATES");
    expect(out).toContain("- researcher [high] — Web research and sourcing");
    // Soft hint, not a hard gate.
    expect(out).toContain("head start, not a constraint");
    expect(out).toContain("no need to call search_agents");
  });

  it("lists workflows with their type and run_workflow guidance", () => {
    const out = formatDiscoveryCapsule(
      [],
      [{ name: "research_packet", workflowType: "job", description: "Gather + synthesize a sourced report" }],
    );
    expect(out).toContain("- research_packet (job) — Gather + synthesize a sourced report");
    expect(out).toContain("run_workflow");
    expect(out).not.toContain("search_agents"); // agent section omitted when no agents
  });

  it("includes both sections when both are present", () => {
    const out = formatDiscoveryCapsule(
      [{ name: "web_coder", confidence: "medium" }],
      [{ name: "paper", workflowType: "scene" }],
    );
    expect(out).toContain("- web_coder [medium]");
    expect(out).toContain("- paper (scene)");
  });

  it("collapses whitespace and truncates an over-long description", () => {
    const long = "x".repeat(200);
    const out = formatDiscoveryCapsule([{ name: "a", description: `line1\n  line2 ${long}` }], []);
    expect(out).toContain("line1 line2"); // newline + double-space collapsed to single spaces
    expect(out).toContain("…"); // truncated
    const agentLine = out.split("\n").find((l) => l.startsWith("- a"))!;
    expect(agentLine.length).toBeLessThan(140); // capped near the 120-char limit
  });
});
