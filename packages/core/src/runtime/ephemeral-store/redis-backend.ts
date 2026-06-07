/**
 * Redis backend for ephemeral store.
 *
 * Storage layout:
 *   Key:   starlingai:eph:{namespace}:{key}
 *   Value: JSON-serialized EphemeralEntry
 *   TTL:   Set via EXPIREAT to entry.expiresAt
 *
 * Reuses the lazy-init pattern from swarm/memory.ts.
 */
import { childLogger } from "../../logger.js";
import type {
  EphemeralBackendDriver,
  EphemeralCleanupResult,
  EphemeralEntry,
  EphemeralQueryFilter,
} from "./types.js";

const log = childLogger("ephemeral:redis");
const KEY_PREFIX = "starlingai:eph:";

 
let _redis: any = null;
let _redisReady = false;

async function getRedis(): Promise<unknown | null> {
  if (_redisReady) return _redis;
  if (_redis !== null) return null; // Already failed

  const url = process.env["REDIS_URL"];
  if (!url) return null;

  try {
     
    const ioredis = (await import("ioredis")) as any;
    const IORedis = ioredis.default ?? ioredis;
    _redis = new IORedis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    await (_redis as { connect: () => Promise<void> }).connect();
    _redisReady = true;
    log.info("Redis ephemeral store connected");
    return _redis;
  } catch (err) {
    log.warn({ err }, "Redis ephemeral store connection failed");
    _redis = null;
    return null;
  }
}

function redisKey(namespace: string, key: string): string {
  return `${KEY_PREFIX}${namespace}:${key}`;
}

export const redisBackend: EphemeralBackendDriver = {
  name: "redis",

  async init(): Promise<boolean> {
    return (await getRedis()) !== null;
  },

  async put(entry: EphemeralEntry): Promise<void> {
    const r = await getRedis();
    if (!r) throw new Error("Redis not available");

    const rk = redisKey(entry.namespace, entry.key);
    const expireUnix = Math.floor(new Date(entry.expiresAt).getTime() / 1000);
    const payload = JSON.stringify(entry);

     
    const redis = r as any;
    await redis.set(rk, payload);
    await redis.expireat(rk, expireUnix);
  },

  async get(namespace: string, key: string): Promise<EphemeralEntry | null> {
    const r = await getRedis();
    if (!r) return null;

     
    const raw = await (r as any).get(redisKey(namespace, key));
    if (!raw) return null;

    try {
      return JSON.parse(raw) as EphemeralEntry;
    } catch {
      return null;
    }
  },

  async query(filter: EphemeralQueryFilter): Promise<EphemeralEntry[]> {
    const r = await getRedis();
    if (!r) return [];

    const limit = filter.limit ?? 100;
    const pattern = filter.keyPrefix
      ? `${KEY_PREFIX}${filter.namespace}:${filter.keyPrefix}*`
      : `${KEY_PREFIX}${filter.namespace}:*`;

     
    const redis = r as any;
    const results: EphemeralEntry[] = [];
    let cursor = "0";

    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = nextCursor;

      if (keys.length > 0) {
        const values = await redis.mget(...keys);
        for (const val of values) {
          if (!val) continue;
          try {
            const entry = JSON.parse(val) as EphemeralEntry;
            if (filter.sessionId && entry.sessionId !== filter.sessionId) continue;
            if (filter.agentName && entry.agentName !== filter.agentName) continue;
            results.push(entry);
            if (results.length >= limit) break;
          } catch {
            // skip corrupt entries
          }
        }
      }
    } while (cursor !== "0" && results.length < limit);

    return results;
  },

  async delete(namespace: string, key: string): Promise<boolean> {
    const r = await getRedis();
    if (!r) return false;

     
    const count = await (r as any).del(redisKey(namespace, key));
    return count > 0;
  },

  async cleanupExpired(): Promise<EphemeralCleanupResult> {
    // Redis handles TTL natively, but we do a sweep for any entries
    // that may have lost their TTL (e.g. after RESTORE).
    const start = Date.now();
    const r = await getRedis();
    if (!r) {
      return { backend: "redis", deletedCount: 0, durationMs: 0, error: "not connected" };
    }

     
    const redis = r as any;
    const now = Date.now();
    let deletedCount = 0;
    let cursor = "0";

    try {
      do {
        const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `${KEY_PREFIX}*`, "COUNT", 200);
        cursor = nextCursor;

        for (const key of keys) {
          const ttl = await redis.ttl(key);
          if (ttl === -1) {
            // Key has no expiry — check if it should be expired
            const raw = await redis.get(key);
            if (raw) {
              try {
                const entry = JSON.parse(raw) as EphemeralEntry;
                if (new Date(entry.expiresAt).getTime() <= now) {
                  await redis.del(key);
                  deletedCount++;
                }
              } catch {
                // Corrupt entry — remove it
                await redis.del(key);
                deletedCount++;
              }
            }
          }
        }
      } while (cursor !== "0");
    } catch (err) {
      return { backend: "redis", deletedCount, durationMs: Date.now() - start, error: String(err) };
    }

    return { backend: "redis", deletedCount, durationMs: Date.now() - start };
  },

  async close(): Promise<void> {
    if (_redis && _redisReady) {
      try {
         
        await (_redis as any).quit();
      } catch {
        // ignore
      }
    }
    _redis = null;
    _redisReady = false;
  },
};
