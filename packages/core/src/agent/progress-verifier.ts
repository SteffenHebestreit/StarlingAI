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
 *  1. BURNING — reasoning going in CIRCLES with no productive action behind it. Judged
 *     on the reasoning text itself (detectReasoningLoop), sampled inside the stream;
 *     a character ceiling remains only as a resource backstop. Neither a clock nor a
 *     length can tell a model working hard from a model stuck, and both were tried.
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
 * ── CONTENT DECIDES, LENGTH ONLY BACKSTOPS ───────────────────────────────────────
 *
 * The budget above is a proxy, and run db88fa5b showed what the proxy costs in both
 * directions: an operator grant waived it and one iteration then spent 80,810 characters
 * and 29 minutes to move a single <div>, while a legitimate 15-minute think would have
 * been killed at 45,000 for the crime of being long. Length is not the pathology. Thinking
 * that goes in circles is, and so is thinking that has lost the thread.
 *
 * So the mid-stream check now SAMPLES THE TEXT every REASONING_SAMPLE_INTERVAL_CHARS and
 * asks whether the model is re-treading ground, and the character ceiling is demoted to a
 * resource backstop sitting far away.
 *
 * WHY REPETITION AND NOT AN LLM JUDGE. The obvious design — hand the reasoning to a model
 * and ask "is this stuck?" — is wrong on this hardware specifically: there is ONE GPU, it
 * is already saturated by the generation being judged, and the judge would be the same
 * model that is stuck. A structural check costs microseconds, needs no GPU, cannot itself
 * hang, and is language-independent — which matters because this repo's tasks arrive in
 * German as often as English and a phrase list would only ever cover one of them.
 *
 * WHAT IS NOT CALIBRATED, STATED PLAINLY. The audit deliberately records reasoningChars but
 * NOT reasoning text ("Preserve observability without persisting provider reasoning"), so
 * there is no stored corpus to fit this threshold against — unlike every other constant in
 * this file, which is derived from measured runs. 0.5 is therefore a deliberately
 * conservative guess: half of a 12,000-character window must be literal re-tread before it
 * counts. It is safe to guess here ONLY because a trip is cheap — the first one hands the
 * run a corrective turn rather than killing it (see REASONING_BURN_RETRY_LIMIT), so a false
 * positive costs one iteration, not the run. If this ever needs tightening, log the ratio
 * on real runs first and fit it; do not nudge the number on a hunch.
 */
export const REASONING_SAMPLE_INTERVAL_CHARS = 2_000;
/** Tail of reasoning examined per sample. Bounds both the work and the memory held. */
export const REASONING_LOOP_WINDOW_CHARS = 12_000;
/** Shingle size. Long enough that ordinary phrase reuse is not a repeat; short enough that
 *  a re-derived paragraph is. */
export const REASONING_LOOP_SHINGLE_CHARS = 120;
/** Below this many shingles the window is too short for the ratio to mean anything. */
export const REASONING_LOOP_MIN_SHINGLES = 40;
/** Fraction of the window that must be duplicated before it reads as circling. */
export const REASONING_LOOP_REPEAT_RATIO = 0.5;

/**
 * ── LOST THE THREAD ──────────────────────────────────────────────────────────────
 *
 * The second pathology, and a different shape from circling: the model took a wrong turn
 * and is now reasoning about something that is not the task. Repetition cannot see it —
 * drifting reasoning is perfectly novel, it is simply about the wrong thing.
 *
 * The signal is lexical coverage of the TASK'S OWN distinctive words in the recent window.
 * Those words are derived at run time from the task text; there is no keyword table, no
 * topic list, and nothing language-specific — which matters because a hardcoded list would
 * cover English and silently fail on the German half of this deployment's traffic. German
 * actually reads BETTER here than English: its compounds ("Spielfeldgrenzen",
 * "Tastatursteuerung") are long, and length is exactly what separates a content word from a
 * function word without needing a stopword list in either language.
 *
 * DELIBERATELY HARD TO TRIP, and MEASURED to still have been too eager. Run d5747607 fired
 * this rule on content_writer 50,045 novel characters (repeat ratio 0.032) into drafting the
 * CSS and JS that would fill its own markers — CSS contains no prose vocabulary, so the rule
 * punished the most productive step in the run and cost ~15 minutes of composition. Two
 * consequences, both load-bearing:
 *
 *   - a code-like window is EXEMPT (looksLikeCode): absence of task words in code is
 *     expected, not evidence of anything;
 *   - drift NEVER aborts mid-stream. A loop is safe to cut because re-tread text is
 *     worthless by definition; drift is not, because the in-flight text may be the
 *     deliverable. It is recorded, logged per iteration, and left to the between-iteration
 *     supervisor, whose stall rule acts where nothing in flight can be destroyed — that
 *     rule independently caught the same run.
 *
 * It still requires a full window, essentially no anchors present, and
 * REASONING_DRIFT_SUSTAINED_SAMPLES consecutive samples. Uncalibrated; coverage is logged.
 */
export const REASONING_ANCHOR_MIN_CHARS = 5;
/** Cap on anchors kept. The longest words are the most distinctive; more adds noise. */
export const REASONING_ANCHOR_MAX_TERMS = 40;
/** At or below this fraction of anchors present, the window is not about the task. */
export const REASONING_DRIFT_COVERAGE = 0.05;
/** Consecutive drifting samples before it latches. One tangent is not lost. */
export const REASONING_DRIFT_SUSTAINED_SAMPLES = 3;

/**
 * Is this window code/markup rather than prose?
 *
 * Density of the characters that structure code — braces, brackets, semicolons, angle
 * brackets, colons, equals — against total length. Prose uses them sparingly; a CSS block,
 * a JS function or an HTML fragment cannot avoid them. Language-independent by construction,
 * since it reads punctuation rather than words.
 *
 * The threshold is deliberately low (3%): the cost of treating composition as prose is a
 * false drift trip that destroys in-flight work, while the cost of treating prose as code is
 * only that the drift rule stays quiet. The asymmetry is the whole point.
 */
export const CODE_SYMBOL_DENSITY = 0.03;

export function looksLikeCode(window: string): boolean {
  if (window.length === 0) return false;
  let symbols = 0;
  for (const ch of window) {
    if (ch === "{" || ch === "}" || ch === ";" || ch === "<" || ch === ">" || ch === "=" || ch === "(" || ch === ")") symbols++;
  }
  return symbols / window.length >= CODE_SYMBOL_DENSITY;
}

/**
 * The task's own distinctive words — the vocabulary a run that is still on task keeps using.
 *
 * Length filter instead of a stopword list, on purpose: "the/and/for/der/die/und/ist" are
 * short in both languages this deployment sees, while content words are not. Longest first
 * so the cap keeps the most distinctive terms rather than an arbitrary slice.
 */
export function deriveTaskAnchors(taskText: string): string[] {
  const seen = new Set<string>();
  for (const raw of taskText.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= REASONING_ANCHOR_MIN_CHARS) seen.add(raw);
  }
  return [...seen].sort((a, b) => b.length - a.length).slice(0, REASONING_ANCHOR_MAX_TERMS);
}

/**
 * Has this window stopped being about the task?
 *
 * Coverage is the fraction of the task's anchors that appear anywhere in the window. Pure;
 * returns the number as well as the verdict so it can be logged and later fitted.
 */
export function detectReasoningDrift(
  anchors: readonly string[],
  window: string,
): { drifting: boolean; coverage: number } {
  // Too few anchors to judge — a one-line task has no vocabulary to lose.
  if (anchors.length < 5 || window.length < REASONING_LOOP_WINDOW_CHARS) {
    return { drifting: false, coverage: 1 };
  }
  // COMPOSING THE ARTIFACT IS NOT LOSING THE THREAD, and this guard is the whole reason
  // this rule is safe to have at all. Run d5747607 measured the alternative: content_writer
  // read the half-built file, then spent 50,045 novel characters (repeat ratio 0.032)
  // drafting the CSS and JS to fill its markers — and was aborted for drift, because CSS
  // and JS contain none of a task's PROSE vocabulary. The rule punished the single most
  // productive step in the run and threw away ~15 minutes of composition.
  //
  // Code is separable from prose without knowing any language: it is dense in symbols that
  // prose barely uses. When the window looks like code, the anchor rule simply does not
  // apply — absence of task words there is expected, not evidence of anything.
  if (looksLikeCode(window)) return { drifting: false, coverage: 1 };
  const haystack = window.toLowerCase();
  let hits = 0;
  for (const anchor of anchors) {
    if (haystack.includes(anchor)) hits++;
  }
  const coverage = hits / anchors.length;
  return { drifting: coverage <= REASONING_DRIFT_COVERAGE, coverage };
}

/**
 * Absolute ceiling on one generation's reasoning — a RESOURCE backstop, not the policy.
 *
 * The policy is detectReasoningLoop. This exists so a single stream cannot consume
 * unbounded wall-clock and GPU if the loop detector never fires (novel text forever), and
 * it is set far above anything measured: the worst observed run was 80,810 characters, so
 * 300,000 is ~3.7x that and roughly 100 minutes at the measured 16.8 tok/s. A run that
 * reaches it is not "thinking too long", it is a run nobody is going to want the answer to.
 */
export const REASONING_ABSOLUTE_CEILING_CHARS = 300_000;

/**
 * Is this reasoning going in circles?
 *
 * Shingles the tail of the text and measures how much of it is duplicate. Normalization is
 * lowercase + whitespace collapse and nothing else: no stemming, no stopwords, no language
 * assumptions. Pure and allocation-light — hashes are computed over the character stream
 * rather than by slicing substrings, so a sample costs one pass over at most
 * REASONING_LOOP_WINDOW_CHARS.
 *
 * Returns the ratio as well as the verdict so a caller can log what it saw; the number is
 * the evidence anyone tightening the threshold will need.
 */
export function detectReasoningLoop(text: string): { looping: boolean; repeatRatio: number; shingles: number } {
  const normalized = text.slice(-REASONING_LOOP_WINDOW_CHARS).toLowerCase().replace(/\s+/g, " ");
  const total = normalized.length - REASONING_LOOP_SHINGLE_CHARS + 1;
  if (total < REASONING_LOOP_MIN_SHINGLES) {
    return { looping: false, repeatRatio: 0, shingles: Math.max(0, total) };
  }

  // EVERY offset, not every Nth. A strided scan only sees repeats whose period happens to be
  // a multiple of the stride: the first version of this used stride 60 and scored a fixture
  // that was 98% duplicate at ratio 0.0, because the repeating block was ~350 characters and
  // no two sampled offsets ever landed on the same phase. A rolling hash makes stride 1 cost
  // one multiply-add per character, so there is no reason to sample at all.
  const BASE = 131;
  let removeFactor = 1;
  for (let i = 1; i < REASONING_LOOP_SHINGLE_CHARS; i++) removeFactor = Math.imul(removeFactor, BASE) >>> 0;

  let hash = 0;
  for (let i = 0; i < REASONING_LOOP_SHINGLE_CHARS; i++) {
    hash = (Math.imul(hash, BASE) + normalized.charCodeAt(i)) >>> 0;
  }
  const seen = new Set<number>([hash]);
  for (let i = REASONING_LOOP_SHINGLE_CHARS; i < normalized.length; i++) {
    const outgoing = Math.imul(normalized.charCodeAt(i - REASONING_LOOP_SHINGLE_CHARS), removeFactor) >>> 0;
    hash = (Math.imul((hash - outgoing) >>> 0, BASE) + normalized.charCodeAt(i)) >>> 0;
    seen.add(hash);
  }

  const repeatRatio = 1 - (seen.size / total);
  return { looping: repeatRatio >= REASONING_LOOP_REPEAT_RATIO, repeatRatio, shingles: total };
}

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
    // BACKSTOP, NOT POLICY. This arm sees only counters — it runs between iterations and
    // has no reasoning text to judge — so it can no longer be the thing that decides a run
    // is stuck. That decision moved into the stream, where the text is (detectReasoningLoop).
    // What is left here is a resource ceiling: a cold run reaching it has consumed a fleet's
    // worth of GPU without producing anything, and that is worth stopping whatever it says.
    if (cur.reasoningChars >= REASONING_ABSOLUTE_CEILING_CHARS) {
      const wrote = cur.outputChars >= MIN_SUBSTANTIVE_OUTPUT_CHARS;
      return {
        action: wrote ? "ask" : "wind_down",
        verdict: "burning",
        consecutiveStalls: 0,
        reason: `${cur.reasoningChars} reasoning chars with no productive tool call and no workspace change `
          + `(ceiling ${REASONING_ABSOLUTE_CEILING_CHARS}, output ${cur.outputChars} chars) — `
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
