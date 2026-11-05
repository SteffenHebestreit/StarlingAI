import { getConfig } from "../config/loader.js";

/**
 * Whether an agent coordinates others: its name ends in "_coordinator", or its catalog entry is
 * tagged "coordination". A coordinator delegates to specialists rather than doing their work, so
 * it is not delegated to by another coordinator (tools/sub-agent.ts) and is not named as "still
 * working" while one of its specialists is (agent/turn-progress.ts).
 */
export function agentNameIsCoordinator(name: string): boolean {
  if (!name) return false;
  if (name.endsWith("_coordinator")) return true;
  const cfg = getConfig().subAgents[name];
  return Boolean(cfg && (cfg.tags ?? []).includes("coordination"));
}
