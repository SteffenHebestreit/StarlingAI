/**
 * Progress verifier — the oversight half of `max` effort's silent-unbounded mode.
 *
 * At `max` effort a long-running sub-agent is granted unbounded budget WITHOUT
 * pinging the operator dock (the user's explicit choice: "auto-choose unbounded
 * … but let a verify-progress agent check the progress and don't let it run into
 * the wrong direction"). Removing the operator from the loop removes the only
 * thing that used to stop a runaway run, so it MUST be replaced by an automated
 * progress check. This module is that check.
 *
 * Two layers, deliberately ordered cheap → expensive:
 *
 *  1. STRUCTURAL stall guard (always on at max; deterministic, language-
 *     independent, no LLM call). A run that produces NO new completion tokens and
 *     makes NO new tool calls across consecutive check windows is stuck — a
 *     provider stall or an empty-iteration loop — regardless of topic or language.
 *     This is the no-keyword-overfit signal: pure forward-progress, not lexicon.
 *
 *  2. SEMANTIC direction judge (opt-in via orchestration.progressVerifierSemantic,
 *     default off pending live eval on the user's stack). A busy run can still be
 *     "running in the wrong direction" — producing tokens toward the wrong goal —
 *     which structure alone cannot see. A small bounded judge call reads the
 *     objective + recent activity and answers on_track | drifting. It NEVER
 *     dead-ends a healthy run: any parse failure / provider error / timeout
 *     resolves to on_track (trust-the-LLM, fail-open).
 *
 * On a confirmed stall or a `drifting` verdict the caller asks the run to wind
 * down and synthesise from what it has, handing the best-available result back to
 * the orchestrator's QA / coordinator loop to re-plan — never a hard kill.
 */
import type { LLMMessage } from "../providers/lmstudio.js";

/** How often the verifier samples a max-effort run (ms). Matches the soft
 *  long-running threshold so the existing crossing cadence drives it. */
export const PROGRESS_CHECK_INTERVAL_MS = 180_000;

/** Consecutive hard-stall samples before the structural guard intervenes. Two
 *  full windows of zero forward progress (~6 min) — conservative, so a single
 *  slow inference or in-flight tool call never trips it. */
export const STALL_LIMIT = 2;

export type ProgressVerdict = "on_track" | "stalled" | "drifting";

/** A point-in-time forward-progress reading of a run. */
export interface ProgressSample {
  completionTokens: number;
  toolCalls: number;
}

/**
 * Structural stall test: did the run make ANY forward progress (new completion
 * tokens OR new tool calls) since the previous sample? `<=` (not `<`) so a
 * counter that somehow resets still reads as no-progress rather than progress.
 * Pure — no LLM, no keywords, no topic awareness.
 */
export function isHardStall(prev: ProgressSample, cur: ProgressSample): boolean {
  return cur.completionTokens <= prev.completionTokens && cur.toolCalls <= prev.toolCalls;
}

export interface SemanticProgressInput {
  /** What this run is supposed to achieve (the sub-agent's task / the plan objective). */
  objective: string;
  /** The plan's acceptance criteria, if any — what "done right" looks like. */
  acceptanceCriteria?: string[];
  /** A compact digest of the run's most recent activity (latest assistant text +
   *  recent tool calls). Built by the caller and clamped before it gets here. */
  recentActivity: string;
}

/**
 * Build the (bounded) judge prompt. Kept here, not inline at the call site, so the
 * exact wording is unit-testable and easy to tune without touching the runtime.
 * The judge is asked for a strict JSON verdict and told to err toward on_track —
 * a verifier that stops good runs is worse than one that misses a little drift.
 */
export function buildProgressJudgePrompt(input: SemanticProgressInput): LLMMessage[] {
  const criteria = (input.acceptanceCriteria ?? []).filter(Boolean);
  const criteriaBlock = criteria.length
    ? `\n\nWhat "done correctly" looks like:\n${criteria.map((c) => `- ${c}`).join("\n")}`
    : "";
  return [
    {
      role: "system",
      content:
        "You are a progress monitor for a long-running autonomous agent. You are given the agent's "
        + "OBJECTIVE and a digest of its RECENT ACTIVITY. Judge ONLY whether the recent activity is "
        + "moving toward the objective — not whether it is finished, polished, or fast. "
        + "Reply with STRICT JSON: {\"verdict\":\"on_track\"|\"drifting\",\"reason\":\"<one short sentence>\"}. "
        + "Use \"drifting\" ONLY when the activity is clearly working on the wrong thing, stuck repeating "
        + "itself, or contradicting the objective. When in any doubt, answer \"on_track\" — it is far worse "
        + "to stop a healthy run than to let a slightly meandering one continue.",
    },
    {
      role: "user",
      content: `OBJECTIVE:\n${input.objective}${criteriaBlock}\n\nRECENT ACTIVITY:\n${input.recentActivity}`,
    },
  ];
}

export interface SemanticProgressResult {
  verdict: "on_track" | "drifting";
  reason: string;
}

/**
 * Parse the judge's raw reply into a verdict, fail-open. Anything that is not an
 * unambiguous `drifting` JSON object resolves to on_track so a malformed or
 * truncated judge reply can never stop a healthy run.
 */
export function parseProgressVerdict(raw: string | null | undefined): SemanticProgressResult {
  const safe: SemanticProgressResult = { verdict: "on_track", reason: "unparseable judge reply — defaulting to on_track" };
  if (!raw || !raw.trim()) return safe;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return safe;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const verdict = String(obj["verdict"] ?? "").trim().toLowerCase();
    if (verdict === "drifting") {
      const reason = String(obj["reason"] ?? "judge flagged the run as drifting").slice(0, 300);
      return { verdict: "drifting", reason };
    }
    return { verdict: "on_track", reason: String(obj["reason"] ?? "on_track").slice(0, 300) };
  } catch {
    return safe;
  }
}
