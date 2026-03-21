import { describe, expect, it } from "vitest";
import { expandSearchQuery, rankSearchResults, rerankSearchResults } from "../tools/web.js";

describe("web search query expansion", () => {
  it("expands MCP toward Model Context Protocol when AI/protocol terms are present", () => {
    const expanded = expandSearchQuery("MCP official documentation github");
    expect(expanded).toContain('"Model Context Protocol"');
  });

  it("does not expand MCP for unrelated acronym-only domains", () => {
    const expanded = expandSearchQuery("MCP transmissions roadmap");
    expect(expanded).toBe("MCP transmissions roadmap");
  });
});

describe("web search reranking", () => {
  it("prioritizes substantive phrase matches over acronym-only collisions", () => {
    const ranked = rerankSearchResults(
      "Model Context Protocol MCP official documentation github",
      [
        {
          title: "MCP Transmissions",
          url: "https://www.atomicmassgames.com/mcp-transmissions/",
          snippet: "Official updates and news for Marvel Crisis Protocol miniatures.",
        },
        {
          title: "Model Context Protocol specification",
          url: "https://modelcontextprotocol.io/specification",
          snippet: "Official Model Context Protocol specification and documentation.",
        },
        {
          title: "GitHub - modelcontextprotocol/specification",
          url: "https://github.com/modelcontextprotocol/specification",
          snippet: "The official specification repo for Model Context Protocol.",
        },
      ],
      3,
    );

    expect(ranked[0]?.url).toBe("https://modelcontextprotocol.io/specification");
    expect(ranked[1]?.url).toBe("https://github.com/modelcontextprotocol/specification");
    expect(ranked[2]?.url).toBe("https://www.atomicmassgames.com/mcp-transmissions/");
  });

  it("keeps acronym-only queries usable when no richer terms exist", () => {
    const ranked = rerankSearchResults(
      "mcp roadmap",
      [
        {
          title: "MCP roadmap",
          url: "https://example.com/mcp-roadmap",
          snippet: "Roadmap and timeline for MCP.",
        },
        {
          title: "Atomic Mass Games MCP transmissions",
          url: "https://www.atomicmassgames.com/mcp-transmissions/",
          snippet: "MCP faction updates and event news.",
        },
      ],
      2,
    );

    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.url).toBe("https://example.com/mcp-roadmap");
  });

  it("exposes ranking scores for audit/debug metadata", () => {
    const ranked = rankSearchResults(
      "Model Context Protocol MCP official documentation github",
      [
        {
          title: "MCP Transmissions",
          url: "https://www.atomicmassgames.com/mcp-transmissions/",
          snippet: "Official updates and news for Marvel Crisis Protocol miniatures.",
        },
        {
          title: "Model Context Protocol specification",
          url: "https://modelcontextprotocol.io/specification",
          snippet: "Official Model Context Protocol specification and documentation.",
        },
      ],
      2,
    );

    expect(ranked[0]?.url).toBe("https://modelcontextprotocol.io/specification");
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
    expect(ranked.every((result) => typeof result.score === "number")).toBe(true);
  });
});