import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "../config/schema.js";

const rows: Array<{ type: string; data: Record<string, unknown> }> = [];
vi.mock("../audit/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/logger.js")>();
  return {
    ...actual,
    logAudit: vi.fn((type: string, data: Record<string, unknown>) => { rows.push({ type, data }); }),
  };
});

const { LMStudioProvider } = await import("../providers/lmstudio.js");
const modelCalls = () => rows.filter((r) => r.type === "provider_model_call").map((r) => r.data);
beforeEach(() => { rows.length = 0; });

const base: ModelConfig = {
  primary: "lmstudio/qwen/qwen3.6-35b-a3b",
  contextWindow: 8192,
  maxTokens: 64,
  temperature: 0,
  enableThinking: false,
} as ModelConfig;

/**
 * A SWALLOWED ABORT IS NOT A SUCCESSFUL CALL.
 *
 * openai@4.104.0's SSE iterator ends the loop silently when the caller aborts:
 *   catch (e) { if (e instanceof Error && e.name === "AbortError") return; throw e; }
 * and a bare `controller.abort()` — which is exactly what the gateway issues on client
 * disconnect — raises a DOMException named "AbortError". So the provider's `for await` exited
 * NORMALLY, no catch ran, and the tail of streamOnce recorded a guillotined generation as a
 * clean one: recordRequestSuccess(), finishReason "stop", and null usage because the
 * include_usage chunk never arrived.
 *
 * Live cost, session 40dbcb5f (2026-09-08): a call that ran 1,146,845 ms sits in the audit log
 * as a successful "stop". The incident was unreadable from its own trail, and every latency
 * percentile computed from that log was survivor-biased — the failures were filed as successes.
 *
 * The asymmetry is the tell, and it is asserted below: the provider's OWN aborts carry an Error
 * whose name is not "AbortError" and always rethrew correctly. Only the CALLER's aborts vanished
 * — the turn deadline, the warden, the client. Exactly the ones a postmortem needs.
 */
function providerWithStream(makeStream: (signal?: AbortSignal) => AsyncIterable<unknown>) {
  const provider = new LMStudioProvider("http://localhost:1234/v1", "test", base, { maxRetries: 0 });
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (_body: unknown, opts?: { signal?: AbortSignal }) => makeStream(opts?.signal),
      },
    },
  };
  return provider;
}

/** The SDK's behaviour: yield a couple of deltas, then return silently once aborted. */
function silentlyEndingStream(signal?: AbortSignal) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: "partial " } }] };
      yield { choices: [{ delta: { content: "answer" } }] };
      while (!signal?.aborted) await new Promise((r) => setTimeout(r, 5));
      return; // <- openai-node swallows the AbortError and returns, exactly like this
    },
  };
}

describe("a caller abort must not be recorded as a completed call", () => {
  it("throws instead of yielding a clean 'stop' when the caller's signal aborted", async () => {
    const ac = new AbortController();
    const provider = providerWithStream((s) => silentlyEndingStream(s));
    setTimeout(() => ac.abort(), 30); // bare abort → DOMException named "AbortError"

    await expect((async () => {
      for await (const _chunk of provider.stream([{ role: "user", content: "hi" }], [], ac.signal)) { /* drain */ }
    })()).rejects.toThrow();
  });

  it("records the call with finishReason 'aborted', not 'stop' — the duration still matters", async () => {
    const ac = new AbortController();
    const provider = providerWithStream((s) => silentlyEndingStream(s));
    setTimeout(() => ac.abort(), 30);

    try {
      for await (const _chunk of provider.stream([{ role: "user", content: "hi" }], [], ac.signal)) { /* drain */ }
    } catch { /* expected */ }

    const calls = modelCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!["finishReason"]).toBe("aborted");
    // A postmortem needs to know how long the doomed call ran, so the row is still written.
    expect(typeof calls[0]!["durationMs"]).toBe("number");
  });

  it("leaves a stream that genuinely finishes reported as a clean stop", async () => {
    // The regression that would matter most: healthy calls must be untouched.
    const provider = providerWithStream(() => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "done" } }] };
        yield { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } };
      },
    }));

    let finish: string | undefined;
    for await (const chunk of provider.stream([{ role: "user", content: "hi" }], [])) {
      if (chunk.type === "done") finish = chunk.finishReason;
    }
    expect(finish).toBe("stop");
    const calls = modelCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!["finishReason"]).toBe("stop");
  });
});
