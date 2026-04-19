/**
 * Reddit JSON endpoints — free, no key required (no auth needed for public subs).
 * Treat the `topic` parameter as the subreddit name.
 */
import { registerDataFeedProvider } from "../provider-registry.js";
import { fetchJson } from "../shared.js";
import type { NewsItem, NewsQuery } from "./_news-types.js";

interface RedditListing {
  data: {
    children: Array<{
      data: {
        title: string;
        permalink: string;
        url?: string;
        subreddit?: string;
        author?: string;
        created_utc?: number;
        score?: number;
        num_comments?: number;
        selftext?: string;
        is_self?: boolean;
      };
    }>;
  };
}

registerDataFeedProvider<NewsQuery, NewsItem[]>({
  id: "reddit",
  category: "news",
  description: "Reddit subreddit listings (free public JSON endpoint, treats topic as subreddit name).",
  homepage: "https://www.reddit.com/dev/api/",
  requiresApiKey: false,

  async fetch(query, ctx) {
    const subreddit = (query.topic ?? "worldnews").replace(/^r\//i, "").replace(/[^A-Za-z0-9_]/g, "");
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 50);
    const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}`;
    ctx.log.debug({ subreddit, limit }, "reddit fetch");
    const data = await fetchJson<RedditListing>(url, { trusted: true, signal: ctx.signal });

    return data.data.children.map((child) => {
      const d = child.data;
      const link = d.is_self
        ? `https://www.reddit.com${d.permalink}`
        : (d.url ?? `https://www.reddit.com${d.permalink}`);
      return {
        title: d.title,
        url: link,
        source: `r/${d.subreddit ?? subreddit}`,
        publishedAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : undefined,
        author: d.author,
        summary: d.selftext ? d.selftext.slice(0, 400) : undefined,
        score: d.score,
        commentCount: d.num_comments,
      };
    });
  },
});
