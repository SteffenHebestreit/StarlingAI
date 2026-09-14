import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "../config/schema.js";
import type { LLMMessage, LLMToolDef } from "../providers/lmstudio.js";

const rows: Array<{ type: string; data: Record<string, unknown> }> = [];
vi.mock("../audit/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/logger.js")>();
  return {
    ...actual,
    logAudit: vi.fn((type: string, data: Record<string, unknown>) => { rows.push({ type, data }); }),
  };
});

const { AnthropicProvider } = await import("../providers/anthropic.js");
const { ReasoningBurnAbort, isReasoningBurnAbort } = await import("../providers/lmstudio.js");

/**
 * THE ANTHROPIC PROVIDER EMITTED NO provider_model_call ROWS AT ALL.
 *
 * Four Claude sub-agent runs and two Claude-orchestrated turns (2026-09-13) were absent from
 * every per-call figure the audit log supports. Both paths now write the same field set as the
 * OpenAI-compatible provider, so one analysis reads both.
 */

const modelConfig: ModelConfig = {
  primary: "anthropic/claude-sonnet-4-6",
  contextWindow: 200_000,
  temperature: 0,
  enableThinking: false,
} as ModelConfig;

const messages: LLMMessage[] = [
  { role: "system", content: "You are a judge." },
  { role: "user", content: "Is water wet? Answer YES or NO." },
];
const tools: LLMToolDef[] = [
  { name: "record_verdict", description: "Record the verdict", parameters: { type: "object", properties: {} } },
  { name: "share_finding", description: "Share a finding", parameters: { type: "object", properties: {} } },
];

const THINKING = ["Water is a liquid. ", "Wetness is a property of solids touched by liquid."];
const THINKING_CHARS = THINKING.join("").length;

function stubbed() {
  const params: Array<Record<string, unknown>> = [];
  const provider = new AnthropicProvider("https://api.anthropic.com", "sk-ant-api03-key", modelConfig, { maxRetries: 0 });
  (provider as unknown as { client: unknown }).client = {
    messages: {
      create: async (body: Record<string, unknown>) => {
        params.push(body);
        if (body["stream"]) {
          return (async function* () {
            yield { type: "message_start", message: { usage: { input_tokens: 1_200, cache_read_input_tokens: 300 } } };
            yield { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } };
            for (const part of THINKING) {
              yield { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: part } };
            }
            yield { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } };
            yield { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "YES" } };
            yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 18 } };
          })();
        }
        return {
          content: [{ type: "text", text: "YES" }],
          usage: { input_tokens: 1_200, cache_read_input_tokens: 300, output_tokens: 3 },
          stop_reason: "end_turn",
        };
      },
    },
  };
  return { provider, params };
}

const modelCalls = () => rows.filter((r) => r.type === "provider_model_call").map((r) => r.data);

beforeEach(() => { rows.length = 0; });

describe("provider_model_call from the Anthropic provider", () => {
  it("complete() writes one row with the OpenAI-compatible field set", async () => {
    const { provider } = stubbed();
    await provider.complete(messages, tools);

    const calls = modelCalls();
    expect(calls).toHaveLength(1);
    const row = calls[0]!;
    expect(row["model"]).toBe("claude-sonnet-4-6");
    expect(row["mode"]).toBe("complete");
    expect(typeof row["durationMs"]).toBe("number");
    expect(row["ttftMs"]).toBeUndefined();
    // Cache reads count as prompt tokens, as the returned usage already does.
    expect(row["promptTokens"]).toBe(1_500);
    expect(row["completionTokens"]).toBe(3);
    expect(row["reasoningTokens"]).toBeNull();
    // No thinking parser on the non-streaming path: nothing captured.
    expect(row["reasoningChars"]).toBeNull();
    expect(row["finishReason"]).toBe("stop");
    expect(row["toolCount"]).toBe(2);
    // The CALLER-VISIBLE count. The wire array is a different number here (system hoisted out,
    // consecutive same-role turns merged) and a different number again on the OpenAI-compatible
    // side, which made the field incomparable across the two providers one analysis reads.
    expect(row["messageCount"]).toBe(2);
    expect(row["controls"]).toEqual({ reasoningEffort: null, enableThinking: null, cachePrompt: true });
  });

  it("stream() writes one row with ttftMs and the thinking characters the parser captured", async () => {
    const { provider } = stubbed();
    for await (const _chunk of provider.stream(messages, tools)) { /* drain */ }

    const calls = modelCalls();
    expect(calls).toHaveLength(1);
    const row = calls[0]!;
    expect(row["model"]).toBe("claude-sonnet-4-6");
    expect(row["mode"]).toBe("stream");
    expect(typeof row["durationMs"]).toBe("number");
    expect(typeof row["ttftMs"]).toBe("number");
    expect(row["promptTokens"]).toBe(1_500);
    expect(row["completionTokens"]).toBe(18);
    expect(row["reasoningTokens"]).toBeNull();
    expect(row["reasoningChars"]).toBe(THINKING_CHARS);
    expect(row["finishReason"]).toBe("stop");
    expect(row["toolCount"]).toBe(2);
    expect(row["messageCount"]).toBe(2);
    expect(row["controls"]).toEqual({ reasoningEffort: null, enableThinking: null, cachePrompt: true });
  });
});

describe("per-call options on the Anthropic provider", () => {
  it("complete(): toolChoice and maxTokens reach the request; controls are a no-op", async () => {
    const { provider, params } = stubbed();
    await provider.complete(messages, tools, undefined, {
      toolChoice: "none",
      maxTokens: 512,
      controls: { enableThinking: false, reasoningEffort: "none" },
    });
    await provider.complete(messages, tools);

    expect(params[0]!["tool_choice"]).toEqual({ type: "none" });
    expect(params[0]!["max_tokens"]).toBe(512);
    // Nothing thinking-shaped is ever sent (file header): the same body, minus the two knobs.
    expect(params[0]!["thinking"]).toBeUndefined();
    expect(params[1]!["tool_choice"]).toEqual({ type: "auto" });
    expect(params[1]!["max_tokens"]).toBeGreaterThan(512);
  });

  it("stream(): maxTokens is one more ceiling, never a raise", async () => {
    const { provider, params } = stubbed();
    for await (const _chunk of provider.stream(messages, tools, undefined, { maxTokens: 256 })) { /* drain */ }
    for await (const _chunk of provider.stream(messages, tools, undefined, { maxTokens: 10_000_000 })) { /* drain */ }
    for await (const _chunk of provider.stream(messages, tools)) { /* drain */ }

    expect(params[0]!["max_tokens"]).toBe(256);
    expect(params[1]!["max_tokens"]).toBe(params[2]!["max_tokens"]);
  });
});

/**
 * SURVIVOR BIAS: A CALL THAT DIED WROTE NO ROW AT ALL.
 *
 * stream() wrote its row only after the for-await completed normally, and complete() only on
 * the successful return — so every Claude duration and reasoning percentile was computed over
 * survivors. That is the same distortion the September audit found in the openai SDK's
 * laundered aborts, and it hides exactly the calls a percentile is asked about: the long ones
 * that were cut. The OpenAI-compatible provider has recorded its abort path all along
 * (finishReason "aborted", with the tokens and reasoningChars seen so far); both Anthropic
 * paths now do too.
 */
function stubbedDyingMidStream(thrown: Error, onSecondEvent?: () => void) {
  const provider = new AnthropicProvider("https://api.anthropic.com", "sk-ant-api03-key", modelConfig, { maxRetries: 0 });
  (provider as unknown as { client: unknown }).client = {
    messages: {
      create: async () =>
        (async function* () {
          yield { type: "message_start", message: { usage: { input_tokens: 1_200, cache_read_input_tokens: 300 } } };
          yield { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } };
          for (const part of THINKING) {
            yield { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: part } };
          }
          yield { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 7 } };
          onSecondEvent?.();
          // One more event so the loop re-enters and the caller-abort check can fire; when the
          // test wants a raw transport death instead, this generator throws it first.
          if (!onSecondEvent) throw thrown;
          yield { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "." } };
        })(),
    },
  };
  return provider;
}

describe("a failed model call still writes its row", () => {
  it("stream() that dies mid-generation: one row, finishReason 'error', with the thinking characters and tokens seen so far", async () => {
    const provider = stubbedDyingMidStream(new Error("socket hang up"));
    await expect(async () => {
      for await (const _chunk of provider.stream(messages, tools)) { /* drain */ }
    }).rejects.toThrow(/socket hang up/);

    const calls = modelCalls();
    expect(calls).toHaveLength(1);
    const row = calls[0]!;
    expect(row["mode"]).toBe("stream");
    expect(row["finishReason"]).toBe("error");
    // The whole point of the row: what the dead call had already cost.
    expect(row["reasoningChars"]).toBe(THINKING_CHARS);
    expect(row["promptTokens"]).toBe(1_500);
    expect(row["completionTokens"]).toBe(7);
    expect(typeof row["ttftMs"]).toBe("number");
    expect(row["messageCount"]).toBe(2);
    expect(row["toolCount"]).toBe(2);
  });

  it("a CALLER abort is 'aborted', not 'error' — an aborted call's duration measures patience, a failure's measures the failure", async () => {
    const ac = new AbortController();
    const provider = stubbedDyingMidStream(new Error("unused"), () => ac.abort(new Error("deadline reached")));
    await expect(async () => {
      for await (const _chunk of provider.stream(messages, tools, ac.signal)) { /* drain */ }
    }).rejects.toThrow(/deadline reached/);

    const calls = modelCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!["finishReason"]).toBe("aborted");
    expect(calls[0]!["reasoningChars"]).toBe(THINKING_CHARS);
  });

  it("the reasoning-burn abort is 'aborted' too — the call whose whole significance is how much it burned", async () => {
    const provider = stubbedDyingMidStream(new ReasoningBurnAbort(THINKING_CHARS, 0));
    await expect(async () => {
      for await (const _chunk of provider.stream(messages, tools, undefined, { guardReasoningBurn: true })) { /* drain */ }
    }).rejects.toSatisfy(isReasoningBurnAbort);

    const calls = modelCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!["finishReason"]).toBe("aborted");
    expect(calls[0]!["reasoningChars"]).toBe(THINKING_CHARS);
  });

  it("complete() that fails writes a row per ATTEMPT, with no usage to report", async () => {
    const provider = new AnthropicProvider("https://api.anthropic.com", "sk-ant-api03-key", modelConfig, { maxRetries: 0 });
    (provider as unknown as { client: unknown }).client = {
      messages: { create: async () => { throw new Error("upstream 503"); } },
    };
    await expect(provider.complete(messages, tools)).rejects.toThrow(/upstream 503/);

    const calls = modelCalls();
    expect(calls).toHaveLength(1);
    const row = calls[0]!;
    expect(row["mode"]).toBe("complete");
    expect(row["finishReason"]).toBe("error");
    expect(row["promptTokens"]).toBeNull();
    expect(row["completionTokens"]).toBeNull();
    expect(row["reasoningChars"]).toBeNull();
    expect(typeof row["durationMs"]).toBe("number");
  });
});
