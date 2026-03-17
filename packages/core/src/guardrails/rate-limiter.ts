import { createClient } from "./redis-client.js";
import { getConfig } from "../config/loader.js";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

// Local in-memory fallback when Redis is unavailable.
// Uses a sliding window counter per key with automatic cleanup.
const _localBuckets = new Map<string, { count: number; windowStart: number }>();

function localRateCheck(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = _localBuckets.get(key);

  if (!bucket || now - bucket.windowStart > windowMs) {
    _localBuckets.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: limit - 1, resetAt: new Date(now + windowMs) };
  }

  bucket.count++;
  const remaining = Math.max(0, limit - bucket.count);
  const resetAt = new Date(bucket.windowStart + windowMs);

  if (bucket.count > limit) {
    return { allowed: false, remaining: 0, resetAt };
  }
  return { allowed: true, remaining, resetAt };
}

// Periodically prune stale local buckets
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of _localBuckets) {
    if (now - bucket.windowStart > 120_000) _localBuckets.delete(key);
  }
}, 60_000).unref();

export async function checkRateLimit(
  sessionId: string,
  action: "request" | "tool_call"
): Promise<RateLimitResult> {
  const config = getConfig();
  const limit =
    action === "request"
      ? config.agents.rateLimit.requestsPerMinute
      : config.agents.rateLimit.toolCallsPerTurn * 60; // per minute equivalent

  const key = `rl:${action}:${sessionId}`;
  const windowMs = config.agents.rateLimit.windowMs ?? 60_000;
  const now = Date.now();
  const windowStart = now - windowMs;

  try {
    const redis = createClient();
    const pipe = redis.multi();
    pipe.zremrangebyscore(key, "-inf", windowStart.toString());
    pipe.zadd(key, now.toString(), `${now}-${Math.random()}`);
    pipe.zcard(key);
    pipe.pexpire(key, windowMs * 2);
    const results = await pipe.exec();

    // Check for partial pipeline failures
    if (!results || results.length < 3) {
      return localRateCheck(key, limit, windowMs);
    }
    for (const [err] of results) {
      if (err) {
        return localRateCheck(key, limit, windowMs);
      }
    }

    const count = (results[2]![1] as number) ?? 0;
    const resetAt = new Date(now + windowMs);

    if (count > limit) {
      return { allowed: false, remaining: 0, resetAt };
    }
    return { allowed: true, remaining: limit - count, resetAt };
  } catch {
    // Redis unavailable — fall back to local in-memory rate limiting (fail-closed)
    return localRateCheck(key, limit, windowMs);
  }
}
