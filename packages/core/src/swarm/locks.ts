/**
 * Distributed task locks — prevents two agents from claiming the same task
 * simultaneously when multiple instances share a Redis backend.
 *
 * Uses Redis SET NX PX (atomic test-and-set) for distributed locking.
 * Falls back to an in-process Map when Redis is unavailable, which is safe
 * for single-instance deployments.
 */
import { randomUUID } from "node:crypto";
import { childLogger } from "../logger.js";

const log = childLogger("swarm:locks");

const LOCK_PREFIX = "starlingai:lock:task:";

// ── In-process fallback ──────────────────────────────────────────────────────

const _localLocks = new Map<string, { owner: string; expiresAt: number }>();

// Periodically prune expired in-process locks
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _localLocks) {
    if (entry.expiresAt <= now) _localLocks.delete(key);
  }
}, 30_000).unref();

// ── Redis client (lazy init) ─────────────────────────────────────────────────

 
let _redis: any = null;
let _redisConnected = false;

async function getRedis(): Promise<unknown | null> {
  if (_redisConnected) return _redis;
  if (_redis !== null) return null; // Connection already failed; skip retry until restart

  const url = process.env["REDIS_URL"];
  if (!url) return null;

  try {
     
    const ioredis = await import("ioredis") as any;
    const IORedis = ioredis.default ?? ioredis;
    _redis = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    await (_redis as { connect: () => Promise<void> }).connect();
    _redisConnected = true;
    return _redis;
  } catch (err) {
    log.warn({ err }, "Locks Redis connection failed — using in-process fallback");
    _redis = null;
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Attempt to acquire an exclusive lock on a task.
 * Returns the owner token (string) if the lock was acquired, or null if
 * the task is already locked by another holder.
 *
 * @param taskId   The task identifier to lock
 * @param ttlMs    Lock time-to-live in milliseconds (default 30 s)
 */
export async function acquireTaskLock(taskId: string, ttlMs = 30_000): Promise<string | null> {
  const owner = randomUUID();
  const key = `${LOCK_PREFIX}${taskId}`;

  const redis = await getRedis();
  if (redis) {
    try {
      const result = await (redis as {
        set: (k: string, v: string, px: string, ms: number, nx: string) => Promise<string | null>
      }).set(key, owner, "PX", ttlMs, "NX");
      if (result === "OK") {
        log.debug({ taskId, owner }, "Task lock acquired (Redis)");
        return owner;
      }
      return null;
    } catch (err) {
      log.warn({ err, taskId }, "Redis lock acquisition failed — falling back to in-process");
    }
  }

  // In-process fallback
  const now = Date.now();
  const existing = _localLocks.get(key);
  if (existing && existing.expiresAt > now) return null;
  _localLocks.set(key, { owner, expiresAt: now + ttlMs });
  log.debug({ taskId, owner }, "Task lock acquired (in-process)");
  return owner;
}

/**
 * Release a previously acquired lock.
 * Only releases the lock if we still own it (owner token matches).
 * Safe to call even if the lock has already expired.
 */
export async function releaseTaskLock(taskId: string, owner: string): Promise<void> {
  const key = `${LOCK_PREFIX}${taskId}`;

  const redis = await getRedis();
  if (redis) {
    try {
      // Atomic check-and-delete: only delete if we own the lock
      await (redis as { eval: (script: string, keyCount: number, key: string, owner: string) => Promise<unknown> })
        .eval(
          `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
          1, key, owner,
        );
      log.debug({ taskId }, "Task lock released (Redis)");
      return;
    } catch (err) {
      log.warn({ err, taskId }, "Redis lock release failed — falling back to in-process");
    }
  }

  // In-process fallback
  const existing = _localLocks.get(key);
  if (existing?.owner === owner) {
    _localLocks.delete(key);
    log.debug({ taskId }, "Task lock released (in-process)");
  }
}

/** Reset all state — for use in tests only. */
export async function resetLocksForTests(): Promise<void> {
  _localLocks.clear();
  if (_redis) {
    try { await (_redis as { quit: () => Promise<void> }).quit(); } catch { /* ignore */ }
  }
  _redis = null;
  _redisConnected = false;
}
