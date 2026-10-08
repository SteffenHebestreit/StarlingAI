import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as loaderModule from "../config/loader.js";
import type { ToolContext } from "../tools/registry.js";

// A name on the operator's LAN for the allowlist cases: it resolves to a private address. Every
// other lookup is the real one.
const { LAN_HOST, LAN_ADDRESS } = vi.hoisted(() => ({ LAN_HOST: "wiki.lan.example", LAN_ADDRESS: "172.22.0.14" }));
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  const lookup = (hostname: string, options?: unknown) => hostname === LAN_HOST
    ? Promise.resolve([{ address: LAN_ADDRESS, family: 4 }])
    : actual.lookup(hostname, options as never);
  return { ...actual, lookup };
});

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

/**
 * The feed URL is the caller's. Only that URL was checked (its host, IPv4 records only, the
 * operator's allowlist ignored) and fetch then followed redirects on its own, so a public feed URL
 * that redirected into the private network was fetched and its items returned. The URL and every
 * redirect target now go through web_fetch's guard, as url_inspect's do.
 */
describe("read_rss_feed goes through web_fetch's SSRF guard", () => {
  // An IP literal: the SSRF guard needs no DNS for it.
  const PUBLIC = "http://93.184.215.14";
  const feed = (title: string) => `<?xml version="1.0"?><rss><channel><title>${title}</title>`
    + `<item><title>${title}: first item</title><link>https://example.com/1</link></item></channel></rss>`;

  beforeAll(async () => {
    await import("../tools/data-feeds/index.js");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function readFeed(feedUrl: string) {
    const { getTool } = await import("../tools/registry.js");
    return getTool("read_rss_feed")!.execute({ feedUrl }, ctx);
  }

  /**
   * fetch on a small web of `pages` (URL -> status, headers, body). Like fetch, it follows
   * redirects itself unless the caller asks for redirect "manual"; `requested` lists every URL it
   * was asked for or followed to.
   */
  function web(pages: Record<string, { status: number; headers?: Record<string, string>; body?: string }>) {
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      let url = String(input);
      for (let hop = 0; hop <= 20; hop++) {
        requested.push(url);
        const page = pages[url] ?? { status: 404 };
        const res = new Response(page.body ?? null, { status: page.status, headers: page.headers });
        const location = res.headers.get("location");
        if (init?.redirect === "manual" || !location || ![301, 302, 303, 307, 308].includes(res.status)) {
          Object.defineProperty(res, "url", { value: url });
          return res;
        }
        url = new URL(location, url).toString();
      }
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, requested };
  }

  function allowPrivateHosts(hosts: string[]) {
    const realConfig = loaderModule.getConfig();
    vi.spyOn(loaderModule, "getConfig").mockReturnValue({
      ...realConfig,
      guardrails: { ...realConfig.guardrails, allowedPrivateHosts: hosts },
    } as typeof realConfig);
  }

  it("refuses a private address before any request is sent", async () => {
    const { fetchMock } = web({ "http://10.0.0.5/feed": { status: 200, body: feed("Intern") } });

    const r = await readFeed("http://10.0.0.5/feed");
    expect(r.success).toBe(false);
    expect(r.error).toBe("read_rss_feed failed: Refusing to fetch http://10.0.0.5/feed: requesting private/internal network addresses is not allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to follow a public feed URL's redirect into loopback, and never requests the target", async () => {
    const internal = "http://127.0.0.1:9000/exec?query=select%20*%20from%20user_credentials";
    const { requested } = web({
      [`${PUBLIC}/feed`]: { status: 302, headers: { location: internal } },
      [internal]: { status: 200, body: feed("QuestDB") },
    });

    const r = await readFeed(`${PUBLIC}/feed`);
    expect(r.success).toBe(false);
    expect(r.error).toBe(`read_rss_feed failed: Refusing to follow the redirect from ${PUBLIC}/feed: requesting private/internal network addresses is not allowed`);
    expect(requested).toEqual([`${PUBLIC}/feed`]);
  });

  it("follows a public redirect chain hop by hop and reads the feed at its end", async () => {
    const { requested } = web({
      [`${PUBLIC}/feed`]: { status: 301, headers: { location: "/rss.xml" } },
      [`${PUBLIC}/rss.xml`]: { status: 200, headers: { "content-type": "application/rss+xml" }, body: feed("Werkstatt-Blog") },
    });

    const r = await readFeed(`${PUBLIC}/feed`);
    expect(r.success).toBe(true);
    expect(r.output).toContain("Werkstatt-Blog: first item");
    expect(requested).toEqual([`${PUBLIC}/feed`, `${PUBLIC}/rss.xml`]);
  });

  it("gives up after as many redirects as url_inspect follows", async () => {
    const { requested } = web({
      [`${PUBLIC}/a`]: { status: 302, headers: { location: "/b" } },
      [`${PUBLIC}/b`]: { status: 302, headers: { location: "/a" } },
    });

    const r = await readFeed(`${PUBLIC}/a`);
    expect(r.success).toBe(false);
    expect(r.error).toBe("read_rss_feed failed: more than 5 redirects");
    expect(requested).toHaveLength(6);
  });

  it("refuses a LAN name that resolves to a private address when it is not listed", async () => {
    const { fetchMock } = web({ [`http://${LAN_HOST}/feed`]: { status: 200, body: feed("Wiki") } });

    const r = await readFeed(`http://${LAN_HOST}/feed`);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/private\/internal network addresses is not allowed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still reads that name's feed, redirects included, when guardrails.allowedPrivateHosts lists it", async () => {
    allowPrivateHosts([LAN_HOST]);
    const { requested } = web({
      [`http://${LAN_HOST}/feed`]: { status: 302, headers: { location: "/feed.xml" } },
      [`http://${LAN_HOST}/feed.xml`]: { status: 200, body: feed("Wiki-Änderungen") },
    });

    const r = await readFeed(`http://${LAN_HOST}/feed`);
    expect(r.success).toBe(true);
    expect(r.output).toContain("Wiki-Änderungen: first item");
    expect(requested).toEqual([`http://${LAN_HOST}/feed`, `http://${LAN_HOST}/feed.xml`]);
  });
});
