/**
 * Unified ephemeral store — routes operations to the correct backend
 * based on namespace.
 *
 * Usage:
 *   import { ephemeralStore } from "./runtime/ephemeral-store/index.js";
 *   await ephemeralStore.put({ namespace: "agent-kv", key: "foo", value: "bar", ... });
 *   const entry = await ephemeralStore.get("agent-kv", "foo");
 */
import { childLogger } from "../../logger.js";
import { logAudit } from "../../audit/logger.js";
import { createCronJob } from "../scheduler.js";
import { redisBackend } from "./redis-backend.js";
import { postgresBackend } from "./postgres-backend.js";
import {
  routeNamespace,
  type EphemeralBackend,
  type EphemeralBackendDriver,
  type EphemeralCleanupResult,
  type EphemeralEntry,
  type EphemeralQueryFilter,
} from "./types.js";

export {
  type EphemeralEntry,
  type EphemeralQueryFilter,
  type EphemeralCleanupResult,
  type EphemeralBackend,
  routeNamespace,
  NAMESPACE_ROUTES,
} from "./types.js";

const log = childLogger("ephemeral-store");
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const inMemoryFallback = new Map<string, EphemeralEntry>();
const fallbackWarnings = new Set<string>();

const backends: Record<EphemeralBackend, EphemeralBackendDriver> = {
  redis: redisBackend,
  postgres: postgresBackend,
};

function getDriver(namespace: string): { backend: EphemeralBackend; driver: EphemeralBackendDriver } {
  const backend = routeNamespace(namespace);
  return { backend, driver: backends[backend] };
}

function fallbackEntryKey(namespace: string, key: string): string {
  return `${namespace}::${key}`;
}

function purgeExpiredFallback(now = Date.now()): void {
  for (const [key, entry] of inMemoryFallback.entries()) {
    if (new Date(entry.expiresAt).getTime() <= now) {
      inMemoryFallback.delete(key);
    }
  }
}

function rememberFallback(entry: EphemeralEntry): void {
  purgeExpiredFallback();
  inMemoryFallback.set(fallbackEntryKey(entry.namespace, entry.key), entry);
}

function forgetFallback(namespace: string, key: string): boolean {
  return inMemoryFallback.delete(fallbackEntryKey(namespace, key));
}

function getFallback(namespace: string, key: string): EphemeralEntry | null {
  purgeExpiredFallback();
  return inMemoryFallback.get(fallbackEntryKey(namespace, key)) ?? null;
}

function queryFallback(filter: EphemeralQueryFilter): EphemeralEntry[] {
  purgeExpiredFallback();
  const limit = filter.limit ?? 100;
  const entries = [...inMemoryFallback.values()].filter((entry) => {
    if (entry.namespace !== filter.namespace) return false;
    if (filter.keyPrefix && !entry.key.startsWith(filter.keyPrefix)) return false;
    if (filter.sessionId && entry.sessionId !== filter.sessionId) return false;
    if (filter.agentName && entry.agentName !== filter.agentName) return false;
    return true;
  });

  entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return entries.slice(0, limit);
}

function logFallback(namespace: string, backend: EphemeralBackend, err: unknown): void {
  if (!isBackendConfigured(backend)) return;
  const key = `${backend}:${namespace}`;
  if (fallbackWarnings.has(key)) return;
  fallbackWarnings.add(key);
  log.warn({ backend, namespace, err }, "Ephemeral backend unavailable; using in-memory fallback");
}

function isBackendConfigured(backend: EphemeralBackend): boolean {
  switch (backend) {
    case "redis":
      return Boolean(process.env["REDIS_URL"]);
    case "postgres":
      return Boolean(process.env["DATABASE_URL"]);
    default:
      return false;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize all backends. Call once at startup.
 * Returns which backends are available.
 */
export async function initEphemeralStore(): Promise<Record<EphemeralBackend, boolean>> {
  const results: Record<string, boolean> = {};
  for (const [name, driver] of Object.entries(backends)) {
    results[name] = await driver.init();
    log.info({ backend: name, available: results[name] }, "Ephemeral backend initialized");
  }
  return results as Record<EphemeralBackend, boolean>;
}

/**
 * Store or overwrite an entry.
 * If createdAt/expiresAt are not set, defaults to now + 24h.
 */
export async function ephemeralPut(
  entry: Omit<EphemeralEntry, "createdAt" | "expiresAt"> & { createdAt?: string; expiresAt?: string },
): Promise<void> {
  const now = new Date();
  const full: EphemeralEntry = {
    ...entry,
    createdAt: entry.createdAt ?? now.toISOString(),
    expiresAt: entry.expiresAt ?? new Date(now.getTime() + DEFAULT_TTL_MS).toISOString(),
  };
  const { backend, driver } = getDriver(full.namespace);
  try {
    await driver.put(full);
    forgetFallback(full.namespace, full.key);
  } catch (err) {
    logFallback(full.namespace, backend, err);
    rememberFallback(full);
  }
}

/**
 * Retrieve a single entry by namespace + key.
 */
export async function ephemeralGet(
  namespace: string,
  key: string,
): Promise<EphemeralEntry | null> {
  const { backend, driver } = getDriver(namespace);
  try {
    const entry = await driver.get(namespace, key);
    return entry ?? getFallback(namespace, key);
  } catch (err) {
    logFallback(namespace, backend, err);
    return getFallback(namespace, key);
  }
}

/**
 * Query entries by filter.
 */
export async function ephemeralQuery(
  filter: EphemeralQueryFilter,
): Promise<EphemeralEntry[]> {
  const { backend, driver } = getDriver(filter.namespace);
  const fallbackEntries = queryFallback(filter);
  try {
    const backendEntries = await driver.query(filter);
    if (backendEntries.length === 0) return fallbackEntries;

    const merged = new Map<string, EphemeralEntry>();
    for (const entry of [...backendEntries, ...fallbackEntries]) {
      merged.set(fallbackEntryKey(entry.namespace, entry.key), entry);
    }
    return [...merged.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, filter.limit ?? 100);
  } catch (err) {
    logFallback(filter.namespace, backend, err);
    return fallbackEntries;
  }
}

/**
 * Delete a single entry.
 */
export async function ephemeralDelete(
  namespace: string,
  key: string,
): Promise<boolean> {
  const { backend, driver } = getDriver(namespace);
  const fallbackDeleted = forgetFallback(namespace, key);
  try {
    const deleted = await driver.delete(namespace, key);
    return deleted || fallbackDeleted;
  } catch (err) {
    logFallback(namespace, backend, err);
    return fallbackDeleted;
  }
}

/**
 * Run cleanup across all backends. Returns per-backend results.
 */
export async function ephemeralCleanupAll(): Promise<EphemeralCleanupResult[]> {
  const results: EphemeralCleanupResult[] = [];
  for (const driver of Object.values(backends)) {
    try {
      results.push(await driver.cleanupExpired());
    } catch (err) {
      results.push({ backend: driver.name, deletedCount: 0, durationMs: 0, error: String(err) });
    }
  }
  return results;
}

/**
 * Register the nightly cleanup cron job.
 * Schedule: 02:00 UTC daily.
 */
export function registerEphemeralCleanupCron(): void {
  createCronJob("0 2 * * *", "ephemeral-store-cleanup", "Purge expired ephemeral data from all backends", async () => {
    log.info("Starting nightly ephemeral store cleanup");
    const results = await ephemeralCleanupAll();

    let totalDeleted = 0;
    for (const r of results) {
      totalDeleted += r.deletedCount;
      if (r.error) {
        log.error({ backend: r.backend, error: r.error, durationMs: r.durationMs }, "Cleanup failed for backend");
      } else {
        log.info({ backend: r.backend, deletedCount: r.deletedCount, durationMs: r.durationMs }, "Cleanup complete");
      }
    }

    logAudit("ephemeral_cleanup", { results, totalDeleted }, {
      severity: results.some((r) => r.error) ? "warn" : "info",
    });
  });

  log.info("Ephemeral store cleanup cron registered (0 2 * * * UTC)");
}

/**
 * Graceful shutdown — close all backends.
 */
export async function shutdownEphemeralStore(): Promise<void> {
  inMemoryFallback.clear();
  fallbackWarnings.clear();
  for (const driver of Object.values(backends)) {
    await driver.close();
  }
  log.info("Ephemeral store shut down");
}
