import type { DataFeedCategory, DataFeedProvider, ProviderContext } from "./types.js";
import { childLogger } from "../../logger.js";
import { getConfig } from "../../config/loader.js";
import { resolveSecretRef } from "../infrastructure-shared.js";

const log = childLogger("data-feeds:registry");

const _providers = new Map<string, DataFeedProvider<unknown, unknown>>();

export function registerDataFeedProvider<TQuery, TResult>(
  provider: DataFeedProvider<TQuery, TResult>,
): void {
  if (_providers.has(provider.id)) {
    log.warn({ id: provider.id }, "data-feed provider re-registered (overwriting)");
  }
  _providers.set(provider.id, provider as DataFeedProvider<unknown, unknown>);
}

export function getDataFeedProvider(id: string): DataFeedProvider<unknown, unknown> | undefined {
  return _providers.get(id);
}

export function listDataFeedProviders(category?: DataFeedCategory): DataFeedProvider<unknown, unknown>[] {
  const all = [..._providers.values()];
  return category ? all.filter((p) => p.category === category) : all;
}

/**
 * Returns enabled providers for a category, in declaration order.
 *
 * Behaviour:
 *  - Providers without an `enabled` config entry are enabled by default IF they
 *    do not require an API key.  Keyed providers are disabled until an explicit
 *    `apiKey` (env-var ref or stored credential) is supplied.
 *  - Explicit `enabled: false` always disables.
 *  - Explicit `enabled: true` enables, even for keyed providers — useful when
 *    the key comes from another mechanism.
 */
export function getEnabledProviders(category: DataFeedCategory): DataFeedProvider<unknown, unknown>[] {
  const cfg = getDataFeedsConfig();
  return listDataFeedProviders(category).filter((p) => {
    const entry = cfg.providers?.[p.id] ?? {};
    if (entry.enabled === false) return false;
    if (entry.enabled === true) return true;
    // Default: free providers (no key) are on; keyed providers wait for an apiKey.
    if (!p.requiresApiKey) return true;
    return Boolean(entry.apiKey);
  });
}

/** Build the per-call ProviderContext for a given provider, resolving its API key server-side. */
export function buildProviderContext<TQuery, TResult>(provider: DataFeedProvider<TQuery, TResult>, signal?: AbortSignal): ProviderContext {
  const cfg = getDataFeedsConfig();
  const entry = cfg.providers?.[provider.id] ?? {};
  const rawKey = typeof entry.apiKey === "string" ? entry.apiKey : undefined;
  const resolvedKey = resolveSecretRef(rawKey);
  return {
    apiKey: resolvedKey,
    config: (entry.config ?? {}) as Record<string, unknown>,
    log: childLogger(`data-feed:${provider.id}`),
    signal,
  };
}

interface DataFeedsRuntimeConfig {
  providers?: Record<string, { enabled?: boolean; apiKey?: string; config?: Record<string, unknown> }>;
}

function getDataFeedsConfig(): DataFeedsRuntimeConfig {
  // dataFeeds is optional in the config — return empty shape when missing.
  const root = getConfig() as { dataFeeds?: DataFeedsRuntimeConfig };
  return root.dataFeeds ?? {};
}
