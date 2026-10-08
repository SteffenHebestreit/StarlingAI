/**
 * The agent the user directed a turn to (`--agent NAME`, RunTurnOptions.directiveAgent).
 *
 * Until that agent has run, the turn delegates to it: the tool call is forced, a line names the
 * agent, and a response that calls no tool is replaced by the delegation itself (runtime.ts). Three
 * questions that loop asks are answered here: did a call run the agent, which requested calls are
 * the delegation to it, and what the runtime's own delegation hands the agent besides the request.
 */
import { currentTurnStartIndex } from "./turn-boundary.js";

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
 * turn's grant, or one a lease, budget or capacity check turned away names no agent here.
 */
export function delegationRanAgent(
  toolName: string,
  metadata: Record<string, unknown> | undefined,
  agentName: string,
): boolean {
  if (toolName !== "delegate_to_agent" && toolName !== "swarm_delegate") return false;
  if (metadata?.["agentName"] === agentName) return true;
  const attempted = metadata?.["attemptedAgents"];
  return Array.isArray(attempted) && attempted.includes(agentName);
}

const DOCUMENT_CONTEXT_PREFIX = "[DOCUMENT CONTEXT]";
/** Bounds for the exchange before this request, on the scale the research-subject fold uses. */
const PRIOR_REQUEST_MAX_CHARS = 600;
const PRIOR_ANSWER_MAX_CHARS = 1_500;

function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/**
 * The context the runtime's own delegation to the named agent carries: what the orchestrator had
 * in view that the bare request lacks. A specialist starts from its task and context alone. The
 * excerpts of a file attached this turn reach the turn only as the orchestrator's
 * [DOCUMENT CONTEXT] message, and the upload is never handed to the model, so the agent asked for a
 * CSV's total got no rows. A follow-up ("and how do I fix it?") names its subject only in the
 * exchange before it, which goes along whenever there is one: whether a message refers back cannot
 * be read from its words in every language. Undefined when there is neither.
 */
export function buildDirectiveDelegationContext(
  history: readonly { role: string; content?: unknown; metadata?: Record<string, unknown> | undefined }[],
  prior: { priorUserRequest?: string | undefined; priorAssistantAnswer?: string | undefined },
): string | undefined {
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
  const parts = [
    ...documents,
    ...(earlier.length > 0 ? [`[EARLIER IN THIS CONVERSATION — the exchange before this request]\n${earlier.join("\n\n")}`] : []),
  ];
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
