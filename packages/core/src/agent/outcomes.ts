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
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { childLogger } from "../logger.js";

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

const OUTCOMES_FILE = ".starlingai/agent_outcomes.ndjson";

export function appendOutcome(workspacePath: string, entry: OutcomeEntry): void {
  try {
    const dir = resolve(workspacePath, ".starlingai");
    mkdirSync(dir, { recursive: true });
    const filePath = resolve(workspacePath, OUTCOMES_FILE);
    appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
    // Rolling-window trim: keep only the last MAX_OUTCOMES_LINES lines so very
    // long-lived workspaces do not pay O(n) read cost on every routing call.
    _trimOutcomesIfNeeded(filePath);
  } catch (err) {
    log.warn({ err }, "Failed to write agent outcome — non-critical, continuing");
  }
}

const MAX_OUTCOMES_LINES = 50_000;
const TRIM_CHECK_INTERVAL = 200; // only count lines every N writes
let _outcomesWriteCount = 0;

function _trimOutcomesIfNeeded(filePath: string): void {
  _outcomesWriteCount++;
  if (_outcomesWriteCount % TRIM_CHECK_INTERVAL !== 0) return;
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length > MAX_OUTCOMES_LINES) {
      const kept = lines.slice(lines.length - MAX_OUTCOMES_LINES);
      writeFileSync(filePath, kept.join("\n") + "\n", "utf-8");
    }
  } catch { /* best-effort */ }
}

export function readRecentOutcomes(workspacePath: string, limit = 40): OutcomeEntry[] {
  const file = resolve(workspacePath, OUTCOMES_FILE);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line) as OutcomeEntry; } catch { return null; } })
      .filter((e): e is OutcomeEntry => e !== null)
      .slice(-limit);
  } catch {
    return [];
  }
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
const MAX_ADAPTIVE_TIMEOUT_MS = 1_800_000;
const TIMEOUT_HEADROOM_FACTOR = 1.5;
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
    .slice(-10);

  if (outcomes.length < MIN_TIMEOUT_SAMPLES) return null;

  const durations = outcomes
    .map((entry) => entry.durationMs!)
    .sort((left, right) => left - right);

  const baselineMs = percentile(durations, 0.95);
  const timeoutMs = clampTimeout(Math.max(fallbackTimeoutMs, Math.round(baselineMs * TIMEOUT_HEADROOM_FACTOR)));

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
    .filter(([name, s]) => !name.startsWith("ephemeral:"))
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
