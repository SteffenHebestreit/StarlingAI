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
 * LEAK BACKSTOP on a SINGLE streaming call made with NO caller signal.
 *
 * It is not a health signal and no longer pretends to be one. The providers gate this
 * check on `signal === undefined` (lmstudio.ts / anthropic.ts), so on any turn-borne call
 * the caller's deadline — which salvages the partial AND resynthesizes — is the bound,
 * and an operator's unbounded grant suspends that deadline all the way down. What is left
 * here is the case the comment always claimed: a caller that stated no deadline at all
 * must still not hang the process forever.
 *
 * 20 minutes was the value while this was enforced unconditionally, and it killed healthy
 * work to the millisecond: run f08195d2's content_writer at 1,200,000 ms and an ephemeral
 * at 1,200,302 ms, both exactly MAX_STREAM_TOTAL_MS, one of them ~6 minutes from finishing.
 * An hour is the honest number for a leak bound — 2.2x the worst legitimate single pass
 * this module itself computes below (~26 min) — and it is the ceiling, so there is now one
 * bound rather than a default plus a ceiling that disagreed with it.
 */
export const MAX_STREAM_TOTAL_MS = 3_600_000;

/**
 * @deprecated The builder tier is GONE. It guessed at a capability ("this agent emits
 * whole files, so it may stream longer") to stand in for a health signal the guess could
 * never provide, and once the flat cap became a no-signal backstop it decided nothing.
 *
 * Retained as an alias of {@link MAX_STREAM_TOTAL_MS}, not deleted, purely so the tier
 * resolution in agent/sub-agent-model-config.ts and its tests keep compiling while they
 * are unwound; collapsing it to the same value is what makes the tier inert TODAY rather
 * than after that follow-up. It must never be given a value below MAX_STREAM_TOTAL_MS —
 * that inversion would hand builders a SHORTER budget than summarizers.
 *
 * The arithmetic that produced the old 45-minute figure is preserved because the ~26-minute
 * worst legitimate pass it derives is the basis for the hour above: on this hardware
 * (qwen3.8-27b via LM Studio, ~16.8 completion tokens/second) a ~30 KB single-file artifact
 * is ~9K tokens to emit, 9_000 / 16.8 ≈ 540 s of pure generation, and the reasoning block
 * that precedes it routinely costs as much again.
 */
export const BUILDER_MAX_STREAM_TOTAL_MS = MAX_STREAM_TOTAL_MS;

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
 * (gateway/rpc.ts), gateway.turnTimeoutMs has a `.min()` and no `.max()`
 * (config/schema.ts), and an effort profile allows 86_400_000. Above a ~59-minute turn
 * budget this clamp wins and the resolved cap sits below the deadline.
 *
 * That no longer costs anything: a call made under such a deadline carries a signal, and
 * the providers only consult the cap when there is none. The clamp bounds the no-signal
 * case, where "an hour of unbroken single-call generation with nobody watching" is a
 * wedged process whatever a config file says.
 */
export const MAX_STREAM_TOTAL_CEILING_MS = 3_600_000;
const MIN_STREAM_TOTAL_MS = 60_000;

/**
 * The no-signal leak backstop a provider instance enforces. Still per-agent — the value
 * rides in on the agent's own ModelConfig, the object that already carries every per-run
 * overlay into the single, failover, Anthropic and containerized construction paths — but
 * it is no longer a capability tier: an agent may lower it deliberately, and unset means
 * the hour above.
 */
export function resolveStreamTotalCapMs(modelConfig: Pick<ModelConfig, "maxStreamTotalMs"> | undefined): number {
  const requested = modelConfig?.maxStreamTotalMs;
  if (typeof requested !== "number" || !Number.isFinite(requested)) return MAX_STREAM_TOTAL_MS;
  return Math.min(Math.max(Math.round(requested), MIN_STREAM_TOTAL_MS), MAX_STREAM_TOTAL_CEILING_MS);
}
