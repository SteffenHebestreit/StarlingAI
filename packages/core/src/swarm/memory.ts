/**
 * Collective Memory — session-scoped shared state for swarm sub-agents.
 *
 * Agents within the same parent session can publish "shared facts" that are
 * automatically injected as context into subsequent sub-agent invocations.
 * This eliminates redundant work: if agent A already resolved a hostname or
 * fetched an API response, agent B can read that result directly.
 *
 * Storage layout (Redis):
 *   starlingai:mem:{sessionId}:facts               — Hash   (key → value strings)
 *   starlingai:mem:{sessionId}:results             — List   (JSON entries, newest last)
 *   starlingai:msgs:{sessionId}:{recipient}        — Stream (direct messages, consumer group "consumers"; ADR-003)
 *   starlingai:msgs:{sessionId}:{recipient}:seen   — Set    (acked message ids — idempotent processing boundary)
 *   starlingai:msgs:{sessionId}:recipients         — Set    (recipients with a stream, for backlog observability)
 *   starlingai:msgs:dead:{sessionId}               — Stream (dead-lettered messages after the retry ceiling)
 *   starlingai:mem:{sessionId}:messages            — List   (LEGACY direct-message list; drained into streams on claim)
 *
 * Keys expire after SESSION_TTL_S (4 h). When Redis is absent, an in-process
 * Map provides the same API (including claim/ack/redelivery) with
 * process-lifetime scope.
 */
import { childLogger } from "../logger.js";
import type { LMStudioProvider } from "../providers/lmstudio.js";

const log = childLogger("swarm:memory");

const SESSION_TTL_S = 4 * 60 * 60; // 4 hours
const RESULTS_MAX = 50;             // cap stored partial results per session
const FACT_VALUE_MAX = 2000;        // chars — prevent bloat from large fact values
const RESULT_CONTENT_MAX = 1200;    // chars — injected into sub-agent context

// ── In-process fallback ──────────────────────────────────────────────────────

const _facts  = new Map<string, Map<string, string>>();
const _results = new Map<string, PartialResult[]>();
const _messages = new Map<string, AgentMessage[]>();
const _factEmbeddingCache = new Map<string, { signature: string; vectors: Array<{ key: string; value: string; vector: Float32Array }> }>();

const SEARCH_TOKEN_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "aktuell",
  "aktuelle",
  "collect",
  "current",
  "das",
  "dem",
  "den",
  "der",
  "die",
  "ein",
  "eine",
  "einem",
  "einen",
  "for",
  "find",
  "gather",
  "im",
  "in",
  "latest",
  "mit",
  "of",
  "on",
  "recent",
  "sammle",
  "search",
  "summarize",
  "the",
  "to",
  "und",
  "use",
  "vom",
  "von",
  "with",
  "zum",
  "zur",
  "zitierfahige",
  "zitierfaehige",
]);

const SEARCH_TOKEN_ALIASES: Record<string, string> = {
  cases: "case",
  docs: "documentation",
  implementierung: "implementation",
  implementierungen: "implementation",
  implementations: "implementation",
  papers: "paper",
  protokoll: "protocol",
  protokolle: "protocol",
  protocols: "protocol",
  quellen: "source",
  quelle: "source",
  repositories: "repository",
  sources: "source",
  spezifikation: "specification",
  spezifikationen: "specification",
  specifications: "specification",
  standards: "standard",
};

// ── Redis client (lazy, reuses REDIS_URL) ────────────────────────────────────

 
let _redis: any = null;
let _redisReady = false;

async function getRedis(): Promise<unknown | null> {
  if (_redisReady) return _redis;
  if (_redis !== null) return null;

  const url = process.env["REDIS_URL"];
  if (!url) return null;

  try {
     
    const ioredis = await import("ioredis") as any;
    const IORedis = ioredis.default ?? ioredis;
    _redis = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    await (_redis as { connect: () => Promise<void> }).connect();
    _redisReady = true;
    return _redis;
  } catch (err) {
    log.warn({ err }, "Shared memory Redis connection failed — using in-process fallback");
    _redis = null;
    return null;
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface PartialResult {
  taskId: string;
  agentName: string;
  content: string;
  ts: string;
}

export interface PartialResultMatch extends PartialResult {
  score: number;
}

export interface SharedFactMatch {
  key: string;
  value: string;
  score: number;
}

export interface AgentMessage {
  id: string;
  fromAgent: string;
  toAgent: string;
  content: string;
  ts: string;
}

export interface AgentMessageBacklogSnapshot {
  sessionId: string;
  pending: number;
  targets: Record<string, number>;
}

// ── Facts API ────────────────────────────────────────────────────────────────

const factsKey = (sid: string) => `starlingai:mem:${sid}:facts`;

// Per-turn tracking of which shared-fact keys were written during the CURRENT
// top-level user turn, keyed by root session id. Purely in-process and
// ephemeral — it scopes the delegation reuse short-circuit
// (findReusableSessionEvidence) to the active mission so a brand-new user
// query never gets served stale facts gathered for an EARLIER turn (audit
// 2f4f5fe6: a "Fable 5" query reused turn-2 news facts at 0.38–0.43 noise-level
// similarity and the researcher never ran). Fail-safe: if the set is empty, or
// a fact was written on another instance this turn, reuse simply does not fire
// and the agent re-researches — a latency cost, never a correctness bug.
const _factKeysThisTurn = new Map<string, Set<string>>();

/** Reset current-turn shared-fact key tracking. Call once at top-level turn start. */
export function beginFactTurn(sessionId: string): void {
  _factKeysThisTurn.delete(sessionId);
}

/** Shared-fact keys written during the current turn for this session. */
export function currentTurnFactKeys(sessionId: string): ReadonlySet<string> {
  return _factKeysThisTurn.get(sessionId) ?? new Set<string>();
}

function recordFactKeyThisTurn(sessionId: string, key: string): void {
  let set = _factKeysThisTurn.get(sessionId);
  if (!set) {
    set = new Set<string>();
    _factKeysThisTurn.set(sessionId, set);
  }
  set.add(key);
}

/**
 * Write a shared fact for the session.
 * key: short identifier, e.g. "resolved_hostname" or "user_email"
 * value: the fact value (truncated to FACT_VALUE_MAX chars)
 */
export async function writeSharedFact(sessionId: string, key: string, value: string): Promise<void> {
  const safeVal = value.slice(0, FACT_VALUE_MAX);
  recordFactKeyThisTurn(sessionId, key);
  _factEmbeddingCache.delete(sessionId);
  const redis = await getRedis();

  if (redis) {
    try {
      const k = factsKey(sessionId);
      await (redis as {
        hset: (k: string, field: string, val: string) => Promise<void>;
        expire: (k: string, ttl: number) => Promise<void>;
      }).hset(k, key, safeVal);
      await (redis as { expire: (k: string, ttl: number) => Promise<void> }).expire(k, SESSION_TTL_S);
      return;
    } catch (err) {
      log.warn({ err, key }, "writeSharedFact Redis failed — using in-process");
    }
  }

  const map = _facts.get(sessionId) ?? new Map<string, string>();
  map.set(key, safeVal);
  _facts.set(sessionId, map);
}

/**
 * Read a single shared fact. Returns null if not found.
 */
export async function readSharedFact(sessionId: string, key: string): Promise<string | null> {
  const redis = await getRedis();
  if (redis) {
    try {
      return await (redis as { hget: (k: string, f: string) => Promise<string | null> })
        .hget(factsKey(sessionId), key);
    } catch (err) {
      log.warn({ err, key }, "readSharedFact Redis failed — using in-process");
    }
  }
  return _facts.get(sessionId)?.get(key) ?? null;
}

/**
 * Read all shared facts for a session.
 */
export async function readAllFacts(sessionId: string): Promise<Record<string, string>> {
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await (redis as { hgetall: (k: string) => Promise<Record<string, string> | null> })
        .hgetall(factsKey(sessionId));
      return raw ?? {};
    } catch (err) {
      log.warn({ err }, "readAllFacts Redis failed — using in-process");
    }
  }
  return Object.fromEntries(_facts.get(sessionId) ?? new Map());
}

// ── Turn plan slot ───────────────────────────────────────────────────────────
// A reserved per-session slot holding the orchestrator's structured plan for the
// current turn (JSON). Kept OUT of the facts hash so the raw JSON never leaks
// into human-facing shared-facts context dumps; sub-agents and QA read it
// explicitly via readTurnPlan. Scoped to the root session id by the caller.
const PLAN_VALUE_MAX = 8000;        // chars — a plan is short; cap prevents bloat
const planKey = (sid: string) => `starlingai:mem:${sid}:turnplan`;
const _turnPlans = new Map<string, string>();

export async function writeTurnPlan(sessionId: string, planJson: string): Promise<void> {
  const safeVal = planJson.slice(0, PLAN_VALUE_MAX);
  const redis = await getRedis();
  if (redis) {
    try {
      await (redis as { set: (k: string, v: string) => Promise<void> }).set(planKey(sessionId), safeVal);
      await (redis as { expire: (k: string, ttl: number) => Promise<void> }).expire(planKey(sessionId), SESSION_TTL_S);
      return;
    } catch (err) {
      log.warn({ err }, "writeTurnPlan Redis failed — using in-process");
    }
  }
  _turnPlans.set(sessionId, safeVal);
}

export async function readTurnPlan(sessionId: string): Promise<string | null> {
  const redis = await getRedis();
  if (redis) {
    try {
      return await (redis as { get: (k: string) => Promise<string | null> }).get(planKey(sessionId));
    } catch (err) {
      log.warn({ err }, "readTurnPlan Redis failed — using in-process");
    }
  }
  return _turnPlans.get(sessionId) ?? null;
}

export async function clearTurnPlan(sessionId: string): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    try {
      await (redis as { del: (k: string) => Promise<void> }).del(planKey(sessionId));
      return;
    } catch (err) {
      log.warn({ err }, "clearTurnPlan Redis failed — using in-process");
    }
  }
  _turnPlans.delete(sessionId);
}

// ── Task-graph ledger slot ───────────────────────────────────────────────────
// A reserved per-session slot holding the durable task-graph ledger (JSON blob:
// node-key → completed-node entry), used by orchestration.durableTaskGraph so a
// re-issued graph can reuse nodes a prior (timed-out) turn already completed.
// Same shape as the turn-plan slot: kept OUT of the facts hash (never surfaces
// in shared-facts dumps), Redis with in-process fallback, session TTL. The
// entry/key semantics live in swarm/task-graph-ledger.ts — this is storage only.
// GRF-206: per-NODE hash storage. The previous single-JSON-blob slot was
// read-modify-write (concurrent processes lost each other's completions) and
// sliced at 64k chars — truncation made the WHOLE blob unparsable and the
// ledger read back empty. One hash field per node is atomic per completion,
// never truncated, and a malformed field only loses that field.
const graphLedgerKey = (sid: string) => `starlingai:mem:${sid}:graphledger`;      // legacy blob (drained)
const graphNodesKey = (sid: string) => `starlingai:mem:${sid}:graphnodes`;        // per-node hash
const _graphLedgers = new Map<string, string>();                                  // legacy local blob (drained)
const _graphNodes = new Map<string, Map<string, string>>();                       // local per-node

// ── GRF-206: durable task-graph DEFINITIONS (restart scheduler) ──────────────
// The per-node ledger above records COMPLETED work; a crash mid-graph loses the
// graph's SHAPE (which nodes exist, what depends on what), so nothing can even
// know a resume is owed. Definitions are written at dispatch, deleted on clean
// completion — a surviving "running" definition after a process death IS the
// crash evidence the boot-time scanner (swarm/graph-restart.ts) looks for.
const graphDefsKey = (sid: string) => `starlingai:mem:${sid}:graphdefs`;          // hash graphId → JSON
const GRAPHDEF_SESSIONS_KEY = "starlingai:graphdef-sessions";
const _localGraphDefs = new Map<string, Map<string, string>>();                   // local sid → graphId → JSON

export interface TaskGraphDefinitionRecord {
  graphId: string;
  sessionId: string;
  startedAt: string;
  objective?: string;
  nodes: Array<{ id: string; title?: string; task: string; dependsOn?: string[]; agentName?: string }>;
}

export async function writeTaskGraphDefinition(sessionId: string, def: TaskGraphDefinitionRecord): Promise<void> {
  // Bound the payload: node task text capped so a huge prompt can't bloat the record.
  const bounded: TaskGraphDefinitionRecord = {
    ...def,
    objective: def.objective?.slice(0, 500),
    nodes: def.nodes.map((n) => ({ ...n, task: n.task.slice(0, 2_000) })),
  };
  const json = JSON.stringify(bounded);
  const redis = await getRedis();
  if (redis) {
    try {
      const r = redis as { hset: (k: string, f: string, v: string) => Promise<unknown>; expire: (k: string, s: number) => Promise<unknown>; sadd: (k: string, m: string) => Promise<unknown> };
      await r.hset(graphDefsKey(sessionId), def.graphId, json);
      await r.expire(graphDefsKey(sessionId), SESSION_TTL_S);
      await r.sadd(GRAPHDEF_SESSIONS_KEY, sessionId);
      return;
    } catch { /* fall through to local */ }
  }
  let bySession = _localGraphDefs.get(sessionId);
  if (!bySession) { bySession = new Map(); _localGraphDefs.set(sessionId, bySession); }
  bySession.set(def.graphId, json);
}

/** Clean completion removes the definition — no definition, no resume owed. */
export async function deleteTaskGraphDefinition(sessionId: string, graphId: string): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    try {
      await (redis as { hdel: (k: string, f: string) => Promise<unknown> }).hdel(graphDefsKey(sessionId), graphId);
      return;
    } catch { /* fall through */ }
  }
  _localGraphDefs.get(sessionId)?.delete(graphId);
}

/** All definitions that still exist = graphs that never completed cleanly. */
export async function listInterruptedTaskGraphs(): Promise<TaskGraphDefinitionRecord[]> {
  const out: TaskGraphDefinitionRecord[] = [];
  const redis = await getRedis();
  if (redis) {
    try {
      const r = redis as { smembers: (k: string) => Promise<string[]>; hgetall: (k: string) => Promise<Record<string, string>>; srem: (k: string, m: string) => Promise<unknown> };
      const sessions = await r.smembers(GRAPHDEF_SESSIONS_KEY);
      for (const sid of sessions) {
        const defs = await r.hgetall(graphDefsKey(sid));
        const entries = Object.values(defs ?? {});
        if (entries.length === 0) {
          // Session's defs all completed or TTL-expired — drop the index entry.
          await r.srem(GRAPHDEF_SESSIONS_KEY, sid).catch?.(() => {});
          continue;
        }
        for (const json of entries) {
          try { out.push(JSON.parse(json) as TaskGraphDefinitionRecord); } catch { /* tolerate one bad record */ }
        }
      }
      return out;
    } catch { /* fall through to local */ }
  }
  for (const bySession of _localGraphDefs.values()) {
    for (const json of bySession.values()) {
      try { out.push(JSON.parse(json) as TaskGraphDefinitionRecord); } catch { /* tolerate */ }
    }
  }
  return out;
}

/** Sessions whose legacy blob was verified drained this process — skip the
 *  otherwise-per-call Redis GET. Only memoized after a SUCCESSFUL check. */
const _drainedGraphSessions = new Set<string>();

/** One-shot migration of the legacy blob into per-node fields (never truncates). */
async function drainLegacyGraphLedgerBlob(sessionId: string): Promise<void> {
  if (_drainedGraphSessions.has(sessionId)) return;
  const redis = await getRedis();
  let legacy: string | null = null;
  let checkFailed = false;
  if (redis) {
    try {
      legacy = await (redis as { get: (k: string) => Promise<string | null> }).get(graphLedgerKey(sessionId));
    } catch { checkFailed = true; }
  }
  legacy = legacy ?? _graphLedgers.get(sessionId) ?? null;
  if (!legacy) {
    if (!checkFailed) _drainedGraphSessions.add(sessionId);
    return;
  }
  try {
    const parsed: unknown = JSON.parse(legacy);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        await writeTaskGraphNode(sessionId, key, JSON.stringify(value), { skipLegacyDrain: true });
      }
    }
  } catch { /* a truncated legacy blob is exactly what this migration retires */ }
  _graphLedgers.delete(sessionId);
  if (redis) {
    try {
      await (redis as { del: (k: string) => Promise<number> }).del(graphLedgerKey(sessionId));
      _drainedGraphSessions.add(sessionId);
    } catch { /* re-check next call */ }
  } else {
    _drainedGraphSessions.add(sessionId);
  }
}

/**
 * Record one completed node atomically (HSETNX): a completed node is terminal,
 * so the first writer wins and concurrent processes can never lose each other's
 * completions. Values are NEVER truncated (entries are size-capped upstream).
 */
export async function writeTaskGraphNode(
  sessionId: string,
  nodeKey: string,
  entryJson: string,
  opts: { skipLegacyDrain?: boolean } = {},
): Promise<void> {
  if (!opts.skipLegacyDrain) await drainLegacyGraphLedgerBlob(sessionId);
  const redis = await getRedis();
  if (redis) {
    try {
      // One atomic script: a failure between HSETNX and EXPIRE would otherwise
      // leave an immortal key.
      await (redis as { eval: (...args: unknown[]) => Promise<unknown> }).eval(
        "redis.call('hsetnx', KEYS[1], ARGV[1], ARGV[2]) redis.call('expire', KEYS[1], ARGV[3]) return 1",
        1, graphNodesKey(sessionId), nodeKey, entryJson, String(SESSION_TTL_S),
      );
      return;
    } catch (err) {
      log.warn({ err }, "writeTaskGraphNode Redis failed — using in-process");
    }
  }
  const map = _graphNodes.get(sessionId) ?? new Map<string, string>();
  if (!map.has(nodeKey)) map.set(nodeKey, entryJson);
  _graphNodes.set(sessionId, map);
}

/** Read all completed-node records for a session (raw JSON per node key). */
export async function readTaskGraphNodes(sessionId: string): Promise<Record<string, string>> {
  await drainLegacyGraphLedgerBlob(sessionId);
  const redis = await getRedis();
  if (redis) {
    try {
      return await (redis as { hgetall: (k: string) => Promise<Record<string, string>> }).hgetall(graphNodesKey(sessionId)) ?? {};
    } catch (err) {
      log.warn({ err }, "readTaskGraphNodes Redis failed — using in-process");
    }
  }
  return Object.fromEntries(_graphNodes.get(sessionId) ?? new Map());
}

/** Explicit, logged eviction (the cap replaces silent truncation — GRF-206). */
export async function deleteTaskGraphNodes(sessionId: string, nodeKeys: string[]): Promise<void> {
  if (nodeKeys.length === 0) return;
  const redis = await getRedis();
  if (redis) {
    try {
      await (redis as { hdel: (k: string, ...f: string[]) => Promise<number> }).hdel(graphNodesKey(sessionId), ...nodeKeys);
      return;
    } catch (err) {
      log.warn({ err }, "deleteTaskGraphNodes Redis failed — using in-process");
    }
  }
  const map = _graphNodes.get(sessionId);
  for (const key of nodeKeys) map?.delete(key);
}

export async function searchSharedFacts(
  sessionId: string,
  query: string,
  opts: {
    maxResults?: number;
    provider?: LMStudioProvider;
    embeddingModel?: string;
  } = {},
): Promise<SharedFactMatch[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const facts = await readAllFacts(sessionId);
  const entries = Object.entries(facts);
  if (entries.length === 0) return [];

  const maxResults = Math.max(1, Math.min(10, opts.maxResults ?? 5));
  const keywordMatches = keywordSearchSharedFacts(entries, trimmedQuery, maxResults);

  if (opts.provider && opts.embeddingModel) {
    try {
      const cache = await buildFactEmbeddingCache(sessionId, entries, opts.provider, opts.embeddingModel);
      const [queryVector] = await opts.provider.embed([trimmedQuery], opts.embeddingModel);
      if (!queryVector) {
        log.warn({ query: trimmedQuery }, "Semantic shared-fact search returned no query vector — falling back to keyword match");
        return keywordMatches;
      }

      const semanticMatches = cache
        .map((entry) => ({
          key: entry.key,
          value: entry.value,
          score: cosineSimilarity(queryVector, entry.vector),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, maxResults);

      return mergeSharedFactMatches(semanticMatches, keywordMatches, maxResults);
    } catch (err) {
      log.warn({ err, query: trimmedQuery }, "Semantic shared-fact search failed — falling back to keyword match");
    }
  }

  return keywordMatches;
}

// ── Partial results API ──────────────────────────────────────────────────────

const resultsKey = (sid: string) => `starlingai:mem:${sid}:results`;
const messagesKey = (sid: string) => `starlingai:mem:${sid}:messages`;

/**
 * Append a partial result from a completed sub-agent.
 * Capped at RESULTS_MAX entries per session to prevent unbounded growth.
 */
export async function appendPartialResult(entry: PartialResult & { sessionId: string }): Promise<void> {
  const { sessionId, ...rest } = entry;
  const safeEntry: PartialResult = { ...rest, content: rest.content.slice(0, RESULT_CONTENT_MAX) };
  const redis = await getRedis();

  if (redis) {
    try {
      const k = resultsKey(sessionId);
      await (redis as { rpush: (k: string, v: string) => Promise<void> })
        .rpush(k, JSON.stringify(safeEntry));
      // Trim to last RESULTS_MAX entries
      await (redis as { ltrim: (k: string, s: number, e: number) => Promise<void> })
        .ltrim(k, -RESULTS_MAX, -1);
      await (redis as { expire: (k: string, ttl: number) => Promise<void> }).expire(k, SESSION_TTL_S);
      return;
    } catch (err) {
      log.warn({ err }, "appendPartialResult Redis failed — using in-process");
    }
  }

  const list = _results.get(sessionId) ?? [];
  list.push(safeEntry);
  if (list.length > RESULTS_MAX) list.splice(0, list.length - RESULTS_MAX);
  _results.set(sessionId, list);
}

/**
 * Read all partial results for a session, oldest first.
 */
export async function readPartialResults(sessionId: string): Promise<PartialResult[]> {
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await (redis as { lrange: (k: string, s: number, e: number) => Promise<string[]> })
        .lrange(resultsKey(sessionId), 0, -1);
      return raw.map(r => { try { return JSON.parse(r) as PartialResult; } catch { return null; } })
                .filter((r): r is PartialResult => r !== null);
    } catch (err) {
      log.warn({ err }, "readPartialResults Redis failed — using in-process");
    }
  }
  return [...(_results.get(sessionId) ?? [])];
}

export async function searchPartialResults(
  sessionId: string,
  query: string,
  opts: { maxResults?: number } = {},
): Promise<PartialResultMatch[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const results = await readPartialResults(sessionId);
  if (results.length === 0) return [];

  const maxResults = Math.max(1, Math.min(10, opts.maxResults ?? 5));
  const tokens = tokenizeSearchText(trimmedQuery);

  return results
    .map((result) => {
      const haystack = `${result.agentName} ${result.taskId} ${result.content}`;
      return {
        ...result,
        score: scoreTokenOverlap(tokens, haystack),
      };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || right.ts.localeCompare(left.ts))
    .slice(0, maxResults);
}

// ── Direct agent messages (ADR-003: acknowledged, at-least-once, idempotent) ─

const MSG_GROUP = "consumers";
const MSG_STREAM_MAXLEN = 500;
/** Unacked claims become reclaimable after this idle time (crash redelivery). */
const MSG_VISIBILITY_MS = 120_000;
/** Deliveries beyond this move a message to the dead-letter stream. */
const MSG_MAX_DELIVERIES = 3;

const msgStreamKey = (sid: string, recipient: string) => `starlingai:msgs:${sid}:${recipient}`;
const msgSeenKey = (sid: string, recipient: string) => `starlingai:msgs:${sid}:${recipient}:seen`;
const msgRecipientsKey = (sid: string) => `starlingai:msgs:${sid}:recipients`;
const msgDeadKey = (sid: string) => `starlingai:msgs:dead:${sid}`;
/** Global index of sessions with message activity (for the operator backlog view).
 *  TTL-refreshed on every append; stale members are pruned lazily on read. */
const MSG_SESSIONS_KEY = "starlingai:msgs:sessions";
const MSG_CONSUMER = `worker-${process.pid}`;

export interface AgentMessageClaim {
  /** Deduplicated messages claimed for this recipient, oldest first. */
  messages: AgentMessage[];
  /**
   * Acknowledge AFTER the messages' effect is durably incorporated (persisted
   * turn/attempt state). Never acking is safe: the claim becomes reclaimable
   * after the visibility timeout and is redelivered (at-least-once transport;
   * the seen-set makes processing idempotent).
   */
  ack: () => Promise<void>;
}

// In-process fallback state: queue per session, pending (claimed, unacked)
// entries, per-message delivery counts, acked ids, and dead letters.
interface LocalPendingClaim {
  sessionId: string;
  agentName: string;
  entries: AgentMessage[];
  claimedAt: number;
  /** The claimant's own visibility window — the expiry sweep must judge each
   *  claim by the visibility it was made with, not the current caller's. */
  visibilityMs: number;
}
const _pendingClaims = new Map<string, LocalPendingClaim>();
const _deliveries = new Map<string, number>();
const _seenLocal = new Map<string, Set<string>>();
const _deadLocal = new Map<string, AgentMessage[]>();

export async function appendAgentMessage(entry: AgentMessage & { sessionId: string }): Promise<void> {
  const { sessionId, ...rest } = entry;
  const safeEntry: AgentMessage = {
    ...rest,
    content: rest.content.slice(0, RESULT_CONTENT_MAX),
  };
  const redis = await getRedis();

  if (redis) {
    try {
      const r = redis as {
        xadd: (...args: unknown[]) => Promise<string>;
        sadd: (k: string, v: string) => Promise<number>;
        expire: (k: string, ttl: number) => Promise<number>;
      };
      const stream = msgStreamKey(sessionId, safeEntry.toAgent);
      await r.xadd(stream, "MAXLEN", "~", String(MSG_STREAM_MAXLEN), "*", "payload", JSON.stringify(safeEntry));
      await r.sadd(msgRecipientsKey(sessionId), safeEntry.toAgent);
      await r.sadd(MSG_SESSIONS_KEY, sessionId);
      await r.expire(stream, SESSION_TTL_S);
      await r.expire(msgRecipientsKey(sessionId), SESSION_TTL_S);
      await r.expire(MSG_SESSIONS_KEY, SESSION_TTL_S);
      return;
    } catch (err) {
      log.warn({ err, toAgent: rest.toAgent }, "appendAgentMessage Redis failed — using in-process");
    }
  }

  const list = _messages.get(sessionId) ?? [];
  list.push(safeEntry);
  if (list.length > RESULTS_MAX) list.splice(0, list.length - RESULTS_MAX);
  _messages.set(sessionId, list);
}

interface ParsedStreamEntries {
  parsed: Array<{ entryId: string; message: AgentMessage }>;
  /** Entries whose payload could not be decoded — they must still be ack-able
   *  and dead-letter-able, or they pin the reclaim window forever. */
  unparseable: Array<{ entryId: string; raw: string }>;
}

function parseStreamEntries(raw: unknown): ParsedStreamEntries {
  const out: ParsedStreamEntries = { parsed: [], unparseable: [] };
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const [entryId, fields] = item as [string, string[]];
    if (typeof entryId !== "string" || !Array.isArray(fields)) continue;
    const payloadIndex = fields.findIndex((field, index) => index % 2 === 0 && field === "payload");
    const payload = payloadIndex >= 0 ? fields[payloadIndex + 1] : undefined;
    if (typeof payload !== "string") {
      out.unparseable.push({ entryId, raw: JSON.stringify(fields).slice(0, RESULT_CONTENT_MAX) });
      continue;
    }
    try {
      out.parsed.push({ entryId, message: JSON.parse(payload) as AgentMessage });
    } catch {
      out.unparseable.push({ entryId, raw: payload.slice(0, RESULT_CONTENT_MAX) });
    }
  }
  return out;
}

/**
 * One-shot drain of the legacy list into per-recipient streams (pre-upgrade
 * messages, and messages parked locally before a Redis recovery). An entry is
 * removed from its source ONLY AFTER it is durably in a stream — a crash
 * mid-drain re-drains the remainder instead of losing it.
 */
async function drainLegacyMessageList(redis: unknown, sessionId: string): Promise<void> {
  try {
    const r = redis as {
      lindex: (k: string, i: number) => Promise<string | null>;
      lpop: (k: string) => Promise<string | null>;
      sadd: (k: string, v: string) => Promise<number>;
      expire: (k: string, ttl: number) => Promise<number>;
      xadd: (...args: unknown[]) => Promise<string>;
    };
    const key = messagesKey(sessionId);
    for (let guard = 0; guard < RESULTS_MAX * 2; guard += 1) {
      const head = await r.lindex(key, 0);
      if (head === null) break;
      let message: AgentMessage | null = null;
      try { message = JSON.parse(head) as AgentMessage; } catch { /* malformed → dead-letter below */ }
      if (message) {
        await r.xadd(msgStreamKey(sessionId, message.toAgent), "MAXLEN", "~", String(MSG_STREAM_MAXLEN), "*", "payload", JSON.stringify(message));
        await r.sadd(msgRecipientsKey(sessionId), message.toAgent);
        await r.expire(msgStreamKey(sessionId, message.toAgent), SESSION_TTL_S);
      } else {
        await r.xadd(msgDeadKey(sessionId), "MAXLEN", "~", String(MSG_STREAM_MAXLEN), "*", "payload", head, "reason", "malformed_legacy");
        await r.expire(msgDeadKey(sessionId), SESSION_TTL_S);
      }
      // Durably transferred — only now remove the exact head entry.
      await r.lpop(key);
    }
  } catch { /* legacy drain is best-effort; the remainder re-drains next claim */ }
}

/** Drain messages parked in the in-process fallback while Redis was down —
 *  once Redis answers again, they move into the durable streams (all recipients). */
async function drainLocalFallbackMessages(redis: unknown, sessionId: string): Promise<void> {
  const parked = _messages.get(sessionId);
  if (!parked || parked.length === 0) return;
  _messages.delete(sessionId); // take atomically to avoid double-drain
  try {
    const r = redis as {
      xadd: (...args: unknown[]) => Promise<string>;
      sadd: (k: string, v: string) => Promise<number>;
      expire: (k: string, ttl: number) => Promise<number>;
    };
    for (let i = 0; i < parked.length; i += 1) {
      const message = parked[i]!;
      try {
        await r.xadd(msgStreamKey(sessionId, message.toAgent), "MAXLEN", "~", String(MSG_STREAM_MAXLEN), "*", "payload", JSON.stringify(message));
        await r.sadd(msgRecipientsKey(sessionId), message.toAgent);
        await r.expire(msgStreamKey(sessionId, message.toAgent), SESSION_TTL_S);
      } catch (err) {
        // Redis died mid-drain: put the untransferred tail back for the next recovery.
        const tail = parked.slice(i);
        const queue = _messages.get(sessionId) ?? [];
        _messages.set(sessionId, [...tail, ...queue]);
        log.warn({ err, sessionId, restored: tail.length }, "Local message drain interrupted — tail restored");
        return;
      }
    }
  } catch { /* handled per-entry above */ }
}

/**
 * Claim pending messages for a recipient without destroying them (ADR-003).
 * At-least-once: entries stay pending until {@link AgentMessageClaim.ack};
 * a crashed claimant's entries are reclaimed after MSG_VISIBILITY_MS; entries
 * delivered more than MSG_MAX_DELIVERIES times dead-letter. Processing is
 * idempotent: ids acked once are never returned again.
 */
export async function claimAgentMessages(
  sessionId: string,
  agentName: string,
  opts: { visibilityMs?: number } = {},
): Promise<AgentMessageClaim> {
  const visibilityMs = Math.max(1_000, opts.visibilityMs ?? MSG_VISIBILITY_MS);
  const redis = await getRedis();

  if (redis) {
    try {
      const r = redis as {
        xgroup: (...args: unknown[]) => Promise<unknown>;
        xreadgroup: (...args: unknown[]) => Promise<unknown>;
        xautoclaim: (...args: unknown[]) => Promise<unknown>;
        xpending: (...args: unknown[]) => Promise<unknown>;
        xack: (...args: unknown[]) => Promise<number>;
        xadd: (...args: unknown[]) => Promise<string>;
        smismember: (k: string, ...ids: string[]) => Promise<number[]>;
        sadd: (k: string, ...v: string[]) => Promise<number>;
        expire: (k: string, ttl: number) => Promise<number>;
      };
      const stream = msgStreamKey(sessionId, agentName);
      const seen = msgSeenKey(sessionId, agentName);

      // Group start at '0' so entries appended before the group existed are readable.
      try {
        await r.xgroup("CREATE", stream, MSG_GROUP, "0", "MKSTREAM");
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("BUSYGROUP"))) throw err;
      }
      await drainLegacyMessageList(redis, sessionId);
      await drainLocalFallbackMessages(redis, sessionId);
      // Claim activity is session liveness: refresh TTLs so an active session's
      // pending entries and consumer group never expire mid-conversation.
      await r.expire(stream, SESSION_TTL_S);
      await r.expire(msgRecipientsKey(sessionId), SESSION_TTL_S);

      // Delivery counts BEFORE reclaiming (XAUTOCLAIM resets idle): entries at the
      // retry ceiling dead-letter; the rest of the stale pending set redelivers here.
      const pending = await r.xpending(stream, MSG_GROUP, "IDLE", String(visibilityMs), "-", "+", "100");
      const deadIds = new Set<string>();
      if (Array.isArray(pending)) {
        for (const row of pending) {
          if (!Array.isArray(row) || row.length < 4) continue;
          const [entryId, , , deliveries] = row as [string, string, number, number];
          if (Number(deliveries) >= MSG_MAX_DELIVERIES) deadIds.add(entryId);
        }
      }
      // Single reclaim pass: stale entries move to this consumer exactly once,
      // then partition into dead-letter vs redeliver. Unparseable payloads are
      // dead-lettered raw immediately — they can never succeed and would
      // otherwise pin the reclaim window forever.
      const reclaimedRaw = await r.xautoclaim(stream, MSG_GROUP, MSG_CONSUMER, String(visibilityMs), "0", "COUNT", "100");
      const reclaimedAll = parseStreamEntries(Array.isArray(reclaimedRaw) ? reclaimedRaw[1] : []);
      const reclaimed: Array<{ entryId: string; message: AgentMessage }> = [];
      const deadLetter = async (entryId: string, payload: string, reason: string): Promise<void> => {
        await r.xadd(msgDeadKey(sessionId), "MAXLEN", "~", String(MSG_STREAM_MAXLEN), "*", "payload", payload, "reason", reason);
        await r.expire(msgDeadKey(sessionId), SESSION_TTL_S);
        await r.xack(stream, MSG_GROUP, entryId);
        log.warn({ sessionId, agentName, entryId, reason }, "Agent message dead-lettered");
      };
      for (const entry of reclaimedAll.unparseable) {
        await deadLetter(entry.entryId, entry.raw, "malformed");
      }
      for (const entry of reclaimedAll.parsed) {
        if (deadIds.has(entry.entryId)) {
          await deadLetter(entry.entryId, JSON.stringify(entry.message), "retry_ceiling");
        } else {
          reclaimed.push(entry);
        }
      }
      const freshRaw = await r.xreadgroup("GROUP", MSG_GROUP, MSG_CONSUMER, "COUNT", "100", "STREAMS", stream, ">");
      const freshParsed = Array.isArray(freshRaw) && Array.isArray(freshRaw[0]) && Array.isArray((freshRaw[0] as unknown[])[1])
        ? parseStreamEntries((freshRaw[0] as unknown[])[1])
        : { parsed: [], unparseable: [] };
      for (const entry of freshParsed.unparseable) {
        await deadLetter(entry.entryId, entry.raw, "malformed");
      }
      const fresh = freshParsed.parsed;

      const combined = [...reclaimed, ...fresh];
      // Idempotency: ids acked in a previous claim were already processed.
      let entries = combined;
      if (combined.length > 0) {
        const flags = await r.smismember(seen, ...combined.map(({ message }) => message.id));
        const already = combined.filter((_, index) => Number(flags[index]) === 1);
        for (const { entryId } of already) await r.xack(stream, MSG_GROUP, entryId);
        entries = combined.filter((_, index) => Number(flags[index]) !== 1);
      }

      const entryIds = entries.map(({ entryId }) => entryId);
      const messageIds = entries.map(({ message }) => message.id);
      let acked = false;
      return {
        messages: entries.map(({ message }) => message),
        ack: async (): Promise<void> => {
          if (acked || entryIds.length === 0) { acked = true; return; }
          acked = true;
          try {
            await r.xack(stream, MSG_GROUP, ...entryIds);
            await r.sadd(seen, ...messageIds);
            await r.expire(seen, SESSION_TTL_S);
          } catch (err) {
            log.warn({ err, sessionId, agentName }, "Agent message ack failed — entries will redeliver");
          }
        },
      };
    } catch (err) {
      log.warn({ err, agentName }, "claimAgentMessages Redis failed — using in-process");
    }
  }

  // ── In-process fallback (same claim/ack/redelivery semantics) ──
  const now = Date.now();
  // Requeue expired unacked claims (redelivery), dead-lettering past the ceiling.
  // Each claim expires by ITS OWN visibility window; requeue newest-claim-first so
  // the oldest claim's messages end up frontmost, preserving oldest-first order.
  const expired = [..._pendingClaims.entries()]
    .filter(([, claim]) => now - claim.claimedAt >= claim.visibilityMs)
    .sort(([, left], [, right]) => right.claimedAt - left.claimedAt);
  for (const [token, claim] of expired) {
    _pendingClaims.delete(token);
    const queue = _messages.get(claim.sessionId) ?? [];
    const survivors: AgentMessage[] = [];
    for (const message of claim.entries) {
      const deliveries = _deliveries.get(message.id) ?? 1;
      if (deliveries >= MSG_MAX_DELIVERIES) {
        const dead = _deadLocal.get(claim.sessionId) ?? [];
        dead.push(message);
        _deadLocal.set(claim.sessionId, dead);
        log.warn({ sessionId: claim.sessionId, agentName: claim.agentName, messageId: message.id }, "Agent message dead-lettered after retry ceiling (local)");
      } else {
        survivors.push(message);
      }
    }
    if (survivors.length > 0) queue.unshift(...survivors);
    if (queue.length > 0) _messages.set(claim.sessionId, queue);
  }

  const seenSet = _seenLocal.get(`${sessionId}:${agentName}`) ?? new Set<string>();
  const list = _messages.get(sessionId) ?? [];
  const matched = list.filter((message) => message.toAgent === agentName && !seenSet.has(message.id));
  // Already-seen messages for this recipient are DISCARDED (they were processed
  // in a prior acked claim), mirroring the Redis path's ack-on-seen — retaining
  // them would park ghosts in the queue and inflate the backlog metric forever.
  const remaining = list.filter((message) => message.toAgent !== agentName);
  if (remaining.length > 0) _messages.set(sessionId, remaining);
  else _messages.delete(sessionId);
  for (const message of matched) _deliveries.set(message.id, (_deliveries.get(message.id) ?? 0) + 1);

  const token = `${sessionId}:${agentName}:${now}:${Math.floor(performance.now() * 1000)}`;
  if (matched.length > 0) _pendingClaims.set(token, { sessionId, agentName, entries: matched, claimedAt: now, visibilityMs });
  let acked = false;
  return {
    messages: matched,
    ack: async (): Promise<void> => {
      if (acked) return;
      acked = true;
      _pendingClaims.delete(token);
      if (matched.length === 0) return;
      for (const message of matched) {
        seenSet.add(message.id);
        _deliveries.delete(message.id);
      }
      // Hygiene cap with oldest-first eviction (Set preserves insertion order):
      // clearing wholesale could resurrect a recently-acked duplicate.
      while (seenSet.size > 1_000) {
        const oldest = seenSet.values().next().value;
        if (oldest === undefined) break;
        seenSet.delete(oldest);
      }
      _seenLocal.set(`${sessionId}:${agentName}`, seenSet);
    },
  };
}

/**
 * Legacy destructive-read compatibility wrapper: claim + immediate ack.
 * Strictly safer than the old list read (no cross-recipient wipe, no
 * cross-consumer theft, crash before return redelivers), but it acknowledges
 * BEFORE the caller has persisted the messages' effect — new call sites should
 * use {@link claimAgentMessages} and ack after persistence.
 */
export async function consumeAgentMessages(sessionId: string, agentName: string): Promise<AgentMessage[]> {
  const claim = await claimAgentMessages(sessionId, agentName);
  await claim.ack();
  return claim.messages;
}

/** Dead-lettered messages for a session — Redis DLQ stream merged with the local view. */
export async function getDeadLetteredAgentMessages(sessionId: string): Promise<AgentMessage[]> {
  const local = [...(_deadLocal.get(sessionId) ?? [])];
  const redis = await getRedis();
  if (!redis) return local;
  try {
    const r = redis as { xrange: (...args: unknown[]) => Promise<unknown> };
    const raw = await r.xrange(msgDeadKey(sessionId), "-", "+", "COUNT", String(MSG_STREAM_MAXLEN));
    const { parsed } = parseStreamEntries(raw);
    return [...local, ...parsed.map(({ message }) => message)];
  } catch {
    return local;
  }
}

export function getAgentMessageBacklogSnapshot(): AgentMessageBacklogSnapshot[] {
  const pendingByClaim = new Map<string, Record<string, number>>();
  for (const claim of _pendingClaims.values()) {
    const targets = pendingByClaim.get(claim.sessionId) ?? {};
    for (const message of claim.entries) targets[message.toAgent] = (targets[message.toAgent] ?? 0) + 1;
    pendingByClaim.set(claim.sessionId, targets);
  }
  const sessions = new Set<string>([..._messages.keys(), ...pendingByClaim.keys()]);
  return [...sessions]
    .map((sessionId) => {
      const targets: Record<string, number> = { ...(pendingByClaim.get(sessionId) ?? {}) };
      for (const message of _messages.get(sessionId) ?? []) {
        targets[message.toAgent] = (targets[message.toAgent] ?? 0) + 1;
      }
      const pending = Object.values(targets).reduce((sum, count) => sum + count, 0);
      return { sessionId, pending, targets };
    })
    .filter((entry) => entry.pending > 0)
    .sort((left, right) => right.pending - left.pending || left.sessionId.localeCompare(right.sessionId));
}

/**
 * Operator backlog view across BOTH transports. The sync snapshot above covers
 * only the in-process fallback; when Redis is the transport it always reads 0 —
 * this variant additionally walks the stream state: per recipient, undelivered
 * entries (XINFO GROUPS lag) plus claimed-but-unacked entries (XPENDING count),
 * and the session's dead-letter depth.
 */
export async function getAgentMessageBacklog(): Promise<Array<AgentMessageBacklogSnapshot & { deadLettered?: number }>> {
  const local = getAgentMessageBacklogSnapshot();
  const redis = await getRedis();
  if (!redis) return local;
  try {
    const r = redis as {
      smembers: (k: string) => Promise<string[]>;
      xinfo: (...args: unknown[]) => Promise<unknown>;
      xpending: (...args: unknown[]) => Promise<unknown>;
      xlen: (k: string) => Promise<number>;
    };
    const bySession = new Map<string, AgentMessageBacklogSnapshot & { deadLettered?: number }>(
      local.map((entry) => [entry.sessionId, entry]),
    );
    const sessions = await r.smembers(MSG_SESSIONS_KEY);
    for (const sessionId of sessions) {
      const recipients = await r.smembers(msgRecipientsKey(sessionId));
      if (recipients.length === 0) continue; // stale index member — keys expired
      const entry = bySession.get(sessionId) ?? { sessionId, pending: 0, targets: {} };
      for (const recipient of recipients) {
        const stream = msgStreamKey(sessionId, recipient);
        let count = 0;
        try {
          const groups = await r.xinfo("GROUPS", stream);
          const group = (Array.isArray(groups) ? groups : []).find((g) =>
            Array.isArray(g) && g.some((field, i) => i % 2 === 0 && field === "name" && g[i + 1] === MSG_GROUP));
          if (Array.isArray(group)) {
            const field = (name: string): number => {
              const index = group.findIndex((value, i) => i % 2 === 0 && value === name);
              return index >= 0 ? Number(group[index + 1]) || 0 : 0;
            };
            count = field("lag") + field("pending");
          } else {
            count = await r.xlen(stream); // no group yet → everything undelivered
          }
        } catch {
          try { count = await r.xlen(stream); } catch { count = 0; }
        }
        if (count > 0) entry.targets[recipient] = (entry.targets[recipient] ?? 0) + count;
      }
      try {
        const dead = await r.xlen(msgDeadKey(sessionId));
        if (dead > 0) entry.deadLettered = (entry.deadLettered ?? 0) + dead;
      } catch { /* dead-letter depth is best-effort */ }
      entry.pending = Object.values(entry.targets).reduce((sum, count) => sum + count, 0);
      if (entry.pending > 0 || (entry.deadLettered ?? 0) > 0) bySession.set(sessionId, entry);
    }
    return [...bySession.values()]
      .filter((entry) => entry.pending > 0 || (entry.deadLettered ?? 0) > 0)
      .sort((left, right) => right.pending - left.pending || left.sessionId.localeCompare(right.sessionId));
  } catch (err) {
    log.warn({ err }, "Redis backlog view failed — returning in-process snapshot");
    return local;
  }
}

// ── Prompt injection ─────────────────────────────────────────────────────────

/**
 * Format shared facts and recent partial results for injection into a
 * sub-agent's context string.
 *
 * Returns an empty string if there is nothing to share yet.
 */
export async function formatSharedContextForPrompt(
  sessionId: string,
  opts: {
    includeFacts?: boolean;
    includeResults?: boolean;
    maxResults?: number;
    agentName?: string;
    /** Pre-claimed messages (ADR-003 deferred ack): the caller holds the claim
     *  and acks after the consuming turn persists. When provided, this function
     *  performs NO consume of its own. */
    directMessages?: AgentMessage[];
  } = {},
): Promise<string> {
  const { includeFacts = true, includeResults = true, maxResults = 5, agentName, directMessages } = opts;

  const sections: string[] = [];

  const messages = directMessages ?? (agentName ? await consumeAgentMessages(sessionId, agentName) : []);
  if (messages.length > 0) {
    sections.push(
      "## Direct Messages (from other agents this session)\n" +
      messages.map((message) => `- **${message.fromAgent}**: ${message.content}`).join("\n"),
    );
  }

  if (includeFacts) {
    const facts = await readAllFacts(sessionId);
    const entries = Object.entries(facts);
    if (entries.length > 0) {
      sections.push(
        "## Shared Facts (from other agents this session)\n" +
        entries.map(([k, v]) => `- **${k}**: ${v}`).join("\n"),
      );
    }
  }

  if (includeResults) {
    const results = await readPartialResults(sessionId);
    const recent = results.slice(-maxResults);
    if (recent.length > 0) {
      sections.push(
        "## Partial Results (from completed sub-agents)\n" +
        recent.map(r => `### ${r.agentName} (task: ${r.taskId})\n${r.content}`).join("\n\n"),
      );
    }
  }

  return sections.length > 0 ? sections.join("\n\n") : "";
}

/**
 * Extract shareable facts from a sub-agent output.
 * Looks for lines formatted as:  FACT: key = value
 * Returns a map of { key → value } pairs found.
 */
export function extractFactsFromOutput(output: string): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = line.match(/^FACT:\s*([^=]+?)\s*=\s*(.+)$/i);
    if (match) {
      const key = match[1]!.trim().toLowerCase().replace(/\s+/g, "_").slice(0, 60);
      const value = match[2]!.trim();
      if (key && value) facts[key] = value;
    }
  }
  return facts;
}

/** Reset all state — for use in tests only. */
export async function resetSharedMemoryForTests(): Promise<void> {
  _facts.clear();
  _results.clear();
  _messages.clear();
  _pendingClaims.clear();
  _deliveries.clear();
  _seenLocal.clear();
  _deadLocal.clear();
  _turnPlans.clear();
  _factEmbeddingCache.clear();
  _factKeysThisTurn.clear();
  _graphLedgers.clear();
  _graphNodes.clear();
  _localGraphDefs.clear();
  _drainedGraphSessions.clear();
  if (_redis) {
    try { await (_redis as { quit: () => Promise<void> }).quit(); } catch { /* ignore */ }
  }
  _redis = null;
  _redisReady = false;
}

/**
 * Cache key for a session's fact-embedding set. Keyed on both the fact entries AND
 * the embedding model: a model change (different vector dimension) must invalidate
 * stale vectors, else cosine similarity mixes dimensions → NaN. Each [key, value]
 * pair is JSON-serialized so keys or values containing ':' or newlines cannot
 * collide into an identical signature. Pure + exported for testing.
 */
export function factEmbeddingSignature(entries: Array<[string, string]>, embeddingModel: string): string {
  return (
    `${embeddingModel}\n` +
    entries
      .slice()
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => JSON.stringify([key, value]))
      .join("\n")
  );
}

/**
 * An embed batch is usable for the fact cache only when it returned exactly one
 * non-empty vector per input. A short / partial response must never be cached (the
 * signature would match next call and permanently serve poisoned vectors, silently
 * disabling semantic fact retrieval). Pure + exported for testing.
 */
export function isUsableEmbeddingBatch(vectors: Array<Float32Array | null | undefined>, expectedCount: number): boolean {
  return vectors.length === expectedCount && vectors.every((v) => !!v && v.length > 0);
}

async function buildFactEmbeddingCache(
  sessionId: string,
  entries: Array<[string, string]>,
  provider: LMStudioProvider,
  embeddingModel: string,
): Promise<Array<{ key: string; value: string; vector: Float32Array }>> {
  const signature = factEmbeddingSignature(entries, embeddingModel);

  const cached = _factEmbeddingCache.get(sessionId);
  if (cached && cached.signature === signature) {
    return cached.vectors;
  }

  const documents = entries.map(([key, value]) => `${key}: ${value}`);
  const vectors = await provider.embed(documents, embeddingModel);
  // A short / partial embed response (fewer vectors than inputs, or an empty vector)
  // must NOT be cached: the signature would match on the next call and permanently
  // serve poisoned vectors, silently disabling semantic fact retrieval. Throw so the
  // caller falls back to keyword search and the embed is retried next time.
  if (!isUsableEmbeddingBatch(vectors, documents.length)) {
    throw new Error(`embed returned ${vectors.length}/${documents.length} usable vectors for shared-fact cache`);
  }
  const prepared = entries.map(([key, value], index) => ({
    key,
    value,
    vector: vectors[index]!,
  }));
  _factEmbeddingCache.set(sessionId, { signature, vectors: prepared });
  return prepared;
}

function keywordSearchSharedFacts(entries: Array<[string, string]>, query: string, maxResults: number): SharedFactMatch[] {
  const tokens = tokenizeSearchText(query);
  return entries
    .map(([key, value]) => {
      return { key, value, score: scoreTokenOverlap(tokens, `${key} ${value}`) };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxResults);
}

function mergeSharedFactMatches(
  semanticMatches: SharedFactMatch[],
  keywordMatches: SharedFactMatch[],
  maxResults: number,
): SharedFactMatch[] {
  const merged = new Map<string, SharedFactMatch>();

  for (const match of [...semanticMatches, ...keywordMatches]) {
    const existing = merged.get(match.key);
    if (!existing || match.score > existing.score) {
      merged.set(match.key, match);
    }
  }

  return [...merged.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, maxResults);
}

function scoreTokenOverlap(queryTokens: string[], haystack: string): number {
  if (queryTokens.length === 0) return 0;

  const haystackTokens = new Set(tokenizeSearchText(haystack));
  let matched = 0;
  for (const token of queryTokens) {
    if (haystackTokens.has(token)) {
      matched += 1;
    }
  }

  return matched / queryTokens.length;
}

function tokenizeSearchText(text: string): string[] {
  const normalized = normalizeSearchText(text);
  if (!normalized) return [];

  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of normalized.split(" ")) {
    if (!token) continue;
    const canonicalToken = SEARCH_TOKEN_ALIASES[token] ?? token;
    if (SEARCH_TOKEN_STOPWORDS.has(canonicalToken)) continue;
    if (canonicalToken.length === 1 && !/\d/.test(canonicalToken)) continue;
    if (seen.has(canonicalToken)) continue;
    seen.add(canonicalToken);
    tokens.push(canonicalToken);
  }
  return tokens;
}

function normalizeSearchText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_/\\-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index]! * b[index]!;
    normA += a[index]! * a[index]!;
    normB += b[index]! * b[index]!;
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
