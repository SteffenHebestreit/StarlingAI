import * as ioredis from "ioredis";

// ioredis exports the Redis class as both default and named export
 
const IORedis = (ioredis as any).default ?? ioredis;
type RedisClient = ioredis.Redis;

let _redis: RedisClient | null = null;

export function createClient(): RedisClient {
  if (_redis) return _redis;
  // The harness-lab process is cut off from the shared stores (harness-lab/bootstrap.ts): no
  // localhost default, where a published Redis would take its writes. The caller falls back to
  // its in-memory path (guardrails/rate-limiter.ts).
  if (!process.env["REDIS_URL"] && process.env["SAI_HARNESS_LAB_PROCESS"] === "1") {
    throw new Error("No Redis in the harness-lab process");
  }
  const url = process.env["REDIS_URL"] ?? "redis://localhost:6379";
   
  _redis = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1 }) as RedisClient;
  return _redis;
}

export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
