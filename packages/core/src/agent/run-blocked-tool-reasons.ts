/**
 * The `sub_agent_tool_blocked` reasons that mean "the RUNTIME took this tool away
 * mid-run", shared by the emitter (agent/sub-agent.ts) and the counter (agent/warden.ts).
 *
 * These reasons exist BECAUSE the withdrawn tool deliberately stays on the wire. Dropping
 * it rewrites the tool list, which misses the prefix cache: the probe in sub-agent.ts
 * measured the same turn at prompt 7,027 / processed 4 / 0.40 s with the tools still
 * listed versus prompt 7,027 / processed 7,027 / 7.28 s once they were stripped. So the
 * run keeps the schema and refuses the call at the call site, answering with a synthetic
 * result plus one of these rows.
 *
 * A model that then retries such a tool is reacting to a withdrawal the runtime performed
 * mid-turn — it is not reaching for a tool it was never granted. Counting those retries
 * toward the warden's escape threshold would punish the prefix-stability fix with an
 * error-severity alert, a synthetic failure outcome against a healthy agent (which feeds
 * outcome-weighted routing) and a possible session abort.
 *
 * `not_in_agent_tools` is deliberately NOT in the set: that row is a genuine attempt to
 * call a tool outside the agent's allow-list, which is exactly what the warden is for.
 *
 * This lives in its own module rather than in sub-agent.ts because sub-agent.ts already
 * imports warden.ts (isSessionDegraded), so a warden → sub-agent import would close a cycle.
 */
export const RUN_INTERNAL_WITHDRAWAL_REASONS: ReadonlySet<string> = new Set([
  "evidence_cap_enforced",
  "approval_gate_unresolved",
  "search_backend_degraded",
  "delegation_cascade_failed",
  // Predates the prefix-stability wave and behaves the same way: after
  // INFRA_FAILURE_BLOCK_THRESHOLD identical failure signatures the whole live-tool family is
  // blocked (agent/infra-failure.ts), the schemas stay on the wire, and each later call is
  // answered at the call site with buildInfraFamilyBlockedMessage. A model retrying a backend
  // the runtime has just declared unreachable is reacting to a withdrawal, not escaping its
  // allow-list — the same reading as the four above.
  "backend_unreachable",
]);

/** True when a `sub_agent_tool_blocked` row records a mid-run withdrawal by the runtime
 *  rather than a call to a tool the agent never held. Tolerates a missing/non-string
 *  reason (older rows carry none) by treating it as not-a-withdrawal. */
export function isRunInternalWithdrawalReason(reason: unknown): boolean {
  return typeof reason === "string" && RUN_INTERNAL_WITHDRAWAL_REASONS.has(reason);
}
