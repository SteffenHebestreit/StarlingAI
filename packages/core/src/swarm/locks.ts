/**
 * Renewable, fenced task leases.
 *
 * A lease is scoped to the execution context rather than a short task id. Redis
 * ownership is atomic and monotonic fencing tokens let callers reject stale work
 * after expiry/takeover. The local adapter is intentionally available only in
 * explicit single-process mode.
 */
import { createHash, randomUUID } from "node:crypto";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";

const log = childLogger("swarm:locks");
const LEASE_PREFIX = "starlingai:lease:task:";
const DEFAULT_LEASE_TTL_MS = 30_000;

export interface TaskLeaseScope {
  sessionId: string;
  taskId: string;
  taskSignature?: string;
  workspacePath?: string;
  userId?: string;
  tenantId?: string;
}

export interface TaskLease {
  key: string;
  scope: TaskLeaseScope;
  owner: string;
  fencingToken: number;
  ttlMs: number;
  expiresAt: number;
  backend: "redis" | "local";
}

export interface TaskLeaseHeartbeat {
  readonly lost: boolean;
  stop: () => Promise<void>;
}

/**
 * Discriminated acquisition outcome. `contended` means another owner verifiably
 * holds the lease; `unavailable` means the clustered coordination backend could
 * not answer — callers MUST NOT treat it as contention (a task nobody owns would
 * otherwise be reported as claimed and silently lost).
 */
export type TaskLeaseAcquisition =
  | { status: "acquired"; lease: TaskLease }
  | { status: "contended" }
  | { status: "unavailable"; reason: string };

/** Renewal outcome: `lost` is definitive (backend answered, we are not the owner);
 *  `unavailable` is transient (backend unreachable — ownership unknown). */
export type TaskLeaseRenewal = "renewed" | "lost" | "unavailable";

type LocalLease = { value: string; fencingToken: number; expiresAt: number };
const localLeases = new Map<string, LocalLease>();
const localFences = new Map<string, number>();
const legacyLeases = new Map<string, TaskLease>();

setInterval(() => {
  const now = Date.now();
  for (const [key, lease] of localLeases) {
    if (lease.expiresAt <= now) localLeases.delete(key);
  }
}, 30_000).unref();

let redisClient: any = null;
let redisConnected = false;

function normalizedScope(scope: TaskLeaseScope): Record<string, string> {
  // taskId is deliberately NOT part of the key: positional ids (task_1) differ
  // between contending workers planning the same work. The structural signature
  // (title/task/deps digest) identifies equivalent work; it falls back to the
  // taskId only when no signature exists (e.g. legacy callers).
  return {
    tenantId: scope.tenantId?.trim() || "default",
    userId: scope.userId?.trim() || "anonymous",
    workspacePath: scope.workspacePath?.trim() || "default",
    sessionId: scope.sessionId.trim(),
    taskSignature: scope.taskSignature?.trim() || scope.taskId.trim(),
  };
}

/** Stable, opaque key that prevents collisions across users, workspaces, sessions, and task signatures. */
export function taskLeaseKey(scope: TaskLeaseScope): string {
  const serialized = Object.entries(normalizedScope(scope))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  return `${LEASE_PREFIX}${createHash("sha256").update(serialized).digest("hex")}`;
}

function leaseValue(lease: Pick<TaskLease, "owner" | "fencingToken">): string {
  return `${lease.owner}:${lease.fencingToken}`;
}

function allowsLocalFallback(): boolean {
  try {
    return getConfig().deployment.mode === "single_process";
  } catch (error) {
    // Fail closed: without a readable deployment mode we must not assume the
    // unsafe process-local adapter is permitted.
    log.warn({ error }, "Deployment mode unavailable — refusing local task-lease fallback");
    return false;
  }
}

let redisConnecting: Promise<unknown | null> | null = null;

async function getRedis(): Promise<unknown | null> {
  if (redisConnected) return redisClient;
  // Share one in-flight connect so concurrent acquires racing the initial
  // connection wait for it instead of being misreported as unavailable.
  if (redisConnecting) return redisConnecting;
  const url = process.env["REDIS_URL"];
  if (!url) return null;

  redisConnecting = (async () => {
    try {
      const ioredis = await import("ioredis") as any;
      const IORedis = ioredis.default ?? ioredis;
      redisClient = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
      await (redisClient as { connect: () => Promise<void> }).connect();
      redisConnected = true;
      return redisClient;
    } catch (error) {
      log.warn({ error }, "Task lease Redis connection failed");
      try { (redisClient as { disconnect?: () => void } | null)?.disconnect?.(); } catch { /* ignore */ }
      redisClient = null;
      return null;
    } finally {
      redisConnecting = null;
    }
  })();
  return redisConnecting;
}

function parseFence(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Fence counters outlive leases but must not leak forever: refresh a long TTL on
 *  every acquire. Monotonicity within any live contention window is preserved
 *  because the counter only resets after 24h of total quiescence on that key,
 *  and lease values additionally embed a per-acquisition random owner UUID. */
const FENCE_TTL_MS = 24 * 60 * 60 * 1_000;

/** Acquire an exclusive lease, distinguishing real contention from backend loss. */
export async function tryAcquireTaskLease(scope: TaskLeaseScope, ttlMs = DEFAULT_LEASE_TTL_MS): Promise<TaskLeaseAcquisition> {
  const key = taskLeaseKey(scope);
  const ttl = Math.max(1_000, Math.floor(ttlMs));
  const owner = randomUUID();
  const redis = await getRedis();

  if (redis) {
    try {
      const result = await (redis as { eval: (...args: unknown[]) => Promise<unknown> }).eval(
        "if redis.call('exists', KEYS[1]) == 1 then return {0, 0} end "
          + "local token = redis.call('incr', KEYS[2]) "
          + "redis.call('pexpire', KEYS[2], ARGV[3]) "
          + "local value = ARGV[1] .. ':' .. token "
          + "redis.call('psetex', KEYS[1], ARGV[2], value) "
          + "return {1, token}",
        2,
        key,
        `${key}:fence`,
        owner,
        String(ttl),
        String(FENCE_TTL_MS),
      );
      const values = Array.isArray(result) ? result : [];
      if (Number(values[0]) !== 1) return { status: "contended" };
      const fencingToken = parseFence(values[1]);
      if (fencingToken === null) throw new Error("Redis returned an invalid fencing token");
      const lease: TaskLease = { key, scope, owner, fencingToken, ttlMs: ttl, expiresAt: Date.now() + ttl, backend: "redis" };
      log.debug({ key, fencingToken }, "Task lease acquired (Redis)");
      return { status: "acquired", lease };
    } catch (error) {
      log.warn({ error, key }, "Task lease Redis acquisition failed");
      if (!allowsLocalFallback()) {
        return { status: "unavailable", reason: "Redis lease backend error in clustered mode; refusing process-local fallback." };
      }
    }
  } else if (!allowsLocalFallback()) {
    return { status: "unavailable", reason: "Redis lease backend is not connected in clustered mode; refusing process-local fallback." };
  }

  const now = Date.now();
  const existing = localLeases.get(key);
  if (existing && existing.expiresAt > now) return { status: "contended" };
  const fencingToken = (localFences.get(key) ?? 0) + 1;
  const lease: TaskLease = { key, scope, owner, fencingToken, ttlMs: ttl, expiresAt: now + ttl, backend: "local" };
  localFences.set(key, fencingToken);
  localLeases.set(key, { value: leaseValue(lease), fencingToken, expiresAt: lease.expiresAt });
  log.debug({ key, fencingToken }, "Task lease acquired (local)");
  return { status: "acquired", lease };
}

/** Back-compat acquire: null on BOTH contention and backend loss. Prefer
 *  {@link tryAcquireTaskLease}, which callers need to avoid misreporting an
 *  unavailable backend as a claimed task. */
export async function acquireTaskLease(scope: TaskLeaseScope, ttlMs = DEFAULT_LEASE_TTL_MS): Promise<TaskLease | null> {
  const acquisition = await tryAcquireTaskLease(scope, ttlMs);
  return acquisition.status === "acquired" ? acquisition.lease : null;
}

/** Renew only when this lease is still the current owner, reporting whether a
 *  failure is definitive (`lost`) or a transient backend problem (`unavailable`). */
export async function renewTaskLeaseState(lease: TaskLease, ttlMs = lease.ttlMs): Promise<TaskLeaseRenewal> {
  const ttl = Math.max(1_000, Math.floor(ttlMs));
  const value = leaseValue(lease);
  if (lease.backend === "redis") {
    const redis = await getRedis();
    if (!redis) return "unavailable";
    try {
      const renewed = await (redis as { eval: (...args: unknown[]) => Promise<unknown> }).eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
        1,
        lease.key,
        value,
        String(ttl),
      );
      // Redis answered: 0 is a definitive ownership loss (expired or superseded).
      if (Number(renewed) !== 1) return "lost";
      lease.ttlMs = ttl;
      lease.expiresAt = Date.now() + ttl;
      return "renewed";
    } catch (error) {
      log.warn({ error, key: lease.key }, "Task lease Redis renewal failed");
      return "unavailable";
    }
  }

  // The local map is authoritative in single-process mode: a mismatch is definitive.
  const current = localLeases.get(lease.key);
  if (!current || current.expiresAt <= Date.now() || current.value !== value) return "lost";
  current.expiresAt = Date.now() + ttl;
  lease.ttlMs = ttl;
  lease.expiresAt = current.expiresAt;
  return "renewed";
}

/** Boolean renew for callers that only need success/failure. */
export async function renewTaskLease(lease: TaskLease, ttlMs = lease.ttlMs): Promise<boolean> {
  return await renewTaskLeaseState(lease, ttlMs) === "renewed";
}

/** True only while this exact fence is still current. Call before publishing terminal work. */
export async function isTaskLeaseCurrent(lease: TaskLease): Promise<boolean> {
  const value = leaseValue(lease);
  if (lease.backend === "redis") {
    const redis = await getRedis();
    if (!redis) return false;
    try {
      return await (redis as { get: (key: string) => Promise<string | null> }).get(lease.key) === value;
    } catch {
      return false;
    }
  }
  const current = localLeases.get(lease.key);
  return Boolean(current && current.expiresAt > Date.now() && current.value === value);
}

/** Release only the exact fenced owner. Safe after expiry or takeover. */
export async function releaseTaskLease(lease: TaskLease): Promise<void> {
  const value = leaseValue(lease);
  if (lease.backend === "redis") {
    const redis = await getRedis();
    if (!redis) return;
    try {
      await (redis as { eval: (...args: unknown[]) => Promise<unknown> }).eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        lease.key,
        value,
      );
    } catch (error) {
      log.warn({ error, key: lease.key }, "Task lease Redis release failed");
    }
    return;
  }
  const current = localLeases.get(lease.key);
  if (current?.value === value) localLeases.delete(lease.key);
}

/** Renew at a bounded cadence and expose a sticky lost signal to the task owner.
 *  `lost` latches only on a DEFINITIVE ownership loss — a transient backend
 *  outage keeps ticking, because discarding finished work on a blip is worse
 *  than one extra ownership check before the terminal publish. */
export function startTaskLeaseHeartbeat(
  lease: TaskLease,
  opts: { ttlMs?: number; intervalMs?: number } = {},
): TaskLeaseHeartbeat {
  const ttlMs = Math.max(1_000, Math.floor(opts.ttlMs ?? lease.ttlMs));
  const intervalMs = Math.max(250, Math.min(Math.floor(opts.intervalMs ?? ttlMs / 3), Math.floor(ttlMs / 2)));
  let stopped = false;
  let lost = false;
  let renewal: Promise<void> | undefined;

  const tick = (): void => {
    if (stopped || lost || renewal) return;
    renewal = renewTaskLeaseState(lease, ttlMs)
      .then((state) => { if (state === "lost") lost = true; })
      .catch(() => { /* treated as transient — the pre-publish isTaskLeaseCurrent check decides */ })
      .finally(() => { renewal = undefined; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  return {
    get lost() { return lost; },
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      if (renewal) await renewal;
    },
  };
}

// ── Durable task results (DST-103 result following) ─────────────────────────

/** How long a winner's result stays readable by contenders (matches session TTL). */
const LEASE_RESULT_TTL_S = 4 * 60 * 60;
const leaseResultKey = (key: string) => `${key}:result`;

export interface TaskLeaseResult {
  status: "completed" | "partial";
  output: string;
  agentName: string;
  fencingToken: number;
  finishedAt: string;
  truncated?: boolean;
}

const localLeaseResults = new Map<string, { value: TaskLeaseResult; expiresAt: number }>();

/**
 * Durably publish the owning attempt's terminal result — atomically guarded by
 * the lease: only the CURRENT fencing owner can write (the plan's "a completion
 * is accepted only from the current fencing token" invariant). Returns false
 * when the caller's lease is stale or the backend refused; the caller must then
 * treat its work as non-authoritative.
 */
export async function publishTaskLeaseResult(lease: TaskLease, result: Omit<TaskLeaseResult, "fencingToken">): Promise<boolean> {
  const payload: TaskLeaseResult = { ...result, fencingToken: lease.fencingToken };
  const value = leaseValue(lease);
  if (lease.backend === "redis") {
    const redis = await getRedis();
    if (!redis) return false;
    try {
      const written = await (redis as { eval: (...args: unknown[]) => Promise<unknown> }).eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then "
          + "redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[3]) return 1 "
          + "else return 0 end",
        2,
        lease.key,
        leaseResultKey(lease.key),
        value,
        JSON.stringify(payload),
        String(LEASE_RESULT_TTL_S),
      );
      return Number(written) === 1;
    } catch (error) {
      log.warn({ error, key: lease.key }, "Task result publish failed");
      return false;
    }
  }
  const current = localLeases.get(lease.key);
  if (!current || current.expiresAt <= Date.now() || current.value !== value) return false;
  localLeaseResults.set(lease.key, { value: payload, expiresAt: Date.now() + LEASE_RESULT_TTL_S * 1_000 });
  return true;
}

/** Read the durable result for a task scope, if any owner has published one. */
export async function readTaskLeaseResult(scope: TaskLeaseScope): Promise<TaskLeaseResult | null> {
  const key = taskLeaseKey(scope);
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await (redis as { get: (k: string) => Promise<string | null> }).get(leaseResultKey(key));
      if (raw) {
        try { return JSON.parse(raw) as TaskLeaseResult; } catch { return null; }
      }
      return null;
    } catch (error) {
      log.warn({ error, key }, "Task result read failed");
      return null;
    }
  }
  const local = localLeaseResults.get(key);
  if (!local || local.expiresAt <= Date.now()) return null;
  return local.value;
}

/** Bounded wait for a winner's result (contender-side of DST-103). */
export async function waitForTaskLeaseResult(
  scope: TaskLeaseScope,
  opts: { timeoutMs: number; pollMs?: number },
): Promise<TaskLeaseResult | null> {
  const pollMs = Math.max(100, opts.pollMs ?? 500);
  const deadline = Date.now() + Math.max(0, opts.timeoutMs);
  for (;;) {
    const result = await readTaskLeaseResult(scope);
    if (result) return result;
    if (Date.now() + pollMs > deadline) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

// Backward-compatible wrappers while callers migrate to the scoped lease API.
export async function acquireTaskLock(taskId: string, ttlMs = DEFAULT_LEASE_TTL_MS): Promise<string | null> {
  const lease = await acquireTaskLease({ sessionId: "legacy", taskId }, ttlMs);
  if (!lease) return null;
  legacyLeases.set(`${taskId}:${lease.owner}`, lease);
  return lease.owner;
}

export async function releaseTaskLock(taskId: string, owner: string): Promise<void> {
  const key = `${taskId}:${owner}`;
  const lease = legacyLeases.get(key);
  if (!lease) return;
  legacyLeases.delete(key);
  await releaseTaskLease(lease);
}

/** Reset all state — for use in tests only. */
export async function resetLocksForTests(): Promise<void> {
  localLeases.clear();
  localFences.clear();
  legacyLeases.clear();
  localLeaseResults.clear();
  if (redisClient) {
    try { await (redisClient as { quit: () => Promise<void> }).quit(); } catch { /* ignore */ }
  }
  redisClient = null;
  redisConnected = false;
  redisConnecting = null;
}