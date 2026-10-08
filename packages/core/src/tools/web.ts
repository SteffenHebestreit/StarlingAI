import { getTool, registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { getConfig } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import { lookup as dnsLookupCallback, type LookupAddress, type LookupOptions } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { Agent } from "undici";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { analyzeImageBytes, callPlaywrightTool, extractDocumentBytesToMarkdown } from "./multimodal.js";
import { resolveWorkspaceWritePath } from "./workspace-path.js";
import { getMcpConnections } from "../mcp/registry.js";
import { rootSessionOf } from "../agent/session-ids.js";
import {
  extractHtmlLinks,
  formatLinkSection,
  LINK_BUDGET_MAX_SHARE,
  LINK_BUDGET_MIN_SHARE,
  LINK_SCAN_MAX,
  LINK_URL_MAX,
  renderedLinks,
  snapshotLinks,
  type PageLink,
} from "./page-links.js";

const log = childLogger("tool:web");

// ─── Per-session consecutive zero-result search tracker ──────────────────────
// After SEARCH_DEGRADED_THRESHOLD consecutive zero-result searches within the
// same root session, the output message changes to tell the agent the backend
// appears degraded and it should stop searching and use web_fetch, shared
// facts, or model knowledge instead.
// At SEARCH_HARD_BLOCK_THRESHOLD the tool refuses to execute entirely.
// The tracker uses the ROOT session ID so parallel sub-agents (which each get
// their own sub:… sessionId) share the degraded counter and don't independently
// re-discover a broken backend.
const SEARCH_DEGRADED_THRESHOLD = 3;
const SEARCH_HARD_BLOCK_THRESHOLD = 4;
const sessionZeroResultStreak = new Map<string, number>();

/**
 * The key a run's zero-result streak is kept under: its root session.
 * sub:sub:ROOT:coord:ts:researcher:ts → ROOT
 * sub:ROOT:agent:ts                   → ROOT
 * ROOT                                → ROOT
 *
 * Under multi-user auth the whole root (rootSessionOf). The first colon-delimited segment was the
 * key, and that is the root only when the root is a chat session's UUID: every account's
 * `a2a-in:<user segment>:<id>` runs shared the key `a2a-in`, every MCP call `mcp`, every
 * federation run `fed`, and a client session named `a2a-in` joined them. Four zero-result searches
 * in one account's A2A task then hard-blocked web search for every account's A2A tasks (found in
 * review, 2026-10-09). With auth off the first segment stays the key, as before.
 */
function getRootSessionId(sessionId: string): string {
  if (getConfig().auth?.enabled === true) return rootSessionOf(sessionId);
  const stripped = sessionId.replace(/^(?:sub:)+/, "");
  const idx = stripped.indexOf(":");
  return idx === -1 ? stripped : stripped.slice(0, idx);
}

/** Increment the zero-result streak for a session and return the new count. */
function recordZeroResultSearch(sessionId: string): number {
  const rootId = getRootSessionId(sessionId);
  const count = (sessionZeroResultStreak.get(rootId) ?? 0) + 1;
  sessionZeroResultStreak.set(rootId, count);
  return count;
}

/** Reset the zero-result streak for a session (called on any successful search). */
function resetZeroResultStreak(sessionId: string): void {
  sessionZeroResultStreak.delete(getRootSessionId(sessionId));
}

/** Get the current zero-result streak for a session. */
function getZeroResultStreak(sessionId: string): number {
  return sessionZeroResultStreak.get(getRootSessionId(sessionId)) ?? 0;
}

/** Clean up session tracking to avoid memory leaks. */
export function clearSearchSessionState(sessionId: string): void {
  sessionZeroResultStreak.delete(getRootSessionId(sessionId));
}

type SearchBackend = "searxng" | "playwright" | "duckduckgo";

interface ResolvedSearchBackendConfig {
  requestedBackend: "auto" | SearchBackend;
  backends: SearchBackend[];
  searxngBaseUrl?: string;
  timeoutMs: number;
}

registerTool({
  name: "web_search",
  description: "Search the web using the configured search backend. Prefers SearXNG when configured and can fall back to DuckDuckGo.",
  embeddingDescription: "Search, google, query the internet or web for information, topics, news, articles. Websuche, Internet durchsuchen, googeln, nachschlagen, Suchmaschine abfragen. Find online content.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      maxResults: { type: "number", description: "Max results to return (1-10)", default: 5 },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args["query"] ?? "");
    const maxResults = Math.min(10, Math.max(1, Number(args["maxResults"] ?? 5)));
    const searchConfig = resolveSearchBackendConfig();
    const sessionId = ctx.sessionId;

    if (!query.trim()) {
      return { success: false, output: "", error: "Search query cannot be empty" };
    }

    // Hard-block: if the root session has already hit the hard block threshold,
    // refuse to execute at all — saves network round-trips and iteration budget.
    const currentStreak = getZeroResultStreak(sessionId);
    if (currentStreak >= SEARCH_HARD_BLOCK_THRESHOLD) {
      log.warn({ sessionId, streak: currentStreak, query }, "web_search hard-blocked — backend offline for this session");
      return {
        success: false,
        output: "",
        error: `The search backend is offline for this session (${currentStreak} consecutive zero-result queries). ` +
          "Do NOT call web_search again. Use web_fetch for known URLs, read_shared_facts for sibling findings, " +
          "or answer from the content and knowledge you already have.",
        metadata: { searchDegraded: true, hardBlocked: true, consecutiveZeroResults: currentStreak },
      };
    }

    if (searchConfig.requestedBackend === "searxng" && !searchConfig.searxngBaseUrl) {
      return {
        success: false,
        output: "",
        error: "web_search is configured for SearXNG, but no endpoint is set. Configure retrieval.search.searxngBaseUrl or SEARXNG_BASE_URL.",
      };
    }

    const attemptedBackends: SearchBackend[] = [];
    const backendErrors: string[] = [];

    for (const backend of searchConfig.backends) {
      attemptedBackends.push(backend);

      try {
        let searchOutcome: { results: SearchResult[]; rewrittenQuery: string; ranking: SearchRankingMetadata; unresponsiveEngines?: string[] };

        if (backend === "searxng") {
          searchOutcome = await searchSearxng(query, maxResults, searchConfig.searxngBaseUrl!, searchConfig.timeoutMs);
        } else if (backend === "playwright") {
          searchOutcome = await searchPlaywright(query, maxResults, searchConfig.timeoutMs);
        } else {
          searchOutcome = await searchDuckDuckGo(query, maxResults, searchConfig.timeoutMs);
        }

        const { results, rewrittenQuery, ranking } = searchOutcome;
        const queryNote = rewrittenQuery !== query.trim()
          ? `\nSearched as: "${rewrittenQuery}"`
          : "";

        if (results.length === 0) {
          // If there are more backends left to try, fall through silently rather
          // than returning an empty-result response.  This is the key path that
          // lets a degraded SearXNG instance automatically retry via playwright
          // DuckDuckGo without the agent seeing a zero-result response.
          const hasMoreBackends = attemptedBackends.length < searchConfig.backends.length;
          if (hasMoreBackends) {
            log.warn({ query, backend }, "web_search: backend returned zero results, trying next backend");
            backendErrors.push(`${backend}: no results`);
            continue;
          }

          const streak = recordZeroResultSearch(sessionId);
          const degraded = streak >= SEARCH_DEGRADED_THRESHOLD;

          let output = `No results found for "${query}" from the ${backend} backend.${queryNote}`;
          // The backends tried before this one are part of the answer. Their errors were collected
          // and then dropped, so "No results found" read as "nothing exists" when SearXNG had in fact
          // returned HTTP 503 and only the last-resort scrape came back empty.
          if (backendErrors.length > 0) {
            output += `\nBackends tried before it: ${backendErrors.join("; ")}.`;
            if (backendErrors.some((entry) => !entry.endsWith(": no results"))) {
              output += "\nOne or more search backends FAILED — this empty result is not evidence that nothing exists.";
            }
          }
          if (degraded) {
            output += `\n⚠ The search backend appears degraded (${streak} consecutive queries returned zero results). ` +
              "STOP calling web_search — further attempts will likely fail the same way. " +
              "Instead: use web_fetch to retrieve known URLs directly, check read_shared_facts for evidence from sibling agents, " +
              "or synthesize your answer from the information you already have and clearly state that live search data was unavailable.";
            log.warn({ sessionId, streak, query, backend }, "Search backend appears degraded — consecutive zero-result streak");
          } else {
            output += "\nTry rephrasing or use different keywords.";
          }

          return {
            success: !degraded,
            output: degraded ? "" : output,
            error: degraded ? output : undefined,
            metadata: {
              query,
              rewrittenQuery,
              backend,
              attemptedBackends,
              requestedBackend: searchConfig.requestedBackend,
              ranking,
              consecutiveZeroResults: streak,
              searchDegraded: degraded,
              ...(backendErrors.length > 0 ? { backendErrors } : {}),
            },
          };
        }

        // Successful results — reset the streak
        resetZeroResultStreak(sessionId);

        const formatted = results
          .map(r => `**${r.title}**\n${r.url}\n${r.snippet}`)
          .join("\n\n");
        const partialNote = searchOutcome.unresponsiveEngines?.length
          ? `\n(Partial results: ${searchOutcome.unresponsiveEngines.length} search engine(s) did not respond — ${searchOutcome.unresponsiveEngines.join(", ")}.)`
          : "";

        return {
          success: true,
          output: `**Web Search Results for:** "${query}" (via ${backend})${queryNote}${partialNote}\n\n${formatted}`,
          metadata: {
            query,
            rewrittenQuery,
            resultCount: results.length,
            backend,
            attemptedBackends,
            requestedBackend: searchConfig.requestedBackend,
            ranking,
            ...(backendErrors.length > 0 ? { backendErrors } : {}),
            ...(searchOutcome.unresponsiveEngines?.length ? { unresponsiveEngines: searchOutcome.unresponsiveEngines } : {}),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        backendErrors.push(`${backend}: ${message}`);

        if (attemptedBackends.length < searchConfig.backends.length) {
          log.warn({ err, query, backend }, "web_search backend failed, trying fallback backend");
          continue;
        }

        log.error({ err, query, backend }, "web_search failed");
        return {
          success: false,
          output: "",
          error: formatSearchError(searchConfig.requestedBackend, backendErrors),
        };
      }
    }

    return {
      success: false,
      output: "",
      error: formatSearchError(searchConfig.requestedBackend, backendErrors),
    };
  },
});

/**
 * Redirects web_fetch follows, every target checked: as many as Chromium follows. A page the
 * direct request cannot read goes to the browser, which walks the same chain; with a limit of 5
 * here the browser was handed the rest of a longer chain, hops 6 to 20, unchecked.
 */
const WEB_FETCH_MAX_REDIRECTS = 20;

/**
 * The longest one web_fetch redirect chain may take, all hops together: the old worst case, the
 * first request and five redirects at 12 s each. A timeoutMs of web_fetch's own, should it get
 * one, wins when it is smaller.
 */
const WEB_FETCH_CHAIN_BUDGET_MS = 72_000;

function webFetchChainBudgetMs(): number {
  const own = getTool("web_fetch")?.timeoutMs;
  return own && own > 0 ? Math.min(WEB_FETCH_CHAIN_BUDGET_MS, own) : WEB_FETCH_CHAIN_BUDGET_MS;
}

/** web_fetch's answer when the browser ended on a page the guard refuses: nothing from it, and the tab sent away. */
async function refuseBrowserLanding(url: string, reason: string): Promise<ToolResult> {
  log.warn({ url, reason }, "web_fetch: the browser landed on a page the SSRF guard refuses");
  await leaveRefusedPage();
  return { success: false, output: "", error: `${url} led the browser to a page the guard refuses (${reason}); nothing from that page is returned` };
}

registerTool({
  name: "web_fetch",
  description: "Fetch a public URL and return its readable text. HTML pages end with a list of their links (absolute URLs, same site first): follow those instead of guessing paths. JSON is returned verbatim, PDFs as extracted text; JavaScript-only pages are browser-rendered when available.",
  embeddingDescription: "Fetch, download, retrieve, load content from a URL or webpage. Webseite abrufen, URL aufrufen, Seiteninhalt laden, HTML holen. Read online page contents.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch (must be a public http/https URL)" },
      maxLength: { type: "number", description: "Max characters to return, the page's link list included (default 8000)", default: 8000 },
    },
    required: ["url"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const url = String(args["url"] ?? "");
    const maxLength = Math.min(32000, Math.max(500, Number(args["maxLength"] ?? 8000)));
    const isSubAgent = !!ctx.currentAgentName;
    const shareSuffix = isSubAgent
      ? "\n\n💡 If this content is useful for your task, call share_finding now to publish key facts for sibling agents before your iteration budget runs out."
      : "";

    if (!url.match(/^https?:\/\//i)) {
      return { success: false, output: "", error: "URL must start with http:// or https://" };
    }

    // Block private/internal IPs (SSRF prevention). safeFetch below re-checks every
    // redirect hop; this up-front check gives a clean tool error on the initial host.
    let initialHost: string;
    try {
      initialHost = new URL(url).hostname;
    } catch {
      return { success: false, output: "", error: "Invalid URL" };
    }
    if (await hostIsBlocked(initialHost)) {
      return { success: false, output: "", error: "Fetching private/internal network addresses is not allowed" };
    }

    try {
      // Single GET; route by the RESPONSE content-type. A separate upfront HEAD
      // probe was removed — it cost an extra round-trip on every fetch to derive a
      // content-type the first GET already returns (and many servers reject HEAD).
      let contentType = "";
      let nativeFetchText: string | null = null;
      // The page's anchors, read from the HTML before stripHtml drops them, and the URL they
      // resolve against: the one that finally answered, after redirects.
      let nativeLinks: PageLink[] = [];
      let nativePageUrl = url;
      // What the direct GET said, carried to whatever answers in its place. A 404 or 403 used to be
      // dropped here: the browser then rendered the error page and it came back as the content.
      let directStatus: number | null = null;
      let directError = "";
      try {
        const { res, finalUrl } = await safeFetchFinal(url, 12000, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; StarlingAI/0.1; +https://starlingai.io)",
            "Accept": "text/html,application/xhtml+xml,application/json,text/plain,*/*",
          },
        }, WEB_FETCH_MAX_REDIRECTS, webFetchChainBudgetMs());
        directStatus = res.status;
        if (res.ok) {
          const ct = res.headers.get("content-type") ?? "";
          contentType = ct;
          let raw = await res.text();
          // PDF documents (datasheets/specs/papers), incl. octet-stream / %PDF magic →
          // extract text via the multimodal service rather than returning raw %PDF bytes.
          if (isPdfContentType(ct) || raw.trimStart().startsWith("%PDF")) {
            return await fetchAndExtractPdf(url, maxLength, shareSuffix);
          }
          // JSON / API → return verbatim (no HTML strip, no min-length floor: small
          // valid JSON must not be rejected and re-fetched down the fallback path).
          if (/\bjson\b/i.test(ct)) {
            let text = raw;
            if (text.length > maxLength) {
              text = text.substring(0, maxLength) + `\n\n[Content truncated at ${maxLength} chars]`;
            }
            return {
              success: true,
              output: `**Content from:** ${url}\n\n${text}${shareSuffix}`,
              metadata: { url, contentLength: text.length, contentType: ct, fetchMethod: "native" },
            };
          }
          // HTML / other content: strip markup first (clean prose for static pages),
          // and keep it only if it has real content — JS-rendered pages return little,
          // so they fall through to Playwright below. This avoids the YAML
          // accessibility-tree noise that browser_snapshot produces. The test is on the
          // text alone: a script shell with a long menu still goes to the browser.
          if (ct.includes("text/html")) {
            nativeLinks = extractHtmlLinks(raw, finalUrl);
            nativePageUrl = finalUrl;
            raw = stripHtml(raw);
          }
          if (raw.trim().length > 200) {
            nativeFetchText = raw.trim();
          }
        }
      } catch (err) {
        // The guard turned a host away, the requested one or a redirect's target. This used to
        // fall through like any failed request: the browser was handed the same URL, followed
        // the redirect unchecked and returned the internal page's text. A refusal now ends the
        // call, with no render, no snapshot and no second direct request.
        if (err instanceof SsrfRefusal) {
          log.warn({ url, reason: err.message }, "web_fetch: the SSRF guard refused a host on the way");
          return { success: false, output: "", error: err.message };
        }
        // fall through to Playwright, remembering why
        directError = err instanceof Error ? err.message : String(err);
      }
      const directNote = directStatus !== null && !(directStatus >= 200 && directStatus < 300)
        ? `a direct request was answered HTTP ${directStatus}`
        : directError ? `a direct request failed (${directError})` : "";

      if (nativeFetchText !== null) {
        const { text, linkCount } = withLinks(nativeFetchText, nativeLinks, nativePageUrl, maxLength);
        return {
          success: true,
          output: `**Content from:** ${url}\n\n${text}${shareSuffix}`,
          metadata: { url, contentLength: text.length, contentType: contentType || "text/html", fetchMethod: "native", linkCount },
        };
      }

      // Native fetch returned empty/short content — page is JS-rendered.
      // Use Playwright, but convert the accessibility snapshot to readable text
      // rather than passing the raw YAML DOM tree to the LLM.
      const playwrightAvailable = getMcpConnections().has("playwright");
      let renderedEmpty = false;
      if (playwrightAvailable) {
        try {
          // The browser follows redirects, runs the page's scripts and may be answered unlike the
          // direct request, and whatever page it ended on came back as this URL's content. That
          // page is now checked, on arrival and again once read, before anything from it is used.
          // This keeps the page out of the answer; it cannot take back the request the browser sent.
          const arrival = await refusedBrowserPage(reportedPageUrls(await callPlaywrightTool("browser_navigate", { url })));
          if (arrival) return await refuseBrowserLanding(url, arrival);
          let rendered: { text: string; pageUrl: string | null; links: PageLink[]; frames?: string[] | null };
          let pageReport: string;
          try {
            // browser_evaluate takes a FUNCTION. This sent `expression`, which Playwright MCP 1.61
            // rejects as a missing `function`, so this fast path never ran and every page came
            // back as a converted accessibility snapshot instead of its text.
            pageReport = await callPlaywrightTool("browser_evaluate", { function: PAGE_TEXT_AND_LINKS });
            rendered = parseRenderedPage(evaluateResultText(pageReport));
          } catch {
            // Fall back to snapshot and convert to readable text
            log.warn({ url }, "web_fetch: browser_evaluate unavailable, converting snapshot to text");
            pageReport = await callPlaywrightTool("browser_snapshot", {});
            rendered = { text: snapshotToReadableText(pageReport), ...snapshotLinks(pageReport, url) };
          }
          const landing = await refusedBrowserPage([...reportedPageUrls(pageReport), ...(rendered.pageUrl ? [rendered.pageUrl] : [])]);
          if (landing) return await refuseBrowserLanding(url, landing);
          // The page can frame a private host, and the snapshot carries the frame's content. The
          // page function lists the frames it found; a snapshot that shows one has them read.
          const frames = rendered.frames !== undefined ? rendered.frames : showsFrames(pageReport) ? (await readPageAddresses()).frames : [];
          const framed = await refusedFrameUrls(frames);
          if (framed) return await refuseBrowserLanding(url, framed);
          // Emptiness is the page's text, never the envelope or the links around it.
          if (!rendered.text.trim()) {
            // An empty render is not the page's content. It was returned as a successful fetch
            // of nothing; now the last-resort direct fetch gets its turn, and if that is empty
            // too the call fails and says both were.
            renderedEmpty = true;
          } else {
            const { text, linkCount } = withLinks(rendered.text, rendered.links, rendered.pageUrl ?? url, maxLength);
            return {
              success: true,
              output: `**Content from:** ${url}${directNote ? ` (browser-rendered; ${directNote})` : ""}\n\n${text}${shareSuffix}`,
              metadata: { url, contentLength: text.length, contentType: contentType || "text/html", fetchMethod: "playwright", linkCount, ...(directStatus !== null ? { httpStatus: directStatus } : {}) },
            };
          }
        } catch (playwrightErr) {
          log.warn({ err: playwrightErr, url }, "web_fetch Playwright failed");
        }
      }
      const renderedNote = renderedEmpty ? "; the browser rendered the page with no text" : "";

      // Last resort: native fetch even if content seems thin
      try {
        const { res, finalUrl } = await safeFetchFinal(url, 15000, {
          headers: {
            "User-Agent": "StarlingAI/0.1 (research assistant)",
            "Accept": "text/html,application/xhtml+xml,text/plain,*/*",
          },
        }, WEB_FETCH_MAX_REDIRECTS, webFetchChainBudgetMs());
        if (!res.ok) {
          return { success: false, output: "", error: `HTTP ${res.status} from ${url}${renderedNote}` };
        }
        const resContentType = res.headers.get("content-type") ?? "";
        let body = await res.text();
        let links: PageLink[] = [];
        if (resContentType.includes("text/html")) {
          links = extractHtmlLinks(body, finalUrl);
          body = stripHtml(body);
        }
        // A page of links and no text has no readable text either.
        if (!body.trim()) {
          return {
            success: false,
            output: "",
            error: `${url} returned no readable text (HTTP ${res.status}${resContentType ? `, ${resContentType}` : ""})${renderedNote}. `
              + "The page may be empty, need interaction, or block automated clients — this is not its content.",
          };
        }
        const { text, linkCount } = withLinks(body, links, finalUrl, maxLength);
        return {
          success: true,
          output: `**Content from:** ${url}${renderedEmpty ? " (raw response; the browser rendered no text)" : ""}\n\n${text}${shareSuffix}`,
          metadata: { url, contentLength: text.length, contentType: resContentType, fetchMethod: "native_fallback", httpStatus: res.status, linkCount },
        };
      } catch (err) {
        log.error({ err, url }, "web_fetch failed");
        return { success: false, output: "", error: `Fetch failed: ${String(err)}${directNote ? `; earlier, ${directNote}` : ""}${renderedNote}` };
      }
    } catch (err) {
      log.error({ err, url }, "web_fetch failed");
      return { success: false, output: "", error: `Fetch failed: ${String(err)}` };
    }
  },
});

// ─── fetch_image ─────────────────────────────────────────────────────────────
// Download + verify a real image into the workspace so deliverables embed a LOCAL
// asset instead of a fragile (and frequently fabricated) hotlink. The recurring
// failure this kills: the model is handed a Commons File: PAGE url, then guesses the
// uncomputable hashed /thumb/<hash>/…NNNpx- direct URL and embeds a dead 404 link
// (audits 39953ed9, 3b53af25 — 0/N image URLs resolved). Given a page, this tool
// extracts the real image (og:image, then the largest <img>/"Original file" link)
// so nothing has to be guessed; given a direct image it uses it as-is. It keeps the
// bytes only when the response is genuinely an image (content-type image/*), then
// saves it under the workspace and returns the workspace-relative path.
const IMAGE_FETCH_UA = "Mozilla/5.0 (compatible; StarlingAI/0.1 image fetcher; +https://starlingai.io)";
const IMAGE_MIN_BYTES = 256;
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

function imageExtFromContentType(contentType: string): string {
  const ct = contentType.split(";")[0]!.trim().toLowerCase();
  switch (ct) {
    case "image/jpeg": case "image/jpg": return ".jpg";
    case "image/png": return ".png";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    case "image/svg+xml": return ".svg";
    case "image/avif": return ".avif";
    case "image/bmp": return ".bmp";
    case "image/tiff": return ".tiff";
    default: return ".img";
  }
}

function slugifyImageName(raw: string): string {
  const base = raw.replace(/\.[a-z0-9]{1,5}$/i, ""); // drop any existing extension
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || "image";
}

function imageBaseNameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return slugifyImageName(decodeURIComponent(last));
  } catch {
    return "image";
  }
}

/** Pull the best embeddable image URL out of an HTML page: prefer og:image /
 *  twitter:image (what Commons File pages, articles, and stock pages expose as the
 *  canonical image), then fall back to the first reasonably-sized <img src>. Relative
 *  srcs are resolved against the page URL. Returns an absolute http(s) URL or null. */
function extractImageUrlFromHtml(html: string, baseUrl: string): string | null {
  const metaPatterns = [
    /<meta[^>]+(?:property|name)=["']og:image(?::secure_url)?["'][^>]*\bcontent=["']([^"']+)["']/i,
    /<meta[^>]+\bcontent=["']([^"']+)["'][^>]*(?:property|name)=["']og:image(?::secure_url)?["']/i,
    /<meta[^>]+(?:property|name)=["']twitter:image(?::src)?["'][^>]*\bcontent=["']([^"']+)["']/i,
  ];
  for (const re of metaPatterns) {
    const m = html.match(re);
    if (m?.[1]) {
      const abs = absolutizeUrl(m[1].trim(), baseUrl);
      if (abs) return abs;
    }
  }
  // Fallback: first <img> whose src looks like an image file.
  const imgRe = /<img[^>]+\bsrc=["']([^"']+)["']/gi;
  let im: RegExpExecArray | null;
  while ((im = imgRe.exec(html)) !== null) {
    const src = im[1]!.trim();
    if (/^data:/i.test(src)) continue;
    if (/\.(?:jpe?g|png|webp|gif|svg|avif)(?:[?#]|$)/i.test(src)) {
      const abs = absolutizeUrl(src, baseUrl);
      if (abs) return abs;
    }
  }
  return null;
}

function absolutizeUrl(candidate: string, baseUrl: string): string | null {
  try {
    const abs = new URL(candidate, baseUrl).href;
    return /^https?:\/\//i.test(abs) ? abs : null;
  } catch {
    return null;
  }
}

/** SSRF guard shared with web_fetch: reject private/internal hosts (literal + DNS). */
async function imageHostIsBlocked(url: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return true; // unparseable URL
  }
  return hostIsBlocked(host);
}

type ImageFetchOutcome =
  | { kind: "image"; bytes: Uint8Array; contentType: string }
  | { kind: "html"; html: string }
  | { kind: "miss"; status: number; contentType: string };

async function fetchImageOnce(url: string): Promise<ImageFetchOutcome> {
  const res = await safeFetch(url, 20000, {
    headers: { "User-Agent": IMAGE_FETCH_UA, "Accept": "image/*,text/html;q=0.9,*/*;q=0.8" },
  });
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok) return { kind: "miss", status: res.status, contentType };
  if (/^image\//i.test(contentType)) {
    return { kind: "image", bytes: new Uint8Array(await res.arrayBuffer()), contentType };
  }
  if (/text\/html/i.test(contentType)) {
    return { kind: "html", html: await res.text() };
  }
  return { kind: "miss", status: 200, contentType };
}

async function fetchImageWithRetry(url: string): Promise<ImageFetchOutcome> {
  let outcome = await fetchImageOnce(url);
  // A 429 is rate-limiting, not a dead link — back off briefly and try once more.
  if (outcome.kind === "miss" && outcome.status === 429) {
    await new Promise((r) => setTimeout(r, 1500));
    outcome = await fetchImageOnce(url);
  }
  return outcome;
}

registerTool({
  name: "fetch_image",
  description:
    "Download a real image into the workspace and VERIFY it is genuinely an image, so a deck/page/document embeds a LOCAL asset instead of a fragile hotlink. Accepts a direct image URL OR a page URL (e.g. a Wikimedia Commons 'File:' page, a stock/museum page); when given a page it extracts the real image (og:image, then the largest <img>) — you NEVER guess or construct a hashed thumbnail URL. It fetches the bytes, keeps them ONLY when the response is a real image (content-type image/*), optionally confirms the image depicts a given subject via the vision model, saves it under the workspace, and returns the saved workspace-relative path to embed as ![alt](path). On a 404 / non-image / rate-limited URL it fails with a clear reason so you leave that slot empty rather than embed a dead link.",
  embeddingDescription:
    "download image, fetch and save a picture or photo to the workspace, verify an image url is real and resolves, cache an image locally, resolve og:image from a page, Bild herunterladen prüfen speichern, verifiziertes Bild lokal ablegen, save verified image",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Direct image URL, or a page URL that contains/links the image (e.g. a Commons 'File:' page)." },
      outputDir: { type: "string", description: "Workspace-relative directory to save the image into. Defaults to 'assets/images'. For a deck, pass the deck folder's images dir (e.g. '<deck>/images') so the saved file sits beside index.html." },
      filename: { type: "string", description: "Optional base filename (the extension is derived from the verified content-type). Defaults to a slug of the source URL." },
      subject: { type: "string", description: "Optional: what the image must depict. When a vision model is configured the saved image is checked against this; a clear mismatch fails the call." },
    },
    required: ["url"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const url = String(args["url"] ?? "").trim();
    const outputDir = (String(args["outputDir"] ?? "").trim() || "assets/images");
    const subject = typeof args["subject"] === "string" ? args["subject"].trim() : "";
    const requestedName = typeof args["filename"] === "string" ? args["filename"].trim() : "";

    if (!/^https?:\/\//i.test(url)) {
      return { success: false, output: "", error: "url must be a public http(s) URL" };
    }
    if (await imageHostIsBlocked(url)) {
      return { success: false, output: "", error: "Fetching private/internal network addresses is not allowed" };
    }

    try {
      let outcome = await fetchImageWithRetry(url);
      let resolvedImageUrl = url;

      if (outcome.kind === "html") {
        const extracted = extractImageUrlFromHtml(outcome.html, url);
        if (!extracted) {
          return { success: false, output: "", error: `The page at ${url} does not expose an embeddable image (no og:image or <img>). Open a direct image URL or a different source.`, metadata: { saved: false, reason: "no_image_on_page", sourceUrl: url } };
        }
        if (await imageHostIsBlocked(extracted)) {
          return { success: false, output: "", error: "Resolved image is on a private/internal address — refusing to fetch." };
        }
        resolvedImageUrl = extracted;
        outcome = await fetchImageWithRetry(extracted);
      }

      if (outcome.kind !== "image") {
        const status = outcome.kind === "miss" ? outcome.status : 0;
        const detail = status === 429
          ? "rate-limited (HTTP 429) — try again later or use a different source"
          : status === 404
            ? "not found (HTTP 404)"
            : `not an image (HTTP ${status}, content-type ${outcome.kind === "miss" ? outcome.contentType || "unknown" : "unknown"})`;
        return { success: false, output: "", error: `Could not verify an image at ${resolvedImageUrl}: ${detail}. Do NOT embed this URL — leave the slot empty or try another source.`, metadata: { saved: false, reason: "not_an_image", status, sourceUrl: url, resolvedImageUrl } };
      }

      const { bytes, contentType } = outcome;
      if (bytes.length < IMAGE_MIN_BYTES) {
        return { success: false, output: "", error: `The fetched resource at ${resolvedImageUrl} is too small (${bytes.length} bytes) to be a real image.`, metadata: { saved: false, reason: "too_small", sourceUrl: url, resolvedImageUrl } };
      }
      if (bytes.length > IMAGE_MAX_BYTES) {
        return { success: false, output: "", error: `Image at ${resolvedImageUrl} is too large (${Math.round(bytes.length / 1024 / 1024)} MB; max ${IMAGE_MAX_BYTES / 1024 / 1024} MB).`, metadata: { saved: false, reason: "too_large", sourceUrl: url, resolvedImageUrl } };
      }

      // Optional best-effort visual subject confirmation.
      let subjectMatch: string | undefined;
      if (subject) {
        const visionModel = getConfig().multimodal.files.visionModel;
        if (visionModel) {
          try {
            const verdict = await analyzeImageBytes(
              bytes,
              contentType,
              visionModel,
              `Does this image primarily depict: ${subject}? Answer with "yes" or "no" first, then a short reason.`,
            );
            const saysNo = /^\s*(?:no\b|nein\b)/i.test(verdict) || /\b(?:does not depict|not depict|unrelated|n't (?:show|depict))\b/i.test(verdict);
            subjectMatch = saysNo ? "mismatch" : "match";
            if (saysNo) {
              return { success: false, output: "", error: `The image at ${resolvedImageUrl} does not depict "${subject}" (vision check: ${verdict.slice(0, 200)}). Not saved — try another source.`, metadata: { saved: false, reason: "subject_mismatch", sourceUrl: url, resolvedImageUrl } };
            }
          } catch {
            subjectMatch = "unverified"; // vision unavailable/failed — keep the verified-image result
          }
        } else {
          subjectMatch = "unverified_no_vision_model";
        }
      }

      const ext = imageExtFromContentType(contentType);
      const baseName = slugifyImageName(requestedName || imageBaseNameFromUrl(resolvedImageUrl));
      const normalizedOutputDir = outputDir.replace(/\\/g, "/");
      const relPath = posix.join(normalizedOutputDir, `${baseName}${ext}`);
      let resolved: { resolved: string; relativePath: string };
      try {
        // Root saved images under generated/ (idempotent) so a deck/paper and its
        // images live in ONE generated/<dir> tree, not a stray workspace/<dir>.
        resolved = resolveWorkspaceWritePath(relPath, ctx.workspacePath);
      } catch {
        return { success: false, output: "", error: "outputDir must resolve inside the workspace" };
      }
      await mkdir(dirname(resolved.resolved), { recursive: true });
      await writeFile(resolved.resolved, bytes);

      const subjectNote = subjectMatch === "match"
        ? " Subject confirmed via vision."
        : subjectMatch === "unverified" || subjectMatch === "unverified_no_vision_model"
          ? " (Subject not visually confirmed.)"
          : "";
      // The deck/paper that embeds this image sits one level above the images dir,
      // so suggest the deck-relative form (images/<file>) rather than the full
      // generated/... path — the model otherwise copies the absolute-ish path and
      // the relative embed breaks.
      const embedHint = posix.basename(normalizedOutputDir) === "images"
        ? `images/${baseName}${ext}`
        : resolved.relativePath;
      return {
        success: true,
        output: `Saved verified image (${contentType}, ${bytes.length} bytes) to ${resolved.relativePath}.${subjectNote} Embed it relative to your deck/paper as ![alt](${embedHint}).`,
        metadata: {
          saved: true,
          outputPath: resolved.relativePath,
          filename: `${baseName}${ext}`,
          contentType,
          bytes: bytes.length,
          sourceUrl: url,
          resolvedImageUrl,
          subjectMatch,
          previewMode: "image",
        },
      };
    } catch (err) {
      log.warn({ err, url }, "fetch_image failed");
      return { success: false, output: "", error: `fetch_image failed: ${String(err)}`, metadata: { saved: false, reason: "exception", sourceUrl: url } };
    }
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The page text inside a browser_evaluate answer. Playwright MCP wraps the returned value as a
 * JSON literal under `### Result` (followed by other sections); an empty page is `""`, which as
 * raw text is two quote characters and read as content. Unparseable answers pass through whole.
 */
function evaluateResultText(output: string): string {
  const start = output.indexOf("### Result\n");
  if (start < 0) return output;
  const body = output.slice(start + "### Result\n".length);
  const end = body.search(/\n#{1,4} /);
  try {
    const value: unknown = JSON.parse((end >= 0 ? body.slice(0, end) : body).trim());
    return typeof value === "string" ? value : output;
  } catch {
    return output;
  }
}

/**
 * A browser expression for the addresses of the page's frames: each iframe or frame element's
 * current address where it can be read (same origin, whose own frames are listed too), else its
 * src, and every frame load the page's resource timing recorded, which still names a frame that
 * has navigated since. An element with neither lists as "", and the expression is null when the
 * frames could not be listed at all. A public page can frame a private one, and what the browser
 * shows of the page (a snapshot, a screenshot) shows the frame with it.
 */
export const FRAME_ADDRESSES = `(() => {
  try {
    const found = [];
    const visit = (doc, depth) => {
      for (const frame of Array.from(doc.querySelectorAll('iframe, frame'))) {
        let href = '';
        let inner = null;
        try { href = String(frame.contentWindow.location.href); inner = frame.contentDocument; } catch (e) { href = ''; }
        found.push(href && href !== 'about:blank' ? href : (frame.src || href));
        if (inner && depth < 8) visit(inner, depth + 1);
      }
      const timing = doc.defaultView && doc.defaultView.performance;
      if (timing) for (const entry of timing.getEntriesByType('resource')) {
        if (entry.initiatorType === 'iframe' || entry.initiatorType === 'frame') found.push(entry.name);
      }
    };
    visit(document, 0);
    return found;
  } catch (e) {
    return null;
  }
})()`;

/**
 * The browser_evaluate function web_fetch sends: the page's text (whitespace evened out as
 * before), the URL the browser ended on, its first LINK_SCAN_MAX links as [href, label]
 * pairs and its frames' addresses (FRAME_ADDRESSES), returned as ONE JSON string. Text and links
 * come back in the same round trip, and a string result is what evaluateResultText reads.
 * innerText has no link targets, so a rendered page used to reach the agent with its menu as
 * bare words. A link longer than LINK_URL_MAX is never listed, so it is not sent either: a data:
 * URI download link can run to megabytes.
 */
const PAGE_TEXT_AND_LINKS = `() => {
  const t = (document.body?.innerText ?? '').replace(/\\t/g, ' ').replace(/[ \\t]{3,}/g, '  ').replace(/\\n{4,}/g, '\\n\\n\\n').trim();
  const l = Array.from(document.links ?? []).filter((a) => typeof a.href === 'string' && a.href.length <= ${LINK_URL_MAX}).slice(0, ${LINK_SCAN_MAX}).map((a) => [a.href, (a.innerText || a.getAttribute('aria-label') || a.title || a.querySelector('img')?.alt || '').replace(/\\s+/g, ' ').trim().slice(0, 200)]);
  return JSON.stringify({ t, u: document.URL, l, f: ${FRAME_ADDRESSES} });
}`;

/**
 * PAGE_TEXT_AND_LINKS's answer as text, page URL and links. Any other answer — a plain string,
 * or an envelope a future Playwright MCP renders differently — is the page text, with no links.
 * A page URL that is not http(s) (a browser error page's) is dropped; the requested URL stands in.
 */
function parseRenderedPage(answer: string): { text: string; pageUrl: string | null; links: PageLink[]; frames?: string[] | null } {
  try {
    const value: unknown = JSON.parse(answer);
    if (value && typeof value === "object" && typeof (value as { t?: unknown }).t === "string") {
      const page = value as { t: string; u?: unknown; l?: unknown; f?: unknown };
      const pageUrl = typeof page.u === "string" && /^https?:\/\//i.test(page.u) ? page.u : null;
      return { text: page.t, pageUrl, links: renderedLinks(page.l), ...("f" in page ? { frames: frameList(page.f) } : {}) };
    }
  } catch {
    // not JSON: the answer is the page text itself
  }
  return { text: answer, pageUrl: null, links: [] };
}

/**
 * A page's text with its links section after it, within maxLength. A text that fits in
 * maxLength is never cut: the section takes only the room the text leaves, at most
 * LINK_BUDGET_MAX_SHARE of maxLength, so a page that nearly fills maxLength lists fewer links,
 * or none. A longer text is cut anyway; the section then takes LINK_BUDGET_MIN_SHARE of
 * maxLength and the text what remains, so a long page keeps its size. With no section the text
 * is cut at maxLength as it always was.
 *
 * The section's floor used to apply to every page: a 6,980-character article at the default
 * 8000 lost its last paragraph to the links, behind a truncation note that invites a re-fetch.
 */
function withLinks(body: string, links: readonly PageLink[], pageUrl: string, maxLength: number): { text: string; linkCount: number } {
  const budget = body.length <= maxLength
    ? Math.min(Math.floor(maxLength * LINK_BUDGET_MAX_SHARE), maxLength - body.length - 2)
    : Math.floor(maxLength * LINK_BUDGET_MIN_SHARE);
  const section = formatLinkSection(links, pageUrl, budget);
  const bodyBudget = maxLength - (section.text ? section.text.length + 2 : 0);
  let text = body;
  if (text.length > bodyBudget) {
    text = text.substring(0, bodyBudget) + `\n\n[Content truncated at ${bodyBudget} chars]`;
  }
  return { text: section.text ? `${text}\n\n${section.text}` : text, linkCount: section.shown };
}

/**
 * Converts a Playwright browser_snapshot accessibility-tree output into compact
 * readable prose. The snapshot is a YAML DOM tree full of structural nodes
 * (generic, banner, listitem, [ref=eN], [cursor=pointer]) that are pure noise
 * for text synthesis. This function extracts heading, text and link-label nodes
 * and caps output at maxChars. Link targets are not part of this text: web_fetch
 * lists them after it (snapshotLinks).
 */
function snapshotToReadableText(snapshot: string, maxChars = 4_000): string {
  const titleLine = snapshot.match(/^-\s+Page Title:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const yamlBlock = snapshot.match(/```ya?ml\n([\s\S]*?)```/)?.[1] ?? "";
  const pieces: string[] = [];
  if (titleLine) pieces.push("# " + titleLine);
  if (yamlBlock) {
    for (const rawLine of yamlBlock.split("\n")) {
      const line = rawLine.trim();
      // - heading "TEXT" [...]
      const hm = line.match(/^-\s+heading\s+"([^"]+)"/);
      if (hm) { pieces.push("## " + hm[1]); continue; }
      // - text: "VALUE"  or  - text: VALUE
      const tm = line.match(/^-\s+text:\s+(?:"([^"]+)"|(\S.*\S))$/);
      if (tm) { const v = (tm[1] ?? tm[2] ?? "").trim(); if (v.length > 3) pieces.push(v); continue; }
      // - link "LABEL" — labels of seven or more characters. An English list of nav words
      // (Contact, About, Home, …) also dropped labels it matched, a keyword table that only
      // read English pages and hid the navigation the agent needs.
      const lm = line.match(/^-\s+link\s+"([^"]{7,})"/);
      if (lm?.[1]) {
        pieces.push(lm[1]); continue;
      }
    }
  }
  const extracted = pieces.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // If the tree parser yielded too little, strip structural markers from raw YAML
  if (extracted.length < 200 && yamlBlock.length > 400) {
    const stripped = yamlBlock
      .replace(/\[ref=e\d+\]/g, "").replace(/\[cursor=[^\]]+\]/g, "")
      .replace(/^\s*-\s+\/url:[^\n]*\n?/gm, "")
      .replace(/^\s*-\s+(generic|listitem|list\b|navigation|banner|main|section|article|figure|footer|header|aside|form|dialog|region|landmark|complementary|contentinfo)\b[^\n]*/gm, "")
      .replace(/\n{3,}/g, "\n\n").trim();
    return stripped.slice(0, maxChars);
  }
  return extracted.slice(0, maxChars);
}

export function isPdfContentType(contentType: string): boolean {
  return /\bapplication\/pdf\b/i.test(contentType);
}

function pdfFilenameFromUrl(url: string): string {
  try {
    const base = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    if (/\.pdf$/i.test(base)) return base;
    return `${base || "document"}.pdf`;
  } catch {
    return "document.pdf";
  }
}

/**
 * Fetch a PDF and return its EXTRACTED TEXT (via the multimodal document service),
 * never the raw %PDF bytes. Audit 97085c6b: web_fetch returned raw bytes for the
 * IM73A135V01 datasheet, so the researcher never learned the mic is analog and the
 * synthesis invented a 4-channel I2S array. If extraction is unavailable, return a
 * plain note (not bytes) so the agent does not fabricate the spec.
 */
async function fetchAndExtractPdf(url: string, maxLength: number, shareSuffix: string): Promise<ToolResult> {
  let bytes: Uint8Array;
  try {
    // The direct request already walked this chain; this one may follow it as far.
    const res = await safeFetch(url, 20000, {
      headers: { "User-Agent": "StarlingAI/0.1 (research assistant)", "Accept": "application/pdf,*/*" },
    }, WEB_FETCH_MAX_REDIRECTS);
    if (!res.ok) return { success: false, output: "", error: `HTTP ${res.status} from ${url}` };
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    log.error({ err, url }, "web_fetch PDF download failed");
    return { success: false, output: "", error: `Fetch failed: ${String(err)}` };
  }

  let markdown = await extractDocumentBytesToMarkdown(bytes, pdfFilenameFromUrl(url), "application/pdf");
  if (markdown) {
    if (markdown.length > maxLength) {
      markdown = markdown.substring(0, maxLength) + `\n\n[Content truncated at ${maxLength} chars]`;
    }
    return {
      success: true,
      output: `**Content from:** ${url} (PDF, extracted to text)\n\n${markdown}${shareSuffix}`,
      metadata: { url, contentLength: markdown.length, contentType: "application/pdf", fetchMethod: "pdf_extract" },
    };
  }
  return {
    success: true,
    output: `**Content from:** ${url}\n\nThis URL is a PDF document and its text could not be extracted here (the document-extraction service is unavailable). Do NOT guess its contents — find an HTML datasheet/specs page for the same item, or report the affected values as unverified.${shareSuffix}`,
    metadata: { url, contentType: "application/pdf", fetchMethod: "pdf_no_extract", pdfExtractionUnavailable: true },
  };
}

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SSRF predicate: true when a host is private/internal by literal OR by DNS
 * resolution. Uses dns.lookup(all) so BOTH A and AAAA records are checked — a
 * resolve4-only check let an IPv6-only host that maps to a private address slip
 * past. A resolver failure (IP literal / offline resolver) is non-fatal, matching
 * the original guard. The only exemption is an exact name listed in
 * guardrails.allowedPrivateHosts (see resolvedHostIsBlocked); a host private by
 * literal is refused whatever that list says.
 */
export async function hostIsBlocked(host: string): Promise<boolean> {
  const h = host.toLowerCase();
  // A trailing dot (FQDN form) must not slip a literal name such as "localhost." past the check.
  if (isPrivateHost(h) || isPrivateHost(h.replace(/\.$/, ""))) return true;
  try {
    const records = await dnsLookup(h, { all: true });
    if (resolvedHostIsBlocked(h, records.map((r) => r.address), configuredPrivateHostAllowlist())) return true;
  } catch {
    /* DNS failure — allow through (IP literal / unavailable resolver) */
  }
  return false;
}

/**
 * Whether a host that resolved to `addresses` is refused. A loopback, link-local or
 * unspecified address refuses it whatever the list says, so the list can open a fixture on a
 * LAN or container network, never the gateway itself or a cloud-metadata endpoint. Any other
 * private address refuses it unless the host is listed in `allowedPrivateHosts` (exact name,
 * any case). The never-allowed test came after the private one and only for a listed host, so
 * an address the private test did not know (::ffff:169.254.169.254) was let through.
 */
export function resolvedHostIsBlocked(host: string, addresses: readonly string[], allowedPrivateHosts: readonly string[]): boolean {
  if (addresses.some((address) => isNeverAllowedAddress(address))) return true;
  if (!addresses.some((address) => isPrivateHost(address))) return false;
  const name = host.toLowerCase().replace(/\.$/, "");
  return !allowedPrivateHosts.some((entry) => entry.toLowerCase() === name);
}

/**
 * Addresses no host reaches through the guard, listed or not: loopback, link-local
 * (169.254.0.0/16 holds the cloud-metadata endpoint; fe80::/10) and the unspecified address
 * (0.0.0.0/8, ::), also as the IPv4 address inside an IPv6 one (embeddedIPv4).
 */
export function isNeverAllowedAddress(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(a) ? a : embeddedIPv4(a);
  if (v4 !== null) return v4.startsWith("127.") || v4.startsWith("169.254.") || v4.startsWith("0.");
  return a === "::1" || a === "::" || /^fe[89ab][0-9a-f]:/.test(a);
}

/** guardrails.allowedPrivateHosts; empty when no config is loaded, so nothing is exempt. */
function configuredPrivateHostAllowlist(): readonly string[] {
  try {
    return getConfig().guardrails?.allowedPrivateHosts ?? [];
  } catch {
    return [];
  }
}

/** The code of a connection guardedConnectLookup refused. */
const CONNECT_REFUSED = "ESSRFBLOCKED";

type ConnectLookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * The lookup a guarded connection resolves its name with. hostIsBlocked resolves a name to
 * decide and the request then resolved it again to connect, so a name whose answers changed in
 * between (DNS rebinding) passed the check on a public address and connected to a private one.
 * This resolves the name once, at connect time, and hands the connection only addresses that
 * pass the same decision: a name in guardrails.allowedPrivateHosts may reach a LAN address, and
 * loopback, link-local (metadata) and unspecified addresses are refused even then. It answers in
 * the shape asked for, one address or all of them.
 */
export function guardedConnectLookup(hostname: string, options: LookupOptions | undefined, callback: ConnectLookupCallback): void {
  dnsLookupCallback(hostname, { ...options, all: true }, (err, records) => {
    if (err) {
      callback(err, "");
      return;
    }
    if (records.length === 0) {
      callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }), "");
      return;
    }
    const name = hostname.toLowerCase();
    const addresses = records.map((record) => record.address);
    if (isPrivateHost(name) || isPrivateHost(name.replace(/\.$/, "")) || resolvedHostIsBlocked(name, addresses, configuredPrivateHostAllowlist())) {
      callback(Object.assign(new Error(`${hostname} resolved to a private/internal network address when connecting; the connection is refused`), { code: CONNECT_REFUSED }), "");
      return;
    }
    // The first record was handed over whatever the family asked for, so a connection asking for
    // IPv4 could be given an IPv6 address. Only records of that family answer it now.
    const family = options?.family === 4 || options?.family === "IPv4" ? 4 : options?.family === 6 || options?.family === "IPv6" ? 6 : 0;
    const answer = family === 0 ? records : records.filter((record) => record.family === family);
    if (answer.length === 0) {
      callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }), "");
      return;
    }
    if (options?.all) callback(null, answer);
    else callback(null, answer[0]!.address, answer[0]!.family);
  });
}

/**
 * The dispatcher for requests to caller-supplied URLs: every connection it opens resolves its
 * name through guardedConnectLookup. The checks before a request stay; they refuse early and
 * cover IP literals, which a connection does not look up. It takes the place of the global
 * dispatcher for these requests, so a proxy set through the environment (NODE_USE_ENV_PROXY
 * with HTTP_PROXY / HTTPS_PROXY) does not apply to them: they connect directly. Proxy support
 * would mean handing this lookup to a proxy-aware agent; none is configured today.
 */
export const guardedDispatcher = new Agent({ connect: { lookup: guardedConnectLookup } });

/** What guardedConnectLookup said when it refused the connection a fetch failed on, else null. */
export function connectRefusalReason(err: unknown): string | null {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null | undefined)?.cause;
  return cause?.code === CONNECT_REFUSED && typeof cause.message === "string" ? cause.message : null;
}

/**
 * Shared SSRF gate for tools that hand a URL to an out-of-process fetcher which
 * has no guard of its own (the Playwright browser, which sits on the service
 * network and could otherwise be pointed at http://engram, http://10.x, or a
 * cloud-metadata endpoint and read the response back via a snapshot). Rejects
 * non-http(s) schemes and any host that resolves to a private/internal address
 * (bar an exact name in guardrails.allowedPrivateHosts, see hostIsBlocked).
 * Returns a reason string when blocked, or null when the URL is allowed.
 */
export async function checkUrlSsrf(rawUrl: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return "invalid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "only http(s) URLs are allowed";
  }
  if (await hostIsBlocked(url.hostname)) {
    return "requesting private/internal network addresses is not allowed";
  }
  return null;
}

/** The page URLs a Playwright MCP answer reports, from its "- Page URL: …" lines. */
export function reportedPageUrls(output: string): string[] {
  return [...output.matchAll(/^[ \t]*-[ \t]+Page URL:[ \t]*(\S+)/gm)].map((match) => match[1]!);
}

/**
 * The last page the guard let the browser show; the same page reported again is not re-checked.
 * This saves a lookup per answer while the browser stays on one page: a per-URL dedup, not a
 * security cache. A name that rebinds to a private address while the browser sits on its page is
 * not caught by it, since the URL does not change (the browser's connection is made by then).
 */
let lastClearedPageUrl: string | undefined;

/**
 * Why the browser may not show the page it reports being on, or null when every one of
 * `pageUrls` passes. checkUrlSsrf sees only the URL the browser is sent to; a redirect, the page's
 * own script or a click then moves it with nothing checking where, so the page it ended on is
 * checked before anything from it is used. An http(s) page goes through checkUrlSsrf (and so
 * guardrails.allowedPrivateHosts), a local file is refused, and the browser's own pages
 * (about:blank, an error page) belong to no host. A blob:, view-source: or filesystem: page
 * belongs to the URL inside it; read as a page of no host, blob:http://10.0.0.5/… passed.
 */
export async function refusedBrowserPage(pageUrls: Iterable<string>): Promise<string | null> {
  for (const pageUrl of pageUrls) {
    if (pageUrl === lastClearedPageUrl) continue;
    const refused = await pageAddressRefusal(pageUrl);
    if (refused) {
      lastClearedPageUrl = undefined;
      return refused;
    }
    if (/^https?:\/\//i.test(innerPageUrl(pageUrl))) lastClearedPageUrl = pageUrl;
  }
  return null;
}

/** The URL a blob:, view-source: or filesystem: page belongs to; any other page URL as it is. */
function innerPageUrl(pageUrl: string): string {
  let target = pageUrl;
  while (/^(?:blob|view-source|filesystem):/i.test(target)) target = target.slice(target.indexOf(":") + 1);
  return target;
}

/** Why a page or frame at `pageUrl` may not be shown, or null: refusedBrowserPage's decision, without its memory. */
async function pageAddressRefusal(pageUrl: string): Promise<string | null> {
  const target = innerPageUrl(pageUrl);
  if (/^file:/i.test(target)) return "a local file is not allowed";
  return /^https?:\/\//i.test(target) ? checkUrlSsrf(target) : null;
}

/** A frame list as the page reported it: its addresses, or null when it is not a list of them. */
function frameList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : null;
}

/**
 * Why a page's frames may not be shown, or null: one on a host the guard refuses, one whose
 * address could not be read, or a list that could not be read (null). This keeps a frame's
 * content out of the answer; only egress control on the browser's network stops the request
 * the frame made.
 */
export async function refusedFrameUrls(reported: unknown): Promise<string | null> {
  const frames = frameList(reported);
  if (frames === null) return "the addresses of its frames could not be read";
  const checked = new Set<string>();
  for (const frame of frames) {
    if (!frame) return "the address of one of its frames could not be read";
    let origin = frame;
    try {
      origin = new URL(innerPageUrl(frame)).origin;
    } catch {
      // checked as it is
    }
    if (checked.has(origin)) continue;
    checked.add(origin);
    const refused = await pageAddressRefusal(frame);
    if (refused) return `a frame on it: ${refused}`;
  }
  return null;
}

/** Whether a Playwright MCP answer carries an image of the page (a screenshot), which shows its frames too. */
function carriesImage(output: string): boolean {
  return /"type"\s*:\s*"image"/.test(output);
}

/** Whether a Playwright MCP answer carries something of the page: a snapshot, an image or a result. */
function carriesPageContent(output: string): boolean {
  return /```ya?ml/.test(output) || carriesImage(output) || /^#{1,4}[ \t]*Result\b/m.test(output);
}

/** Whether a snapshot in the answer shows a frame's content: an iframe, or an element inside one (a ref such as f1e2). */
function showsFrames(output: string): boolean {
  return /^[ \t]*-[ \t]+'?iframe\b/m.test(output) || /\[ref=f\d+e\d+\]/.test(output);
}

/** browser_evaluate's function for the tab's address and its frames' (FRAME_ADDRESSES), as one JSON string. */
const PAGE_ADDRESSES = `() => JSON.stringify({ u: location.href, f: ${FRAME_ADDRESSES} })`;

/** The address of the page the shared browser tab is on and its frames', read now; null where they cannot be read. */
async function readPageAddresses(): Promise<{ page: string | null; frames: string[] | null }> {
  try {
    const output = await callPlaywrightTool("browser_evaluate", { function: PAGE_ADDRESSES });
    const value: unknown = JSON.parse(evaluateResultText(output));
    const read = value !== null && typeof value === "object" ? (value as { u?: unknown; f?: unknown }) : {};
    const page = typeof read.u === "string" && /^[a-z][a-z0-9+.-]*:\S*$/i.test(read.u) ? read.u : reportedPageUrls(output)[0] ?? null;
    return { page, frames: frameList(read.f) };
  } catch {
    return { page: null, frames: null };
  }
}

/**
 * Why the browser answers in `outputs` may not be shown, or null. The page URLs they report are
 * checked. An answer that carries something of the page but reports no URL, such as a
 * screenshot taken while the tab's header had not changed, passed unchecked; the tab's address
 * is now read for it, and one that cannot be read refuses it. An answer that shows frames (an
 * iframe in its snapshot, or an image of the page) has its frames' addresses read and checked;
 * a page without frames costs no extra call.
 */
export async function refusedBrowserAnswer(outputs: readonly string[]): Promise<string | null> {
  const pageUrls = outputs.flatMap((output) => reportedPageUrls(output));
  if (pageUrls.length > 0) {
    const refused = await refusedBrowserPage(pageUrls);
    if (refused) return refused;
  }
  const pageUnknown = pageUrls.length === 0 && outputs.some((output) => carriesPageContent(output));
  const framesShown = outputs.some((output) => showsFrames(output) || carriesImage(output));
  if (!pageUnknown && !framesShown) return null;
  const read = await readPageAddresses();
  if (pageUnknown) {
    if (read.page === null) return "its address could not be read";
    const refused = await refusedBrowserPage([read.page]);
    if (refused) return refused;
  }
  return refusedFrameUrls(read.frames);
}

/** Sends the shared browser tab to about:blank after a refused page, so no later call starts on it. */
export async function leaveRefusedPage(): Promise<void> {
  try {
    await callPlaywrightTool("browser_navigate", { url: "about:blank" });
  } catch (err) {
    log.warn({ err }, "could not send the browser to about:blank after a refused page");
  }
}

/**
 * The guard turned a request away before it was sent: the host, or the target of a redirect
 * on the way, is private or internal, a redirect left http(s), or the chain was still going at
 * the hop limit, so the guard never saw where it ends. It is kept apart from network errors
 * because web_fetch hands those to the browser, and the browser follows the same redirects with
 * nothing checking where they lead.
 */
class SsrfRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfRefusal";
  }
}

/**
 * fetch() that re-runs the SSRF guard on EVERY redirect hop. The plain guard only
 * validated the initial URL, so a public URL that 30x-redirected to 169.254.169.254
 * or an internal host bypassed it. Follows redirects manually, re-checking each
 * Location target's host (and its DNS) before the next request; a host or target it
 * turns away throws SsrfRefusal. Only for user/LLM-supplied URLs — NOT the configured
 * (trusted) search backends.
 */
async function safeFetch(url: string, ms: number, init?: RequestInit, maxRedirects = 5): Promise<Response> {
  return (await safeFetchFinal(url, ms, init, maxRedirects)).res;
}

/**
 * safeFetch, also returning the URL of the hop that answered. A page's relative links resolve
 * against that URL, not the one requested (/produkte answered from /produkte/seite-1.html), and
 * `res.url` cannot be relied on for it: it is "" on a Response that was not fetched.
 *
 * `chainBudgetMs` bounds the whole chain. Once a redirect has been followed, a hop that runs out
 * of time, its own `ms` or what is left of the budget, is a refusal rather than a network error:
 * web_fetch hands a network error to the browser, which walks the rest of the chain unchecked,
 * so a slow hop was a way past the per-hop check. The first request keeps its own timeout and
 * fails as before.
 */
async function safeFetchFinal(url: string, ms: number, init?: RequestInit, maxRedirects = 5, chainBudgetMs = Number.POSITIVE_INFINITY): Promise<{ res: Response; finalUrl: string }> {
  const deadline = Date.now() + chainBudgetMs;
  const tooSlow = () => new SsrfRefusal(`${url}: the redirect chain took too long; it is not followed further`);
  let current = url;
  // The URLs this chain has requested, fragments dropped (they are never sent).
  const requested = new Set<string>();
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let host: string;
    try {
      host = new URL(current).hostname;
    } catch {
      throw new Error("Invalid URL");
    }
    if (await hostIsBlocked(host)) {
      throw new SsrfRefusal(hop === 0
        ? "Fetching private/internal network addresses is not allowed"
        : `${url} redirects to a private/internal network address; fetching it is not allowed`);
    }
    // The host check above resolves the name, which can take as long as its server likes.
    const left = deadline - Date.now();
    if (hop > 0 && left <= 0) throw tooSlow();
    requested.add(withoutFragment(current));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), hop === 0 ? ms : Math.min(ms, left));
    let res: Response;
    try {
      res = await fetch(current, { ...init, signal: controller.signal, redirect: "manual", dispatcher: guardedDispatcher } as RequestInit);
    } catch (err) {
      if (hop > 0 && controller.signal.aborted) throw tooSlow();
      // The name passed the check above and resolved to a private address when connecting: a
      // refusal, never a network error the browser, which resolves names itself, gets to retry.
      const refused = connectRefusalReason(err);
      if (refused) throw new SsrfRefusal(`${url}: ${refused}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      const next = new URL(res.headers.get("location")!, current).toString();
      if (!/^https?:\/\//i.test(next)) throw new SsrfRefusal("Redirect to a non-http(s) scheme is not allowed");
      // Back to a URL the guard already let through: a loop, such as a cookie check that only a
      // client keeping cookies gets past. Not a refusal, so web_fetch still tries the browser.
      if (requested.has(withoutFragment(next))) throw new Error("Redirect loop");
      current = next;
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new SsrfRefusal(`${url} redirects more than ${maxRedirects} times; it is not followed further`);
}

function withoutFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
}

/** The eight 16-bit groups of an IPv6 address (a trailing dotted IPv4 counts as two), or null. */
function ipv6Hextets(address: string): number[] | null {
  if (!address.includes(":")) return null;
  let text = address;
  const tail: number[] = [];
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = dotted.slice(2, 6).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    tail.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
    text = dotted[1]!.endsWith("::") ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":").map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN)));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  if ([...head, ...rest].some((group) => Number.isNaN(group))) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1) return known === 8 ? [...head, ...tail] : null;
  return known <= 7 ? [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail] : null;
}

/**
 * The IPv4 address an IPv6 address carries, dotted, or null: IPv4-mapped ::ffff:a.b.c.d (also
 * written ::ffff:xxxx:xxxx), IPv4-translated ::ffff:0:a.b.c.d, the deprecated IPv4-compatible
 * ::a.b.c.d and the NAT64 well-known prefix 64:ff9b::/96. A connection to any of these reaches
 * the IPv4 address.
 */
function embeddedIPv4(address: string): string | null {
  const g = ipv6Hextets(address);
  if (!g) return null;
  const zeroTo = (end: number) => g.slice(0, end).every((group) => group === 0);
  const mapped = zeroTo(5) && g[5] === 0xffff;
  const translated = zeroTo(4) && g[4] === 0xffff && g[5] === 0;
  const compatible = zeroTo(6);
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((group) => group === 0);
  if (!mapped && !translated && !compatible && !nat64) return null;
  return `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
}

/** Whether a dotted IPv4 address is loopback, RFC 1918, link-local (metadata) or in 0.0.0.0/8. */
function isPrivateIPv4(dotted: string): boolean {
  const [a, b] = dotted.split(".").map(Number);
  return a === 127 || a === 10 || a === 0 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function isPrivateHost(host: string): boolean {
  // Strip IPv6 brackets if present; lowercase so IPv6 hextets match case-insensitively.
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();

  // Loopback, and every name under .localhost (RFC 6761): a subdomain of it was left to the
  // resolver, and one answering NXDOMAIN let it through while a browser maps it to loopback.
  if (h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1") return true;
  // Unspecified / any-address
  if (h === "0.0.0.0" || h === "::") return true;
  // IPv6 Unique-Local Addresses fc00::/7 (fc00–fdff first hextet). The 4-hex-digit
  // hextet + colon shape avoids over-blocking public hostnames like "fcbarcelona.com".
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  // IPv6 link-local fe80::/10 (fe80–febf first hextet)
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  // An IPv6 address that carries an IPv4 one reaches that IPv4 address, so it is judged as it.
  // Only the dotted ::ffff: forms of 127/8 and RFC 1918 were known here, and the metadata
  // endpoint as ::ffff:169.254.169.254 (::ffff:a9fe:a9fe once URL parsing has written it) passed.
  const embedded = embeddedIPv4(h);
  if (embedded !== null) return isPrivateIPv4(embedded);
  // 0.0.0.0/8 (dotted form): "this network", which reaches the host itself.
  if (/^0\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  // Loopback 127.0.0.0/8 (dotted form) — the literal check above only caught
  // 127.0.0.1, so 127.0.0.2 … 127.255.255.255 (all loopback) slipped through.
  if (h.startsWith("127.")) return true;
  // RFC 1918 private ranges
  if (h.startsWith("10.")) return true;
  if (h.startsWith("192.168.")) return true;
  // 172.16.0.0/12 → 172.16.x.x through 172.31.x.x only (not all 172.x)
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  // Link-local (APIPA: 169.254.0.0/16)
  if (h.startsWith("169.254.")) return true;
  // Cloud metadata endpoint (AWS, GCP, Azure)
  if (h === "metadata.google.internal" || h === "169.254.169.254") return true;
  // Docker / internal DNS
  if (h === "host.docker.internal" || h.endsWith(".internal")) return true;
  // Decimal IP for 127.0.0.1 = 2130706433
  const decimalIp = Number(h);
  if (Number.isInteger(decimalIp) && decimalIp > 0) {
    const a = (decimalIp >>> 24) & 0xff;
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && ((decimalIp >>> 16) & 0xff) === 168) return true;
    if (a === 172) {
      const b = (decimalIp >>> 16) & 0xff;
      if (b >= 16 && b <= 31) return true;
    }
    if (a === 169 && ((decimalIp >>> 16) & 0xff) === 254) return true;
  }
  // Octal/hex IP representations (0x7f000001, 0177.0.0.1)
  if (/^0[xX][0-9a-fA-F]+$/.test(h)) {
    const num = parseInt(h, 16);
    if (isPrivateHost(String(num))) return true;
  }
  return false;
}

function stripHtml(html: string): string {
  // Remove scripts, styles, comments
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{3,}/g, "\n\n")
    .trim();
  return decodeHtmlEntities(text);
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function resolveSearchBackendConfig(config: Config = getConfig()): ResolvedSearchBackendConfig {
  const searchConfig = config.retrieval.search;
  const searxngBaseUrl = searchConfig.searxngBaseUrl?.trim() || process.env["SEARXNG_BASE_URL"]?.trim();
  const playwrightAvailable = getMcpConnections().has("playwright");

  if (searchConfig.backend === "searxng") {
    // Always include playwright (when available) and DuckDuckGo as hard fallbacks
    // so a degraded/offline SearXNG instance automatically retries via browser
    // search and then DuckDuckGo without the agent seeing a zero-result failure.
    const backends: SearchBackend[] = ["searxng"];
    if (playwrightAvailable) backends.push("playwright");
    backends.push("duckduckgo");
    return {
      requestedBackend: "searxng",
      backends,
      searxngBaseUrl,
      timeoutMs: searchConfig.timeoutMs,
    };
  }

  if (searchConfig.backend === "duckduckgo") {
    return {
      requestedBackend: "duckduckgo",
      backends: ["duckduckgo"],
      searxngBaseUrl,
      timeoutMs: searchConfig.timeoutMs,
    };
  }

  // auto mode: SearXNG → Playwright → DuckDuckGo
  const backends: SearchBackend[] = [];
  if (searxngBaseUrl) backends.push("searxng");
  if (playwrightAvailable) backends.push("playwright");
  backends.push("duckduckgo");

  return {
    requestedBackend: "auto",
    backends,
    searxngBaseUrl,
    timeoutMs: searchConfig.timeoutMs,
  };
}

const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "into",
  "is", "it", "latest", "of", "on", "or", "roadmap", "the", "to", "what", "when", "where",
  "which", "who", "with",
]);

interface AcronymExpansionRule {
  acronym: string;
  expansion: string;
  triggerTerms: string[];
}

const SEARCH_ACRONYM_EXPANSIONS: AcronymExpansionRule[] = [
  {
    acronym: "mcp",
    expansion: '"Model Context Protocol"',
    triggerTerms: [
      "ai", "agent", "agents", "anthropic", "api", "apis", "assistant", "assistants",
      "context", "documentation", "docs", "github", "llm", "llms", "model", "models",
      "prompt", "prompts", "protocol", "server", "servers", "spec", "specification",
      "tool", "tools",
    ],
  },
];

interface RankedSearchResult extends SearchResult {
  score: number;
}

interface SearchHeuristicsMetadata {
  phrases: string[];
  keywordTerms: string[];
  acronymTerms: string[];
}

interface SearchRankingMetadata {
  topResults: Array<{ title: string; url: string; score: number }>;
  heuristics: SearchHeuristicsMetadata;
}

interface QuerySignals {
  phrases: string[];
  keywordTerms: string[];
  acronymTerms: string[];
}

function extractQuerySignals(query: string): QuerySignals {
  const normalized = query.trim().toLowerCase();
  const phrases = [...normalized.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((phrase) => phrase.length >= 3);

  const keywordTerms: string[] = [];
  const acronymTerms: string[] = [];

  for (const rawToken of normalized.split(/[^a-z0-9]+/i)) {
    if (!rawToken) continue;
    if (SEARCH_STOP_WORDS.has(rawToken)) continue;
    if (/^[a-z]+\d+$/.test(rawToken)) {
      keywordTerms.push(rawToken);
      continue;
    }
    if (rawToken.length >= 3 && /\d/.test(rawToken)) {
      keywordTerms.push(rawToken);
      continue;
    }
    if (rawToken.length <= 4) {
      acronymTerms.push(rawToken);
      continue;
    }
    keywordTerms.push(rawToken);
  }

  return {
    phrases,
    keywordTerms: [...new Set(keywordTerms)],
    acronymTerms: [...new Set(acronymTerms)],
  };
}

function countWholeWordMatches(haystack: string, term: string): number {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = haystack.match(new RegExp(`\\b${escaped}\\b`, "g"));
  return matches?.length ?? 0;
}

function scoreSearchResult(result: SearchResult, signals: QuerySignals): number {
  const title = result.title.toLowerCase();
  const url = result.url.toLowerCase();
  const snippet = result.snippet.toLowerCase();
  const combined = `${title}\n${url}\n${snippet}`;

  let score = 0;
  let matchedKeywordTerms = 0;
  let matchedAcronymTerms = 0;

  for (const phrase of signals.phrases) {
    if (combined.includes(phrase)) score += 8;
    else if (title.includes(phrase)) score += 6;
  }

  for (const term of signals.keywordTerms) {
    const titleMatches = countWholeWordMatches(title, term);
    const urlMatches = countWholeWordMatches(url, term);
    const snippetMatches = countWholeWordMatches(snippet, term);
    const termScore = titleMatches * 4 + urlMatches * 2.5 + snippetMatches * 1.5;
    if (termScore > 0) {
      matchedKeywordTerms += 1;
      score += termScore;
    }
  }

  for (const term of signals.acronymTerms) {
    const titleMatches = countWholeWordMatches(title, term);
    const urlMatches = countWholeWordMatches(url, term);
    const snippetMatches = countWholeWordMatches(snippet, term);
    const termScore = titleMatches * 1.2 + urlMatches * 0.8 + snippetMatches * 0.4;
    if (termScore > 0) {
      matchedAcronymTerms += 1;
      score += termScore;
    }
  }

  if (signals.keywordTerms.length > 0) {
    score += (matchedKeywordTerms / signals.keywordTerms.length) * 6;
  }

  if (signals.keywordTerms.length >= 2 && matchedKeywordTerms === 0 && matchedAcronymTerms > 0) {
    score -= 6;
  }

  if (signals.keywordTerms.length >= 3 && matchedKeywordTerms === 1 && matchedAcronymTerms > 0) {
    score -= 3;
  }

  return score;
}

export function rankSearchResults(query: string, results: SearchResult[], maxResults: number): RankedSearchResult[] {
  const signals = extractQuerySignals(query);
  const ranked = results
    .map((result) => ({ ...result, score: scoreSearchResult(result, signals) }))
    .sort((left, right) => right.score - left.score) as RankedSearchResult[];

  const positive = ranked.filter((result) => result.score > 0);
  const selected = positive.length > 0 ? positive : ranked;
  return selected.slice(0, maxResults);
}

export function rerankSearchResults(query: string, results: SearchResult[], maxResults: number): SearchResult[] {
  return rankSearchResults(query, results, maxResults).map(({ score: _score, ...result }) => result);
}

export function expandSearchQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return trimmed;

  const normalized = trimmed.toLowerCase();
  const signals = extractQuerySignals(trimmed);
  const signalTerms = new Set([...signals.keywordTerms, ...signals.acronymTerms]);

  let expanded = trimmed;
  for (const rule of SEARCH_ACRONYM_EXPANSIONS) {
    const acronymPattern = new RegExp(`\\b${rule.acronym}\\b`, "i");
    if (!acronymPattern.test(normalized)) continue;
    if (normalized.includes(rule.expansion.toLowerCase().replace(/"/g, ""))) continue;

    const matchedTrigger = rule.triggerTerms.some((term) => signalTerms.has(term));
    if (!matchedTrigger) continue;

    expanded = `${expanded} ${rule.expansion}`;
  }

  return expanded;
}

// ─── SearXNG (self-hosted, most reliable) ────────────────────────────────────

/** SearXNG's `unresponsive_engines` — `[engine, reason]` pairs — as "engine (reason)" strings. */
function describeUnresponsiveEngines(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    if (Array.isArray(entry)) {
      const [engine, reason] = entry as unknown[];
      return reason ? `${String(engine)} (${String(reason)})` : String(engine);
    }
    return String(entry);
  }).filter(Boolean);
}

async function searchSearxng(query: string, maxResults: number, baseUrl: string, timeoutMs: number): Promise<{
  results: SearchResult[];
  rewrittenQuery: string;
  ranking: SearchRankingMetadata;
  unresponsiveEngines: string[];
}> {
  const rewrittenQuery = expandSearchQuery(query);
  const url = `${baseUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(rewrittenQuery)}&format=json&categories=general&language=auto`;
  const res = await fetchWithTimeout(url, timeoutMs, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "StarlingAI/0.1",
    },
  });

  if (!res.ok) throw new Error(`SearXNG returned HTTP ${res.status}`);
  const data = await res.json() as { results?: Array<{ title?: string; url?: string; content?: string }>; unresponsive_engines?: unknown };

  const rawResults = (data.results ?? []).map(r => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  })).filter(r => r.title && r.url);

  // An empty result list while engines did not answer is an OUTAGE, not an empty web: SearXNG
  // reports rate-limited, CAPTCHA'd and timed-out upstreams here and still answers HTTP 200.
  // Thrown, it is recorded as this backend's error and the next backend is tried.
  const unresponsiveEngines = describeUnresponsiveEngines(data.unresponsive_engines);
  if (rawResults.length === 0 && unresponsiveEngines.length > 0) {
    throw new Error(`SearXNG returned no results and ${unresponsiveEngines.length} engine(s) did not respond: ${unresponsiveEngines.join(", ")}`);
  }

  const rankedResults = rankSearchResults(rewrittenQuery, rawResults, maxResults);
  const signals = extractQuerySignals(rewrittenQuery);

  return {
    unresponsiveEngines,
    results: rankedResults.map(({ score: _score, ...result }) => result),
    rewrittenQuery,
    ranking: {
      topResults: rankedResults.slice(0, 3).map((result) => ({
        title: result.title,
        url: result.url,
        score: Number(result.score.toFixed(3)),
      })),
      heuristics: {
        phrases: signals.phrases,
        keywordTerms: signals.keywordTerms,
        acronymTerms: signals.acronymTerms,
      },
    },
  };
}

// ─── Playwright browser-based search (DuckDuckGo via rendered browser) ───────

async function searchPlaywright(query: string, maxResults: number, _timeoutMs: number): Promise<{
  results: SearchResult[];
  rewrittenQuery: string;
  ranking: SearchRankingMetadata;
}> {
  const rewrittenQuery = expandSearchQuery(query);
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(rewrittenQuery)}&kl=wt-wt`;

  await callPlaywrightTool("browser_navigate", { url: searchUrl });
  const snapshot = await callPlaywrightTool("browser_snapshot", {});

  const rawResults = parsePlaywrightSearchSnapshot(snapshot);
  const rankedResults = rankSearchResults(rewrittenQuery, rawResults, maxResults);
  const signals = extractQuerySignals(rewrittenQuery);

  return {
    results: rankedResults.map(({ score: _score, ...result }) => result),
    rewrittenQuery,
    ranking: {
      topResults: rankedResults.slice(0, 3).map((result) => ({
        title: result.title,
        url: result.url,
        score: Number(result.score.toFixed(3)),
      })),
      heuristics: {
        phrases: signals.phrases,
        keywordTerms: signals.keywordTerms,
        acronymTerms: signals.acronymTerms,
      },
    },
  };
}

/**
 * Parse search results from a Playwright accessibility snapshot of
 * DuckDuckGo's HTML-lite results page.
 *
 * The snapshot contains lines like:
 *   - link "Title text" [ref=...] -> url
 *   - text: snippet text
 * We extract link text as title, the href as url, and subsequent
 * non-link text as snippet.
 */
function parsePlaywrightSearchSnapshot(snapshot: string): SearchResult[] {
  const results: SearchResult[] = [];
  const lines = snapshot.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    // Match accessibility snapshot link entries
    // Format: - link "Title" [ref=...] -> https://url
    const linkMatch = line.match(/^-\s*link\s+"([^"]+)"\s*(?:\[ref=[^\]]*\]\s*)?->\s*(.+)$/i);
    if (!linkMatch) continue;

    const rawTitle = linkMatch[1]!.trim();
    const rawUrl = linkMatch[2]!.trim();

    // Skip DuckDuckGo navigation/internal links
    if (!rawUrl.startsWith("http")) continue;
    if (/duckduckgo\.com\/(about|settings|bangs|params|feedback)/i.test(rawUrl)) continue;

    // Decode DuckDuckGo redirect URLs
    const url = decodeDuckDuckGoResultUrl(rawUrl);

    // Skip duplicate URLs
    if (results.some(r => r.url === url)) continue;

    // Gather the snippet from the next few non-link text lines
    let snippet = "";
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const nextLine = lines[j]!.trim();
      if (nextLine.startsWith("- link ")) break;
      // Pick up text content (format varies: "- text: ..." or just text)
      const textMatch = nextLine.match(/^(?:-\s*)?(?:text:\s*)?(.+)/);
      if (textMatch && textMatch[1] && !textMatch[1].startsWith("- ")) {
        snippet = textMatch[1].trim();
        break;
      }
    }

    results.push({ title: rawTitle, url, snippet });
  }

  return results;
}

async function searchDuckDuckGo(query: string, maxResults: number, timeoutMs: number): Promise<{
  results: SearchResult[];
  rewrittenQuery: string;
  ranking: SearchRankingMetadata;
}> {
  const rewrittenQuery = expandSearchQuery(query);
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(rewrittenQuery)}&kl=wt-wt`;
  const res = await fetchWithTimeout(url, timeoutMs, {
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "User-Agent": "StarlingAI/0.1",
    },
  });

  if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
  const html = await res.text();
  const rawResults = parseDuckDuckGoResults(html);
  const rankedResults = rankSearchResults(rewrittenQuery, rawResults, maxResults);
  const signals = extractQuerySignals(rewrittenQuery);

  return {
    results: rankedResults.map(({ score: _score, ...result }) => result),
    rewrittenQuery,
    ranking: {
      topResults: rankedResults.slice(0, 3).map((result) => ({
        title: result.title,
        url: result.url,
        score: Number(result.score.toFixed(3)),
      })),
      heuristics: {
        phrases: signals.phrases,
        keywordTerms: signals.keywordTerms,
        acronymTerms: signals.acronymTerms,
      },
    },
  };
}

function parseDuckDuckGoResults(html: string): SearchResult[] {
  const anchorPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const matches = [...html.matchAll(anchorPattern)];
  const results: SearchResult[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match) continue;

    const nextIndex = matches[index + 1]?.index ?? html.length;
    const segment = html.slice(match.index ?? 0, nextIndex);
    const title = collapseWhitespace(stripHtml(match[2] ?? ""));
    const url = collapseWhitespace(decodeDuckDuckGoResultUrl(match[1] ?? ""));
    const snippetMatch = segment.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    const snippet = collapseWhitespace(stripHtml(snippetMatch?.[1] ?? ""));

    if (!title || !url) continue;
    if (results.some((result) => result.url === url)) continue;

    results.push({ title, url, snippet });
  }

  return results;
}

function decodeDuckDuckGoResultUrl(rawUrl: string): string {
  const normalized = decodeHtmlEntities(rawUrl).trim();

  try {
    const url = new URL(normalized.startsWith("//") ? `https:${normalized}` : normalized, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    return target ? target : url.toString();
  } catch {
    return normalized;
  }
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_match, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, value: string) => String.fromCodePoint(parseInt(value, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function formatSearchError(requestedBackend: "auto" | SearchBackend, backendErrors: string[]): string {
  if (backendErrors.length === 0) {
    return requestedBackend === "searxng"
      ? "Search failed: SearXNG is configured but unavailable. Check retrieval.search.searxngBaseUrl or SEARXNG_BASE_URL."
      : "Search failed: no search backend is available.";
  }

  const notEvidence = " — the search did not run, so this is not evidence that nothing exists.";
  if (requestedBackend === "auto") {
    return `Search failed across available backends: ${backendErrors.join("; ")}${notEvidence}`;
  }

  return `Search failed: ${backendErrors.join("; ")}${notEvidence}`;
}

