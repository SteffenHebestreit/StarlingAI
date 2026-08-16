/**
 * Total-stream budget constants.
 *
 * Their own module because both ends of the seam need them: the providers ENFORCE the
 * cap, and the sub-agent runner RESOLVES it per agent (agent/sub-agent-model-config.ts,
 * whose imports are otherwise type-only — importing lmstudio.ts there would drag the
 * OpenAI SDK and undici into every consumer of those pure helpers).
 */

import type { ModelConfig } from "../config/schema.js";

/**
 * Hard ceiling on a SINGLE streaming call, however healthy it looks — the DEFAULT
 * for an agent that does not build files.
 *
 * The inactivity guard measures silence and re-arms per chunk, so it can never stop a
 * model that keeps emitting. 20 minutes is far above any legitimate single generation
 * on this hardware (a full build turn is minutes) and far below the 36-minute runaway
 * that motivated it.
 */
export const MAX_STREAM_TOTAL_MS = 1_200_000;

/**
 * The same ceiling for an agent whose deliverable is a whole file it EMITS.
 *
 * Arithmetic, measured on this hardware (qwen3.8-27b via LM Studio, ~16.8 completion
 * tokens/second): a ~30 KB single-file artifact is ~9K tokens to EMIT, i.e.
 * 9_000 / 16.8 ≈ 540 s of pure generation, and the reasoning block that precedes it
 * routinely costs as much again — so ONE legitimate build pass can need ~26 minutes.
 * The flat 20-minute ceiling guillotined exactly that (run f08195d2: content_writer
 * iteration 2 ran 1,200,000 ms to the millisecond, 64,587 reasoning chars, zero
 * artifact tool calls). 45 minutes leaves headroom over the ~26-minute worst
 * legitimate pass while staying a decisive signal against the 36-minute-plus runaway
 * class the cap exists to stop.
 */
export const BUILDER_MAX_STREAM_TOTAL_MS = 2_700_000;

/**
 * Absolute bounds any per-agent cap is clamped into.
 *
 * The upper bound sits above the largest turn deadline an AGENT can declare for itself
 * (SubAgentConfigSchema caps turnTimeoutMs at 1_800_000) plus headroom, so the lift in
 * resolveAgentStreamCapMs (agent/sub-agent-model-config.ts) is never clipped for an
 * agent-declared budget.
 *
 * It is NOT above every reachable deadline, and a comment here previously claimed it was.
 * A CALLER budget has no such bound: `--timeout 0` resolves to 7_200_000
 * (gateway/rpc.ts:197-199), gateway.turnTimeoutMs has a `.min()` and no `.max()`
 * (config/schema.ts), and an effort profile allows 86_400_000. Above a ~59-minute turn
 * budget this clamp wins and the cap sits BELOW the deadline again. That is intended —
 * an hour of unbroken single-call generation is a runaway whatever the deadline says —
 * but it means "the deadline always fires first" is a property of the common case, not
 * an invariant of this module.
 */
export const MAX_STREAM_TOTAL_CEILING_MS = 3_600_000;
const MIN_STREAM_TOTAL_MS = 60_000;

/**
 * The total-stream cap a provider instance enforces. Per-agent, because a builder
 * needs minutes a summarizer never will: the value rides in on the agent's own
 * ModelConfig — the object that already carries every per-run overlay into the single,
 * failover, Anthropic and containerized construction paths — so no provider signature
 * changes and no caller-side plumbing are involved. Unset → the 20-minute default.
 */
export function resolveStreamTotalCapMs(modelConfig: Pick<ModelConfig, "maxStreamTotalMs"> | undefined): number {
  const requested = modelConfig?.maxStreamTotalMs;
  if (typeof requested !== "number" || !Number.isFinite(requested)) return MAX_STREAM_TOTAL_MS;
  return Math.min(Math.max(Math.round(requested), MIN_STREAM_TOTAL_MS), MAX_STREAM_TOTAL_CEILING_MS);
}
