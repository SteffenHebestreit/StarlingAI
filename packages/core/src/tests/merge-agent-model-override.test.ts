import { describe, expect, it } from "vitest";
import { mergeAgentModelOverride } from "../agent/sub-agent.js";
import type { ModelConfig } from "../config/schema.js";

describe("mergeAgentModelOverride", () => {
  const defaults = { primary: "lmstudio/qwen/qwen3.6-35b-a3b", temperature: 0.7 } as ModelConfig;

  it("keeps the default primary when a partial override omits it (audit c33e65dd)", () => {
    // An ephemeral agent passed model:{temperature:0.3}; the constructed override
    // carried primary:undefined which previously blanked out the default and
    // crashed model-id handling with "Cannot read properties of undefined
    // (reading 'toLowerCase')".
    const merged = mergeAgentModelOverride(defaults, {
      primary: undefined,
      temperature: 0.3,
      maxTokens: undefined,
    } as Partial<ModelConfig>);
    expect(merged.primary).toBe("lmstudio/qwen/qwen3.6-35b-a3b");
    expect(merged.temperature).toBe(0.3);
  });

  it("applies a defined primary override", () => {
    const merged = mergeAgentModelOverride(defaults, { primary: "lmstudio/qwen/qwen3.5-9b" } as Partial<ModelConfig>);
    expect(merged.primary).toBe("lmstudio/qwen/qwen3.5-9b");
  });

  it("returns the defaults unchanged when the override is undefined", () => {
    const merged = mergeAgentModelOverride(defaults, undefined);
    expect(merged.primary).toBe("lmstudio/qwen/qwen3.6-35b-a3b");
    expect(merged.temperature).toBe(0.7);
  });
});
