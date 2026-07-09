import { randomUUID } from "node:crypto";
import { SpanKind } from "@opentelemetry/api";
import { childLogger } from "../logger.js";
import { emitSwarmEvent, onSwarmEvent, type SwarmEvent } from "./bus.js";
import { withLinkedSpan, spanLinkFromCarrier } from "../observability/tracing.js";

const log = childLogger("swarm:bidding");
const INSTANCE_ID = randomUUID();

export const DEFAULT_AUTONOMOUS_BID_WINDOW_MS = 125;
const MAX_BIDS_PER_TASK = 3;

export interface AutonomousTaskBid {
  taskId: string;
  agentName: string;
  score: number;
  confidence: "high" | "medium" | "low";
  matchedTerms: string[];
  bidderInstance: string;
  ts: string;
}

let _unsubscribe: (() => void) | null = null;
const _handledAnnouncementIds = new Map<string, number>(); // id → timestamp
const _handledBidIds = new Map<string, number>();           // id → timestamp
const _bidsByTask = new Map<string, Map<string, AutonomousTaskBid>>();

// Maximum age for dedup entries before eviction (10 minutes)
const DEDUP_TTL_MS = 10 * 60 * 1000;
// Maximum entries before forced pruning
const DEDUP_MAX_ENTRIES = 5000;
let _pruneInterval: ReturnType<typeof setInterval> | null = null;

/** Prune stale dedup entries to prevent unbounded memory growth. */
function pruneDedup(): void {
  const now = Date.now();
  const cutoff = now - DEDUP_TTL_MS;

  for (const [id, ts] of _handledAnnouncementIds) {
    if (ts < cutoff) _handledAnnouncementIds.delete(id);
  }
  for (const [id, ts] of _handledBidIds) {
    if (ts < cutoff) _handledBidIds.delete(id);
  }

  // Force prune if still too large (keep newest entries)
  if (_handledAnnouncementIds.size > DEDUP_MAX_ENTRIES) {
    const sorted = [..._handledAnnouncementIds.entries()].sort((a, b) => b[1] - a[1]);
    _handledAnnouncementIds.clear();
    for (const [id, ts] of sorted.slice(0, DEDUP_MAX_ENTRIES / 2)) {
      _handledAnnouncementIds.set(id, ts);
    }
  }
  if (_handledBidIds.size > DEDUP_MAX_ENTRIES) {
    const sorted = [..._handledBidIds.entries()].sort((a, b) => b[1] - a[1]);
    _handledBidIds.clear();
    for (const [id, ts] of sorted.slice(0, DEDUP_MAX_ENTRIES / 2)) {
      _handledBidIds.set(id, ts);
    }
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item).trim())
    .filter(Boolean);
}

function rememberBid(event: SwarmEvent): void {
  if (event.type !== "task_bid" || !event.taskId || !event.agentName) return;
  if (_handledBidIds.has(event.id)) return;
  _handledBidIds.set(event.id, Date.now());

  if (event.data?.["dispatchMode"] !== "autonomous_bidding") return;

  const score = typeof event.data?.["score"] === "number"
    ? event.data["score"] as number
    : Number(event.data?.["score"] ?? 0);
  const confidence = event.data?.["confidence"];
  if (!Number.isFinite(score) || (confidence !== "high" && confidence !== "medium" && confidence !== "low")) {
    return;
  }

  const bid: AutonomousTaskBid = {
    taskId: event.taskId,
    agentName: event.agentName,
    score,
    confidence,
    matchedTerms: normalizeStringArray(event.data?.["matchedTerms"]),
    bidderInstance: String(event.data?.["bidderInstance"] ?? "unknown"),
    ts: event.ts,
  };

  let bids = _bidsByTask.get(event.taskId);
  if (!bids) {
    bids = new Map<string, AutonomousTaskBid>();
    _bidsByTask.set(event.taskId, bids);
  }
  const existing = bids.get(bid.agentName);
  if (!existing || bid.score > existing.score || (bid.score === existing.score && bid.ts < existing.ts)) {
    bids.set(bid.agentName, bid);
  }
}

async function emitAutonomousBids(event: SwarmEvent): Promise<void> {
  if (event.type !== "task_announced" || !event.taskId) return;
  if (_handledAnnouncementIds.has(event.id)) return;
  _handledAnnouncementIds.set(event.id, Date.now());

  if (event.data?.["dispatchMode"] !== "autonomous_bidding") return;

  const query = typeof event.data?.["routingQuery"] === "string"
    ? event.data["routingQuery"].trim()
    : String(event.task ?? "").trim();
  if (!query) return;

  const allowedAgents = normalizeStringArray(event.data?.["allowedAgents"]);
  const excludedAgents = new Set(normalizeStringArray(event.data?.["excludeAgents"]));

  // Consume span LINKED to the announcing span (concurrent producer→consumer
  // across the bus, so a link — not parent/child — is the honest causal edge).
  // The task_bid events emitted inside inherit this span's context, carrying the
  // chain forward. No-op passthrough when tracing is disabled.
  await withLinkedSpan(
    "swarm.autonomous_bid",
    { "starlingai.swarm.task_id": event.taskId },
    [spanLinkFromCarrier(event.trace)],
    async () => {
      try {
        const { resolveAgentRouting } = await import("../tools/sub-agent.js");
        const resolution = await resolveAgentRouting(query, {
          minConfidence: "low",
          allowedAgents: allowedAgents.length > 0 ? allowedAgents : undefined,
        });

        const candidates = [...resolution.results, ...resolution.weakCandidates]
          .filter(candidate => !excludedAgents.has(candidate.name))
          .sort((left, right) => right.score - left.score)
          .slice(0, MAX_BIDS_PER_TASK);

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
              bidderInstance: INSTANCE_ID,
            },
          });
        }
      } catch (err) {
        log.debug({ err, taskId: event.taskId }, "Failed to emit autonomous bids");
      }
    },
    SpanKind.CONSUMER,
  );
}

async function handleEvent(event: SwarmEvent): Promise<void> {
  if (event.type === "task_announced") {
    await emitAutonomousBids(event);
    return;
  }
  if (event.type === "task_bid") {
    rememberBid(event);
    return;
  }
  if (event.taskId && (event.type === "task_completed" || event.type === "task_requeued")) {
    clearTaskBids(event.taskId);
  }
}

export function startAutonomousBidding(): void {
  if (_unsubscribe) return;
  if (!_pruneInterval) {
    _pruneInterval = setInterval(pruneDedup, 60_000);
    _pruneInterval.unref();
  }
  _unsubscribe = onSwarmEvent(event => {
    void handleEvent(event);
  });
}

export function stopAutonomousBidding(): void {
  _unsubscribe?.();
  _unsubscribe = null;
  _handledAnnouncementIds.clear();
  _handledBidIds.clear();
  _bidsByTask.clear();
  if (_pruneInterval) {
    clearInterval(_pruneInterval);
    _pruneInterval = null;
  }
}

export function isAutonomousBiddingStarted(): boolean {
  return _unsubscribe !== null;
}

export function clearTaskBids(taskId: string): void {
  _bidsByTask.delete(taskId);
}

export async function collectTaskBids(
  taskId: string,
  waitMs: number = DEFAULT_AUTONOMOUS_BID_WINDOW_MS,
): Promise<AutonomousTaskBid[]> {
  if (waitMs > 0) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, waitMs);
      timer.unref();
    });
  }

  return [...(_bidsByTask.get(taskId)?.values() ?? [])]
    .sort((left, right) => right.score - left.score || left.ts.localeCompare(right.ts));
}

export function resetAutonomousBiddingForTests(): void {
  stopAutonomousBidding();
}