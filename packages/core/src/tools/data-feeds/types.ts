/**
 * Data Feeds — pluggable provider architecture for real-time external data.
 *
 * The architecture lets us add new free-tier APIs (weather, news, finance,
 * reference, network) without touching the LLM-facing tool surface.  Tools
 * declare which `category` of provider they need; providers register
 * themselves and the registry routes calls to the matching one(s).
 *
 * Adding a new API:
 *   1. Create `providers/<category>-<name>.ts` exporting a `DataFeedProvider`
 *   2. Call `registerDataFeedProvider(...)` at module load
 *   3. Add the side-effect import to `data-feeds/index.ts`
 *   4. (Optional) Add a config entry under `dataFeeds.providers.<id>`
 */

export type DataFeedCategory =
  | "weather"
  | "news"
  | "finance.fx"
  | "finance.crypto"
  | "finance.stocks"
  | "reference"
  | "network";

export interface DataFeedProvider<TQuery = Record<string, unknown>, TResult = unknown> {
  /** Globally unique provider id, e.g. "open-meteo", "hackernews". */
  id: string;
  /** Category — tools select providers by category. */
  category: DataFeedCategory;
  /** Human-readable description. Surfaced by `list_data_feeds`. */
  description: string;
  /** Public homepage / docs URL. Surfaced by `list_data_feeds`. */
  homepage?: string;
  /** When true, the provider needs `dataFeeds.providers[id].apiKey` to function. */
  requiresApiKey: boolean;
  /** Env var name suggested for the API key (documentation only — never read directly). */
  apiKeyEnvVarHint?: string;
  /**
   * Fetch data.  The provider receives a typed query and a runtime context.
   * It must NEVER throw for "no results" — return an empty result instead.
   * It MAY throw for transport / auth / quota errors; the registry surfaces those.
   */
  fetch(query: TQuery, ctx: ProviderContext): Promise<TResult>;
}

export interface ProviderContext {
  /** Provider-scoped API key, resolved server-side from config/env. */
  apiKey?: string;
  /** Per-provider configuration overrides from the config file. */
  config: Record<string, unknown>;
  /** Logger child scoped to this provider. */
  log: { info: Fn; warn: Fn; error: Fn; debug: Fn };
  /** Abort signal honoured by the registry's HTTP helper. */
  signal?: AbortSignal;
}

type Fn = (...args: unknown[]) => void;

export interface ProviderQueryEnvelope<TResult> {
  providerId: string;
  fetchedAt: string;
  cached: boolean;
  result: TResult;
}
