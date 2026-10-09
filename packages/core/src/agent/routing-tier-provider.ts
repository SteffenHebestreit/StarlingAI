/**
 * A provider for routing-tier work, falling back to the turn's own model config.
 *
 * `getChatProviderForTier` returns null while a model preset is active, deliberately (see
 * providers/index.ts for why a preset branch THERE is untenable). The consequence is that on
 * a preset deployment the receptionist, the judge and every other tier call silently do not
 * run at all — which is exactly what the live audit showed: 0 of 5 fast-lane attempts, and
 * not one of them logged a reason. The sanctioned fix is this call-site pattern: fall back to
 * the caller's OWN merged model config carrying the tier's controls, so the call still
 * happens and the deployment is measurable.
 *
 * It lives in its own module because both the turn (agent/runtime.ts) and the delegation
 * tool path (tools/sub-agent.ts) need it, and importing the turn from a tool would close a
 * cycle.
 */
import { applyActiveModelPreset, createChatProvider, getActiveModelPreset, getChatProviderForTier, tierModelDefaults } from "../providers/index.js";
import type { ChatProvider } from "../providers/index.js";
import { getConfig } from "../config/loader.js";

export function resolveRoutingTierProvider(): ChatProvider {
  return getChatProviderForTier("routing")
    ?? createChatProvider({
      ...applyActiveModelPreset(getConfig().agents.defaults.model),
      ...tierModelDefaults("routing"),
    });
}

/**
 * The model id routing-tier work goes to, by the rule above: the tier's own model, or — under a
 * model preset (where getChatProviderForTier returns null), or with no tier configured — the turn's
 * own. Its provider prefix ("anthropic/…") tells a caller that needs what only a llama.cpp server
 * gives (a GBNF grammar, token logprobs) that the call would be paid for and could not answer.
 */
export function routingTierModelId(): string {
  const config = getConfig();
  const tierModel = getActiveModelPreset(config) ? undefined : config.agents.defaults.model.tiers?.["routing"];
  return tierModel ?? applyActiveModelPreset(config.agents.defaults.model).primary;
}
