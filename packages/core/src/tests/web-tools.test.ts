import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/schema.js";
import { expandSearchQuery, isPdfContentType, rankSearchResults, rerankSearchResults, resolveSearchBackendConfig } from "../tools/web.js";

// Mock MCP registry so tests can control playwright availability
const mcpConnections = new Map<string, unknown>();
vi.mock("../mcp/registry.js", () => ({
  getMcpConnections: () => mcpConnections,
}));

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mcpConnections.clear();
  delete process.env["SEARXNG_BASE_URL"];

  const configLoader = await import("../config/loader.js");
  configLoader.resetConfigForTests();
});

describe("web_fetch PDF detection", () => {
  // Audit 97085c6b: web_fetch returned raw %PDF bytes for the IM73A135V01 datasheet,
  // so the analog-mic spec never reached synthesis. PDFs must be routed to extraction.
  it("recognizes application/pdf content types (with charset/params)", () => {
    expect(isPdfContentType("application/pdf")).toBe(true);
    expect(isPdfContentType("application/pdf; charset=binary")).toBe(true);
    expect(isPdfContentType("APPLICATION/PDF")).toBe(true);
  });

  it("does not flag HTML/JSON/text as PDF", () => {
    expect(isPdfContentType("text/html; charset=utf-8")).toBe(false);
    expect(isPdfContentType("application/json")).toBe(false);
    expect(isPdfContentType("")).toBe(false);
  });
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

  it("includes playwright as fallback backend when searxng is explicitly configured and playwright is available", async () => {
    mcpConnections.set("playwright", {});
    const loaderModule = await import("../config/loader.js");
    const realConfig = loaderModule.getConfig();
    const config: Config = {
      ...realConfig,
      retrieval: {
        ...realConfig.retrieval,
        search: {
          backend: "searxng",
          searxngBaseUrl: "http://search.local",
          timeoutMs: 12000,
        },
      },
    };

    const resolved = resolveSearchBackendConfig(config);

    expect(resolved.requestedBackend).toBe("searxng");
    expect(resolved.backends).toEqual(["searxng", "playwright", "duckduckgo"]);
  });

  it("falls through to playwright duckduckgo when searxng returns zero results", async () => {
    mcpConnections.set("playwright", {});
    const loaderModule = await import("../config/loader.js");
    const realConfig = loaderModule.getConfig();
    vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      retrieval: {
        ...realConfig.retrieval,
        search: {
          backend: "searxng",
          searxngBaseUrl: "http://search.local",
          timeoutMs: 12000,
        },
      },
    });

    // SearXNG returns a valid but empty results array
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("http://search.local/")) {
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("network error", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    // Playwright callTool mock — navigate + snapshot returning a DuckDuckGo result
    const playwrightCallTool = vi.fn(async (input: { name: string }) => {
      if (input.name === "browser_navigate") return { content: [{ type: "text", text: "" }] };
      if (input.name === "browser_snapshot") {
        return {
          content: [{
            type: "text",
            text: [
              '- link "KI-Protokolle im Vergleich" [ref=e1] -> https://example.com/ki-protokolle',
              "- text: MCP, A2A und AG-UI in der Übersicht",
            ].join("\n"),
          }],
        };
      }
      return { content: [{ type: "text", text: "" }] };
    });
    mcpConnections.set("playwright", { client: { callTool: playwrightCallTool } });

    const { clearSearchSessionState } = await import("../tools/web.js");
    clearSearchSessionState("session-searxng-fallback");

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("web_search");

    const result = await tool!.execute({ query: "KI-Protokolle", maxResults: 5 }, {
      sessionId: "session-searxng-fallback",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("via playwright");
    expect(result.output).toContain("KI-Protokolle im Vergleich");
    expect(result.metadata?.["attemptedBackends"]).toEqual(["searxng", "playwright"]);
    // streak should NOT have been incremented since playwright succeeded
    expect(result.metadata?.["consecutiveZeroResults"]).toBeUndefined();
  });
});
describe("web_fetch through the browser (Playwright MCP 1.61)", () => {
  // browser_evaluate takes `function`; this sent `expression`, which 1.61 rejects, so the page's
  // text was never read and every JS-rendered page came back as a converted accessibility tree.
  it("reads a JS-rendered page's text with browser_evaluate's `function`", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><body><div id=app></div></body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })));
    const callTool = vi.fn(async (input: { name: string; arguments: Record<string, unknown> }) => {
      if (input.name === "browser_evaluate") {
        const fn = input.arguments["function"];
        return typeof fn === "string" && fn.startsWith("() =>")
          ? { content: [{ type: "text", text: "### Result\n\"Rendered pricing table: Basic 9 EUR, Pro 29 EUR\"" }] }
          : { content: [{ type: "text", text: "Invalid input: function expected string, received undefined" }], isError: true };
      }
      if (input.name === "browser_snapshot") {
        return { content: [{ type: "text", text: "### Snapshot\n```yaml\n- heading \"Fallback tree\" [ref=e1]\n```" }] };
      }
      return { content: [{ type: "text", text: "" }] };
    });
    mcpConnections.set("playwright", { client: { callTool } });

    const { getTool } = await import("../tools/registry.js");
    const result = await getTool("web_fetch")!.execute({ url: "https://example.com/app" }, {
      sessionId: "session-web-fetch-evaluate",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Rendered pricing table: Basic 9 EUR, Pro 29 EUR");
    expect(result.output, "fell back to the accessibility tree").not.toContain("Fallback tree");
    expect(result.metadata?.["fetchMethod"]).toBe("playwright");
  });
});

/**
 * An empty answer from a search or a fetch is evidence only when the backend actually ran. These are
 * the cases where it had not — a failed SearXNG, engines that never answered, a 404, a blank render —
 * and the answer used to read like a clean "nothing there".
 */
describe("web_search / web_fetch say when nothing came back because something failed", () => {
  const ddgEmpty = () => new Response("<html><body><div class=\"no-results\">No results.</div></body></html>", {
    status: 200, headers: { "Content-Type": "text/html" },
  });

  async function searchWithConfig(search: Record<string, unknown>) {
    const loaderModule = await import("../config/loader.js");
    const realConfig = loaderModule.getConfig();
    vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      retrieval: { ...realConfig.retrieval, search: { timeoutMs: 12000, ...search } as Config["retrieval"]["search"] },
    });
    const { getTool } = await import("../tools/registry.js");
    const { clearSearchSessionState } = await import("../tools/web.js");
    return async (query: string, sessionId: string) => {
      clearSearchSessionState(sessionId);
      return getTool("web_search")!.execute({ query, maxResults: 5 }, { sessionId, workspacePath: "/workspace" });
    };
  }

  it("prints the failed backend and says the empty result is not evidence", async () => {
    const search = await searchWithConfig({ backend: "auto", searxngBaseUrl: "http://search.local" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith("http://search.local/") ? new Response("down", { status: 503 }) : ddgEmpty()));

    const r = await search("quarterly ferry timetable", "session-search-failed-backend");
    expect(r.success).toBe(true);
    expect(r.output).toContain("No results found for \"quarterly ferry timetable\" from the duckduckgo backend.");
    expect(r.output).toContain("Backends tried before it: searxng: SearXNG returned HTTP 503.");
    expect(r.output).toContain("One or more search backends FAILED — this empty result is not evidence that nothing exists.");
  });

  it("treats SearXNG's empty answer with unresponsive engines as a failure, not an empty web", async () => {
    const search = await searchWithConfig({ backend: "auto", searxngBaseUrl: "http://search.local" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith("http://search.local/")
        ? new Response(JSON.stringify({ results: [], unresponsive_engines: [["google", "timeout"], ["bing", "CAPTCHA"]] }), {
          status: 200, headers: { "Content-Type": "application/json" },
        })
        : ddgEmpty()));

    const r = await search("quarterly ferry timetable", "session-search-unresponsive");
    expect(r.output).toContain("searxng: SearXNG returned no results and 2 engine(s) did not respond: google (timeout), bing (CAPTCHA)");
    expect(r.output).toContain("not evidence that nothing exists");
  });

  it("marks results as partial when some SearXNG engines did not respond", async () => {
    const search = await searchWithConfig({ backend: "auto", searxngBaseUrl: "http://search.local" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      results: [{ title: "Ferry timetable 2026", url: "https://example.com/ferry", content: "quarterly ferry timetable" }],
      unresponsive_engines: [["google", "timeout"]],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const r = await search("quarterly ferry timetable", "session-search-partial");
    expect(r.output).toContain("via searxng");
    expect(r.output).toContain("(Partial results: 1 search engine(s) did not respond — google (timeout).)");
  });

  it("carries the direct request's HTTP status into a browser-rendered answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><body>Not here</body></html>", {
      status: 404, headers: { "Content-Type": "text/html" },
    })));
    const callTool = vi.fn(async (input: { name: string }) => input.name === "browser_evaluate"
      ? { content: [{ type: "text", text: "### Result\n\"404 — this page could not be found\"\n\n### Ran Playwright code\n```js\nawait page.evaluate()\n```" }] }
      : { content: [{ type: "text", text: "" }] });
    mcpConnections.set("playwright", { client: { callTool } });

    const { getTool } = await import("../tools/registry.js");
    const r = await getTool("web_fetch")!.execute({ url: "http://93.184.215.14/missing" }, { sessionId: "s-fetch-404", workspacePath: "/workspace" });
    expect(r.success).toBe(true);
    expect(r.output).toContain("**Content from:** http://93.184.215.14/missing (browser-rendered; a direct request was answered HTTP 404)");
    expect(r.output).toContain("404 — this page could not be found");
    expect(r.output, "the evaluate wrapper is not page text").not.toContain("### Ran Playwright code");
    expect(r.metadata?.["httpStatus"]).toBe(404);
  });

  it("fails when the browser renders no text and the direct response has none either", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><body><div id=app></div></body></html>", {
      status: 200, headers: { "Content-Type": "text/html" },
    })));
    const callTool = vi.fn(async (input: { name: string }) => input.name === "browser_evaluate"
      ? { content: [{ type: "text", text: "### Result\n\"\"" }] }
      : { content: [{ type: "text", text: "" }] });
    mcpConnections.set("playwright", { client: { callTool } });

    const { getTool } = await import("../tools/registry.js");
    const r = await getTool("web_fetch")!.execute({ url: "http://93.184.215.14/app" }, { sessionId: "s-fetch-empty", workspacePath: "/workspace" });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/returned no readable text \(HTTP 200, text\/html\); the browser rendered the page with no text\. .*this is not its content/);
  });
});

/**
 * web_fetch kept no link targets: stripHtml drops `<a href>`, innerText has none, and the snapshot
 * fallback deleted its `/url` lines. In the E2E run (2026-10-07) the researcher fetched the fixture
 * shop's start page natively, saw "Dokumentation" with no URL, guessed 14 paths into browser-rendered
 * 404s and used up its 16 web_fetch calls before reaching /dokumentation.html. Every HTML path now
 * appends the page's links after its text, inside maxLength.
 */
describe("web_fetch lists the page's links after its text", () => {
  // An IP literal: the SSRF guard needs no DNS for it.
  const SITE = "http://93.184.215.14";
  const PROSE = "Die Nordlicht Werkzeuge GmbH entwickelt und vertreibt Akkuwerkzeuge, Handwerkzeuge, "
    + "Messtechnik und Werkstattausstattung für Handwerksbetriebe in ganz Norddeutschland.";
  const JS_SHELL = "<div id=\"app\"></div><script src=\"/app.js\"></script>";

  const html = (body: string, status = 200) => new Response(`<!doctype html><html><body>${body}</body></html>`, {
    status, headers: { "Content-Type": "text/html; charset=utf-8" },
  });

  async function webFetch(args: Record<string, unknown>, sessionId: string) {
    const { getTool } = await import("../tools/registry.js");
    return getTool("web_fetch")!.execute(args, { sessionId, workspacePath: "/workspace" });
  }

  /** The section's lines after its header, or [] when the output has none. */
  function sectionOf(output: string): { header: string; lines: string[] } {
    const start = output.indexOf("[Links on this page");
    if (start < 0) return { header: "", lines: [] };
    const [header = "", ...rest] = output.slice(start).split("\n");
    const end = rest.findIndex((line) => !line.startsWith("- "));
    return { header, lines: end < 0 ? rest : rest.slice(0, end) };
  }

  // A stand-in for the page browser_evaluate runs PAGE_TEXT_AND_LINKS in.
  const anchor = (href: string, innerText: string, extra: { title?: string; aria?: string; alt?: string } = {}) => ({
    href,
    innerText,
    title: extra.title ?? "",
    getAttribute: (name: string) => (name === "aria-label" ? extra.aria ?? null : null),
    querySelector: (selector: string) => (selector === "img" && extra.alt ? { alt: extra.alt } : null),
  });

  /** Playwright MCP 1.61 running the exact `function` web_fetch sends against `document`; `evaluated` holds what it returned. */
  function browserRendering(document: unknown) {
    const evaluated: unknown[] = [];
    const callTool = vi.fn(async (input: { name: string; arguments: Record<string, unknown> }) => {
      if (input.name !== "browser_evaluate") return { content: [{ type: "text", text: "" }] };
      const value: unknown = runInNewContext(`(${String(input.arguments["function"])})()`, { document });
      evaluated.push(value);
      return {
        content: [{
          type: "text",
          text: `### Result\n${JSON.stringify(value)}\n### Ran Playwright code\n\`\`\`js\nawait page.evaluate('() => { … }');\n\`\`\``,
        }],
      };
    });
    return { callTool, evaluated };
  }

  it("lists the start page's links on the native path (the incident)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html(`
      <header><strong>Nordlicht Werkzeuge GmbH</strong>
        <nav><a href="#top">Nach oben</a>
          <a href="/index.html">Start</a>
          <a href="/produkte/seite-1.html">Produkte</a>
          <a href="/dokumentation.html">Dokumentation</a>
          <a href="/kontakt.html">Kontakt &amp; Bestellung</a>
        </nav>
      </header>
      <main>
        <h1>Werkzeug für Werkstatt und Baustelle</h1>
        <p>${PROSE}</p>
        <ul><li>Gegründet: 1987</li><li>Mitarbeiterinnen und Mitarbeiter: 146</li></ul>
        <p>Alles Wissenswerte steht in der <a href="/dokumentation.html">Dokumentation</a>.
          Partner: <a href="https://partner.example/">Partnershop</a>.
          Schreiben Sie uns: <a href="mailto:info@nordlicht-werkzeuge.test">info@nordlicht-werkzeuge.test</a></p>
      </main>`)));

    const r = await webFetch({ url: `${SITE}/` }, "s-fetch-links-native");
    expect(r.success).toBe(true);
    expect(r.metadata?.["fetchMethod"]).toBe("native");
    expect(r.output).toContain("Gegründet: 1987");
    expect(r.output.split(`- Dokumentation -> ${SITE}/dokumentation.html`)).toHaveLength(2);
    const { header, lines } = sectionOf(r.output);
    expect(header).toBe("[Links on this page — 5 of 5, same site first]");
    expect(lines).toEqual([
      `- Start -> ${SITE}/index.html`,
      `- Produkte -> ${SITE}/produkte/seite-1.html`,
      `- Dokumentation -> ${SITE}/dokumentation.html`,
      `- Kontakt & Bestellung -> ${SITE}/kontakt.html`,
      "- Partnershop -> https://partner.example/",
    ]);
    expect(r.output).not.toContain("mailto:");
    expect(r.output).not.toContain("#top");
    expect(r.metadata?.["linkCount"]).toBe(lines.length);
    expect(r.metadata?.["contentLength"]).toBe(r.output.length - `**Content from:** ${SITE}/\n\n`.length);
  });

  it("resolves links against the URL that answered after a redirect", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const requested = String(input);
      if (requested === `${SITE}/produkte`) {
        return new Response(null, { status: 302, headers: { Location: "/produkte/seite-1.html" } });
      }
      if (requested === `${SITE}/produkte/seite-1.html`) {
        return html(`<h1>Produktkatalog</h1><p>${PROSE}</p>
          <nav><a href="/produkte/seite-1.html">Produkte</a> <a href="seite-2.html">Seite 2</a> <a href="seite-3.html">Seite 3</a></nav>`);
      }
      return html("<p>Nicht gefunden</p>", 404);
    }));

    const r = await webFetch({ url: `${SITE}/produkte` }, "s-fetch-links-redirect");
    expect(r.metadata?.["fetchMethod"]).toBe("native");
    expect(r.output).toContain(`- Seite 2 -> ${SITE}/produkte/seite-2.html`);
    expect(r.output).toContain(`- Seite 3 -> ${SITE}/produkte/seite-3.html`);
    expect(r.output).not.toContain(`${SITE}/seite-2.html`);
    expect(r.output, "the page's own link is not listed").not.toContain(`-> ${SITE}/produkte/seite-1.html`);
  });

  it("lists the links on the last-resort direct fetch (native_fallback)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html("<p>Wartungsfenster heute von 22 bis 23 Uhr.</p><a href=\"/status.html\">Status</a>")));

    const r = await webFetch({ url: `${SITE}/portal` }, "s-fetch-links-fallback");
    expect(r.success).toBe(true);
    expect(r.metadata?.["fetchMethod"]).toBe("native_fallback");
    expect(r.output).toContain("Wartungsfenster heute von 22 bis 23 Uhr.");
    expect(sectionOf(r.output).lines).toEqual([`- Status -> ${SITE}/status.html`]);
    expect(r.metadata?.["linkCount"]).toBe(1);
  });

  it("reads a rendered page's text and links in the one browser_evaluate call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html(JS_SHELL)));
    const csvExport = `data:text/csv;charset=utf-8,${"Artikel;Preis%0A".repeat(400)}`;
    const { callTool, evaluated } = browserRendering({
      URL: `${SITE}/app`,
      body: { innerText: "Preisrechner\tNordlicht\n\n\n\n\nBasic 9 EUR, Pro 29 EUR" },
      links: [
        anchor(`${SITE}/dokumentation.html`, "Dokumentation"),
        anchor(`${SITE}/dokumentation.html#e31`, "  Fehlercodes  "),
        anchor(`${SITE}/app`, "Preisrechner"),
        anchor(csvExport, "CSV exportieren"),
        anchor("https://partner.example/", "", { aria: "Partnershop" }),
        anchor(`${SITE}/logo`, "", { alt: "Logo" }),
        anchor("mailto:info@nordlicht-werkzeuge.test", "Mail"),
      ],
    });
    mcpConnections.set("playwright", { client: { callTool } });

    const r = await webFetch({ url: `${SITE}/app` }, "s-fetch-links-evaluate");
    expect(r.success).toBe(true);
    expect(r.metadata?.["fetchMethod"]).toBe("playwright");
    expect(r.output, "the page text, whitespace evened out in the browser").toContain("Preisrechner Nordlicht\n\n\nBasic 9 EUR, Pro 29 EUR");
    expect(sectionOf(r.output).lines).toEqual([
      `- Dokumentation -> ${SITE}/dokumentation.html`,
      `- Logo -> ${SITE}/logo`,
      "- Partnershop -> https://partner.example/",
    ]);
    expect(r.output, "the JSON envelope is not page text").not.toContain("\"t\":");
    expect(r.output).not.toContain("### Ran Playwright code");
    expect(r.output).not.toContain("mailto:");
    expect(r.metadata?.["linkCount"]).toBe(3);
    expect(callTool.mock.calls.map(([input]) => input.name)).toEqual(["browser_navigate", "browser_evaluate"]);
    // A link too long to list is not sent back from the browser either.
    const sent = JSON.parse(String(evaluated[0])) as { l: Array<[string, string]> };
    expect(sent.l.map(([href]) => href)).not.toContain(csvExport);
    expect(String(evaluated[0]).length).toBeLessThan(1_000);
  });

  it("lists the links of the snapshot fallback, and keeps its nav labels in the text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html(JS_SHELL)));
    const snapshot = [
      "### Page",
      `- Page URL: ${SITE}/`,
      "- Page Title: Nordlicht Werkzeuge GmbH",
      "### Snapshot",
      "```yaml",
      "- generic [active] [ref=e1]:",
      "  - navigation [ref=e2]:",
      "    - link \"Contact & Ordering\" [ref=e3] [cursor=pointer]:",
      "      - /url: /kontakt.html",
      "  - main [ref=e4]:",
      "    - heading \"Werkzeug für Werkstatt und Baustelle\" [level=1] [ref=e5]",
      "    - paragraph [ref=e6]:",
      `      - text: ${PROSE}`,
      "    - paragraph [ref=e7]:",
      "      - text: Gegründet 1987, 146 Mitarbeiterinnen und Mitarbeiter, 18 Artikel in sechs Kategorien.",
      "    - listitem [ref=e8]:",
      "      - 'link \"Kundenportal: Wartungsfenster und Störungen\" [ref=e9] [cursor=pointer]':",
      "        - /url: /langsam.html",
      "```",
    ].join("\n");
    mcpConnections.set("playwright", {
      client: {
        callTool: vi.fn(async (input: { name: string }) => {
          if (input.name === "browser_evaluate") return { content: [{ type: "text", text: "evaluate unavailable" }], isError: true };
          if (input.name === "browser_snapshot") return { content: [{ type: "text", text: snapshot }] };
          return { content: [{ type: "text", text: "" }] };
        }),
      },
    });

    const r = await webFetch({ url: `${SITE}/` }, "s-fetch-links-snapshot");
    expect(r.success).toBe(true);
    expect(r.metadata?.["fetchMethod"]).toBe("playwright");
    const sectionStart = r.output.indexOf("[Links on this page");
    expect(sectionStart).toBeGreaterThan(0);
    expect(r.output.slice(0, sectionStart)).toContain("Contact & Ordering");
    expect(sectionOf(r.output).lines).toEqual([
      `- Contact & Ordering -> ${SITE}/kontakt.html`,
      `- Kundenportal: Wartungsfenster und Störungen -> ${SITE}/langsam.html`,
    ]);
  });

  it("still renders a script shell whose menu is long but whose text is short (the 200-character test reads the text alone)", async () => {
    const menu = Array.from({ length: 12 }, (_, i) => `<a href="/bereich-${i + 1}.html">${String.fromCharCode(65 + i)}</a>`).join(" ");
    vi.stubGlobal("fetch", vi.fn(async () => html(`<nav>${menu}</nav>${JS_SHELL}`)));
    mcpConnections.set("playwright", {
      client: {
        callTool: browserRendering({
          URL: `${SITE}/konto`,
          body: { innerText: "Bestellübersicht: 3 offene Aufträge, 1 Rücksendung" },
          links: [anchor(`${SITE}/bereich-1.html`, "A")],
        }).callTool,
      },
    });

    const r = await webFetch({ url: `${SITE}/konto` }, "s-fetch-links-spa");
    expect(r.metadata?.["fetchMethod"]).toBe("playwright");
    expect(r.output).toContain("Bestellübersicht: 3 offene Aufträge, 1 Rücksendung");
  });

  it("still fails an empty render that has links (emptiness reads the text, not the envelope)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => html("<div id=\"app\"></div>")));
    mcpConnections.set("playwright", {
      client: { callTool: browserRendering({ URL: `${SITE}/leer`, body: { innerText: "" }, links: [anchor(`${SITE}/start.html`, "Start")] }).callTool },
    });

    const r = await webFetch({ url: `${SITE}/leer` }, "s-fetch-links-empty");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/returned no readable text \(HTTP 200, text\/html; charset=utf-8\); the browser rendered the page with no text\./);
  });

  it("keeps a long page within maxLength: the links take their share from the end of the text", async () => {
    const prose = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(360);
    const menu = Array.from({ length: 100 }, (_, i) => `<a href="/artikel/${i + 1}.html">Artikel ${i + 1}</a>`).join(" ");
    vi.stubGlobal("fetch", vi.fn(async () => html(`<main><p>${prose}</p></main><nav>${menu}</nav>`)));

    const r = await webFetch({ url: `${SITE}/katalog`, maxLength: 8000 }, "s-fetch-links-budget");
    expect(r.metadata?.["fetchMethod"]).toBe("native");
    const { header, lines } = sectionOf(r.output);
    const shown = Number(/^\[Links on this page — (\d+) of 100, same site first; a larger maxLength lists more\]$/.exec(header)?.[1]);
    expect(shown).toBeGreaterThanOrEqual(10);
    expect(lines).toHaveLength(shown);
    const note = /\n\n\[Content truncated at \d+ chars\]/.exec(r.output)?.[0] ?? "";
    expect(note, "the text was cut").not.toBe("");
    const content = r.output.slice(`**Content from:** ${SITE}/katalog\n\n`.length);
    expect(content.length).toBeLessThanOrEqual(8000 + note.length);
  });
});

/**
 * safeFetch refuses a redirect into a private or internal host, but web_fetch caught the refusal
 * like any failed request and handed the same URL to the browser. The browser followed the
 * redirect with nothing checking it, so a public page that answered 302 with a service on the
 * private network had that service's page returned as its content.
 */
describe("web_fetch never hands the browser a URL the SSRF guard refused", () => {
  // An IP literal: the SSRF guard needs no DNS for it.
  const PUBLIC = "http://93.184.215.14";
  const INTERNAL = "QuestDB tables: trades, user_credentials";

  async function webFetch(url: string, sessionId: string) {
    const { getTool } = await import("../tools/registry.js");
    return getTool("web_fetch")!.execute({ url }, { sessionId, workspacePath: "/workspace" });
  }

  /** A browser that renders wherever it is sent, a redirect's target included: what Playwright does. */
  function followingBrowser() {
    const callTool = vi.fn(async (input: { name: string }) => input.name === "browser_evaluate"
      ? { content: [{ type: "text", text: `### Result\n${JSON.stringify(INTERNAL)}` }] }
      : { content: [{ type: "text", text: `### Snapshot\n\`\`\`yaml\n- text: ${INTERNAL}\n\`\`\`` }] });
    mcpConnections.set("playwright", { client: { callTool } });
    return callTool;
  }

  /** fetch answering from `redirects` (URL -> Location), and with the internal page for anything else. */
  function web(redirects: Record<string, string>) {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      requested.push(u);
      const location = redirects[u];
      return location !== undefined
        ? new Response(null, { status: 302, headers: { Location: location } })
        : new Response(`<html><body><p>${INTERNAL}</p></body></html>`, { status: 200, headers: { "Content-Type": "text/html" } });
    }));
    return requested;
  }

  it.each([
    ["loopback", "http://127.0.0.1:9000/exec?query=select%20*%20from%20user_credentials"],
    ["a private network", "http://10.0.0.5/admin"],
    ["the cloud-metadata endpoint", "http://169.254.169.254/latest/meta-data/"],
    ["IPv6 loopback", "http://[::1]:8080/"],
  ])("fails a redirect into %s and calls no browser tool", async (_label, target) => {
    const requested = web({ [`${PUBLIC}/go`]: target });
    const callTool = followingBrowser();

    const r = await webFetch(`${PUBLIC}/go`, "s-fetch-redirect-private");
    expect(r.success).toBe(false);
    expect(r.error).toBe(`${PUBLIC}/go redirects to a private/internal network address; fetching it is not allowed`);
    expect(r.output).not.toContain(INTERNAL);
    expect(callTool, "a browser tool was called").not.toHaveBeenCalled();
    expect(requested, "only the public URL was requested, and only once").toEqual([`${PUBLIC}/go`]);
  });

  it("fails when a later hop of the chain is the one into the private network", async () => {
    const requested = web({ [`${PUBLIC}/go`]: "/weiter", [`${PUBLIC}/weiter`]: "http://10.0.0.5/admin" });
    const callTool = followingBrowser();

    const r = await webFetch(`${PUBLIC}/go`, "s-fetch-redirect-private-hop2");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/redirects to a private\/internal network address/);
    expect(callTool).not.toHaveBeenCalled();
    expect(requested).toEqual([`${PUBLIC}/go`, `${PUBLIC}/weiter`]);
  });

  it("follows a chain past 5 redirects with every hop checked, and fails at the private one", async () => {
    const chain: Record<string, string> = {};
    for (let i = 0; i < 6; i++) chain[`${PUBLIC}/h${i}`] = `/h${i + 1}`;
    chain[`${PUBLIC}/h6`] = "http://10.0.0.5/admin";
    const requested = web(chain);
    const callTool = followingBrowser();

    const r = await webFetch(`${PUBLIC}/h0`, "s-fetch-redirect-long-chain");
    expect(r.success).toBe(false);
    expect(r.error).toBe(`${PUBLIC}/h0 redirects to a private/internal network address; fetching it is not allowed`);
    expect(r.output).not.toContain(INTERNAL);
    expect(callTool, "a browser tool was called").not.toHaveBeenCalled();
    expect(requested).toEqual(Array.from({ length: 7 }, (_, i) => `${PUBLIC}/h${i}`));
  });

  it("still hands a loop through public URLs it already checked to the browser, which keeps cookies", async () => {
    const requested = web({ [`${PUBLIC}/konto`]: "/cookie-check", [`${PUBLIC}/cookie-check`]: "/konto" });
    const callTool = vi.fn(async (input: { name: string }) => input.name === "browser_evaluate"
      ? { content: [{ type: "text", text: "### Result\n\"Kontoübersicht: 3 offene Rechnungen\"" }] }
      : { content: [{ type: "text", text: "" }] });
    mcpConnections.set("playwright", { client: { callTool } });

    const r = await webFetch(`${PUBLIC}/konto`, "s-fetch-redirect-loop");
    expect(r.success).toBe(true);
    expect(r.metadata?.["fetchMethod"]).toBe("playwright");
    expect(r.output).toContain(`**Content from:** ${PUBLIC}/konto (browser-rendered; a direct request failed (Redirect loop))`);
    expect(r.output).toContain("Kontoübersicht: 3 offene Rechnungen");
    expect(requested, "the loop is seen when the chain returns to a URL it requested").toEqual([`${PUBLIC}/konto`, `${PUBLIC}/cookie-check`]);
  });

  it("fails a chain still redirecting after 20 hops without calling the browser, which gives up there too", async () => {
    const chain: Record<string, string> = {};
    for (let i = 0; i < 30; i++) chain[`${PUBLIC}/h${i}`] = `/h${i + 1}`;
    const requested = web(chain);
    const callTool = followingBrowser();

    const r = await webFetch(`${PUBLIC}/h0`, "s-fetch-redirect-too-long");
    expect(r.success).toBe(false);
    expect(r.error).toBe(`${PUBLIC}/h0 redirects more than 20 times; it is not followed further`);
    expect(callTool, "a browser tool was called").not.toHaveBeenCalled();
    expect(requested).toEqual(Array.from({ length: 21 }, (_, i) => `${PUBLIC}/h${i}`));
  });

  it("fails a redirect off http(s) the same way", async () => {
    web({ [`${PUBLIC}/go`]: "file:///etc/passwd" });
    const callTool = followingBrowser();

    const r = await webFetch(`${PUBLIC}/go`, "s-fetch-redirect-scheme");
    expect(r.success).toBe(false);
    expect(r.error).toBe("Redirect to a non-http(s) scheme is not allowed");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("still renders the page in the browser when the direct request fails for any other reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const callTool = vi.fn(async (input: { name: string }) => input.name === "browser_evaluate"
      ? { content: [{ type: "text", text: "### Result\n\"Fahrplan: Abfahrt 7:15, Ankunft 9:40\"" }] }
      : { content: [{ type: "text", text: "" }] });
    mcpConnections.set("playwright", { client: { callTool } });

    const r = await webFetch(`${PUBLIC}/fahrplan`, "s-fetch-direct-failed");
    expect(r.success).toBe(true);
    expect(r.metadata?.["fetchMethod"]).toBe("playwright");
    expect(r.output).toContain(`**Content from:** ${PUBLIC}/fahrplan (browser-rendered; a direct request failed (fetch failed))`);
    expect(r.output).toContain("Fahrplan: Abfahrt 7:15, Ankunft 9:40");
    expect(callTool.mock.calls.map(([input]) => input.name)).toEqual(["browser_navigate", "browser_evaluate"]);
  });
});

/**
 * Only web_fetch's own requests go through the guard. The browser follows a redirect, runs the
 * page's scripts and may be answered differently from the direct request, and web_fetch returned
 * whatever page it ended on: a page that sent the browser on to a service on the private network
 * had that service's text returned as its content.
 */
describe("web_fetch checks the page the browser landed on", () => {
  // An IP literal: the SSRF guard needs no DNS for it.
  const PUBLIC = "http://93.184.215.14";
  const INTERNAL = "Grafana admin: datasource passwords";

  async function webFetch(url: string, sessionId: string) {
    const { getTool } = await import("../tools/registry.js");
    return getTool("web_fetch")!.execute({ url }, { sessionId, workspacePath: "/workspace" });
  }

  /** A direct answer with too little text to keep, so web_fetch renders the page in the browser. */
  function scriptShell() {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><body><div id=\"app\"></div><script src=\"/app.js\"></script></body></html>", {
      status: 200, headers: { "Content-Type": "text/html" },
    })));
  }

  /** Playwright MCP answering each tool with `answers[name]`, and with nothing otherwise. */
  function browser(answers: Record<string, { text: string; isError?: boolean }>) {
    const callTool = vi.fn(async (input: { name: string; arguments: Record<string, unknown> }) => ({
      content: [{ type: "text", text: answers[input.name]?.text ?? "" }],
      isError: answers[input.name]?.isError ?? false,
    }));
    mcpConnections.set("playwright", { client: { callTool } });
    return callTool;
  }

  const calls = (callTool: ReturnType<typeof browser>) => callTool.mock.calls.map(([input]) =>
    input.name === "browser_navigate" ? `navigate ${String(input.arguments["url"])}` : input.name);

  /** What PAGE_TEXT_AND_LINKS returns, as browser_evaluate's answer carries it. */
  const evaluated = (t: string, u: string) => `### Result\n${JSON.stringify(JSON.stringify({ t, u, l: [] }))}`;

  it("fails when the page's script took the browser to a private host, and sends the tab to about:blank", async () => {
    scriptShell();
    const callTool = browser({ browser_evaluate: { text: evaluated(INTERNAL, "http://10.0.0.5:3000/admin") } });

    const r = await webFetch(`${PUBLIC}/app`, "s-landing-script");
    expect(r.success).toBe(false);
    expect(r.error).toBe(`${PUBLIC}/app led the browser to a page the guard refuses (requesting private/internal network addresses is not allowed); nothing from that page is returned`);
    expect(r.output).not.toContain(INTERNAL);
    expect(calls(callTool)).toEqual([`navigate ${PUBLIC}/app`, "browser_evaluate", "navigate about:blank"]);
  });

  it("fails as soon as the navigation reports a private page, before reading anything from it", async () => {
    scriptShell();
    const callTool = browser({
      browser_navigate: { text: "### Ran Playwright code\n```js\nawait page.goto('http://93.184.215.14/app');\n```\n### Page\n- Page URL: http://169.254.169.254/latest/meta-data/\n- Page Title: \n" },
      browser_evaluate: { text: evaluated(INTERNAL, "http://169.254.169.254/latest/meta-data/") },
    });

    const r = await webFetch(`${PUBLIC}/app`, "s-landing-navigate");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/led the browser to a page the guard refuses/);
    expect(calls(callTool)).toEqual([`navigate ${PUBLIC}/app`, "navigate about:blank"]);
  });

  it("fails when the snapshot it falls back to reports a private page", async () => {
    scriptShell();
    const callTool = browser({
      browser_evaluate: { text: "evaluate unavailable", isError: true },
      browser_snapshot: { text: `### Page\n- Page URL: http://127.0.0.1:9000/\n- Page Title: QuestDB\n### Snapshot\n\`\`\`yaml\n- text: ${INTERNAL}\n\`\`\`` },
    });

    const r = await webFetch(`${PUBLIC}/app`, "s-landing-snapshot");
    expect(r.success).toBe(false);
    expect(r.output).not.toContain(INTERNAL);
    expect(calls(callTool)).toEqual([`navigate ${PUBLIC}/app`, "browser_evaluate", "browser_snapshot", "navigate about:blank"]);
  });

  it("still returns a page the browser reached on another public URL", async () => {
    scriptShell();
    const callTool = browser({
      browser_navigate: { text: `### Page\n- Page URL: ${PUBLIC}/neu\n- Page Title: Preise\n` },
      browser_evaluate: { text: evaluated("Neue Preisliste: Basic 9 EUR, Pro 29 EUR", `${PUBLIC}/neu`) },
    });

    const r = await webFetch(`${PUBLIC}/preise`, "s-landing-public");
    expect(r.success).toBe(true);
    expect(r.metadata?.["fetchMethod"]).toBe("playwright");
    expect(r.output).toContain("Neue Preisliste: Basic 9 EUR, Pro 29 EUR");
    expect(calls(callTool)).toEqual([`navigate ${PUBLIC}/preise`, "browser_evaluate"]);
  });
});

/**
 * A hop of the chain that ran past its 12 s, or a chain that crawled along hop by hop, failed the
 * direct request like any network error, and web_fetch handed the URL to the browser: a slow hop
 * was a way past the per-hop check, since the browser walks the rest of the chain unchecked.
 * Once a redirect has been followed, running out of time now ends the call.
 */
describe("web_fetch's redirect chain has a deadline", () => {
  // An IP literal: the SSRF guard needs no DNS for it.
  const PUBLIC = "http://93.184.215.14";

  afterEach(() => {
    vi.useRealTimers();
  });

  async function webFetch(url: string, sessionId: string) {
    const { getTool } = await import("../tools/registry.js");
    return getTool("web_fetch")!.execute({ url }, { sessionId, workspacePath: "/workspace" });
  }

  /** Runs `call` with fake timers, advancing them until it settles. */
  async function withFakeTime<T>(call: () => Promise<T>): Promise<T> {
    vi.useFakeTimers();
    let settled = false;
    const pending = call().finally(() => { settled = true; });
    for (let step = 0; step < 400 && !settled; step++) await vi.advanceTimersByTimeAsync(1_000);
    return pending;
  }

  type Page = { delayMs?: number; location?: string; hang?: boolean };
  /** fetch answering from `pages` after each page's delay; a hanging page answers only its abort. */
  function web(pages: Record<string, Page>) {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      const page = pages[url] ?? {};
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        if (page.hang) return;
        setTimeout(() => resolve(page.location
          ? new Response(null, { status: 302, headers: { Location: page.location } })
          : new Response(`<html><body><p>${"Lieferzeiten und Versandkosten für alle Werkzeuge. ".repeat(8)}</p></body></html>`, {
            status: 200, headers: { "Content-Type": "text/html" },
          })), page.delayMs ?? 0);
      });
    }));
    return requested;
  }

  function renderingBrowser() {
    const callTool = vi.fn(async (input: { name: string }) => input.name === "browser_evaluate"
      ? { content: [{ type: "text", text: "### Result\n\"Seite aus dem Browser\"" }] }
      : { content: [{ type: "text", text: "" }] });
    mcpConnections.set("playwright", { client: { callTool } });
    return callTool;
  }

  it("fails a chain whose third hop does not answer, without calling the browser", async () => {
    const requested = web({
      [`${PUBLIC}/a`]: { location: "/b" },
      [`${PUBLIC}/b`]: { location: "/c" },
      [`${PUBLIC}/c`]: { hang: true },
    });
    const callTool = renderingBrowser();

    const r = await withFakeTime(() => webFetch(`${PUBLIC}/a`, "s-chain-slow-hop"));
    expect(r.success).toBe(false);
    expect(r.error).toBe(`${PUBLIC}/a: the redirect chain took too long; it is not followed further`);
    expect(callTool, "a browser tool was called").not.toHaveBeenCalled();
    expect(requested).toEqual([`${PUBLIC}/a`, `${PUBLIC}/b`, `${PUBLIC}/c`]);
  });

  it("fails a chain whose hops each answer in time but together take longer than 72 s", async () => {
    const pages: Record<string, Page> = {};
    for (let i = 0; i < 8; i++) pages[`${PUBLIC}/h${i}`] = { delayMs: 11_000, location: `/h${i + 1}` };
    pages[`${PUBLIC}/h8`] = { delayMs: 11_000 };
    const requested = web(pages);
    const callTool = renderingBrowser();

    const r = await withFakeTime(() => webFetch(`${PUBLIC}/h0`, "s-chain-slow-total"));
    expect(r.success).toBe(false);
    expect(r.error).toBe(`${PUBLIC}/h0: the redirect chain took too long; it is not followed further`);
    expect(callTool).not.toHaveBeenCalled();
    expect(requested).toHaveLength(7);
  });

  it("still renders the page in the browser when the first request alone is slow", async () => {
    web({ [`${PUBLIC}/langsam`]: { hang: true } });
    const callTool = renderingBrowser();

    const r = await withFakeTime(() => webFetch(`${PUBLIC}/langsam`, "s-chain-slow-first"));
    expect(r.success).toBe(true);
    expect(r.metadata?.["fetchMethod"]).toBe("playwright");
    expect(r.output).toContain(`**Content from:** ${PUBLIC}/langsam (browser-rendered; a direct request failed (This operation was aborted))`);
    expect(callTool.mock.calls.map(([input]) => input.name)).toEqual(["browser_navigate", "browser_evaluate"]);
  });
});
