import { describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "../config/schema.js";
import type { LLMMessage } from "../providers/lmstudio.js";

vi.mock("../audit/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/logger.js")>();
  return { ...actual, logAudit: vi.fn() };
});

const { LMStudioProvider, readChoiceLogprobs } = await import("../providers/lmstudio.js");

/**
 * LOGPROBS ON THE OPENAI-COMPATIBLE WIRE.
 *
 * The logit readout (decisions/logit-readout.ts) reads a decision off the model's distribution over
 * option letters: one token, and its top alternatives. So a call may ask for them and gets them
 * back; a call that does not ask must go out and come back exactly as before. Every assertion
 * reads the REQUEST BODY the client stub received, or the response the provider returned.
 */

const base: ModelConfig = {
  primary: "lmstudio/qwen/qwen3.6-35b-a3b",
  contextWindow: 8192,
  maxTokens: 64,
  enableThinking: false,
} as ModelConfig;

const messages: LLMMessage[] = [
  { role: "system", content: "Answer with one letter." },
  { role: "user", content: "A or B?" },
];

/** What llama-server sent for a one-token readout, 2026-09-26 (trimmed). */
const SERVER_LOGPROBS = {
  content: [{
    id: 32,
    token: "A",
    bytes: [65],
    logprob: -0.185,
    top_logprobs: [
      { id: 32, token: "A", bytes: [65], logprob: -0.185 },
      { id: 33, token: "B", bytes: [66], logprob: -2.487 },
      { id: 362, token: " A", bytes: [32, 65], logprob: -2.589 },
      { id: 425, token: " B", bytes: [32, 66], logprob: -4.542 },
    ],
  }],
};

function mockProvider() {
  const bodies: Array<Record<string, unknown>> = [];
  const provider = new LMStudioProvider("http://localhost:1234/v1", "test", base, { maxRetries: 0 });
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          bodies.push(body);
          // The server answers with its list whether or not the provider asked: what the provider
          // hands back must follow the ASK, not the wire.
          return {
            choices: [{ message: { content: "A", tool_calls: [] }, finish_reason: "length", logprobs: SERVER_LOGPROBS }],
            usage: { prompt_tokens: 30, completion_tokens: 1, total_tokens: 31 },
          };
        },
      },
    },
  };
  return { provider, bodies };
}

describe("per-call logprobs", () => {
  it("asks for them when told, and hands back each token with its alternatives", async () => {
    const { provider, bodies } = mockProvider();
    const response = await provider.complete(messages, [], undefined, { maxTokens: 1, logprobs: true, topLogprobs: 20 });
    expect(bodies[0]!["logprobs"]).toBe(true);
    expect(bodies[0]!["top_logprobs"]).toBe(20);
    expect(bodies[0]!["max_tokens"]).toBe(1);
    expect(response.logprobs).toEqual([{
      token: "A",
      logprob: -0.185,
      topLogprobs: [
        { token: "A", logprob: -0.185 },
        { token: "B", logprob: -2.487 },
        { token: " A", logprob: -2.589 },
        { token: " B", logprob: -4.542 },
      ],
    }]);
  });

  it("changes nothing for a call that does not ask", async () => {
    const { provider, bodies } = mockProvider();
    const response = await provider.complete(messages, []);
    expect("logprobs" in bodies[0]!).toBe(false);
    expect("top_logprobs" in bodies[0]!).toBe(false);
    expect("logprobs" in response).toBe(false);
  });

  it("asks for the chosen token alone when no alternatives are wanted", async () => {
    const { provider, bodies } = mockProvider();
    await provider.complete(messages, [], undefined, { logprobs: true });
    expect(bodies[0]!["logprobs"]).toBe(true);
    expect("top_logprobs" in bodies[0]!).toBe(false);
  });
});

describe("reading the server's list", () => {
  it("drops an entry with no finite log-probability rather than reading it as certain or impossible", () => {
    expect(readChoiceLogprobs({
      content: [
        { token: "A", logprob: -0.1, top_logprobs: [{ token: "A", logprob: -0.1 }, { token: "B", logprob: null }, { token: 7, logprob: -3 }] },
        { token: "x", logprob: "no" },
      ],
    })).toEqual([{ token: "A", logprob: -0.1, topLogprobs: [{ token: "A", logprob: -0.1 }] }]);
  });

  it("is undefined when the answer carries no list", () => {
    expect(readChoiceLogprobs(undefined)).toBeUndefined();
    expect(readChoiceLogprobs(null)).toBeUndefined();
    expect(readChoiceLogprobs({ content: null })).toBeUndefined();
  });
});
