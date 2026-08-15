/**
 * Effort profiles — a single per-session "effort" dial that bundles the scattered
 * latency / budget / size / depth / reasoning knobs (and, at the top tier, the
 * orchestration quality gates) into named tiers: low | medium | high | max.
 *
 * `medium` is the IDENTITY overlay (every field undefined → the turn runs under
 * today's config defaults, unchanged). Higher tiers relax caps, raise SLOs, push
 * reasoning, and inject a "be thorough" prompt-chunk. `max` additionally turns the
 * correctness/QA gates OFF (a deliberate "get out of the way" mode).
 *
 * Effort NEVER touches the content-safety / security guardrails (GuardrailsSchema) —
 * only the orchestration quality / latency behavior.
 *
 * Resolution: BUILTIN_EFFORT_PROFILES[tier] overlaid with config.effort.profiles[tier]
 * (field-wise; a config only specifies what it changes). The resolved profile is
 * carried for the duration of a turn via an AsyncLocalStorage (mirroring
 * runtime/request-context.ts) so the scattered getConfig().orchestration reads inside
 * the runtime pick it up without threading a parameter through every function.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getConfig } from "../config/loader.js";
import type { EffortProfile, EffortTier, OrchestrationConfig } from "../config/schema.js";

export type { EffortProfile, EffortTier } from "../config/schema.js";

/** A profile with every relevant field resolved (after built-in + config overlay). */
export type ResolvedEffortProfile = EffortProfile;

const VALID_TIERS = new Set<EffortTier>(["low", "medium", "high", "max"]);

/** Coerce an arbitrary value (RPC param / inline flag) into a known tier, or undefined. */
export function resolveEffortTier(value: unknown): EffortTier | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return VALID_TIERS.has(v as EffortTier) ? (v as EffortTier) : undefined;
}

/** A lean, droppable prompt-chunk that nudges the model toward depth/completeness. */
const HIGH_ADDENDUM =
  "HIGH-EFFORT MODE: the user has asked for maximum thoroughness on this turn. Favor "
  + "depth and completeness over speed — gather enough evidence, decompose the problem "
  + "fully, and produce a complete, well-structured deliverable. When the request is for "
  + "a document, paper, report, or plan, write it IN FULL with clear sections; do not "
  + "summarize, stub, or truncate sections you could complete. You have an expanded time "
  + "and tool budget — use it. Do not stop at a 'good enough' first pass.";

const MAX_ADDENDUM =
  HIGH_ADDENDUM
  + " There is no latency pressure on this turn: prefer the most rigorous path even if it "
  + "is slow, and keep refining and expanding until the deliverable is genuinely complete.";

/** Pushes the model toward the least-work path that still fully answers the request —
 *  paired with the long-running policy's low→"stop" so a low-effort turn winds down fast. */
const LOW_ADDENDUM =
  "LOW-EFFORT MODE: reach the user's goal with the LEAST work that still fully answers it. "
  + "Strongly prefer a direct answer or a single specialist over multi-step orchestration; "
  + "do not fan out, deep-research, or add sections the request did not explicitly ask for. "
  + "Be concise and stop as soon as the answer is complete — favor speed over exhaustiveness.";

/**
 * Built-in per-tier defaults. `medium` is intentionally empty (identity). These are
 * overlaid by config.effort.profiles[tier]. See docs/architecture.md for the rationale
 * behind each tier (high = thorough WITH correctness kept; max = unleashed, gates off).
 */
export const BUILTIN_EFFORT_PROFILES: Record<EffortTier, EffortProfile> = {
  low: {
    turnTimeoutMs: 120_000,
    orchestratorMaxToolIterations: 10,
    subAgentMaxIterations: 4,
    maxDelegationDepth: 2,
    maxDelegatedResultChars: 6_000,
    // Effort-scaled child budget: a low-effort delegated specialist finishes fast (a low turn is
    // "least work that answers it", so its children must be short too — else a leaf researcher gets
    // the config default 600s under a 120s turn, run e3cf6c22). Doubles as the leaf timeout default
    // via effectiveSubAgentTurnSloMs().
    subAgentTurnSloMs: 90_000,
    reasoningEffort: "low",
    enableThinking: false,
    toolCapMultiplier: 0.5,
    promptAddendum: LOW_ADDENDUM,
  },
  medium: {},
  high: {
    turnTimeoutMs: 1_200_000,
    orchestratorMaxToolIterations: 40,
    subAgentMaxIterations: 30,
    maxDelegationDepth: 4,
    maxParallelSlices: 3,
    maxDelegatedResultChars: 40_000,
    subAgentMaxTokens: 16_384,
    orchestratorTurnSloMs: 1_200_000,
    subAgentTurnSloMs: 600_000,
    reasoningEffort: "high",
    enableThinking: true,
    toolCapMultiplier: 2,
    promptAddendum: HIGH_ADDENDUM,
  },
  max: {
    turnTimeoutMs: 0,
    orchestratorMaxToolIterations: 80,
    subAgentMaxIterations: 60,
    maxDelegationDepth: 6,
    maxParallelSlices: 4,
    maxDelegatedResultChars: 120_000,
    subAgentMaxTokens: 32_768,
    orchestratorTurnSloMs: 86_400_000,
    subAgentTurnSloMs: 86_400_000,
    reasoningEffort: "high",
    enableThinking: true,
    toolCapMultiplier: 4,
    // User's explicit choice: at max effort, relax the orchestration quality gates too.
    riskGatedQA: false,
    qaEvidenceAnchoring: false,
    finalResponseQaGate: false,
    autoResearchOnRefusal: false,
    oversight: false,
    // autoBuildAfterResearch stays ON — it is what produces the deliverable.
    promptAddendum: MAX_ADDENDUM,
  },
};

/**
 * Resolve the effective profile for a tier: built-in default overlaid with the
 * config.effort.profiles[tier] override (field-wise; undefined config fields keep the
 * built-in value). An unknown/undefined tier resolves to the configured default tier.
 */
export function resolveEffortProfile(tier?: EffortTier): ResolvedEffortProfile {
  const cfg = getConfig().effort;
  const effectiveTier: EffortTier = tier ?? cfg?.default ?? "medium";
  const builtin = BUILTIN_EFFORT_PROFILES[effectiveTier] ?? {};
  const override = cfg?.profiles?.[effectiveTier] ?? {};
  // Drop undefined keys from the override so they don't clobber built-in values.
  const merged: EffortProfile = { ...builtin };
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/** The effective default tier from config. */
export function defaultEffortTier(): EffortTier {
  return getConfig().effort?.default ?? "medium";
}

// ─── Turn-scoped active profile ───────────────────────────────────────────────

interface EffortContext {
  tier: EffortTier;
  profile: ResolvedEffortProfile;
  /** Turn-scoped orchestration overlay — see runWithOrchestrationOverride. */
  orchestrationOverride?: Partial<OrchestrationConfig>;
}

const storage = new AsyncLocalStorage<EffortContext>();

/** Run `fn` with the resolved effort profile active for its entire async lifetime. */
export function runWithEffortContext<T>(tier: EffortTier | undefined, fn: () => T): T {
  const effectiveTier: EffortTier = tier ?? defaultEffortTier();
  const current = storage.getStore();
  return storage.run({
    tier: effectiveTier,
    profile: resolveEffortProfile(effectiveTier),
    // Preserve an outer orchestration overlay: an eval arm sets the overlay, then the
    // turn sets its effort tier inside it. Dropping it here would silently disarm the
    // arm being measured.
    ...(current?.orchestrationOverride ? { orchestrationOverride: current.orchestrationOverride } : {}),
  }, fn);
}

/**
 * Run `fn` with a turn-scoped orchestration overlay.
 *
 * Exists so an A/B arm can flip an `orchestration.*` flag for the duration of one
 * run WITHOUT mutating process-global config. `effectiveOrchestration` reads
 * `getConfig().orchestration`, which is shared by every concurrent turn — so before
 * this, evaluating a candidate orchestration flag meant editing a shard, rebuilding
 * config and restarting. That friction is why flags accumulate at default-off.
 *
 * Layering is base → overlay → effort profile, so the effort dial still wins by
 * construction. The fields an effort profile controls (maxDelegationDepth,
 * riskGatedQA, qaEvidenceAnchoring, finalResponseQaGate, autoResearchOnRefusal,
 * autoBuildAfterResearch, maxParallelSlices) therefore cannot be A/B'd this way
 * while a non-default tier is active; every other orchestration flag can.
 *
 * In-process only. A gateway-routed run executes in a different process and never
 * observes this store.
 */
export function runWithOrchestrationOverride<T>(
  override: Partial<OrchestrationConfig> | undefined,
  fn: () => T,
): T {
  if (!override || Object.keys(override).length === 0) return fn();
  const current = storage.getStore();
  const tier: EffortTier = current?.tier ?? defaultEffortTier();
  return storage.run({
    tier,
    profile: current?.profile ?? resolveEffortProfile(tier),
    orchestrationOverride: { ...current?.orchestrationOverride, ...override },
  }, fn);
}

/** The active turn's resolved effort profile, if a turn context is set. */
export function currentEffortProfile(): ResolvedEffortProfile | undefined {
  return storage.getStore()?.profile;
}

/** The active turn's effort tier, if set. */
export function currentEffortTier(): EffortTier | undefined {
  return storage.getStore()?.tier;
}

// ─── Effective-value accessors (overlay active profile onto config) ────────────

/** config.orchestration with the active profile's gate/number overrides applied. */
export function effectiveOrchestration(): OrchestrationConfig {
  const store = storage.getStore();
  // base → turn-scoped overlay (eval arms) → effort profile. Effort stays last so
  // its existing precedence is unchanged.
  const base = store?.orchestrationOverride
    ? { ...getConfig().orchestration, ...store.orchestrationOverride }
    : getConfig().orchestration;
  const p = store?.profile;
  if (!p) return base;
  return {
    ...base,
    ...(p.maxDelegationDepth !== undefined ? { maxDelegationDepth: p.maxDelegationDepth } : {}),
    ...(p.maxParallelSlices !== undefined ? { maxParallelSlices: p.maxParallelSlices } : {}),
    ...(p.riskGatedQA !== undefined ? { riskGatedQA: p.riskGatedQA } : {}),
    ...(p.qaEvidenceAnchoring !== undefined ? { qaEvidenceAnchoring: p.qaEvidenceAnchoring } : {}),
    ...(p.finalResponseQaGate !== undefined ? { finalResponseQaGate: p.finalResponseQaGate } : {}),
    ...(p.autoResearchOnRefusal !== undefined ? { autoResearchOnRefusal: p.autoResearchOnRefusal } : {}),
    ...(p.autoBuildAfterResearch !== undefined ? { autoBuildAfterResearch: p.autoBuildAfterResearch } : {}),
    ...(p.oversight !== undefined ? { oversight: p.oversight } : {}),
  };
}

/** Effective max chars of a single delegated result relayed verbatim. */
export function effectiveMaxDelegatedResultChars(): number {
  const p = currentEffortProfile();
  return p?.maxDelegatedResultChars ?? getConfig().agents.performance.maxDelegatedResultChars;
}

/** Effective orchestrator turn-SLO breach threshold (ms). */
export function effectiveOrchestratorTurnSloMs(): number {
  const p = currentEffortProfile();
  return p?.orchestratorTurnSloMs ?? getConfig().agents.performance.orchestratorTurnSloMs;
}

/** Effective sub-agent turn-SLO breach threshold (ms). */
export function effectiveSubAgentTurnSloMs(): number {
  const p = currentEffortProfile();
  return p?.subAgentTurnSloMs ?? getConfig().agents.performance.subAgentTurnSloMs;
}

/**
 * Effective orchestrator iteration cap as a resolved number (0 → unbounded). Returns
 * undefined when no effort override applies, so callers fall through to config.
 */
export function effectiveOrchestratorMaxToolIterations(): number | undefined {
  const p = currentEffortProfile();
  if (p?.orchestratorMaxToolIterations === undefined) return undefined;
  return p.orchestratorMaxToolIterations === 0
    ? Number.MAX_SAFE_INTEGER
    : p.orchestratorMaxToolIterations;
}
