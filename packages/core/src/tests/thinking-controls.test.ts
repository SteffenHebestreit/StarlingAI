import { describe, it, expect } from "vitest";
import { detectThinkingFamily, resolveThinkingControls } from "../providers/lmstudio.js";

describe("thinking control — model-family detection", () => {
  it("classifies each family by model id", () => {
    expect(detectThinkingFamily("lmstudio/qwen/qwen3.6-35b-a3b")).toBe("enable_thinking");
    expect(detectThinkingFamily("Qwen3.5-9B")).toBe("enable_thinking");
    expect(detectThinkingFamily("glm-4.6")).toBe("enable_thinking");
    expect(detectThinkingFamily("deepseek-v3.1")).toBe("deepseek");
    expect(detectThinkingFamily("openai/gpt-oss-20b")).toBe("gpt-oss");
    expect(detectThinkingFamily("gpt_oss_120b")).toBe("gpt-oss");
    expect(detectThinkingFamily("mistral-small-3")).toBe("none");
  });

  it("covers every Gemma 4 size as enable_thinking (same key as Qwen)", () => {
    for (const id of [
      "google/gemma-4-E2B-it",
      "google/gemma-4-E4B-it",
      "gemma-4-12b-it",
      "gemma-4-26b-a4b",      // MoE
      "gemma-4-31B",          // dense
      "lmstudio-community/gemma-4-27b-it-Q4_K_M",
    ]) {
      expect(detectThinkingFamily(id), id).toBe("enable_thinking");
      expect(resolveThinkingControls(id, { enableThinking: false }), id)
        .toEqual({ chatTemplateKwargs: { enable_thinking: false } });
    }
  });
});

describe("thinking control — resolveThinkingControls (family-aware)", () => {
  it("Qwen/GLM use chat_template_kwargs.enable_thinking", () => {
    expect(resolveThinkingControls("qwen3.6-35b", { enableThinking: true }))
      .toEqual({ chatTemplateKwargs: { enable_thinking: true } });
    expect(resolveThinkingControls("glm-4.6", { enableThinking: false }))
      .toEqual({ chatTemplateKwargs: { enable_thinking: false } });
  });

  it("DeepSeek uses the DIFFERENT key chat_template_kwargs.thinking", () => {
    expect(resolveThinkingControls("deepseek-v3.1", { enableThinking: true }))
      .toEqual({ chatTemplateKwargs: { thinking: true } });
    expect(resolveThinkingControls("deepseek-v3.1", { enableThinking: false }))
      .toEqual({ chatTemplateKwargs: { thinking: false } });
  });

  it("gpt-oss uses reasoning_effort + a system 'Reasoning:' line (the form LM Studio honors)", () => {
    expect(resolveThinkingControls("gpt-oss-20b", { reasoningEffort: "high" }))
      .toEqual({ reasoningEffort: "high", systemReasoningLine: "Reasoning: high" });
    // boolean toggle maps to effort when reasoningEffort is unset
    expect(resolveThinkingControls("gpt-oss-20b", { enableThinking: false }))
      .toEqual({ reasoningEffort: "low", systemReasoningLine: "Reasoning: low" });
    expect(resolveThinkingControls("gpt-oss-20b", { enableThinking: true }))
      .toEqual({ reasoningEffort: "high", systemReasoningLine: "Reasoning: high" });
    // explicit reasoningEffort wins over the boolean
    expect(resolveThinkingControls("gpt-oss-20b", { enableThinking: true, reasoningEffort: "medium" }))
      .toEqual({ reasoningEffort: "medium", systemReasoningLine: "Reasoning: medium" });
  });

  it("emits NOTHING when there is no signal (leaves the model/GUI default)", () => {
    expect(resolveThinkingControls("qwen3.6-35b", {})).toEqual({});
    expect(resolveThinkingControls("deepseek-v3.1", {})).toEqual({});
    expect(resolveThinkingControls("gpt-oss-20b", {})).toEqual({});
    // unknown family never toggles
    expect(resolveThinkingControls("mistral-small-3", { enableThinking: true })).toEqual({});
  });
});
