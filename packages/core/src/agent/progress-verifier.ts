/**
 * Progress supervisor — the thing that replaces static budget limits.
 *
 * The policy this module implements: DON'T cap a healthy run, DO stop an unhealthy
 * one. Every static limit measured in this area killed a run that was working —
 * a token ceiling truncated a model mid-thought so it never reached a tool call, a
 * 20-minute stream cap killed a run ~6 minutes from finishing, a 30-minute turn
 * budget cut synthesis on a run that had made 15 tool calls and written 5 files.
 * None of those timers could tell a working run from a burning one, because none
 * of them looked at what the run had DONE. This one only looks at that.
 *
 * Three pathologies, three detectors, all pure and all structural (no keywords, no
 * topic awareness, no LLM in the hot path):
 *
 *  1. BURNING — reasoning pouring out with no productive action behind it. Bounded
 *     by a reasoning-character BUDGET, not a clock (see
 *     COLD_START_REASONING_BUDGET_CHARS for why a clock cannot work here).
 *  2. STALLED — the run has produced something, then nothing new across
 *     consecutive windows: no productive tool call, no workspace change, no new
 *     content hash, no substantive new output.
 *  3. LOOPING — the run is repeating itself: the same bytes written to the same
 *     path, an A→B→A→B content oscillation, or an assistant turn identical to one
 *     an earlier iteration already produced.
 *
 * A confirmed pathology asks the run to WIND DOWN through the same path an
 * operator `stop` uses, so collected evidence is synthesised and handed back —
 * never a hard kill. An AMBIGUOUS shape (a run that HAS produced something and has
 * merely gone quiet — it may be mid-verification) is surfaced to the operator dock
 * instead of being stopped.
 *
 * A fourth, opt-in layer remains below: the SEMANTIC direction judge
 * (orchestration.progressVerifierSemantic, default off pending live eval). A busy
 * run can still be working toward the wrong goal, which structure alone cannot
 * see. It is fail-open by construction — any parse failure / provider error /
 * timeout resolves to on_track, because stopping a healthy run is far worse than
 * missing some drift.
 */
import type { LLMMessage } from "../providers/lmstudio.js";

/** How often the supervisor samples a run (ms). Matches the soft long-running
 *  threshold so the existing crossing cadence drives it. */
export const PROGRESS_CHECK_INTERVAL_MS = 180_000;

/** Consecutive no-progress samples before the stall rule intervenes. Two full
 *  windows (~6 min) — conservative, so a single slow inference or one in-flight
 *  tool call never trips it. The healthy reference run made a productive tool call
 *  every ~108s on average (15 calls over 26.9 min), so it never came within 3x. */
export const STALL_LIMIT = 2;

/**
 * Reasoning budget for a run that has produced NOTHING yet.
 *
 * Measured, from three reference runs, and the single most important number here.
 * The pathologies were *descriptively* obvious inside two minutes — but as a
 * THRESHOLD two minutes is fatal: at that point the healthy run looked identical
 * to both of them. Its first iteration was 23,876 reasoning chars with zero tool
 * calls, which at the measured ~16.8 completion tok/s is ~7.9 MINUTES of pure
 * thinking on a run that went on to make 15 tool calls and write 5 files. Any
 * wall-clock rule short enough to catch the pathologies kills it.
 *
 * A reasoning-character budget separates them where a clock cannot:
 *   healthy peak before first tool call   23,876
 *   ephemeral (0 tool calls, 20 min)      60,385
 *   content_writer (1 tool call, 28.8 min) 64,587
 * 45,000 sits 1.9x above the healthy peak and 0.74x below both failures. It fires
 * at roughly 15 minutes for a burner and never for the reference run — the
 * earliest point at which the two shapes are genuinely distinguishable rather than
 * merely different in hindsight.
 */
export const COLD_START_REASONING_BUDGET_CHARS = 45_000;

/**
 * How much assistant output counts as actually having produced something.
 *
 * Used twice, for the same reason both times: a run that emits "Done." or "OK" (or
 * the 37-character result the zero-tool pathology ended with) has not produced
 * anything, and must not earn either an exemption from the reasoning budget or a
 * forward-progress tick. 200 chars is far below any real deliverable and far above
 * an acknowledgement; a producing model at ~16.8 tok/s clears it in ~4 seconds, so
 * it can never suppress a real emit across a 180s window.
 */
export const MIN_SUBSTANTIVE_OUTPUT_CHARS = 200;

export type ProgressVerdict = "on_track" | "burning" | "stalled" | "looping" | "drifting";

/**
 * A point-in-time shape reading of a run.
 *
 * `completionTokens` is DELIBERATELY ABSENT, and must not be reintroduced. The
 * provider salvage path (providers/lmstudio.ts) reconstructs that counter from
 * reasoning characters when a stream is cut, and LM Studio reports reasoning
 * INSIDE completion_tokens on the normal path anyway. Either way the counter
 * cannot tell thinking from doing: a 60,385-character zero-tool monologue reads as
 * ~20,000 "completion tokens" of forward progress. It is a liveness signal, not a
 * progress signal, and the old structural guard trusted it as the latter.
 */
export interface ProgressSample {
  /** Tool calls that EXECUTED and SUCCEEDED. Structural, not a keyword list: cache
   *  hits, cap-blocked calls and consecutive duplicates all short-circuit before
   *  this is incremented, so a model re-reading the same context in circles never
   *  moves it. */
  productiveToolCalls: number;
  /** Distinct workspace paths successfully written or edited. */
  mutatedPaths: number;
  /** Distinct content hashes written across all paths — a rewrite with NEW content
   *  moves this, an A→B→A oscillation does not. */
  distinctWriteHashes: number;
  /** Cumulative NON-reasoning assistant output. Progress, because one legitimate
   *  long builder pass is a content stream with no tool call in it. */
  outputChars: number;
  /** Cumulative reasoning characters. DIAGNOSTIC ONLY — never counts as progress. */
  reasoningChars: number;
}

export const EMPTY_PROGRESS_SAMPLE: ProgressSample = {
  productiveToolCalls: 0,
  mutatedPaths: 0,
  distinctWriteHashes: 0,
  outputChars: 0,
  reasoningChars: 0,
};

/** What the supervisor wants the caller to do about a sample. */
export interface ProgressDecision {
  /** `continue` = leave it alone; `wind_down` = synthesise from what it has;
   *  `ask` = ambiguous, surface to the operator dock rather than deciding. */
  action: "continue" | "wind_down" | "ask";
  verdict: ProgressVerdict;
  reason: string;
  consecutiveStalls: number;
}

/**
 * Did the run DO anything since the last sample? Pure; no LLM, no keywords, no
 * topic awareness. Reasoning growth is not in this expression and must never be
 * added to it — reasoning growth is the pathology, not an exemption from it.
 *
 * Output has to clear MIN_SUBSTANTIVE_OUTPUT_CHARS to count, so a run emitting a
 * two-word acknowledgement every iteration cannot fake progress indefinitely.
 */
export function hasForwardProgress(prev: ProgressSample, cur: ProgressSample): boolean {
  return cur.productiveToolCalls > prev.productiveToolCalls
    || cur.mutatedPaths > prev.mutatedPaths
    || cur.distinctWriteHashes > prev.distinctWriteHashes
    || (cur.outputChars - prev.outputChars) >= MIN_SUBSTANTIVE_OUTPUT_CHARS;
}

/**
 * The shape rule. Two arms, split on whether the run has taken any productive
 * action at all:
 *
 *  COLD (no productive tool call and no mutated path yet): a reasoning BUDGET, not
 *    a clock. This is the only arm that can see a zero-tool-call run, and the only
 *    threshold shape that does not also kill the healthy run's ~8-minute opening
 *    think. Below budget the run is left alone however long it has been going. A
 *    cold run that HAS emitted substantive output is ambiguous, not condemned —
 *    it may be a pure-writer legitimately answering without tools — so it goes to
 *    the dock instead of being wound down.
 *
 *  WARM: consecutive windows with no productive call, no new path, no new content
 *    hash and no substantive new output. Reasoning may be pouring in; that is the
 *    pathology, not an exemption. A warm run that has written files and gone quiet
 *    may legitimately be verifying, so THAT case goes to the dock too; a run that
 *    has written nothing is not ambiguous.
 */
export function classifyRunProgress(
  prev: ProgressSample,
  cur: ProgressSample,
  consecutiveStalls: number,
): ProgressDecision {
  const producedSomething = cur.mutatedPaths > 0;
  const tookAction = cur.productiveToolCalls > 0 || producedSomething;
  if (!tookAction) {
    if (cur.reasoningChars >= COLD_START_REASONING_BUDGET_CHARS) {
      const wrote = cur.outputChars >= MIN_SUBSTANTIVE_OUTPUT_CHARS;
      return {
        action: wrote ? "ask" : "wind_down",
        verdict: "burning",
        consecutiveStalls: 0,
        reason: `${cur.reasoningChars} reasoning chars with no productive tool call and no workspace change `
          + `(budget ${COLD_START_REASONING_BUDGET_CHARS}, output ${cur.outputChars} chars) — `
          + `the run is thinking, not working`,
      };
    }
    return {
      action: "continue",
      verdict: "on_track",
      reason: "no productive action yet, still within the reasoning budget",
      consecutiveStalls: 0,
    };
  }
  if (hasForwardProgress(prev, cur)) {
    return { action: "continue", verdict: "on_track", reason: "forward progress", consecutiveStalls: 0 };
  }
  const stalls = consecutiveStalls + 1;
  if (stalls < STALL_LIMIT) {
    return { action: "continue", verdict: "on_track", reason: "first no-progress window", consecutiveStalls: stalls };
  }
  return {
    action: producedSomething ? "ask" : "wind_down",
    verdict: "stalled",
    consecutiveStalls: stalls,
    reason: `no productive tool call, no workspace change and no substantive new output across ${stalls} `
      + `${Math.round(PROGRESS_CHECK_INTERVAL_MS / 1000)}s windows (reasoning ${cur.reasoningChars} chars)`,
  };
}

// ── Loop detection ────────────────────────────────────────────────────────────

/** Same path, same bytes, this many times = a loop. NOT "same path twice": a
 *  builder legitimately rewrites one file several times with DIFFERENT content
 *  (the healthy reference run made 3 such corrections, including catching its own
 *  off-by-one), and the old flat per-path write cap of 2 blocked exactly that. */
export const IDENTICAL_WRITE_LIMIT = 2;

/** Same tool, byte-identical arguments, this many times in one run = a loop.
 *  3, not 2: one legitimate retry after a transient failure is 2. */
export const ARG_SIG_REPEAT_LIMIT = 3;

export type WriteLoopKind = "identical_rewrite" | "content_oscillation";

/**
 * Content-shape loop test for a write to a path whose previous content hashes are
 * `history` (oldest first). Sees the two things a COUNT cannot:
 *
 *   identical_rewrite    — these exact bytes have already been written here, so
 *                          the file on disk already has them and the write is a
 *                          no-op the model keeps re-issuing.
 *   content_oscillation  — A→B→A→B: the run is flip-flopping between two versions
 *                          rather than converging on one.
 *
 * The oscillation test deliberately needs the FULL A→B→A→B, not the A→B→A prefix.
 * A→B→A is a revert — the model tried something, saw it was wrong, and put the
 * good version back — which is exactly the self-correction the healthy reference
 * run was doing. Blocking a revert would strand the bad content on disk, so one
 * revert is allowed and only the repeat of it reads as a loop.
 *
 * Pure and language-independent — it compares hashes, never content.
 */
export function classifyWriteLoop(history: readonly string[], incoming: string): WriteLoopKind | null {
  const n = history.length;
  if (n >= 3 && history[n - 2] === incoming && history[n - 1] === history[n - 3]) return "content_oscillation";
  const identical = history.filter((h) => h === incoming).length;
  if (identical >= IDENTICAL_WRITE_LIMIT) return "identical_rewrite";
  return null;
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
