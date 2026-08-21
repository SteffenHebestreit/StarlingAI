/**
 * Agent outcome log — persistent NDJSON record of sub-agent executions.
 *
 * Each record captures whether an agent succeeded, failed, or hit its
 * iteration limit.  Lessons (written by agents via record_lesson, or
 * detected automatically) are stored alongside the record.
 *
 * The orchestrator reads recent failures at session start so it can
 * route smarter without repeating known-broken paths.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { childLogger } from "../logger.js";
import { appendJsonLine, readLastRecords } from "../memory/bounded-ndjson-store.js";

import { PRODUCT } from "../product/index.js";

const log = childLogger("agent:outcomes");

export interface OutcomeEntry {
  ts: string;
  agent: string;
  task: string;
  outcome: "success" | "failure" | "partial";
  iterations: number;
  totalTokens: number;
  durationMs?: number;
  timeoutMs?: number;
  error?: string;
  /** Human-readable lesson the agent or system recorded */
  lesson?: string;
  /**
   * G32: Coarse task-class fingerprint — top 3 content words from the task,
   * lower-cased, sorted.  Used for outcome-weighted routing.
   */
  taskKeywords?: string[];
  /** G32: Number of share_finding calls made during this run (quality signal). */
  sharedFindingsCount?: number;
}

const OUTCOMES_FILE = `${PRODUCT.stateDirName}/agent_outcomes.ndjson`;
const MAX_OUTCOMES_LINES = 50_000;

// Short-TTL parsed-tail cache. readRecentOutcomes is hit ~30× per degraded route
// (per-agent timeout/routing/cost-profile/circuit reads over the pool) and once per
// fan-out slice — each a synchronous chunked tail read + JSON.parse of the same file.
// Cache the parsed last-N entries per workspace and serve smaller asks from it.
const OUTCOMES_CACHE_TTL_MS = 1500;
const OUTCOMES_CACHE_LIMIT = 200;
const _outcomesCache = new Map<string, { storedAt: number; entries: OutcomeEntry[] }>();

export function appendOutcome(workspacePath: string, entry: OutcomeEntry): void {
  try {
    const filePath = resolve(workspacePath, OUTCOMES_FILE);
    appendJsonLine(filePath, entry, { maxLines: MAX_OUTCOMES_LINES });
    _outcomesCache.delete(filePath); // invalidate so the next read reflects the append
  } catch (err) {
    log.warn({ err }, "Failed to write agent outcome — non-critical, continuing");
  }
}

export function readRecentOutcomes(workspacePath: string, limit = 40): OutcomeEntry[] {
  const file = resolve(workspacePath, OUTCOMES_FILE);
  if (!existsSync(file)) return [];
  // Asks beyond the cached window bypass the cache (rare).
  if (limit > OUTCOMES_CACHE_LIMIT) return readLastRecords<OutcomeEntry>(file, limit);
  const cached = _outcomesCache.get(file);
  const entries = cached && Date.now() - cached.storedAt <= OUTCOMES_CACHE_TTL_MS
    ? cached.entries
    : (() => {
        const fresh = readLastRecords<OutcomeEntry>(file, OUTCOMES_CACHE_LIMIT);
        _outcomesCache.set(file, { storedAt: Date.now(), entries: fresh });
        return fresh;
      })();
  // Return a fresh copy of the last `limit` so callers can't mutate the cache.
  return limit >= entries.length ? entries.slice() : entries.slice(-limit);
}

export interface AgentCostProfile {
  /** Number of outcome log entries used for this profile. */
  runs: number;
  /** Blended success rate: success=1, partial=0.5, failure=0. */
  successRate: number;
  /** Average total tokens across recent runs (0 if not recorded). */
  avgTokens: number;
  /** Average tool-call iterations across recent runs. */
  avgIterations: number;
}

export interface AdaptiveTimeoutRecommendation {
  timeoutMs: number;
  sampleSize: number;
  baselineMs: number;
}

/**
 * Compute a cost/performance profile for a named agent from the outcomes log.
 * Returns null if fewer than MIN_RUNS samples exist (not enough data yet).
 */
const MIN_PROFILE_RUNS = 3;
const MIN_TIMEOUT_SAMPLES = 3;
const MIN_ADAPTIVE_TIMEOUT_MS = 15_000;
// Ceiling for an adaptively-grown per-sub-agent timeout. Kept well under the
// interactive orchestrator turn cap (gateway.turnTimeoutMs, 10 min) so a single
// sub-agent run can never consume the whole turn — bounded deep work, room left
// for the orchestrator's own synthesis. Was 30 min, which (together with the
// feedback loop below) let coordinators grow 25-min timeouts.
const MAX_ADAPTIVE_TIMEOUT_MS = 360_000;
const TIMEOUT_HEADROOM_FACTOR = 1.5;
// A run whose duration reached ~this fraction of its allotted timeout was almost
// certainly killed by that timeout (the outcome log records durationMs ≈ the
// timeout, sometimes slightly over due to the post-operation grace). Such runs
// must NOT seed the baseline: feeding a timed-out duration back in ratchets the
// next timeout upward toward the ceiling — a self-reinforcing loop that produced
// 25-min coordinator timeouts.
const TIMEOUT_HIT_FRACTION = 0.9;
const PROMPT_OUTCOME_LOOKBACK_MS = 6 * 60 * 60 * 1_000;
const PROMPT_MIN_ADVERSE_OUTCOMES = 2;

export function computeAgentCostProfile(agentName: string, workspacePath: string): AgentCostProfile | null {
  const outcomes = readRecentOutcomes(workspacePath, 50);
  const relevant = outcomes.filter(o => o.agent === agentName);
  if (relevant.length < MIN_PROFILE_RUNS) return null;
  const successes = relevant.filter(o => o.outcome === "success").length;
  const partials = relevant.filter(o => o.outcome === "partial").length;
  const avgTokens = Math.round(relevant.reduce((sum, o) => sum + (o.totalTokens ?? 0), 0) / relevant.length);
  const avgIterations = Math.round(relevant.reduce((sum, o) => sum + (o.iterations ?? 0), 0) / relevant.length * 10) / 10;
  return {
    runs: relevant.length,
    successRate: (successes + partials * 0.5) / relevant.length,
    avgTokens,
    avgIterations,
  };
}

export function computeAdaptiveSubAgentTimeoutMs(
  agentName: string,
  workspacePath: string,
  fallbackTimeoutMs: number,
): AdaptiveTimeoutRecommendation | null {
  const outcomes = readRecentOutcomes(workspacePath, 50)
    .filter((entry) => entry.agent === agentName)
    .filter((entry) => (entry.outcome === "success" || entry.outcome === "partial") && typeof entry.durationMs === "number" && entry.durationMs > 0)
    // Drop runs that ran to (or past) their own timeout — their duration is the
    // allotted budget, not a real completion time, so including them would
    // inflate the next budget toward the ceiling. Only clean finishes inform it.
    .filter((entry) => !(typeof entry.timeoutMs === "number" && entry.timeoutMs > 0
      && entry.durationMs! >= entry.timeoutMs * TIMEOUT_HIT_FRACTION))
    .slice(-10);

  // Too few clean (non-timed-out) samples → fall back to the static default
  // rather than grow a budget from a history of timeouts.
  if (outcomes.length < MIN_TIMEOUT_SAMPLES) return null;

  const durations = outcomes
    .map((entry) => entry.durationMs!)
    .sort((left, right) => left - right);

  const baselineMs = percentile(durations, 0.95);
  // Cap the history-derived growth to [MIN, MAX], then floor at the agent's own
  // default. The ceiling bounds how far HISTORY can push the budget up; it must
  // never pull the budget BELOW a legitimately higher default (e.g. a
  // coordinator's turn-cap-derived floor can exceed the adaptive ceiling).
  const timeoutMs = Math.max(fallbackTimeoutMs, clampTimeout(Math.round(baselineMs * TIMEOUT_HEADROOM_FACTOR)));

  return {
    timeoutMs,
    sampleSize: durations.length,
    baselineMs,
  };
}

/**
 * Returns a compact Markdown section summarising recent agent performance.
 * Empty string if there's nothing noteworthy.
 */
export function formatOutcomesForPrompt(workspacePath: string): string {
  const cutoffMs = Date.now() - PROMPT_OUTCOME_LOOKBACK_MS;
  const outcomes = readRecentOutcomes(workspacePath, 30).filter((entry) => {
    const tsMs = Date.parse(entry.ts);
    return Number.isFinite(tsMs) && tsMs >= cutoffMs;
  });
  if (outcomes.length === 0) return "";

  // Aggregate per-agent stats from the most recent window
  const stats = new Map<string, {
    success: number;
    failure: number;
    partial: number;
  }>();

  for (const o of outcomes) {
    const s = stats.get(o.agent) ?? { success: 0, failure: 0, partial: 0 };
    s[o.outcome]++;
    stats.set(o.agent, s);
  }

  const failingAgents = [...stats.entries()]
    .filter(([name]) => !name.startsWith("ephemeral:"))
    .filter(([, s]) => s.failure + s.partial >= PROMPT_MIN_ADVERSE_OUTCOMES)
    .sort((left, right) => {
      const leftAdverse = left[1].failure + left[1].partial;
      const rightAdverse = right[1].failure + right[1].partial;
      if (rightAdverse !== leftAdverse) return rightAdverse - leftAdverse;
      return left[0].localeCompare(right[0]);
    });
  if (failingAgents.length === 0) return "";

  const lines = failingAgents.map(([name, s]) => {
    return `- **${name}**: ${s.failure} failure(s), ${s.partial} partial(s) [${s.success} success(es)]`;
  });

  return [
    "## Recent Agent Performance",
    ...lines,
    "→ If an agent has repeated failures, prefer an alternative agent or use create_ephemeral_agent.",
  ].join("\n");
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1));
  return values[index]!;
}

function clampTimeout(timeoutMs: number): number {
  return Math.max(MIN_ADAPTIVE_TIMEOUT_MS, Math.min(MAX_ADAPTIVE_TIMEOUT_MS, timeoutMs));
}

// ── G32: Task-class fingerprint helpers ────────────────────────────────────

const STOP_WORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","should","could","may","might","shall","can",
  "i","we","you","he","she","it","they","this","that","these","those","of","in",
  "on","at","to","for","with","by","from","up","about","into","through","during",
  "what","which","who","how","when","where","why","please","me","my","our","your",
  "gibt","mir","ich","bitte","die","der","das","ein","eine","und","oder","von",
]);

/**
 * G32: Extract a stable 3-word fingerprint from a task description.
 * Used to group outcomes into coarse task classes for routing weight adjustment.
 */
export function extractTaskKeywords(task: string): string[] {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
    .slice(0, 3)
    .sort();
}

/**
 * G32: Jaccard similarity between two keyword arrays.
 * Returns 0–1. Used to identify "similar task class" outcomes.
 */
function keywordJaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * G32: Outcome-weighted routing multiplier for a specific agent on a given task.
 *
 * Algorithm:
 *   1. Find recent outcomes for this agent whose task keywords have Jaccard ≥ 0.4
 *      with the current query keywords (similar task class).
 *   2. Compute blended success rate (success=1, partial=0.5, failure=0).
 *   3. Return a multiplier in [0.80, 1.20] via tanh — neutral at 0.5 success rate.
 *
 * Minimum 25 similar-class samples required before applying any adjustment.
 * Below threshold returns 1.0 (no change).
 */
const MIN_OUTCOME_WEIGHT_SAMPLES = 25;
const OUTCOME_WEIGHT_MAX_DELTA = 0.20; // ±20% cap

export function computeOutcomeRoutingMultiplier(
  agentName: string,
  queryKeywords: string[],
  workspacePath: string,
): number {
  const outcomes = readRecentOutcomes(workspacePath, 200);
  const similar = outcomes.filter(o => {
    if (o.agent !== agentName) return false;
    const kws = o.taskKeywords ?? extractTaskKeywords(o.task);
    return keywordJaccard(queryKeywords, kws) >= 0.4;
  });
  if (similar.length < MIN_OUTCOME_WEIGHT_SAMPLES) return 1.0;
  const successRate =
    (similar.filter(o => o.outcome === "success").length +
     similar.filter(o => o.outcome === "partial").length * 0.5) /
    similar.length;
  // tanh maps [-∞,+∞] → (-1,+1); here we map [0,1] success rate so that
  // 0.5 → multiplier 1.0, 1.0 → ~1.20, 0.0 → ~0.80.
  const delta = Math.tanh((successRate - 0.5) * 4) * OUTCOME_WEIGHT_MAX_DELTA;
  return 1.0 + delta;
}
