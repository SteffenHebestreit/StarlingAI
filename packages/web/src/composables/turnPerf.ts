/**
 * A turn's all-agents model totals, as the gateway reports them on turn_performance
 * (core agent/turn-metrics.ts allModelCalls): every model call made in the turn, by any agent, with
 * the time and tokens they took. The main assistant's own figures (llmCalls, llmTimeMs) leave out the
 * agents it delegated to, so a delegating turn read "LLM time 20.5 s" over 4.9 minutes of work.
 */
export interface TurnModelTotals {
  allModelCalls?: number;
  allModelTimeMs?: number;
  allPromptTokens?: number;
  allCompletionTokens?: number;
}

const TOTAL_KEYS = ["allModelCalls", "allModelTimeMs", "allPromptTokens", "allCompletionTokens"] as const;

/** The totals of a turn_performance payload, each only when the gateway sent it as a finite, non-negative number. */
export function turnModelTotals(rawPerf: Record<string, unknown>): TurnModelTotals {
  const out: TurnModelTotals = {};
  for (const key of TOTAL_KEYS) {
    const value = rawPerf[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}
