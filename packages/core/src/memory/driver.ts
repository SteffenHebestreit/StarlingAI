/**
 * Sleep-time memory consolidation driver — the "idle reflection" half of durable
 * memory, inspired by Letta's sleep-time compute. A periodic, deterministic
 * background sweep that keeps long-term memory healthy without a user in the
 * loop:
 *
 *   - compacts near-duplicate records in the workspace + user scopes (merging
 *     tags, keeping the strongest copy),
 *   - backfills embeddings for records that have none (e.g. written while the
 *     embedding provider was offline) so they become semantically retrievable.
 *
 * Everything here is additive and reversible-in-spirit: compaction merges
 * duplicates (it never drops unique facts) and embedding backfill only adds
 * vectors. Superseded facts are handled at write time (see service.ts), not
 * here. Gated by `memory.sleepTimeConsolidation`.
 */
import { getConfig } from "../config/loader.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import {
  compactWorkspaceMemoryRecords,
  compactUserMemoryRecords,
  refreshMissingDurableEmbeddings,
  userMemoryBaseDir,
} from "./service.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { listUserScopeSegments } from "../runtime/user-scope.js";

const log = childLogger("memory:driver");

let _driverInterval: ReturnType<typeof setInterval> | null = null;
let _sweepInFlight = false;

export interface MemorySweepResult {
  merged: number;
  removed: number;
  embeddingsRefreshed: number;
}

export function startMemoryConsolidationDriver(): void {
  if (_driverInterval) return;
  const cfg = getConfig().memory;
  if (!cfg.sleepTimeConsolidation) return;
  _driverInterval = setInterval(() => {
    void runMemoryConsolidationSweep(getConfig().workspacePath).catch((err) => {
      log.warn({ err }, "Memory consolidation sweep failed");
    });
  }, cfg.consolidationIntervalMs);
  _driverInterval.unref();
  log.info({ intervalMs: cfg.consolidationIntervalMs }, "Sleep-time memory consolidation driver started");
}

export function stopMemoryConsolidationDriver(): void {
  if (_driverInterval) {
    clearInterval(_driverInterval);
    _driverInterval = null;
  }
}

/** Run one idle consolidation sweep. Safe to call directly (and in tests). */
export async function runMemoryConsolidationSweep(workspacePath: string): Promise<MemorySweepResult> {
  const result: MemorySweepResult = { merged: 0, removed: 0, embeddingsRefreshed: 0 };
  if (getConfig().memory.sleepTimeConsolidation === false) return result;
  if (_sweepInFlight) return result; // never overlap sweeps
  _sweepInFlight = true;
  try {
    // 1. Compact near-duplicates (merges tags, keeps the strongest copy).
    // Workspace scope has no per-user dimension.
    try {
      const r = compactWorkspaceMemoryRecords(workspacePath, {});
      result.merged += r.merged;
      result.removed += r.removed;
    } catch (err) {
      log.debug({ err }, "Workspace compaction step skipped — non-critical");
    }
    // User scope is partitioned per authenticated user — sweep the shared/base
    // bucket AND each per-user bucket (each in that user's request context so the
    // store resolves to their directory). Per-user buckets also self-maintain via
    // inline compaction on write; this is the idle backstop.
    for (const userId of [undefined, ...listUserScopeSegments(userMemoryBaseDir())]) {
      try {
        const r = runWithRequestContext({ userId }, () => compactUserMemoryRecords(workspacePath, {}));
        result.merged += r.merged;
        result.removed += r.removed;
      } catch (err) {
        log.debug({ err, userId }, "User compaction step skipped — non-critical");
      }
    }
    // 2. Backfill embeddings for records that have none (no-op without a provider).
    try {
      const refreshed = await refreshMissingDurableEmbeddings(workspacePath);
      result.embeddingsRefreshed = refreshed.reduce((sum, r) => sum + r.refreshed, 0);
    } catch (err) {
      log.debug({ err }, "Embedding backfill skipped — non-critical");
    }

    if (result.merged > 0 || result.removed > 0 || result.embeddingsRefreshed > 0) {
      logAudit("memory_consolidation_sweep", {
        merged: result.merged,
        removed: result.removed,
        embeddingsRefreshed: result.embeddingsRefreshed,
      }, { severity: "info" });
      log.info(result, "Sleep-time memory consolidation sweep complete");
    }
  } finally {
    _sweepInFlight = false;
  }
  return result;
}
