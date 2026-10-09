import { describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../config/schema.js";

/**
 * THE TIER LADDER RETURNS NULL UNDER AN ACTIVE PRESET — AND THE CALL SITES, NOT THIS FUNCTION,
 * SUPPLY THE FALLBACK.
 *
 * A branch that returned a preset-model provider from here was tried and withdrawn. Building a
 * provider in this function means building it out of `config.agents.defaults.model`, and that
 * breaks three things at once:
 *   - SCOPE. getChatProviderWithOverride applies the preset with no scope context, and
 *     presetAppliesUnderScope answers true for an absent ctx — so under modelPresetScope
 *     "coordinator_qa" a worker deliberately left on local qwen would have every distillation,
 *     judge and synthesis call routed to the preset model.
 *   - CONFIG DIVERGENCE. The caller's own contextWindow, the effort overlay's maxTokens raise,
 *     the per-run stream cap and the failover chain live on the caller's merged model config,
 *     not on the defaults, so the tier provider would be a different model config from the one
 *     the caller runs on.
 *   - CIRCUIT STATE. A fresh FailoverChatProvider per call discards the breaker state the cached
 *     provider holds, so a dead endpoint is re-tried in full on every tier call.
 *
 * What the tier ladder is actually for is the CONTROLS, and those the call sites already apply
 * to their own merged config — sub-agent.ts's synthProvider, distillation and progress-judge
 * sites each read `getChatProviderForTier(t) ?? createChatProvider({ ...modelConfig,
 * ...tierModelDefaults(t) }, providerEndpoint)`. So the contract this file pins
 * is: null when there is no tier model or a preset is active — and tierModelDefaults carrying
 * the routing tier's thinking off-switch, with nothing imposed on synthesis.
 */

function configWith(overrides: Record<string, unknown>) {
  return ConfigSchema.parse({
    providers: { anthropic: { apiKey: "sk-ant-api03-test" } },
    agents: {
      defaults: {
        model: {
          primary: "lmstudio/qwen",
          enableThinking: true,
          tiers: { routing: "lmstudio/qwen-small", synthesis: "lmstudio/qwen-small" },
        },
        ...overrides,
      },
    },
  });
}

const presetConfig = configWith({ activeModelPreset: "claude" });
const plainConfig = configWith({});
let active = presetConfig;

vi.mock("../config/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/loader.js")>();
  return { ...original, getConfig: vi.fn(() => active) };
});
// No credential store on this machine's test run: the anthropic binding is built with a
// plain API key, and nothing here should touch the OAuth token store.
vi.mock("../providers/anthropic-oauth.js", () => ({
  loadStoredTokenSet: () => null,
  getValidAccessToken: async () => null,
  startAnthropicTokenRefresher: () => {},
  anthropicRefreshDisabledReason: () => null,
}));

const { getChatProviderForTier, tierModelDefaults } = await import("../providers/index.js");
const { FailoverChatProvider } = await import("../providers/failover.js");

/** The ModelConfig the PRIMARY binding was constructed with (TS `private` is not enforced at runtime). */
function primaryModelConfig(provider: unknown): Record<string, unknown> {
  const failover = provider as { bindings?: Array<{ provider: { modelConfig?: Record<string, unknown> } }>; modelConfig?: Record<string, unknown> };
  if (provider instanceof FailoverChatProvider) return failover.bindings![0]!.provider.modelConfig!;
  return failover.modelConfig!;
}

describe("getChatProviderForTier under an active model preset", () => {
  it("returns null for BOTH tiers, even though tier models are configured", () => {
    active = presetConfig;
    // The tiers ARE set in this config — null is the preset rule firing, not a missing tier.
    expect(presetConfig.agents.defaults.model.tiers?.routing).toBe("lmstudio/qwen-small");
    expect(getChatProviderForTier("routing")).toBeNull();
    expect(getChatProviderForTier("synthesis")).toBeNull();
    // A caller override does not buy its way past the preset either.
    expect(getChatProviderForTier("routing", { reasoningEffort: "low" })).toBeNull();
  });

  it("without a preset the SAME config yields the tier model — so the null above is the preset, not the fixture", () => {
    active = plainConfig;
    const cfg = primaryModelConfig(getChatProviderForTier("routing"));
    expect(cfg["primary"]).toBe("lmstudio/qwen-small");
    expect(cfg["enableThinking"]).toBe(false);
    expect(cfg["reasoningEffort"]).toBe("none");
    active = presetConfig;
  });
});

describe("tierModelDefaults — the controls the call sites lay over their OWN merged config", () => {
  it("routing carries the thinking off-switch, expressed both ways so it survives a model swap", () => {
    // qwen3.6 honours enableThinking and ignores reasoningEffort; the qwen-effort family is the
    // other way round. A yes/no verdict must not reason on either.
    expect(tierModelDefaults("routing")).toEqual({ enableThinking: false, reasoningEffort: "none" });
  });

  it("synthesis imposes nothing — the QA rewrite keeps whatever deliberation its own config has", () => {
    expect(tierModelDefaults("synthesis")).toEqual({});
  });
});
