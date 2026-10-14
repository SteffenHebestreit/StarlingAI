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

export interface SubAgentHeartbeat {
  activity: "planning" | "composing" | "steering";
  chars?: number;
}

/**
 * A specialist's sign of life, for its delegation's row: planning its next step, composing a long
 * reply, reading a message the user sent mid-turn. Not a status line (above) — the row's detail,
 * which otherwise stood still for the minutes a specialist composed without calling a tool. Sent
 * as what it is, not as a sentence, so the page says it in the user's language. A `thinking` event
 * that does not say what it is (a federated peer's) is not one.
 */
export function subAgentHeartbeat(event: Pick<SubAgentProgressEvent, "kind" | "activity" | "chars">): SubAgentHeartbeat | null {
  if (event.kind !== "thinking" || !event.activity) return null;
  return { activity: event.activity, ...(typeof event.chars === "number" && Number.isFinite(event.chars) ? { chars: event.chars } : {}) };
}
