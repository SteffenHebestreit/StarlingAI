/**
 * LLM-facing tools backed by the data-feeds provider registry.
 *
 * Each tool selects providers from a single category and either uses an
 * explicitly-requested provider id or the first enabled one.  Output is
 * always Markdown so the LLM can quote it directly.
 */
import { registerTool, type ToolContext, type ToolResult } from "../registry.js";
import {
  buildProviderContext,
  getDataFeedProvider,
  getEnabledProviders,
  listDataFeedProviders,
} from "./provider-registry.js";
import type { DataFeedCategory, DataFeedProvider } from "./types.js";
import type { WeatherQuery, WeatherResult } from "./providers/weather-open-meteo.js";
import type { CryptoQuery, CryptoResult } from "./providers/finance-coingecko.js";
import type { FxQuery, FxResult } from "./providers/finance-frankfurter.js";
import type { WikipediaQuery, WikipediaResult } from "./providers/reference-wikipedia.js";
import type { NewsItem, NewsQuery } from "./providers/_news-types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}

function pickProvider<TQuery, TResult>(
  category: DataFeedCategory,
  requestedId?: string,
): DataFeedProvider<TQuery, TResult> | { error: string } {
  if (requestedId) {
    const provider = getDataFeedProvider(requestedId);
    if (!provider) return { error: `Unknown data-feed provider '${requestedId}'.` };
    if (provider.category !== category) {
      return { error: `Provider '${requestedId}' is in category '${provider.category}', not '${category}'.` };
    }
    return provider as unknown as DataFeedProvider<TQuery, TResult>;
  }
  const enabled = getEnabledProviders(category);
  if (enabled.length === 0) {
    const knownIds = listDataFeedProviders(category).map((p) => p.id).join(", ");
    return { error: `No enabled providers for category '${category}'.${knownIds ? ` Known: ${knownIds}.` : ""}` };
  }
  return enabled[0] as unknown as DataFeedProvider<TQuery, TResult>;
}

// ─── get_weather ────────────────────────────────────────────────────────────

registerTool({
  name: "get_weather",
  description:
    "Fetch the current weather and short-term forecast for a latitude/longitude pair. " +
    "Defaults to the free Open-Meteo provider (no API key needed). " +
    "Takes coordinates only — if you have a place name, resolve it to lat/lon first (e.g. via `web_search`).",
  parameters: {
    type: "object",
    properties: {
      lat: { type: "number", description: "Latitude in decimal degrees." },
      lon: { type: "number", description: "Longitude in decimal degrees." },
      days: { type: "number", description: "Forecast horizon in days (1–16, default 1).", default: 1 },
      units: { type: "string", enum: ["metric", "imperial"], description: "Unit system (default metric).", default: "metric" },
      provider: { type: "string", description: "Optional provider id (e.g. 'open-meteo'). Omit for default." },
    },
    required: ["lat", "lon"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const lat = Number(args["lat"]);
    const lon = Number(args["lon"]);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return fail("lat must be between -90 and 90");
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) return fail("lon must be between -180 and 180");

    const sel = pickProvider<WeatherQuery, WeatherResult>("weather", typeof args["provider"] === "string" ? String(args["provider"]) : undefined);
    if ("error" in sel) return fail(sel.error);

    try {
      const result = await sel.fetch(
        {
          lat, lon,
          days: args["days"] != null ? Number(args["days"]) : undefined,
          units: args["units"] === "imperial" ? "imperial" : "metric",
        },
        buildProviderContext(sel, abortSignalFromCtx(ctx)),
      );

      const cur = result.current;
      const lines: string[] = [
        `**Weather at ${lat.toFixed(4)}, ${lon.toFixed(4)}** (${result.location.timezone})`,
        ``,
        `**Now (${cur.observedAt}):**`,
        `- Temperature: ${cur.temperature}${result.units.temperature} (feels like ${cur.apparentTemperature}${result.units.temperature})`,
        `- Conditions: ${cur.description} (${cur.isDay ? "day" : "night"})`,
        `- Humidity: ${cur.humidity}%`,
        `- Wind: ${cur.windSpeed} ${result.units.wind} from ${cur.windDirection}°`,
      ];
      if (result.daily.length > 0) {
        lines.push(``, `**Daily forecast:**`);
        for (const day of result.daily) {
          lines.push(`- ${day.date}: ${day.tempMin}–${day.tempMax}${result.units.temperature}, ${day.description}, precipitation ${day.precipitation}${result.units.precipitation}`);
        }
      }

      return {
        success: true,
        output: lines.join("\n"),
        metadata: { provider: sel.id, ...result },
      };
    } catch (err) {
      return fail(`get_weather failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

// ─── get_news_headlines ─────────────────────────────────────────────────────

registerTool({
  name: "get_news_headlines",
  description:
    "Fetch recent news headlines from a free public source. " +
    "Default provider is Hacker News; pass provider='reddit' (with topic=subreddit name), " +
    "or provider='rss' with feedUrl=<rss/atom URL> for arbitrary feeds. " +
    "List all configured providers with `list_data_feeds`.",
  parameters: {
    type: "object",
    properties: {
      topic: { type: "string", description: "Topic / subreddit / feed hint (provider-specific)." },
      limit: { type: "number", description: "Maximum items (1–50, default 10).", default: 10 },
      provider: { type: "string", description: "Provider id (e.g. 'hackernews', 'reddit', 'rss'). Default: first enabled." },
      feedUrl: { type: "string", description: "Required when provider='rss'. Public RSS or Atom feed URL." },
      language: { type: "string", description: "Optional BCP-47 language hint, honoured by some providers." },
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const sel = pickProvider<NewsQuery & { feedUrl?: string }, NewsItem[]>(
      "news",
      typeof args["provider"] === "string" ? String(args["provider"]) : undefined,
    );
    if ("error" in sel) return fail(sel.error);

    try {
      const items = await sel.fetch(
        {
          topic: args["topic"] != null ? String(args["topic"]) : undefined,
          limit: args["limit"] != null ? Number(args["limit"]) : undefined,
          language: args["language"] != null ? String(args["language"]) : undefined,
          feedUrl: args["feedUrl"] != null ? String(args["feedUrl"]) : undefined,
        },
        buildProviderContext(sel, abortSignalFromCtx(ctx)),
      );

      if (items.length === 0) {
        return { success: true, output: `(no headlines from ${sel.id})`, metadata: { provider: sel.id, count: 0 } };
      }

      const lines = items.map((item, i) => {
        const meta: string[] = [];
        if (item.source) meta.push(item.source);
        if (item.publishedAt) meta.push(item.publishedAt.slice(0, 10));
        if (typeof item.score === "number") meta.push(`${item.score} pts`);
        if (typeof item.commentCount === "number") meta.push(`${item.commentCount} comments`);
        const metaStr = meta.length ? ` _(${meta.join(" • ")})_` : "";
        const summary = item.summary ? `\n   > ${item.summary.slice(0, 240)}` : "";
        return `${i + 1}. [${item.title}](${item.url})${metaStr}${summary}`;
      });

      return {
        success: true,
        output: `**${items.length} headline(s) from ${sel.id}**\n\n${lines.join("\n")}`,
        metadata: { provider: sel.id, count: items.length, items },
      };
    } catch (err) {
      return fail(`get_news_headlines failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

// ─── read_rss_feed ──────────────────────────────────────────────────────────

registerTool({
  name: "read_rss_feed",
  description:
    "Read the latest items from a public RSS or Atom feed URL. " +
    "Convenience wrapper for `get_news_headlines` with provider='rss'. " +
    "Refuses to fetch private/internal hosts.",
  parameters: {
    type: "object",
    properties: {
      feedUrl: { type: "string", description: "Public RSS or Atom feed URL (http/https only)." },
      limit: { type: "number", description: "Maximum items (1–50, default 10).", default: 10 },
    },
    required: ["feedUrl"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const provider = getDataFeedProvider("rss");
    if (!provider) return fail("rss provider not registered");
    try {
      const items = await provider.fetch(
        {
          feedUrl: String(args["feedUrl"] ?? ""),
          limit: args["limit"] != null ? Number(args["limit"]) : undefined,
        },
        buildProviderContext(provider, abortSignalFromCtx(ctx)),
      ) as NewsItem[];

      if (items.length === 0) return { success: true, output: "(feed returned no items)", metadata: { count: 0 } };

      const lines = items.map((item, i) => {
        const date = item.publishedAt ? ` _(${item.publishedAt.slice(0, 10)})_` : "";
        const summary = item.summary ? `\n   > ${item.summary.slice(0, 240)}` : "";
        return `${i + 1}. [${item.title}](${item.url})${date}${summary}`;
      });

      return {
        success: true,
        output: `**${items.length} item(s) from ${items[0]?.source ?? "feed"}**\n\n${lines.join("\n")}`,
        metadata: { count: items.length, items },
      };
    } catch (err) {
      return fail(`read_rss_feed failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

// ─── get_fx_rate ────────────────────────────────────────────────────────────

registerTool({
  name: "get_fx_rate",
  description:
    "Convert one fiat currency to another using free European Central Bank reference rates. " +
    "Defaults to the Frankfurter provider (no API key). Pass historical date for past rates.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Base currency ISO 4217 code (e.g. 'EUR')." },
      to: { type: "string", description: "Target currency ISO 4217 code (e.g. 'USD')." },
      amount: { type: "number", description: "Amount to convert (default 1).", default: 1 },
      date: { type: "string", description: "Historical date YYYY-MM-DD (omit for latest)." },
      provider: { type: "string", description: "Provider id (default 'frankfurter')." },
    },
    required: ["from", "to"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const sel = pickProvider<FxQuery, FxResult>("finance.fx", typeof args["provider"] === "string" ? String(args["provider"]) : undefined);
    if ("error" in sel) return fail(sel.error);

    try {
      const result = await sel.fetch(
        {
          from: String(args["from"] ?? ""),
          to: String(args["to"] ?? ""),
          amount: args["amount"] != null ? Number(args["amount"]) : undefined,
          date: args["date"] != null ? String(args["date"]) : undefined,
        },
        buildProviderContext(sel, abortSignalFromCtx(ctx)),
      );
      const output = `**${result.amount} ${result.base} = ${result.converted} ${result.target}**\n` +
        `- Rate: 1 ${result.base} = ${result.rate.toFixed(6)} ${result.target}\n` +
        `- Date: ${result.date}\n` +
        `- Source: ${sel.id}`;
      return { success: true, output, metadata: { provider: sel.id, ...result } };
    } catch (err) {
      return fail(`get_fx_rate failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

// ─── get_crypto_price ───────────────────────────────────────────────────────

registerTool({
  name: "get_crypto_price",
  description:
    "Fetch a real-time crypto-asset price in any fiat or crypto quote. " +
    "Default provider is CoinGecko (free, no API key). Accepts ticker symbols (BTC, ETH) or coin ids (bitcoin, ethereum).",
  parameters: {
    type: "object",
    properties: {
      asset: { type: "string", description: "Coin id ('bitcoin') or ticker symbol ('BTC')." },
      vs: { type: "string", description: "Quote currency (default 'usd').", default: "usd" },
      provider: { type: "string", description: "Provider id (default 'coingecko')." },
    },
    required: ["asset"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const sel = pickProvider<CryptoQuery, CryptoResult>("finance.crypto", typeof args["provider"] === "string" ? String(args["provider"]) : undefined);
    if ("error" in sel) return fail(sel.error);

    try {
      const result = await sel.fetch(
        {
          asset: String(args["asset"] ?? ""),
          vs: args["vs"] != null ? String(args["vs"]) : undefined,
        },
        buildProviderContext(sel, abortSignalFromCtx(ctx)),
      );

      const lines = [
        `**${result.resolvedId.toUpperCase()} → ${result.vs.toUpperCase()}**`,
        `- Price: ${result.price} ${result.vs.toUpperCase()}`,
      ];
      if (typeof result.changePercent24h === "number") lines.push(`- 24h change: ${result.changePercent24h.toFixed(2)}%`);
      if (typeof result.marketCap === "number") lines.push(`- Market cap: ${result.marketCap}`);
      if (typeof result.volume24h === "number") lines.push(`- 24h volume: ${result.volume24h}`);
      lines.push(`- Observed: ${result.observedAt}`);
      lines.push(`- Source: ${sel.id}`);

      return { success: true, output: lines.join("\n"), metadata: { provider: sel.id, ...result } };
    } catch (err) {
      return fail(`get_crypto_price failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

// ─── wikipedia_lookup ───────────────────────────────────────────────────────

registerTool({
  name: "wikipedia_lookup",
  description:
    "Look up a Wikipedia article summary by title or free-text term. " +
    "Falls back to title search when the term doesn't match a page directly. Multi-language.",
  parameters: {
    type: "object",
    properties: {
      term: { type: "string", description: "Article title or free-text search term." },
      language: { type: "string", description: "Wikipedia language edition (default 'en').", default: "en" },
      provider: { type: "string", description: "Provider id (default 'wikipedia')." },
    },
    required: ["term"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const sel = pickProvider<WikipediaQuery, WikipediaResult>("reference", typeof args["provider"] === "string" ? String(args["provider"]) : undefined);
    if ("error" in sel) return fail(sel.error);

    try {
      const result = await sel.fetch(
        {
          term: String(args["term"] ?? ""),
          language: args["language"] != null ? String(args["language"]) : undefined,
        },
        buildProviderContext(sel, abortSignalFromCtx(ctx)),
      );

      const desc = result.description ? `_${result.description}_\n\n` : "";
      const output =
        `**${result.title}** ([Wikipedia](${result.url}))\n\n${desc}${result.extract}`;
      return { success: true, output, metadata: { provider: sel.id, ...result } };
    } catch (err) {
      return fail(`wikipedia_lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

// ─── list_data_feeds ────────────────────────────────────────────────────────

registerTool({
  name: "list_data_feeds",
  description:
    "List all registered data-feed providers (weather, news, finance, reference, etc.) " +
    "with their categories, descriptions, and whether they are currently enabled. " +
    "Use this to discover what real-time data sources are available.",
  parameters: { type: "object", properties: {} },
  async execute(): Promise<ToolResult> {
    const all = listDataFeedProviders();
    if (all.length === 0) return { success: true, output: "(no data-feed providers registered)" };

    const enabled = new Set(getAllEnabledIds());
    const grouped = new Map<DataFeedCategory, DataFeedProvider[]>();
    for (const p of all) {
      const arr = grouped.get(p.category) ?? [];
      arr.push(p);
      grouped.set(p.category, arr);
    }

    const lines: string[] = [];
    for (const [category, providers] of [...grouped.entries()].sort()) {
      lines.push(`### ${category}`);
      for (const p of providers) {
        const status = enabled.has(p.id) ? "✅ enabled" : (p.requiresApiKey ? "🔑 needs API key" : "⏸ disabled");
        lines.push(`- **${p.id}** — ${p.description} _(${status})_`);
      }
      lines.push("");
    }

    return {
      success: true,
      output: lines.join("\n").trim(),
      metadata: { providers: all.map((p) => ({ id: p.id, category: p.category, requiresApiKey: p.requiresApiKey, enabled: enabled.has(p.id) })) },
    };
  },
});

// ─── helpers ────────────────────────────────────────────────────────────────

function getAllEnabledIds(): string[] {
  const cats: DataFeedCategory[] = ["weather", "news", "finance.fx", "finance.crypto", "finance.stocks", "reference", "network"];
  return cats.flatMap((c) => getEnabledProviders(c).map((p) => p.id));
}

function abortSignalFromCtx(ctx: ToolContext): AbortSignal | undefined {
  return (ctx as unknown as { signal?: AbortSignal }).signal;
}
