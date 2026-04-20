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

import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { isEmbeddingAvailable, computeQueryEmbedding, cosineSimilarity } from "../providers/embeddings.js";

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

    const dir = resolve(workspacePath, ".starlingai");
    mkdirSync(dir, { recursive: true });
    const filePath = resolve(workspacePath, CACHE_FILE);
    appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");

    // Rolling-window: keep only the last MAX_CACHE_LINES entries
    _trimCacheIfNeeded(filePath);
  } catch {
    // Best-effort — trajectory cache write is never critical
  }
}

function _trimCacheIfNeeded(filePath: string): void {
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length > MAX_CACHE_LINES) {
      writeFileSync(filePath, lines.slice(lines.length - MAX_CACHE_LINES).join("\n") + "\n", "utf-8");
    }
  } catch { /* best-effort */ }
}

// ── Read ───────────────────────────────────────────────────────────────────

/**
 * Look up a cached trajectory for a semantically similar query.
 *
 * Returns the best matching entry if:
 *   - Cosine similarity ≥ SIMILARITY_THRESHOLD
 *   - Entry is not expired (within TTL)
 *   - Entry is not credential-shaped
 *
 * Returns `null` if embeddings are unavailable or no match found.
 */
export async function lookupTrajectory(
  query: string,
  workspacePath: string,
  freshnessSensitive = false,
): Promise<TrajectoryEntry | null> {
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

  try {
    const lines = readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry: TrajectoryEntry = JSON.parse(line);
        // TTL check
        const finishedMs = new Date(entry.finishedAt).getTime();
        if (Number.isNaN(finishedMs) || (now - finishedMs) > entry.ttlSeconds * 1000) continue;
        // Security: skip credential-shaped entries
        if (CREDENTIAL_RE.test(line)) continue;
        // Embedding similarity
        if (!Array.isArray(entry.queryEmbedding) || entry.queryEmbedding.length === 0) continue;
        const entryVec = new Float32Array(entry.queryEmbedding);
        const sim = cosineSimilarity(queryEmbedding, entryVec);
        if (sim >= SIMILARITY_THRESHOLD && sim > bestSim) {
          bestSim = sim;
          bestEntry = entry;
        }
      } catch { /* skip malformed line */ }
    }
  } catch {
    return null;
  }

  return bestEntry;
}
