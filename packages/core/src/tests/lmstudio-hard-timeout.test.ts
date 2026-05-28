import { describe, expect, it, vi, afterEach } from "vitest";
import { LMStudioProvider } from "../providers/lmstudio.js";
import type { ModelConfig } from "../config/schema.js";

// Audit traces (2026-05-28) showed a single chat.completions.create() running
// for ~20 minutes past the OpenAI SDK's own 5-minute timeout — LM Studio held
// the HTTP socket open and the SDK timeout option never fired. We added an
// AbortController-based hard ceiling so the runtime can't lose this much
// budget to a stuck provider regardless of what the SDK does.

const baseModelConfig: ModelConfig = {
  primary: "lmstudio/test-model",
  contextWindow: 8192,
  maxTokens: 64,
  temperature: 0,
  enableThinking: false,
};

describe("LMStudioProvider hard timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts a hung chat.completions.create() call shortly after requestTimeoutMs", async () => {
    vi.useFakeTimers();
    const provider = new LMStudioProvider("http://localhost:1234/v1", "test", baseModelConfig, {
      timeoutMs: 100, // 100ms SDK timeout + 5000ms grace = ~5.1s hard ceiling
      maxRetries: 0,
    });

    let abortReason: unknown = null;
    // Replace the underlying client.create with a hung implementation that
    // only resolves/rejects when its signal aborts. This simulates LM Studio
    // not honoring the SDK's own timeout.
    (provider as unknown as { client: { chat: { completions: { create: unknown } } } }).client = {
      chat: {
        completions: {
          create: (_body: unknown, opts: { signal: AbortSignal }) => new Promise((_, reject) => {
            opts.signal.addEventListener("abort", () => {
              abortReason = (opts.signal as AbortSignal & { reason?: unknown }).reason ?? new Error("aborted");
              reject(abortReason);
            }, { once: true });
          }),
        },
      },
    };

    const callPromise = provider.complete([{ role: "user", content: "hi" }], []);
    // Subscribe a rejection handler immediately so fake timers don't flag the
    // (correctly-rejected) promise as unhandled while ticks are still flushing.
    const settled = callPromise.then(
      (value) => ({ ok: true as const, value }),
      (err) => ({ ok: false as const, err: err as Error }),
    );
    // Hard ceiling = requestTimeoutMs + 5000. With our 100ms timeoutMs that's
    // capped to the DEFAULT (30_000) by computeOpenAICompatibleRequestTimeoutMs
    // floor, then +5000 grace. Advance well past it.
    await vi.advanceTimersByTimeAsync(40_000);
    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.message).toMatch(/exceeded hard timeout/);
    expect(String(abortReason)).toMatch(/exceeded hard timeout/);
  });

  it("propagates an externally-aborted signal without firing the hard timeout", async () => {
    vi.useFakeTimers();
    const provider = new LMStudioProvider("http://localhost:1234/v1", "test", baseModelConfig, {
      timeoutMs: 100,
      maxRetries: 0,
    });

    (provider as unknown as { client: { chat: { completions: { create: unknown } } } }).client = {
      chat: {
        completions: {
          create: (_body: unknown, opts: { signal: AbortSignal }) => new Promise((_, reject) => {
            opts.signal.addEventListener("abort", () => reject(new Error("aborted by caller")), { once: true });
          }),
        },
      },
    };

    const ac = new AbortController();
    const callPromise = provider.complete([{ role: "user", content: "hi" }], [], ac.signal);
    const settled = callPromise.then(
      (value) => ({ ok: true as const, value }),
      (err) => ({ ok: false as const, err: err as Error }),
    );
    // Caller aborts at 1s, well before the hard ceiling.
    setTimeout(() => ac.abort(), 1000);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.message).toMatch(/aborted by caller/);
  });
});
