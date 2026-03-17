import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { resolve as dnsResolve } from "node:dns/promises";

const log = childLogger("tool:web");

// StarlingAI relies on a configured SearXNG instance for web search.
const SEARXNG_BASE = process.env["SEARXNG_BASE_URL"];

registerTool({
  name: "web_search",
  description: "Search the web using the configured SearXNG instance. Returns top results with titles, URLs, and snippets.",
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

    if (!query.trim()) {
      return { success: false, output: "", error: "Search query cannot be empty" };
    }

    if (!SEARXNG_BASE) {
      return {
        success: false,
        output: "",
        error: "web_search requires SEARXNG_BASE_URL to be configured. StarlingAI relies exclusively on SearXNG for web search.",
      };
    }

    try {
      const results = await searchSearxng(query, maxResults, SEARXNG_BASE);
      const backend = "searxng";

      if (results.length === 0) {
        return {
          success: true,
          output: `No results found for "${query}" from the configured SearXNG backend. Try rephrasing or use different keywords.`,
          metadata: { query, backend },
        };
      }

      const formatted = results
        .map(r => `**${r.title}**\n${r.url}\n${r.snippet}`)
        .join("\n\n");

      return {
        success: true,
        output: `**Web Search Results for:** "${query}" (via ${backend})\n\n${formatted}`,
        metadata: { query, resultCount: results.length, backend },
      };
    } catch (err) {
      log.error({ err, query }, "web_search failed");
      return {
        success: false,
        output: "",
        error: `Search failed: ${String(err)}. Check that SEARXNG_BASE_URL points to a reachable SearXNG instance.`,
      };
    }
  },
});

registerTool({
  name: "web_fetch",
  description: "Fetch and read content from a public URL. Only works with unauthenticated public pages. Returns text content.",
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
      const res = await fetchWithTimeout(url, 15000, {
        headers: {
          "User-Agent": "StarlingAI/0.1 (research assistant)",
          "Accept": "text/html,application/xhtml+xml,text/plain,*/*",
        },
      });

      if (!res.ok) {
        return { success: false, output: "", error: `HTTP ${res.status} from ${url}` };
      }

      const contentType = res.headers.get("content-type") ?? "";
      let text: string;

      if (contentType.includes("text/html")) {
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
        metadata: { url, contentLength: text.length, contentType },
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
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, "\n\n")
    .trim();
  return text;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ─── SearXNG (self-hosted, most reliable) ────────────────────────────────────

async function searchSearxng(query: string, maxResults: number, baseUrl: string): Promise<SearchResult[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json&categories=general&language=auto`;
  const res = await fetchWithTimeout(url, 12000, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "StarlingAI/0.1",
    },
  });

  if (!res.ok) throw new Error(`SearXNG returned HTTP ${res.status}`);
  const data = await res.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };

  return (data.results ?? []).slice(0, maxResults).map(r => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  })).filter(r => r.title && r.url);
}

