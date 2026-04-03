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
import { mongoBackend } from "./mongo-backend.js";
import {
  routeNamespace,
  DEFAULT_BACKEND,
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

const backends: Record<EphemeralBackend, EphemeralBackendDriver> = {
  redis: redisBackend,
  postgres: postgresBackend,
  mongo: mongoBackend,
};

function getDriver(namespace: string): EphemeralBackendDriver {
  const backend = routeNamespace(namespace);
  return backends[backend];
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
  const driver = getDriver(full.namespace);
  await driver.put(full);
}

/**
 * Retrieve a single entry by namespace + key.
 */
export async function ephemeralGet(
  namespace: string,
  key: string,
): Promise<EphemeralEntry | null> {
  const driver = getDriver(namespace);
  return driver.get(namespace, key);
}

/**
 * Query entries by filter.
 */
export async function ephemeralQuery(
  filter: EphemeralQueryFilter,
): Promise<EphemeralEntry[]> {
  const driver = getDriver(filter.namespace);
  return driver.query(filter);
}

/**
 * Delete a single entry.
 */
export async function ephemeralDelete(
  namespace: string,
  key: string,
): Promise<boolean> {
  const driver = getDriver(namespace);
  return driver.delete(namespace, key);
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
  for (const driver of Object.values(backends)) {
    await driver.close();
  }
  log.info("Ephemeral store shut down");
}
