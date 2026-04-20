/**
 * Wikipedia REST API — free, no key required.
 * https://en.wikipedia.org/api/rest_v1/
 */
import { registerDataFeedProvider } from "../provider-registry.js";
import { fetchJson } from "../shared.js";

export interface WikipediaQuery {
  /** Article title or free-text term to look up. */
  term: string;
  /** Wikipedia language edition (default "en"). */
  language?: string;
}

export interface WikipediaResult {
  title: string;
  language: string;
  description?: string;
  extract: string;
  url: string;
  thumbnail?: string;
  lastModified?: string;
}

interface SummaryResponse {
  title: string;
  description?: string;
  extract: string;
  content_urls?: { desktop?: { page?: string } };
  thumbnail?: { source: string };
  timestamp?: string;
}

interface SearchResponse {
  pages: Array<{ key: string; title: string; description?: string }>;
}

registerDataFeedProvider<WikipediaQuery, WikipediaResult>({
  id: "wikipedia",
  category: "reference",
  description: "Wikipedia article summaries (free, no API key, multi-language).",
  homepage: "https://en.wikipedia.org/api/rest_v1/",
  requiresApiKey: false,

  async fetch(query, ctx) {
    const term = query.term.trim();
    if (!term) throw new Error("term is required");
    const lang = (query.language ?? "en").trim().toLowerCase();
    const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term)}`;
    ctx.log.debug({ summaryUrl }, "wikipedia direct lookup");

    let summary: SummaryResponse;
    try {
      summary = await fetchJson<SummaryResponse>(summaryUrl, { trusted: true, signal: ctx.signal });
    } catch (err) {
      // Fall back to search-then-fetch when the direct title is not a page.
      ctx.log.debug({ err }, "wikipedia summary miss, trying search");
      const searchUrl = `https://${lang}.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(term)}&limit=1`;
      const search = await fetchJson<SearchResponse>(searchUrl, { trusted: true, signal: ctx.signal });
      const first = search.pages[0];
      if (!first) throw new Error(`No Wikipedia article found for "${term}"`);
      summary = await fetchJson<SummaryResponse>(
        `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(first.key)}`,
        { trusted: true, signal: ctx.signal },
      );
    }

    return {
      title: summary.title,
      language: lang,
      description: summary.description,
      extract: summary.extract,
      url: summary.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(summary.title)}`,
      thumbnail: summary.thumbnail?.source,
      lastModified: summary.timestamp,
    };
  },
});
