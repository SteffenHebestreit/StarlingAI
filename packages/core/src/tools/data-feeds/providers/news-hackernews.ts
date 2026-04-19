/**
 * Hacker News — free Firebase API, no key required.
 * https://github.com/HackerNews/API
 */
import { registerDataFeedProvider } from "../provider-registry.js";
import { fetchJson, TtlCache } from "../shared.js";
import type { NewsItem, NewsQuery } from "./_news-types.js";

interface HnItem {
  id: number;
  title?: string;
  url?: string;
  score?: number;
  by?: string;
  time?: number;
  descendants?: number;
  type?: string;
}

const itemCache = new TtlCache<HnItem>(60_000);

registerDataFeedProvider<NewsQuery, NewsItem[]>({
  id: "hackernews",
  category: "news",
  description: "Hacker News top/new/best stories (free public API).",
  homepage: "https://news.ycombinator.com/",
  requiresApiKey: false,

  async fetch(query, ctx) {
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 50);
    const feed = pickFeed(query.topic);
    const idsUrl = `https://hacker-news.firebaseio.com/v0/${feed}.json`;
    ctx.log.debug({ feed }, "hackernews fetch");
    const ids = await fetchJson<number[]>(idsUrl, { trusted: true, signal: ctx.signal });

    const slice = ids.slice(0, limit);
    const items = await Promise.all(slice.map(async (id) => {
      const cached = itemCache.get(String(id));
      if (cached) return cached;
      const item = await fetchJson<HnItem>(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
        trusted: true, signal: ctx.signal,
      });
      itemCache.set(String(id), item);
      return item;
    }));

    return items
      .filter((item) => item && item.title)
      .map((item) => ({
        title: item.title!,
        url: item.url ?? `https://news.ycombinator.com/item?id=${item.id}`,
        source: "Hacker News",
        publishedAt: item.time ? new Date(item.time * 1000).toISOString() : undefined,
        author: item.by,
        score: item.score,
        commentCount: item.descendants,
      }));
  },
});

function pickFeed(topic?: string): "topstories" | "newstories" | "beststories" | "askstories" | "showstories" | "jobstories" {
  const t = (topic ?? "").toLowerCase();
  if (t.includes("ask")) return "askstories";
  if (t.includes("show")) return "showstories";
  if (t.includes("job")) return "jobstories";
  if (t.includes("new")) return "newstories";
  if (t.includes("best")) return "beststories";
  return "topstories";
}
