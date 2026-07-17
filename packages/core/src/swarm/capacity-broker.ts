/**
 * Provider capacity broker (CAP-204).
 *
 * A weighted, cross-process semaphore per provider endpoint: work is ADMITTED
 * against a shared unit budget before it may occupy the provider, so adding
 * gateway/worker processes no longer multiplies the configured concurrency.
 * Permits carry a TTL and are pruned on every acquire — a crashed holder frees
 * its units within one TTL instead of leaking them forever.
 *
 * Slice 1 admits at DELEGATION granularity (one permit per running sub-agent,
 * default weight 1) — an honest first cut of "two processes honor one provider
 * cap"; per-LLM-call admission and priority/fairness queueing are later slices.
 * Staged rollout via `mission.capacity.mode`: "shadow" records would-block
 * admissions without blocking; "enforce" waits up to the admission timeout and
 * refuses when the endpoint stays saturated.
 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";

const log = childLogger("swarm:capacity");

const capacityKey = (endpoint: string) =>
  `starlingai:capacity:${createHash("sha256").update(endpoint).digest("hex").slice(0, 32)}`;

export interface CapacityPermit {
  id: string;
  endpoint: string;
  weight: number;
  backend: "redis" | "local";
}

export type AdmissionResult =
  | { admitted: true; permit: CapacityPermit; waitedMs: number }
  | { admitted: false; reason: "saturated" | "timeout"; waitedMs: number };

// ── Local fallback (single-process semantics) ───────────────────────────────

const _localHeld = new Map<string, Map<string, { weight: number; expiresAt: number }>>();

function localHeldUnits(endpoint: string, now: number): number {
  const held = _localHeld.get(endpoint);
  if (!held) return 0;
  let total = 0;
  for (const [id, permit] of held) {
    if (permit.expiresAt <= now) held.delete(id);
    else total += permit.weight;
  }
  return total;
}

// ── Redis backend ────────────────────────────────────────────────────────────

let _redis: any = null;
let _redisReady = false;
let _redisConnecting: Promise<unknown | null> | null = null;

async function getRedis(): Promise<unknown | null> {
  if (_redisReady) return _redis;
  if (_redisConnecting) return _redisConnecting;
  const url = process.env["REDIS_URL"];
  if (!url) return null;
  _redisConnecting = (async () => {
    try {
      const ioredis = await import("ioredis") as any;
      const IORedis = ioredis.default ?? ioredis;
      _redis = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
      await (_redis as { connect: () => Promise<void> }).connect();
      _redisReady = true;
      return _redis;
    } catch (error) {
      log.warn({ error }, "Capacity broker Redis connection failed — using in-process admission");
      try { (_redis as { disconnect?: () => void } | null)?.disconnect?.(); } catch { /* ignore */ }
      _redis = null;
      return null;
    } finally {
      _redisConnecting = null;
    }
  })();
  return _redisConnecting;
}

// Prune expired permits, then admit iff held + weight <= capacity.
// KEYS[1]=hash; ARGV: now, capacity, weight, permitId, expiresAt, keyTtlMs.
const ACQUIRE_LUA = `
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local weight = tonumber(ARGV[3])
local held = 0
local entries = redis.call('hgetall', KEYS[1])
for i = 1, #entries, 2 do
  local parts = {}
  for part in string.gmatch(entries[i+1], '[^:]+') do parts[#parts+1] = part end
  local w = tonumber(parts[1]) or 0
  local exp = tonumber(parts[2]) or 0
  if exp <= now then redis.call('hdel', KEYS[1], entries[i])
  else held = held + w end
end
if held + weight > capacity then return {0, held} end
redis.call('hset', KEYS[1], ARGV[4], ARGV[3] .. ':' .. ARGV[5])
redis.call('pexpire', KEYS[1], ARGV[6])
return {1, held + weight}
`;

async function tryAcquireOnce(endpoint: string, weight: number, capacity: number, permitTtlMs: number): Promise<CapacityPermit | null> {
  const now = Date.now();
  const redis = await getRedis();
  if (redis) {
    try {
      const id = randomUUID();
      const result = await (redis as { eval: (...args: unknown[]) => Promise<unknown> }).eval(
        ACQUIRE_LUA, 1, capacityKey(endpoint),
        String(now), String(capacity), String(weight), id, String(now + permitTtlMs), String(Math.max(permitTtlMs * 4, 600_000)),
      );
      const ok = Array.isArray(result) ? Number(result[0]) : 0;
      if (ok === 1) return { id, endpoint, weight, backend: "redis" };
      return null;
    } catch (error) {
      log.warn({ error, endpoint }, "Capacity acquire failed on Redis — using in-process admission");
    }
  }
  const held = localHeldUnits(endpoint, now);
  if (held + weight > capacity) return null;
  const id = randomUUID();
  const map = _localHeld.get(endpoint) ?? new Map();
  map.set(id, { weight, expiresAt: now + permitTtlMs });
  _localHeld.set(endpoint, map);
  return { id, endpoint, weight, backend: "local" };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Admit one unit of work against the endpoint's shared capacity. Waits up to
 * `timeoutMs` (poll-based; fairness/priority queueing is a later slice), then
 * reports saturation. `weight`/`capacity`/TTL default from `mission.capacity`.
 */
export async function admitToProvider(
  endpoint: string,
  opts: { weight?: number; timeoutMs?: number } = {},
): Promise<AdmissionResult> {
  const cfg = getConfig().mission.capacity;
  const weight = Math.max(1, opts.weight ?? 1);
  const capacity = Math.max(1, cfg.endpointUnits);
  const timeoutMs = Math.max(0, opts.timeoutMs ?? cfg.acquireTimeoutMs);
  const started = Date.now();
  for (;;) {
    const permit = await tryAcquireOnce(endpoint, weight, capacity, cfg.permitTtlMs);
    if (permit) return { admitted: true, permit, waitedMs: Date.now() - started };
    const waitedMs = Date.now() - started;
    if (waitedMs + 250 > timeoutMs) {
      // A zero wait budget is a single probe — its refusal is saturation, not a timeout
      // (measured wall time over Redis is never 0, so derive from the BUDGET).
      return { admitted: false, reason: timeoutMs === 0 ? "saturated" : "timeout", waitedMs };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}

/** Release a permit (idempotent; a lost release self-heals via the permit TTL). */
export async function releaseProviderPermit(permit: CapacityPermit): Promise<void> {
  if (permit.backend === "redis") {
    const redis = await getRedis();
    if (!redis) return;
    try {
      await (redis as { hdel: (k: string, f: string) => Promise<number> }).hdel(capacityKey(permit.endpoint), permit.id);
    } catch (error) {
      log.warn({ error, endpoint: permit.endpoint }, "Capacity release failed — permit expires via TTL");
    }
    return;
  }
  _localHeld.get(permit.endpoint)?.delete(permit.id);
}

// Atomic renewal: refuse when the field is gone OR logically expired (never
// resurrect a pruned/expired permit — that would over-admit), then extend the
// permit AND the hash key's own TTL. The key-TTL refresh here is load-bearing:
// without it a long-running fleet of healthy holders lets the WHOLE key expire
// (acquire only bumps it on admission), silently freeing all held capacity.
// KEYS[1]=hash; ARGV: permitId, now, newValue, keyTtlMs.
const RENEW_LUA = `
local v = redis.call('hget', KEYS[1], ARGV[1])
if v == false then return 0 end
local sep = string.find(v, ':')
local exp = tonumber(string.sub(v, sep + 1)) or 0
if exp <= tonumber(ARGV[2]) then return 0 end
redis.call('hset', KEYS[1], ARGV[1], ARGV[3])
redis.call('pexpire', KEYS[1], ARGV[4])
return 1
`;

/** Extend a long-running holder's permit (mirrors the lease heartbeat pattern). */
export async function renewProviderPermit(permit: CapacityPermit): Promise<boolean> {
  const cfg = getConfig().mission.capacity;
  const now = Date.now();
  if (permit.backend === "redis") {
    const redis = await getRedis();
    if (!redis) return false;
    try {
      const renewed = await (redis as { eval: (...args: unknown[]) => Promise<unknown> }).eval(
        RENEW_LUA, 1, capacityKey(permit.endpoint),
        permit.id, String(now), `${permit.weight}:${now + cfg.permitTtlMs}`, String(Math.max(cfg.permitTtlMs * 4, 600_000)),
      );
      return Number(renewed) === 1;
    } catch {
      return false;
    }
  }
  const held = _localHeld.get(permit.endpoint)?.get(permit.id);
  if (!held || held.expiresAt <= now) return false;
  held.expiresAt = now + cfg.permitTtlMs;
  return true;
}

export interface EndpointCapacitySnapshot {
  endpoint: string;
  capacity: number;
  heldUnits: number;
}

export async function getEndpointCapacitySnapshot(endpoint: string): Promise<EndpointCapacitySnapshot> {
  const cfg = getConfig().mission.capacity;
  const now = Date.now();
  const redis = await getRedis();
  if (redis) {
    try {
      const entries = await (redis as { hgetall: (k: string) => Promise<Record<string, string>> }).hgetall(capacityKey(endpoint));
      let held = 0;
      for (const value of Object.values(entries ?? {})) {
        const [weight, expiresAt] = value.split(":");
        if (Number(expiresAt) > now) held += Number(weight) || 0;
      }
      return { endpoint, capacity: cfg.endpointUnits, heldUnits: held };
    } catch { /* fall through to local view */ }
  }
  return { endpoint, capacity: cfg.endpointUnits, heldUnits: localHeldUnits(endpoint, now) };
}

/** Reset all state — for use in tests only. */
export async function resetCapacityBrokerForTests(): Promise<void> {
  _localHeld.clear();
  if (_redis) {
    try { await (_redis as { quit: () => Promise<void> }).quit(); } catch { /* ignore */ }
  }
  _redis = null;
  _redisReady = false;
  _redisConnecting = null;
}
