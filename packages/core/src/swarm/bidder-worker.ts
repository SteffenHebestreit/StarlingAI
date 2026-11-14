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
 *   4. Routes announced tasks with the product's own router (swarm/bidding.ts
 *      routeAnnouncedTask) and emits `task_bid` events back to the bus. In a
 *      process whose in-process bidder is running it stays silent: that bidder
 *      asks the same router, and the bids would be the same ones twice.
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
import { childLogger } from "../logger.js";
import { emitSwarmEvent, onSwarmEvent, isSwarmBusConnected, type SwarmEvent } from "./bus.js";
import { isAutonomousBiddingStarted, routeAnnouncedTask } from "./bidding.js";
import { announceAgentCapability } from "./capabilities.js";
import type { SubAgentConfig } from "../config/schema.js";

const log = childLogger("swarm:bidder-worker");

// ── Worker identity ──────────────────────────────────────────────────────────

const WORKER_ID = randomUUID();

// ── Agent catalog snapshot (refreshed periodically) ──────────────────────────
// What this worker announces to the capability registry and reports in its status. It is not
// what a task is scored against: that is the router's own catalog (routeAnnouncedTask).

interface AgentIndexEntry {
  name: string;
  config: SubAgentConfig;
}

let _agentIndex: AgentIndexEntry[] = [];
let _catalogRefreshInterval: ReturnType<typeof setInterval> | null = null;

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
    entries.push({ name, config: cfg });
  }

  // Merge promoted agents that aren't in the permanent config
  if (promotedAgents) {
    for (const [name, cfg] of Object.entries(promotedAgents)) {
      if (!subAgents[name]) {
        entries.push({ name, config: cfg });
      }
    }
  }

  _agentIndex = entries;
  for (const entry of entries) {
    announceAgentCapability({
      agentName: entry.name,
      domain: entry.config.domain,
      capabilities: entry.config.capabilities ?? [],
      tags: entry.config.tags ?? [],
      availability: "idle",
      source: "catalog_refresh",
    });
  }
  log.info({ agentCount: entries.length }, "Agent index refreshed");
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

/**
 * Bid on an announced task with the router's ranking.
 *
 * This worker used to score the task itself: every word fragment of two letters or more, counted
 * when it equalled or BEGAN a word of an agent's description. A German task's "ca", "am", "nach"
 * and "com" began "categorizes", "anhang", "nachrichten" and "composes", and a weather lookup was
 * bid for mail_agent at 0.17 (session 5b77edf9) — which then ran, behind the top bid's score. The
 * router ranks by meaning and holds every candidate to its floor; it is asked instead.
 */
async function handleTaskAnnounced(event: SwarmEvent): Promise<void> {
  if (event.type !== "task_announced" || !event.taskId) return;
  if (event.data?.["dispatchMode"] !== "autonomous_bidding") return;
  if (_handledAnnouncements.has(event.id)) return;
  _handledAnnouncements.set(event.id, Date.now());
  // This process's own bidder (swarm/bidding.ts) answers every announcement from the same router.
  if (isAutonomousBiddingStarted()) return;

  const query = typeof event.data?.["routingQuery"] === "string"
    ? event.data["routingQuery"].trim()
    : String(event.task ?? "").trim();
  if (!query) return;

  const allowedAgents = normalizeStringArray(event.data?.["allowedAgents"]);
  const excludeAgents = new Set(normalizeStringArray(event.data?.["excludeAgents"]));

  let candidates: Awaited<ReturnType<typeof routeAnnouncedTask>>;
  try {
    candidates = await routeAnnouncedTask(query, allowedAgents, excludeAgents);
  } catch (err) {
    log.debug({ err, taskId: event.taskId }, "Failed to route an announced task");
    return;
  }

  for (const candidate of candidates) {
    emitSwarmEvent("task_bid", {
      sessionId: event.sessionId,
      taskId: event.taskId,
      task: event.task,
      agentName: candidate.name,
      data: {
        dispatchMode: "autonomous_bidding",
        score: Number(candidate.score.toFixed(4)),
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
    void handleTaskAnnounced(event);
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
