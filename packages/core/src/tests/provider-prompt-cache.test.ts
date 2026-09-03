import { afterEach, describe, expect, it } from "vitest";
import { LMStudioProvider, noteRejectedReasoningEffort, _resetRejectedReasoningEffortsForTests } from "../providers/lmstudio.js";
import type { ModelConfig } from "../config/schema.js";

/**
 * P1 prefill caching: when modelConfig.promptCache is set, the provider must send
 * `cache_prompt: true` so llama.cpp / LM Studio reuses the KV cache for the stable
 * prompt prefix. Opt-in — absent when the flag is unset.
 *
 * TOP-LEVEL, not nested under `extra_body`. These assertions previously checked the
 * nested shape and so locked in a bug: `extra_body` is a Python-SDK client-side
 * convenience that never reaches the wire, so an OpenAI-compatible server sees one
 * unknown field and discards everything inside it. Measured against LM Studio on
 * qwen3.8-27b: top-level `reasoning_effort:"none"` → 0 reasoning chars, the same
 * value nested under `extra_body` → 2323. cache_prompt was being dropped the same way.
 */
const base: ModelConfig = {
  primary: "lmstudio/qwen3.6-35b-a3b",
  contextWindow: 8192,
  maxTokens: 64,
  temperature: 0,
  enableThinking: false,
};

function mockProvider(cfg: Partial<ModelConfig>) {
  const captured: Array<Record<string, unknown>> = [];
  const provider = new LMStudioProvider("http://localhost:1234/v1", "test", { ...base, ...cfg }, { maxRetries: 0 });
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          captured.push(body);
          return { choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }], usage: {} };
        },
      },
    },
  };
  return { provider, captured };
}

afterEach(() => _resetRejectedReasoningEffortsForTests());

describe("LMStudioProvider promptCache → top-level cache_prompt", () => {
  it("sends cache_prompt:true when promptCache is enabled", async () => {
    const { provider, captured } = mockProvider({ promptCache: true });
    await provider.complete([{ role: "user", content: "hi" }], []);
    expect(captured[0]!["cache_prompt"]).toBe(true);
  });

  it("omits cache_prompt when promptCache is unset", async () => {
    const { provider, captured } = mockProvider({});
    await provider.complete([{ role: "user", content: "hi" }], []);
    expect(captured[0]!["cache_prompt"]).toBeUndefined();
  });

  it("never nests provider extensions under extra_body — the server would drop them", async () => {
    const { provider, captured } = mockProvider({ promptCache: true, primary: "lmstudio/qwen/qwen3.8-27b", reasoningEffort: "none" });
    await provider.complete([{ role: "user", content: "hi" }], []);
    expect(captured[0]!["extra_body"]).toBeUndefined();
    // "none" reaches the wire as itself. It used to be folded to "low" on the strength of a
    // warning about LM Studio's per-model CONFIG field; the API is its own surface and names its
    // own set ("Supported values: none, minimal, low, medium, high, xhigh"), and "low" still
    // thinks — measured 1,752 reasoning chars in 6.5 s against 0 chars in 0.39 s for "none".
    expect(captured[0]!["reasoning_effort"]).toBe("none");
    expect(captured[0]!["chat_template_kwargs"]).toBeUndefined();
    expect(captured[0]!["cache_prompt"]).toBe(true);
  });

  it("steps down to a level an older backend accepts once that backend refuses this one", async () => {
    const { provider, captured } = mockProvider({ promptCache: true, primary: "lmstudio/qwen/qwen3.8-27b", reasoningEffort: "none" });
    // What an older LM Studio answers: it takes only xhigh|medium|low.
    noteRejectedReasoningEffort("http://localhost:1234/v1", "none");
    await provider.complete([{ role: "user", content: "hi" }], []);
    expect(captured[0]!["reasoning_effort"]).toBe("low");
  });
});
