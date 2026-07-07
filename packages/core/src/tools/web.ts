import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { getConfig } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import { lookup as dnsLookup } from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { analyzeImageBytes, callPlaywrightTool, extractDocumentBytesToMarkdown } from "./multimodal.js";
import { resolveWorkspaceWritePath } from "./workspace-path.js";
import { getMcpConnections } from "../mcp/registry.js";

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
 * Extract the root session UUID from a potentially nested sub-agent session ID.
 * sub:sub:ROOT:coord:ts:researcher:ts → ROOT
 * sub:ROOT:agent:ts                   → ROOT
 * ROOT                                → ROOT
 */
function getRootSessionId(sessionId: string): string {
  const stripped = sessionId.replace(/^(?:sub:)+/, "");
  // The root session is always the first colon-delimited segment (a UUID)
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
        let searchOutcome: { results: SearchResult[]; rewrittenQuery: string; ranking: SearchRankingMetadata };

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
            },
          };
        }

        // Successful results — reset the streak
        resetZeroResultStreak(sessionId);

        const formatted = results
          .map(r => `**${r.title}**\n${r.url}\n${r.snippet}`)
          .join("\n\n");

        return {
          success: true,
          output: `**Web Search Results for:** "${query}" (via ${backend})${queryNote}\n\n${formatted}`,
          metadata: {
            query,
            rewrittenQuery,
            resultCount: results.length,
            backend,
            attemptedBackends,
            requestedBackend: searchConfig.requestedBackend,
            ranking,
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

registerTool({
  name: "web_fetch",
  description: "Fetch and read content from a public URL. Uses Playwright for HTML pages (renders JavaScript) and native fetch for JSON APIs. Returns text content.",
  embeddingDescription: "Fetch, download, retrieve, load content from a URL or webpage. Webseite abrufen, URL aufrufen, Seiteninhalt laden, HTML holen. Read online page contents.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch (must be a public http/https URL)" },
      maxLength: { type: "number", description: "Max characters to return (default 8000)", default: 8000 },
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
      try {
        const res = await safeFetch(url, 12000, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; StarlingAI/0.1; +https://starlingai.io)",
            "Accept": "text/html,application/xhtml+xml,application/json,text/plain,*/*",
          },
        });
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
          // accessibility-tree noise that browser_snapshot produces.
          if (ct.includes("text/html")) raw = stripHtml(raw);
          if (raw.trim().length > 200) {
            nativeFetchText = raw.trim();
          }
        }
      } catch {
        // ignore — fall through to Playwright
      }

      if (nativeFetchText !== null) {
        let text = nativeFetchText;
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + `\n\n[Content truncated at ${maxLength} chars]`;
        }
        return {
          success: true,
          output: `**Content from:** ${url}\n\n${text}${shareSuffix}`,
          metadata: { url, contentLength: text.length, contentType: contentType || "text/html", fetchMethod: "native" },
        };
      }

      // Native fetch returned empty/short content — page is JS-rendered.
      // Use Playwright, but convert the accessibility snapshot to readable text
      // rather than passing the raw YAML DOM tree to the LLM.
      const playwrightAvailable = getMcpConnections().has("playwright");
      if (playwrightAvailable) {
        try {
          await callPlaywrightTool("browser_navigate", { url });
          let text = "";
          try {
            // browser_evaluate is available in Playwright MCP >= 0.0.21
            text = await callPlaywrightTool("browser_evaluate", {
              expression: `(document.body?.innerText??'').replace(/\\t/g,' ').replace(/[ \\t]{3,}/g,'  ').replace(/\\n{4,}/g,'\\n\\n\\n').trim()`,
            });
          } catch {
            // Fall back to snapshot and convert to readable text
            log.warn({ url }, "web_fetch: browser_evaluate unavailable, converting snapshot to text");
            const rawSnapshot = await callPlaywrightTool("browser_snapshot", {});
            text = snapshotToReadableText(rawSnapshot);
          }
          if (text.length > maxLength) {
            text = text.substring(0, maxLength) + `\n\n[Content truncated at ${maxLength} chars]`;
          }
          return {
            success: true,
            output: `**Content from:** ${url}\n\n${text}${shareSuffix}`,
            metadata: { url, contentLength: text.length, contentType: contentType || "text/html", fetchMethod: "playwright" },
          };
        } catch (playwrightErr) {
          log.warn({ err: playwrightErr, url }, "web_fetch Playwright failed");
        }
      }

      // Last resort: native fetch even if content seems thin
      try {
        const res = await safeFetch(url, 15000, {
          headers: {
            "User-Agent": "StarlingAI/0.1 (research assistant)",
            "Accept": "text/html,application/xhtml+xml,text/plain,*/*",
          },
        });
        if (!res.ok) {
          return { success: false, output: "", error: `HTTP ${res.status} from ${url}` };
        }
        const resContentType = res.headers.get("content-type") ?? "";
        let text = await res.text();
        if (resContentType.includes("text/html")) text = stripHtml(text);
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + `\n\n[Content truncated at ${maxLength} chars]`;
        }
        return {
          success: true,
          output: `**Content from:** ${url}\n\n${text}${shareSuffix}`,
          metadata: { url, contentLength: text.length, contentType: resContentType, fetchMethod: "native_fallback" },
        };
      } catch (err) {
        log.error({ err, url }, "web_fetch failed");
        return { success: false, output: "", error: `Fetch failed: ${String(err)}` };
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
 * Converts a Playwright browser_snapshot accessibility-tree output into compact
 * readable prose. The snapshot is a YAML DOM tree full of structural nodes
 * (generic, banner, listitem, [ref=eN], [cursor=pointer]) that are pure noise
 * for text synthesis. This function extracts heading and text nodes only and
 * caps output at maxChars.
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
      // - link "LABEL" — skip short nav labels
      const lm = line.match(/^-\s+link\s+"([^"]{7,})"/);
      if (lm?.[1] && !/^(Skip|Close|Back|Next|Previous|Search|Home|Menu|Login|Register|Contact|About|×)/i.test(lm[1])) {
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
    const res = await safeFetch(url, 20000, {
      headers: { "User-Agent": "StarlingAI/0.1 (research assistant)", "Accept": "application/pdf,*/*" },
    });
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
 * the original guard.
 */
async function hostIsBlocked(host: string): Promise<boolean> {
  const h = host.toLowerCase();
  if (isPrivateHost(h)) return true;
  try {
    const records = await dnsLookup(h, { all: true });
    if (records.some((r) => isPrivateHost(r.address))) return true;
  } catch {
    /* DNS failure — allow through (IP literal / unavailable resolver) */
  }
  return false;
}

/**
 * Shared SSRF gate for tools that hand a URL to an out-of-process fetcher which
 * has no guard of its own (the Playwright browser, which sits on the service
 * network and could otherwise be pointed at http://engram, http://10.x, or a
 * cloud-metadata endpoint and read the response back via a snapshot). Rejects
 * non-http(s) schemes and any host that resolves to a private/internal address.
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

/**
 * fetch() that re-runs the SSRF guard on EVERY redirect hop. The plain guard only
 * validated the initial URL, so a public URL that 30x-redirected to 169.254.169.254
 * or an internal host bypassed it. Follows redirects manually, re-checking each
 * Location target's host (and its DNS) before the next request. Only for
 * user/LLM-supplied URLs — NOT the configured (trusted) search backends.
 */
async function safeFetch(url: string, ms: number, init?: RequestInit, maxRedirects = 5): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let host: string;
    try {
      host = new URL(current).hostname;
    } catch {
      throw new Error("Invalid URL");
    }
    if (await hostIsBlocked(host)) {
      throw new Error("Fetching private/internal network addresses is not allowed");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    let res: Response;
    try {
      res = await fetch(current, { ...init, signal: controller.signal, redirect: "manual" });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      const next = new URL(res.headers.get("location")!, current).toString();
      if (!/^https?:\/\//i.test(next)) throw new Error("Redirect to a non-http(s) scheme is not allowed");
      current = next;
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects");
}

export function isPrivateHost(host: string): boolean {
  // Strip IPv6 brackets if present; lowercase so IPv6 hextets match case-insensitively.
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();

  // Loopback
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  // Unspecified / any-address
  if (h === "0.0.0.0" || h === "::") return true;
  // IPv6 Unique-Local Addresses fc00::/7 (fc00–fdff first hextet). The 4-hex-digit
  // hextet + colon shape avoids over-blocking public hostnames like "fcbarcelona.com".
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  // IPv6 link-local fe80::/10 (fe80–febf first hextet)
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  // IPv6-mapped IPv4 loopback (::ffff:127.0.0.1)
  if (/^::ffff:127\./i.test(h)) return true;
  // IPv6-mapped private ranges
  if (/^::ffff:(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(h)) return true;
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

async function searchSearxng(query: string, maxResults: number, baseUrl: string, timeoutMs: number): Promise<{
  results: SearchResult[];
  rewrittenQuery: string;
  ranking: SearchRankingMetadata;
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
  const data = await res.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };

  const rawResults = (data.results ?? []).map(r => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  })).filter(r => r.title && r.url);

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

  if (requestedBackend === "auto") {
    return `Search failed across available backends: ${backendErrors.join("; ")}`;
  }

  return `Search failed: ${backendErrors.join("; ")}`;
}

