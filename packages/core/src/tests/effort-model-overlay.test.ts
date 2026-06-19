import { describe, expect, it } from "vitest";
import { applyEffortModelOverlay } from "../agent/sub-agent.js";
import type { ModelConfig } from "../config/schema.js";

/**
 * The effort dial RAISES budget/reasoning for a thorough turn, but it must respect an
 * agent's explicit opt-out: a builder (content_writer) sets enableThinking:false so its
 * whole completion budget goes to write_file calls. At max effort the unconditional
 * thinking:true overrode that and the builder burned its entire 32K-token budget reasoning
 * and never called write_file (audit 463d6192). Precedence: explicit opt-out > dial > default.
 */
const MAX = { subAgentMaxTokens: 32_768, enableThinking: true, reasoningEffort: "high" as const };

/** Complete ModelConfig with the field(s) under test overridden. */
const mk = (over: Partial<ModelConfig>): ModelConfig => ({
  primary: "lmstudio/qwen/qwen3.6-35b-a3b",
  contextWindow: 32_768,
  temperature: 0.3,
  maxTokens: 16_384,
  enableThinking: false,
  ...over,
});

describe("applyEffortModelOverlay", () => {
  it("does NOT force thinking on for a builder that explicitly disabled it (audit 463d6192)", () => {
    const r = applyEffortModelOverlay(mk({ enableThinking: false }), MAX);
    expect(r.enableThinking).toBe(false);       // agent opt-out wins
    expect(r.reasoningEffort).toBeUndefined();   // reasoning is not cranked either
    expect(r.maxTokens).toBe(32_768);            // budget IS still raised
  });

  it("raises thinking + reasoning for an agent that did NOT opt out", () => {
    const r = applyEffortModelOverlay(mk({ enableThinking: true, maxTokens: 8_192 }), MAX);
    expect(r.enableThinking).toBe(true);
    expect(r.reasoningEffort).toBe("high");
    expect(r.maxTokens).toBe(32_768);
  });

  it("low effort still turns thinking OFF for a thinking-on agent (dial lowers non-opted-out agents)", () => {
    const r = applyEffortModelOverlay(mk({ enableThinking: true }), { enableThinking: false, reasoningEffort: "low" });
    expect(r.enableThinking).toBe(false);
    expect(r.reasoningEffort).toBe("low");
  });

  it("only RAISES maxTokens, never shrinks an agent's intentionally larger budget", () => {
    const r = applyEffortModelOverlay(mk({ maxTokens: 65_536 }), { subAgentMaxTokens: 32_768 });
    expect(r.maxTokens).toBe(65_536);
  });

  it("is a no-op without an active effort profile", () => {
    const cfg = mk({ enableThinking: false });
    expect(applyEffortModelOverlay(cfg, undefined)).toEqual(cfg);
    expect(applyEffortModelOverlay(cfg, null)).toEqual(cfg);
  });
});
