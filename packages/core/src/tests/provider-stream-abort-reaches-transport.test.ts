import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../providers/anthropic.js";
import { DeadlineAbort, LMStudioProvider } from "../providers/lmstudio.js";
import type { ModelConfig } from "../config/schema.js";

/**
 * AN ABORT MUST REACH AN ALREADY-OPEN STREAM.
 *
 * The measured failure (run f08195d2): content_writer ran 1,200,000 ms to the
 * millisecond and an ephemeral 1,200,302 ms — both exactly MAX_STREAM_TOTAL_MS.
 * Their turn deadlines were armed and completely inert, and an operator pressing
 * STOP would have been equally powerless.
 *
 * Cause: withHardTimeout bridged the caller's signal to a LOCAL AbortController
 * with addEventListener and unhooked it in `finally`. On the streaming path
 * `finally` runs the moment `create()` RESOLVES — the stream is open, zero chunks
 * read — so the controller the SDK was holding was orphaned at chunk zero. Both
 * SDKs reach the real fetch controller ONLY through that `options.signal`
 * (openai v4 core.js fetchWithTimeout), so from then on nothing could stop the
 * generation but the total-budget guillotine.
 *
 * These tests assert the guarantees the fix rests on, per provider:
 *   (a) the signal the SDK was handed is STILL aborted after the stream is open,
 *       and chunk delivery stops at the abort instead of draining the stream;
 *   (b) a DEADLINE abort salvages — partial content kept, finishReason "length",
 *       usage reconstructed rather than the {0,0,0} a cut stream reports;
 *   (c) an OPERATOR cancel still propagates instead of being salvaged;
 *   (d) the OPEN-phase hard timeout — the one thing that always worked — still
 *       fires before a single chunk exists. It is the regression guard on the
 *       composed signal: the composite must carry the ceiling as well as the
 *       caller.
 */

const base: ModelConfig = {
  primary: "lmstudio/qwen/qwen3.8-27b",
  contextWindow: 32_768,
  maxTokens: 256,
  temperature: 0,
  enableThinking: true,
};

const anthropicBase: ModelConfig = {
  primary: "anthropic/claude-sonnet-4-6",
  contextWindow: 200_000,
  maxTokens: 256,
  temperature: 0,
  enableThinking: false,
};

/** Chunks offered by the transport, and chunks the consumer actually took. */
interface Tally {
  /** Consumer-visible StreamChunks. */
  yielded: number;
  /** Value of `yielded` at the instant the caller aborted. */
  yieldedAtAbort: number;
  /** Transport-side chunks offered. */
  produced: number;
}

/**
 * A stream the transport DELIBERATELY refuses to interrupt: it keeps yielding
 * chunks whatever its signal says. That is what makes the two guarantees
 * separable — the recorded signal proves the link survived stream-open, and the
 * chunk count proves the consumer stops on its own.
 */
function unstoppableChunks(count: number, onChunk?: (i: number) => void) {
  return (async function* () {
    for (let i = 0; i < count; i++) {
      onChunk?.(i);
      yield {
        choices: [{ delta: { content: `c${i}` }, finish_reason: null }],
      };
      await new Promise((r) => setImmediate(r));
    }
    yield { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  })();
}

/** LMStudioProvider whose SDK client records the signal it was handed. */
function lmProviderRecordingSignal(chunkCount: number, onChunk?: (i: number) => void) {
  const provider = new LMStudioProvider("http://localhost:1234/v1", "k", base, { maxRetries: 0 });
  const seen: { sdkSignal?: AbortSignal } = {};
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (_body: unknown, opts: { signal: AbortSignal }) => {
          seen.sdkSignal = opts.signal;
          // Resolving here is exactly the moment the old `finally` severed the link.
          return unstoppableChunks(chunkCount, onChunk);
        },
      },
    },
  };
  return { provider, seen };
}

/** AnthropicProvider whose SDK client records the signal it was handed. */
function anthropicProviderRecordingSignal(chunkCount: number, onChunk?: (i: number) => void) {
  const provider = new AnthropicProvider("https://api.anthropic.com", "sk-ant-api03-key", anthropicBase, { maxRetries: 0 });
  const seen: { sdkSignal?: AbortSignal } = {};
  (provider as unknown as { client: unknown }).client = {
    messages: {
      create: async (_body: unknown, opts: { signal: AbortSignal }) => {
        seen.sdkSignal = opts.signal;
        return (async function* () {
          yield { type: "message_start", message: { usage: { input_tokens: 1 } } };
          yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
          for (let i = 0; i < chunkCount; i++) {
            onChunk?.(i);
            yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `c${i}` } };
            await new Promise((r) => setImmediate(r));
          }
          yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } };
        })();
      },
    },
  };
  return { provider, seen };
}

/** Abort on the 5th transport chunk — long after create() resolved, i.e. long
 *  after the old `finally` had already orphaned the SDK's controller. */
function abortMidStream(tally: Tally, controller: AbortController, reason: unknown) {
  return (i: number) => {
    tally.produced = i + 1;
    if (i === 5) {
      tally.yieldedAtAbort = tally.yielded;
      controller.abort(reason);
    }
  };
}

const TOTAL_CHUNKS = 200;

describe("an abort reaches an OPEN stream — LMStudioProvider", () => {
  it("(a) keeps the SDK's signal linked to the caller AFTER the stream is open, and delivery stops there", async () => {
    const controller = new AbortController();
    const tally: Tally = { yielded: 0, yieldedAtAbort: -1, produced: 0 };
    const { provider, seen } = lmProviderRecordingSignal(
      TOTAL_CHUNKS,
      abortMidStream(tally, controller, new DeadlineAbort(60)),
    );

    try {
      for await (const _chunk of provider.stream([{ role: "user", content: "go" }], [], controller.signal)) {
        tally.yielded++;
      }
    } catch {
      // expected — the consumer check fires
    }

    // THE assertion. Before the fix this was false: the SDK held an orphan.
    expect(seen.sdkSignal).toBeDefined();
    expect(seen.sdkSignal!.aborted).toBe(true);
    // ...and it carries the caller's reason, not a generic abort.
    expect(DeadlineAbort.prototype.isPrototypeOf(seen.sdkSignal!.reason as object)).toBe(true);
    // Delivery STOPPED at the abort rather than draining all 200 chunks. Both
    // halves matter: the absolute bound catches a run that ignores the abort
    // entirely, the delta catches one that notices it only many chunks later.
    // FIXTURE SELF-CHECK, not a claim about the fix: it holds with the fix
    // reverted too. It exists so the test cannot silently degrade into aborting
    // at open time, where the whole defect is invisible.
    expect(tally.yieldedAtAbort).toBeGreaterThan(0);
    expect(tally.yielded).toBeLessThan(20);
    expect(tally.yielded - tally.yieldedAtAbort).toBeLessThanOrEqual(2);
  });

  it("(a) stops consuming even when the transport ignores its signal", async () => {
    const controller = new AbortController();
    const tally: Tally = { yielded: 0, yieldedAtAbort: -1, produced: 0 };
    const { provider } = lmProviderRecordingSignal(
      TOTAL_CHUNKS,
      abortMidStream(tally, controller, new DeadlineAbort(60)),
    );

    await expect((async () => {
      for await (const _chunk of provider.stream([{ role: "user", content: "go" }], [], controller.signal)) {
        tally.yielded++;
      }
    })()).rejects.toThrow();
    // 200 chunks were available; the reviewer's probe measured all of them delivered.
    expect(tally.yielded).toBeLessThan(20);
    expect(tally.produced).toBeLessThan(20);
  });

  it("(b) a DEADLINE abort mid-stream SALVAGES the partial through completeViaStream", async () => {
    const controller = new AbortController();
    const tally: Tally = { yielded: 0, yieldedAtAbort: -1, produced: 0 };
    const { provider } = lmProviderRecordingSignal(
      TOTAL_CHUNKS,
      abortMidStream(tally, controller, new DeadlineAbort(60)),
    );

    const res = await provider.completeViaStream([{ role: "user", content: "go" }], [], controller.signal);
    expect(res.content).toContain("c0");
    expect(res.finishReason).toBe("length");
    expect(res.truncatedBy).toBe("deadline");
    // Usage arrives only on the final chunk a cut stream never reaches, so an
    // unreconstructed salvage reports {0,0,0} — which prices the call at nothing
    // and reads as "no progress" to every stall detector.
    expect(res.usage).not.toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    expect(res.usage.completionTokens).toBeGreaterThan(0);
    expect(res.usage.promptTokens).toBeGreaterThan(0);
    expect(res.usage.totalTokens).toBe(res.usage.promptTokens + res.usage.completionTokens);
    // ...and it is marked inferred, so cost code can tell it from a metered number.
    expect(res.usage.estimated).toBe(true);
  });

  it("(c) an OPERATOR cancel mid-stream RE-THROWS instead of salvaging", async () => {
    const controller = new AbortController();
    const tally: Tally = { yielded: 0, yieldedAtAbort: -1, produced: 0 };
    const { provider } = lmProviderRecordingSignal(
      TOTAL_CHUNKS,
      abortMidStream(tally, controller, new Error("operator pressed stop")),
    );

    // Content HAD been produced by the abort (c0..c4), so this is the branch
    // choosing not to salvage, not an empty stream with nothing to keep.
    await expect(
      provider.completeViaStream([{ role: "user", content: "go" }], [], controller.signal),
    ).rejects.toThrow(/operator pressed stop/);
  });

  it("(d) still enforces the OPEN-phase hard timeout, before any chunk exists", async () => {
    vi.useFakeTimers();
    const provider = new LMStudioProvider("http://localhost:1234/v1", "k", base, { timeoutMs: 100, maxRetries: 0 });
    let createCalls = 0;
    let sdkSignal: AbortSignal | undefined;
    (provider as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          // Never resolves: the HTTP stream never opens.
          create: (_body: unknown, opts: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
            createCalls++;
            sdkSignal = opts.signal;
            opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
          }),
        },
      },
    };

    const settled = (async () => {
      for await (const _chunk of provider.stream([{ role: "user", content: "go" }], [])) { /* never */ }
    })().then(() => "resolved", (err: Error) => err);

    // timeoutMs 100 is raised to the MINIMUM SILENCE BUDGET (600_000) by
    // computeOpenAICompatibleRequestTimeoutMs; the ceiling is that + 5000 grace.
    await vi.advanceTimersByTimeAsync(700_000);
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/exceeded hard timeout/);
    // The ceiling must reach the SDK through the SAME composed signal the caller
    // uses — composing away the timeout controller would leave this false.
    expect(sdkSignal?.aborted).toBe(true);
    // A hung provider is attempted exactly once, never retried.
    expect(createCalls).toBe(1);
    vi.useRealTimers();
  });
});

/**
 * The case the consumer-side check CANNOT cover, and the reason the signal link is
 * the primary fix rather than the belt-and-braces one.
 *
 * A stream that goes SILENT never runs the loop body, so neither the abort check nor
 * the elapsed-vs-totalCapMs check can ever execute — MAX_STREAM_TOTAL_MS only ever
 * bounded a stream that kept PRODUCING. The inactivity timer was the sole guard, and
 * it aborted the same orphaned controller, so a mid-stream stall on this path was
 * bounded by nothing at all. Restoring the link is what makes the guard real again.
 */
describe("a silent mid-stream stall is bounded again — LMStudioProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the inactivity timer's abort reaches the OPEN stream", async () => {
    vi.useFakeTimers();
    const provider = new LMStudioProvider("http://localhost:1234/v1", "k", base, { maxRetries: 0 });
    let sdkSignal: AbortSignal | undefined;
    (provider as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: async (_body: unknown, opts: { signal: AbortSignal }) => {
            sdkSignal = opts.signal;
            // Opens, then never sends a byte — the loop body is never entered.
            return {
              [Symbol.asyncIterator]: () => ({
                next: () => new Promise((_resolve, reject) => {
                  opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
                }),
              }),
            };
          },
        },
      },
    };

    const settled = (async () => {
      for await (const _chunk of provider.stream([{ role: "user", content: "go" }], [])) { /* never */ }
    })().then(() => "resolved", (err: unknown) => String(err));

    // requestTimeoutMs is raised to the MINIMUM SILENCE BUDGET (600_000) by
    // computeOpenAICompatibleRequestTimeoutMs; advance past it.
    await vi.advanceTimersByTimeAsync(700_000);
    expect(sdkSignal?.aborted).toBe(true);
    await expect(settled).resolves.toMatch(/stalled/);
  });
});

describe("an abort reaches an OPEN stream — AnthropicProvider", () => {
  it("(a) keeps the SDK's signal linked to the caller AFTER the stream is open, and delivery stops there", async () => {
    const controller = new AbortController();
    const tally: Tally = { yielded: 0, yieldedAtAbort: -1, produced: 0 };
    const { provider, seen } = anthropicProviderRecordingSignal(
      TOTAL_CHUNKS,
      abortMidStream(tally, controller, new DeadlineAbort(60)),
    );

    try {
      for await (const _chunk of provider.stream([{ role: "user", content: "go" }], [], controller.signal)) {
        tally.yielded++;
      }
    } catch {
      // expected
    }

    expect(seen.sdkSignal).toBeDefined();
    expect(seen.sdkSignal!.aborted).toBe(true);
    expect(DeadlineAbort.prototype.isPrototypeOf(seen.sdkSignal!.reason as object)).toBe(true);
    expect(tally.yieldedAtAbort).toBeGreaterThan(0);
    expect(tally.yielded).toBeLessThan(20);
    expect(tally.yielded - tally.yieldedAtAbort).toBeLessThanOrEqual(2);
  });

  it("(b) a DEADLINE abort mid-stream SALVAGES the partial through completeViaStream", async () => {
    const controller = new AbortController();
    const tally: Tally = { yielded: 0, yieldedAtAbort: -1, produced: 0 };
    const { provider } = anthropicProviderRecordingSignal(
      TOTAL_CHUNKS,
      abortMidStream(tally, controller, new DeadlineAbort(60)),
    );

    const res = await provider.completeViaStream([{ role: "user", content: "go" }], [], controller.signal);
    expect(res.content).toContain("c0");
    expect(res.finishReason).toBe("length");
    expect(res.truncatedBy).toBe("deadline");
    expect(res.usage).not.toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    expect(res.usage.completionTokens).toBeGreaterThan(0);
    expect(res.usage.totalTokens).toBeGreaterThan(0);
    // The asymmetry this used to pin is CLOSED, deliberately. `usage` is assigned only on
    // the final `done` chunk a cut stream never emits, so the prompt side came back as 0 —
    // and on the only PRICED provider that under-reported a salvaged turn by the whole
    // prompt, usually the larger half. It is now estimated, exactly as the OpenAI-compatible
    // salvage beside it does, and the record says it was inferred rather than metered.
    expect(res.usage.promptTokens).toBeGreaterThan(0);
    expect(res.usage.totalTokens).toBe(res.usage.promptTokens + res.usage.completionTokens);
    expect(res.usage.estimated).toBe(true);
  });

  it("(c) an OPERATOR cancel mid-stream RE-THROWS instead of salvaging", async () => {
    const controller = new AbortController();
    const tally: Tally = { yielded: 0, yieldedAtAbort: -1, produced: 0 };
    const { provider } = anthropicProviderRecordingSignal(
      TOTAL_CHUNKS,
      abortMidStream(tally, controller, new Error("operator pressed stop")),
    );

    await expect(
      provider.completeViaStream([{ role: "user", content: "go" }], [], controller.signal),
    ).rejects.toThrow(/operator pressed stop/);
  });

  it("(d) still enforces the OPEN-phase hard timeout, before any chunk exists", async () => {
    vi.useFakeTimers();
    const provider = new AnthropicProvider("https://api.anthropic.com", "sk-ant-api03-key", anthropicBase, {
      timeoutMs: 100,
      maxRetries: 0,
    });
    let createCalls = 0;
    let sdkSignal: AbortSignal | undefined;
    (provider as unknown as { client: unknown }).client = {
      messages: {
        create: (_body: unknown, opts: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
          createCalls++;
          sdkSignal = opts.signal;
          opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
        }),
      },
    };

    const settled = (async () => {
      for await (const _chunk of provider.stream([{ role: "user", content: "go" }], [])) { /* never */ }
    })().then(() => "resolved", (err: Error) => err);

    await vi.advanceTimersByTimeAsync(700_000);
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/exceeded hard timeout/);
    expect(sdkSignal?.aborted).toBe(true);
    expect(createCalls).toBe(1);
    vi.useRealTimers();
  });
});
