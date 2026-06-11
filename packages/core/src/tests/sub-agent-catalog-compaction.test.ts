import { describe, expect, it } from "vitest";
import { compactAgentCatalogDescription } from "../agent/sub-agent.js";

/**
 * Prompt diet (Wave 2): configured agent descriptions are written for EMBEDDING
 * search (long "Example queries:" bags, multi-sentence detail). Inlining 24 of them
 * verbatim into every orchestration-capable sub-agent prompt put ~12KB of padding
 * into each coordinator iteration (27KB coordinator prompt vs 4.8KB researcher).
 * The inline catalog keeps only the first-sentence lead; search_agents still sees
 * the full description.
 */
describe("compactAgentCatalogDescription", () => {
  it("keeps the first sentence and drops the example-query bag", () => {
    const full =
      "Browser automation specialist using Playwright MCP tools to open websites, interact with pages, submit forms, click through flows, and capture screenshots for downstream analysis. "
      + "Example queries: 'log into the portal and download the PDF', 'fill out the contact form on example.com', 'klicke den Download-Button'.";
    const compact = compactAgentCatalogDescription(full);
    expect(compact).toContain("Browser automation specialist");
    expect(compact).not.toContain("Example queries");
    expect(compact).not.toContain("log into the portal");
    expect(compact.length).toBeLessThanOrEqual(180);
  });

  it("caps a single run-on sentence at 180 chars with an ellipsis", () => {
    const runOn = "A ".repeat(200) + "specialist";
    const compact = compactAgentCatalogDescription(runOn);
    expect(compact.length).toBeLessThanOrEqual(180);
    expect(compact.endsWith("…")).toBe(true);
  });

  it("handles empty/missing descriptions", () => {
    expect(compactAgentCatalogDescription(undefined)).toBe("No description available.");
    expect(compactAgentCatalogDescription("  ")).toBe("No description available.");
  });

  it("leaves a short single-sentence description untouched", () => {
    expect(compactAgentCatalogDescription("Writes TypeScript tools.")).toBe("Writes TypeScript tools.");
  });
});
