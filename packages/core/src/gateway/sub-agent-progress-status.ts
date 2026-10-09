import type { SubAgentProgressEvent } from "../agent/sub-agent.js";

export interface SubAgentLifecycleStatus {
  phase: "delegating";
  message: string;
  iteration: number;
}

/** A status line is a glance, not a transcript — and federated peers author summaries too. */
const MAX_STATUS_CHARS = 200;

function statusLine(summary: string | undefined, fallback: string): string {
  const text = summary?.trim() || fallback;
  return text.length > MAX_STATUS_CHARS ? `${text.slice(0, MAX_STATUS_CHARS - 1)}…` : text;
}

/**
 * The status line a sub-agent lifecycle event becomes for the dashboard.
 *
 * The gateway forwarded a delegated agent's tool events and reasoning, but not the fact that it
 * had started or finished — so for the minutes a specialist ran without tool calls (a long
 * synthesis, a container bootstrap) the user saw the status pill frozen on the orchestrator's
 * last phase. `thinking` fires every iteration and stays out: at status granularity it is noise,
 * and the reasoning lane already carries what the model is doing.
 */
export function subAgentProgressStatus(
  event: Pick<SubAgentProgressEvent, "kind" | "agentName" | "iteration" | "summary">,
): SubAgentLifecycleStatus | null {
  if (event.kind === "started") {
    return { phase: "delegating", message: statusLine(event.summary, `${event.agentName} started`), iteration: event.iteration };
  }
  if (event.kind === "completed") {
    return { phase: "delegating", message: statusLine(event.summary, `${event.agentName} finished`), iteration: event.iteration };
  }
  return null;
}
