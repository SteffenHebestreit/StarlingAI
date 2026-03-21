/**
 * Long-Running Bidder Worker — fully independent autonomous bidding process.
 *
 * Instead of relying solely on the in-process `startAutonomousBidding()` that
 * runs inside the gateway, this module provides a standalone bidder lifecycle
 * that can run as a separate process.
 *
 * Architecture:
 *   1. Connects directly to the Redis swarm bus (requires REDIS_URL).
 *   2. Maintains a local snapshot of the agent catalog (loaded from config,
 *      refreshed on config changes).
 *   3. Listens for `task_announced` events with `dispatchMode: "autonomous_bidding"`.
 *   4. Scores announced tasks against its local catalog and emits `task_bid`
 *      events back to the bus.
 *   5. Multiple bidder workers can run across different machines — bid
 *      deduplication at the collector level prevents double-claims.
 *
 * State:
 *   - Stateless between bid rounds (no in-flight task state).
 *   - Periodic catalog refresh keeps the agent index current.
 *   - Graceful shutdown via SIGINT/SIGTERM.
 *
 * Usage (as standalone):
 *   SAI_CONFIG_PATH=./starlingai.json REDIS_URL=redis://... node bidder-worker.js
 *
 * Usage (in-process, for testing or single-instance deployments):
 *   import { startBidderWorker, stopBidderWorker } from "./bidder-worker.js";
 *   await startBidderWorker();
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { childLogger } from "../logger.js";
import { emitSwarmEvent, onSwarmEvent, isSwarmBusConnected, type SwarmEvent } from "./bus.js";
import type { SubAgentConfig } from "../config/schema.js";

const log = childLogger("swarm:bidder-worker");

// ── Worker identity ──────────────────────────────────────────────────────────

const WORKER_ID = randomUUID();
const MAX_BIDS_PER_ANNOUNCEMENT = 3;

// ── Agent catalog snapshot (refreshed periodically) ──────────────────────────

interface AgentIndexEntry {
  name: string;
  config: SubAgentConfig;
  /** Pre-computed lowercase keyword set for fast matching. */
  keywords: Set<string>;
}

let _agentIndex: AgentIndexEntry[] = [];
let _catalogRefreshInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Build keyword set from agent metadata for fast task matching.
 */
function buildKeywords(name: string, cfg: SubAgentConfig): Set<string> {
  const words = new Set<string>();
  // Agent name tokens
  for (const token of name.split(/[_\-\s]+/)) {
    if (token.length >= 2) words.add(token.toLowerCase());
  }
  // Description tokens
  for (const token of (cfg.description ?? "").split(/\W+/)) {
    if (token.length >= 3) words.add(token.toLowerCase());
  }
  // Domain
  if (cfg.domain) words.add(cfg.domain.toLowerCase());
  // Capabilities
  for (const cap of cfg.capabilities ?? []) {
    for (const token of cap.split(/\W+/)) {
      if (token.length >= 3) words.add(token.toLowerCase());
    }
  }
  // Tags
  for (const tag of cfg.tags ?? []) {
    words.add(tag.toLowerCase());
  }
  return words;
}

/**
 * Refresh the local agent index from config.
 * Safe to call repeatedly — replaces the index atomically.
 */
export function refreshAgentIndex(
  subAgents: Record<string, SubAgentConfig>,
  promotedAgents?: Record<string, SubAgentConfig>,
): void {
  const entries: AgentIndexEntry[] = [];

  for (const [name, cfg] of Object.entries(subAgents)) {
    entries.push({ name, config: cfg, keywords: buildKeywords(name, cfg) });
  }

  // Merge promoted agents that aren't in the permanent config
  if (promotedAgents) {
    for (const [name, cfg] of Object.entries(promotedAgents)) {
      if (!subAgents[name]) {
        entries.push({ name, config: cfg, keywords: buildKeywords(name, cfg) });
      }
    }
  }

  _agentIndex = entries;
  log.info({ agentCount: entries.length }, "Agent index refreshed");
}

// ── Scoring ──────────────────────────────────────────────────────────────────

interface BidCandidate {
  name: string;
  score: number;
  matchedTerms: string[];
  confidence: "high" | "medium" | "low";
}

function confidenceLabel(score: number): "high" | "medium" | "low" {
  if (score >= 0.72) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

/**
 * Score a task query against the local agent index.
 * Returns up to MAX_BIDS_PER_ANNOUNCEMENT top candidates.
 */
function scoreTaskAgainstIndex(
  query: string,
  allowedAgents?: string[],
  excludeAgents?: Set<string>,
): BidCandidate[] {
  const queryTokens = query.toLowerCase().split(/\W+/).filter(t => t.length >= 2);
  if (queryTokens.length === 0) return [];

  const querySet = new Set(queryTokens);
  const candidates: BidCandidate[] = [];

  for (const entry of _agentIndex) {
    if (allowedAgents && allowedAgents.length > 0 && !allowedAgents.includes(entry.name)) continue;
    if (excludeAgents?.has(entry.name)) continue;

    const matchedTerms: string[] = [];
    let matchScore = 0;

    for (const token of querySet) {
      if (entry.keywords.has(token)) {
        matchedTerms.push(token);
        matchScore += 1;
      }
      // Partial prefix match (e.g. "code" matches "coding")
      for (const kw of entry.keywords) {
        if (kw.startsWith(token) && kw !== token) {
          matchedTerms.push(kw);
          matchScore += 0.5;
        }
      }
    }

    if (matchScore === 0) continue;

    // Normalize score: matched terms / total query terms, capped at 1
    const normalizedScore = Math.min(1, matchScore / queryTokens.length);

    candidates.push({
      name: entry.name,
      score: Number(normalizedScore.toFixed(4)),
      matchedTerms: [...new Set(matchedTerms)],
      confidence: confidenceLabel(normalizedScore),
    });
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_BIDS_PER_ANNOUNCEMENT);
}

// ── Event handling ───────────────────────────────────────────────────────────

/** Track recently handled announcements to avoid re-processing. */
const _handledAnnouncements = new Map<string, number>();
const HANDLED_TTL_MS = 5 * 60 * 1000;

function pruneHandledAnnouncements(): void {
  const cutoff = Date.now() - HANDLED_TTL_MS;
  for (const [id, ts] of _handledAnnouncements) {
    if (ts < cutoff) _handledAnnouncements.delete(id);
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item).trim()).filter(Boolean);
}

function handleTaskAnnounced(event: SwarmEvent): void {
  if (event.type !== "task_announced" || !event.taskId) return;
  if (event.data?.["dispatchMode"] !== "autonomous_bidding") return;
  if (_handledAnnouncements.has(event.id)) return;
  _handledAnnouncements.set(event.id, Date.now());

  const query = typeof event.data?.["routingQuery"] === "string"
    ? event.data["routingQuery"].trim()
    : String(event.task ?? "").trim();
  if (!query) return;

  const allowedAgents = normalizeStringArray(event.data?.["allowedAgents"]);
  const excludeAgents = new Set(normalizeStringArray(event.data?.["excludeAgents"]));

  const candidates = scoreTaskAgainstIndex(
    query,
    allowedAgents.length > 0 ? allowedAgents : undefined,
    excludeAgents,
  );

  for (const candidate of candidates) {
    emitSwarmEvent("task_bid", {
      sessionId: event.sessionId,
      taskId: event.taskId,
      task: event.task,
      agentName: candidate.name,
      data: {
        dispatchMode: "autonomous_bidding",
        score: candidate.score,
        confidence: candidate.confidence,
        matchedTerms: candidate.matchedTerms,
        bidderInstance: WORKER_ID,
        bidderType: "long_running_worker",
      },
    });
  }

  if (candidates.length > 0) {
    log.debug(
      { taskId: event.taskId, bids: candidates.length, topAgent: candidates[0]!.name },
      "Emitted bids for announced task",
    );
  }
}

function handleSwarmEvent(event: SwarmEvent): void {
  if (event.type === "task_announced") {
    handleTaskAnnounced(event);
    return;
  }
  // Clean up tracking for completed/requeued tasks
  if (event.taskId && (event.type === "task_completed" || event.type === "task_requeued")) {
    _handledAnnouncements.delete(event.id);
  }
}

// ── Worker lifecycle ─────────────────────────────────────────────────────────

let _unsubscribe: (() => void) | null = null;
let _pruneInterval: ReturnType<typeof setInterval> | null = null;
let _started = false;

const _emitter = new EventEmitter();

/** Emitted when the bidder worker starts. */
export function onBidderReady(handler: () => void): () => void {
  _emitter.on("ready", handler);
  return () => _emitter.off("ready", handler);
}

/**
 * Start the long-running bidder worker.
 *
 * @param agentCatalog  Initial agent catalog to index. If omitted, loads from
 *                      the config system (requires loadConfig() to have run).
 * @param promotedAgents  Optional promoted agents to merge into the index.
 */
export async function startBidderWorker(
  agentCatalog?: Record<string, SubAgentConfig>,
  promotedAgents?: Record<string, SubAgentConfig>,
): Promise<void> {
  if (_started) return;
  _started = true;

  // Build initial agent index
  if (agentCatalog) {
    refreshAgentIndex(agentCatalog, promotedAgents);
  } else {
    try {
      const { getConfig } = await import("../config/loader.js");
      const { readPromotedAgents } = await import("../agent/promoted-agents.js");
      const config = getConfig();
      refreshAgentIndex(config.subAgents, readPromotedAgents(config.workspacePath));
    } catch (err) {
      log.warn({ err }, "Failed to load agent catalog from config — bidder running with empty index");
    }
  }

  // Subscribe to swarm bus events
  _unsubscribe = onSwarmEvent(handleSwarmEvent);

  // Periodic announcement dedup cleanup
  _pruneInterval = setInterval(pruneHandledAnnouncements, 60_000);
  _pruneInterval.unref();

  // Periodic catalog refresh (every 5 minutes)
  _catalogRefreshInterval = setInterval(async () => {
    try {
      const { getConfig } = await import("../config/loader.js");
      const { readPromotedAgents } = await import("../agent/promoted-agents.js");
      const config = getConfig();
      refreshAgentIndex(config.subAgents, readPromotedAgents(config.workspacePath));
    } catch (err) {
      log.debug({ err }, "Catalog refresh skipped (config not available)");
    }
  }, 5 * 60 * 1000);
  _catalogRefreshInterval.unref();

  const mode = isSwarmBusConnected() ? "Redis" : "in-process";
  log.info({ workerId: WORKER_ID, mode, agents: _agentIndex.length }, "Bidder worker started");
  _emitter.emit("ready");
}

/**
 * Stop the long-running bidder worker and release all resources.
 */
export function stopBidderWorker(): void {
  if (!_started) return;
  _started = false;

  _unsubscribe?.();
  _unsubscribe = null;

  if (_pruneInterval) {
    clearInterval(_pruneInterval);
    _pruneInterval = null;
  }
  if (_catalogRefreshInterval) {
    clearInterval(_catalogRefreshInterval);
    _catalogRefreshInterval = null;
  }

  _handledAnnouncements.clear();
  _agentIndex = [];

  log.info({ workerId: WORKER_ID }, "Bidder worker stopped");
}

export function isBidderWorkerRunning(): boolean {
  return _started;
}

export function getBidderWorkerStatus(): {
  running: boolean;
  workerId: string;
  agentCount: number;
  mode: string;
} {
  return {
    running: _started,
    workerId: WORKER_ID,
    agentCount: _agentIndex.length,
    mode: isSwarmBusConnected() ? "redis" : "in-process",
  };
}

export function resetBidderWorkerForTests(): void {
  stopBidderWorker();
}
