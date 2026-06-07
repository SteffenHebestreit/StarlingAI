import { describe, expect, it } from "vitest";
import { LMStudioProvider } from "../providers/lmstudio.js";
import type { ModelConfig } from "../config/schema.js";

/**
 * P1 prefill caching: when modelConfig.promptCache is set, the provider must send
 * `extra_body.cache_prompt: true` so llama.cpp / LM Studio reuses the KV cache for
 * the stable prompt prefix. Opt-in — absent when the flag is unset.
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

describe("LMStudioProvider promptCache → extra_body.cache_prompt", () => {
  it("sends cache_prompt:true when promptCache is enabled", async () => {
    const { provider, captured } = mockProvider({ promptCache: true });
    await provider.complete([{ role: "user", content: "hi" }], []);
    const extra = captured[0]!["extra_body"] as Record<string, unknown> | undefined;
    expect(extra?.["cache_prompt"]).toBe(true);
  });

  it("omits cache_prompt when promptCache is unset", async () => {
    const { provider, captured } = mockProvider({});
    await provider.complete([{ role: "user", content: "hi" }], []);
    const extra = captured[0]!["extra_body"] as Record<string, unknown> | undefined;
    expect(extra?.["cache_prompt"]).toBeUndefined();
  });
});
