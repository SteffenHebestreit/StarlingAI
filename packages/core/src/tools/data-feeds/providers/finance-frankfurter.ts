/**
 * Frankfurter — free FX rates from the European Central Bank reference rates.
 * https://www.frankfurter.app/
 */
import { registerDataFeedProvider } from "../provider-registry.js";
import { fetchJson } from "../shared.js";

export interface FxQuery {
  /** ISO 4217 base currency, e.g. "EUR", "USD". */
  from: string;
  /** ISO 4217 target currency, e.g. "USD", "GBP". */
  to: string;
  /** Amount to convert (default 1). */
  amount?: number;
  /** Historical date YYYY-MM-DD (omit for latest). */
  date?: string;
}

export interface FxResult {
  base: string;
  target: string;
  amount: number;
  rate: number;
  converted: number;
  date: string;
}

interface FrankfurterResponse {
  amount: number;
  base: string;
  date: string;
  rates: Record<string, number>;
}

registerDataFeedProvider<FxQuery, FxResult>({
  id: "frankfurter",
  category: "finance.fx",
  description: "Frankfurter — free ECB reference exchange rates (no API key).",
  homepage: "https://www.frankfurter.app/",
  requiresApiKey: false,

  async fetch(query, ctx) {
    const from = query.from.trim().toUpperCase();
    const to = query.to.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
      throw new Error("Currencies must be ISO 4217 three-letter codes");
    }
    const amount = query.amount && query.amount > 0 ? query.amount : 1;
    const datePath = query.date ? encodeURIComponent(query.date) : "latest";
    const url = `https://api.frankfurter.app/${datePath}?from=${from}&to=${to}&amount=${amount}`;
    ctx.log.debug({ url }, "frankfurter fetch");
    const data = await fetchJson<FrankfurterResponse>(url, { trusted: true, signal: ctx.signal });
    const converted = data.rates[to];
    if (converted == null) {
      throw new Error(`Frankfurter returned no rate for ${to}`);
    }
    return {
      base: data.base,
      target: to,
      amount,
      rate: converted / amount,
      converted,
      date: data.date,
    };
  },
});
