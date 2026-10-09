/**
 * web_table: the tables of a web page, or of every page of a paginated table, as rows, and a
 * column's sum, count, min, max or avg computed over every row (tools/html-tables.ts).
 *
 * E2E 2026-10-08/09: agents asked for a total or a count over a table read the page and did the
 * arithmetic themselves. browser_agent answered 609 for a stock total of 596 (one cell misread,
 * then its own 18 terms added wrongly) and 6, 7 and 9 for 8 articles under 50 €; the researcher's
 * correct 596 became 740 after a coverage re-synthesis invented four rows. Values and totals now
 * never pass through the model: it names a column and a condition, this tool computes.
 *
 * Two sources. "url" (the default) fetches the pages through web_fetch's guarded path: every URL
 * is checked by checkUrlSsrf before any request and one refusal fails the call; safeFetchFinal
 * re-checks every redirect hop and connects through the DNS-pinned guardedDispatcher; an
 * SsrfRefusal ends the call. There is no browser fallback: a table drawn by script is read with
 * "tab" by an agent that drives the browser. "tab" reads the tables of the page the agent's
 * browser tab shows now, with one browser_evaluate and no navigation, and checks that page and its
 * frames as browser_axe_audit does.
 *
 * Bounded: 10 pages, 20 where conditions and 90 s per call, the deadline enforced inside every
 * body read and the turn's abort signal honoured; 5 MB per page and 10 MB per call; 40 pages per
 * run (the sub-agent run's own session id), and the run's call cap in SUB_AGENT_PER_TOOL_CAPS.
 */
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { getMcpConnections } from "../mcp/registry.js";
import { coerceJsonArrayArg } from "./json-arg-coercion.js";
import { chargeWebTablePages, WEB_TABLE_PAGES_PER_RUN, webTablePagesUsed } from "./web-table-budget.js";
import {
  AGGREGATES,
  computeTables,
  CONDITION_OPS,
  decodeHtmlBytes,
  displayText,
  newCellBudget,
  parseHtmlTables,
  shownColumnName,
  type AggregateName,
  type CellBudget,
  type ComputeResult,
  type Condition,
  type ConditionOp,
  type PageInput,
  type TableQuery,
} from "./html-tables.js";

const log = childLogger("tool:web_table");

export const WEB_TABLE_LIMITS = Object.freeze({
  pagesPerCall: 10,
  pagesPerRun: WEB_TABLE_PAGES_PER_RUN,
  pageBytes: 5 * 1024 * 1024,
  callBytes: 10 * 1024 * 1024,
  /** Redirects per page: a table page needs no long sign-in chain (web_fetch follows 20). */
  redirects: 5,
  /** Per request, as web_fetch's direct GET. */
  requestMs: 12_000,
  /** What the tab source reads of the page: at most this many top-level tables and characters. */
  tabTables: 50,
  tabChars: 2_000_000,
  whereConditions: 20,
});

/** The call deadline. The registry's own 120 s timeout is a race that does not stop the handler. */
let callDeadlineMs = 90_000;

/** Shortens the call deadline for a test; with no argument, restores the default. */
export function setWebTableDeadlineForTests(ms?: number): void {
  callDeadlineMs = ms ?? 90_000;
}

// ─── Pages per run ────────────────────────────────────────────────────────────
// Counted in tools/web-table-budget.ts, which the sub-agent loop clears at run end.

export { clearWebTableSessionState } from "./web-table-budget.js";

// ─── Arguments ────────────────────────────────────────────────────────────────

interface Request {
  source: "url" | "tab";
  urls: string[];
  query: TableQuery;
}

function argumentError(message: string): ToolResult {
  return { success: false, output: "", error: message, rejectedBeforeEffect: true };
}

/** A real array, a single value, or a string holding a JSON array or object, as an array. */
function asList(value: unknown): unknown[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const coerced = coerceJsonArrayArg(value);
  return Array.isArray(coerced) ? coerced : [coerced];
}

/** A table, column or group_by argument: a string, or a number given as one. */
function asName(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  return value.trim() ? value.trim() : undefined;
}

function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
}

/** A URL as compared for duplicates: parsed (host case, default port) and without its fragment. */
function comparableUrl(url: string): string {
  try {
    return withoutFragment(new URL(url).href);
  } catch {
    return withoutFragment(url.trim());
  }
}

function parseRequest(args: Record<string, unknown>): Request | string {
  const sourceArg = args["source"];
  if (sourceArg !== undefined && sourceArg !== null && sourceArg !== "" && sourceArg !== "url" && sourceArg !== "tab") {
    return `source must be "url" or "tab", not ${JSON.stringify(sourceArg)}`;
  }
  const source = sourceArg === "tab" ? "tab" : "url";

  const urlList = asList(args["url"]) ?? [];
  if (urlList.some((url) => typeof url !== "string")) return "url must be a URL or a list of URLs";
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const url of urlList as string[]) {
    const trimmed = url.trim();
    if (!trimmed) continue;
    const key = comparableUrl(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(trimmed);
  }
  if (source === "url" && urls.length === 0) return "url is required: the page's URL, or the URLs of all pages of one table in order";
  if (source === "url" && urls.length > WEB_TABLE_LIMITS.pagesPerCall) {
    return `at most ${WEB_TABLE_LIMITS.pagesPerCall} pages per call; ${urls.length} were given. Call again for the rest`;
  }
  if (source === "tab" && urls.length > 1) return "source \"tab\" reads the one page the browser tab shows; give at most one url, the tab's";

  const aggregateList = asList(args["aggregates"]);
  const aggregates: AggregateName[] = [];
  for (const entry of aggregateList ?? []) {
    const name = typeof entry === "string" ? entry.trim().toLowerCase() : entry;
    if (!(AGGREGATES as readonly unknown[]).includes(name)) return `aggregates may hold ${AGGREGATES.join(", ")}; ${JSON.stringify(entry)} is none of them`;
    aggregates.push(name as AggregateName);
  }

  const whereList = asList(args["where"]);
  // Each condition resolves its column against a header of up to 100,000 columns and passes over
  // every row: an unbounded list held the event loop for as long as the list was long.
  if (whereList && whereList.length > WEB_TABLE_LIMITS.whereConditions) {
    return `at most ${WEB_TABLE_LIMITS.whereConditions} where conditions; ${whereList.length} were given`;
  }
  const where: Condition[] = [];
  for (const entry of whereList ?? []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "where must be a list of conditions like {\"column\": \"Preis\", \"op\": \"<\", \"value\": 50}";
    const condition = entry as Record<string, unknown>;
    const column = asName(condition["column"]);
    const op = typeof condition["op"] === "string" ? condition["op"].trim().toLowerCase() : "";
    const value = condition["value"];
    if (!column) return "every where condition needs a column";
    if (!(CONDITION_OPS as readonly string[]).includes(op)) return `a where condition's op is one of ${CONDITION_OPS.join(" ")}; ${JSON.stringify(condition["op"])} is none of them`;
    if (typeof value !== "number" && typeof value !== "string") return "every where condition needs a value, a number or a text";
    where.push({ column, op: op as ConditionOp, value });
  }

  const query: TableQuery = {};
  const table = asName(args["table"]);
  const column = asName(args["column"]);
  const groupBy = asName(args["group_by"]);
  if (table !== undefined) query.table = table;
  if (column !== undefined) query.column = column;
  if (groupBy !== undefined) query.groupBy = groupBy;
  if (aggregates.length > 0) query.aggregates = aggregates;
  if (where.length > 0) query.where = where;
  return { source, urls, query };
}

// ─── Stopping ─────────────────────────────────────────────────────────────────

class Stopped extends Error {
  constructor(readonly why: "deadline" | "aborted") {
    super(why);
  }
}

/** Resolves `work`, or rejects with Stopped at the deadline or on the turn's abort, whichever comes first. */
async function bounded<T>(work: Promise<T>, deadline: number, signal: AbortSignal | undefined): Promise<T> {
  if (signal?.aborted) throw new Stopped("aborted");
  const left = deadline - Date.now();
  if (left <= 0) throw new Stopped("deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Stopped("deadline")), left);
    if (signal) {
      onAbort = () => reject(new Stopped("aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([work, stop]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function stoppedText(why: Stopped["why"]): string {
  return why === "aborted" ? "stopped: the turn was stopped" : `stopped at the call's ${callDeadlineMs / 1000} s deadline`;
}

/**
 * The body, read here and not by res.text(): safeFetchFinal stops its timer once the headers
 * arrive, so a body that never ends would hold the call until the registry's race gave up on it,
 * with the read still running. Every read races the deadline and the turn's abort; at either the
 * reader is cancelled. A body past `maxBytes` is cancelled there and returned as cut.
 */
async function readBody(res: Response, maxBytes: number, deadline: number, signal: AbortSignal | undefined): Promise<{ bytes: Uint8Array; cut: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), cut: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cut = false;
  try {
    for (;;) {
      const { done, value } = await bounded(reader.read(), deadline, signal);
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        cut = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (err) {
    void reader.cancel().catch(() => undefined);
    throw err;
  }
  if (cut) void reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, cut };
}

function discardBody(res: Response): void {
  void res.body?.cancel().catch(() => undefined);
}

function isHtmlContentType(contentType: string): boolean {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return type === "" || type === "text/html" || type === "application/xhtml+xml";
}

// ─── Results ──────────────────────────────────────────────────────────────────

interface WebTableMeta {
  source: "url" | "tab";
  urls: string[];
  finalUrls?: string[];
  pagesRead?: number;
  pagesSkipped?: Array<{ page: number; reason: string }>;
  table?: string;
  rows?: number;
  columns?: string[];
  aggregates?: Record<string, string>;
  fetchFailed?: true;
}

/** A fetch-level failure (status, guard refusal, network, deadline, no table): the run's dead-fetch streak counts it. */
function fetchFailure(error: string, meta: WebTableMeta): ToolResult {
  return { success: false, output: "", error, metadata: { webTable: { ...meta, fetchFailed: true } } };
}

/** The hint for a source with no table, from the caller's own tools. */
function noTableHint(drives: boolean, source: "url" | "tab"): string {
  if (source === "tab") return "the page the browser tab shows has no <table> (yet); wait for the table to appear, then call web_table with source \"tab\" again";
  return drives
    ? "the page has no <table> in its HTML; the table may be drawn by script: open the page in the browser, wait for the table, then call web_table with source \"tab\""
    : "the page has no <table> in its HTML; the table may be drawn by script; web_fetch reads the page's text";
}

async function drivesBrowser(ctx: ToolContext): Promise<boolean> {
  const { agentCfgDrivesSharedBrowser } = await import("./agent-routing.js");
  return agentCfgDrivesSharedBrowser({ tools: ctx.allowedTools ?? [] });
}

async function finish(result: ComputeResult, meta: WebTableMeta, ctx: ToolContext): Promise<ToolResult> {
  if (!result.ok) {
    if (result.noTable) return fetchFailure(noTableHint(meta.source === "tab" || await drivesBrowser(ctx), meta.source), meta);
    return { success: false, output: "", error: result.error, metadata: { webTable: meta } };
  }
  return {
    success: true,
    output: result.output,
    metadata: {
      webTable: {
        ...meta,
        pagesSkipped: [...(meta.pagesSkipped ?? []), ...result.pagesSkipped],
        table: result.table,
        rows: result.rows,
        // As the output shows them. The audit log, its Postgres sink and the dashboard receive
        // this; a 4.8 MB header text spanning 40 columns once put 192 MB of page text there.
        columns: result.columns.slice(0, 40).map(shownColumnName),
        aggregates: result.aggregates,
      },
    },
  };
}

// ─── Source "url" ─────────────────────────────────────────────────────────────

const REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; StarlingAI/0.1; +https://starlingai.io)",
  "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
};

async function fromUrls(request: Request, ctx: ToolContext): Promise<ToolResult> {
  const web = await import("./web.js");
  const meta: WebTableMeta = { source: "url", urls: request.urls };
  // Every URL before any request: one the guard refuses fails the whole call, nothing fetched.
  for (const url of request.urls) {
    const refused = await web.checkUrlSsrf(url);
    if (refused) return fetchFailure(`${url}: ${refused}; nothing was fetched`, meta);
  }
  const used = webTablePagesUsed(ctx.sessionId);
  if (used + request.urls.length > WEB_TABLE_LIMITS.pagesPerRun) {
    return {
      success: false,
      output: "",
      error: `this run has read ${used} pages with web_table, and ${request.urls.length} more would pass its ${WEB_TABLE_LIMITS.pagesPerRun}; compute from what was read`,
    };
  }

  const deadline = Date.now() + callDeadlineMs;
  const budget: CellBudget = newCellBudget();
  const pages: PageInput[] = [];
  const finalUrls: string[] = [];
  const finalByPage = new Map<string, number>();
  const notes: string[] = [];
  const skipped: Array<{ page: number; reason: string }> = [];
  let bytesLeft = WEB_TABLE_LIMITS.callBytes;
  let lastRead: { nextHref: string | null; finalUrl: string } | null = null;

  for (let index = 0; index < request.urls.length; index++) {
    const url = request.urls[index]!;
    const page = index + 1;
    try {
      if (ctx.signal?.aborted) throw new Stopped("aborted");
      const left = deadline - Date.now();
      if (left <= 0) throw new Stopped("deadline");
      chargeWebTablePages(ctx.sessionId, 1);
      const fetching = web.safeFetchFinal(url, Math.min(WEB_TABLE_LIMITS.requestMs, left), { headers: REQUEST_HEADERS }, WEB_TABLE_LIMITS.redirects, left);
      // An answer that arrives after the call stopped waiting is not read.
      fetching.then(({ res }) => {
        if (ctx.signal?.aborted || Date.now() >= deadline) discardBody(res);
      }, () => undefined);
      const { res, finalUrl } = await bounded(fetching, deadline, ctx.signal);
      const finalKey = comparableUrl(finalUrl);
      const earlier = finalByPage.get(finalKey);
      if (earlier !== undefined) {
        discardBody(res);
        const reason = `the same page as page ${earlier} after redirects (${finalUrl})`;
        skipped.push({ page, reason });
        notes.push(`page ${page} (${url}) skipped: ${reason}`);
        continue;
      }
      if (res.status < 200 || res.status > 299) {
        discardBody(res);
        return fetchFailure(`HTTP ${res.status} from ${url}${index > 0 ? ` (page ${page})` : ""}; nothing was computed`, { ...meta, finalUrls });
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (!isHtmlContentType(contentType)) {
        discardBody(res);
        return fetchFailure(`${url} is ${contentType.split(";")[0]!.trim()}, not an HTML page; web_table reads the tables of HTML pages`, { ...meta, finalUrls });
      }
      const { bytes, cut } = await readBody(res, Math.min(WEB_TABLE_LIMITS.pageBytes, bytesLeft), deadline, ctx.signal);
      bytesLeft -= bytes.byteLength;
      const decoded = decodeHtmlBytes(bytes, contentType);
      if (decoded.unknownLabel) notes.push(`page ${page}: unknown charset ${JSON.stringify(displayText(decoded.unknownLabel).slice(0, 40))}, read as UTF-8`);
      if (cut) notes.push(`page ${page} (${url}) was cut at ${bytes.byteLength} bytes; what came after was not read`);
      const doc = parseHtmlTables(decoded.text, budget, { cut });
      finalByPage.set(finalKey, page);
      finalUrls.push(finalUrl);
      pages.push({ page, url, doc });
      lastRead = { nextHref: doc.nextHref, finalUrl };
      // One page's parse at a time: the event loop serves other turns between pages.
      await new Promise<void>((resolve) => setImmediate(resolve));
    } catch (err) {
      if (err instanceof Stopped) {
        log.info({ url, why: err.why }, "web_table stopped before reading every page");
        return fetchFailure(`${stoppedText(err.why)}; ${pages.length} of ${request.urls.length} pages had been read (${url} was not); nothing was computed`, { ...meta, finalUrls });
      }
      if (err instanceof web.SsrfRefusal) {
        log.warn({ url, reason: err.message }, "web_table: the SSRF guard refused a host on the way");
        return fetchFailure(err.message, { ...meta, finalUrls });
      }
      return fetchFailure(`fetching ${url} failed: ${err instanceof Error ? err.message : String(err)}`, { ...meta, finalUrls });
    }
  }

  // A pager the call did not follow: the last page read links its next page.
  if (lastRead?.nextHref) {
    try {
      const next = new URL(lastRead.nextHref, lastRead.finalUrl);
      const key = comparableUrl(next.href);
      const known = new Set([...request.urls.map(comparableUrl), ...finalUrls.map(comparableUrl)]);
      if (/^https?:$/.test(next.protocol) && !known.has(key)) {
        notes.unshift(`the last page links a next page (rel=next): ${displayText(next.href).slice(0, 300)}; it was not read`);
      }
    } catch {
      // not a URL: no hint
    }
  }

  const result = computeTables(pages, request.query, { sourceNote: "fetched directly (without the browser's session)", notes });
  return finish(result, { ...meta, finalUrls, pagesRead: pages.length, pagesSkipped: skipped }, ctx);
}

// ─── Source "tab" ─────────────────────────────────────────────────────────────

async function fromTab(request: Request, ctx: ToolContext): Promise<ToolResult> {
  const meta: WebTableMeta = { source: "tab", urls: request.urls };
  // The tab is shared: an agent that only views it would read whatever page another session left
  // there (vision_browser_analyst, E2E 2026-10-08). Only an agent that opens pages itself reads it.
  if (!(await drivesBrowser(ctx))) {
    return argumentError("source \"tab\" reads the page this agent opened in the browser, and this agent has no browser tool that opens pages; give the page's URL instead (source \"url\")");
  }
  if (!getMcpConnections().has("playwright")) return fetchFailure("the browser is not connected; give the page's URL instead (source \"url\")", meta);
  if (webTablePagesUsed(ctx.sessionId) + 1 > WEB_TABLE_LIMITS.pagesPerRun) {
    return { success: false, output: "", error: `this run has read ${webTablePagesUsed(ctx.sessionId)} pages with web_table, its limit is ${WEB_TABLE_LIMITS.pagesPerRun}; compute from what was read` };
  }
  const web = await import("./web.js");
  const { callPlaywrightTool } = await import("./multimodal.js");
  const deadline = Date.now() + callDeadlineMs;
  const script = `() => {
  const all = Array.from(document.querySelectorAll('table'));
  const top = all.filter((t) => !(t.parentElement && t.parentElement.closest('table')));
  const out = [];
  let size = 0;
  let cut = false;
  for (const t of top) {
    const html = t.outerHTML;
    if (out.length >= ${WEB_TABLE_LIMITS.tabTables} || size + html.length > ${WEB_TABLE_LIMITS.tabChars}) { cut = true; break; }
    out.push(html);
    size += html.length;
  }
  return JSON.stringify({ t: out, c: cut, u: document.URL, l: (document.documentElement && document.documentElement.lang) || '', f: ${web.FRAME_ADDRESSES} });
}`;
  let report: string;
  try {
    chargeWebTablePages(ctx.sessionId, 1);
    report = await bounded(callPlaywrightTool("browser_evaluate", { function: script }), deadline, ctx.signal);
  } catch (err) {
    if (err instanceof Stopped) return fetchFailure(`${stoppedText(err.why)}; the browser tab's tables were not read`, meta);
    return fetchFailure(`the browser tab's tables could not be read: ${err instanceof Error ? err.message : String(err)}`, meta);
  }
  let read: { t?: unknown; c?: unknown; u?: unknown; l?: unknown; f?: unknown } = {};
  try {
    const value: unknown = JSON.parse(web.evaluateResultText(report));
    if (value && typeof value === "object") read = value as typeof read;
  } catch {
    // checked below: no address, no tables
  }
  const tabUrl = typeof read.u === "string" ? read.u : "";
  // The page and its frames are checked before anything from them is used, as browser_axe_audit does.
  const refuse = async (reason: string): Promise<ToolResult> => {
    await web.leaveRefusedPage();
    return fetchFailure(`Refusing to read the page the browser is on: ${reason}. The browser was sent to about:blank.`, meta);
  };
  if (!tabUrl) return refuse("its address could not be read");
  const landing = await web.refusedBrowserPage([tabUrl, ...web.reportedPageUrls(report)]);
  if (landing) return refuse(landing);
  const framed = await web.refusedFrameUrls(read.f);
  if (framed) return refuse(framed);
  if (request.urls.length === 1 && comparableUrl(request.urls[0]!) !== comparableUrl(tabUrl)) {
    return {
      success: false,
      output: "",
      error: `the browser tab shows ${displayText(tabUrl).slice(0, 300)}, not ${request.urls[0]}; open that page in the browser first, or give its URL with source "url"`,
      metadata: { webTable: { ...meta, finalUrls: [tabUrl] } },
    };
  }
  const tables = Array.isArray(read.t) ? read.t.filter((entry): entry is string => typeof entry === "string") : [];
  const cut = read.c === true;
  const doc = parseHtmlTables(tables.join("\n"), newCellBudget(), { cut });
  doc.lang = typeof read.l === "string" && read.l.trim() ? read.l.trim() : null;
  const notes = cut ? [`the page has more tables than were read (at most ${WEB_TABLE_LIMITS.tabTables}, ${WEB_TABLE_LIMITS.tabChars} characters)`] : [];
  const shown = displayText(tabUrl).slice(0, 300);
  const result = computeTables([{ page: 1, url: tabUrl, doc }], request.query, { sourceNote: `read from the browser tab showing ${shown}`, notes });
  return finish(result, { ...meta, urls: [tabUrl], finalUrls: [tabUrl], pagesRead: 1, pagesSkipped: [] }, ctx);
}

// ─── Registration ─────────────────────────────────────────────────────────────

registerTool({
  name: "web_table",
  description:
    "Read the tables of a web page — or of every page of a paginated table — as rows, and compute "
    + "sum, count, min, max or avg of a column over all rows, optionally filtered (where) or per group "
    + "(group_by). Use it for any total, count or extreme taken from a table instead of adding up or "
    + "counting rows yourself. By default it fetches the URL(s) directly, without the browser's login "
    + "or page state; source \"tab\" reads the page your browser tab shows now.",
  embeddingDescription:
    "Extract HTML tables from a web page as rows; sum, count, minimum, maximum, average, filter and "
    + "group a table column deterministically across one or more pages.",
  parameters: {
    type: "object",
    properties: {
      url: {
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, maxItems: WEB_TABLE_LIMITS.pagesPerCall }],
        description: "The page's URL, or the URLs of all pages of one table in order. Not needed with source \"tab\".",
      },
      source: {
        type: "string",
        enum: ["url", "tab"],
        description: "\"tab\": read the page the browser tab shows (after a login, a filter or a script). Only for agents that drive the browser.",
      },
      table: { type: "string", description: "Which table when a page has several: its number (1 = first) or its id, as listed." },
      column: { type: "string", description: "The column to compute over: its header text or its number." },
      aggregates: { type: "array", items: { type: "string", enum: [...AGGREGATES] } },
      where: {
        type: "array",
        description: "Keep only rows matching every condition; numbers compare as numbers.",
        items: {
          type: "object",
          properties: {
            column: { type: "string" },
            op: { type: "string", enum: [...CONDITION_OPS] },
            value: { oneOf: [{ type: "number" }, { type: "string" }] },
          },
          required: ["column", "op", "value"],
        },
      },
      group_by: { type: "string", description: "Compute the aggregates per distinct value of this column." },
    },
    required: [],
  },
  // A backstop only: the handler stops itself at its own deadline (callDeadlineMs).
  timeoutMs: 120_000,
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const request = parseRequest(args);
    if (typeof request === "string") return argumentError(request);
    try {
      return request.source === "tab" ? await fromTab(request, ctx) : await fromUrls(request, ctx);
    } catch (err) {
      log.error({ err }, "web_table failed");
      return fetchFailure(`web_table failed: ${err instanceof Error ? err.message : String(err)}`, { source: request.source, urls: request.urls });
    }
  },
});
