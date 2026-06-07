import * as ioredis from "ioredis";

// ioredis exports the Redis class as both default and named export
 
const IORedis = (ioredis as any).default ?? ioredis;
type RedisClient = ioredis.Redis;

let _redis: RedisClient | null = null;

export function createClient(): RedisClient {
  if (_redis) return _redis;
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
