import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "../config/schema.js";
import type { LLMMessage, LLMToolDef, StreamCallOptions } from "../providers/lmstudio.js";

const rows: Array<{ type: string; data: Record<string, unknown> }> = [];
vi.mock("../audit/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/logger.js")>();
  return {
    ...actual,
    logAudit: vi.fn((type: string, data: Record<string, unknown>) => { rows.push({ type, data }); }),
  };
});

const { LMStudioProvider, _resetRejectedReasoningEffortsForTests } = await import("../providers/lmstudio.js");

/**
 * PER-CALL CONTROLS ON THE OPENAI-COMPATIBLE WIRE.
 *
 * Measured on the live cluster 2026-09-13: a forced tool call (tool_choice "required") issued
 * with the orchestrator's thinking ON reasoned for 8,000 tokens, hit finish_reason "length" with
 * ZERO tool calls, and cost 150 s of a 208 s turn. Nothing let the caller turn thinking off or
 * cap output for that ONE call — the only knobs were per provider instance, and the instance is
 * the orchestrator's, which thinks on purpose everywhere else.
 *
 * So the instance keeps its config and a call may override it. Every assertion here reads the
 * REQUEST BODY the client stub received, or the audit row that was written — never a proxy.
 */

/** A thinking-on Qwen instance: exactly the orchestrator's shape. No temperature pin: a pin is
 *  now honoured on the thinking-OFF calls below (qwen-sampling-precedence.test.ts), and what
 *  this file checks is that the per-call switch lands the RECOMMENDED non-thinking sampling. */
const base: ModelConfig = {
  primary: "lmstudio/qwen/qwen3.6-35b-a3b",
  contextWindow: 8192,
  maxTokens: 64,
  enableThinking: true,
  promptCache: true,
} as ModelConfig;

const messages: LLMMessage[] = [
  { role: "system", content: "You are a judge." },
  { role: "user", content: "Is water wet? Answer YES or NO." },
];
const tools: LLMToolDef[] = [
  {
    name: "record_verdict",
    description: "Record the verdict",
    parameters: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
  },
];

/** What the stub answers on the stream path: two reasoning deltas, one text delta, usage. */
const STREAM_REASONING = ["Water is a liquid. ", "Wetness is a property of solids touched by liquid."];
const STREAM_REASONING_CHARS = STREAM_REASONING.join("").length;
/** What the stub answers on the complete path. */
const COMPLETE_REASONING = "Considering the definition of wet.";

function mockProvider(cfg: Partial<ModelConfig> = {}) {
  const bodies: Array<Record<string, unknown>> = [];
  const provider = new LMStudioProvider("http://localhost:1234/v1", "test", { ...base, ...cfg }, { maxRetries: 0 });
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          bodies.push(body);
          if (body["stream"]) {
            return (async function* () {
              for (const part of STREAM_REASONING) {
                yield { choices: [{ delta: { reasoning_content: part }, finish_reason: null }] };
              }
              yield { choices: [{ delta: { content: "YES" }, finish_reason: null }] };
              yield {
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
              };
            })();
          }
          return {
            choices: [{ message: { content: "YES", reasoning_content: COMPLETE_REASONING, tool_calls: [] }, finish_reason: "stop" }],
            usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
          };
        },
      },
    },
  };
  return { provider, bodies };
}

const modelCalls = () => rows.filter((r) => r.type === "provider_model_call").map((r) => r.data);

beforeEach(() => { rows.length = 0; });
afterEach(() => _resetRejectedReasoningEffortsForTests());

const THINKING_OFF: StreamCallOptions = { controls: { enableThinking: false, reasoningEffort: "none" } };

describe("per-call thinking controls", () => {
  it("complete(): one call turns thinking off — both mechanisms and the non-thinking sampling — and the next call is untouched", async () => {
    const { provider, bodies } = mockProvider();

    await provider.complete(messages, tools, undefined, THINKING_OFF);
    await provider.complete(messages, tools);

    // The call that asked: reasoning_effort "none" (the only control measured to work on the
    // llama.cpp qwen3.6 backend) AND enable_thinking:false, plus Qwen's non-thinking sampling.
    const off = bodies[0]!;
    expect(off["reasoning_effort"]).toBe("none");
    expect(off["chat_template_kwargs"]).toEqual({ enable_thinking: false });
    expect(off["temperature"]).toBe(0.7);
    expect(off["top_p"]).toBe(0.8);

    // NO LEAKAGE: the same instance, next call, no options — instance defaults, thinking on.
    const on = bodies[1]!;
    expect(on["reasoning_effort"]).toBeUndefined();
    expect(on["chat_template_kwargs"]).toEqual({ enable_thinking: true });
    expect(on["temperature"]).toBe(0.6);
    expect(on["top_p"]).toBe(0.95);
  });

  it("stream path: the same override reaches the streaming body, and the next stream is untouched", async () => {
    const { provider, bodies } = mockProvider();

    await provider.completeViaStream(messages, tools, undefined, THINKING_OFF);
    await provider.completeViaStream(messages, tools);

    const off = bodies[0]!;
    expect(off["stream"]).toBe(true);
    expect(off["reasoning_effort"]).toBe("none");
    expect(off["chat_template_kwargs"]).toEqual({ enable_thinking: false });
    expect(off["temperature"]).toBe(0.7);
    expect(off["top_p"]).toBe(0.8);

    const on = bodies[1]!;
    expect(on["reasoning_effort"]).toBeUndefined();
    expect(on["chat_template_kwargs"]).toEqual({ enable_thinking: true });
    expect(on["temperature"]).toBe(0.6);
    expect(on["top_p"]).toBe(0.95);
  });

  it("a key the caller leaves undefined is 'no opinion' — it does not unset the instance value", async () => {
    const { provider, bodies } = mockProvider();
    await provider.complete(messages, tools, undefined, { controls: { reasoningEffort: undefined, enableThinking: undefined } });
    expect(bodies[0]!["chat_template_kwargs"]).toEqual({ enable_thinking: true });
    expect(bodies[0]!["temperature"]).toBe(0.6);
  });
});

describe("per-call max_tokens ceiling", () => {
  it("caps the derived budget on both paths, and never raises it", async () => {
    const { provider, bodies } = mockProvider();

    await provider.complete(messages, tools, undefined, { maxTokens: 16 });
    await provider.completeViaStream(messages, tools, undefined, { maxTokens: 16 });
    await provider.complete(messages, tools, undefined, { maxTokens: 100_000 });
    await provider.complete(messages, tools);

    expect(bodies[0]!["max_tokens"]).toBe(16);
    expect(bodies[1]!["max_tokens"]).toBe(16);
    // The instance ceiling (64) is the smaller one here — a per-call value is min(), never a raise.
    expect(bodies[2]!["max_tokens"]).toBe(64);
    expect(bodies[3]!["max_tokens"]).toBe(64);
  });
});

describe("per-call tool_choice on the non-stream path", () => {
  it("reaches the complete() body — 'none' and 'required' — and defaults to 'auto'", async () => {
    const { provider, bodies } = mockProvider();

    await provider.complete(messages, tools, undefined, { toolChoice: "none" });
    await provider.complete(messages, tools, undefined, { toolChoice: "required" });
    await provider.complete(messages, tools);

    expect(bodies[0]!["tool_choice"]).toBe("none");
    expect(bodies[1]!["tool_choice"]).toBe("required");
    expect(bodies[2]!["tool_choice"]).toBe("auto");
  });
});

describe("the audit row reports the controls ACTUALLY SENT and the reasoning length", () => {
  it("complete(): per-call controls and the reasoning field's length, then the instance defaults on the next row", async () => {
    const { provider } = mockProvider();

    await provider.complete(messages, tools, undefined, THINKING_OFF);
    await provider.complete(messages, tools);

    const calls = modelCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!["controls"]).toEqual({ reasoningEffort: "none", enableThinking: false, cachePrompt: true });
    expect(calls[0]!["reasoningChars"]).toBe(COMPLETE_REASONING.length);
    // Recomputing from instance config here would have said "on" for the call above.
    expect(calls[1]!["controls"]).toEqual({ reasoningEffort: null, enableThinking: true, cachePrompt: true });
  });

  it("stream: the accumulated reasoning length, per call", async () => {
    const { provider } = mockProvider();

    await provider.completeViaStream(messages, tools, undefined, THINKING_OFF);

    const row = modelCalls()[0]!;
    expect(row["mode"]).toBe("stream");
    expect(row["controls"]).toEqual({ reasoningEffort: "none", enableThinking: false, cachePrompt: true });
    expect(row["reasoningChars"]).toBe(STREAM_REASONING_CHARS);
    // llama.cpp folds reasoning into completion_tokens and reports no split: reasoningTokens stays
    // null (all 196 rows of the last four days), which is why the char count has to be on the row.
    expect(row["reasoningTokens"]).toBeNull();
  });

  it("a response with no reasoning at all records 0, not null — the parser ran and saw none", async () => {
    const { provider } = mockProvider();
    (provider as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "YES", tool_calls: [] }, finish_reason: "stop" }],
            usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 },
          }),
        },
      },
    };
    await provider.complete(messages, tools, undefined, THINKING_OFF);
    expect(modelCalls()[0]!["reasoningChars"]).toBe(0);
  });
});

/**
 * THE INVARIANT: a call with no options is byte-identical to what went on the wire before any of
 * this existed. The two literals below were captured from the provider as shipped at d9063cc,
 * against exactly this fixture, BEFORE the per-call options were added — so they compare against
 * the old code, not against the new code's own output.
 */
describe("no options → byte-identical request body", () => {
  const COMPLETE_BODY = '{"model":"qwen/qwen3.6-35b-a3b","messages":[{"role":"system","content":"You are a judge."},{"role":"user","content":"Is water wet? Answer YES or NO."}],"tools":[{"type":"function","function":{"name":"record_verdict","description":"Record the verdict","parameters":{"type":"object","properties":{"verdict":{"type":"string"}},"required":["verdict"]}}}],"tool_choice":"auto","temperature":0.6,"max_tokens":64,"top_p":0.95,"chat_template_kwargs":{"enable_thinking":true},"cache_prompt":true}';
  const STREAM_BODY = '{"model":"qwen/qwen3.6-35b-a3b","messages":[{"role":"system","content":"You are a judge."},{"role":"user","content":"Is water wet? Answer YES or NO."}],"tools":[{"type":"function","function":{"name":"record_verdict","description":"Record the verdict","parameters":{"type":"object","properties":{"verdict":{"type":"string"}},"required":["verdict"]}}}],"tool_choice":"auto","temperature":0.6,"max_tokens":64,"top_p":0.95,"chat_template_kwargs":{"enable_thinking":true},"cache_prompt":true,"stream":true,"stream_options":{"include_usage":true}}';

  it("complete() and stream() without options serialise exactly as before", async () => {
    const { provider, bodies } = mockProvider();
    await provider.complete(messages, tools);
    for await (const _chunk of provider.stream(messages, tools)) { /* drain */ }
    expect(JSON.stringify(bodies[0])).toBe(COMPLETE_BODY);
    expect(JSON.stringify(bodies[1])).toBe(STREAM_BODY);
  });

  it("an empty options bag is the same as no options", async () => {
    const { provider, bodies } = mockProvider();
    await provider.complete(messages, tools, undefined, {});
    await provider.complete(messages, tools);
    expect(JSON.stringify(bodies[0])).toBe(COMPLETE_BODY);
    expect(JSON.stringify(bodies[0])).toBe(JSON.stringify(bodies[1]));
  });
});
