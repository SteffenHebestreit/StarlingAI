/**
 * Generic RSS/Atom feed reader — free, accepts any user-supplied URL.
 *
 * Unlike the other providers, this one does NOT lock the URL to a known host;
 * the SSRF guard inside `fetchText` rejects loopback/private targets.
 */
import { registerDataFeedProvider } from "../provider-registry.js";
import { fetchText } from "../shared.js";
import type { NewsItem, NewsQuery } from "./_news-types.js";

interface RssQuery extends NewsQuery {
  /** Required: RSS or Atom feed URL. */
  feedUrl: string;
}

registerDataFeedProvider<RssQuery, NewsItem[]>({
  id: "rss",
  category: "news",
  description: "Generic RSS/Atom feed reader. Caller supplies the feed URL.",
  homepage: "https://en.wikipedia.org/wiki/RSS",
  requiresApiKey: false,

  async fetch(query, ctx) {
    if (!query.feedUrl) throw new Error("rss provider requires feedUrl");
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 50);
    ctx.log.debug({ feedUrl: query.feedUrl, limit }, "rss fetch");
    const xml = await fetchText(query.feedUrl, { signal: ctx.signal });
    return parseFeed(xml).slice(0, limit);
  },
});

function parseFeed(xml: string): NewsItem[] {
  // Minimal regex-based parser — sufficient for well-formed RSS/Atom.
  // For pathological inputs the items list will simply be shorter; we never
  // execute or render the feed content directly.
  const sourceMatch = xml.match(/<channel>[\s\S]*?<title>([\s\S]*?)<\/title>/i)
    ?? xml.match(/<feed[^>]*>[\s\S]*?<title>([\s\S]*?)<\/title>/i);
  const source = sourceMatch ? stripCdata(sourceMatch[1] ?? "").trim() : "RSS";

  const itemRegex = /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  const items: NewsItem[] = [];
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml))) {
    const block = m[1] ?? "";
    const title = stripCdata(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
    const linkRaw = block.match(/<link[^>]*href="([^"]+)"/i)?.[1]
      ?? stripCdata(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? "").trim();
    const author = stripCdata(
      block.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/i)?.[1]
      ?? block.match(/<author>([\s\S]*?)<\/author>/i)?.[1]
      ?? block.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/i)?.[1]
      ?? "",
    ).trim();
    const pub = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]
      ?? block.match(/<published>([\s\S]*?)<\/published>/i)?.[1]
      ?? block.match(/<updated>([\s\S]*?)<\/updated>/i)?.[1];
    const description = stripCdata(
      block.match(/<description>([\s\S]*?)<\/description>/i)?.[1]
      ?? block.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1]
      ?? "",
    ).replace(/<[^>]+>/g, "").trim();

    if (!title) continue;
    items.push({
      title,
      url: linkRaw || "",
      source,
      publishedAt: pub ? new Date(pub).toISOString() : undefined,
      author: author || undefined,
      summary: description ? description.slice(0, 400) : undefined,
    });
  }
  return items;
}

function stripCdata(value: string): string {
  return value.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
}
