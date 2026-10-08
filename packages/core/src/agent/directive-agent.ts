/**
 * The agent the user directed a turn to (`--agent NAME`, RunTurnOptions.directiveAgent).
 *
 * Until that agent has run, the turn delegates to it: the tool call is forced, a line names the
 * agent, and a response that calls no tool is replaced by the delegation itself (runtime.ts). Three
 * questions that loop asks are answered here: did a call run the agent, which requested calls are
 * the delegation to it, and what the runtime's own delegation hands the agent besides the request.
 * The gateway asks a fourth before the turn starts: is there an agent of that name at all.
 */
import { getConfig } from "../config/loader.js";
import { withPromotedAgents } from "./promoted-agents.js";
import { currentTurnStartIndex } from "./turn-boundary.js";
import type { NestedToolCall } from "./turn-tool-contribution.js";

/**
 * Whether a name names an agent this deployment has: a configured sub-agent or a promoted one (the
 * promoted catalog is deployment-scoped, see maybePromoteEphemeral). An empty catalog refuses
 * nothing, the rule delegate_to_agent applies to the names it is given.
 */
export function isKnownAgentName(agentName: string): boolean {
  const config = getConfig();
  const known = Object.keys(withPromotedAgents(config.subAgents, config.workspacePath));
  return known.length === 0 || known.includes(agentName);
}

/**
 * Whether a requested tool call is the delegation to the named agent: delegate_to_agent naming it,
 * or the agent's own name called as a tool, which the loop rewrites to delegate_to_agent before it
 * runs.
 */
export function isDelegationToAgent(
  call: { name: string; arguments?: Record<string, unknown> | null },
  agentName: string,
): boolean {
  if (call.name === agentName) return true;
  const requested = call.arguments?.["agentName"];
  return call.name === "delegate_to_agent" && typeof requested === "string" && requested.trim() === agentName;
}

/**
 * Whether a delegation's result shows that the named agent ran: the agent its result is from, or
 * one of the agents it attempted, since a run that failed still ran. Read from the RESULT because
 * the request proves nothing: a call with unparseable arguments, one naming an agent outside the
 * turn's grant, or one a lease, budget or capacity check turned away names no agent here. Only the
 * delegation tools' own results are read: an infrastructure tool merges a remote endpoint's
 * metadata into its result (turn-tool-contribution.ts), and a name there proves nothing.
 *
 * A task graph's result names no agent of its own. Unread, a graph that had run the agent left the
 * turn directed to it, and the model's answer was replaced by a second run of the same agent
 * (review of 6955e34, 2026-10-08). It reports, for each node it ran, the agents that node's own
 * result named (nodeRuns), and that is what is read. The swarm state it also reports is not: the
 * turn's swarm state is seeded with the previous turn's tasks, attempts included, and a node whose
 * id repeated one of them was turned away before any agent ran and still showed that task's
 * attempt (review of faeee22, 2026-10-08).
 */
export function delegationRanAgent(
  toolName: string,
  metadata: Record<string, unknown> | undefined,
  agentName: string,
): boolean {
  if (toolName === "run_task_graph") return taskGraphNodeRanAgent(metadata, agentName);
  if (toolName !== "delegate_to_agent" && toolName !== "swarm_delegate") return false;
  return resultNamesAgent(metadata, agentName);
}

/**
 * Whether a call a tool made on the turn's behalf ran the agent: a plan step's or a fan-out slice's
 * delegation, read from the agents its own result named, which the reporter stamps on the call. The
 * turn's grant does not say it. A step or a slice that names no agent is routed within the grant,
 * and when routing finds no match the architect fallback, which no grant binds, answers it with an
 * ephemeral agent; counted as the named agent's, that answer released the directive and the named
 * agent never ran (review of 6955e34, 2026-10-08).
 */
export function nestedCallRanAgent(call: NestedToolCall, agentName: string): boolean {
  return delegationRanAgent(call.tool, { agentName: call.agentName, attemptedAgents: call.attemptedAgents }, agentName);
}

function resultNamesAgent(result: Record<string, unknown> | undefined, agentName: string): boolean {
  if (result?.["agentName"] === agentName) return true;
  const attempted = result?.["attemptedAgents"];
  return Array.isArray(attempted) && attempted.includes(agentName);
}

/**
 * Whether a node the graph ran named the agent. Each node the graph started has its entry once it
 * finished, completed or failed, with the agents its result named; a node turned away before any
 * agent ran named none, and a blocked node or one served from the durable ledger never started.
 */
function taskGraphNodeRanAgent(metadata: Record<string, unknown> | undefined, agentName: string): boolean {
  const nodeRuns = metadata?.["nodeRuns"];
  if (nodeRuns === null || typeof nodeRuns !== "object") return false;
  return Object.values(nodeRuns).some((run) => (
    run !== null && typeof run === "object" && resultNamesAgent(run as Record<string, unknown>, agentName)
  ));
}

const DOCUMENT_CONTEXT_PREFIX = "[DOCUMENT CONTEXT]";
/** Bounds for the exchange before this request, on the scale the research-subject fold uses. */
const PRIOR_REQUEST_MAX_CHARS = 600;
const PRIOR_ANSWER_MAX_CHARS = 1_500;

function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/** What the runtime's own delegation to the named agent hands the agent besides the request. */
export interface DirectiveDelegationContext {
  /** The exchange before this request: the call's `context` argument, recorded with the call. */
  context?: string;
  /**
   * This turn's [DOCUMENT CONTEXT] excerpts, handed to the agent beside the call and never put in
   * its arguments (ToolContext.delegationDocuments). The arguments are kept, in the session history
   * and the audit, while the note the excerpts come from is pruned at the next turn so that a
   * document does not outlive the turn it was attached to. Put in the arguments, a CSV's rows were
   * still in the history and the audit after the next turn (review of bf095a1, 2026-10-08).
   */
  documents?: string;
}

/**
 * What the runtime's own delegation to the named agent carries: what the orchestrator had in view
 * that the bare request lacks. A specialist starts from its task and context alone. The excerpts of
 * a file attached this turn reach the turn only as the orchestrator's [DOCUMENT CONTEXT] message,
 * and the upload is never handed to the model, so the agent asked for a CSV's total got no rows. A
 * follow-up ("and how do I fix it?") names its subject only in the exchange before it, which goes
 * along whenever there is one: whether a message refers back cannot be read from its words in
 * every language. Each part is absent when there is nothing for it.
 */
export function buildDirectiveDelegationContext(
  history: readonly { role: string; content?: unknown; metadata?: Record<string, unknown> | undefined }[],
  prior: { priorUserRequest?: string | undefined; priorAssistantAnswer?: string | undefined },
): DirectiveDelegationContext {
  const documents = history
    .slice(currentTurnStartIndex(history) + 1)
    .flatMap((message) => (
      message.role === "system" && typeof message.content === "string" && message.content.startsWith(DOCUMENT_CONTEXT_PREFIX)
        ? [message.content.trim()]
        : []
    ));
  const request = prior.priorUserRequest?.trim();
  const answer = prior.priorAssistantAnswer?.trim();
  const earlier = [
    ...(request ? [`Request: ${clip(request, PRIOR_REQUEST_MAX_CHARS)}`] : []),
    ...(answer ? [`Answer: ${clip(answer, PRIOR_ANSWER_MAX_CHARS)}`] : []),
  ];
  return {
    ...(earlier.length > 0 ? { context: `[EARLIER IN THIS CONVERSATION — the exchange before this request]\n${earlier.join("\n\n")}` } : {}),
    ...(documents.length > 0 ? { documents: documents.join("\n\n") } : {}),
  };
}
