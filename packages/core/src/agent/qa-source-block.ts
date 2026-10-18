/**
 * What this turn's tools returned, for the QA verdict (orchestration.qaVerdictSeesSources).
 *
 * The verdict is asked to ground a PASS in "a concrete verifiable fact from the answer's tool
 * results", and was never shown them: it saw the criteria, the answer and (qa-turn-record.ts) the
 * files and the user's words. Measured on this deployment (2026-10-17, three scenarios, five runs
 * each), it failed correct answers 60-100% of the time, citing the missing evidence or its own,
 * older knowledge ("Node.js 24 does not exist"). This block puts the results after the answer.
 *
 * Only the current turn's results, and only what can be a fact: routing tools (which agent could
 * do it, the swarm's state) and a plan without its results are left out. When the results do not
 * fit the budget the block is left out whole: a reviewer shown part of the source would read every
 * fact from the rest as invented.
 *
 * INVARIANT: imports only leaf modules, so runtime.ts can use it without a cycle.
 */
import { planReportResultsForDisplay, stripDelegateRelayFrame } from "./runtime-evidence-dump.js";
import { currentTurnStartIndex, type TurnBoundaryMessage } from "./turn-boundary.js";

/** Characters of results the block carries at most; past it, the block is left out. */
export const QA_SOURCE_MAX_CHARS = 8_000;

export const QA_SOURCE_HEADER = "SOURCE — what this turn's tools and specialists returned, which the ANSWER above was written from. "
  + "It is not part of the answer. Check two things against it: every fact the ANSWER states is in the source (a fact the "
  + "source does not contain, or contradicts, is invented — FAIL), and the ANSWER itself leaves out nothing the criteria ask "
  + "for (FAIL if it does). Judge facts only against this source, never against your own knowledge: it may be out of date, "
  + "and a version, date or event you do not know of is not wrong for that reason.";
export const QA_SOURCE_FOOTER = "(end of source)";

/** Tools whose results say how the turn was routed, not what is true. */
const ROUTING_TOOLS = new Set([
  "search_agents", "list_agents", "agent_catalog", "search_workflows", "search_skills", "search_tools", "load_tool", "get_swarm_state",
]);

const EVIDENCE_LEAD = "Observed evidence:";

export interface SourceHistoryMessage extends TurnBoundaryMessage {
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: ReadonlyArray<{ id: string; function?: { name?: string } }>;
}

/** The SOURCE block for the verdict, or "" when the turn's tools returned nothing that fits. */
export function formatQaSourceBlock(
  history: readonly SourceHistoryMessage[],
  options: { maxChars?: number; header?: string } = {},
): string {
  const turn = history.slice(currentTurnStartIndex(history) + 1);
  const toolNames = new Map<string, string>();
  for (const message of turn) {
    for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function?.name ?? "");
  }
  const pieces: string[] = [];
  for (const message of turn) {
    if (message.role !== "tool") continue;
    const name = message.tool_call_id ? toolNames.get(message.tool_call_id) ?? "" : "";
    if (ROUTING_TOOLS.has(name)) continue;
    const metadata = message.metadata ?? {};
    const text = sourceText(String(message.content ?? ""), metadata, name);
    if (!text) continue;
    const agent = typeof metadata["agentName"] === "string" ? metadata["agentName"] : "";
    const label = metadata["planExecution"] === true ? "" : agent || name;
    pieces.push(label ? `[${label}]\n${text}` : text);
  }
  if (pieces.length === 0) return "";
  const body = pieces.join("\n\n");
  if (body.length > (options.maxChars ?? QA_SOURCE_MAX_CHARS)) return "";
  return [options.header ?? QA_SOURCE_HEADER, body, QA_SOURCE_FOOTER].join("\n");
}

function sourceText(content: string, metadata: Record<string, unknown>, name: string): string {
  // A plan's report: its steps' results, without the executor's instructions to the orchestrator.
  if (metadata["planExecution"] === true) return (planReportResultsForDisplay(content) ?? "").trim();
  // A plan with no results yet is what the orchestrator meant to do, not a finding.
  if (name === "record_plan") return "";
  // A delegated result: the specialist's evidence, without the relay frame around it.
  const at = content.indexOf(EVIDENCE_LEAD);
  return stripDelegateRelayFrame(at >= 0 ? content.slice(at + EVIDENCE_LEAD.length) : content).trim();
}
