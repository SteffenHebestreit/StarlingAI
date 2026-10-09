/**
 * The order a sub-agent's tools are sent in — held once it has been ranked.
 *
 * THE ORDER IS PART OF THE CACHE KEY. A sub-agent's tool block renders right behind its system
 * prompt, so the provider's prefix cache reuses it only while it is byte-identical: the same tools
 * rotated measured 47.17 s to prefill against 0.43 s for the order the cache held
 * (sub-agent.ts, at the rerank). The rerank is keyed on the agent's role for exactly that reason —
 * but it is recomputed on every dispatch, and when its embedding call failed or stalled it fell back
 * to registration order: a different head, a cold prefill (8-14 s on the production stack) for an
 * agent whose tools had not changed, and the embedding wait itself sat before the run's first model
 * call (finding 2026-10-05).
 *
 * So the first FULL ranking per (agent, ranking key, tool set) is held for the process lifetime and
 * reused without asking the embedder again; until one exists, the rerank gets a short deadline and
 * the run falls back to the order it was given, while the ranking finishes in the background for the
 * next dispatch.
 */
import type { LLMToolDef } from "../providers/lmstudio.js";
import { rerankToolsForTask } from "../tools/registry.js";
import { childLogger } from "../logger.js";

const log = childLogger("agent:sub-agent-tool-order");

/**
 * How long a dispatch waits for a ranking it does not hold yet. The query embedding of one short
 * role statement plus cached tool embeddings is well under this on a healthy embedder; a stalled one
 * should cost a dispatch this much, not its whole wait.
 */
export const TOOL_RERANK_TIMEOUT_MS = 1_500;
/** Ephemeral agents are minted with fresh names, so the held orders are bounded. */
const HELD_ORDERS_MAX = 512;

const heldOrders = new Map<string, string[]>();

function orderKey(agentName: string, rankingKey: string, minTools: number, tools: readonly LLMToolDef[]): string {
  // The SET of tools, not their incoming order: the incoming order is registration order, which a
  // late-registering tool can shift without changing what the agent holds.
  return [agentName, rankingKey, String(minTools), tools.map((tool) => tool.name).sort().join(",")].join("\u0000");
}

function applyOrder(tools: readonly LLMToolDef[], names: readonly string[]): LLMToolDef[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const ordered = names.flatMap((name) => {
    const tool = byName.get(name);
    if (!tool) return [];
    byName.delete(name);
    return [tool];
  });
  // Nothing should be left (the key holds the set), but never drop a tool the agent was granted.
  return [...ordered, ...byName.values()];
}

/**
 * The tools in the order this agent's runs send them: the held ranking when there is one, else the
 * rerank if it answers within `timeoutMs`, else the order given. Never throws.
 */
export async function orderSubAgentTools(params: {
  agentName: string;
  /** What the order is ranked against — the agent's role statement, never the task. */
  rankingKey: string;
  tools: LLMToolDef[];
  minTools: number;
  timeoutMs?: number;
}): Promise<LLMToolDef[]> {
  const { agentName, rankingKey, tools, minTools } = params;
  const key = orderKey(agentName, rankingKey, minTools, tools);
  const held = heldOrders.get(key);
  if (held) return applyOrder(tools, held);

  const report: { ranked?: boolean } = {};
  const ranking = rerankToolsForTask(tools, rankingKey, minTools, report).then((ranked) => {
    // Only a full ranking is held: a fallback order would pin the failure for the process lifetime.
    if (report.ranked) {
      heldOrders.set(key, ranked.map((tool) => tool.name));
      while (heldOrders.size > HELD_ORDERS_MAX) {
        const oldest = heldOrders.keys().next().value;
        if (oldest === undefined) break;
        heldOrders.delete(oldest);
      }
    }
    return ranked;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      ranking.catch((err: unknown) => {
        log.debug({ err, agentName }, "Tool rerank failed — using the order given");
        return null;
      }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), params.timeoutMs ?? TOOL_RERANK_TIMEOUT_MS); }),
    ]);
    if (!result) log.debug({ agentName }, "Tool rerank did not answer in time — using the order given");
    return result ?? tools;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function _resetSubAgentToolOrdersForTests(): void {
  heldOrders.clear();
}
