/**
 * One turn's execution steps, derived from a message.
 *
 * This lived inside MessageBubble.vue while the step list was rendered in the bubble head.
 * The list now belongs to the side panel, and the bubble keeps only a one-line summary — so
 * two components need the same derivation and it stops being a component's private business.
 * A second copy would drift: the sub-agent branch in particular carries a rule that is easy
 * to get wrong (see `buildExecutionItems`).
 */
import type { ChatMessage } from "../stores/gateway";

export type ExecutionStatus = "running" | "done" | "partial" | "failed";

export interface ExecutionItem {
  key: string;
  kind: "subagent" | "subagent-tool" | "tool";
  name: string;
  meta?: string;
  status: ExecutionStatus;
  statusSymbol: string;
  startedAt?: string;
  result?: string;
}

export function mapExecutionStatus(status: "running" | "completed" | "partial" | "failed"): ExecutionStatus {
  if (status === "completed") return "done";
  if (status === "partial") return "partial";
  return status;
}

export function executionStatusSymbol(status: ExecutionStatus): string {
  if (status === "done") return "✓";
  if (status === "partial") return "~";
  if (status === "failed") return "!";
  return "…";
}

/** Steps reconstructed from swarm state — the richer source when a turn delegated. */
function swarmItems(message: ChatMessage): ExecutionItem[] {
  return Object.values(message.swarmState?.tasks ?? {})
    .flatMap((task) => task.attempts.flatMap((attempt, index) => {
      const status = mapExecutionStatus(attempt.status);
      const items: ExecutionItem[] = [{
        key: `${task.id}-${attempt.agentName}-${attempt.startedAt}-${index}`,
        kind: "subagent",
        name: attempt.agentName,
        meta: [
          task.title,
          attempt.toolCount ? `${attempt.toolCount} tool${attempt.toolCount === 1 ? "" : "s"}` : "",
          attempt.iterations ? `${attempt.iterations} iter${attempt.iterations === 1 ? "" : "s"}` : "",
        ].filter(Boolean).join(" · "),
        status,
        statusSymbol: executionStatusSymbol(status),
        startedAt: attempt.startedAt,
      }];

      // A tool name only appears in toolNames after that call COMPLETED, so each listed
      // sub-agent tool call did run. Render it "done" — never inherit the parent attempt's
      // "partial"/"failed" status. A stopped or timed-out attempt, or one the operator chose
      // to stop, must not retroactively paint the searches that already succeeded as failed.
      // The attempt node itself keeps its real status.
      for (const [toolIndex, toolName] of (attempt.toolNames ?? []).entries()) {
        items.push({
          key: `${task.id}-${attempt.agentName}-${attempt.startedAt}-${index}-tool-${toolIndex}`,
          kind: "subagent-tool",
          name: toolName,
          meta: `${attempt.agentName} · ${toolIndex + 1}/${attempt.toolNames?.length ?? 0}`,
          status: "done",
          statusSymbol: executionStatusSymbol("done"),
          startedAt: attempt.startedAt,
        });
      }

      return items;
    }))
    .sort((left, right) => {
      if (left.startedAt && right.startedAt) return left.startedAt.localeCompare(right.startedAt);
      if (left.startedAt) return -1;
      if (right.startedAt) return 1;
      return left.key.localeCompare(right.key);
    });
}

/** Steps from the turn's own tool calls — the fallback when nothing was delegated. */
function toolItems(message: ChatMessage): ExecutionItem[] {
  return (message.toolCalls ?? []).map((toolCall, index) => {
    const argsSummary = Object.entries(toolCall.args ?? {})
      // Render object/array values as JSON, not the useless "[object Object]" String() gives.
      .map(([k, v]) => `${k}: ${(typeof v === "string" ? v : JSON.stringify(v)).substring(0, 80)}`)
      .join(", ");
    const status: ExecutionStatus = toolCall.result === undefined
      ? "running"
      : toolCall.result.trim().startsWith("Error:")
        ? "failed"
        : "done";
    return {
      key: toolCall.id ?? `${toolCall.name}-${index}`,
      kind: "tool" as const,
      name: toolCall.name,
      meta: argsSummary || undefined,
      status,
      statusSymbol: executionStatusSymbol(status),
      result: toolCall.result,
    };
  });
}

export interface ExecutionSummary {
  items: ExecutionItem[];
  header: string;
  /** True when the steps came from swarm state rather than from raw tool calls. */
  delegated: boolean;
}

export function buildExecutionItems(message: ChatMessage): ExecutionSummary {
  const swarm = swarmItems(message);
  if (swarm.length > 0) return { items: swarm, header: "Swarm Task Timeline", delegated: true };
  return { items: toolItems(message), header: "Tool Execution Steps", delegated: false };
}

/**
 * The one line the bubble shows in place of the whole list.
 *
 * Deliberately says what HAPPENED rather than how much happened: "3 tool calls completed" is
 * a progress bar in words, while naming the agent and what it produced is the thing a reader
 * skimming a long conversation is actually looking for.
 */
export function summariseExecution(message: ChatMessage): string {
  const { items, delegated } = buildExecutionItems(message);
  if (!items.length) return "";

  const running = items.filter(i => i.status === "running");
  const failed = items.filter(i => i.status === "failed");

  if (delegated) {
    const agents = [...new Set(items.filter(i => i.kind === "subagent").map(i => i.name))];
    const who = agents.length === 1 ? agents[0]
      : agents.length === 2 ? `${agents[0]} and ${agents[1]}`
        : `${agents.length} specialists`;
    if (running.length) return `${who} working…`;
    if (failed.length) return `${who} — ${failed.length} step${failed.length === 1 ? "" : "s"} failed`;
    const toolCount = items.filter(i => i.kind === "subagent-tool").length;
    return toolCount ? `${who} · ${toolCount} step${toolCount === 1 ? "" : "s"}` : String(who);
  }

  if (running.length) return `Running ${running[0]!.name}…`;
  if (failed.length) return `${failed.length} of ${items.length} step${items.length === 1 ? "" : "s"} failed`;
  const names = [...new Set(items.map(i => i.name))];
  return names.length === 1
    ? `${names[0]} · done`
    : `${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""} · done`;
}
