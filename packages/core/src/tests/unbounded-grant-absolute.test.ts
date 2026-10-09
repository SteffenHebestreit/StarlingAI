/**
 * The operator's unbounded grant is ABSOLUTE.
 *
 * Audit 3959f3ac is the whole reason this file exists:
 *   07:35:17  long_running_generation_requested  { elapsedMs: 521233, blocking: false }
 *   07:35:24  long_running_generation_resolved   { outcome: "unbounded", operator: "steffen" }
 *   07:54:36  turn_timeout_recovered             { timeoutMs: 1800000 }
 * The operator personally granted an unbounded budget through the dock and an enclosing
 * timer killed the run 19 minutes later. The grant reached the sub-agent's own deadline
 * and stopped there — it did not propagate to the gateway turn budget, the runtime turn
 * deadline, or the provider stream cap.
 *
 * Every test here is written so that REVERTING the fix it covers makes it fail; the
 * revert is recorded above each block, because in this area four separate fixes have now
 * shipped inert under a green suite. Nothing below hand-supplies the value it is testing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../audit/logger.js", () => ({ logAudit: vi.fn() }));

import { longRunningGenerationManager } from "../agent/long-running-generation.js";
import { LMStudioProvider, type StreamChunk } from "../providers/lmstudio.js";
import { MAX_STREAM_TOTAL_MS } from "../providers/stream-budget.js";
import {
  MAX_SYNTHESIS_RESERVE_FRACTION,
  resolveDelegationCeilingMs,
  resolveDelegationDeadlineMs,
  SUB_AGENT_MIN_DELEGATION_MS,
} from "../agent/sub-agent-turn-budget.js";
import type { ModelConfig } from "../config/schema.js";

/** The audited turn: a 30-minute gateway budget, the grant landing 521 s in. */
const AUDITED_TURN_BUDGET_MS = 1_800_000;
const AUDITED_GRANT_AT_MS = 521_233;
/** The sub-agent session id shape the manager actually sees (deriveRootSessionId hops). */
const ROOT = "sess-3959f3ac";
const RUN = `sub:${ROOT}:backend_coder:1`;

beforeEach(() => longRunningGenerationManager.resetForTests());
afterEach(() => {
  longRunningGenerationManager.resetForTests();
  vi.restoreAllMocks();
});

/* ────────────────────────────────────────────────────────────────────────────
 * A1 — the grant is readable by the TURN, not only by the run
 * Revert: drop _unboundedRoots / _grantRoot from long-running-generation.ts.
 * ──────────────────────────────────────────────────────────────────────────── */
describe("the grant is scoped to the root turn, not just the run session", () => {
  it("a grant on a nested sub: run id is visible to something holding only the turn id", () => {
    // This is the exact gap that let the timers override the operator: they know
    // `sess-…`, the grant was filed under `sub:sess-…:backend_coder:1`, and nothing
    // bridged the two. `stop` already bridged it via rootOf(); `unbounded` did not.
    longRunningGenerationManager.markUnbounded(RUN);

    expect(longRunningGenerationManager.isUnbounded(RUN)).toBe(true);
    expect(longRunningGenerationManager.isTurnUnbounded(ROOT)).toBe(true);
    // and from any descendant, at any nesting depth
    expect(longRunningGenerationManager.isTurnUnbounded(`sub:${RUN}:writer:2`)).toBe(true);
  });

  it("an operator choosing `unbounded` in the dock grants the turn, not only that run", () => {
    const pending = longRunningGenerationManager.notifyLongRunning({
      agentName: "backend_coder",
      runSessionId: RUN,
      parentSessionId: ROOT,
      reason: "long generation",
      elapsedMs: AUDITED_GRANT_AT_MS,
      completionTokens: 7_799,
      iterations: 1,
    });
    expect(pending.surfaced).toBe(true);

    const id = longRunningGenerationManager.listPending()[0]!.id;
    longRunningGenerationManager.resolveRequest(id, "unbounded", "steffen");

    expect(longRunningGenerationManager.isTurnUnbounded(ROOT)).toBe(true);
  });

  it("announces the grant once, so a timer that cannot poll can suspend itself immediately", () => {
    const seen: string[] = [];
    longRunningGenerationManager.on("lrg:unbounded", (root) => seen.push(root));

    longRunningGenerationManager.markUnbounded(RUN);
    longRunningGenerationManager.markUnbounded(`sub:${ROOT}:content_writer:2`); // same turn

    // The root, not the run id — a listener keyed on its own session id must match.
    expect(seen).toEqual([ROOT]);
  });

  it("is TURN-scoped: cleared, the next turn of the same session is bounded again", () => {
    longRunningGenerationManager.markUnbounded(RUN);
    // Asserted BEFORE the clear, or the case passes on an empty set and proves nothing.
    expect(longRunningGenerationManager.isTurnUnbounded(ROOT)).toBe(true);
    longRunningGenerationManager.clearUnbounded(ROOT);
    expect(longRunningGenerationManager.isTurnUnbounded(ROOT)).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * A4 — the provider stream cap is a NO-SIGNAL backstop
 * Revert: drop `signal === undefined &&` from the cap check in lmstudio.ts.
 * ──────────────────────────────────────────────────────────────────────────── */
const base: ModelConfig = {
  primary: "lmstudio/qwen/qwen3.8-27b",
  contextWindow: 32_768,
  maxTokens: 256,
  temperature: 0,
  enableThinking: false,
};

/** A stream that "takes" `gapMs` between two chunks. Date.now is stubbed, so no real wait. */
function installFakeStream(provider: LMStudioProvider, clock: { now: number }, gapMs: number): void {
  const chunk = (content: string) => ({ choices: [{ delta: { content }, finish_reason: null }] });
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            yield chunk("first pass");
            clock.now += gapMs;
            yield chunk(" second pass");
            yield { choices: [{ delta: {}, finish_reason: "stop" }] };
          },
        }),
      },
    },
  };
}

async function drain(provider: LMStudioProvider, signal?: AbortSignal): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of provider.stream([{ role: "user", content: "build it" }], [], signal)) out.push(c);
  return out;
}

describe("the provider total-stream cap only bounds a caller that states NO deadline", () => {
  // Well past the cap in both cases, so nothing here passes by being under a threshold.
  const RUNAWAY_MS = MAX_STREAM_TOTAL_MS + 600_000;

  it("still stops a caller that passed no signal at all — the case the backstop is FOR", () => {
    const clock = { now: Date.now() };
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    const provider = new LMStudioProvider("http://localhost:1234/v1", "k", base, { maxRetries: 0 });
    installFakeStream(provider, clock, RUNAWAY_MS);

    return expect(drain(provider)).rejects.toThrow(/exceeded its total budget/);
  });

  it("does NOT stop the identical generation when the caller holds a signal", async () => {
    // A granted-unbounded run reaches the provider with its composed (never-aborted)
    // signal. Before this gate that signal was irrelevant here and the run died anyway —
    // this was the LAST wall clock able to override the operator.
    const clock = { now: Date.now() };
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    const provider = new LMStudioProvider("http://localhost:1234/v1", "k", base, { maxRetries: 0 });
    installFakeStream(provider, clock, RUNAWAY_MS);

    const chunks = await drain(provider, new AbortController().signal);

    const text = chunks.filter((c) => c.type === "text_delta").map((c) => c.content).join("");
    expect(text).toBe("first pass second pass");
    expect(chunks.at(-1)?.finishReason).toBe("stop");
  });

  it("an ABORTED signal still tears the stream down — the gate is not a way to ignore a cancel", () => {
    const clock = { now: Date.now() };
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    const provider = new LMStudioProvider("http://localhost:1234/v1", "k", base, { maxRetries: 0 });
    installFakeStream(provider, clock, 1_000);
    const ac = new AbortController();
    ac.abort(new Error("operator cancel"));

    return expect(drain(provider, ac.signal)).rejects.toThrow(/operator cancel/);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * E18 — the silence floor is not waived for a remote endpoint
 * Revert: restore `const floor = opts.locallyServed === false ? 0 : MIN_PROVIDER_SILENCE_MS`.
 * ──────────────────────────────────────────────────────────────────────────── */
describe("the per-chunk silence budget does not depend on where the model is hosted", () => {
  it("a self-hosted thinking model behind a PUBLIC hostname keeps the full silence floor", () => {
    // The old rule classified this endpoint "remote", collapsed the floor to 0, and left
    // the bare configured 30 s as the stall budget — so any reasoning block longer than
    // half a minute was declared a stall. The documented workaround was for the operator
    // to notice and raise providers.<name>.timeoutMs.
    const local = new LMStudioProvider("http://localhost:1234/v1", "k", base, { timeoutMs: 30_000 });
    const remote = new LMStudioProvider("https://llm.example.com/v1", "k", base, { timeoutMs: 30_000 });

    expect(remote.getRuntimeSnapshot().requestTimeoutMs)
      .toBe(local.getRuntimeSnapshot().requestTimeoutMs);
    // And it is the generous one, not the 30 s the caller configured.
    expect(remote.getRuntimeSnapshot().requestTimeoutMs).toBeGreaterThan(30_000);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * E19 — the NON-streaming hard timeout bounds a generation, not a silence
 * Revert: `this.requestTimeoutMs + 5000` instead of the MAX_PROVIDER_TIMEOUT_MS floor.
 * ──────────────────────────────────────────────────────────────────────────── */
describe("a non-streaming completion is not cut at the per-chunk silence budget", () => {
  it("is still running at 700 s, where the silence budget alone would have killed it", async () => {
    // requestTimeoutMs is a SILENCE budget and the streaming path re-arms it on every chunk.
    // complete() has no chunks, so the same number silently became a bound on the whole
    // generation — and the calls that land here are the progress judge, the rescue prompts
    // and the forced timeout synthesis, i.e. exactly the work that exists to preserve the
    // evidence a hard timeout would discard. The SDK's own timer cannot substitute: it is
    // cleared the moment response headers arrive (openai/core.js fetchWithTimeout), so it
    // covers connection setup only.
    vi.useFakeTimers();
    try {
      const provider = new LMStudioProvider("http://localhost:1234/v1", "k", base, { maxRetries: 0 });
      let aborted = false;
      (provider as unknown as { client: unknown }).client = {
        chat: {
          completions: {
            create: (_b: unknown, opts: { signal: AbortSignal }) => new Promise((_res, rej) => {
              opts.signal.addEventListener("abort", () => { aborted = true; rej(new Error("hard timeout")); }, { once: true });
            }),
          },
        },
      };

      const settled = provider.complete([{ role: "user", content: "synthesize" }], []).then(
        () => "resolved", () => "rejected",
      );
      await vi.advanceTimersByTimeAsync(700_000);
      expect(aborted).toBe(false);

      // ...and it IS eventually bounded — this is a floor, not a removal.
      await vi.advanceTimersByTimeAsync(300_000);
      expect(aborted).toBe(true);
      expect(await settled).toBe("rejected");
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Job 2 — the parent-turn-aware clamp shapes the room, it does not delete it
 * Revert: drop effectiveReserveMs / MAX_SYNTHESIS_RESERVE_FRACTION and subtract
 * synthesisReserveMs flat again.
 * ──────────────────────────────────────────────────────────────────────────── */
describe("the synthesis reserve is a share of what is left, not a fixed slab", () => {
  /** One level of the real chain: deadline in, tightened deadline + child budget out. */
  const level = (parentDeadlineMs: number, nowMs: number, reserveMs: number) => ({
    budget: resolveDelegationCeilingMs({
      callerBudgetMs: AUDITED_TURN_BUDGET_MS,
      parentDeadlineMs,
      nowMs,
      synthesisReserveMs: reserveMs,
    }),
    deadline: resolveDelegationDeadlineMs({ parentDeadlineMs, nowMs, synthesisReserveMs: reserveMs }),
  });

  it("stops compounding a nested child down toward the bare floor", () => {
    // The shipped 420,000 ms reserve is subtracted at EVERY level from an already
    // tightened deadline: depth 2 removed 840,000 ms — 14 minutes of a 30-minute turn —
    // before the grandchild ran an iteration.
    const RESERVE = 420_000;
    const now = 0;
    const d1 = level(AUDITED_TURN_BUDGET_MS, now, RESERVE);
    const d2 = level(d1.deadline!, now, RESERVE);

    const flatTwoLevels = AUDITED_TURN_BUDGET_MS - 2 * RESERVE;
    expect(d2.budget!).toBeGreaterThan(flatTwoLevels);
    // Still monotonically non-increasing — a deeper child never gets MORE than a shallower one.
    expect(d2.budget!).toBeLessThanOrEqual(d1.budget!);
    expect(d2.deadline!).toBeLessThanOrEqual(d1.deadline!);
  });

  it("never takes more than its declared share of a nearly-exhausted parent", () => {
    const remaining = 200_000;
    const { budget } = level(remaining, 0, 420_000);
    // Flat subtraction wanted -220,000 and landed on the floor; the child now keeps the
    // majority of what is actually left.
    expect(budget!).toBeGreaterThan(SUB_AGENT_MIN_DELEGATION_MS);
    expect(budget!).toBeGreaterThanOrEqual(Math.floor(remaining * (1 - MAX_SYNTHESIS_RESERVE_FRACTION)));
  });

  it("leaves a roomy parent's reserve exactly as configured — this is a bound, not a rewrite", () => {
    const RESERVE = 120_000;
    const { budget } = level(AUDITED_TURN_BUDGET_MS, 0, RESERVE);
    expect(budget).toBe(AUDITED_TURN_BUDGET_MS - RESERVE);
  });
});
