/**
 * The lab's own model calls: editors, composer, selector. Local models only, by default the
 * swarm's primary model (the one the executor runs on, so the model server does not swap models
 * between a turn and the lab's call after it). A role may name another "<provider>/<model>"
 * (selfImprovement.harnessLab.roles); that model gets an endpoint of its own, never the primary's.
 */
import { getConfig } from "../config/loader.js";
import type { ModelConfig } from "../config/schema.js";
import { createChatProvider, resolveProviderEndpoint } from "../providers/index.js";

export type LabRole = "editor" | "composer" | "selector";

/** One call of a lab role: a system prompt and one user message in, the answer's text out. */
export type LabComplete = (role: LabRole, system: string, user: string) => Promise<string>;

/** The model config a role runs on. */
export function labModelConfig(role: LabRole): ModelConfig {
  const config = getConfig();
  const defaults = config.agents.defaults.model;
  const named = config.selfImprovement.harnessLab.roles[role];
  if (!named || named === defaults.primary) return defaults;
  // Another model: nothing of the primary's endpoint or chain may come along with it.
  return {
    ...defaults,
    primary: named,
    baseUrl: undefined,
    apiKey: undefined,
    fallback: undefined,
    cloudFallback: undefined,
    tiers: undefined,
    toolCallPrefill: undefined,
  };
}

const LAB_CALL_MAX_TOKENS = 4_000;

export function createLabComplete(): LabComplete {
  return async (role, system, user) => {
    const config = getConfig();
    const modelConfig = labModelConfig(role);
    const provider = createChatProvider(modelConfig, resolveProviderEndpoint(modelConfig, config));
    const response = await provider.complete(
      [{ role: "system", content: system }, { role: "user", content: user }],
      [],
      undefined,
      { controls: { enableThinking: config.selfImprovement.harnessLab.enableThinking }, maxTokens: LAB_CALL_MAX_TOKENS },
    );
    return response.content ?? "";
  };
}
