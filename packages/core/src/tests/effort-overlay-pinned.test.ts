import { describe, expect, it } from "vitest";
// Imported from the DEFINING module, not the sub-agent barrel: its only imports are
// type-only, so this suite runs without pulling the provider chain in.
import { applyEffortModelOverlay } from "../agent/sub-agent-model-config.js";
import type { ModelConfig } from "../config/schema.js";

/**
 * The effort dial must respect an agent's explicit opt-out. enableThinking:false was
 * already covered (audit 463d6192: a builder forced to think burned its whole 32K
 * budget reasoning and never called write_file). A PINNED reasoningEffort is the same
 * kind of deliberate choice and was not covered: coder sets reasoningEffort:"low"
 * WITH enableThinking:true, so the old guard did not apply and a max-effort session
 * overwrote it — folding "high" to "xhigh" on Qwen 3.8, the rung measured at 9,034
 * reasoning chars / 183s that hits the completion cap.
 */
const MAX = { subAgentMaxTokens: 32_768, enableThinking: true, reasoningEffort: "high" as const };

const mk = (over: Partial<ModelConfig>): ModelConfig => ({
  primary: "lmstudio/qwen/qwen3.8-27b",
  contextWindow: 131_072,
  temperature: 0.3,
  maxTokens: 8_192,
  enableThinking: true,
  ...over,
});

describe("applyEffortModelOverlay — a pinned agent effort is an opt-out", () => {
  it("keeps an agent's explicit reasoningEffort at max effort", () => {
    const r = applyEffortModelOverlay(mk({ reasoningEffort: "low" }), MAX);
    expect(r.reasoningEffort).toBe("low");   // pinned value survives the dial
    expect(r.maxTokens).toBe(32_768);        // budget is still raised
  });

  it("still lets the dial set effort for an agent that did NOT pin one", () => {
    const r = applyEffortModelOverlay(mk({}), MAX);
    expect(r.reasoningEffort).toBe("high");
  });

  it("keeps honouring the enableThinking opt-out", () => {
    const r = applyEffortModelOverlay(mk({ enableThinking: false }), MAX);
    expect(r.enableThinking).toBe(false);
    expect(r.reasoningEffort).toBeUndefined();
  });

  it("raises the budget regardless of either opt-out", () => {
    expect(applyEffortModelOverlay(mk({ reasoningEffort: "low" }), MAX).maxTokens).toBe(32_768);
    expect(applyEffortModelOverlay(mk({ enableThinking: false }), MAX).maxTokens).toBe(32_768);
  });
});
