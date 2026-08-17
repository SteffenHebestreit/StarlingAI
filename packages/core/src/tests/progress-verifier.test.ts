import { describe, expect, it } from "vitest";
import {
  classifyRunProgress,
  classifyWriteLoop,
  hasForwardProgress,
  buildProgressJudgePrompt,
  parseProgressVerdict,
  COLD_START_REASONING_BUDGET_CHARS,
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
    expect(openingThink.reasoningChars).toBeLessThan(COLD_START_REASONING_BUDGET_CHARS);
  });

  it("keeps a healthy margin over the healthy run and under both pathologies", () => {
    // The budget is only defensible if it sits between the measured shapes. If a future
    // edit narrows either margin this fails loudly rather than silently killing runs.
    expect(COLD_START_REASONING_BUDGET_CHARS / 23_876).toBeGreaterThan(1.5);
    expect(COLD_START_REASONING_BUDGET_CHARS / 60_385).toBeLessThan(0.8);
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

  it("stops ephemeral for burning, ~5 minutes before it actually died", () => {
    const { decisions, stoppedAtWindow } = replay(EPHEMERAL_BAD);
    expect(stoppedAtWindow).not.toBeNull();
    expect(decisions.at(-1)!.verdict).toBe("burning");
    expect(decisions.at(-1)!.action).toBe("wind_down");
    // It ran 20 min; the budget bites the window after reasoning crosses 45,000 — 15 min in.
    const stoppedAtMin = (stoppedAtWindow! * WINDOW_S) / 60;
    expect(stoppedAtMin).toBe(15);
  });

  it("does not let a 37-character result buy the burner an exemption", () => {
    // The zero-tool run's entire output was 37 chars. Treating any output at all as
    // "it produced something" would have downgraded this to a dock prompt.
    expect(EPHEMERAL_BAD.at(-1)!.outputChars).toBeLessThan(MIN_SUBSTANTIVE_OUTPUT_CHARS);
    const d = classifyRunProgress(EMPTY_PROGRESS_SAMPLE, EPHEMERAL_BAD.at(-1)!, 0);
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
    // The new rule stops it. Same fixture, opposite verdict — the signal, not the test, is doing the work.
    expect(replay(EPHEMERAL_BAD).stoppedAtWindow).not.toBeNull();
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

  it("raising the budget past the measured pathologies un-stops the burner", () => {
    // Proves the 45,000 threshold — not merely the arm's existence — is load-bearing.
    const overBudget = EPHEMERAL_BAD.filter((s) => s.reasoningChars >= COLD_START_REASONING_BUDGET_CHARS);
    expect(overBudget.length).toBeGreaterThan(0);
    const stillUnderARaisedBudget = EPHEMERAL_BAD.filter((s) => s.reasoningChars >= 70_000);
    expect(stillUnderARaisedBudget).toHaveLength(0);
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
    const writer = sample({ reasoningChars: 60_000, outputChars: 40_000 });
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
