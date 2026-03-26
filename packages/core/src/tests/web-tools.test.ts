import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/schema.js";
import { expandSearchQuery, rankSearchResults, rerankSearchResults, resolveSearchBackendConfig } from "../tools/web.js";

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env["SEARXNG_BASE_URL"];

  const configLoader = await import("../config/loader.js");
  configLoader.resetConfigForTests();
});

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

describe("web search backend selection", () => {
  it("defaults to DuckDuckGo when no SearXNG endpoint is configured", async () => {
    const loaderModule = await import("../config/loader.js");
    const realConfig = loaderModule.getConfig();
    const config: Config = {
      ...realConfig,
      retrieval: {
        ...realConfig.retrieval,
        search: {
          backend: "auto",
          timeoutMs: 12000,
        },
      },
    };

    const resolved = resolveSearchBackendConfig(config);

    expect(resolved.backends).toEqual(["duckduckgo"]);
    expect(resolved.requestedBackend).toBe("auto");
  });

  it("uses DuckDuckGo when explicitly configured and parses redirect results", async () => {
    const loaderModule = await import("../config/loader.js");
    const realConfig = loaderModule.getConfig();
    vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      retrieval: {
        ...realConfig.retrieval,
        search: {
          backend: "duckduckgo",
          timeoutMs: 12000,
        },
      },
    });

    const fetchMock = vi.fn(async () => new Response(`
      <div class="result results_links results_links_deep web-result">
        <h2 class="result__title">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fmodelcontextprotocol.io%2Fspecification">Model Context Protocol specification</a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fmodelcontextprotocol.io%2Fspecification">Official Model Context Protocol specification and documentation.</a>
      </div>
    `, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("web_search");

    const result = await tool!.execute({ query: "MCP official documentation", maxResults: 5 }, {
      sessionId: "session-1",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("via duckduckgo");
    expect(result.output).toContain("https://modelcontextprotocol.io/specification");
    expect(result.metadata?.["backend"]).toBe("duckduckgo");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://html.duckduckgo.com/html/?q="),
      expect.any(Object),
    );
  });

  it("falls back from SearXNG to DuckDuckGo in auto mode", async () => {
    const loaderModule = await import("../config/loader.js");
    const realConfig = loaderModule.getConfig();
    vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      retrieval: {
        ...realConfig.retrieval,
        search: {
          backend: "auto",
          searxngBaseUrl: "http://search.local",
          timeoutMs: 12000,
        },
      },
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("http://search.local/")) {
        return new Response("down", { status: 503 });
      }

      return new Response(`
        <div class="result results_links results_links_deep web-result">
          <h2 class="result__title">
            <a class="result__a" href="https://example.com/docs">Example Docs</a>
          </h2>
          <div class="result__snippet">Primary docs page.</div>
        </div>
      `, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("web_search");

    const result = await tool!.execute({ query: "example docs", maxResults: 5 }, {
      sessionId: "session-2",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("via duckduckgo");
    expect(result.metadata?.["attemptedBackends"]).toEqual(["searxng", "duckduckgo"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});