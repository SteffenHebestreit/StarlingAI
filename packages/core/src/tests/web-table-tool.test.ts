/**
 * web_table as a tool: the guarded fetch path it shares with web_fetch, its bounds, page
 * de-duplication and the browser-tab source. fetch and Playwright are mocked; the pages are the
 * e2e fixture site's.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as loaderModule from "../config/loader.js";
import type { ToolContext, ToolResult } from "../tools/registry.js";

const mcpConnections = new Map<string, unknown>();
vi.mock("../mcp/registry.js", () => ({
  getMcpConnections: () => mcpConnections,
}));

// A name on the operator's LAN for the allowlist case: it resolves to a private address. Every
// other lookup is the real one (the URLs below are IP literals, which need no DNS).
const { LAN_HOST } = vi.hoisted(() => ({ LAN_HOST: "www.nordlicht-werkzeuge.test" }));
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  const lookup = (hostname: string, options?: unknown) => hostname === LAN_HOST
    ? Promise.resolve([{ address: "172.22.0.14", family: 4 }])
    : actual.lookup(hostname, options as never);
  return { ...actual, lookup };
});

const SITE = resolve(process.cwd(), "..", "..", "eval", "e2e", "site");
const PUBLIC = "http://93.184.215.14";
const fixture = (file: string): string => readFileSync(resolve(SITE, file), "utf8");
const html = (body: string, type = "text/html; charset=utf-8", status = 200) =>
  new Response(body, { status, headers: { "Content-Type": type } });

/** fetch answering from `routes` by URL; anything else is a 404. Records every requested URL. */
function serve(routes: Record<string, () => Response>) {
  const requested: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    const route = routes[url];
    return route ? route() : html("<p>not found</p>", "text/html", 404);
  }));
  return requested;
}

/** The fixture site under PUBLIC, with /produkte/ redirecting to page 1 as the nginx config does. */
function site(extra: Record<string, () => Response> = {}) {
  return serve({
    [`${PUBLIC}/lager.html`]: () => html(fixture("lager.html")),
    [`${PUBLIC}/preise.html`]: () => html(fixture("preise.html")),
    [`${PUBLIC}/produkte/`]: () => new Response(null, { status: 302, headers: { Location: "/produkte/seite-1.html" } }),
    [`${PUBLIC}/produkte/seite-1.html`]: () => html(fixture("produkte/seite-1.html")),
    [`${PUBLIC}/produkte/seite-2.html`]: () => html(fixture("produkte/seite-2.html")),
    [`${PUBLIC}/produkte/seite-3.html`]: () => html(fixture("produkte/seite-3.html")),
    ...extra,
  });
}

let sessionCounter = 0;
function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: `sub:web-table-test:${++sessionCounter}`, workspacePath: "/workspace", allowedTools: ["web_table", "web_fetch"], ...extra };
}

async function webTable(args: Record<string, unknown>, context: ToolContext = ctx()): Promise<ToolResult> {
  const { getTool } = await import("../tools/registry.js");
  return getTool("web_table")!.execute(args, context);
}

type ContentPart = { type: string; text?: string };
/** Playwright MCP answering each tool with `answers[name]`, and with nothing otherwise. */
function browser(answers: Record<string, string>) {
  const callTool = vi.fn(async (input: { name: string; arguments: Record<string, unknown> }) => {
    const text = answers[input.name] ?? "";
    return { content: [{ type: "text", text } satisfies ContentPart], isError: false };
  });
  mcpConnections.set("playwright", { client: { callTool }, tools: [] });
  return callTool;
}
const calls = (callTool: ReturnType<typeof browser>) => callTool.mock.calls.map(([input]) =>
  input.name === "browser_navigate" ? `navigate ${String(input.arguments["url"])}` : input.name);

/** A browser_evaluate answer as Playwright MCP renders it, for the tab script's JSON. */
function tabAnswer(read: { t: string[]; u: string; l?: string; f?: unknown; c?: boolean }, pageUrl = read.u): string {
  return `### Result\n${JSON.stringify(JSON.stringify({ c: false, l: "de", f: [], ...read }))}\n### Page\n- Page URL: ${pageUrl}\n- Page Title: Seite`;
}
const lagerTable = (): string => /<table[\s\S]*<\/table>/.exec(fixture("lager.html"))![0];

beforeAll(async () => {
  await import("../tools/web-table.js");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mcpConnections.clear();
  const { setWebTableDeadlineForTests } = await import("../tools/web-table.js");
  setWebTableDeadlineForTests();
});

function allowPrivateHosts(hosts: string[]) {
  const realConfig = loaderModule.getConfig();
  vi.spyOn(loaderModule, "getConfig").mockReturnValue({
    ...realConfig,
    guardrails: { ...realConfig.guardrails, allowedPrivateHosts: hosts },
  } as typeof realConfig);
}

describe("web_table source url: the SSRF guard, before any request", () => {
  it.each([
    ["loopback", "http://127.0.0.1:9000/exec"],
    ["a private network", "http://10.0.0.5/lager.html"],
    ["the cloud-metadata endpoint", "http://169.254.169.254/latest/meta-data/"],
    ["IPv6 loopback", "http://[::1]:8080/"],
  ])("refuses %s and never calls fetch", async (_label, url) => {
    const requested = site();
    const r = await webTable({ url, column: "Südtal", aggregates: ["sum"] });
    expect(r.success).toBe(false);
    expect(r.error).toBe(`${url}: requesting private/internal network addresses is not allowed; nothing was fetched`);
    expect(requested).toEqual([]);
    expect((r.metadata?.["webTable"] as { fetchFailed?: boolean }).fetchFailed).toBe(true);
  });

  it("refuses a whole list when one URL is private: the public page is not fetched either", async () => {
    const requested = site();
    const r = await webTable({ url: [`${PUBLIC}/lager.html`, "http://10.0.0.5/lager.html"], column: "Südtal", aggregates: ["sum"] });
    expect(r.success).toBe(false);
    expect(requested).toEqual([]);
  });

  it("ends the call on a redirect into a private host, and never asks the browser", async () => {
    const requested = site({ [`${PUBLIC}/weiter`]: () => new Response(null, { status: 302, headers: { Location: "http://10.0.0.5/lager.html" } }) });
    const callTool = browser({});
    const r = await webTable({ url: `${PUBLIC}/weiter`, column: "Südtal", aggregates: ["sum"] }, ctx({ allowedTools: ["web_table", "browser_navigate"] }));
    expect(r.success).toBe(false);
    expect(r.error).toBe(`${PUBLIC}/weiter redirects to a private/internal network address; fetching it is not allowed`);
    expect(requested).toEqual([`${PUBLIC}/weiter`]);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("reads a host guardrails.allowedPrivateHosts lists, as web_fetch does", async () => {
    allowPrivateHosts([LAN_HOST]);
    const requested = serve({ [`http://${LAN_HOST}/lager.html`]: () => html(fixture("lager.html")) });
    const r = await webTable({ url: `http://${LAN_HOST}/lager.html`, column: "Südtal", aggregates: ["sum"] });
    expect(r.success).toBe(true);
    expect(r.output.split("\n")[0]).toBe("sum(column 4 \"Südtal\") = 596 — all 18 rows, 18 numeric of 18 (whole numbers)");
    expect(requested).toEqual([`http://${LAN_HOST}/lager.html`]);
  });

  it("refuses that name when it is not listed", async () => {
    const requested = serve({ [`http://${LAN_HOST}/lager.html`]: () => html(fixture("lager.html")) });
    const r = await webTable({ url: `http://${LAN_HOST}/lager.html`, column: "Südtal", aggregates: ["sum"] });
    expect(r.success).toBe(false);
    expect(requested).toEqual([]);
  });
});

describe("web_table source url: pages", () => {
  it("counts the 8 articles under 50 € over the redirecting start URL and pages 1-3, page 1 once", async () => {
    const requested = site();
    const urls = [`${PUBLIC}/produkte/`, `${PUBLIC}/produkte/seite-1.html`, `${PUBLIC}/produkte/seite-2.html`, `${PUBLIC}/produkte/seite-3.html`];
    const r = await webTable({ url: urls, aggregates: ["count", "sum"], column: "Preis", where: [{ column: "Preis", op: "<", value: 50 }] });
    expect(r.success).toBe(true);
    const lines = r.output.split("\n");
    expect(lines[0]).toBe("where column 4 \"Preis\" < 50 → 8 of 18 rows kept");
    expect(lines[1]).toBe("count = 8");
    expect(lines[2]).toBe("sum(column 4 \"Preis\") = 227,40 — 8 rows kept, 8 numeric of 8 (decimal comma, from the cells)");
    expect(r.output).toContain(`page 2 (${PUBLIC}/produkte/seite-1.html) skipped: the same page as page 1 after redirects (${PUBLIC}/produkte/seite-1.html)`);
    expect(r.output).toContain("read: 3 pages, table 1 id \"produkte\" on each, 18 rows × 5 columns, fetched directly (without the browser's session)");
    expect(requested).toEqual([`${PUBLIC}/produkte/`, `${PUBLIC}/produkte/seite-1.html`, `${PUBLIC}/produkte/seite-1.html`, `${PUBLIC}/produkte/seite-2.html`, `${PUBLIC}/produkte/seite-3.html`]);
    const meta = r.metadata?.["webTable"] as Record<string, unknown>;
    expect(meta["pagesRead"]).toBe(3);
    expect(meta["aggregates"]).toEqual({ count: "8", "sum(4 Preis)": "227,40" });
    expect(meta["computed"]).toEqual(["8", "227,40"]);
    expect(meta["fetchFailed"]).toBeUndefined();
  });

  it("requests the same URL once, its fragment ignored", async () => {
    const requested = site();
    const urls = [`${PUBLIC}/produkte/seite-1.html`, `${PUBLIC}/produkte/seite-1.html#top`, `${PUBLIC}/produkte/seite-2.html`, `${PUBLIC}/produkte/seite-3.html`];
    const r = await webTable({ url: urls, aggregates: ["count"], where: [{ column: "Preis", op: "<", value: 50 }] });
    expect(r.output.split("\n")[1]).toBe("count = 8");
    expect(requested).toEqual([`${PUBLIC}/produkte/seite-1.html`, `${PUBLIC}/produkte/seite-2.html`, `${PUBLIC}/produkte/seite-3.html`]);
  });

  it("reads a url list a model sent as a JSON string, and a where condition sent as one", async () => {
    site();
    const urls = JSON.stringify([1, 2, 3].map((n) => `${PUBLIC}/produkte/seite-${n}.html`));
    const r = await webTable({ url: urls, aggregates: "count", where: "{\"column\": \"Preis\", \"op\": \"<\", \"value\": \"50\"}" });
    expect(r.success).toBe(true);
    expect(r.output.split("\n")[1]).toBe("count = 8");
    expect((r.metadata?.["webTable"] as Record<string, unknown>)["pagesRead"]).toBe(3);
  });

  it("refuses more than 20 where conditions before fetching anything", async () => {
    const requested = site();
    const where = Array.from({ length: 21 }, () => ({ column: "Preis", op: "<", value: 50 }));
    const r = await webTable({ url: `${PUBLIC}/lager.html`, aggregates: ["count"], where });
    expect(r.success).toBe(false);
    expect(r.error).toBe("at most 20 where conditions; 21 were given");
    expect(r.rejectedBeforeEffect).toBe(true);
    expect(requested).toEqual([]);
    expect((await webTable({ url: `${PUBLIC}/lager.html`, aggregates: ["count"], where: where.slice(0, 20).map((c) => ({ ...c, column: "Südtal", value: 1_000 })) })).success).toBe(true);
  });

  it("refuses 11 distinct URLs before fetching any", async () => {
    const requested = site();
    const r = await webTable({ url: Array.from({ length: 11 }, (_, i) => `${PUBLIC}/p${i}.html`), aggregates: ["count"] });
    expect(r.success).toBe(false);
    expect(r.error).toBe("at most 10 pages per call; 11 were given. Call again for the rest");
    expect(r.rejectedBeforeEffect).toBe(true);
    expect(requested).toEqual([]);
  });

  it("stops a body that never ends at the call deadline, cancels its reader and requests no further page", async () => {
    const { setWebTableDeadlineForTests } = await import("../tools/web-table.js");
    setWebTableDeadlineForTests(300);
    let cancelled = false;
    const requested = site({
      [`${PUBLIC}/endlos.html`]: () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<table><tr><td>a</td><td>1</td></tr>"));
        },
        cancel() {
          cancelled = true;
        },
      }), { status: 200, headers: { "Content-Type": "text/html" } }),
    });
    const started = Date.now();
    const r = await webTable({ url: [`${PUBLIC}/endlos.html`, `${PUBLIC}/lager.html`], aggregates: ["count"] });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(r.success).toBe(false);
    expect(r.error).toBe(`stopped at the call's 0.3 s deadline; 0 of 2 pages had been read (${PUBLIC}/endlos.html was not); nothing was computed`);
    expect(cancelled).toBe(true);
    expect(requested).toEqual([`${PUBLIC}/endlos.html`]);
  });

  it("requests no further page once the turn is stopped", async () => {
    const controller = new AbortController();
    const requested = site();
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await realFetch(input, init);
      controller.abort();
      return response;
    }));
    const r = await webTable({ url: [`${PUBLIC}/produkte/seite-1.html`, `${PUBLIC}/produkte/seite-2.html`], aggregates: ["count"] }, ctx({ signal: controller.signal }));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^stopped: the turn was stopped; 0 of 2 pages had been read/);
    expect(requested).toEqual([`${PUBLIC}/produkte/seite-1.html`]);
  });

  it("puts column names into its metadata as the output shows them: at most 40, each at most 60 characters", async () => {
    // metadata.webTable reaches the audit log, its Postgres sink and the dashboard. A 4.8 MB
    // header text spanning 40 columns put 192 MB of page text there.
    const huge = "x".repeat(4_800_000);
    site({
      [`${PUBLIC}/breit.html`]: () => html(`<table><thead><tr><th>Artikel</th><th colspan=45>${huge}</th></tr></thead>`
        + `<tbody><tr><td>A</td>${"<td>1</td>".repeat(45)}</tr></tbody></table>`),
    });
    const r = await webTable({ url: `${PUBLIC}/breit.html`, column: "2", aggregates: ["sum"] });
    expect(r.success, r.error).toBe(true);
    const columns = (r.metadata?.["webTable"] as { columns: string[] }).columns;
    expect(columns).toHaveLength(40);
    expect(columns[0]).toBe("Artikel");
    expect(columns[1]).toBe(`${"x".repeat(59)}…`);
    expect(columns.every((name) => [...name].length <= 60)).toBe(true);
    expect(JSON.stringify(r.metadata).length).toBeLessThan(4_000);
  });

  it("fails on a 404 page with its status, computing nothing over the error page", async () => {
    site({ [`${PUBLIC}/weg.html`]: () => html(fixture("lager.html"), "text/html", 404) });
    const r = await webTable({ url: `${PUBLIC}/weg.html`, column: "Südtal", aggregates: ["sum"] });
    expect(r.success).toBe(false);
    expect(r.error).toBe(`HTTP 404 from ${PUBLIC}/weg.html; nothing was computed`);
    expect(r.output).toBe("");
  });

  it("fails on a page that is not HTML, naming its type", async () => {
    site({ [`${PUBLIC}/lager.csv`]: () => html("Artikel;Bestand\nA;1\n", "text/csv") });
    const r = await webTable({ url: `${PUBLIC}/lager.csv`, aggregates: ["count"] });
    expect(r.success).toBe(false);
    expect(r.error).toBe(`${PUBLIC}/lager.csv is text/csv, not an HTML page; web_table reads the tables of HTML pages`);
  });

  it("says when the last page links a next page the call did not read", async () => {
    site();
    const r = await webTable({ url: [`${PUBLIC}/produkte/seite-1.html`, `${PUBLIC}/produkte/seite-2.html`], aggregates: ["count"] });
    expect(r.output).toContain(`the last page links a next page (rel=next): ${PUBLIC}/produkte/seite-3.html; it was not read`);
    const all = await webTable({ url: [1, 2, 3].map((n) => `${PUBLIC}/produkte/seite-${n}.html`), aggregates: ["count"] });
    expect(all.output).not.toContain("rel=next");
  });

  it("reads at most 40 pages per run, counted per session and reset when the run ends", async () => {
    site(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`${PUBLIC}/p/${i}.html`, () => html(fixture("lager.html"))])));
    const { clearWebTableSessionState } = await import("../tools/web-table.js");
    const run = ctx();
    for (let call = 0; call < 4; call++) {
      const r = await webTable({ url: Array.from({ length: 10 }, (_, i) => `${PUBLIC}/p/${call * 10 + i}.html`), aggregates: ["count"] }, run);
      expect(r.success, r.error).toBe(true);
    }
    const over = await webTable({ url: `${PUBLIC}/lager.html`, aggregates: ["count"] }, run);
    expect(over.success).toBe(false);
    expect(over.error).toBe("this run has read 40 pages with web_table, and 1 more would pass its 40; compute from what was read");
    expect((await webTable({ url: `${PUBLIC}/lager.html`, aggregates: ["count"] }, ctx())).success).toBe(true);
    clearWebTableSessionState(run.sessionId);
    expect((await webTable({ url: `${PUBLIC}/lager.html`, aggregates: ["count"] }, run)).success).toBe(true);
  });

  it("answers a page without a <table> with a hint built from the caller's own tools", async () => {
    site({ [`${PUBLIC}/lieferstatus.html`]: () => html(fixture("lieferstatus.html")) });
    const driver = await webTable({ url: `${PUBLIC}/lieferstatus.html`, aggregates: ["count"] }, ctx({ allowedTools: ["web_table", "browser_navigate", "browser_snapshot"] }));
    expect(driver.success).toBe(false);
    expect(driver.error).toContain("open the page in the browser, wait for the table, then call web_table with source \"tab\"");
    expect((driver.metadata?.["webTable"] as { fetchFailed?: boolean }).fetchFailed).toBe(true);
    const reader = await webTable({ url: `${PUBLIC}/lieferstatus.html`, aggregates: ["count"] }, ctx({ allowedTools: ["web_table", "web_fetch", "browser_snapshot"] }));
    expect(reader.error).toBe("the page has no <table> in its HTML; the table may be drawn by script; web_fetch reads the page's text");
    expect((reader.metadata?.["webTable"] as { fetchFailed?: boolean }).fetchFailed).toBe(true);
  });

  it("leaves fetchFailed unset on an argument error, which reaches no page", async () => {
    const requested = site();
    const r = await webTable({ url: `${PUBLIC}/lager.html`, column: "Gewicht", aggregates: ["sum"] });
    expect(r.success).toBe(false);
    expect(r.error).toContain("no table has the column(s) \"Gewicht\"");
    expect((r.metadata?.["webTable"] as { fetchFailed?: boolean }).fetchFailed).toBeUndefined();
    const bad = await webTable({ url: `${PUBLIC}/lager.html`, aggregates: ["median"] });
    expect(bad.error).toBe("aggregates may hold sum, count, min, max, avg; \"median\" is none of them");
    expect(bad.metadata).toBeUndefined();
    expect(requested).toEqual([`${PUBLIC}/lager.html`]);
  });
});

describe("web_table source tab", () => {
  const driver = () => ctx({ allowedTools: ["web_table", "browser_navigate", "browser_click", "browser_snapshot"] });

  it("reads the tables of the page the tab shows with one evaluate, and never navigates", async () => {
    const requested = serve({});
    const callTool = browser({ browser_evaluate: tabAnswer({ t: [lagerTable()], u: `${PUBLIC}/lager.html` }) });
    const r = await webTable({ source: "tab", column: "Südtal", aggregates: ["sum"] }, driver());
    expect(r.success, r.error).toBe(true);
    expect(r.output.split("\n")[0]).toBe("sum(column 4 \"Südtal\") = 596 — all 18 rows, 18 numeric of 18 (whole numbers)");
    expect(r.output).toContain(`read: ${PUBLIC}/lager.html, table 1 id "lagerbestand", 18 rows × 6 columns, read from the browser tab showing ${PUBLIC}/lager.html`);
    expect(calls(callTool)).toEqual(["browser_evaluate"]);
    expect(requested).toEqual([]);
  });

  it("refuses a tab on a private host and sends the tab to about:blank", async () => {
    const callTool = browser({ browser_evaluate: tabAnswer({ t: [lagerTable()], u: "http://10.0.0.5/lager.html" }) });
    const r = await webTable({ source: "tab", column: "Südtal", aggregates: ["sum"] }, driver());
    expect(r.success).toBe(false);
    expect(r.error).toBe("Refusing to read the page the browser is on: requesting private/internal network addresses is not allowed. The browser was sent to about:blank.");
    expect(JSON.stringify(r)).not.toContain("596");
    expect(calls(callTool)).toEqual(["browser_evaluate", "navigate about:blank"]);
  });

  it("refuses a tab whose page frames a private host", async () => {
    const callTool = browser({ browser_evaluate: tabAnswer({ t: [lagerTable()], u: `${PUBLIC}/lager.html`, f: ["http://169.254.169.254/latest/meta-data/"] }) });
    const r = await webTable({ source: "tab", column: "Südtal", aggregates: ["sum"] }, driver());
    expect(r.success).toBe(false);
    expect(r.error).toBe("Refusing to read the page the browser is on: a frame on it: requesting private/internal network addresses is not allowed. The browser was sent to about:blank.");
    expect(calls(callTool)).toEqual(["browser_evaluate", "navigate about:blank"]);
  });

  it("refuses a caller that only views the tab, without calling the browser", async () => {
    const callTool = browser({ browser_evaluate: tabAnswer({ t: [lagerTable()], u: `${PUBLIC}/lager.html` }) });
    const r = await webTable({ source: "tab", column: "Südtal", aggregates: ["sum"] }, ctx({ allowedTools: ["web_table", "browser_snapshot", "browser_screenshot"] }));
    expect(r.success).toBe(false);
    expect(r.error).toContain("this agent has no browser tool that opens pages");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("names the page the tab shows when the url given is another", async () => {
    browser({ browser_evaluate: tabAnswer({ t: [lagerTable()], u: `${PUBLIC}/lager.html` }) });
    const r = await webTable({ source: "tab", url: `${PUBLIC}/preise.html`, aggregates: ["count"] }, driver());
    expect(r.success).toBe(false);
    expect(r.error).toBe(`the browser tab shows ${PUBLIC}/lager.html, not ${PUBLIC}/preise.html; open that page in the browser first, or give its URL with source "url"`);
    const same = await webTable({ source: "tab", url: `${PUBLIC}/lager.html#mitte`, aggregates: ["count"] }, driver());
    expect(same.success).toBe(true);
  });
});

describe("web_table tier", () => {
  it("is a tier-0 read with no approval and no sandbox", async () => {
    const { getToolTier } = await import("../guardrails/tool-tiers.js");
    expect(getToolTier("web_table")).toMatchObject({ tier: 0, requiresPerCallApproval: false, requiresSandbox: false });
  });
});
