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

const base: ModelConfig = {
  primary: "lmstudio/qwen/qwen3.6-35b-a3b",
  contextWindow: 8192,
  maxTokens: 64,
  temperature: 0,
  enableThinking: false,
} as ModelConfig;

function mockProvider(cfg: Partial<ModelConfig>, usage: Record<string, unknown>) {
  const provider = new LMStudioProvider("http://localhost:1234/v1", "test", { ...base, ...cfg }, { maxRetries: 0 });
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: "YES", tool_calls: [] }, finish_reason: "stop" }],
          usage,
        }),
      },
    },
  };
  return provider;
}

const modelCalls = () => rows.filter((r) => r.type === "provider_model_call").map((r) => r.data);

beforeEach(() => { rows.length = 0; });

/**
 * THE MEASUREMENT THAT SETTLES IT. Two of this deployment's costs were re-derived from the client
 * side every time anyone asked — whether a call re-prefilled its prefix, and whether a verdict
 * call thought — and the thinking-off switch shipped in 2066738 turned out to be inert on the
 * deployed model with nobody the wiser, because no row anywhere recorded what went on the wire
 * against what came back. One row per model call, with both.
 */
describe("provider_model_call — one audit row per model call", () => {
  it("records what was asked (the wire controls) and what happened (tokens, reasoning share, time)", async () => {
    const provider = mockProvider({ enableThinking: false, reasoningEffort: "none" }, {
      prompt_tokens: 14_939,
      completion_tokens: 2,
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    await provider.complete([{ role: "user", content: "verdict?" }], []);

    const calls = modelCalls();
    expect(calls).toHaveLength(1);
    const row = calls[0]!;
    expect(row["mode"]).toBe("complete");
    expect(row["model"]).toBe("qwen/qwen3.6-35b-a3b");
    expect(row["promptTokens"]).toBe(14_939);
    expect(row["completionTokens"]).toBe(2);
    expect(row["reasoningTokens"]).toBe(0);
    expect(row["finishReason"]).toBe("stop");
    expect(typeof row["durationMs"]).toBe("number");
    expect(row["controls"]).toEqual({ reasoningEffort: "none", enableThinking: false, cachePrompt: false });
  });

  it("is the row that exposes an inert switch: controls say off, reasoning tokens say otherwise", async () => {
    // What the deployed model did for a month under enable_thinking:false alone — visible in one
    // query over the audit log instead of a probe: WHERE controls.enableThinking = false AND
    // reasoningTokens > 0.
    const provider = mockProvider({ enableThinking: true }, {
      prompt_tokens: 484,
      completion_tokens: 1_122,
      completion_tokens_details: { reasoning_tokens: 1_100 },
    });
    await provider.complete([{ role: "user", content: "PASS or FAIL?" }], []);

    const row = modelCalls()[0]!;
    expect(row["reasoningTokens"]).toBe(1_100);
    expect((row["controls"] as Record<string, unknown>)["enableThinking"]).toBe(true);
    expect((row["controls"] as Record<string, unknown>)["reasoningEffort"]).toBeNull();
  });

  it("does not invent a reasoning count the backend did not report", async () => {
    const provider = mockProvider({}, { prompt_tokens: 10, completion_tokens: 5 });
    await provider.complete([{ role: "user", content: "hi" }], []);
    expect(modelCalls()[0]!["reasoningTokens"]).toBeNull();
  });
});
