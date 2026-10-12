import { describe, expect, it } from "vitest";
import { LMStudioProvider, isRetryableStreamError, streamRetryDelayMs, type StreamChunk } from "../providers/lmstudio.js";
import type { ModelConfig } from "../config/schema.js";

/**
 * The streaming path retries a transient connection drop that happens DURING
 * prefill — the long, byte-silent window before the first token on a large
 * prompt, which surfaces as "Premature close" and previously killed the whole
 * turn (unlike complete(), stream() had no retry). It must retry ONLY when
 * nothing has been yielded yet (no duplicated content) and only for genuine
 * connection drops — never our own hard-timeout/stall or an intentional cancel.
 */
const baseModelConfig: ModelConfig = {
  primary: "lmstudio/test-model",
  contextWindow: 8192,
  maxTokens: 64,
  temperature: 0,
  enableThinking: false,
};

function makeProvider(maxRetries: number, streamRetryBaseDelayMs = 0): LMStudioProvider {
  return new LMStudioProvider("http://localhost:1234/v1", "test", baseModelConfig, { maxRetries, streamRetryBaseDelayMs });
}

/** What the OpenAI SDK throws for a refused connection: APIConnectionError over fetch's error over undici's. */
function sdkConnectionError(): Error {
  const socket = Object.assign(new Error("connect ECONNREFUSED 192.168.12.11:8080"), { code: "ECONNREFUSED" });
  const fetchFailed = Object.assign(new TypeError("fetch failed"), { cause: socket });
  return Object.assign(new Error("Connection error."), { cause: fetchFailed });
}

type StreamFn = () => AsyncGenerator<StreamChunk>;
function setStreamOnce(provider: LMStudioProvider, fn: StreamFn): void {
  (provider as unknown as { streamOnce: StreamFn }).streamOnce = fn;
}

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe("isRetryableStreamError", () => {
  it("matches connection-level drops (incl. the wrapped stream() message)", () => {
    expect(isRetryableStreamError(new Error("Premature close"))).toBe(true);
    expect(isRetryableStreamError(new Error("OpenAI-compatible stream failed (model: x): Error: Premature close"))).toBe(true);
    expect(isRetryableStreamError(new Error("read ECONNRESET"))).toBe(true);
    expect(isRetryableStreamError(new Error("terminated"))).toBe(true);
    const withCode = Object.assign(new Error("socket failure"), { code: "ECONNRESET" });
    expect(isRetryableStreamError(withCode)).toBe(true);
  });

  it("matches the SDK's connection error, by its message and by the code two causes down", () => {
    expect(isRetryableStreamError(sdkConnectionError())).toBe(true);
    const unnamed = Object.assign(new Error("upstream failure"), { cause: sdkConnectionError().cause });
    expect(isRetryableStreamError(unnamed)).toBe(true);
    // The SDK's timeout is its own error, and a timeout is not a dropped connection.
    expect(isRetryableStreamError(new Error("Request timed out."))).toBe(false);
  });

  it("does NOT match our own stalls/timeouts or an intentional abort", () => {
    expect(isRetryableStreamError(new Error("LLM call exceeded hard timeout of 600000ms"))).toBe(false);
    expect(isRetryableStreamError(new Error("LLM stream stalled (no chunk in 120000ms)"))).toBe(false);
    expect(isRetryableStreamError(new Error("The operation was aborted"))).toBe(false);
    expect(isRetryableStreamError(new Error("model not found"))).toBe(false);
  });
});

describe("LMStudioProvider.stream — transient-drop retry", () => {
  it("retries a premature close that happens before any chunk, then succeeds (no duplication)", async () => {
    const provider = makeProvider(1); // maxAttempts = 2
    let attempts = 0;
    setStreamOnce(provider, async function* () {
      attempts++;
      if (attempts === 1) throw new Error("OpenAI-compatible stream failed (model: x): Error: Premature close");
      yield { type: "text_delta", content: "hello" };
      yield { type: "done", finishReason: "stop" };
    });
    const chunks = await collect(provider.stream([{ role: "user", content: "hi" }], []));
    expect(attempts).toBe(2);
    const text = chunks.filter((c) => c.type === "text_delta");
    expect(text).toHaveLength(1);
    expect(text[0]!.content).toBe("hello");
  });

  it("does NOT retry once a chunk has already streamed (avoids duplicate output)", async () => {
    const provider = makeProvider(1);
    let attempts = 0;
    setStreamOnce(provider, async function* () {
      attempts++;
      yield { type: "text_delta", content: "partial" };
      throw new Error("Premature close");
    });
    await expect(collect(provider.stream([{ role: "user", content: "hi" }], []))).rejects.toThrow(/Premature close/);
    expect(attempts).toBe(1);
  });

  it("does NOT retry a non-connection error (hard timeout)", async () => {
    const provider = makeProvider(1);
    let attempts = 0;
    setStreamOnce(provider, async function* () {
      attempts++;
      throw new Error("LLM call exceeded hard timeout of 600000ms");
    });
    await expect(collect(provider.stream([{ role: "user", content: "hi" }], []))).rejects.toThrow(/hard timeout/);
    expect(attempts).toBe(1);
  });

  it("still retries a transient drop when maxRetries=0 (connection retry is decoupled from semantic retries)", async () => {
    const provider = makeProvider(0); // maxAttempts floored at 2
    let attempts = 0;
    setStreamOnce(provider, async function* () {
      attempts++;
      if (attempts === 1) throw new Error("Premature close");
      yield { type: "text_delta", content: "recovered" };
      yield { type: "done", finishReason: "stop" };
    });
    const chunks = await collect(provider.stream([{ role: "user", content: "hi" }], []));
    expect(attempts).toBe(2);
    expect(chunks.find((c) => c.type === "text_delta")?.content).toBe("recovered");
  });

  it("gives up after maxAttempts and rethrows the drop", async () => {
    const provider = makeProvider(1); // 2 attempts
    let attempts = 0;
    setStreamOnce(provider, async function* () {
      attempts++;
      throw new Error("Premature close");
    });
    await expect(collect(provider.stream([{ role: "user", content: "hi" }], []))).rejects.toThrow(/Premature close/);
    expect(attempts).toBe(2);
  });

  it("retries the SDK's connection error, which it used to fail over on at once", async () => {
    const provider = makeProvider(3);
    let attempts = 0;
    setStreamOnce(provider, async function* () {
      attempts++;
      if (attempts < 3) throw sdkConnectionError();
      yield { type: "text_delta", content: "back" };
      yield { type: "done", finishReason: "stop" };
    });
    const chunks = await collect(provider.stream([{ role: "user", content: "hi" }], []));
    expect(attempts).toBe(3);
    expect(chunks.find((c) => c.type === "text_delta")?.content).toBe("back");
  });

  it("stops waiting and rethrows when the caller cancels during the backoff", { timeout: 1_000 }, async () => {
    // The first wait is the 4 s cap: were the abort not honoured, the test would run into its timeout.
    const provider = makeProvider(3, 10_000);
    const controller = new AbortController();
    let attempts = 0;
    setStreamOnce(provider, async function* () {
      attempts++;
      setTimeout(() => controller.abort(), 20);
      throw sdkConnectionError();
    });
    await expect(collect(provider.stream([{ role: "user", content: "hi" }], [], controller.signal))).rejects.toThrow(/Connection error/);
    expect(attempts).toBe(1);
  });
});

describe("streamRetryDelayMs", () => {
  it("doubles from the base per retry, at most 4 s, and is 0 for a 0 base", () => {
    expect([1, 2, 3, 4].map((retry) => streamRetryDelayMs(retry, 1_000))).toEqual([1_000, 2_000, 4_000, 4_000]);
    expect(streamRetryDelayMs(2, 0)).toBe(0);
  });
});
