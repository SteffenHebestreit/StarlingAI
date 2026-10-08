/**
 * The agent the user directed a turn to (`--agent NAME`, RunTurnOptions.directiveAgent).
 *
 * Until that agent has run, the turn delegates to it: the tool call is forced, a line names the
 * agent, and a response that calls no tool is replaced by the delegation itself (runtime.ts). Two
 * questions that loop asks are answered here: did a call run the agent, and which requested calls
 * are the delegation to it.
 */

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
