import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../providers/anthropic.js";
import { FailoverChatProvider } from "../providers/failover.js";
import { wrapProviderWithBoundary } from "../providers/llm-boundary.js";
import { LMStudioProvider, type ChatProvider, type CompletionCallOptions, type LLMResponse, type StreamChunk } from "../providers/lmstudio.js";
import type { ModelConfig } from "../config/schema.js";

/**
 * A RUNAWAY MUST BE STOPPABLE WHILE IT IS STILL STREAMING.
 *
 * The measured failure (.starlingai/audit.jsonl, 2026-08-17 19:12:31 → 19:33:15,
 * backend_coder): ONE provider.completeViaStream call, 1,244,109 ms, 59,418 reasoning
 * characters, zero tool calls, zero iterations, outcome "failure". The burn detector
 * that exists for exactly that shape never fired, because it samples between
 * iterations and on a timer reading counters only a RETURNED call updates — and this
 * call did not return for 20.7 minutes. reasoningChars was only knowable afterwards.
 *
 * The fixtures are the measured numbers from those runs:
 *   healthy first iteration, then 15 tool calls   23,876 reasoning chars
 *   the zero-tool-call pathology                  59,418 reasoning chars
 *   budget                                        45,000 (COLD_START_REASONING_BUDGET_CHARS)
 *
 * Killing the healthy run is the worst regression available here, so it is asserted
 * twice over: once with the tool call arriving after its full opening think, and once
 * for a legitimate tool-free long-form writer.
 */

const base: ModelConfig = {
  primary: "lmstudio/qwen/qwen3.8-27b",
  contextWindow: 131_072,
  temperature: 0,
  enableThinking: true,
};

const anthropicBase: ModelConfig = {
  primary: "anthropic/claude-sonnet-4-6",
  contextWindow: 200_000,
  temperature: 0,
  enableThinking: false,
};

/** Measured on the run that hung: 59,418 reasoning chars, no tool call, no answer. */
const PATHOLOGY_REASONING_CHARS = 59_418;
/** Measured on the reference run that then made 15 tool calls and wrote 5 files. */
const HEALTHY_OPENING_REASONING_CHARS = 23_876;
const CHUNK_CHARS = 1_000;

/**
 * The two SHAPES a long think can have. This distinction is the whole policy.
 *
 * The fixtures used to be `"r".repeat(n)` — filler chosen to reach a character count back
 * when the count was the decision. It cannot be used now for the reason that made the old
 * policy wrong: 45,000 identical characters ARE a loop, so filler would trip the content
 * check instantly and every test would pass for the wrong reason.
 *
 * `progressive` says something new in every sentence — a model working hard. `looping`
 * re-derives one paragraph forever — a model stuck. Measured separation on these two
 * generators is 0.0000 vs 0.97 repeat ratio, either side of a 0.5 threshold.
 */
type Shape = "progressive" | "looping";

function reasoningText(shape: Shape, total: number): string {
  const parts: string[] = [];
  let i = 0;
  while (parts.join("\n").length < total) {
    parts.push(shape === "progressive"
      ? `Step ${i}: column ${i % 10} maps to offset ${i * 3}, so the kick entry is ${i % 4} `
        + `and the wall bound becomes ${320 - i}; the pivot moved ${i} units since the last `
        + `case, which changes the spawn row for piece ${String.fromCharCode(65 + (i % 7))}.`
      : "Wait, let me reconsider the rotation. The SRS kick table for the J piece has five "
        + "offsets and I must apply them in order against the board bounds before accepting "
        + "it. Actually, let me reconsider the rotation. The SRS kick table has five offsets.");
    i++;
  }
  // The providers trim the joined reasoning, so a payload that happens to be sliced on a
  // newline comes back one character short and every length assertion here misses by one.
  // Swap the edge whitespace rather than trimming it, so the length stays exactly `total`.
  return parts.join("\n").slice(0, total).replace(/^\s/, ".").replace(/\s$/, ".");
}

/** How many transport chunks `total` characters take at CHUNK_CHARS each. */
function chunkCount(total: number): number {
  return Math.ceil(total / CHUNK_CHARS);
}

interface Tally {
  /** Reasoning chunks the TRANSPORT was asked for. Stops climbing when the abort lands. */
  produced: number;
}

/**
 * An OpenAI-compatible transport that emits `total` reasoning characters in
 * CHUNK_CHARS-sized deltas, then optionally a tool call, then finishes. It ignores
 * its signal deliberately: the consumer must stop on its own, exactly as the sibling
 * abort-reaches-transport fixtures do.
 */
function lmBurner(opts: { total: number; tally: Tally; toolCallAfter?: boolean; contentChars?: number; shape?: Shape }) {
  const payload = reasoningText(opts.shape ?? "progressive", opts.total);
  const provider = new LMStudioProvider("http://localhost:1234/v1", "k", base, { maxRetries: 0 });
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async () => (async function* () {
          if (opts.contentChars) {
            yield { choices: [{ delta: { content: "a".repeat(opts.contentChars) }, finish_reason: null }] };
          }
          let emitted = 0;
          while (emitted < opts.total) {
            const size = Math.min(CHUNK_CHARS, opts.total - emitted);
            emitted += size;
            opts.tally.produced += 1;
            yield { choices: [{ delta: { reasoning_content: payload.slice(emitted - size, emitted) }, finish_reason: null }] };
            await new Promise((r) => setImmediate(r));
          }
          if (opts.toolCallAfter) {
            yield {
              choices: [{
                delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file", arguments: "{\"path\":\"a.ts\"}" } }] },
                finish_reason: null,
              }],
            };
          }
          yield {
            choices: [{ delta: {}, finish_reason: opts.toolCallAfter ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 6845, completion_tokens: 19806, total_tokens: 26651 },
          };
        })(),
      },
    },
  };
  return provider;
}

/** The same fixture shapes on the Anthropic wire (thinking_delta / tool_use blocks). */
function anthropicBurner(opts: { total: number; tally: Tally; toolCallAfter?: boolean; shape?: Shape }) {
  const payload = reasoningText(opts.shape ?? "progressive", opts.total);
  const provider = new AnthropicProvider("https://api.anthropic.com", "sk-ant-api03-key", anthropicBase, { maxRetries: 0 });
  (provider as unknown as { client: unknown }).client = {
    messages: {
      create: async () => (async function* () {
        yield { type: "message_start", message: { usage: { input_tokens: 6845 } } };
        yield { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } };
        let emitted = 0;
        while (emitted < opts.total) {
          const size = Math.min(CHUNK_CHARS, opts.total - emitted);
          emitted += size;
          opts.tally.produced += 1;
          yield { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: payload.slice(emitted - size, emitted) } };
          await new Promise((r) => setImmediate(r));
        }
        if (opts.toolCallAfter) {
          yield { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_1", name: "write_file" } };
          yield { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a.ts\"}" } };
        }
        yield {
          type: "message_delta",
          delta: { stop_reason: opts.toolCallAfter ? "tool_use" : "end_turn" },
          usage: { output_tokens: 19806 },
        };
      })(),
    },
  };
  return provider;
}

describe("mid-stream reasoning burn — OpenAI-compatible provider", () => {
  it("aborts the burning generation WHILE IT STREAMS and keeps the partial", async () => {
    const tally: Tally = { produced: 0 };
    const provider = lmBurner({ total: PATHOLOGY_REASONING_CHARS, tally, shape: "looping" });

    const res = await provider.completeViaStream([{ role: "user", content: "build it" }], []);

    // Stopped because the CONTENT says it is circling — and stopped far sooner than any
    // character budget would have, because a loop is recognisable long before 45,000.
    expect(res.reasoning).toBeDefined();
    expect(res.reasoning!.length).toBeLessThan(PATHOLOGY_REASONING_CHARS);
    // MID-STREAM, measured at the transport: it was never asked for the rest.
    expect(tally.produced).toBeLessThan(chunkCount(PATHOLOGY_REASONING_CHARS));
    // Salvaged, and labelled — the caller must be able to tell this from a transport
    // drop or a deadline, because it means "wind down", not "retry".
    expect(res.truncatedBy).toBe("reasoning_burn");
    expect(res.finishReason).toBe("length");
    expect(res.usage.completionTokens).toBeGreaterThan(0);
    expect(res.usage.estimated).toBe(true);
  });

  it("leaves the HEALTHY reference run — 23,876 reasoning chars, then a tool call — untouched", async () => {
    const tally: Tally = { produced: 0 };
    const provider = lmBurner({ total: HEALTHY_OPENING_REASONING_CHARS, tally, toolCallAfter: true });

    const res = await provider.completeViaStream([{ role: "user", content: "build it" }], []);

    expect(res.reasoning!.length).toBe(HEALTHY_OPENING_REASONING_CHARS);
    expect(res.tool_calls).toHaveLength(1);
    expect(res.tool_calls[0]!.name).toBe("write_file");
    expect(res.truncatedBy).toBeUndefined();
    expect(res.finishReason).toBe("tool_calls");
    // The whole opening think reached the caller — nothing was cut.
    expect(tally.produced).toBe(chunkCount(HEALTHY_OPENING_REASONING_CHARS));
  });

  it("LETS A LONG THINK RUN when it keeps saying new things — length is not the pathology", async () => {
    // THE POLICY, and the limitation the old guard carried made obsolete. Previously a run
    // whose opening think passed 45,000 characters before its first tool call was cut, and
    // that was the acknowledged trade. It is no longer a trade: 59,418 characters of
    // PROGRESSIVE reasoning followed by a tool call is a model working, and it runs to
    // completion untouched. Only circling stops a run now.
    const tally: Tally = { produced: 0 };
    const provider = lmBurner({ total: PATHOLOGY_REASONING_CHARS, tally, toolCallAfter: true, shape: "progressive" });

    const res = await provider.completeViaStream([{ role: "user", content: "build it" }], []);

    expect(res.tool_calls).toHaveLength(1);
    expect(res.reasoning!.length).toBe(PATHOLOGY_REASONING_CHARS);
    expect(res.truncatedBy).toBeUndefined();
    expect(tally.produced).toBe(chunkCount(PATHOLOGY_REASONING_CHARS));
  });

  it("leaves a tool-free writer that is PRODUCING TEXT alone past the budget", async () => {
    const tally: Tally = { produced: 0 };
    const provider = lmBurner({ total: PATHOLOGY_REASONING_CHARS, tally, contentChars: 4_000 });

    const res = await provider.completeViaStream([{ role: "user", content: "write the report" }], []);

    expect(res.content).toHaveLength(4_000);
    expect(res.reasoning!.length).toBe(PATHOLOGY_REASONING_CHARS);
    expect(res.truncatedBy).toBeUndefined();
  });

  it("does NOT cut a long PROGRESSIVE run holding the operator's unbounded grant", async () => {
    const tally: Tally = { produced: 0 };
    const provider = lmBurner({ total: PATHOLOGY_REASONING_CHARS, tally, shape: "progressive" });

    const res = await provider.completeViaStream([{ role: "user", content: "build it" }], [], undefined, {
      isUnbounded: () => true,
    });

    expect(res.reasoning!.length).toBe(PATHOLOGY_REASONING_CHARS);
    expect(res.truncatedBy).toBeUndefined();
    expect(tally.produced).toBe(chunkCount(PATHOLOGY_REASONING_CHARS));
  });

  it("STILL cuts a LOOPING run holding the grant — the grant waives length, not pathology", async () => {
    // Run db88fa5b is the cost of conflating the two: the grant disarmed the whole guard
    // and one iteration then spent 80,810 characters and 29 minutes to move a single <div>.
    // An operator answering the dock means "take the time you need", never "keep circling".
    const tally: Tally = { produced: 0 };
    const provider = lmBurner({ total: PATHOLOGY_REASONING_CHARS, tally, shape: "looping" });

    const res = await provider.completeViaStream([{ role: "user", content: "build it" }], [], undefined, {
      isUnbounded: () => true,
    });

    expect(res.truncatedBy).toBe("reasoning_burn");
    expect(tally.produced).toBeLessThan(chunkCount(PATHOLOGY_REASONING_CHARS));
  });

  it("surfaces reasoning-chars-so-far to the caller AS THEY ARRIVE, not at the end", async () => {
    const tally: Tally = { produced: 0 };
    const provider = lmBurner({ total: HEALTHY_OPENING_REASONING_CHARS, tally, toolCallAfter: true });

    // Recorded at the moment the transport had produced its 3rd chunk — i.e. long
    // before the call returns, which is the only thing this hook exists to change.
    const readings: Array<{ at: number; reasoningChars: number; toolCallStarted: boolean }> = [];
    await provider.completeViaStream([{ role: "user", content: "build it" }], [], undefined, {
      onProgress: (p) => readings.push({ at: tally.produced, reasoningChars: p.reasoningChars, toolCallStarted: p.toolCallStarted }),
    });

    const early = readings.find((r) => r.at === 3);
    expect(early).toBeDefined();
    expect(early!.reasoningChars).toBe(3 * CHUNK_CHARS);
    expect(early!.toolCallStarted).toBe(false);
    expect(readings.at(-1)!.toolCallStarted).toBe(true);
  });
});

describe("mid-stream reasoning burn — Anthropic provider", () => {
  it("aborts the burning generation mid-stream and keeps the partial", async () => {
    const tally: Tally = { produced: 0 };
    const provider = anthropicBurner({ total: PATHOLOGY_REASONING_CHARS, tally, shape: "looping" });

    const res = await provider.completeViaStream([{ role: "user", content: "build it" }], []);

    expect(res.reasoning!.length).toBeLessThan(PATHOLOGY_REASONING_CHARS);
    expect(tally.produced).toBeLessThan(chunkCount(PATHOLOGY_REASONING_CHARS));
    expect(res.truncatedBy).toBe("reasoning_burn");
    expect(res.finishReason).toBe("length");
  });

  it("leaves the healthy shape — long opening think, then a tool call — untouched", async () => {
    const tally: Tally = { produced: 0 };
    const provider = anthropicBurner({ total: HEALTHY_OPENING_REASONING_CHARS, tally, toolCallAfter: true });

    const res = await provider.completeViaStream([{ role: "user", content: "build it" }], []);

    expect(res.reasoning!.length).toBe(HEALTHY_OPENING_REASONING_CHARS);
    expect(res.tool_calls).toHaveLength(1);
    expect(res.truncatedBy).toBeUndefined();
  });

  it("does NOT cut a run holding the operator's unbounded grant", async () => {
    const tally: Tally = { produced: 0 };
    const provider = anthropicBurner({ total: PATHOLOGY_REASONING_CHARS, tally });

    const res = await provider.completeViaStream([{ role: "user", content: "build it" }], [], undefined, {
      isUnbounded: () => true,
    });

    expect(res.reasoning!.length).toBe(PATHOLOGY_REASONING_CHARS);
    expect(res.truncatedBy).toBeUndefined();
  });
});

/**
 * The wrappers every real deployment runs through. A provider-level guard that a
 * wrapper drops on the floor is inert exactly where it matters most — the failover
 * chain has done precisely this before (see FailoverChatProvider.completeViaStream).
 */
describe("the wrappers forward the observation options", () => {
  function recordingProvider(): { provider: ChatProvider; seen: { options?: CompletionCallOptions } } {
    const seen: { options?: CompletionCallOptions } = {};
    const provider: ChatProvider = {
      checkHealth: async () => ({ healthy: true }),
      verifyToolCallSupport: async () => true,
      complete: async (): Promise<LLMResponse> => ({ content: "no", tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" }),
      completeViaStream: async (_m, _t, _s, options): Promise<LLMResponse> => {
        seen.options = options;
        return { content: "ok", tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" };
      },
      stream: async function* (): AsyncGenerator<StreamChunk> { return; },
      embed: async () => [],
      isHealthy: () => true,
    };
    return { provider, seen };
  }

  it("llm-boundary passes the unbounded grant and the progress hook through", async () => {
    const { provider, seen } = recordingProvider();
    const wrapped = wrapProviderWithBoundary(provider);
    const isUnbounded = () => true;

    await wrapped.completeViaStream!([{ role: "user", content: "hi" }], [], undefined, { isUnbounded });

    expect(seen.options?.isUnbounded).toBe(isUnbounded);
  });

  it("the failover chain passes them through to the active binding", async () => {
    const { provider, seen } = recordingProvider();
    const chain = new FailoverChatProvider([
      { endpoint: { providerId: "p", model: "m", baseUrl: "http://x", apiKey: "k", priority: "primary" }, provider },
    ]);
    const isUnbounded = () => true;

    await chain.completeViaStream([{ role: "user", content: "hi" }], [], undefined, { isUnbounded });

    expect(seen.options?.isUnbounded).toBe(isUnbounded);
  });
});
