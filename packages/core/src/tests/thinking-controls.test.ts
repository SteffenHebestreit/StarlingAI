import { describe, it, expect } from "vitest";
import { detectThinkingFamily, resolveThinkingControls, recommendedQwenSampling } from "../providers/lmstudio.js";

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

describe("thinking control — Qwen 3.8+ graded reasoning_effort", () => {
  // Qwen 3.8 dropped the working enable_thinking toggle in favour of graded
  // reasoning_effort. Measured on LM Studio against qwen3.8-27b (2026-08-15):
  // none → 0 reasoning chars, low → 1344, medium → 1634, xhigh → 9034; while
  // chat_template_kwargs.enable_thinking:false left thinking fully ON. Routing
  // 3.8 through the old family would leave it with no working control at all.
  it("routes 3.8+ to the effort family and leaves 3.5/3.6 on enable_thinking", () => {
    expect(detectThinkingFamily("lmstudio/qwen/qwen3.8-27b")).toBe("qwen-effort");
    expect(detectThinkingFamily("Qwen3.8-2.4T-A95B")).toBe("qwen-effort");
    expect(detectThinkingFamily("qwen3.9-plus")).toBe("qwen-effort");
    expect(detectThinkingFamily("qwen3.10-next")).toBe("qwen-effort");
    // Older generations keep the mechanism that does work for them.
    expect(detectThinkingFamily("lmstudio/qwen/qwen3.6-35b-a3b")).toBe("enable_thinking");
    expect(detectThinkingFamily("Qwen3.5-9B")).toBe("enable_thinking");
  });

  it("sends reasoning_effort alone for a thinking level", () => {
    const controls = resolveThinkingControls("qwen/qwen3.8-27b", { reasoningEffort: "medium" });
    expect(controls).toEqual({ reasoningEffort: "medium" });
    expect(controls.chatTemplateKwargs).toBeUndefined();
  });

  // Qwen's card documents only xhigh|medium|low and says to disable thinking with
  // enable_thinking:false (what vLLM honors). Measured on LM Studio, that flag did
  // nothing and the undocumented reasoning_effort "none" was what worked. Send both.
  // LM Studio accepts ONLY xhigh|medium|low and SKIPS anything else — a rejected
  // value leaves NO setting, so the model falls back to its default of xhigh (the
  // 183s rung). "none" must therefore never reach the wire: it goes as "low", the
  // lowest valid rung, with enable_thinking:false alongside for backends that honour
  // it. Otherwise the agents asking for no thinking got the slowest setting there is.
  it("never puts a value on the wire that LM Studio rejects", () => {
    for (const cfg of [{ enableThinking: false }, { reasoningEffort: "none" as const }]) {
      const c = resolveThinkingControls("qwen/qwen3.8-27b", cfg);
      expect(c).toEqual({ reasoningEffort: "low", chatTemplateKwargs: { enable_thinking: false } });
    }
  });

  it("only ever emits xhigh, medium or low for this family", () => {
    const valid = new Set(["xhigh", "medium", "low"]);
    for (const cfg of [
      { reasoningEffort: "none" as const }, { reasoningEffort: "low" as const },
      { reasoningEffort: "medium" as const }, { reasoningEffort: "high" as const },
      { reasoningEffort: "xhigh" as const }, { enableThinking: false }, { enableThinking: true },
    ]) {
      const eff = resolveThinkingControls("qwen/qwen3.8-27b", cfg).reasoningEffort;
      expect(eff === undefined || valid.has(eff), JSON.stringify(cfg)).toBe(true);
    }
    expect(resolveThinkingControls("qwen/qwen3.8-27b", { enableThinking: true }).reasoningEffort).toBe("medium");
  });

  it("folds 'high' to 'xhigh' — Qwen 3.8 has no 'high' level", () => {
    expect(resolveThinkingControls("qwen/qwen3.8-27b", { reasoningEffort: "high" }))
      .toEqual({ reasoningEffort: "xhigh" });
  });

  it("explicit effort beats the boolean toggle", () => {
    expect(resolveThinkingControls("qwen/qwen3.8-27b", { enableThinking: false, reasoningEffort: "xhigh" }))
      .toEqual({ reasoningEffort: "xhigh" });
  });

  it("leaves the model default alone when neither is configured", () => {
    expect(resolveThinkingControls("qwen/qwen3.8-27b", {})).toEqual({});
  });

  it("folds Qwen-only levels onto what gpt-oss accepts", () => {
    expect(resolveThinkingControls("openai/gpt-oss-20b", { reasoningEffort: "xhigh" }))
      .toEqual({ reasoningEffort: "high", systemReasoningLine: "Reasoning: high" });
    expect(resolveThinkingControls("openai/gpt-oss-20b", { reasoningEffort: "none" }))
      .toEqual({ reasoningEffort: "low", systemReasoningLine: "Reasoning: low" });
  });
});

describe("recommendedQwenSampling", () => {
  it("uses Qwen 3.8 thinking sampling (temp 1.0) and non-thinking for 'none'", () => {
    expect(recommendedQwenSampling("qwen/qwen3.8-27b", { reasoningEffort: "medium" }))
      .toEqual({ temperature: 1.0, topP: 0.95 });
    expect(recommendedQwenSampling("qwen/qwen3.8-27b", { reasoningEffort: "none" }))
      .toEqual({ temperature: 0.7, topP: 0.8 });
    expect(recommendedQwenSampling("qwen/qwen3.8-27b", { enableThinking: false }))
      .toEqual({ temperature: 0.7, topP: 0.8 });
  });

  it("keeps the older Qwen recommendation for 3.5/3.6 (temp 0.6 thinking)", () => {
    expect(recommendedQwenSampling("qwen/qwen3.6-35b-a3b", { enableThinking: true }))
      .toEqual({ temperature: 0.6, topP: 0.95 });
  });

  it("returns null for non-Qwen models and for unconfigured older Qwen", () => {
    expect(recommendedQwenSampling("openai/gpt-oss-20b", { enableThinking: true })).toBeNull();
    expect(recommendedQwenSampling("qwen/qwen3.6-35b-a3b", {})).toBeNull();
  });
});
