import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../tools/registry.js";

const ctx: ToolContext = {
  sessionId: "session-data-feeds",
  workspacePath: "/workspace",
};

function mockResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    statusText: "OK",
    headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
    ...init,
  });
}

describe("data-feeds tools", () => {
  beforeAll(async () => {
    await import("../tools/data-feeds/index.js");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers all 7 LLM-facing tools", async () => {
    const { getTool } = await import("../tools/registry.js");
    for (const name of [
      "get_weather", "get_news_headlines", "read_rss_feed",
      "get_fx_rate", "get_crypto_price", "wikipedia_lookup", "list_data_feeds",
    ]) {
      expect(getTool(name), `tool ${name} should be registered`).toBeDefined();
    }
  });

  it("get_weather: parses Open-Meteo response into Markdown summary", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("api.open-meteo.com");
      expect(url).toContain("latitude=52.52");
      return mockResponse(JSON.stringify({
        latitude: 52.52, longitude: 13.41, timezone: "Europe/Berlin",
        current: {
          time: "2026-04-18T10:00",
          temperature_2m: 12.4, apparent_temperature: 10.8,
          relative_humidity_2m: 65, wind_speed_10m: 8.2,
          wind_direction_10m: 180, weather_code: 3, is_day: 1,
        },
        current_units: { temperature_2m: "°C", wind_speed_10m: "km/h" },
        daily: {
          time: ["2026-04-18"],
          temperature_2m_min: [6], temperature_2m_max: [14],
          precipitation_sum: [0.2], weather_code: [61],
        },
        daily_units: { precipitation_sum: "mm" },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getTool } = await import("../tools/registry.js");
    const result = await getTool("get_weather")!.execute({ lat: 52.52, lon: 13.41 }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain("Weather at 52.5200, 13.4100");
    expect(result.output).toContain("Overcast");
    expect(result.output).toContain("Slight rain");
  });

  it("get_weather: rejects out-of-range coordinates", async () => {
    const { getTool } = await import("../tools/registry.js");
    const result = await getTool("get_weather")!.execute({ lat: 999, lon: 0 }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/lat must be/);
  });

  it("get_fx_rate: validates ISO codes and converts via Frankfurter", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("api.frankfurter.app");
      expect(url).toContain("from=EUR");
      expect(url).toContain("to=USD");
      return mockResponse(JSON.stringify({
        amount: 100, base: "EUR", date: "2026-04-18", rates: { USD: 108.42 },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getTool } = await import("../tools/registry.js");
    const result = await getTool("get_fx_rate")!.execute({ from: "EUR", to: "USD", amount: 100 }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain("100 EUR = 108.42 USD");
  });

  it("get_fx_rate: rejects invalid currency codes", async () => {
    const { getTool } = await import("../tools/registry.js");
    const result = await getTool("get_fx_rate")!.execute({ from: "EURO", to: "USD" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ISO 4217/);
  });

  it("get_crypto_price: maps ticker BTC → bitcoin and parses CoinGecko response", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("api.coingecko.com");
      expect(url).toContain("ids=bitcoin");
      expect(url).toContain("vs_currencies=usd");
      return mockResponse(JSON.stringify({
        bitcoin: { usd: 70200, usd_24h_change: 1.5, usd_market_cap: 1.4e12, usd_24h_vol: 3.2e10, last_updated_at: 1713440000 },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getTool } = await import("../tools/registry.js");
    const result = await getTool("get_crypto_price")!.execute({ asset: "BTC" }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain("BITCOIN → USD");
    expect(result.output).toContain("70200");
    expect(result.output).toContain("1.50%");
  });

  it("wikipedia_lookup: returns formatted summary on direct hit", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("en.wikipedia.org/api/rest_v1/page/summary/");
      return mockResponse(JSON.stringify({
        title: "Apollo 11",
        description: "First crewed Moon landing mission",
        extract: "Apollo 11 was the American spaceflight that first landed humans on the Moon.",
        content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Apollo_11" } },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getTool } = await import("../tools/registry.js");
    const result = await getTool("wikipedia_lookup")!.execute({ term: "Apollo 11" }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain("**Apollo 11**");
    expect(result.output).toContain("First crewed Moon landing mission");
  });

  it("read_rss_feed: parses an RSS feed and returns formatted items", async () => {
    const xml = `<?xml version="1.0"?><rss><channel><title>Example Blog</title>
      <item><title>First post</title><link>https://example.com/1</link>
        <pubDate>Fri, 18 Apr 2026 10:00:00 GMT</pubDate>
        <description><![CDATA[<p>Hello world</p>]]></description></item>
      <item><title>Second post</title><link>https://example.com/2</link>
        <description>Another</description></item>
    </channel></rss>`;
    const fetchMock = vi.fn(async () => new Response(xml, {
      status: 200, headers: { "Content-Type": "application/rss+xml" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { getTool } = await import("../tools/registry.js");
    const result = await getTool("read_rss_feed")!.execute({ feedUrl: "https://example.com/feed.xml" }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain("First post");
    expect(result.output).toContain("Second post");
    expect(result.output).toContain("Example Blog");
  });

  it("read_rss_feed: refuses to fetch private hosts (SSRF guard)", async () => {
    const { getTool } = await import("../tools/registry.js");
    const result = await getTool("read_rss_feed")!.execute({ feedUrl: "http://127.0.0.1/feed" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/private|internal/i);
  });

  it("list_data_feeds: enumerates registered providers grouped by category", async () => {
    const { getTool } = await import("../tools/registry.js");
    const result = await getTool("list_data_feeds")!.execute({}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain("### weather");
    expect(result.output).toContain("open-meteo");
    expect(result.output).toContain("### news");
    expect(result.output).toContain("hackernews");
    expect(result.output).toContain("### finance.fx");
    expect(result.output).toContain("frankfurter");
    expect(result.output).toContain("### finance.crypto");
    expect(result.output).toContain("coingecko");
    expect(result.output).toContain("### reference");
    expect(result.output).toContain("wikipedia");
    // free providers should be marked enabled by default
    expect(result.output).toContain("✅ enabled");
  });

  it("get_news_headlines: rejects unknown provider id", async () => {
    const { getTool } = await import("../tools/registry.js");
    const result = await getTool("get_news_headlines")!.execute({ provider: "nope" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown data-feed provider/);
  });
});
