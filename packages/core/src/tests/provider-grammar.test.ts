import { describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "../config/schema.js";
import type { CompletionCallOptions, LLMMessage } from "../providers/lmstudio.js";

vi.mock("../audit/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/logger.js")>();
  return { ...actual, logAudit: vi.fn() };
});

const { LMStudioProvider } = await import("../providers/lmstudio.js");

/**
 * A GRAMMAR, A PER-CALL TEMPERATURE AND THE WHOLE TOKEN LIST ON THE OPENAI-COMPATIBLE WIRE.
 *
 * The intent readout (decisions/intent-readout.ts) binds its reply to one letter per line with
 * llama.cpp's `grammar`, decodes greedily so every later line is read after the argmax of the
 * earlier ones, and reads each line's letter off that token's top list — so it needs the grammar
 * in the body, the temperature it asked for, and every generated token back, in order. A call that
 * asks for none of it must go out exactly as before. Every assertion reads the REQUEST BODY the
 * client stub received, or the response the provider returned.
 */

const base: ModelConfig = {
  primary: "lmstudio/qwen/qwen3.6-35b-a3b",
  contextWindow: 8192,
  maxTokens: 256,
  enableThinking: false,
} as ModelConfig;

const messages: LLMMessage[] = [
  { role: "system", content: "Label the request." },
  { role: "user", content: "Request:\nsomething" },
];

const GRAMMAR = "root ::= \"mode: \" [A-F] \"\\ndecision: \" [A-E] \"\\nquery_en: \" [^\\r\\n]{1,200}";

/**
 * The shape llama-server sent on 2026-09-28 for a grammar-bound reply: 29 tokens, each letter one
 * token with its leading space, every token with its own top list (the restatement is synthetic).
 */
const WORDS = [" Make", " a", " short", " deck", " about", " the", " topic", " for", " a", " team", " meeting", " next", " week", "."];
const TOKENS = ["mode", ":", " C", "\n", "decision", ":", " C", "\n", "source", ":", " A", "\n", "query", "_en", ":", ...WORDS];
const SERVER_LOGPROBS = {
  content: TOKENS.map((token, i) => ({
    id: i,
    token,
    bytes: [...Buffer.from(token)],
    logprob: -0.01 * (i + 1),
    top_logprobs: [
      { id: i, token, bytes: [...Buffer.from(token)], logprob: -0.01 * (i + 1) },
      { id: 900 + i, token: " B", bytes: [32, 66], logprob: -2 - i / 10 },
    ],
  })),
};
const CONTENT = TOKENS.join("");

function mockProvider(config: ModelConfig = base) {
  const bodies: Array<Record<string, unknown>> = [];
  const provider = new LMStudioProvider("http://localhost:1234/v1", "test", config, { maxRetries: 0 });
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          bodies.push(body);
          if (body["stream"]) {
            return {
              async *[Symbol.asyncIterator]() {
                yield { choices: [{ delta: { role: "assistant", content: CONTENT } }] };
                yield { choices: [{ delta: {}, finish_reason: "stop" }] };
                yield { choices: [], usage: { prompt_tokens: 30, completion_tokens: 29, total_tokens: 59 } };
              },
            };
          }
          return {
            choices: [{ message: { content: CONTENT, tool_calls: [] }, finish_reason: "stop", logprobs: SERVER_LOGPROBS }],
            usage: { prompt_tokens: 30, completion_tokens: 29, total_tokens: 59 },
          };
        },
      },
    },
  };
  return { provider, bodies };
}

async function bodyOf(options?: CompletionCallOptions, config?: ModelConfig): Promise<Record<string, unknown>> {
  const { provider, bodies } = mockProvider(config);
  await provider.complete(messages, [], undefined, options);
  return bodies[0]!;
}

async function streamBodyOf(options?: CompletionCallOptions): Promise<Record<string, unknown>> {
  const { provider, bodies } = mockProvider();
  for await (const _chunk of provider.stream(messages, [], undefined, options)) { /* drain */ }
  return bodies[0]!;
}

describe("per-call grammar", () => {
  it("puts the grammar in the body when asked, and changes nothing else", async () => {
    const asked = await bodyOf({ grammar: GRAMMAR });
    const unasked = await bodyOf();
    expect(asked["grammar"]).toBe(GRAMMAR);
    const { grammar: _grammar, ...rest } = asked;
    expect(rest).toEqual(unasked);
  });

  it("leaves an unasked body without the key at all", async () => {
    expect("grammar" in (await bodyOf())).toBe(false);
    expect("grammar" in (await bodyOf({ grammar: "" }))).toBe(false);
    expect("grammar" in (await streamBodyOf())).toBe(false);
  });

  it("sends the grammar in the schema's place, which llama-server refuses beside it", async () => {
    const responseFormat = { name: "labels", schema: { type: "object" } };
    const both = await bodyOf({ grammar: GRAMMAR, responseFormat });
    expect(both["grammar"]).toBe(GRAMMAR);
    expect("response_format" in both).toBe(false);
    expect((await bodyOf({ responseFormat }))["response_format"]).toBeDefined();
  });

  it("puts it in a streamed call's body too", async () => {
    const asked = await streamBodyOf({ grammar: GRAMMAR });
    const unasked = await streamBodyOf();
    expect(asked["grammar"]).toBe(GRAMMAR);
    const { grammar: _grammar, ...rest } = asked;
    expect(rest).toEqual(unasked);
  });

  it("sends a streamed call's grammar in the schema's place too", async () => {
    const responseFormat = { name: "labels", schema: { type: "object" } };
    const both = await streamBodyOf({ grammar: GRAMMAR, responseFormat });
    expect(both["grammar"]).toBe(GRAMMAR);
    expect("response_format" in both).toBe(false);
    expect((await streamBodyOf({ responseFormat }))["response_format"]).toBeDefined();
  });
});

describe("per-call temperature", () => {
  it("replaces the temperature on a thinking-off call, and nothing else", async () => {
    const unasked = await bodyOf();
    const asked = await bodyOf({ temperature: 0 });
    // Qwen thinking-off with no pin: the model card's 0.7 / 0.8.
    expect(unasked["temperature"]).toBe(0.7);
    expect(asked["temperature"]).toBe(0);
    const { temperature: _a, ...askedRest } = asked;
    const { temperature: _u, ...unaskedRest } = unasked;
    expect(askedRest).toEqual(unaskedRest);
    expect((await streamBodyOf({ temperature: 0 }))["temperature"]).toBe(0);
  });

  it("is refused on a thinking-on call, as the config's pin is", async () => {
    const thinking = { ...base, enableThinking: true } as ModelConfig;
    const unasked = await bodyOf(undefined, thinking);
    const asked = await bodyOf({ temperature: 0 }, thinking);
    expect(asked["temperature"]).toBe(unasked["temperature"]);
    expect(asked["temperature"]).not.toBe(0);
  });

  it("wins over the model config's own temperature pin", async () => {
    // Agents pin temperatures (workspace/agents/*.jsonc: 0.1-0.3); a readout asked through such a
    // provider must still decode greedily, or every later slot is read after a sampled letter.
    const pinned = { ...base, temperature: 0.2 } as ModelConfig;
    expect((await bodyOf(undefined, pinned))["temperature"]).toBe(0.2);
    expect((await bodyOf({ temperature: 0 }, pinned))["temperature"]).toBe(0);
  });

  it("ignores a temperature that is no temperature", async () => {
    const unasked = await bodyOf();
    for (const temperature of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect((await bodyOf({ temperature }))["temperature"]).toBe(unasked["temperature"]);
    }
  });
});

describe("the token list of a grammar-bound reply", () => {
  it("hands back every generated token in order, each with its own alternatives", async () => {
    const { provider } = mockProvider();
    const response = await provider.complete(messages, [], undefined, { grammar: GRAMMAR, logprobs: true, topLogprobs: 8, maxTokens: 120 });
    expect(response.logprobs).toHaveLength(TOKENS.length);
    expect(response.logprobs!.map((entry) => entry.token)).toEqual(TOKENS);
    expect(response.logprobs!.map((entry) => entry.token).join("")).toBe(response.content);
    response.logprobs!.forEach((entry, i) => {
      expect(entry.logprob).toBeCloseTo(-0.01 * (i + 1), 10);
      expect(entry.topLogprobs.map((alt) => alt.token)).toEqual([TOKENS[i], " B"]);
    });
  });
});
