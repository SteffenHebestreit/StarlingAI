import { describe, expect, it } from "vitest";
// Imported from the DEFINING module so the suite does not pull the provider chain in.
import { ModelConfigSchema, ModelPresetSchema } from "../config/schema.js";

/**
 * Guards the OUTPUT-ceiling removal.
 *
 * `maxTokens` used to be `.max(16384).default(4096)` and `contextWindow` `.max(131072)`.
 * Config validation is a hard FAIL, not a clamp, so those caps were the single thing
 * making 16384 the most any agent could ever be given — and nothing tested them, so
 * they could be reinstated silently. On the OpenAI-compatible wire max_tokens is a
 * SHARED reasoning+content budget, so a fixed ceiling truncates mid-`<think>` and the
 * model never reaches the point of emitting a tool call (measured: completionTokens
 * == maxTokens EXACTLY, zero tool calls, 46k-59k reasoning chars).
 *
 * The budget is now DERIVED per request from what the context window has left
 * (providers/lmstudio.ts computeOutputTokenBudget); a declared maxTokens is honoured
 * only as a deliberate ceiling on top of it. Both properties below must hold:
 * unset must stay unset, and a large declared value must parse.
 */
describe("ModelConfigSchema — the output ceiling is gone", () => {
  it("leaves maxTokens UNSET when the config omits it", () => {
    // A `.default(N)` here would silently re-impose a ceiling on every agent that
    // declares none, which is exactly what the shard cleanup removed.
    const parsed = ModelConfigSchema.parse({});
    expect(parsed.maxTokens).toBeUndefined();
  });

  it("accepts a declared maxTokens far above the old 16384 cap", () => {
    expect(ModelConfigSchema.safeParse({ maxTokens: 100_000 }).success).toBe(true);
  });

  it("accepts a contextWindow above the old 131072 cap", () => {
    // The box serves 262144; the old cap made half the real window unreachable.
    expect(ModelConfigSchema.safeParse({ contextWindow: 262_144 }).success).toBe(true);
  });

  it("still rejects a nonsense value — the bound is a typo guard, not a policy", () => {
    expect(ModelConfigSchema.safeParse({ maxTokens: 0 }).success).toBe(false);
    expect(ModelConfigSchema.safeParse({ contextWindow: 1024 }).success).toBe(false);
  });
});

describe("ModelPresetSchema — the SECOND, independent cap", () => {
  // providers/index.ts overwrites the resolved ModelConfig unconditionally and
  // modelPresetScope defaults to "all", so a stale cap here would re-impose the old
  // ceiling on every agent the moment the Local/Claude switch is flipped.
  it("matches the ModelConfig bounds", () => {
    const preset = { primary: "anthropic/claude-sonnet-4-6", maxTokens: 100_000, contextWindow: 262_144 };
    expect(ModelPresetSchema.safeParse(preset).success).toBe(true);
  });
});
