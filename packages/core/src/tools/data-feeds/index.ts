/**
 * Data Feeds — pluggable real-time data providers.
 *
 * Importing this module is sufficient to register every built-in provider and
 * the LLM-facing tools that consume them. To add a new free-API source:
 *
 *   1. Drop a file under `providers/<category>-<name>.ts` exporting a
 *      `DataFeedProvider` and calling `registerDataFeedProvider(...)` at load.
 *   2. Add the side-effect import below.
 *   3. (Optional) extend `tools.ts` if a *new* category needs a new tool —
 *      providers in an existing category light up automatically.
 */

// Provider registrations (side-effect imports; order is irrelevant).
import "./providers/weather-open-meteo.js";
import "./providers/news-hackernews.js";
import "./providers/news-reddit.js";
import "./providers/news-rss.js";
import "./providers/finance-frankfurter.js";
import "./providers/finance-coingecko.js";
import "./providers/reference-wikipedia.js";

// LLM-facing tools.
import "./tools.js";

export type { DataFeedCategory, DataFeedProvider, ProviderContext } from "./types.js";
export {
  registerDataFeedProvider,
  getDataFeedProvider,
  listDataFeedProviders,
  getEnabledProviders,
  buildProviderContext,
} from "./provider-registry.js";
