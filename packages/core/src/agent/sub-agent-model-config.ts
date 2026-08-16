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
/*
 * NOTE — there is deliberately NO clamp on the effort the dial hands a sub-agent.
 *
 * One briefly lived here, folding high/xhigh down to medium on the theory that the
 * top rung was what made backend_coder emit 97,714 characters of reasoning, call
 * ZERO tools and die at 36 minutes. Measurement refuted it. Across four cap-hits on
 * qwen3.8-27b the reasoning volume was independent of the rung — content_writer sat
 * on the LOWEST rung LM Studio accepts and burned the MOST (59,508 chars) — and in
 * every case completionTokens equalled maxTokens EXACTLY. The model was not
 * over-thinking because of the rung; it was being TRUNCATED mid-thought by a shared
 * reasoning+content budget, so it never reached the point of emitting a tool call.
 *
 * The fix is the derived output budget (providers/lmstudio.ts computeOutputTokenBudget),
 * not a quieter rung. Clamping here only made max effort silently not-max for every
 * sub-agent, for no measured gain.
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
  // An agent that PINNED its own reasoning effort has expressed the same kind of
  // deliberate opt-out as enableThinking:false, and the documented precedence
  // above ("explicit agent opt-out > effort dial > default") covers both. Without
  // this, a high/max-effort session overwrites e.g. coder's explicit "low" — and
  // normalizeQwenEffort folds the dial's "high" to "xhigh", the rung measured at
  // 9,034 reasoning chars / 183s that hits the completion cap. An artifact-emitting
  // agent truncating at the cap is exactly the failure of audit 463d6192 that the
  // enableThinking half of this guard was written to prevent.
  const agentPinnedEffort = baseModelConfig.reasoningEffort !== undefined;
  return {
    ...baseModelConfig,
    // The dial may only RAISE an existing pin. It must NOT invent one: an agent
    // with no maxTokens is on the derived budget, and Math.max(0, 16_384) would
    // silently pin it back to a fixed 16_384 — the very ceiling the directive
    // removes, re-applied by the effort tier.
    ...(effortProfile.subAgentMaxTokens !== undefined && baseModelConfig.maxTokens !== undefined
      ? { maxTokens: Math.max(baseModelConfig.maxTokens, effortProfile.subAgentMaxTokens) }
      : {}),
    ...(effortProfile.enableThinking !== undefined && !agentDisabledThinking
      ? { enableThinking: effortProfile.enableThinking }
      : {}),
    ...(effortProfile.reasoningEffort !== undefined && !agentDisabledThinking && !agentPinnedEffort
      ? { reasoningEffort: effortProfile.reasoningEffort }
      : {}),
  };
}
