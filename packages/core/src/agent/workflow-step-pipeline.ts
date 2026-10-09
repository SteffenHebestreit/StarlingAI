/**
 * The agents a scene or job step's task names, in the order it names them, and what the step's turn
 * is told after one of them has returned.
 *
 * A step that is not run by one agent directly runs as an orchestrator turn of its own
 * (tools/workflow-catalog.ts, agent/scene-worker.ts), and that turn ended after its first delegation
 * that returned evidence: the runtime then requires synthesis ("Do NOT delegate again") unless a
 * recorded plan still has steps left, and a step's turn records none. In the E2E run of 2026-10-08,
 * source_grounded_paper_packet ran researcher and its fan-out to the rest of the scene's agents was
 * rejected, and verified_research_brief wrote the brief itself after researcher. Neither reached the
 * agents the scene's author had named, in order, in the task.
 *
 * The pipeline is handed to the step's turn rather than recorded as its plan. A recorded plan is read
 * by execute_plan, which runs every step of it, and a scene's task names agents it calls for only
 * conditionally: document_intake "first when the request starts from attached material", "quality_supervisor
 * or qa_guard", a cover letter content_writer writes only if the user asks. Which of those apply is the
 * orchestrator's to read from the task. The pipeline gives the order and keeps the turn open while
 * named agents are left.
 */
import { getConfig } from "../config/loader.js";

/**
 * Tools that run several agents, or a workflow, from one call. An agent with one coordinates the agents
 * the task names after it, inside its own run: deep_research is "Run mission_coordinator. Phase 1 -
 * researcher …, Phase 2 - evidence_analyst …". A single delegate_to_agent does not count: summarizer and
 * paper_author carry it to fetch missing evidence, not to run the scene.
 */
const FAN_OUT_TOOL_NAMES = new Set(["parallel_delegate", "run_task_graph", "run_workflow", "swarm_delegate"]);

/**
 * The discovery tools a step's turn goes without once its task names its agents. The scene's author
 * has picked them, so there is nothing to look for, and a search proposes agents the scene does not
 * allow: verified_research_brief spent six of its eight model calls on search_agents and search_skills,
 * then delegated to browser_agent and was refused it (E2E 2026-10-08). list_agents is the same
 * discovery as search_agents, and the runtime withholds the two together after a no-match.
 */
export const WORKFLOW_STEP_DISCOVERY_TOOL_NAMES: ReadonlySet<string> = new Set(["search_agents", "list_agents", "search_skills"]);

const isIdentifierChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

/** Where `task` first names `agent` as a whole identifier, or -1. "researchers" does not name researcher. */
export function firstMentionOfAgent(task: string, agent: string): number {
  if (!agent) return -1;
  for (let at = task.indexOf(agent); at !== -1; at = task.indexOf(agent, at + 1)) {
    if (!isIdentifierChar(task[at - 1]) && !isIdentifierChar(task[at + agent.length])) return at;
  }
  return -1;
}

/**
 * The configured agents of `allowedAgents` that `authorTask` names, in the order it first names them,
 * up to and including the first that coordinates (FAN_OUT_TOOL_NAMES). Empty when the task names none.
 *
 * `authorTask` is the scene's task as its author wrote it, before any parameter is filled in: a
 * placeholder can carry the caller's own words, and "{{request}}" filled with "a report on researcher
 * salaries" would otherwise put researcher at the head of reviewed_deliverable's pipeline.
 */
export function workflowStepPipeline(authorTask: string | undefined, allowedAgents: readonly string[] | undefined): string[] {
  if (!authorTask?.trim() || !allowedAgents?.length) return [];
  const task = authorTask.replace(/\{\{[^}]*\}\}/g, " ");
  const subAgents = getConfig().subAgents ?? {};
  const named = [...new Set(allowedAgents)]
    .filter((agent) => Boolean(subAgents[agent]))
    .map((agent) => ({ agent, at: firstMentionOfAgent(task, agent) }))
    .filter((mention) => mention.at !== -1)
    .sort((a, b) => a.at - b.at)
    .map((mention) => mention.agent);
  const coordinatorAt = named.findIndex((agent) => (subAgents[agent]?.tools ?? []).some((tool) => FAN_OUT_TOOL_NAMES.has(tool)));
  return coordinatorAt === -1 ? named : named.slice(0, coordinatorAt + 1);
}

export interface WorkflowStepContinuationInput {
  /** The step's pipeline (workflowStepPipeline). */
  pipeline: readonly string[];
  /** The pipeline agents whose delegations returned this turn. */
  returned: ReadonlySet<string>;
  /** Delegations and workflows run so far this turn, as the plan continuation counts them. */
  executedDelegations: number;
  /** The per-turn delegate cap: never continue past it. */
  delegationCap: number;
  /** False when a run of this round masked figures: nothing is built on it. */
  lastDelegationSucceeded: boolean;
}

/**
 * The pipeline agents named after the furthest one that has returned, or none when the turn should not
 * go on. An agent before that one which did not run is one the turn passed over, as a step whose
 * condition did not hold is passed over (document_intake with nothing attached), and it is not offered
 * again. Each continuation ends in another delegation, which the cap bounds, or in the final answer.
 */
export function remainingWorkflowStepAgents(input: WorkflowStepContinuationInput): string[] {
  if (input.pipeline.length === 0 || !input.lastDelegationSucceeded) return [];
  if (input.executedDelegations >= input.delegationCap) return [];
  let furthest = -1;
  input.pipeline.forEach((agent, index) => {
    if (input.returned.has(agent)) furthest = index;
  });
  return input.pipeline.slice(furthest + 1);
}

/** The directive the step's turn gets instead of the synthesis requirement while named agents are left. */
export function renderWorkflowStepContinuationDirective(remaining: readonly string[]): string {
  return `[CONTINUE PLAN] The step's task names agents that have not run yet this turn, in its order: ${remaining.join(", ")}. `
    + "Delegate to the next one the task calls for now. Skip one only where the task makes it conditional and the condition does not hold; "
    + "when the task calls for none of them, write the final answer.";
}
