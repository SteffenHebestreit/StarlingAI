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
/** The provider's warnings, read by the refused-prefill cases below. */
const warnings: Array<{ fields: Record<string, unknown>; msg: string }> = [];
vi.mock("../logger.js", () => {
  const stub: Record<string, unknown> = {};
  for (const level of ["trace", "debug", "info", "error", "fatal"]) stub[level] = () => undefined;
  stub["warn"] = (fields: Record<string, unknown>, msg: string) => { warnings.push({ fields, msg }); };
  stub["child"] = () => stub;
  return { logger: stub, childLogger: () => stub };
});

const {
  LMStudioProvider,
  _resetRejectedReasoningEffortsForTests,
  _resetToolCallPrefillRefusalsForTests,
  isToolCallPrefillRefusal,
} = await import("../providers/lmstudio.js");

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

/** `refuse` answers a request with an error instead (the SDK throws a non-2xx answer at the send).
 *  `stub.cut` accepts a stream request and drops the connection after its first delta;
 *  `stub.maxRetries` is the provider's own retry budget, 0 unless set. */
function mockProvider(
  cfg: Partial<ModelConfig> = {},
  refuse?: (body: Record<string, unknown>) => Error | undefined,
  stub: { cut?: (body: Record<string, unknown>) => boolean; maxRetries?: number } = {},
) {
  const bodies: Array<Record<string, unknown>> = [];
  const provider = new LMStudioProvider("http://localhost:1234/v1", "test", { ...base, ...cfg }, { maxRetries: stub.maxRetries ?? 0 });
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          bodies.push(body);
          const refusal = refuse?.(body);
          if (refusal) throw refusal;
          if (body["stream"]) {
            const cutAfterFirst = stub.cut?.(body) ?? false;
            return (async function* () {
              for (const part of STREAM_REASONING) {
                yield { choices: [{ delta: { reasoning_content: part }, finish_reason: null }] };
                if (cutAfterFirst) throw new Error("Premature close");
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

beforeEach(() => {
  rows.length = 0;
  warnings.length = 0;
});
afterEach(() => {
  _resetRejectedReasoningEffortsForTests();
  _resetToolCallPrefillRefusalsForTests();
});

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

/**
 * A FORCED CALL THAT STARTS INSIDE ITS TOOL CALL (ModelConfig.toolCallPrefill, CompletionCallOptions.prefillToolCall).
 *
 * On the deployed llama.cpp (b11015) tool_choice "required" only keeps the turn from ending until a
 * call is complete. A model that wants to answer itself writes prose until max_tokens: 13,263
 * characters on the --agent turn of 2026-10-07. With a trailing assistant message
 * `<tool_call>\n<function=` the call is the continuation, 24 times in 24 against 10 in 24 without on
 * one prompt (2026-10-08). The server's conditions are what is pinned here: only under "required",
 * never after an assistant message, never carrying tool_calls, a function name only when the grammar
 * offers it. Every assertion reads the request body the client stub received, or the audit row.
 */
const PREFILL_OPENER = "<tool_call>\n<function=";
const FORCED_PREFILLED: StreamCallOptions = { toolChoice: "required", prefillToolCall: {} };
const QWEN_XML: Partial<ModelConfig> = { toolCallPrefill: "qwen-xml" };

const wireMessages = (body: Record<string, unknown>) => body["messages"] as Array<Record<string, unknown>>;
const lastWireMessage = (body: Record<string, unknown>) => wireMessages(body)[wireMessages(body).length - 1]!;
/** What llama-server answers a continuation it cannot take (std::invalid_argument → 400). */
const prefillRefusal = () => Object.assign(new Error("400 Cannot have 2 or more assistant messages at the end of the list."), { status: 400 });
const refusePrefilled = (body: Record<string, unknown>) => (lastWireMessage(body)["role"] === "assistant" ? prefillRefusal() : undefined);

describe("a prefilled tool call goes out only on a forced call, and only where the model config names the syntax", () => {
  it("complete() and the stream path append the opener after the normalised messages", async () => {
    const { provider, bodies } = mockProvider(QWEN_XML);

    await provider.complete(messages, tools, undefined, FORCED_PREFILLED);
    await provider.completeViaStream(messages, tools, undefined, FORCED_PREFILLED);

    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(wireMessages(body).map((m) => m["role"])).toEqual(["system", "user", "assistant"]);
      expect(lastWireMessage(body)).toEqual({ role: "assistant", content: PREFILL_OPENER });
      // The string, never the object form: llama-server reads the object as "auto" and says so
      // only in its own log.
      expect(body["tool_choice"]).toBe("required");
    }
  });

  it("is not sent without 'required', unasked, or without the flag", async () => {
    const { provider, bodies } = mockProvider(QWEN_XML);
    await provider.complete(messages, tools, undefined, { toolChoice: "auto", prefillToolCall: {} });
    await provider.complete(messages, tools, undefined, { prefillToolCall: {} });
    await provider.completeViaStream(messages, tools, undefined, { toolChoice: "auto", prefillToolCall: {} });
    await provider.complete(messages, tools, undefined, { toolChoice: "required" });
    const { provider: unflagged, bodies: unflaggedBodies } = mockProvider();
    await unflagged.complete(messages, tools, undefined, FORCED_PREFILLED);
    await unflagged.completeViaStream(messages, tools, undefined, FORCED_PREFILLED);

    for (const body of [...bodies, ...unflaggedBodies]) {
      expect(wireMessages(body).map((m) => m["role"])).toEqual(["system", "user"]);
    }
  });

  it("is never sent after an assistant message, and is content only — never tool_calls", async () => {
    const { provider, bodies } = mockProvider(QWEN_XML);
    // llama-server answers 400 "Cannot have 2 or more assistant messages at the end of the list".
    const endsWithAssistant: LLMMessage[] = [...messages, { role: "assistant", content: "Let me check." }];
    const endsWithToolCall: LLMMessage[] = [...messages, {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "record_verdict", arguments: "{}" } }],
    }];
    await provider.complete(endsWithAssistant, tools, undefined, FORCED_PREFILLED);
    await provider.completeViaStream(endsWithAssistant, tools, undefined, FORCED_PREFILLED);
    await provider.complete(endsWithToolCall, tools, undefined, FORCED_PREFILLED);

    expect(wireMessages(bodies[0]!)).toHaveLength(endsWithAssistant.length);
    expect(lastWireMessage(bodies[0]!)).toEqual({ role: "assistant", content: "Let me check." });
    expect(wireMessages(bodies[1]!)).toHaveLength(endsWithAssistant.length);
    expect(wireMessages(bodies[2]!)).toHaveLength(endsWithToolCall.length);
    expect(lastWireMessage(bodies[2]!)["tool_calls"]).toHaveLength(1);

    // The prefill itself: llama-server answers 400 "Cannot continue an assistant message that
    // contains tool calls", so the message carries the two fields and nothing else.
    const { provider: forced, bodies: forcedBodies } = mockProvider(QWEN_XML);
    await forced.complete(messages, tools, undefined, FORCED_PREFILLED);
    expect(Object.keys(lastWireMessage(forcedBodies[0]!)).sort()).toEqual(["content", "role"]);
  });

  it("is not sent on a forced call with no tools: no tool_choice goes out then, so no grammar would take the opener", async () => {
    const { provider, bodies } = mockProvider(QWEN_XML);
    await provider.complete(messages, [], undefined, FORCED_PREFILLED);
    await provider.completeViaStream(messages, [], undefined, FORCED_PREFILLED);

    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body["tool_choice"]).toBeUndefined();
      // Sent anyway, the opener would be continued as plain text: the reply would read
      // "<tool_call>\n<function=…" with nothing to parse it as a call.
      expect(wireMessages(body).map((m) => m["role"])).toEqual(["system", "user"]);
    }
    expect(modelCalls().map((row) => [row["prefill"], row["prefillSkipped"]])).toEqual([
      [null, "no_tools"],
      [null, "no_tools"],
    ]);
  });

  it("names the tool only when that tool is in the request; any other name leaves the opener bare", async () => {
    const { provider, bodies } = mockProvider(QWEN_XML);
    await provider.complete(messages, tools, undefined, { toolChoice: "required", prefillToolCall: { tool: "record_verdict" } });
    await provider.completeViaStream(messages, tools, undefined, { toolChoice: "required", prefillToolCall: { tool: "record_verdict" } });
    await provider.complete(messages, tools, undefined, { toolChoice: "required", prefillToolCall: { tool: "delegate_to_agent" } });

    expect(lastWireMessage(bodies[0]!)).toEqual({ role: "assistant", content: `${PREFILL_OPENER}record_verdict>\n` });
    expect(lastWireMessage(bodies[1]!)).toEqual({ role: "assistant", content: `${PREFILL_OPENER}record_verdict>\n` });
    // delegate_to_agent is not among this request's tools. The grammar offers only the names sent,
    // and an opener it rejects fails the whole request, so the opener stays bare.
    expect(lastWireMessage(bodies[2]!)).toEqual({ role: "assistant", content: PREFILL_OPENER });
  });

  it("the audit row says what was sent, and a row the feature does not govern is left as it was", async () => {
    const { provider } = mockProvider(QWEN_XML);
    await provider.complete(messages, tools, undefined, FORCED_PREFILLED);
    await provider.completeViaStream(messages, tools, undefined, { toolChoice: "required", prefillToolCall: { tool: "record_verdict" } });
    await provider.complete(messages, tools, undefined, { toolChoice: "auto", prefillToolCall: {} });
    await provider.complete(messages, tools, undefined, { toolChoice: "required" });

    const calls = modelCalls();
    expect(calls).toHaveLength(4);
    expect(calls[0]!["prefill"]).toBe("bare");
    expect(calls[0]).not.toHaveProperty("prefillSkipped");
    expect(calls[1]!["prefill"]).toBe("named");
    expect(calls[2]!["prefill"]).toBeNull();
    expect(calls[2]!["prefillSkipped"]).toBe("tool_choice");
    expect(calls[3]).not.toHaveProperty("prefill");
  });
});

describe("a refused prefill: the call is retried once without it, and the endpoint is remembered only when that retry is served", () => {
  it("complete(): retries outside the attempt budget, and once the retry is served the next forced call goes without", async () => {
    // maxRetries 0: without a retry of its own, the refusal would end the call.
    const { provider, bodies } = mockProvider(QWEN_XML, refusePrefilled);

    const first = await provider.complete(messages, tools, undefined, FORCED_PREFILLED);
    await provider.complete(messages, tools, undefined, FORCED_PREFILLED);

    expect(first.content).toBe("YES");
    expect(bodies.map((body) => lastWireMessage(body)["role"])).toEqual(["assistant", "user", "user"]);
    // The retry reads as the retry; only a call after it reads as a remembered refusal.
    expect(modelCalls().map((row) => [row["finishReason"], row["prefill"], row["prefillSkipped"]])).toEqual([
      ["error", "bare", undefined],
      ["stop", null, "refusal_retry"],
      ["stop", null, "endpoint_refused"],
    ]);
  });

  it("remembers nothing when the retry without the prefill is refused too: that 4xx was not the prefill's", async () => {
    // Every request is refused here, prefilled or not. Remembering the first refusal would send
    // every later forced call to this endpoint without the prefill until the gateway restarts —
    // the mode that wrote 13,263 characters of prose on 2026-10-07.
    const notThePrefills = () => Object.assign(new Error("400 Bad Request"), { status: 400 });
    let refusing = true;
    const { provider, bodies } = mockProvider(QWEN_XML, () => (refusing ? notThePrefills() : undefined));

    await expect(provider.complete(messages, tools, undefined, FORCED_PREFILLED)).rejects.toThrow(/400/);
    await expect(provider.completeViaStream(messages, tools, undefined, FORCED_PREFILLED)).rejects.toThrow(/400/);
    refusing = false;
    await provider.complete(messages, tools, undefined, FORCED_PREFILLED);
    await provider.completeViaStream(messages, tools, undefined, FORCED_PREFILLED);

    // Each refused call: the prefilled request, then its one retry without. Then both paths prefill again.
    expect(bodies.map((body) => lastWireMessage(body)["role"])).toEqual(["assistant", "user", "assistant", "user", "assistant", "assistant"]);
  });

  it("complete(): only THE retry counts — refused, the retry fails, a budgeted attempt is served, nothing remembered", async () => {
    // maxRetries 1 gives the call one more attempt after the free retry, 2 s later (faked here).
    let call = 0;
    const { provider, bodies } = mockProvider(QWEN_XML, () => {
      call += 1;
      if (call === 1) return prefillRefusal();
      if (call === 2) return Object.assign(new Error("502 Bad Gateway"), { status: 502 });
      return undefined;
    }, { maxRetries: 1 });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const served = provider.complete(messages, tools, undefined, FORCED_PREFILLED);
      await vi.advanceTimersByTimeAsync(2000);
      expect((await served).content).toBe("YES");
    } finally {
      vi.useRealTimers();
    }
    await provider.complete(messages, tools, undefined, FORCED_PREFILLED);

    // The rest of the refused call went without the prefill; the next call is prefilled again.
    expect(bodies.map((body) => lastWireMessage(body)["role"])).toEqual(["assistant", "user", "user", "assistant"]);
    // One refusal, one deciding retry. The attempt the budget adds after it decides nothing and
    // reads so: a served "refusal_retry" row says the endpoint was remembered, and this one was not.
    expect(modelCalls().map((row) => [row["finishReason"], row["prefill"], row["prefillSkipped"]])).toEqual([
      ["error", "bare", undefined],
      ["error", null, "refusal_retry"],
      ["stop", null, "refused_in_call"],
      ["stop", "bare", undefined],
    ]);
  });

  it("a context overflow is not taken for a refusal: not retried, and the next forced call is still prefilled", async () => {
    // llama-server answers an overflow with 400 exceed_context_size_error, on the stream path too
    // (the first error of a stream goes out as a plain response). It is about size, not the
    // prefill's shape, and the same call without the prefill overflows as well.
    const overflow = () => Object.assign(
      new Error("400 request (70123 tokens) exceeds the available context size (65536 tokens), try increasing it"),
      { status: 400, type: "exceed_context_size_error" },
    );
    let overflowing = true;
    const { provider, bodies } = mockProvider(QWEN_XML, () => (overflowing ? overflow() : undefined));

    await expect(provider.complete(messages, tools, undefined, FORCED_PREFILLED)).rejects.toThrow(/exceeds the available context size/);
    await expect(provider.completeViaStream(messages, tools, undefined, FORCED_PREFILLED)).rejects.toThrow(/exceeds the available context size/);
    overflowing = false;
    await provider.complete(messages, tools, undefined, FORCED_PREFILLED);

    // One request per overflowing call, and the prefill stays on.
    expect(bodies.map((body) => lastWireMessage(body)["role"])).toEqual(["assistant", "assistant", "assistant"]);
  });

  it("the stream path remembers the refusal only once the retry is served to the end", async () => {
    // The first retry is cut after its first delta: the partial is salvaged, but the retry was not
    // served, so nothing shows the prefill was the cause. The second call's retry is served.
    let cutRetry = true;
    const { provider, bodies } = mockProvider(QWEN_XML, refusePrefilled, {
      cut: (body) => cutRetry && lastWireMessage(body)["role"] === "user",
    });

    await provider.completeViaStream(messages, tools, undefined, FORCED_PREFILLED);
    cutRetry = false;
    await provider.completeViaStream(messages, tools, undefined, FORCED_PREFILLED);
    await provider.completeViaStream(messages, tools, undefined, FORCED_PREFILLED);

    expect(bodies.map((body) => lastWireMessage(body)["role"])).toEqual(["assistant", "user", "assistant", "user", "user"]);
  });

  it("the warnings carry what the server answered, redacted", async () => {
    // An opener the tool-call grammar does not take: llama-server fails the sampler setup with 400
    // (b11015, server-context.cpp). The key-shaped string stands for anything a server may echo.
    // A made-up key, assembled at run time: as one literal it is a secret-scanner hit (GitHub
    // flagged one in a redaction test on 2026-09-29), although the redaction only needs it here.
    const echoedKey = ["sk", "proj", "ABCDEFGHIJ1234567890"].join("-");
    const grammarRefusal = () => Object.assign(
      new Error(`400 Failed to initialize samplers: Unexpected empty grammar stack after accepting piece: < (${echoedKey})`),
      { status: 400 },
    );
    const { provider } = mockProvider(QWEN_XML, (body) => (lastWireMessage(body)["role"] === "assistant" ? grammarRefusal() : undefined));
    await provider.complete(messages, tools, undefined, FORCED_PREFILLED);

    // One when the call is retried without the prefill, one when the served retry makes it a refusal.
    const prefillWarnings = warnings.filter((warning) => /prefill/i.test(warning.msg));
    expect(prefillWarnings).toHaveLength(2);
    for (const warning of prefillWarnings) {
      expect(warning.fields["status"]).toBe(400);
      expect(warning.fields["error"]).toContain("Failed to initialize samplers: Unexpected empty grammar stack");
      expect(String(warning.fields["error"])).not.toContain("ABCDEFGHIJ");
    }
  });

  it("the stream path: the refusal comes before any chunk, and the retry is served", async () => {
    const { provider, bodies } = mockProvider(QWEN_XML, refusePrefilled);

    const first = await provider.completeViaStream(messages, tools, undefined, FORCED_PREFILLED);
    await provider.completeViaStream(messages, tools, undefined, FORCED_PREFILLED);

    expect(first.content).toBe("YES");
    expect(bodies.map((body) => lastWireMessage(body)["role"])).toEqual(["assistant", "user", "user"]);
  });

  it("the stream's retry is not one of its drop-retry attempts: refused, then dropped, then served", async () => {
    // maxRetries 0 floors the stream at two attempts. The refusal must not use one of them up.
    let call = 0;
    const { provider, bodies } = mockProvider(QWEN_XML, () => {
      call += 1;
      if (call === 1) return prefillRefusal();
      if (call === 2) return new Error("Premature close");
      return undefined;
    });

    const result = await provider.completeViaStream(messages, tools, undefined, FORCED_PREFILLED);
    await provider.completeViaStream(messages, tools, undefined, FORCED_PREFILLED);

    expect(result.content).toBe("YES");
    // The rest of the call goes without the prefill. The retry itself was dropped, not served, so
    // nothing was remembered and the next call is prefilled again.
    expect(bodies.map((body) => lastWireMessage(body)["role"])).toEqual(["assistant", "user", "user", "assistant"]);
    // A stream request that fails before its first chunk writes no row, so the served drop retry
    // carries the call's only row. It is not the retry that decided, and must not read as one.
    expect(modelCalls().map((row) => [row["finishReason"], row["prefill"], row["prefillSkipped"]])).toEqual([
      ["stop", null, "refused_in_call"],
      ["stop", "bare", undefined],
    ]);
  });

  it("is remembered per endpoint AND model: another model behind the same address keeps its prefill", async () => {
    const { provider: refusing } = mockProvider(QWEN_XML, refusePrefilled);
    await refusing.complete(messages, tools, undefined, FORCED_PREFILLED);

    const { provider: other, bodies } = mockProvider({ ...QWEN_XML, primary: "lmstudio/qwen/qwen3.6-27b" });
    await other.complete(messages, tools, undefined, FORCED_PREFILLED);

    expect(lastWireMessage(bodies[0]!)).toEqual({ role: "assistant", content: PREFILL_OPENER });
  });

  it("learns nothing from a failure that is not a refusal of the request, or from a request that carried no prefill", async () => {
    // 429 is load, not shape: the call fails as before, and the next forced call is still prefilled.
    const rateLimited = () => Object.assign(new Error("429 Too Many Requests"), { status: 429 });
    let limited = true;
    const { provider, bodies } = mockProvider(QWEN_XML, () => (limited ? rateLimited() : undefined));
    await expect(provider.complete(messages, tools, undefined, FORCED_PREFILLED)).rejects.toThrow(/429/);
    limited = false;
    await provider.complete(messages, tools, undefined, FORCED_PREFILLED);
    expect(bodies).toHaveLength(2);
    expect(lastWireMessage(bodies[1]!)).toEqual({ role: "assistant", content: PREFILL_OPENER });

    // A 400 to a request with no prefill on it is not retried by this path.
    const { provider: unflagged, bodies: unflaggedBodies } = mockProvider({}, () => prefillRefusal());
    await expect(unflagged.complete(messages, tools, undefined, FORCED_PREFILLED)).rejects.toThrow(/400/);
    expect(unflaggedBodies).toHaveLength(1);
  });

  it("reads only a 4xx about the request as a refusal", () => {
    expect(isToolCallPrefillRefusal(prefillRefusal())).toBe(true);
    expect(isToolCallPrefillRefusal({ status: 400, message: "Cannot continue an assistant message that contains tool calls." })).toBe(true);
    expect(isToolCallPrefillRefusal({ status: 400, message: "400 Failed to initialize samplers: Unexpected empty grammar stack after accepting piece: <" })).toBe(true);
    expect(isToolCallPrefillRefusal({ status: 422, message: "unprocessable" })).toBe(true);
    // Size, not shape: llama-server's context overflow is a 400 of its own type, and a body over a
    // proxy's limit is a 413. The same call without the prefill fails the same way.
    expect(isToolCallPrefillRefusal({
      status: 400,
      type: "exceed_context_size_error",
      message: "400 request (70123 tokens) exceeds the available context size (65536 tokens), try increasing it",
    })).toBe(false);
    expect(isToolCallPrefillRefusal({ status: 413, message: "Payload Too Large" })).toBe(false);
    // The credential, time and load: a condition that passes must not switch the prefill off for good.
    for (const status of [401, 403, 408, 429]) expect(isToolCallPrefillRefusal({ status, message: "x" })).toBe(false);
    // A llama-swap restart answers 502 for seconds.
    expect(isToolCallPrefillRefusal({ status: 502, message: "Bad Gateway" })).toBe(false);
    // The reasoning_effort ladder owns its own refusal.
    expect(isToolCallPrefillRefusal({ status: 400, message: "Invalid 'reasoning_effort' value: 'none'." })).toBe(false);
    expect(isToolCallPrefillRefusal(new Error("Premature close"))).toBe(false);
  });
});

describe("flag off → a forced call's request is byte-identical, prefill asked for or not", () => {
  it("asking for a prefill changes nothing without the flag, on either path, and the audit row has no prefill field", async () => {
    const { provider, bodies } = mockProvider();
    await provider.complete(messages, tools, undefined, { toolChoice: "required", prefillToolCall: { tool: "record_verdict" } });
    await provider.complete(messages, tools, undefined, { toolChoice: "required" });
    await provider.completeViaStream(messages, tools, undefined, { toolChoice: "required", prefillToolCall: {} });
    await provider.completeViaStream(messages, tools, undefined, { toolChoice: "required" });

    expect(JSON.stringify(bodies[0])).toBe(JSON.stringify(bodies[1]));
    expect(JSON.stringify(bodies[2])).toBe(JSON.stringify(bodies[3]));
    expect(modelCalls().filter((row) => "prefill" in row || "prefillSkipped" in row)).toEqual([]);
  });

  it("the flag alone changes nothing: a forced call that does not ask is the same request with or without it", async () => {
    const { provider: off, bodies: offBodies } = mockProvider();
    const { provider: on, bodies: onBodies } = mockProvider(QWEN_XML);
    for (const provider of [off, on]) {
      await provider.complete(messages, tools, undefined, { toolChoice: "required" });
      for await (const _chunk of provider.stream(messages, tools, undefined, { toolChoice: "required" })) { /* drain */ }
    }

    expect(onBodies).toHaveLength(2);
    expect(onBodies.map((body) => JSON.stringify(body))).toEqual(offBodies.map((body) => JSON.stringify(body)));
  });
});
