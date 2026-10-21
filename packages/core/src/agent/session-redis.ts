/**
 * Redis-backed session persistence adapter.
 *
 * Enabled when REDIS_URL is set (shares the same connection config as the swarm bus
 * so no additional env-var is needed).  When Redis is unavailable or unconfigured
 * the module is a no-op and sessions fall back to the local JSON-file store.
 *
 * Data model:
 *   sai:session:<id>            — JSON string, EX = SESSION_TTL_SECONDS
 *   sai:session-index           — sorted set, score = updatedAt (epoch ms)
 *   sai:ch:<channel>:<senderId> — string, session ID for cross-instance channel routing
 */

import { childLogger } from "../logger.js";

const log = childLogger("agent:session-redis");

/** The key of one session's record; the harness lab's harvest reads it (harness-lab/harvest-stores.ts). */
export const SESSION_KEY = (id: string) => `sai:session:${id}`;
const SESSION_INDEX_KEY = "sai:session-index";
const CHANNEL_SESSION_KEY = (channelType: string, senderId: string) =>
  `sai:ch:${channelType}:${senderId}`;

/** 7-day TTL so sessions survive instance restarts and brief Redis outages. */
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Hard cap on bulk hydration to keep startup latency bounded. */
const MAX_HYDRATE = 1_000;

// ioredis is a peer dep — use dynamic import to avoid hard failure when not available.
 
type RedisClient = any;

/**
 * Cached promise so concurrent callers share a single connection attempt and
 * later calls await the same result instead of seeing `null`.
 * Resolves to `null` when REDIS_URL is unset or ioredis cannot be loaded.
 */
let _clientPromise: Promise<RedisClient | null> | null = null;

function getRedisClient(): Promise<RedisClient | null> {
  if (_clientPromise) return _clientPromise;

  const url = process.env["REDIS_URL"]?.trim();
  if (!url) {
    _clientPromise = Promise.resolve(null);
    return _clientPromise;
  }

  _clientPromise = import("ioredis")
    .then((mod) => {
      const IORedis = (mod.default ?? mod) as unknown as new (
        url: string,
        opts: Record<string, unknown>,
      ) => RedisClient;
      const client = new IORedis(url, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: false,
        lazyConnect: false,
        enableOfflineQueue: true,
      });
      client.on("error", (err: Error) => log.warn({ err }, "Redis session store error"));
      client.on("ready", () => log.info("Redis session store ready"));
      return client;
    })
    .catch((err) => {
      log.warn({ err }, "ioredis not available — Redis session store disabled");
      return null;
    });

  return _clientPromise;
}

/**
 * Persist one serialized session record to Redis.
 * `json` should be the result of `JSON.stringify(session.toRecord())`.
 * `updatedAtMs` is the epoch-ms timestamp used as the sorted-set score.
 */
export async function saveSessionToRedis(
  id: string,
  json: string,
  updatedAtMs: number,
): Promise<void> {
  const redis = await getRedisClient();
  if (!redis) return;
  try {
    await redis
      .multi()
      .set(SESSION_KEY(id), json, "EX", SESSION_TTL_SECONDS)
      .zadd(SESSION_INDEX_KEY, updatedAtMs, id)
      .exec();
  } catch (err) {
    log.warn({ err, sessionId: id }, "Failed to save session to Redis");
  }
}

/**
 * Load a serialized session record from Redis.
 * Returns the raw JSON string or `null` when not found / Redis unavailable.
 */
export async function loadSessionFromRedis(id: string): Promise<string | null> {
  const redis = await getRedisClient();
  if (!redis) return null;
  try {
    return await redis.get(SESSION_KEY(id));
  } catch (err) {
    log.warn({ err, sessionId: id }, "Failed to load session from Redis");
    return null;
  }
}

/**
 * Delete a session from Redis — removes both the record and the index entry.
 */
export async function deleteSessionFromRedis(id: string): Promise<void> {
  const redis = await getRedisClient();
  if (!redis) return;
  try {
    await redis.multi().del(SESSION_KEY(id)).zrem(SESSION_INDEX_KEY, id).exec();
  } catch (err) {
    log.warn({ err, sessionId: id }, "Failed to delete session from Redis");
  }
}

/**
 * Load the most recent serialized session records from Redis (raw JSON strings).
 * Capped at `MAX_HYDRATE` to bound startup latency; older sessions are still
 * available via `loadSessionFromRedis` lookup when referenced.
 * Callers are responsible for deserialization into AgentSession objects.
 */
export async function loadAllSessionsFromRedis(): Promise<string[]> {
  const redis = await getRedisClient();
  if (!redis) return [];
  try {
    // ZREVRANGE returns highest-score (most recent) first.
    const ids: string[] = await redis.zrevrange(SESSION_INDEX_KEY, 0, MAX_HYDRATE - 1);
    if (!ids.length) return [];

    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.get(SESSION_KEY(id));
    const results: Array<[Error | null, unknown]> = (await pipeline.exec()) ?? [];

    return results.flatMap(([err, raw]) =>
      !err && typeof raw === "string" ? [raw] : [],
    );
  } catch (err) {
    log.warn({ err }, "Failed to load all sessions from Redis");
    return [];
  }
}

// ── The account migration's access (runtime/account-migration.ts) ───────────
// The calls above swallow every Redis error, which is right for a mirror written in the background
// and wrong for a migration that rewrites the store of record (in Docker the session file does not
// survive a container recreate): these throw, so a step that did not land is reported as failed.

/** Whether a Redis mirror is configured at all. */
export function sessionRedisConfigured(): boolean {
  return Boolean(process.env["REDIS_URL"]?.trim());
}

async function requireRedisClient(): Promise<RedisClient | null> {
  if (!sessionRedisConfigured()) return null;
  const redis = await getRedisClient();
  if (!redis) throw new Error("the Redis session mirror is configured but its client could not be loaded");
  return redis;
}

/**
 * Every session record in the mirror, however many: the boot hydrates only the most recent
 * MAX_HYDRATE, and a session that exists only in the mirror must not be missed. Read in pages of
 * the index. Null when no mirror is configured; throws when it is and fails.
 */
export async function loadEverySessionFromRedis(): Promise<Array<{ id: string; json: string }> | null> {
  const redis = await requireRedisClient();
  if (!redis) return null;
  const out: Array<{ id: string; json: string }> = [];
  const PAGE = 500;
  for (let start = 0; ; start += PAGE) {
    const ids: string[] = await redis.zrange(SESSION_INDEX_KEY, start, start + PAGE - 1);
    if (!ids.length) break;
    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.get(SESSION_KEY(id));
    const results: Array<[Error | null, unknown]> = (await pipeline.exec()) ?? [];
    results.forEach(([err, raw], index) => {
      if (err) throw err;
      if (typeof raw === "string") out.push({ id: ids[index]!, json: raw });
    });
    if (ids.length < PAGE) break;
  }
  return out;
}

/** Writes one record; false when no mirror is configured, throws when the write fails. */
export async function saveSessionToRedisChecked(id: string, json: string, updatedAtMs: number): Promise<boolean> {
  const redis = await requireRedisClient();
  if (!redis) return false;
  const results: Array<[Error | null, unknown]> | null = await redis
    .multi()
    .set(SESSION_KEY(id), json, "EX", SESSION_TTL_SECONDS)
    .zadd(SESSION_INDEX_KEY, updatedAtMs, id)
    .exec();
  const failed = results?.find(([err]) => err);
  if (!results || failed) throw failed?.[0] ?? new Error(`Redis did not run the write of session ${id}`);
  return true;
}

/** Reads one record back; null when absent or no mirror is configured, throws when the read fails. */
export async function loadSessionFromRedisChecked(id: string): Promise<string | null> {
  const redis = await requireRedisClient();
  if (!redis) return null;
  return (await redis.get(SESSION_KEY(id))) as string | null;
}

/** Deletes one record and its index entry (a purge); false when no mirror is configured. */
export async function deleteSessionFromRedisChecked(id: string): Promise<boolean> {
  const redis = await requireRedisClient();
  if (!redis) return false;
  await redis.multi().del(SESSION_KEY(id)).zrem(SESSION_INDEX_KEY, id).exec();
  return true;
}

/**
 * Look up the session ID associated with a channel + sender pair.
 * Used to route incoming channel messages to existing sessions on other instances.
 */
export async function getChannelSessionId(
  channelType: string,
  senderId: string,
): Promise<string | null> {
  const redis = await getRedisClient();
  if (!redis) return null;
  try {
    return await redis.get(CHANNEL_SESSION_KEY(channelType, senderId));
  } catch (err) {
    log.warn({ err, channelType, senderId }, "Failed to get channel session ID from Redis");
    return null;
  }
}

/**
 * Persist the channel → session ID mapping in Redis.
 * Called whenever a session is created or looked up for a channel sender.
 */
export async function setChannelSessionId(
  channelType: string,
  senderId: string,
  sessionId: string,
): Promise<void> {
  const redis = await getRedisClient();
  if (!redis) return;
  try {
    await redis.set(
      CHANNEL_SESSION_KEY(channelType, senderId),
      sessionId,
      "EX",
      SESSION_TTL_SECONDS,
    );
  } catch (err) {
    log.warn({ err, channelType, senderId }, "Failed to set channel session ID in Redis");
  }
}

/**
 * Close the Redis connection — called during graceful shutdown.
 */
export async function closeSessionRedis(): Promise<void> {
  const promise = _clientPromise;
  _clientPromise = null;
  if (!promise) return;
  const client = await promise;
  if (client) {
    await (client as { quit: () => Promise<void> }).quit().catch(() => {});
  }
}
