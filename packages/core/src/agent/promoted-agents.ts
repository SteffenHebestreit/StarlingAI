/**
 * Promoted agent store — ephemeral agents that proved reliable enough to be
 * auto-promoted to the permanent catalog.
 *
 * Promoted agents are stored in .starlingai/promoted_agents.json alongside
 * the outcome log.  They are merged into routing at query time (not into the
 * hot-reloadable config) so they persist without touching starlingai.json.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { childLogger } from "../logger.js";
import type { SubAgentConfig } from "../config/schema.js";

import { PRODUCT } from "../product/index.js";

const log = childLogger("agent:promoted-agents");

const PROMOTED_FILE = `${PRODUCT.stateDirName}/promoted_agents.json`;

/** Minimum successful runs before an ephemeral agent is promoted to the catalog. */
export const PROMOTION_MIN_SUCCESSES = 3;

/** Minimum success rate (0–1) required for auto-promotion. */
export const PROMOTION_MIN_SUCCESS_RATE = 0.6;

export function readPromotedAgents(workspacePath: string): Record<string, SubAgentConfig> {
  const file = resolve(workspacePath, PROMOTED_FILE);
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    return typeof raw === "object" && raw !== null ? (raw as Record<string, SubAgentConfig>) : {};
  } catch {
    return {};
  }
}

/**
 * The catalog the semantic index should cover: the configured agents plus the promoted ones.
 * Promoted agents are merged into ROUTING at query time, but the embedding index was built from
 * config.subAgents alone — so a promoted agent could win keyword routing and still never appear
 * as a semantic candidate, and search_agents never surfaced it. A configured name wins a clash.
 */
export function withPromotedAgents(
  subAgents: Record<string, SubAgentConfig>,
  workspacePath: string,
): Record<string, SubAgentConfig> {
  return { ...readPromotedAgents(workspacePath), ...subAgents };
}

export function writePromotedAgents(workspacePath: string, agents: Record<string, SubAgentConfig>): void {
  const dir = resolve(workspacePath, PRODUCT.stateDirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(workspacePath, PROMOTED_FILE), JSON.stringify(agents, null, 2), "utf-8");
}

/**
 * Add an ephemeral agent to the promoted catalog.
 * No-op if it is already there.
 */
export function promoteEphemeralAgent(
  workspacePath: string,
  agentName: string,
  cfg: SubAgentConfig,
): void {
  const existing = readPromotedAgents(workspacePath);
  if (existing[agentName]) return;
  existing[agentName] = cfg;
  writePromotedAgents(workspacePath, existing);
  log.info({ agentName }, "Ephemeral agent auto-promoted to catalog");
}

/**
 * Remove a promoted agent from the catalog (for testing or operator cleanup).
 */
export function unpromoteAgent(workspacePath: string, agentName: string): void {
  const existing = readPromotedAgents(workspacePath);
  if (!existing[agentName]) return;
  delete existing[agentName];
  writePromotedAgents(workspacePath, existing);
}
