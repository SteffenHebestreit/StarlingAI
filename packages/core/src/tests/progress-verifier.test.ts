import { describe, expect, it } from "vitest";
import {
  classifyRunProgress,
  classifyWriteLoop,
  hasForwardProgress,
  buildProgressJudgePrompt,
  parseProgressVerdict,
  REASONING_ABSOLUTE_CEILING_CHARS,
  detectReasoningLoop,
  EMPTY_PROGRESS_SAMPLE,
  MIN_SUBSTANTIVE_OUTPUT_CHARS,
  PROGRESS_CHECK_INTERVAL_MS,
  STALL_LIMIT,
  type ProgressDecision,
  type ProgressSample,
} from "../agent/progress-verifier.js";

/**
 * The progress supervisor — the thing that replaces the static budget limits.
 *
 * The fixtures below are the three MEASURED runs, not synthetic shapes. Every
 * static limit in this area shipped green and inert because its test supplied the
 * numbers it was meant to be testing; these instead replay real counter sequences
 * and assert the policy separates them.
 *
 *   backend_coder  HEALTHY  13 iterations, 15 tool calls, 5 files, 26.9 min.
 *                           MUST NOT trip any detector.
 *   content_writer BAD      64,587 reasoning chars, 1 tool call, 28.8 min, no artifact.
 *   ephemeral      BAD      60,385 reasoning chars, 0 tool calls, 20 min, 37-char result.
 *                           Both MUST be stopped, and well before they actually died.
 */

const WINDOW_S = PROGRESS_CHECK_INTERVAL_MS / 1000;

/** Replay a sampled run through the supervisor exactly as the sub-agent loop does. */
function replay(samples: readonly ProgressSample[]): { decisions: ProgressDecision[]; stoppedAtWindow: number | null } {
  let prev = EMPTY_PROGRESS_SAMPLE;
  let stalls = 0;
  const decisions: ProgressDecision[] = [];
  let stoppedAtWindow: number | null = null;
  samples.forEach((cur, i) => {
    if (stoppedAtWindow !== null) return;
    const d = classifyRunProgress(prev, cur, stalls);
    stalls = d.consecutiveStalls;
    prev = cur;
    decisions.push(d);
    if (d.action === "wind_down") stoppedAtWindow = i;
  });
  return { decisions, stoppedAtWindow };
}

const sample = (s: Partial<ProgressSample>): ProgressSample => ({ ...EMPTY_PROGRESS_SAMPLE, ...s });

// ── Fixture 1: backend_coder, the healthy run ────────────────────────────────
//
// Per-iteration reasoning was 23,876 then 93, 150, 259, 120, 302, 923, 83, 1300,
// 371, 352, 334, 56, 552 — 28,771 chars in total, almost all of it in the opening
// think. Tool calls landed in nearly every iteration; 5 files were written and 3
// edit_file corrections applied, each with different content.
const BACKEND_CODER_HEALTHY: ProgressSample[] = [
  // First ~8 minutes are ONE iteration of pure reasoning: nothing has returned yet,
  // so every counter — including reasoningChars — is still zero.
  sample({}),
  sample({}),
  sample({}),
  // Iteration 1 returns: the whole 23,876-char think lands at once, with its tool call.
  sample({ productiveToolCalls: 1, reasoningChars: 23_876 }),
  sample({ productiveToolCalls: 3, mutatedPaths: 1, distinctWriteHashes: 1, reasoningChars: 24_400, outputChars: 900 }),
  sample({ productiveToolCalls: 5, mutatedPaths: 2, distinctWriteHashes: 2, reasoningChars: 25_800, outputChars: 1_800 }),
  sample({ productiveToolCalls: 8, mutatedPaths: 3, distinctWriteHashes: 3, reasoningChars: 27_100, outputChars: 2_600 }),
  sample({ productiveToolCalls: 10, mutatedPaths: 4, distinctWriteHashes: 5, reasoningChars: 27_800, outputChars: 3_400 }),
  sample({ productiveToolCalls: 13, mutatedPaths: 5, distinctWriteHashes: 7, reasoningChars: 28_200, outputChars: 4_100 }),
  sample({ productiveToolCalls: 15, mutatedPaths: 5, distinctWriteHashes: 8, reasoningChars: 28_771, outputChars: 5_200 }),
];

// ── Fixture 2: content_writer, 1 tool call then 28.8 minutes of nothing ──────
const CONTENT_WRITER_BAD: ProgressSample[] = [
  sample({}),
  // read_shared_facts lands early. That is the ONLY thing this run ever did.
  sample({ productiveToolCalls: 1, reasoningChars: 7_000 }),
  sample({ productiveToolCalls: 1, reasoningChars: 14_500 }),
  sample({ productiveToolCalls: 1, reasoningChars: 21_800 }),
  sample({ productiveToolCalls: 1, reasoningChars: 29_000 }),
  sample({ productiveToolCalls: 1, reasoningChars: 36_400 }),
  sample({ productiveToolCalls: 1, reasoningChars: 43_900 }),
  sample({ productiveToolCalls: 1, reasoningChars: 51_200 }),
  sample({ productiveToolCalls: 1, reasoningChars: 58_100 }),
  sample({ productiveToolCalls: 1, reasoningChars: 64_587 }),
];

// ── Fixture 3: ephemeral, zero tool calls, 37-char result ────────────────────
const EPHEMERAL_BAD: ProgressSample[] = [
  sample({}),
  sample({ reasoningChars: 9_000 }),
  sample({ reasoningChars: 18_100 }),
  sample({ reasoningChars: 27_300 }),
  sample({ reasoningChars: 36_200 }),
  sample({ reasoningChars: 45_400 }),
  sample({ reasoningChars: 54_000 }),
  sample({ reasoningChars: 60_385, outputChars: 37 }),
];

describe("progress supervisor — the healthy run must survive every rule", () => {
  it("never stops backend_coder, and never even flags it", () => {
    const { decisions, stoppedAtWindow } = replay(BACKEND_CODER_HEALTHY);
    expect(stoppedAtWindow).toBeNull();
    expect(decisions).toHaveLength(BACKEND_CODER_HEALTHY.length);
    expect(decisions.every((d) => d.action === "continue")).toBe(true);
    expect(decisions.every((d) => d.verdict === "on_track")).toBe(true);
  });

  it("leaves the 23,876-char opening think alone — the shape a 2-minute clock would have killed", () => {
    // The single most important assertion in this file. At the moment this sample is
    // taken the healthy run is ~7.9 minutes in (23,876 chars at the measured ~16.8
    // completion tok/s) with ZERO tool calls and ZERO output — indistinguishable, on a
    // wall clock, from the two runs below. It went on to make 15 tool calls and write
    // 5 files.
    const openingThink = sample({ reasoningChars: 23_876 });
    const d = classifyRunProgress(EMPTY_PROGRESS_SAMPLE, openingThink, 0);
    expect(d.action).toBe("continue");
    expect(openingThink.reasoningChars).toBeLessThan(REASONING_ABSOLUTE_CEILING_CHARS);
  });

  it("the ceiling sits FAR above every measured shape — it is a backstop, not a classifier", () => {
    // This assertion used to say the opposite: that 45,000 sat BETWEEN the healthy run and
    // the pathologies, because length was how the two were told apart. It no longer is.
    // Length cannot distinguish them without also killing long honest work, so the decision
    // moved into the stream where the reasoning TEXT is (detectReasoningLoop, and see
    // reasoning-loop-detector.test.ts for the separation that replaced this one). What is
    // left here must clear every measured shape by a wide margin, or it is still a classifier.
    for (const measured of [23_876, 60_385, 64_587, 80_810]) {
      expect(REASONING_ABSOLUTE_CEILING_CHARS / measured).toBeGreaterThan(3);
    }
  });

  it("does not stall a run that is emitting content without calling tools", () => {
    // A long legitimate writing pass is a content stream with no tool call in it.
    const a = sample({ productiveToolCalls: 2, mutatedPaths: 1, outputChars: 4_000 });
    const b = sample({ productiveToolCalls: 2, mutatedPaths: 1, outputChars: 12_000 });
    expect(hasForwardProgress(a, b)).toBe(true);
    expect(classifyRunProgress(a, b, STALL_LIMIT).action).toBe("continue");
  });

  it("tolerates one quiet window before it counts a stall", () => {
    const a = sample({ productiveToolCalls: 4, mutatedPaths: 2 });
    const d = classifyRunProgress(a, a, 0);
    expect(d.action).toBe("continue");
    expect(d.consecutiveStalls).toBe(1);
  });
});

describe("progress supervisor — both pathologies must be stopped, early", () => {
  it("stops content_writer for stalling, ~20 minutes before it actually died", () => {
    const { decisions, stoppedAtWindow } = replay(CONTENT_WRITER_BAD);
    expect(stoppedAtWindow).not.toBeNull();
    expect(decisions.at(-1)!.verdict).toBe("stalled");
    expect(decisions.at(-1)!.action).toBe("wind_down");
    // It ran 28.8 min. Two stall windows after its single early tool call puts the
    // intervention at 9 minutes — sample i is taken at t = i * window.
    const stoppedAtMin = (stoppedAtWindow! * WINDOW_S) / 60;
    expect(stoppedAtMin).toBe(9);
  });

  it("still stops a cold run that reaches the RESOURCE ceiling", () => {
    // The measured ephemeral run (60,385 chars) no longer trips this arm — see the
    // deliberate-weakening test below, and reasoning-loop-detector.test.ts for where that
    // decision now lives. What must remain true is that the backstop is connected: a cold
    // run consuming ceiling-scale reasoning with nothing to show is still wound down.
    const atCeiling = EPHEMERAL_BAD.map((sm) => sample({
      ...sm,
      reasoningChars: sm.reasoningChars * 6,
    }));
    const { decisions, stoppedAtWindow } = replay(atCeiling);
    expect(atCeiling.at(-1)!.reasoningChars).toBeGreaterThan(REASONING_ABSOLUTE_CEILING_CHARS);
    expect(stoppedAtWindow).not.toBeNull();
    expect(decisions.at(-1)!.verdict).toBe("burning");
    expect(decisions.at(-1)!.action).toBe("wind_down");
  });

  it("does not let a 37-character result buy the burner an exemption", () => {
    // The zero-tool run's entire output was 37 chars. Treating any output at all as
    // "it produced something" would have downgraded this to a dock prompt.
    expect(EPHEMERAL_BAD.at(-1)!.outputChars).toBeLessThan(MIN_SUBSTANTIVE_OUTPUT_CHARS);
    // Scaled to the backstop, since that is the magnitude this arm now judges at. The rule
    // under test is unchanged: a token of output must not buy an exemption from it.
    const atCeiling = sample({ ...EPHEMERAL_BAD.at(-1)!, reasoningChars: REASONING_ABSOLUTE_CEILING_CHARS + 1 });
    const d = classifyRunProgress(EMPTY_PROGRESS_SAMPLE, atCeiling, 0);
    expect(d.action).toBe("wind_down");
  });
});

describe("progress supervisor — discrimination proof (revert the fix, watch it fail)", () => {
  /**
   * The REVERTED rule, reproduced verbatim from the code this replaced:
   *   isHardStall = cur.completionTokens <= prev.completionTokens && cur.toolCalls <= prev.toolCalls
   * with completionTokens as the provider actually reports it — the salvage path
   * reconstructs it from reasoning characters at 3 chars/token, and LM Studio counts
   * reasoning inside completion_tokens on the normal path too.
   */
  const revertedIsHardStall = (prev: ProgressSample, cur: ProgressSample): boolean => {
    const tokensOf = (s: ProgressSample) => Math.round(s.reasoningChars / 3) + Math.round(s.outputChars / 3);
    return tokensOf(cur) <= tokensOf(prev) && cur.productiveToolCalls <= prev.productiveToolCalls;
  };

  it("the old rule sees the zero-tool burner as FORWARD PROGRESS at every single window", () => {
    // This is why the pathology ran the full 20 minutes: a 60,385-char monologue
    // back-fills ~20,000 "completion tokens", so the counter the old guard trusted was
    // climbing the entire time. Not one window read as a stall.
    for (let i = 1; i < EPHEMERAL_BAD.length; i++) {
      expect(revertedIsHardStall(EPHEMERAL_BAD[i - 1]!, EPHEMERAL_BAD[i]!)).toBe(false);
    }
    // WHERE THE DECISION WENT. The counter-based rule no longer stops this either — not
    // because it regressed, but because volume was never the distinguishing fact: the same
    // 60,385 characters could be a model circling or a model doing hard work, and this arm
    // cannot see which. The signal that CAN see it reads the reasoning text, so the proof
    // moved with it: identical volume, opposite verdict, decided on content.
    expect(replay(EPHEMERAL_BAD).stoppedAtWindow).toBeNull();

    const circling = Array.from({ length: 60 }, () =>
      "Wait, let me reconsider the rotation. The SRS kick table for the J piece has five "
      + "offsets and I must apply them in order against the board bounds before accepting it. "
      + "Actually, let me reconsider the rotation. The SRS kick table has five offsets.").join("\n");
    const working = Array.from({ length: 400 }, (_, i) =>
      `Step ${i}: column ${i % 10} maps to offset ${i * 3}, kick entry ${i % 4}, wall bound `
      + `${320 - i}; the pivot moved ${i} units since the last case.`).join("\n");

    expect(circling.length).toBeGreaterThan(10_000);
    expect(working.length).toBeGreaterThan(10_000);
    expect(detectReasoningLoop(circling).looping).toBe(true);
    expect(detectReasoningLoop(working).looping).toBe(false);
  });

  it("the old rule sees the 28-minute content_writer stall as FORWARD PROGRESS too", () => {
    for (let i = 1; i < CONTENT_WRITER_BAD.length; i++) {
      expect(revertedIsHardStall(CONTENT_WRITER_BAD[i - 1]!, CONTENT_WRITER_BAD[i]!)).toBe(false);
    }
    expect(replay(CONTENT_WRITER_BAD).stoppedAtWindow).not.toBeNull();
  });

  it("counting reasoning as progress (the reverted definition) un-stops both pathologies", () => {
    // Mutate the one line that matters — put reasoningChars back into the progress
    // expression — and the supervisor goes blind to both runs. Nothing else changes.
    const revertedHasForwardProgress = (prev: ProgressSample, cur: ProgressSample): boolean =>
      hasForwardProgress(prev, cur) || cur.reasoningChars > prev.reasoningChars;
    for (const fixture of [CONTENT_WRITER_BAD, EPHEMERAL_BAD]) {
      for (let i = 1; i < fixture.length; i++) {
        expect(revertedHasForwardProgress(fixture[i - 1]!, fixture[i]!)).toBe(true);
      }
    }
  });

  it("no longer stops the 60,385-char burner between iterations — and that is deliberate", () => {
    // A DELIBERATE WEAKENING, recorded so nobody re-tightens it by accident. This arm reads
    // counters only; it cannot see whether that reasoning was circling or productive, and
    // stopping on volume alone is what would have killed a 15-minute honest think. The
    // measured ephemeral pathology therefore passes here now, and is caught upstream instead:
    // the provider samples the reasoning text mid-stream and aborts when it repeats.
    const worstMeasured = Math.max(...EPHEMERAL_BAD.map((s) => s.reasoningChars));
    expect(worstMeasured).toBeGreaterThan(45_000);
    expect(worstMeasured).toBeLessThan(REASONING_ABSOLUTE_CEILING_CHARS);
    for (const s of EPHEMERAL_BAD) {
      expect(classifyRunProgress(EMPTY_PROGRESS_SAMPLE, s, 0).action).not.toBe("wind_down");
    }
  });

  it("a wall-clock rule short enough to catch them would have killed the healthy run", () => {
    // The brief's "detectable within two minutes" as a THRESHOLD, tested. At the 2-minute
    // mark all three runs are byte-identical in every counter the supervisor can read.
    const atTwoMinutes = (f: readonly ProgressSample[]) => f[0]!;
    expect(atTwoMinutes(BACKEND_CODER_HEALTHY)).toEqual(atTwoMinutes(EPHEMERAL_BAD));
    expect(atTwoMinutes(BACKEND_CODER_HEALTHY)).toEqual(atTwoMinutes(CONTENT_WRITER_BAD));
  });
});

describe("progress supervisor — ambiguous shapes go to the dock, not to a kill", () => {
  it("asks instead of stopping when a run has written files and gone quiet", () => {
    // It may legitimately be verifying. A run that has written NOTHING is not ambiguous.
    const quiet = sample({ productiveToolCalls: 9, mutatedPaths: 3, distinctWriteHashes: 4, reasoningChars: 50_000 });
    expect(classifyRunProgress(quiet, quiet, STALL_LIMIT - 1).action).toBe("ask");
  });

  it("asks instead of stopping when a tool-less run is over budget but genuinely emitting", () => {
    // Scaled to BACKSTOP magnitude on purpose: this arm is no longer a classifier at
    // 45,000, so the measured 60,000 no longer reaches it. What is still worth asserting is
    // the arm's SHAPE — a tool-less run that is nonetheless emitting real output is
    // ambiguous (it may be a legitimate writer) and goes to the dock rather than being cut.
    const writer = sample({ reasoningChars: REASONING_ABSOLUTE_CEILING_CHARS + 1, outputChars: 40_000 });
    const d = classifyRunProgress(EMPTY_PROGRESS_SAMPLE, writer, 0);
    expect(d.action).toBe("ask");
    expect(d.verdict).toBe("burning");
  });
});

describe("progress supervisor — write-loop detection by content hash", () => {
  it("passes the healthy run's three corrections to one file (different content each time)", () => {
    const history: string[] = [];
    for (const h of ["a1", "b2", "c3"]) {
      expect(classifyWriteLoop(history, h)).toBeNull();
      history.push(h);
    }
  });

  it("catches a byte-identical rewrite the model keeps re-issuing", () => {
    expect(classifyWriteLoop(["a1", "a1"], "a1")).toBe("identical_rewrite");
  });

  it("allows a single revert (A->B->A) — blocking it would strand the bad content on disk", () => {
    expect(classifyWriteLoop(["a1", "b2"], "a1")).toBeNull();
  });

  it("catches the actual flip-flop (A->B->A->B)", () => {
    expect(classifyWriteLoop(["a1", "b2", "a1"], "b2")).toBe("content_oscillation");
  });

  it("does not fire on the first two writes to a fresh path", () => {
    expect(classifyWriteLoop([], "a1")).toBeNull();
    expect(classifyWriteLoop(["a1"], "b2")).toBeNull();
  });

  it("the reverted flat cap of 2 would have blocked the healthy run's third correction", () => {
    // The rule this replaced was `perPathWrites >= 2 -> block`, which stopped the third
    // edit_file regardless of content — including the one where the agent caught its own
    // line-clear index bug.
    const revertedFlatCap = (writes: number) => writes >= 2;
    expect(revertedFlatCap(2)).toBe(true);
    expect(classifyWriteLoop(["a1", "b2"], "c3")).toBeNull();
  });
});

describe("progress supervisor — constants", () => {
  it("ships sane window/limit constants", () => {
    expect(PROGRESS_CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(60_000);
    expect(STALL_LIMIT).toBeGreaterThanOrEqual(2);
    expect(MIN_SUBSTANTIVE_OUTPUT_CHARS).toBeGreaterThan(0);
  });
});

describe("progress-verifier — judge prompt", () => {
  it("includes the objective, recent activity, and acceptance criteria", () => {
    const msgs = buildProgressJudgePrompt({
      objective: "Write a 5-section market report on EU heat pumps.",
      acceptanceCriteria: ["all 5 sections present", "sources cited"],
      recentActivity: "Latest output: ## Section 1 …\n\nRecent tool calls: web_search, web_fetch",
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toMatch(/strict json/i);
    const user = String(msgs[1]!.content);
    expect(user).toContain("EU heat pumps");
    expect(user).toContain("all 5 sections present");
    expect(user).toContain("web_search");
  });
  it("omits the criteria block when none are given", () => {
    const msgs = buildProgressJudgePrompt({ objective: "Do the thing.", recentActivity: "working…" });
    expect(String(msgs[1]!.content)).not.toMatch(/done correctly/i);
  });
});

describe("progress-verifier — verdict parser (fail-open)", () => {
  it("reads a clean drifting verdict with its reason", () => {
    const r = parseProgressVerdict('{"verdict":"drifting","reason":"keeps re-summarising the same section"}');
    expect(r.verdict).toBe("drifting");
    expect(r.reason).toContain("re-summarising");
  });
  it("reads a drifting verdict embedded in surrounding prose", () => {
    const r = parseProgressVerdict('Here is my assessment:\n{"verdict":"drifting","reason":"wrong topic"}\nThanks.');
    expect(r.verdict).toBe("drifting");
  });
  it("reads an on_track verdict", () => {
    expect(parseProgressVerdict('{"verdict":"on_track","reason":"steadily drafting sections"}').verdict).toBe("on_track");
  });
  it("defaults to on_track for empty / undefined / non-JSON replies (never stops a healthy run)", () => {
    expect(parseProgressVerdict(undefined).verdict).toBe("on_track");
    expect(parseProgressVerdict("").verdict).toBe("on_track");
    expect(parseProgressVerdict("the agent seems fine to me").verdict).toBe("on_track");
  });
  it("defaults to on_track for malformed JSON (fail-open, no throw)", () => {
    expect(parseProgressVerdict('{"verdict":"drifting", reason:').verdict).toBe("on_track");
  });
  it("treats an unknown verdict value as on_track (only explicit drifting stops a run)", () => {
    expect(parseProgressVerdict('{"verdict":"confused"}').verdict).toBe("on_track");
  });
});

/**
 * COMPOSING A LARGE EDIT IS NOT STALLING — the third time this same productive step was
 * killed by a different rule, and the reason it kept happening.
 *
 * Run d5747607: web_coder read the half-built artifact, then spent ~17 minutes in ONE
 * generation drafting the fills. Every counter the supervisor reads only moves when a call
 * RETURNS, so two 180s windows saw nothing move and wound the run down mid-composition.
 * A round earlier the identical step was aborted by drift; before that, by a character
 * budget. Three rules, one blind spot: a model that is writing is invisible to a sampler
 * that only watches for finished work.
 *
 * The old design deliberately refused to count tokens as progress, and was RIGHT to at the
 * time — a 60,385-char monologue back-fills ~20,000 tokens, so a burner never looked stalled
 * either. What changed is that the stream is now judged on content: a circling generation is
 * aborted before it can earn credit here, so "tokens are arriving" finally means work.
 */
describe("progress supervisor — a streaming generation is work in progress", () => {
  it("does NOT stall a run whose in-flight generation is producing novel text", () => {
    const composing = (chars: number) => sample({
      productiveToolCalls: 3, // it read the file first — so the WARM arm applies
      liveReasoningChars: chars,
    });
    // Two consecutive windows with no returned call — exactly the shape that was wound down.
    const w1 = composing(9_000);
    const w2 = composing(18_000);
    expect(hasForwardProgress(w1, w2)).toBe(true);
    expect(classifyRunProgress(w1, w2, STALL_LIMIT).action).toBe("continue");
  });

  it("STILL stalls when the generation is circling — the old hole stays shut", () => {
    // THE DISCRIMINATOR. Identical token growth; only the content verdict differs. Without
    // the liveLoopSuspected gate this rule would re-open the exact hole the counter-based
    // guard had, where a monologue's climbing counter read as progress forever.
    const circling = (chars: number) => sample({
      productiveToolCalls: 3,
      liveReasoningChars: chars,
      liveLoopSuspected: true,
    });
    const w1 = circling(9_000);
    const w2 = circling(18_000);
    expect(hasForwardProgress(w1, w2)).toBe(false);
    expect(classifyRunProgress(w1, w2, STALL_LIMIT).action).not.toBe("continue");
  });

  it("a generation that produces almost nothing between windows is still a stall", () => {
    const barely = (chars: number) => sample({ productiveToolCalls: 3, liveReasoningChars: chars });
    expect(hasForwardProgress(barely(9_000), barely(9_050))).toBe(false);
  });
});
