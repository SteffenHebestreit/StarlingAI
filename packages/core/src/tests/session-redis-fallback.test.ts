import { describe, expect, it, beforeAll } from "vitest";
import {
  saveSessionToRedis,
  loadSessionFromRedis,
  deleteSessionFromRedis,
  loadAllSessionsFromRedis,
  getChannelSessionId,
  setChannelSessionId,
  closeSessionRedis,
} from "../agent/session-redis.js";

// With no REDIS_URL configured (the default in tests), the adapter is a no-op and sessions fall back
// to the local JSON store — every op resolves to its "Redis unavailable" value without connecting.
describe("session-redis adapter — Redis-unavailable fallback", () => {
  beforeAll(async () => {
    delete process.env["REDIS_URL"];
    await closeSessionRedis(); // reset any cached client promise from earlier modules
  });

  it("degrades every operation to the local-store fallback", async () => {
    await expect(saveSessionToRedis("id-1", "{\"x\":1}", 1)).resolves.toBeUndefined();
    expect(await loadSessionFromRedis("id-1")).toBeNull();
    await expect(deleteSessionFromRedis("id-1")).resolves.toBeUndefined();
    expect(await loadAllSessionsFromRedis()).toEqual([]);
    expect(await getChannelSessionId("webchat", "user-1")).toBeNull();
    await expect(setChannelSessionId("webchat", "user-1", "sess-1")).resolves.toBeUndefined();
    await expect(closeSessionRedis()).resolves.toBeUndefined();
  });
});
