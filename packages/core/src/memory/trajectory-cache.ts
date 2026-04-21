/**
 * G33: Trajectory cache — lightweight per-workspace NDJSON store that records
 * completed turn trajectories (shared findings + final answer) so that
 * semantically similar follow-up queries can be seeded with recent evidence
 * instead of re-running all delegation from scratch.
 *
 * Security:
 * - File stored under `.starlingai/trajectory_cache.ndjson` inside the workspace only.
 *   Never written to a user-global location.
 * - Entries containing credential-shaped tokens are stripped before persistence.
 * - TTL enforced on read: stale entries are never returned.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isEmbeddingAvailable, computeQueryEmbedding, cosineSimilarity } from "../providers/embeddings.js";
import { appendJsonLine, readLastRecords } from "./bounded-ndjson-store.js";

// ── Constants ──────────────────────────────────────────────────────────────

const CACHE_FILE = ".starlingai/trajectory_cache.ndjson";
const MAX_CACHE_LINES = 5_000;
const SIMILARITY_THRESHOLD = 0.86;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;          // 24 h
const FRESH_TTL_SECONDS = 30 * 60;                  // 30 min for freshness-sensitive

// Naïve credential-pattern detector — if a string matches any of these patterns
// we refuse to persist it.
const CREDENTIAL_RE = /(?:password|secret|token|api[_-]?key|bearer|authorization)\s*[:=]\s*\S+/i;

// ── Types ──────────────────────────────────────────────────────────────────

export interface TrajectoryEntry {
  /** ISO timestamp of when the turn finished */
  finishedAt: string;
  /** Channel the turn ran in (used for scoping; empty = global) */
  channel: string;
  /** TTL in seconds from `finishedAt` */
  ttlSeconds: number;
  /** Original user query, lowercased+trimmed */
  normalizedQuery: string;
  /** Embedding vector of the query (stored as plain number[]) */
  queryEmbedding: number[];
  /** Evidence gathered via share_finding during the turn */
  sharedFindings: string[];
  /** Final synthesised answer text */
  finalAnswer: string;
}

// ── Write ──────────────────────────────────────────────────────────────────

/**
 * Persist a trajectory entry for a completed turn.
 * No-ops if the entry is credential-shaped or embeddings are unavailable.
 */
export async function writeTrajectory(
  entry: Omit<TrajectoryEntry, "queryEmbedding" | "finishedAt" | "ttlSeconds">,
  workspacePath: string,
  freshnessSensitive = false,
): Promise<void> {
  if (!isEmbeddingAvailable()) return;

  // Security: refuse to persist if credential patterns are found anywhere
  const raw = JSON.stringify(entry);
  if (CREDENTIAL_RE.test(raw)) return;

  try {
    const embedding = await computeQueryEmbedding(entry.normalizedQuery);
    if (!embedding) return;

    const record: TrajectoryEntry = {
      finishedAt: new Date().toISOString(),
      channel: entry.channel,
      ttlSeconds: freshnessSensitive ? FRESH_TTL_SECONDS : DEFAULT_TTL_SECONDS,
      normalizedQuery: entry.normalizedQuery,
      queryEmbedding: Array.from(embedding),
      sharedFindings: entry.sharedFindings,
      finalAnswer: entry.finalAnswer,
    };

    const filePath = resolve(workspacePath, CACHE_FILE);
    appendJsonLine(filePath, record, { maxLines: MAX_CACHE_LINES });
  } catch {
    // Best-effort — trajectory cache write is never critical
  }
}

// ── Invalidation ───────────────────────────────────────────────────────────
// In-memory blocklist of trajectory entries that produced a bad turn outcome
// (apology, blocked, or empty answer) when injected. Keyed by a stable
// identity built from `${normalizedQuery}::${finishedAt}` so the same entry
// is skipped on subsequent lookups in the current process. Bounded to keep
// memory predictable; the file itself is the source of truth across restarts.

const INVALIDATION_MAX_ENTRIES = 256;
const _invalidatedKeys = new Map<string, number>(); // key -> insertion order

function trajectoryIdentity(entry: Pick<TrajectoryEntry, "normalizedQuery" | "finishedAt">): string {
  return `${entry.normalizedQuery}::${entry.finishedAt}`;
}

/**
 * Mark a previously-returned trajectory entry as bad so future lookups skip
 * it. Wired from `runtime.ts` when a turn that received an injected cache
 * ends in apology/empty-answer/blocked — the entry is then almost certainly
 * stale or wrong, and reusing it would propagate the same bad outcome.
 */
export function invalidateTrajectory(
  entry: Pick<TrajectoryEntry, "normalizedQuery" | "finishedAt">,
): void {
  const key = trajectoryIdentity(entry);
  if (_invalidatedKeys.has(key)) return;
  _invalidatedKeys.set(key, Date.now());
  if (_invalidatedKeys.size > INVALIDATION_MAX_ENTRIES) {
    const oldestKey = _invalidatedKeys.keys().next().value;
    if (oldestKey) _invalidatedKeys.delete(oldestKey);
  }
}

export function _resetTrajectoryInvalidationForTests(): void {
  _invalidatedKeys.clear();
}

// ── Read ───────────────────────────────────────────────────────────────────

/**
 * Result of a trajectory cache lookup. The similarity score and identity are
 * exposed so callers can decide whether to invalidate the entry on a bad turn
 * outcome.
 */
export interface TrajectoryLookupResult {
  entry: TrajectoryEntry;
  similarity: number;
}

/**
 * Look up a cached trajectory for a semantically similar query.
 *
 * Returns the best matching entry if:
 *   - Cosine similarity ≥ SIMILARITY_THRESHOLD
 *   - Entry is not expired (within TTL)
 *   - Entry is not credential-shaped
 *   - Entry has not been invalidated this process
 *
 * Returns `null` if embeddings are unavailable or no match found.
 */
export async function lookupTrajectory(
  query: string,
  workspacePath: string,
  freshnessSensitive = false,
): Promise<TrajectoryLookupResult | null> {
  if (!isEmbeddingAvailable()) return null;
  if (freshnessSensitive) return null; // Never use cached data for fresh-sensitive queries

  const filePath = resolve(workspacePath, CACHE_FILE);
  if (!existsSync(filePath)) return null;

  let queryEmbedding: Float32Array | null = null;
  try {
    queryEmbedding = await computeQueryEmbedding(query.toLowerCase().trim());
  } catch {
    return null;
  }
  if (!queryEmbedding) return null;

  const now = Date.now();

  let bestEntry: TrajectoryEntry | null = null;
  let bestSim = 0;

  // Only the most recent tail of the cache is useful — older entries are
  // either expired or dominated by newer ones.  Reading the tail keeps the
  // hot-path cost bounded even as the file grows toward MAX_CACHE_LINES.
  const entries = readLastRecords<TrajectoryEntry>(filePath, 500);
  for (const entry of entries) {
    // TTL check
    const finishedMs = new Date(entry.finishedAt).getTime();
    if (Number.isNaN(finishedMs) || (now - finishedMs) > entry.ttlSeconds * 1000) continue;
    // Skip entries marked bad earlier in this process
    if (_invalidatedKeys.has(trajectoryIdentity(entry))) continue;
    // Security: skip credential-shaped entries (defence in depth — should not exist)
    const serialized = JSON.stringify(entry);
    if (CREDENTIAL_RE.test(serialized)) continue;
    // Embedding similarity
    if (!Array.isArray(entry.queryEmbedding) || entry.queryEmbedding.length === 0) continue;
    const entryVec = new Float32Array(entry.queryEmbedding);
    const sim = cosineSimilarity(queryEmbedding, entryVec);
    if (sim >= SIMILARITY_THRESHOLD && sim > bestSim) {
      bestSim = sim;
      bestEntry = entry;
    }
  }

  return bestEntry ? { entry: bestEntry, similarity: bestSim } : null;
}
