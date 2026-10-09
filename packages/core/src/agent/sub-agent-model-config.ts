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
// Leaf module by design: importing the constants from providers/lmstudio.js would pull
// the OpenAI SDK and undici into every consumer of these otherwise type-only helpers.
import {
  BUILDER_MAX_STREAM_TOTAL_MS,
  MAX_STREAM_TOTAL_CEILING_MS,
  MAX_STREAM_TOTAL_MS,
} from "../providers/stream-budget.js";

/**
 * Tools whose SINGLE CALL emits a whole file — the file IS the deliverable, and the one
 * completion that produces it is the work that can legitimately outrun the flat 20-minute
 * stream cap.
 *
 * write_file and edit_file are deliberately ABSENT. They were in this set, and measuring
 * it against the shipped roster is what killed that: 39 of the 49 agents in
 * workspace/agents/*.jsonc hold write_file+edit_file, including summarizer, qa_guard,
 * diff_reviewer, researcher and every pentest agent. Those tools are how an agent takes a
 * note, not evidence that its deliverable is a 30 KB artifact — so keying the raised tier
 * on them made it the near-universal default and the "builder" tier meaningless. An agent
 * that really does emit a large file through bare write_file (backend_coder's server.js)
 * pins `model.maxStreamTotalMs` in its own shard: an explicit declaration, not a guess
 * from a tool grant. Nothing here can distinguish summarizer from backend_coder, and
 * pretending otherwise is what produced the 39.
 *
 * Also deliberately NOT ARTIFACT_PRODUCING_TOOLS (tools/delegation-artifact-classification.ts):
 * that set is the "did the agent narrate instead of executing" test and also contains
 * shell_exec and create_dir, neither of which emits content.
 */
const ARTIFACT_EMITTER_TOOL_NAMES = new Set([
  "generate_document",
  "generate_website",
  "generate_presentation",
  "generate_docx",
  "generate_pptx",
  "generate_pdf",
  "render_pdf",
]);

/**
 * Tools that let an agent put bytes into the workspace at all — a much weaker property
 * than ARTIFACT_EMITTER_TOOL_NAMES above, and kept separate precisely so the two are not
 * confused again. Only the ephemeral factory uses it, and only to decide how long an
 * architect is ALLOWED TO ASK for; nothing is granted automatically from it.
 */
const WORKSPACE_WRITE_TOOL_NAMES = new Set([
  "write_file",
  "edit_file",
  ...ARTIFACT_EMITTER_TOOL_NAMES,
]);

/**
 * Headroom by which the stream cap must exceed the turn deadline.
 *
 * The two bounds are not interchangeable. The DEADLINE (DeadlineAbort) salvages the
 * partial AND runs the timeout-synthesis pass that turns it into an answer; the CAP only
 * salvages. So the deadline should fire first, and a stream never starts before its turn
 * does — streamElapsed <= turnElapsed — which makes `cap > turnTimeoutMs` sufficient.
 * The margin covers abort latency and clock jitter so the ordering is not a photo finish.
 *
 * This ordering only became REAL when the providers stopped orphaning the abort signal
 * the moment the stream opened (providers/lmstudio.ts + anthropic.ts withHardTimeout): an
 * armed deadline that cannot reach the transport fires in name only, which is why run
 * f08195d2 landed on the cap to the millisecond under a deadline that had already passed.
 * It still holds only where a deadline EXISTS and the ceiling below does not clip the
 * lift — see resolveAgentStreamCapMs for both exceptions.
 */
const DEADLINE_PRIMACY_MARGIN_MS = 60_000;

/** Does one call to one of this agent's tools emit a whole file? Drives the stream-cap tier. */
export function emitsWholeFileArtifacts(toolNames: readonly string[] | undefined): boolean {
  return (toolNames ?? []).some((name) => ARTIFACT_EMITTER_TOOL_NAMES.has(name));
}

/** Can this agent write into the workspace at all? Weaker; see WORKSPACE_WRITE_TOOL_NAMES. */
export function canWriteWorkspaceFiles(toolNames: readonly string[] | undefined): boolean {
  return (toolNames ?? []).some((name) => WORKSPACE_WRITE_TOOL_NAMES.has(name));
}

/**
 * The total-stream backstop this agent's provider should enforce.
 *
 * HOW MUCH THIS MATTERS, honestly: for a run that HAS a deadline, not at all. The lift
 * below puts the cap a full minute above the deadline, and the deadline now genuinely
 * aborts the open stream, so the cap is unreachable by construction. It is the operative
 * wall clock only where no deadline exists — `turnTimeoutMs: "unbound"`, the max-effort
 * profile (turnTimeoutMs 0, which propagates a 0 caller ceiling to every child), and a
 * run whose deadline an operator suspended with an unbounded grant. Those are exactly the
 * runs with nothing else holding them, which is why the tier is narrow rather than absent.
 *
 * Inputs, in order:
 *  1. Tier by capability — an agent that emits whole files gets 45 min, everything else
 *     the 20-min default. Measured: at ~16.8 completion tok/s a ~30 KB artifact is ~9K
 *     tokens to emit plus the reasoning that precedes it, so one pass can need ~26 min.
 *  2. Floor at the agent's OWN declared turn budget, whether or not this run resolved a
 *     deadline from it. An author who wrote `turnTimeoutMs: 1500000` said a single pass
 *     of this agent's work runs up to 25 minutes; a max-effort run that suspends the
 *     deadline should not silently shrink that statement to the flat 20. This is what
 *     lets the tier stay narrow: backend_coder keeps its 26 minutes on a deadline-less
 *     run without holding a document-emitter tool.
 *  3. Lift above the deadline THIS run actually resolved, so DeadlineAbort — which
 *     salvages AND resynthesizes — reaches the stream before the cap, which only salvages.
 *
 * An explicit per-agent `maxStreamTotalMs` replaces the tier but is still floored/lifted:
 * a pin that sits under the agent's own deadline is a mistake, not a policy.
 */
export function resolveAgentStreamCapMs(agent: {
  toolNames: readonly string[] | undefined;
  /** The deadline THIS run resolved; `undefined` when the run has none. */
  turnTimeoutMs: number | undefined;
  /** The agent's own numeric `turnTimeoutMs` declaration, independent of this run's
   *  resolution. `undefined` for an agent that declared none or declared "unbound" —
   *  in both cases the agent has made no statement about how long one pass takes. */
  declaredTurnTimeoutMs?: number | undefined;
  explicitCapMs?: number | undefined;
}): number {
  const tierCapMs = agent.explicitCapMs
    ?? (emitsWholeFileArtifacts(agent.toolNames) ? BUILDER_MAX_STREAM_TOTAL_MS : MAX_STREAM_TOTAL_MS);
  const floorFor = (ms: number | undefined): number => (ms && ms > 0 ? ms + DEADLINE_PRIMACY_MARGIN_MS : 0);
  const resolved = Math.max(tierCapMs, floorFor(agent.declaredTurnTimeoutMs), floorFor(agent.turnTimeoutMs));
  // The ceiling is an absolute sanity bound and it WINS over the lift, so the ordering in
  // DEADLINE_PRIMACY_MARGIN_MS is not universal: a turn budget above ~59 minutes (reachable
  // via `--timeout 0` → 7_200_000, gateway.turnTimeoutMs has no schema max, and the effort
  // profile allows 86_400_000) leaves the cap below the deadline again. That is a deliberate
  // choice — an hour of unbroken generation is a runaway whatever the deadline says — not a
  // guarantee that the deadline always wins.
  return Math.min(resolved, MAX_STREAM_TOTAL_CEILING_MS);
}

/** Fold the resolved stream cap onto a ModelConfig so it rides the existing per-agent
 *  overlay chain into every provider construction path (single, failover, Anthropic,
 *  containerized worker) without a signature change. */
export function applyStreamCapOverlay(
  modelConfig: ModelConfig,
  agent: {
    toolNames: readonly string[] | undefined;
    turnTimeoutMs: number | undefined;
    declaredTurnTimeoutMs?: number | undefined;
  },
): ModelConfig {
  return {
    ...modelConfig,
    maxStreamTotalMs: resolveAgentStreamCapMs({
      toolNames: agent.toolNames,
      turnTimeoutMs: agent.turnTimeoutMs,
      declaredTurnTimeoutMs: agent.declaredTurnTimeoutMs,
      explicitCapMs: modelConfig.maxStreamTotalMs,
    }),
  };
}

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
