/**
 * Max-effort turn oversight — the orchestrator-level half of `max` effort.
 *
 * At `max` effort agents run unbounded (no turn timeout, QA gates off) — the user's
 * explicit choice: "don't limit the effort of the agents, but trigger an oversight
 * agent which checks if we made progress or got stuck and intervenes if necessary."
 * The existing progress-verifier (progress-verifier.ts) watches a SINGLE sub-agent's
 * loop for a token/tool STALL. But the observed max-effort dead-end lives one level up:
 * a builder makes real progress, its stream dies mid-generation, the sub-agent returns
 * a failure/partial, and the ORCHESTRATOR re-delegates the same dying build over and
 * over — churning without ever converging on a deliverable. With the never-empty floor
 * and final-QA gate switched off at max, that turn can end having delivered nothing.
 *
 * This module is the turn-level oversight that closes that gap. Two layers, cheap →
 * expensive (mirrors progress-verifier.ts):
 *
 *  1. STRUCTURAL signal (no LLM, language-independent): is the WHOLE turn moving? New
 *     artifacts / tokens / tool calls = progressing. Delegated again AND failed again
 *     with no new artifact = churning (the dying-build retry loop). Nothing moved =
 *     stalled. Pure forward-progress, not lexicon (the no-keyword-overfit signal).
 *
 *  2. OVERSIGHT AGENT (a small bounded LLM judge, only when the structural signal is
 *     NOT progressing): reads the objective + recent turn activity + artifact/failure
 *     state and returns on_track | stuck | redirect plus ONE corrective directive. The
 *     caller injects that directive so the turn RE-PLANS (e.g. "stop re-emitting the
 *     whole file — resume the existing partial via append", or "deliver what you have
 *     now"). If a redirect was already tried and the turn is STILL not progressing, the
 *     caller falls back to forcing the best-available delivery — so max ALWAYS finishes.
 *
 * Fail-open throughout: any judge parse failure / provider error resolves to on_track,
 * so the oversight can never stop a healthy long run — only rescue a stuck one.
 */
import type { LLMMessage } from "../providers/lmstudio.js";

/** How often the oversight samples a max-effort turn (ms). Matches the sub-agent
 *  progress-verifier window so the two layers tick on the same cadence. */
export const TURN_OVERSIGHT_CHECK_INTERVAL_MS = 180_000;

/** A point-in-time forward-progress reading of the WHOLE turn. */
export interface TurnProgressSample {
  /** Cumulative completion tokens across the turn. */
  completionTokens: number;
  /** Cumulative tool calls requested this turn. */
  toolCalls: number;
  /** Cumulative delegations dispatched this turn. */
  delegations: number;
  /** Number of downloadable artifacts produced this turn so far. */
  artifacts: number;
  /** Consecutive delegation failures the warden has counted this turn. */
  delegationFailures: number;
}

export type TurnProgressSignal = "progressing" | "churning" | "stalled";

/**
 * Structural turn-progress test (pure — no LLM, no keywords, no topic awareness):
 *  - "progressing": a NEW artifact landed, or new completion tokens / tool calls since
 *     the last sample. The turn is moving; leave it alone.
 *  - "churning": delegated again AND a delegation failure was recorded again, with NO
 *     new artifact — the orchestrator is re-delegating a failing build without producing
 *     a deliverable (the max-effort dying-build retry loop). Narration tokens don't count
 *     as progress here: a real artifact is the only thing that clears this.
 *  - "stalled": nothing moved at all — a provider stall or an empty-iteration loop.
 * `>` (strict) so a counter that resets reads as no-progress rather than progress.
 */
export function classifyTurnProgress(prev: TurnProgressSample, cur: TurnProgressSample): TurnProgressSignal {
  if (cur.artifacts > prev.artifacts) return "progressing";
  if (cur.delegations > prev.delegations && cur.delegationFailures > prev.delegationFailures) return "churning";
  if (cur.completionTokens > prev.completionTokens || cur.toolCalls > prev.toolCalls) return "progressing";
  return "stalled";
}

export interface TurnOversightInput {
  /** What the turn is supposed to achieve (the turn-plan objective or the user request). */
  objective: string;
  /** The plan's acceptance criteria, if any — what "done right" looks like. */
  acceptanceCriteria?: string[];
  /** Compact digest of the turn's most recent activity (latest assistant text + recent
   *  tool / delegation names). Built and clamped by the caller. */
  recentActivity: string;
  /** What exists on disk so far, e.g. "1 file: generated/index.html (appears truncated)"
   *  or "no artifacts produced yet" — so the agent can suggest resuming a partial. */
  artifactState: string;
  /** The most recent delegation / build failure reason, if any. */
  lastFailure?: string;
  /** The structural reading that triggered this check (churning vs stalled), passed to
   *  the agent as context for the kind of stuck it is looking at. */
  signal: TurnProgressSignal;
}

/**
 * Build the (bounded) oversight-agent prompt. Kept here, not inline at the call site, so
 * the wording is unit-testable and tunable without touching the runtime. The agent is
 * asked for a strict JSON verdict + ONE corrective directive, and told to err toward
 * on_track — an oversight that derails a healthy run is worse than one that misses a
 * little churn.
 */
export function buildTurnOversightPrompt(input: TurnOversightInput): LLMMessage[] {
  const criteria = (input.acceptanceCriteria ?? []).filter(Boolean);
  const criteriaBlock = criteria.length
    ? `\n\nWhat "done correctly" looks like:\n${criteria.map((c) => `- ${c}`).join("\n")}`
    : "";
  const failureBlock = input.lastFailure ? `\n\nMost recent failure:\n${input.lastFailure}` : "";
  return [
    {
      role: "system",
      content:
        "You are the oversight agent for a long-running autonomous orchestrator running at MAX effort "
        + "(no time limit; it is expected to take many minutes). A structural check has flagged that the "
        + "turn may be STUCK: it is "
        + (input.signal === "churning"
          ? "re-delegating work that keeps FAILING without producing a deliverable"
          : "making no forward progress at all (no new output, tool calls, or files)")
        + ". You are given the OBJECTIVE, the RECENT ACTIVITY, and what has been produced so far. Decide whether "
        + "the turn is fine or needs your intervention, and reply with STRICT JSON:\n"
        + "{\"verdict\":\"on_track\"|\"stuck\"|\"redirect\",\"directive\":\"<one short corrective instruction, or empty>\",\"reason\":\"<one short sentence>\"}.\n"
        + "- on_track: the turn is genuinely progressing toward the objective; leave it alone (directive empty).\n"
        + "- redirect: it CAN still succeed but is using a failing approach; give ONE concrete corrective instruction "
        + "to change course (e.g. if a file was started but is truncated, tell it to RESUME that file by appending the "
        + "missing remainder rather than regenerating it; if one giant generation keeps dying, tell it to build in small "
        + "appended chunks; stop repeating the failing delegation).\n"
        + "- stuck: it cannot make further progress; the directive should tell it to STOP and deliver the best result "
        + "it can from what already exists.\n"
        + "Prefer a concrete, actionable directive over a vague one. When genuinely unsure whether it is still moving, "
        + "answer on_track — derailing a healthy run is worse than letting a slow one continue.",
    },
    {
      role: "user",
      content:
        `OBJECTIVE:\n${input.objective}${criteriaBlock}`
        + `\n\nPRODUCED SO FAR:\n${input.artifactState}`
        + `${failureBlock}`
        + `\n\nRECENT ACTIVITY:\n${input.recentActivity}`,
    },
  ];
}

export type TurnOversightVerdict = "on_track" | "stuck" | "redirect";

export interface TurnOversightResult {
  verdict: TurnOversightVerdict;
  /** ONE corrective instruction to inject; empty for on_track. */
  directive: string;
  reason: string;
}

/**
 * Parse the oversight agent's raw reply, fail-open. Anything that is not an unambiguous
 * stuck/redirect JSON object resolves to on_track so a malformed or truncated reply can
 * never derail a healthy turn. A redirect/stuck verdict with no usable directive is
 * downgraded to on_track (there is nothing actionable to inject).
 */
export function parseTurnOversightVerdict(raw: string | null | undefined): TurnOversightResult {
  const onTrack = (reason: string): TurnOversightResult => ({ verdict: "on_track", directive: "", reason });
  if (!raw || !raw.trim()) return onTrack("empty oversight reply — defaulting to on_track");
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return onTrack("unparseable oversight reply — defaulting to on_track");
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const verdict = String(obj["verdict"] ?? "").trim().toLowerCase();
    const directive = String(obj["directive"] ?? "").trim().slice(0, 600);
    const reason = String(obj["reason"] ?? "").trim().slice(0, 300);
    if ((verdict === "redirect" || verdict === "stuck") && directive) {
      return { verdict, directive, reason: reason || `oversight flagged the turn as ${verdict}` };
    }
    // redirect/stuck with no directive = nothing actionable; on_track otherwise.
    return onTrack(reason || "on_track");
  } catch {
    return onTrack("unparseable oversight reply — defaulting to on_track");
  }
}
