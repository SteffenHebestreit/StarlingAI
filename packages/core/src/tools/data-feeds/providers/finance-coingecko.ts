/**
 * CoinGecko — free crypto-asset prices, no key required for basic /simple/price.
 * https://www.coingecko.com/en/api/documentation
 */
import { registerDataFeedProvider } from "../provider-registry.js";
import { fetchJson, rateLimit } from "../shared.js";

export interface CryptoQuery {
  /** CoinGecko coin id (e.g. "bitcoin", "ethereum") OR ticker symbol (BTC/ETH/SOL...). */
  asset: string;
  /** Quote currency (default "usd"). */
  vs?: string;
}

export interface CryptoResult {
  asset: string;
  resolvedId: string;
  vs: string;
  price: number;
  changePercent24h?: number;
  marketCap?: number;
  volume24h?: number;
  observedAt: string;
}

interface SimplePriceQuote {
  last_updated_at?: number;
  [metric: string]: number | undefined;
}

interface SimplePriceResponse {
  [coinId: string]: SimplePriceQuote;
}

const SYMBOL_TO_ID: Record<string, string> = {
  btc: "bitcoin", eth: "ethereum", sol: "solana", ada: "cardano", xrp: "ripple",
  doge: "dogecoin", dot: "polkadot", matic: "matic-network", ltc: "litecoin",
  bch: "bitcoin-cash", link: "chainlink", avax: "avalanche-2", uni: "uniswap",
  atom: "cosmos", xlm: "stellar", trx: "tron", etc: "ethereum-classic",
  bnb: "binancecoin", usdc: "usd-coin", usdt: "tether",
};

registerDataFeedProvider<CryptoQuery, CryptoResult>({
  id: "coingecko",
  category: "finance.crypto",
  description: "CoinGecko spot crypto prices in any fiat or crypto quote (free public API).",
  homepage: "https://www.coingecko.com/en/api",
  requiresApiKey: false,

  async fetch(query, ctx) {
    const raw = query.asset.trim().toLowerCase();
    if (!raw) throw new Error("asset is required");
    const id = SYMBOL_TO_ID[raw] ?? raw;
    const vs = (query.vs ?? "usd").trim().toLowerCase();

    // CoinGecko free tier is rate-limited (~10-30 req/min). Stay polite.
    await rateLimit("coingecko", 1500);

    const params = new URLSearchParams({
      ids: id, vs_currencies: vs,
      include_24hr_change: "true",
      include_market_cap: "true",
      include_24hr_vol: "true",
      include_last_updated_at: "true",
    });
    const url = `https://api.coingecko.com/api/v3/simple/price?${params.toString()}`;
    ctx.log.debug({ url }, "coingecko fetch");
    const data = await fetchJson<SimplePriceResponse>(url, { trusted: true, signal: ctx.signal });

    const entry = data[id];
    if (!entry || typeof entry[vs] !== "number") {
      throw new Error(`CoinGecko returned no price for asset='${id}' vs='${vs}'`);
    }

    return {
      asset: query.asset,
      resolvedId: id,
      vs,
      price: entry[vs] as number,
      changePercent24h: entry[`${vs}_24h_change`] as number | undefined,
      marketCap: entry[`${vs}_market_cap`] as number | undefined,
      volume24h: entry[`${vs}_24h_vol`] as number | undefined,
      observedAt: entry.last_updated_at
        ? new Date((entry.last_updated_at as number) * 1000).toISOString()
        : new Date().toISOString(),
    };
  },
});
