/**
 * Parallel capability discovery prefetch (staged orchestration — S4).
 *
 * On an escalated turn (the receptionist fast-lane declined to answer it), the
 * coordinator normally spends one or more SLOW orchestrator tool rounds calling
 * `search_agents` / `search_workflows` to find out what specialists and reusable
 * workflows exist before it can plan. This module fires both discoveries
 * CONCURRENTLY up-front (one embedding round-trip, parallelised) and renders a
 * compact, droppable capsule the coordinator sees on its very first call — so it
 * can plan immediately instead of round-tripping through the slow model to discover.
 *
 * The capsule is a HEAD START, not a constraint (soft hint, never a hard gate — the
 * model may still search for something more specific). Gated by
 * orchestration.discoveryPrefetch (default off; pass^k before default-on) because it
 * adds an up-front embedding call + prompt tokens to every escalated turn, and only
 * pays off if it actually saves a slower discovery tool round.
 */

import { resolveAgentRouting } from "../tools/sub-agent.js";
import { agentIsMetaFactory, logRoutingEvaluated } from "../tools/agent-routing.js";
import { searchWorkflowCandidates } from "../tools/workflow-catalog.js";

function oneLine(text: string | undefined, max: number): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Render prefetched candidates into a compact capsule. Pure + deterministic so it is
 * unit-tested without a provider. Returns "" when there is nothing worth injecting.
 */
export function formatDiscoveryCapsule(
  agents: ReadonlyArray<{ name: string; description?: string; confidence?: string }>,
  workflows: ReadonlyArray<{ name: string; workflowType: string; description?: string }>,
): string {
  const lines: string[] = [];
  if (agents.length > 0) {
    lines.push("Specialist agents matched to this request (no need to call search_agents to re-discover these — delegate to one directly when it fits):");
    for (const a of agents) {
      const desc = oneLine(a.description, 120);
      lines.push(`- ${a.name}${a.confidence ? ` [${a.confidence}]` : ""}${desc ? ` — ${desc}` : ""}`);
    }
  }
  if (workflows.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Reusable workflow(s) whose purpose closely matches this request — consider run_workflow ONLY if the workflow's deliverable is actually what the user asked for; otherwise plan normally:");
    for (const w of workflows) {
      const desc = oneLine(w.description, 120);
      lines.push(`- ${w.name} (${w.workflowType})${desc ? ` — ${desc}` : ""}`);
    }
  }
  if (lines.length === 0) return "";
  return [
    "[CAPABILITY CANDIDATES — discovered up-front for this turn]",
    ...lines,
    "This is a head start, not a constraint: if none fit, plan normally — you may still search for something more specific.",
  ].join("\n");
}

/** An agent the capsule lists, with the confidence routing admitted it at. */
export interface DiscoveryCapsuleAgent {
  name: string;
  confidence?: string;
}

/**
 * Discover candidate agents + workflows for a query in parallel and format the
 * capsule. Best-effort: a failure in either discovery degrades to whatever the other
 * returned (and to "" if both fail), never throwing into the turn.
 */
export async function prefetchCapabilityCandidates(
  query: string,
  opts?: {
    allowedAgents?: string[];
    maxAgents?: number;
    maxWorkflows?: number;
    sessionId?: string;
    /**
     * The capsule's agent names, in the order the capsule lists them, once they are known (also
     * when there are none). The capsule itself is text; the intent readout's shadow needs the
     * candidate list the turn actually had (agent/intent-shadow.ts). The second argument is the
     * same list with each agent's routing confidence, for a caller that acts on how sure the
     * routing was (the runtime's --auto artifact build, agent/turn-setup.ts).
     */
    onAgents?: (names: readonly string[], agents: readonly DiscoveryCapsuleAgent[]) => void;
    /**
     * The turn has no catalog tools (a scene or job step, agent/runtime.ts). No workflow is looked
     * up or named: the capsule would point the turn at run_workflow, which it cannot call, and at
     * the workflow it is running, which its own task matches.
     */
    withoutWorkflows?: boolean;
  },
): Promise<string> {
  const q = query.trim();
  if (!q) return "";
  const maxAgents = Math.max(1, opts?.maxAgents ?? 4);
  const maxWorkflows = Math.max(1, opts?.maxWorkflows ?? 3);
  const startedAt = Date.now();

  const [agentRes, workflowRes] = await Promise.all([
    resolveAgentRouting(q, {
      minConfidence: "medium",
      allowKeywordFallback: false,
      ...(opts?.allowedAgents ? { allowedAgents: opts.allowedAgents } : {}),
    }).catch(() => null),
    // semanticOutlier: only surface a workflow when its embedding score is a clear
    // standout from the ~0.5 baseline — never steer the model into a deliverable-shape
    // workflow the request did not clearly call for (audit 7839e153). Pure semantic.
    opts?.withoutWorkflows
      ? Promise.resolve([])
      : searchWorkflowCandidates(q, { limit: maxWorkflows, semanticOutlier: true }).catch(() => []),
  ]);

  // Log the routing decision on EVERY prefetch, including the empty ones. The capsule is
  // only rendered when something matched, and `discovery_prefetch` only fires when the
  // capsule is non-empty, so the misses — which are also the slow ones (~2.5 s vs ~0.5 s
  // when something matched) — left no trace at all.
  if (agentRes) {
    logRoutingEvaluated({
      surface: "discovery_prefetch",
      query: q,
      resolution: agentRes,
      elapsedMs: Date.now() - startedAt,
      ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
      extra: {
        workflowCount: (workflowRes ?? []).length,
        workflowTop: workflowRes?.[0]?.name ?? null,
        workflowTopScore: workflowRes?.[0]?.semanticScore ?? null,
      },
    });
  }

  const agents = (agentRes?.results ?? [])
    // Drop meta/factory agents (agent_factory): UNDIRECTED routing/bidding never picks them, so
    // suggesting one in the capsule steers the coordinator toward a delegation it cannot make
    // (it would waste a cycle minting a bespoke agent). Mirrors the routing/bidding exclusion.
    .filter((candidate) => !agentIsMetaFactory(candidate.name))
    .slice(0, maxAgents)
    .map((candidate) => ({
      name: candidate.name,
      description: candidate.description,
      confidence: candidate.confidence,
    }));
  const workflows = (workflowRes ?? []).slice(0, maxWorkflows).map((workflow) => ({
    name: workflow.name,
    workflowType: workflow.workflowType,
    description: workflow.description,
  }));

  try {
    opts?.onAgents?.(
      agents.map((agent) => agent.name),
      agents.map((agent) => ({ name: agent.name, confidence: agent.confidence })),
    );
  } catch {
    // An observer's failure is never the capsule's.
  }
  return formatDiscoveryCapsule(agents, workflows);
}
