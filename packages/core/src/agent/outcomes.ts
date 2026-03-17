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
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
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
}

const OUTCOMES_FILE = ".starlingai/agent_outcomes.ndjson";

export function appendOutcome(workspacePath: string, entry: OutcomeEntry): void {
  try {
    const dir = resolve(workspacePath, ".starlingai");
    mkdirSync(dir, { recursive: true });
    appendFileSync(resolve(workspacePath, OUTCOMES_FILE), JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    log.warn({ err }, "Failed to write agent outcome — non-critical, continuing");
  }
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
const MAX_ADAPTIVE_TIMEOUT_MS = 900_000;
const TIMEOUT_HEADROOM_FACTOR = 1.5;

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
  const outcomes = readRecentOutcomes(workspacePath, 30);
  if (outcomes.length === 0) return "";

  // Aggregate per-agent stats from the most recent window
  const stats = new Map<string, {
    success: number;
    failure: number;
    partial: number;
    latestLesson?: string;
    lastFailureTask?: string;
  }>();

  for (const o of outcomes) {
    const s = stats.get(o.agent) ?? { success: 0, failure: 0, partial: 0 };
    s[o.outcome]++;
    if (o.lesson) s.latestLesson = o.lesson;
    if ((o.outcome === "failure" || o.outcome === "partial") && o.task) {
      s.lastFailureTask = o.task.slice(0, 80);
    }
    stats.set(o.agent, s);
  }

  const failingAgents = [...stats.entries()].filter(([, s]) => s.failure > 0 || s.partial > 0);
  if (failingAgents.length === 0) return "";

  const lines = failingAgents.map(([name, s]) => {
    const lessonNote = s.latestLesson ? ` — Lesson: "${s.latestLesson}"` : "";
    const taskNote = !s.latestLesson && s.lastFailureTask ? ` (last failed: "${s.lastFailureTask}")` : "";
    return `- **${name}**: ${s.failure} failure(s), ${s.partial} partial(s) [${s.success} success(es)]${lessonNote}${taskNote}`;
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
