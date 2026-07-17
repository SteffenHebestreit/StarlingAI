/**
 * Mission budget envelope (BUD-203, ADR-004 dimensions per the dev plan).
 *
 * One atomic ledger per mission: children RESERVE an estimated slice before
 * dispatch, RECONCILE to actual usage while/after running, and RELEASE on
 * abandoned paths — so the whole swarm debits one envelope instead of every
 * nested delegation receiving a fresh local allowance. Enforcement is staged
 * (`mission.budget.mode`): "shadow" records would-be refusals without blocking;
 * "enforce" refuses dispatch when the envelope cannot fit a child's reserve.
 *
 * Backends: Redis Lua (atomic check-and-reserve across processes; the plan's
 * "Redis: budget atomics") with a process-local fallback of identical semantics.
 * Dimensions: total tokens (prompt+completion), tool calls, active compute ms.
 * 0 = unlimited for any limit.
 */
import { randomUUID } from "node:crypto";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";

const log = childLogger("swarm:mission-budget");

const BUDGET_TTL_S = 4 * 60 * 60;
const budgetKey = (missionId: string) => `starlingai:budget:${missionId}`;

export interface BudgetDimensions {
  tokens: number;
  toolCalls: number;
  activeTimeMs: number;
}

export interface BudgetReservation {
  id: string;
  missionId: string;
  reserved: BudgetDimensions;
  backend: "redis" | "local";
}

export type ReserveResult =
  | { granted: true; reservation: BudgetReservation }
  | { granted: false; reason: string; exceeded: Array<keyof BudgetDimensions> };

export interface MissionBudgetSnapshot {
  missionId: string;
  limits: BudgetDimensions;
  spent: BudgetDimensions;
  reserved: BudgetDimensions;
}

function limitsFromConfig(): BudgetDimensions {
  const cfg = getConfig().mission.budget;
  return { tokens: cfg.maxTotalTokens, toolCalls: cfg.maxToolCalls, activeTimeMs: cfg.maxActiveTimeMs };
}

export function defaultChildReserve(): BudgetDimensions {
  const cfg = getConfig().mission.budget;
  return { tokens: cfg.childReserveTokens, toolCalls: cfg.childReserveToolCalls, activeTimeMs: cfg.childReserveActiveTimeMs };
}

// ── Local ledger (single-process fallback; identical semantics) ─────────────

interface LocalLedger { spent: BudgetDimensions; reserved: BudgetDimensions; lastTouchedAt: number; }
const _local = new Map<string, LocalLedger>();
const _localReservations = new Map<string, BudgetDimensions>();

function localLedger(missionId: string): LocalLedger {
  // Lazy TTL sweep — the local fallback must not grow unboundedly (Redis has
  // a real TTL; this mirrors it).
  const cutoff = Date.now() - BUDGET_TTL_S * 1_000;
  for (const [id, ledger] of _local) {
    if (ledger.lastTouchedAt < cutoff) _local.delete(id);
  }
  let ledger = _local.get(missionId);
  if (!ledger) {
    ledger = { spent: { tokens: 0, toolCalls: 0, activeTimeMs: 0 }, reserved: { tokens: 0, toolCalls: 0, activeTimeMs: 0 }, lastTouchedAt: Date.now() };
    _local.set(missionId, ledger);
  }
  ledger.lastTouchedAt = Date.now();
  return ledger;
}

function exceededDimensions(limits: BudgetDimensions, spent: BudgetDimensions, reserved: BudgetDimensions, estimate: BudgetDimensions): Array<keyof BudgetDimensions> {
  const out: Array<keyof BudgetDimensions> = [];
  for (const dim of ["tokens", "toolCalls", "activeTimeMs"] as const) {
    if (limits[dim] > 0 && spent[dim] + reserved[dim] + estimate[dim] > limits[dim]) out.push(dim);
  }
  return out;
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
      log.warn({ error }, "Mission budget Redis connection failed — using in-process ledger");
      try { (_redis as { disconnect?: () => void } | null)?.disconnect?.(); } catch { /* ignore */ }
      _redis = null;
      return null;
    } finally {
      _redisConnecting = null;
    }
  })();
  return _redisConnecting;
}

// Atomic check-and-reserve: every dimension must fit (limit 0 = unlimited),
// then all reservations apply together. KEYS[1]=hash; ARGV = limits(3), estimate(3).
const RESERVE_LUA = `
local sT = tonumber(redis.call('hget', KEYS[1], 'spent_tokens') or '0')
local sC = tonumber(redis.call('hget', KEYS[1], 'spent_calls') or '0')
local sM = tonumber(redis.call('hget', KEYS[1], 'spent_ms') or '0')
local rT = tonumber(redis.call('hget', KEYS[1], 'res_tokens') or '0')
local rC = tonumber(redis.call('hget', KEYS[1], 'res_calls') or '0')
local rM = tonumber(redis.call('hget', KEYS[1], 'res_ms') or '0')
local lT = tonumber(ARGV[1]); local lC = tonumber(ARGV[2]); local lM = tonumber(ARGV[3])
local eT = tonumber(ARGV[4]); local eC = tonumber(ARGV[5]); local eM = tonumber(ARGV[6])
local over = {}
if lT > 0 and sT + rT + eT > lT then over[#over+1] = 'tokens' end
if lC > 0 and sC + rC + eC > lC then over[#over+1] = 'toolCalls' end
if lM > 0 and sM + rM + eM > lM then over[#over+1] = 'activeTimeMs' end
if #over > 0 then return {0, table.concat(over, ',')} end
redis.call('hincrby', KEYS[1], 'res_tokens', eT)
redis.call('hincrby', KEYS[1], 'res_calls', eC)
redis.call('hincrby', KEYS[1], 'res_ms', eM)
redis.call('expire', KEYS[1], ARGV[7])
return {1, ''}
`;

// Reconcile: release the reservation and add actuals to spent (never negative).
const RECONCILE_LUA = `
local function dec(field, amount)
  local v = tonumber(redis.call('hget', KEYS[1], field) or '0') - amount
  if v < 0 then v = 0 end
  redis.call('hset', KEYS[1], field, v)
end
dec('res_tokens', tonumber(ARGV[1])); dec('res_calls', tonumber(ARGV[2])); dec('res_ms', tonumber(ARGV[3]))
redis.call('hincrby', KEYS[1], 'spent_tokens', tonumber(ARGV[4]))
redis.call('hincrby', KEYS[1], 'spent_calls', tonumber(ARGV[5]))
redis.call('hincrby', KEYS[1], 'spent_ms', tonumber(ARGV[6]))
redis.call('expire', KEYS[1], ARGV[7])
return 1
`;

// ── Public API ───────────────────────────────────────────────────────────────

/** Atomically reserve an estimated child slice against the mission envelope. */
export async function reserveMissionBudget(missionId: string, estimate: BudgetDimensions): Promise<ReserveResult> {
  const limits = limitsFromConfig();
  const redis = await getRedis();
  if (redis) {
    try {
      const result = await (redis as { eval: (...args: unknown[]) => Promise<unknown> }).eval(
        RESERVE_LUA, 1, budgetKey(missionId),
        String(limits.tokens), String(limits.toolCalls), String(limits.activeTimeMs),
        String(Math.max(0, Math.floor(estimate.tokens))), String(Math.max(0, Math.floor(estimate.toolCalls))), String(Math.max(0, Math.floor(estimate.activeTimeMs))),
        String(BUDGET_TTL_S),
      );
      const [ok, over] = Array.isArray(result) ? result : [0, ""];
      if (Number(ok) === 1) {
        return { granted: true, reservation: { id: randomUUID(), missionId, reserved: { ...estimate }, backend: "redis" } };
      }
      const exceeded = String(over).split(",").filter(Boolean) as Array<keyof BudgetDimensions>;
      return { granted: false, reason: `mission budget exhausted: ${String(over)}`, exceeded };
    } catch (error) {
      log.warn({ error, missionId }, "Budget reserve failed on Redis — using in-process ledger");
    }
  }

  const ledger = localLedger(missionId);
  const exceeded = exceededDimensions(limits, ledger.spent, ledger.reserved, estimate);
  if (exceeded.length > 0) return { granted: false, reason: `mission budget exhausted: ${exceeded.join(",")}`, exceeded };
  for (const dim of ["tokens", "toolCalls", "activeTimeMs"] as const) ledger.reserved[dim] += Math.max(0, estimate[dim]);
  const reservation: BudgetReservation = { id: randomUUID(), missionId, reserved: { ...estimate }, backend: "local" };
  _localReservations.set(reservation.id, { ...estimate });
  return { granted: true, reservation };
}

/** Replace the reservation with actual usage (terminal path of every child). */
export async function reconcileMissionBudget(reservation: BudgetReservation, actual: BudgetDimensions): Promise<void> {
  const safeActual = {
    tokens: Math.max(0, Math.floor(actual.tokens)),
    toolCalls: Math.max(0, Math.floor(actual.toolCalls)),
    activeTimeMs: Math.max(0, Math.floor(actual.activeTimeMs)),
  };
  if (reservation.backend === "redis") {
    const redis = await getRedis();
    if (redis) {
      try {
        await (redis as { eval: (...args: unknown[]) => Promise<unknown> }).eval(
          RECONCILE_LUA, 1, budgetKey(reservation.missionId),
          String(reservation.reserved.tokens), String(reservation.reserved.toolCalls), String(reservation.reserved.activeTimeMs),
          String(safeActual.tokens), String(safeActual.toolCalls), String(safeActual.activeTimeMs),
          String(BUDGET_TTL_S),
        );
        return;
      } catch (error) {
        log.warn({ error, missionId: reservation.missionId }, "Budget reconcile failed on Redis");
        return;
      }
    }
    return;
  }
  const ledger = localLedger(reservation.missionId);
  const held = _localReservations.get(reservation.id);
  if (!held) return; // already reconciled/released — idempotent
  _localReservations.delete(reservation.id);
  for (const dim of ["tokens", "toolCalls", "activeTimeMs"] as const) {
    ledger.reserved[dim] = Math.max(0, ledger.reserved[dim] - held[dim]);
    ledger.spent[dim] += safeActual[dim];
  }
}

/** Cancel a reservation without spending (abandoned dispatch paths). */
export async function releaseMissionBudget(reservation: BudgetReservation): Promise<void> {
  await reconcileMissionBudget(reservation, { tokens: 0, toolCalls: 0, activeTimeMs: 0 });
}

export async function getMissionBudgetSnapshot(missionId: string): Promise<MissionBudgetSnapshot> {
  const limits = limitsFromConfig();
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await (redis as { hgetall: (k: string) => Promise<Record<string, string>> }).hgetall(budgetKey(missionId));
      const n = (field: string): number => Number(raw?.[field] ?? 0) || 0;
      return {
        missionId,
        limits,
        spent: { tokens: n("spent_tokens"), toolCalls: n("spent_calls"), activeTimeMs: n("spent_ms") },
        reserved: { tokens: n("res_tokens"), toolCalls: n("res_calls"), activeTimeMs: n("res_ms") },
      };
    } catch (error) {
      log.warn({ error, missionId }, "Budget snapshot failed on Redis");
    }
  }
  // Read-only view: an unknown mission must not create a ledger entry.
  const ledger = _local.get(missionId);
  const zero: BudgetDimensions = { tokens: 0, toolCalls: 0, activeTimeMs: 0 };
  return {
    missionId,
    limits,
    spent: ledger ? { ...ledger.spent } : { ...zero },
    reserved: ledger ? { ...ledger.reserved } : { ...zero },
  };
}

/** Reset all state — for use in tests only. */
export async function resetMissionBudgetForTests(): Promise<void> {
  _local.clear();
  _localReservations.clear();
  if (_redis) {
    try { await (_redis as { quit: () => Promise<void> }).quit(); } catch { /* ignore */ }
  }
  _redis = null;
  _redisReady = false;
  _redisConnecting = null;
}
