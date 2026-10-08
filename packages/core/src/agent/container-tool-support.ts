/**
 * What the agent-worker container can actually run, and the honest failure a run
 * gets when it cannot.
 *
 * The worker entrypoint (agent/container-entrypoint.ts) imports tools/registry.js for
 * getToolsAsLLMDefs/executeTool, but a tool only enters that registry as the import SIDE
 * EFFECT of its own module (tools/register-builtins.ts and the per-family files). The
 * entrypoint imports none of them, so inside the worker the registry is EMPTY. An agent
 * that declares tools therefore reaches the worker with zero of them wired up: the model
 * is handed no tool definitions and can only answer in prose, which the orchestrator reads
 * as a completed run and which invites invented results ("I ran the query…"). It has been
 * this way since the first commit.
 *
 * Making those tools work inside the worker is a separate, deliberate decision (most of
 * them need the gateway: shared facts, the shell sandbox's Docker socket, service
 * credentials, the kali exec target — and the worker usually runs with `--network none`).
 * Until that decision is made, the only honest behaviour is to FAIL LOUD: refuse the run
 * and say plainly which declared tools the worker cannot run.
 *
 * Kept in its own module on purpose — the same reasoning as agent/container-failure.ts:
 * both the worker and agent/sub-agent.ts import this, and sub-agent.ts (and
 * container-runner.ts) are replaced wholesale by vi.mock factories in parts of the test
 * suite, so a symbol parked in either of them would have to be re-declared in every mock.
 */

/**
 * The tool names the agent-worker process registers in its own registry — TODAY: NONE,
 * because agent/container-entrypoint.ts imports no tool module. This is the static contract
 * the gateway predicts against before it spends a container start (see missingContainerTools).
 *
 * If the worker image is ever given tool modules to import, list exactly the tools those
 * imports register here, or the gateway's pre-flight will keep refusing runs the worker could
 * in fact serve. The worker's OWN check reads its live registry, so it stays truthful on its
 * own regardless; this constant only exists to let the gateway refuse statically.
 */
export const WORKER_REGISTERED_TOOL_NAMES: ReadonlySet<string> = new Set<string>();

/**
 * The declared tools that `registered` does not contain, in declaration order and de-duped.
 * `registered` is the worker's live registry when the worker calls this, and the static
 * WORKER_REGISTERED_TOOL_NAMES when the gateway calls it before spawning — the same check,
 * made in-process or statically.
 */
export function missingContainerTools(
  declaredTools: readonly string[] | undefined,
  registered: ReadonlySet<string>,
): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const tool of declaredTools ?? []) {
    if (registered.has(tool) || seen.has(tool)) continue;
    seen.add(tool);
    missing.push(tool);
  }
  return missing;
}

/** Cap on how many missing tool names the failure message spells out before "(+N more)". */
const MAX_NAMED_MISSING_TOOLS = 8;

/**
 * The failure a container run gets when the worker cannot run the agent's tools. It names the
 * missing tools (bounded) and states plainly that the worker answered NOTHING rather than
 * answering without them, so the gateway and the audit trail both see why the run failed
 * instead of a prose answer that silently had no tools behind it.
 */
export function formatMissingContainerToolsFailure(
  agentName: string,
  missingTools: readonly string[],
  declaredCount: number,
): string {
  const shown = missingTools.slice(0, MAX_NAMED_MISSING_TOOLS).join(", ");
  const extra = missingTools.length - MAX_NAMED_MISSING_TOOLS;
  const named = extra > 0 ? `${shown} (+${extra} more)` : shown;
  return (
    `The agent-worker container cannot run sub-agent '${agentName}': ${missingTools.length} of its ` +
    `${declaredCount} declared tool(s) are not registered in the worker process, so the model would be ` +
    `handed no tools and could only answer in prose. Unavailable in the worker: ${named}. ` +
    `The worker returned no answer rather than answering without these tools — run this agent in-process ` +
    `(set container.disabled: true), or ship a worker image that registers its tools.`
  );
}
