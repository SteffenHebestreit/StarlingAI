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
    // Hard ceiling = max(requestTimeoutMs, MAX_PROVIDER_TIMEOUT_MS) + 5000. Our 100ms
    // timeoutMs is raised to the MINIMUM SILENCE BUDGET (600_000) by
    // computeOpenAICompatibleRequestTimeoutMs, and the non-streaming ceiling is floored at
    // 900_000: requestTimeoutMs measures SILENCE and the streaming path re-arms it per
    // chunk, but this path has no chunks, so the same number would otherwise bound a whole
    // generation — and a terminal hard timeout on the rescue/synthesis calls that land here
    // discards the very evidence they exist to preserve. Advance well past it.
    await vi.advanceTimersByTimeAsync(1_000_000);
    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.message).toMatch(/exceeded hard timeout/);
    expect(String(abortReason)).toMatch(/exceeded hard timeout/);
  });

  it("does NOT retry a hard-timeout — a hung provider is attempted exactly once", async () => {
    vi.useFakeTimers();
    // maxRetries: 3 would normally allow 4 attempts. A hung provider must still
    // be hit only ONCE, or the wall-clock hang is multiplied by the retry count
    // (the live 20-min ≈ 4 × 5-min delegation bug).
    const provider = new LMStudioProvider("http://localhost:1234/v1", "test", baseModelConfig, {
      timeoutMs: 100,
      maxRetries: 3,
    });

    let createCalls = 0;
    (provider as unknown as { client: { chat: { completions: { create: unknown } } } }).client = {
      chat: {
        completions: {
          create: (_body: unknown, opts: { signal: AbortSignal }) => new Promise((_, reject) => {
            createCalls += 1;
            opts.signal.addEventListener("abort", () => reject((opts.signal as AbortSignal & { reason?: unknown }).reason), { once: true });
          }),
        },
      },
    };

    const callPromise = provider.complete([{ role: "user", content: "hi" }], []);
    const settled = callPromise.then(
      (value) => ({ ok: true as const, value }),
      (err) => ({ ok: false as const, err: err as Error }),
    );
    // Advance far past several hard-timeout windows + retry delays.
    await vi.advanceTimersByTimeAsync(2_000_000);
    const result = await settled;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.name).toBe("ProviderHardTimeoutError");
      expect(result.err.message).toMatch(/exceeded hard timeout/);
    }
    expect(createCalls).toBe(1); // never retried
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
