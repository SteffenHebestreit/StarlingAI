/**
 * Who may run an agent that maintains the deployment: one with workspaceAccess "full".
 *
 * Such an agent works from the SHARED root with the whole workspace in view (agent/sub-agent.ts):
 * it writes agents/, scenes/ and jobs/, which changes the assistant for every account, and it can
 * read every account's root. Its write_file and edit_file ask for no approval per call, so any
 * caller who reached it held those powers, a viewer through A2A included. Every way of reaching an
 * agent (delegate_to_agent, --agent, run_workflow, both A2A routes, MCP agent__, and the turns of
 * queued jobs and scheduled runs) ends in runSubAgentWithStats, which asks {@link agentRunRefusal}
 * before any model call. The gateway asks it again for `--agent`, so that turn is refused before it
 * starts, and search_agents/list_agents leave out what it would refuse, so the orchestrator does not
 * plan with those agents.
 *
 * The order: every loaded extension's authorizeAgentRun hook first (a refusal there wins, whatever
 * the role), then, under multi-user auth, the role floor `agents.fullScopeMinRole`. The role is the
 * one the caller threads or its work carries. A run done for an account that carries none (a queued
 * job or a scheduled run, which a person started) answers to the role the store holds for that
 * account when it runs. A run with no known role (a channel, a cron or channel trigger, a federation
 * peer, an identity-provider account's queued run) passes the floor as before; a fork that wants to
 * refuse those does it in its hook.
 */
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { getExtensionAgentRunAuthorizers } from "../extension/index.js";
import { currentCallerRole, currentIdentity } from "../runtime/request-context.js";
import type { Identity } from "../runtime/accounts.js";
import type { SubAgentConfig } from "../config/schema.js";
import { withPromotedAgents } from "./promoted-agents.js";

const log = childLogger("agent:full-scope-floor");

/** Who a run is for: the caller's role when the surface that started it knows one, and its account. */
export interface AgentRunCaller {
  role?: string;
  identity?: Identity;
}

export interface AgentRunRequest extends AgentRunCaller {
  agentName: string;
  /** The config the run would use; undefined for a name with none (the run itself fails then). */
  agentConfig: { workspaceAccess?: string } | undefined;
}

export interface AgentRunRefusal {
  /** What the refused run returns and the audit records. */
  reason: string;
  /** "role_floor", or the name of the extension whose hook refused the run. */
  deniedBy: string;
  /** The role the run was judged as, when one is known: the caller's, or its account's (runRole). */
  role?: string;
}

/** The refusal text of the role floor, the same on every surface. */
export function fullScopeFloorMessage(agentName: string, floor: string): string {
  return `Agent ${agentName} maintains the deployment and needs role ${floor}`;
}

/**
 * The role and identity a run is for: the ones its caller passes, else the ones on the request
 * context (a turn puts its session's role there, a sub-agent run the role it was started with, and
 * the A2A and MCP surfaces the signed-in caller's).
 */
export function runCaller(explicit: AgentRunCaller = {}): AgentRunCaller {
  const role = explicit.role ?? currentCallerRole();
  const identity = explicit.identity ?? currentIdentity();
  return { ...(role ? { role } : {}), ...(identity ? { identity } : {}) };
}

/**
 * The role a run answers to: the one its caller threads or its work carries, else, under multi-user
 * auth, for a run done for an account, the role the store holds for that account now. That is how a
 * queued job or a scheduled run answers to the person who started it: no role travels with either.
 * Null when that account no longer signs in; undefined when no role is known (no account, or an
 * identity-provider account whose registry entry records no granted role: gateway/auth.ts
 * storedAccountRole).
 */
async function runRole(caller: AgentRunCaller): Promise<string | null | undefined> {
  if (caller.role !== undefined) return caller.role;
  if (!caller.identity?.account || getConfig().auth?.enabled !== true) return undefined;
  // Imported here, as the other role checks outside the gateway do: tools and agents stay out of
  // the gateway's module graph until a check needs it.
  const { storedAccountRole } = await import("../gateway/auth.js");
  return storedAccountRole(caller.identity);
}

/** The routable catalog: configured agents, and promoted ones a configured agent does not shadow. */
function routableAgents(): Record<string, SubAgentConfig> {
  const config = getConfig();
  return withPromotedAgents(config.subAgents, config.workspacePath);
}

/**
 * Why this run may not start, or undefined when it may. Extension hooks first, then the role floor
 * for a full-scope agent under multi-user auth, for a run whose role is known (runRole).
 */
export async function agentRunRefusal(run: AgentRunRequest): Promise<AgentRunRefusal | undefined> {
  const floorMayApply = run.agentConfig?.workspaceAccess === "full" && getConfig().auth?.enabled === true;
  if (!floorMayApply && getExtensionAgentRunAuthorizers().length === 0) return undefined;
  return refusalFor(run, await runRole(run));
}

/** {@link agentRunRefusal} for a run whose role is already resolved. */
async function refusalFor(run: AgentRunRequest, role: string | null | undefined): Promise<AgentRunRefusal | undefined> {
  const workspaceAccess = run.agentConfig?.workspaceAccess;
  const judgedAs = typeof role === "string" ? { role } : {};
  for (const { extension, authorize } of getExtensionAgentRunAuthorizers()) {
    let reason: string | undefined;
    try {
      reason = await authorize({
        agentName: run.agentName,
        agentConfig: workspaceAccess !== undefined ? { workspaceAccess } : {},
        ...judgedAs,
        // A copy: a hook reads who the run is for, it cannot change it.
        ...(run.identity ? { identity: { ...run.identity } } : {}),
      });
    } catch (err) {
      // A hook that cannot decide refuses: it exists to refuse what the core lets through.
      log.error({ err, extension, agentName: run.agentName }, "authorizeAgentRun threw; the agent run is refused");
      reason = `Agent ${run.agentName} cannot run: the ${extension} extension could not authorize the run`;
    }
    if (typeof reason === "string" && reason.trim()) return { reason, deniedBy: extension, ...judgedAs };
  }

  if (workspaceAccess !== "full" || role === undefined) return undefined;
  const config = getConfig();
  if (config.auth?.enabled !== true) return undefined;
  const floor = config.agents.fullScopeMinRole;
  const { roleRank } = await import("../gateway/auth.js");
  // An account that no longer signs in holds no role, and an unrecognized role ranks -1: both are
  // refused, as userHasRole refuses them.
  return role === null || roleRank(role) < roleRank(floor)
    ? { reason: fullScopeFloorMessage(run.agentName, floor), deniedBy: "role_floor", ...judgedAs }
    : undefined;
}

/** {@link agentRunRefusal} for an agent of the routable catalog, named as `--agent` names it. */
export async function catalogAgentRunRefusal(agentName: string, caller: AgentRunCaller): Promise<AgentRunRefusal | undefined> {
  return agentRunRefusal({ agentName, agentConfig: routableAgents()[agentName], ...caller });
}

/**
 * The agents of the routable catalog a run would refuse to this caller, for search_agents and
 * list_agents to leave out. Empty, without reading the catalog, when nothing could refuse: no
 * extension hook, and auth off or neither a role nor an account to read one for.
 */
export async function agentsRefusedToCaller(explicit: AgentRunCaller = {}): Promise<string[]> {
  const caller = runCaller(explicit);
  const floorMayApply = getConfig().auth?.enabled === true && (caller.role !== undefined || caller.identity?.account !== undefined);
  if (!floorMayApply && getExtensionAgentRunAuthorizers().length === 0) return [];
  const role = await runRole(caller);
  const refused: string[] = [];
  for (const [agentName, agentConfig] of Object.entries(routableAgents())) {
    if (await refusalFor({ agentName, agentConfig, ...caller }, role)) refused.push(agentName);
  }
  return refused;
}
