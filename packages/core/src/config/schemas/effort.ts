import { z } from "zod";

// ─── Effort profiles ──────────────────────────────────────────────────────────
// A single per-session "effort" dial bundles the scattered latency/budget/size/
// depth/reasoning knobs (and, at the top tier, the orchestration quality gates)
// into named profiles. `medium` is the identity overlay — every field undefined,
// so the turn runs under today's config defaults. Higher tiers relax the caps,
// raise SLOs, push reasoning, and inject a "be thorough" prompt-chunk; `max`
// additionally turns the correctness/QA gates OFF (a deliberate "get out of the
// way" mode). Effort NEVER touches the content-safety/security guardrails
// (GuardrailsSchema) — only the orchestration quality/latency behavior.
//
// Built-in per-tier defaults live in runtime/effort-context.ts
// (BUILTIN_EFFORT_PROFILES); a `profiles[tier]` entry here overlays its fields on
// top of that built-in, so a config only needs to specify what it wants to change.
export const EFFORT_TIERS = ["low", "medium", "high", "max"] as const;
export const EffortTierSchema = z.enum(EFFORT_TIERS);

export const EffortProfileSchema = z.object({
  /** Hard turn timeout (ms). 0 = unlimited (disables the gateway turn-timeout kill). */
  turnTimeoutMs: z.number().int().min(0).max(86_400_000).optional(),
  /** Orchestrator per-turn tool-call iteration cap (overrides agents.maxToolIterations). 0 = unbounded. */
  orchestratorMaxToolIterations: z.number().int().min(0).max(500).optional(),
  /** Delegated sub-agent iteration cap (feeds maxIterationsOverride). 0 = unbounded. */
  subAgentMaxIterations: z.number().int().min(0).max(500).optional(),
  /** Max delegation nesting depth (overrides orchestration.maxDelegationDepth). */
  maxDelegationDepth: z.number().int().min(1).max(12).optional(),
  /** Max simultaneous research slices (overrides orchestration.maxParallelSlices). */
  maxParallelSlices: z.number().int().min(1).max(12).optional(),
  /** Max chars of a single delegated result relayed verbatim (overrides performance.maxDelegatedResultChars). */
  maxDelegatedResultChars: z.number().int().min(1_000).max(500_000).optional(),
  /** Completion-token ceiling for delegated sub-agents (overrides the agent's maxTokens). */
  subAgentMaxTokens: z.number().int().min(256).max(200_000).optional(),
  /** Orchestrator turn-SLO breach threshold (ms) — raise it so long turns don't spuriously alert. */
  orchestratorTurnSloMs: z.number().int().min(5_000).optional(),
  /** Sub-agent turn-SLO breach threshold (ms). */
  subAgentTurnSloMs: z.number().int().min(5_000).optional(),
  /** Reasoning effort passed to reasoning-effort models for this turn.
   *  "none" (thinking off) and "xhigh" are Qwen 3.8+ levels; see ModelConfig.reasoningEffort
   *  for how each family folds the ladder onto what it actually accepts. */
  reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
  /** Extended-thinking toggle for this turn (Qwen/GLM/DeepSeek enable_thinking families). */
  enableThinking: z.boolean().optional(),
  /** Multiplier applied to every per-call/per-turn tool cap (subAgentToolCaps, coordinatorToolCaps, perTurnCaps). */
  toolCapMultiplier: z.number().min(0.1).max(20).optional(),
  /** Orchestration quality gates — set false to relax (top tier). Undefined = inherit config. */
  riskGatedQA: z.boolean().optional(),
  qaEvidenceAnchoring: z.boolean().optional(),
  finalResponseQaGate: z.boolean().optional(),
  autoResearchOnRefusal: z.boolean().optional(),
  autoBuildAfterResearch: z.boolean().optional(),
  oversight: z.boolean().optional(),
  /** Lean, droppable system prompt-chunk injected at turn start (e.g. a thoroughness nudge). */
  promptAddendum: z.string().max(4_000).optional(),
});
export type EffortProfile = z.infer<typeof EffortProfileSchema>;
export type EffortTier = z.infer<typeof EffortTierSchema>;

export const EffortSchema = z.object({
  /** Effort tier new sessions inherit. Per-session settings override it. Default "medium" (= today's behavior). */
  default: EffortTierSchema.default("medium"),
  /** Per-tier overrides layered on top of the built-in profiles (BUILTIN_EFFORT_PROFILES).
   *  Only specify the fields you want to change; omitted fields keep the built-in value. */
  profiles: z.record(EffortTierSchema, EffortProfileSchema).default({}),
});
export type EffortConfig = z.infer<typeof EffortSchema>;
