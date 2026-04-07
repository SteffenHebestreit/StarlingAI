import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { getConfig } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import { resolve as dnsResolve } from "node:dns/promises";
import { callPlaywrightTool } from "./multimodal.js";
import { getMcpConnections } from "../mcp/registry.js";

const log = childLogger("tool:web");

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
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      maxResults: { type: "number", description: "Max results to return (1-10)", default: 5 },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const query = String(args["query"] ?? "");
    const maxResults = Math.min(10, Math.max(1, Number(args["maxResults"] ?? 5)));
    const searchConfig = resolveSearchBackendConfig();

    if (!query.trim()) {
      return { success: false, output: "", error: "Search query cannot be empty" };
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
          return {
            success: true,
            output: `No results found for "${query}" from the ${backend} backend.${queryNote}\nTry rephrasing or use different keywords.`,
            metadata: {
              query,
              rewrittenQuery,
              backend,
              attemptedBackends,
              requestedBackend: searchConfig.requestedBackend,
              ranking,
            },
          };
        }

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

        if (searchConfig.requestedBackend === "auto" && attemptedBackends.length < searchConfig.backends.length) {
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
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch (must be a public http/https URL)" },
      maxLength: { type: "number", description: "Max characters to return (default 8000)", default: 8000 },
    },
    required: ["url"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const url = String(args["url"] ?? "");
    const maxLength = Math.min(32000, Math.max(500, Number(args["maxLength"] ?? 8000)));

    if (!url.match(/^https?:\/\//i)) {
      return { success: false, output: "", error: "URL must start with http:// or https://" };
    }

    // Block private/internal IPs (SSRF prevention)
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (isPrivateHost(host)) {
        return { success: false, output: "", error: "Fetching private/internal network addresses is not allowed" };
      }
      // DNS resolution check — prevents DNS rebinding and hostname tricks
      try {
        const addrs = await dnsResolve(host);
        if (addrs.some(addr => isPrivateHost(addr))) {
          return { success: false, output: "", error: "Fetching private/internal network addresses is not allowed" };
        }
      } catch {
        // DNS failure — allow through (could be IP literal or unavailable resolver)
      }
    } catch {
      return { success: false, output: "", error: "Invalid URL" };
    }

    try {
      // Lightweight HEAD to determine content type before committing to a strategy
      let contentType = "";
      try {
        const headRes = await fetchWithTimeout(url, 8000, {
          method: "HEAD",
          headers: { "User-Agent": "StarlingAI/0.1 (research assistant)" },
        });
        contentType = headRes.headers.get("content-type") ?? "";
      } catch {
        // HEAD failed (some servers reject it) — fall through to full request
      }

      const isJsonApi = /\bjson\b/i.test(contentType);

      // JSON / API responses → native fetch (no browser needed)
      if (isJsonApi) {
        const res = await fetchWithTimeout(url, 15000, {
          headers: {
            "User-Agent": "StarlingAI/0.1 (research assistant)",
            "Accept": "application/json,text/plain,*/*",
          },
        });

        if (!res.ok) {
          return { success: false, output: "", error: `HTTP ${res.status} from ${url}` };
        }

        let text = await res.text();
        if (text.length > maxLength) {
          text = text.substring(0, maxLength) + `\n\n[Content truncated at ${maxLength} chars]`;
        }
        return {
          success: true,
          output: `**Content from:** ${url}\n\n${text}`,
          metadata: { url, contentLength: text.length, contentType, fetchMethod: "native" },
        };
      }

      // HTML / other content → prefer Playwright (renders JS, handles cookie banners)
      const playwrightAvailable = getMcpConnections().has("playwright");
      if (playwrightAvailable) {
        try {
          await callPlaywrightTool("browser_navigate", { url });
          const snapshot = await callPlaywrightTool("browser_snapshot", {});
          let text = snapshot;
          if (text.length > maxLength) {
            text = text.substring(0, maxLength) + `\n\n[Content truncated at ${maxLength} chars]`;
          }
          return {
            success: true,
            output: `**Content from:** ${url}\n\n${text}`,
            metadata: { url, contentLength: text.length, contentType: contentType || "text/html", fetchMethod: "playwright" },
          };
        } catch (playwrightErr) {
          log.warn({ err: playwrightErr, url }, "web_fetch Playwright failed, falling back to native fetch");
        }
      }

      // Fallback: native fetch with HTML stripping
      const res = await fetchWithTimeout(url, 15000, {
        headers: {
          "User-Agent": "StarlingAI/0.1 (research assistant)",
          "Accept": "text/html,application/xhtml+xml,text/plain,*/*",
        },
      });

      if (!res.ok) {
        return { success: false, output: "", error: `HTTP ${res.status} from ${url}` };
      }

      const resContentType = res.headers.get("content-type") ?? "";
      let text: string;

      if (resContentType.includes("text/html")) {
        const html = await res.text();
        text = stripHtml(html);
      } else {
        text = await res.text();
      }

      if (text.length > maxLength) {
        text = text.substring(0, maxLength) + `\n\n[Content truncated at ${maxLength} chars]`;
      }

      return {
        success: true,
        output: `**Content from:** ${url}\n\n${text}`,
        metadata: { url, contentLength: text.length, contentType: resContentType, fetchMethod: "native_fallback" },
      };
    } catch (err) {
      log.error({ err, url }, "web_fetch failed");
      return { success: false, output: "", error: `Fetch failed: ${String(err)}` };
    }
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isPrivateHost(host: string): boolean {
  // Strip IPv6 brackets if present
  const h = host.replace(/^\[|\]$/g, "");

  // Loopback
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  // Unspecified / any-address
  if (h === "0.0.0.0" || h === "::") return true;
  // IPv6-mapped IPv4 loopback (::ffff:127.0.0.1)
  if (/^::ffff:127\./i.test(h)) return true;
  // IPv6-mapped private ranges
  if (/^::ffff:(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(h)) return true;
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
  let text = html
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
    return {
      requestedBackend: "searxng",
      backends: ["searxng"],
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

