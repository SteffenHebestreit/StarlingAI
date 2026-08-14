/**
 * Sub-Agent Model Config
 *
 * Pure helpers that resolve the ModelConfig a sub-agent runs with: merging a
 * per-agent override onto the defaults, and overlaying the active effort
 * profile while respecting an agent's explicit opt-outs. They depend only on
 * the config schema types — never on the sub-agent runner loop — so the
 * precedence rules stay unit-testable without a running sub-agent.
 */

import type { ModelConfig } from "../config/schema.js";
import type { ReasoningEffort } from "../providers/lmstudio.js";

/**
 * Merge a per-agent model override onto the defaults, dropping override keys
 * whose value is `undefined`. A partial override (e.g. an ephemeral agent that
 * passes `model: { temperature: 0.3 }` with no `primary`) must NOT spread
 * `primary: undefined` over the default and blank it out — that left
 * modelConfig.primary undefined and crashed downstream model-id handling (audit
 * c33e65dd: create_ephemeral_agent "Cannot read properties of undefined
 * (reading 'toLowerCase')").
 */
export function mergeAgentModelOverride(
  defaults: ModelConfig,
  override: Partial<ModelConfig> | undefined,
): ModelConfig {
  const defined = Object.fromEntries(
    Object.entries(override ?? {}).filter(([, value]) => value !== undefined),
  ) as Partial<ModelConfig>;
  return { ...defaults, ...defined };
}

/**
 * Overlay the active effort profile onto a resolved model config. The effort dial RAISES
 * budget/reasoning for a thorough turn, but it must respect an agent's EXPLICIT opt-outs:
 *  - maxTokens only ever RAISES (never shrinks an agent's intentional larger budget).
 *  - enableThinking / reasoningEffort are NOT forced ON for an agent that explicitly set
 *    enableThinking:false. A builder whose job is to emit a large artifact via tool calls
 *    disables thinking so its WHOLE completion budget goes to write_file calls, not a
 *    reasoning monologue. At max effort the unconditional thinking:true overrode
 *    content_writer's own enableThinking:false, so it burned its entire 32K-token budget
 *    reasoning ("Let me plan… I'll chunk…") and never called write_file — 651s, zero
 *    artifacts (audit 463d6192). Precedence: explicit agent opt-out > effort dial > default.
 * Pure so the precedence is unit-testable without a running sub-agent.
 */
export function applyEffortModelOverlay(
  baseModelConfig: ModelConfig,
  effortProfile:
    | { subAgentMaxTokens?: number; enableThinking?: boolean; reasoningEffort?: ReasoningEffort }
    | null
    | undefined,
): ModelConfig {
  if (!effortProfile) return baseModelConfig;
  const agentDisabledThinking = baseModelConfig.enableThinking === false;
  return {
    ...baseModelConfig,
    ...(effortProfile.subAgentMaxTokens !== undefined
      ? { maxTokens: Math.max(baseModelConfig.maxTokens ?? 0, effortProfile.subAgentMaxTokens) }
      : {}),
    ...(effortProfile.enableThinking !== undefined && !agentDisabledThinking
      ? { enableThinking: effortProfile.enableThinking }
      : {}),
    ...(effortProfile.reasoningEffort !== undefined && !agentDisabledThinking
      ? { reasoningEffort: effortProfile.reasoningEffort }
      : {}),
  };
}
