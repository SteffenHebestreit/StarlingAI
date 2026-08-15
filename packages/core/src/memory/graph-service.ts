/**
 * Graph Memory Service — MemGraph-backed enhancement layer.
 *
 * Augments the flat-file memory service (memory/service.ts) with a MemGraph graph
 * for richer retrieval, reranking, and quality management. Every operation
 * degrades gracefully — if MemGraph is unavailable the caller falls back to
 * flat-file behaviour without error.
 *
 * Responsibilities:
 *   - Write-through: mirror MemoryRecord writes as graph nodes with relationships
 *   - L0 always-loaded layer: decisions + preferences injected unconditionally
 *   - Graph reranking: centrality / feedback scores re-order search candidates
 *   - Outlier detection: surface orphaned or stale nodes for review
 *   - FACT promotion: persist extracted agent facts as durable graph nodes
 *   - MAGE background jobs: betweenness centrality + community detection
 *   - Similarity links: SIMILAR_TO edges via MemGraph vector_search
 *
 * Graph schema (MemGraph nodes / relationships):
 *   (:MemoryRecord)  ← primary memory nodes
 *   (:Agent)         ← named agents
 *   (:Session)       ← execution sessions
 *   (:Topic)         ← subject classification
 *   (:Entity)        ← extracted named entities
 *
 *   (Agent)-[:WROTE {scope, ts}]->(MemoryRecord)
 *   (Session)-[:PRODUCED {taskId}]->(MemoryRecord)
 *   (MemoryRecord)-[:ABOUT {relevance}]->(Topic)
 *   (MemoryRecord)-[:SIMILAR_TO {similarity, method}]->(MemoryRecord)
 *   (MemoryRecord)-[:SUPERSEDES {ts, reason}]->(MemoryRecord)
 *   (MemoryRecord)-[:CONTRADICTS {detectedAt, confidence}]->(MemoryRecord)
 *   (Agent)-[:RETRIEVED {ts, sessionId, rank, wasUseful}]->(MemoryRecord)
 */

import { isGraphDbAvailable, runCypher, toPlainRecords } from "../db/neo4j.js";
import type { MemoryRecord } from "./service.js";
import { childLogger } from "../logger.js";
import { getConfig } from "../config/loader.js";
import { getEmbeddingProvider } from "../providers/index.js";
import { currentUserId } from "../runtime/request-context.js";

/**
 * Per-user tenant for graph partitioning: the authenticated userId when
 * multi-user auth is on, else null (single-operator — no partitioning, fully
 * back-compat). Only the 'user' scope is tenant-partitioned; workspace / session
 * / agent scopes stay shared. Pass the record's scope on WRITE (tenant only for
 * user-scope nodes); omit on READ to get the current reader's tenant.
 */
function graphUserTenant(scope?: string): string | null {
  if (scope !== undefined && scope !== "user") return null;
  return getConfig().auth?.enabled === true ? (currentUserId() ?? null) : null;
}

const log = childLogger("memory:graph");

export const VECTOR_INDEX_NAME = "memory_embedding";

// ── Types ─────────────────────────────────────────────────────────────────────


// ── Write-through upsert ──────────────────────────────────────────────────────

/**
 * Mirror a MemoryRecord into the graph as a :MemoryRecord node.
 * Optionally creates :Agent + WROTE and :Session + PRODUCED relationships.
 *
 * Callers should fire-and-forget: upsertMemoryToGraph(...).catch(() => {})
 */
export async function upsertMemoryToGraph(
  record: MemoryRecord,
  agentName?: string,
  sessionId?: string,
  // A4: the durable-memory write computes ONE embedding for the flat-file search
  // vector and hands the SAME vector here (resolved value or the in-flight promise)
  // so the graph does not embed a second time. The graph vector's only consumer is
  // the non-scoring peerCount, so reusing the richer search vector is behavior-neutral.
  // When omitted (other callers), the graph computes its own from record.content.
  sharedEmbedding?: Float32Array | number[] | null | Promise<Float32Array | null>,
): Promise<void> {
  if (!isGraphDbAvailable()) return;

  // Derive domain (wing) and topic (room) from existing MemoryRecord fields
  const domain = record.ownerType === "agent"
    ? record.ownerId
    : (agentName ?? record.scope);
  const topic = record.kind;

  try {
    await runCypher(`
      MERGE (m:MemoryRecord {id: $id})
      SET m.content     = $content,
          m.kind        = $kind,
          m.scope       = $scope,
          m.tenant      = $tenant,
          m.domain      = $domain,
          m.topic       = $topic,
          m.importance  = coalesce(m.importance, 0.5),
          m.accessCount = coalesce(m.accessCount, 0),
          m.updatedAt   = $updatedAt,
          m.createdAt   = coalesce(m.createdAt, $createdAt)
    `, {
      id: record.id,
      content: record.content.slice(0, 2000),
      kind: record.kind,
      scope: record.scope,
      // Per-user tenant for 'user'-scope nodes (multi-user auth); null otherwise.
      tenant: graphUserTenant(record.scope),
      domain,
      topic,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }, { write: true });
  } catch (err) {
    log.warn({ err, id: record.id }, "Graph MemoryRecord upsert failed");
    return;
  }

  if (agentName) {
    const writeScope = record.scope === "agent" ? "private" : "shared";
    try {
      await runCypher(`
        MERGE (a:Agent {name: $agentName})
        WITH a
        MATCH (m:MemoryRecord {id: $id})
        MERGE (a)-[w:WROTE]->(m)
        SET w.scope = $writeScope, w.ts = $now
      `, {
        agentName,
        id: record.id,
        writeScope,
        now: new Date().toISOString(),
      }, { write: true });
    } catch (err) {
      log.debug({ err }, "WROTE relationship upsert failed");
    }
  }

  if (sessionId) {
    try {
      await runCypher(`
        MERGE (s:Session {id: $sessionId})
        WITH s
        MATCH (m:MemoryRecord {id: $id})
        MERGE (s)-[:PRODUCED]->(m)
      `, { sessionId, id: record.id }, { write: true });
    } catch (err) {
      log.debug({ err }, "PRODUCED relationship upsert failed");
    }
  }

  // Embedding step — runs AFTER the node MERGE so a slow or absent embed never delays
  // node creation. Prefer the caller's shared vector (A4: computed once for the flat
  // file too); fall back to computing our own when no caller supplies one.
  if (sharedEmbedding === undefined) {
    void computeAndStoreEmbedding(record.id, record.content);
  } else {
    const vector = sharedEmbedding instanceof Promise ? await sharedEmbedding.catch(() => null) : sharedEmbedding;
    if (vector && vector.length > 0) await storeGraphEmbedding(record.id, vector);
  }
}

/** Persist a precomputed embedding onto an existing MemoryRecord node. */
async function storeGraphEmbedding(id: string, vector: Float32Array | number[]): Promise<void> {
  if (!isGraphDbAvailable()) return;
  try {
    await runCypher(
      `MATCH (m:MemoryRecord {id: $id}) SET m.embedding = $embedding`,
      { id, embedding: Array.from(vector) },
      { write: true },
    );
  } catch (err) {
    log.debug({ err, id }, "Embedding write failed — vector similarity for this record unavailable");
  }
}

async function computeAndStoreEmbedding(id: string, content: string): Promise<void> {
  if (!isGraphDbAvailable()) return;

  try {
    const embeddingModel = getConfig().agents.defaults.model.embeddingModel;
    if (!embeddingModel) return;

    const provider = getEmbeddingProvider();
    const [vector] = await provider.embed([content.slice(0, 512)], embeddingModel);
    if (!vector || vector.length === 0) return;

    await storeGraphEmbedding(id, vector);
  } catch (err) {
    log.debug({ err, id }, "Embedding compute failed — vector similarity for this record unavailable");
  }
}

// ── L0 always-loaded critical layer ──────────────────────────────────────────

// graphL0Layer also sits on the turn-0 memory-injection critical path (called inside
// formatScopedMemoryGuidance's Promise.all). Guard it with the same wall-clock timeout
// as graphRerank — a slow/locked MemGraph degrades to an empty Critical-Memory section
// rather than blocking the turn — plus a SHORT TTL cache (this surfaces the *presence*
// of always-on decisions/preferences, so it is more freshness-sensitive than rerank's
// stable scores; 60s collapses repeat round-trips within a burst of turns while keeping
// a newly-added critical record visible within a minute). Keyed by domain+maxChars.
const GRAPH_L0_TIMEOUT_MS = 200;
const GRAPH_L0_CACHE_TTL_MS = 60_000;
const GRAPH_L0_CACHE_MAX = 64;
const _graphL0Cache = new Map<string, { storedAt: number; content: string }>();
let _graphL0Timeouts = 0;
const _GRAPH_L0_TIMEOUT = Symbol("graph-l0-timeout");

/** Number of graphL0Layer calls that hit the wall-clock timeout (degraded to empty). */
export function graphL0TimeoutCount(): number { return _graphL0Timeouts; }

/**
 * Query decisions and preferences from the graph — records that should always
 * appear in context regardless of query relevance.
 *
 * Returns a formatted section string ready to prepend to memory guidance,
 * or "" when the graph is empty / unavailable / slow.
 */
export async function graphL0Layer(
  domain?: string,
  maxChars = 600,
): Promise<string> {
  if (!isGraphDbAvailable()) return "";

  // Tenant MUST be in the cache key — else one user's cached L0 block would be
  // served to another user under multi-user auth.
  const tenant = graphUserTenant();
  const cacheKey = `${domain ?? ""} ${maxChars} ${tenant ?? ""}`;
  const cached = _graphL0Cache.get(cacheKey);
  if (cached && Date.now() - cached.storedAt <= GRAPH_L0_CACHE_TTL_MS) return cached.content;

  try {
    const queryPromise = runCypher(`
      MATCH (m:MemoryRecord)
      WHERE m.kind IN ['decision', 'preference']
        AND (m.scope = 'workspace'
             OR (m.scope = 'user' AND ($tenant IS NULL OR m.tenant = $tenant)))
        AND (m.validTo IS NULL OR m.validTo > $now)
        AND ($domain IS NULL OR m.domain = $domain OR m.domain IS NULL)
      RETURN m.id AS id, m.kind AS kind, m.content AS content
      ORDER BY m.importance DESC, m.updatedAt DESC
      LIMIT 5
    `, { domain: domain ?? null, now: new Date().toISOString(), tenant }).catch(() => null); // swallow a late rejection after timeout
    const result = await Promise.race([
      queryPromise,
      new Promise<typeof _GRAPH_L0_TIMEOUT>((resolve) => {
        const t = setTimeout(() => resolve(_GRAPH_L0_TIMEOUT), GRAPH_L0_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
    if (result === _GRAPH_L0_TIMEOUT) { _graphL0Timeouts++; return ""; }

    let content = "";
    if (result) {
      const rows = toPlainRecords(result);
      if (rows.length > 0) {
        const lines: string[] = [];
        let totalChars = "## Critical Memory".length + 1;
        for (const row of rows) {
          const text = String(row["content"] ?? "").replace(/\s+/g, " ").trim();
          const kind = String(row["kind"] ?? "note");
          const line = `- [${kind}] ${text.slice(0, 220)}`;
          if (totalChars + line.length + 1 > maxChars) break;
          lines.push(line);
          totalChars += line.length + 1;
        }
        if (lines.length > 0) content = ["## Critical Memory", ...lines].join("\n");
      }
    }

    // Cache the formatted section (including an empty one) so repeat turns within the
    // window skip the round-trip; the timeout above is what guards a hung MemGraph.
    _graphL0Cache.set(cacheKey, { storedAt: Date.now(), content });
    if (_graphL0Cache.size > GRAPH_L0_CACHE_MAX) {
      const oldest = _graphL0Cache.keys().next().value;
      if (oldest !== undefined) _graphL0Cache.delete(oldest);
    }
    return content;
  } catch (err) {
    log.debug({ err }, "L0 layer query failed");
    return "";
  }
}

// ── Graph reranking ───────────────────────────────────────────────────────────

/**
 * Compute graph-based scores for a set of candidate MemoryRecord IDs.
 * Returns Map<id, graphScore> where graphScore is 0.0–1.0.
 *
 * Callers blend this with their text score:
 *   finalScore = textScore * 0.55 + graphScore * 0.45
 *
 * Scoring factors:
 *   +centrality      — well-connected nodes surface more related context
 *   +importance      — explicit importance weighting
 *   +usefulRetrievals — feedback loop from past retrievals marked useful
 *   −newerVersionCount — hard penalty when a SUPERSEDES edge exists pointing away
 *   −supersededCount  — soft penalty when the record itself supersedes old facts
 */
// graphRerank sits on the turn-0 memory-injection critical path. Bound it with a
// wall-clock timeout (slow/locked MemGraph degrades to text-only ranking, never
// blocks the turn) and a short TTL cache keyed by the sorted candidate-id set
// (score-preserving — same candidates → same graph scores within the window).
const GRAPH_RERANK_TIMEOUT_MS = 200;
const GRAPH_RERANK_CACHE_TTL_MS = 5 * 60_000;
const GRAPH_RERANK_CACHE_MAX = 256;
const _graphRerankCache = new Map<string, { storedAt: number; scores: Map<string, number> }>();
let _graphRerankTimeouts = 0;
const _GRAPH_RERANK_TIMEOUT = Symbol("graph-rerank-timeout");

/** Number of graphRerank calls that hit the wall-clock timeout (degraded to text-only). */
export function graphRerankTimeoutCount(): number { return _graphRerankTimeouts; }

export async function graphRerank(candidateIds: string[]): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (!isGraphDbAvailable() || candidateIds.length === 0) return scores;

  const cacheKey = candidateIds.slice().sort().join(",");
  const cached = _graphRerankCache.get(cacheKey);
  if (cached && Date.now() - cached.storedAt <= GRAPH_RERANK_CACHE_TTL_MS) {
    return new Map(cached.scores);
  }

  try {
    // Each OPTIONAL MATCH must be collapsed by its own WITH before the next one
    // expands again. Chained un-aggregated OPTIONAL MATCHes multiply row counts
    // (peers x older x newer x retrievals per candidate) and only collapse at the
    // final count(DISTINCT ...) — correct values, but a cartesian intermediate.
    // That is survivable only while SIMILAR_TO/SUPERSEDES are never written; the
    // moment either starts producing edges it blows the 200 ms budget above.
    // RETRIEVED alone already grows without bound (it is CREATEd, not MERGEd).
    const queryPromise = runCypher(`
      MATCH (m:MemoryRecord) WHERE m.id IN $ids
      OPTIONAL MATCH (m)-[:SIMILAR_TO]-(peer:MemoryRecord)
      WITH m, count(DISTINCT peer) AS peerCount
      OPTIONAL MATCH (m)-[:SUPERSEDES]->(older:MemoryRecord)
      WITH m, peerCount, count(DISTINCT older) AS supersededCount
      OPTIONAL MATCH (m)<-[:SUPERSEDES]-(newer:MemoryRecord)
      WITH m, peerCount, supersededCount, count(DISTINCT newer) AS newerVersionCount
      OPTIONAL MATCH ()-[ret:RETRIEVED {wasUseful: true}]->(m)
      WITH m, peerCount, supersededCount, newerVersionCount,
           count(DISTINCT ret) AS usefulRetrievals
      RETURN
        m.id                           AS id,
        coalesce(m.importance, 0.5)    AS importance,
        coalesce(m.centrality, 0.0)    AS centrality,
        coalesce(m.accessCount, 0)     AS accessCount,
        peerCount                      AS peerCount,
        supersededCount                AS supersededCount,
        newerVersionCount              AS newerVersionCount,
        usefulRetrievals               AS usefulRetrievals
    `, { ids: candidateIds }).catch(() => null); // swallow a late rejection after timeout
    const result = await Promise.race([
      queryPromise,
      new Promise<typeof _GRAPH_RERANK_TIMEOUT>((resolve) => {
        const t = setTimeout(() => resolve(_GRAPH_RERANK_TIMEOUT), GRAPH_RERANK_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);

    if (result === _GRAPH_RERANK_TIMEOUT) { _graphRerankTimeouts++; return scores; }
    if (!result) return scores;

    for (const row of toPlainRecords(result)) {
      const id = String(row["id"] ?? "");
      if (!id) continue;

      const importance        = clamp(asFloat(row["importance"], 0.5));
      const centrality        = clamp(asFloat(row["centrality"], 0.0) * 10); // normalise
      const usefulRetrievals  = asInt(row["usefulRetrievals"], 0);
      const newerVersionCount = asInt(row["newerVersionCount"], 0);
      const supersededCount   = asInt(row["supersededCount"], 0);

      const raw =
        centrality * 0.20
        + importance * 0.20
        + clamp(usefulRetrievals * 0.1) * 0.25
        - (newerVersionCount > 0 ? 0.50 : 0)   // has been superseded → deprioritise
        - (supersededCount    > 0 ? 0.15 : 0);  // references older facts → mild penalty

      scores.set(id, clamp(raw));
    }

    _graphRerankCache.set(cacheKey, { storedAt: Date.now(), scores: new Map(scores) });
    if (_graphRerankCache.size > GRAPH_RERANK_CACHE_MAX) {
      const oldest = _graphRerankCache.keys().next().value;
      if (oldest !== undefined) _graphRerankCache.delete(oldest);
    }
  } catch (err) {
    log.debug({ err }, "Graph rerank query failed");
  }

  return scores;
}

// ── Retrieval tracking ────────────────────────────────────────────────────────

/**
 * Record that an agent retrieved a memory. Increments accessCount and
 * creates a RETRIEVED relationship used by the reranking feedback loop.
 */
export async function graphTrackRetrieval(
  memoryId: string,
  agentName: string,
  sessionId: string,
  rank: number,
): Promise<void> {
  if (!isGraphDbAvailable()) return;

  try {
    await runCypher(`
      MATCH (m:MemoryRecord {id: $id})
      MERGE (a:Agent {name: $agentName})
      CREATE (a)-[:RETRIEVED {
        ts:        $now,
        sessionId: $sessionId,
        rank:      $rank,
        wasUseful: null
      }]->(m)
      SET m.accessCount = coalesce(m.accessCount, 0) + 1
    `, {
      id: memoryId,
      agentName,
      sessionId,
      rank,
      now: new Date().toISOString(),
    }, { write: true });
  } catch (err) {
    log.debug({ err }, "Retrieval tracking failed");
  }
}

// ── FACT auto-promotion ───────────────────────────────────────────────────────

/**
 * Promote a FACT: key = value extracted from agent output into a durable
 * :MemoryRecord node. Creates a SUPERSEDES edge if a previous version of
 * the same fact exists, marking the old one as expired.
 *
 * Facts written here outlive the 4-hour Redis TTL of the swarm memory layer.
 */
export async function graphPromoteFact(
  key: string,
  value: string,
  agentName: string,
  sessionId: string,
): Promise<void> {
  if (!isGraphDbAvailable()) return;

  // Stable ID: same agent + same key always resolves to the same node
  const id = `fact:${agentName}:${key.toLowerCase().replace(/\s+/g, "_").slice(0, 60)}`;
  const now = new Date().toISOString();
  const content = `${key} = ${value}`.slice(0, 1000);

  try {
    // Check for an existing valid fact to create a SUPERSEDES chain
    const existingResult = await runCypher(`
      MATCH (m:MemoryRecord {id: $id})
      WHERE m.validTo IS NULL OR m.validTo > $now
      RETURN m.id AS existingId, m.content AS existingContent
    `, { id, now });

    const existing = existingResult ? toPlainRecords(existingResult) : [];
    const hadPrevious = existing.length > 0 && String(existing[0]?.["existingContent"] ?? "") !== content;

    // Upsert the fact node
    await runCypher(`
      MERGE (m:MemoryRecord {id: $id})
      SET m.content     = $content,
          m.kind        = 'fact',
          m.scope       = 'workspace',
          m.domain      = $agentName,
          m.topic       = $key,
          m.importance  = 0.7,
          m.accessCount = coalesce(m.accessCount, 0),
          m.validTo     = null,
          m.updatedAt   = $now,
          m.createdAt   = coalesce(m.createdAt, $now)
      WITH m
      MERGE (a:Agent {name: $agentName})
      MERGE (a)-[w:WROTE]->(m)
      SET w.scope = 'shared', w.ts = $now
      WITH m
      MERGE (s:Session {id: $sessionId})
      MERGE (s)-[:PRODUCED]->(m)
    `, { id, content, agentName, key, sessionId, now }, { write: true });

    // If the content changed, record the supersession. The fact uses a STABLE id
    // (one node per agent+key), so the MERGE above overwrote the content in place —
    // there is no separate prior-version node to link a SUPERSEDES edge to. Capture
    // the audit trail as properties on the same node instead: the prior value, when
    // it was replaced, and a monotonic revision counter.
    //
    // (The previous query MATCHed two aliases by the SAME id, so both bound to the
    // one node; `oldFact.updatedAt <> $now` was therefore always false and it
    // silently did nothing — no SUPERSEDES edge, no validTo, ever.)
    if (hadPrevious) {
      const previousContent = String(existing[0]?.["existingContent"] ?? "");
      await runCypher(`
        MATCH (m:MemoryRecord {id: $id})
        SET m.previousContent = $previousContent,
            m.supersededAt    = $now,
            m.revision        = coalesce(m.revision, 0) + 1
      `, { id, previousContent, now }, { write: true });
    }
  } catch (err) {
    log.warn({ err, key, agentName }, "FACT graph promotion failed");
  }
}

// ── Feedback loop closure ─────────────────────────────────────────────────────

/**
 * Close the retrieval feedback loop for a successful session.
 *
 * Finds all RETRIEVED edges created for this sessionId where wasUseful is
 * still null, marks them wasUseful=true, and nudges the target memory's
 * importance upward by `boost` (clamped to ≤ 1.0).
 *
 * Call fire-and-forget from sub-agent / orchestrator outcome sinks when a
 * turn completes with outcome=success. The opposite case (unused/stale
 * memories) is handled by graphDecayUnusedMemories so that retrieved memories
 * that never pan out gradually lose rank instead of being marked `false`
 * after a single failure.
 *
 * Returns the number of edges updated. Returns 0 on unavailable graph.
 */
export async function graphMarkSessionRetrievalsUseful(
  sessionId: string,
  opts: { boost?: number } = {},
): Promise<number> {
  if (!isGraphDbAvailable() || !sessionId) return 0;
  const boost = Math.max(0.001, Math.min(0.2, opts.boost ?? 0.05));

  try {
    const result = await runCypher(`
      MATCH (a:Agent)-[ret:RETRIEVED]->(m:MemoryRecord)
      WHERE ret.sessionId = $sessionId AND ret.wasUseful IS NULL
      SET ret.wasUseful = true,
          m.importance  = CASE
            WHEN coalesce(m.importance, 0.5) + $boost > 1.0 THEN 1.0
            ELSE coalesce(m.importance, 0.5) + $boost
          END
      RETURN count(ret) AS marked
    `, { sessionId, boost }, { write: true });

    const marked = asInt(toPlainRecords(result ?? null as never)[0]?.["marked"], 0);
    if (marked > 0) log.debug({ sessionId, marked, boost }, "Retrieval feedback closed");
    return marked;
  } catch (err) {
    log.debug({ err, sessionId }, "Marking session retrievals useful failed");
    return 0;
  }
}

/**
 * Close the retrieval feedback loop for an unsuccessful session.
 *
 * Counterpart to graphMarkSessionRetrievalsUseful: marks the still-pending
 * RETRIEVED edges for this sessionId as wasUseful=false and nudges the target
 * memories' importance downward by `penalty` (clamped to ≥ floor).
 *
 * Used when the turn terminated in failure, an apology, or a stub answer —
 * a stronger signal than the slow decay applied by graphDecayUnusedMemories,
 * because we know the retrieved memories were present and still didn't help.
 *
 * Returns the number of edges updated. Returns 0 on unavailable graph.
 */
export async function graphMarkSessionRetrievalsUnhelpful(
  sessionId: string,
  opts: { penalty?: number; floor?: number } = {},
): Promise<number> {
  if (!isGraphDbAvailable() || !sessionId) return 0;
  const penalty = Math.max(0.001, Math.min(0.2, opts.penalty ?? 0.03));
  const floor = Math.max(0, Math.min(0.5, opts.floor ?? 0.05));

  try {
    const result = await runCypher(`
      MATCH (a:Agent)-[ret:RETRIEVED]->(m:MemoryRecord)
      WHERE ret.sessionId = $sessionId AND ret.wasUseful IS NULL
      SET ret.wasUseful = false,
          m.importance  = CASE
            WHEN coalesce(m.importance, 0.5) - $penalty < $floor THEN $floor
            ELSE coalesce(m.importance, 0.5) - $penalty
          END
      RETURN count(ret) AS marked
    `, { sessionId, penalty, floor }, { write: true });

    const marked = asInt(toPlainRecords(result ?? null as never)[0]?.["marked"], 0);
    if (marked > 0) log.debug({ sessionId, marked, penalty }, "Retrieval negative feedback applied");
    return marked;
  } catch (err) {
    log.debug({ err, sessionId }, "Marking session retrievals unhelpful failed");
    return 0;
  }
}

/**
 * Importance decay for memories that were retrieved repeatedly but never
 * contributed to a useful outcome — and for memories that have not been
 * touched in a long time.
 *
 * Two rules, applied independently:
 *   1. A memory has ≥ minRetrievalsForDecay RETRIEVED edges with wasUseful
 *      still null AND no RETRIEVED edge with wasUseful=true → it is getting
 *      surfaced but is not actually helping. Nudge importance down by decay.
 *   2. A memory has not been updated in ≥ staleDays and has accessCount=0 →
 *      it was never used after being written. Nudge importance down by decay.
 *
 * Importance never falls below the floor (default 0.05) — decayed memories
 * remain addressable by exact ID and may still surface in narrow searches;
 * they just lose their rerank boost.
 *
 * Callers schedule this periodically (e.g. once per day alongside centrality
 * updates). Returns the number of nodes whose importance changed.
 */
export async function graphDecayUnusedMemories(opts: {
  staleDays?: number;
  minRetrievalsForDecay?: number;
  decay?: number;
  floor?: number;
} = {}): Promise<number> {
  if (!isGraphDbAvailable()) return 0;
  const staleDays = Math.max(1, opts.staleDays ?? 14);
  const minRetrievals = Math.max(1, opts.minRetrievalsForDecay ?? 3);
  const decay = Math.max(0.001, Math.min(0.2, opts.decay ?? 0.02));
  const floor = Math.max(0, Math.min(0.5, opts.floor ?? 0.05));
  const cutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString();

  try {
    // Rule 1: retrieved repeatedly but never useful
    const unusefulResult = await runCypher(`
      MATCH (m:MemoryRecord)
      WHERE m.importance > $floor
      OPTIONAL MATCH (m)<-[useful:RETRIEVED]-()
        WHERE useful.wasUseful = true
      OPTIONAL MATCH (m)<-[pending:RETRIEVED]-()
        WHERE pending.wasUseful IS NULL
      WITH m,
           count(DISTINCT useful)  AS usefulCount,
           count(DISTINCT pending) AS pendingCount
      WHERE usefulCount = 0 AND pendingCount >= $minRetrievals
      SET m.importance = CASE
        WHEN m.importance - $decay < $floor THEN $floor
        ELSE m.importance - $decay
      END
      RETURN count(m) AS decayed
    `, { floor, minRetrievals, decay }, { write: true });

    // Rule 2: stale and never accessed
    const staleResult = await runCypher(`
      MATCH (m:MemoryRecord)
      WHERE m.importance > $floor
        AND coalesce(m.accessCount, 0) = 0
        AND coalesce(m.updatedAt, '') < $cutoff
      SET m.importance = CASE
        WHEN m.importance - $decay < $floor THEN $floor
        ELSE m.importance - $decay
      END
      RETURN count(m) AS decayed
    `, { floor, cutoff, decay }, { write: true });

    const decayedUnuseful = asInt(toPlainRecords(unusefulResult ?? null as never)[0]?.["decayed"], 0);
    const decayedStale = asInt(toPlainRecords(staleResult ?? null as never)[0]?.["decayed"], 0);
    const total = decayedUnuseful + decayedStale;
    if (total > 0) log.info({ decayedUnuseful, decayedStale, total }, "Graph importance decay applied");
    return total;
  } catch (err) {
    log.warn({ err }, "Graph importance decay failed");
    return 0;
  }
}

// ── MAGE background jobs ──────────────────────────────────────────────────────

/**
 * Run MAGE betweenness_centrality across all MemoryRecord nodes and write
 * the scores back as node properties. Used by reranking to boost hub memories.
 * Returns the number of nodes updated.
 */
export async function graphUpdateCentrality(): Promise<number> {
  if (!isGraphDbAvailable()) return 0;

  try {
    const result = await runCypher(`
      CALL betweenness_centrality.get(False, True)
      YIELD node, betweenness_centrality
      WITH node, betweenness_centrality
      WHERE 'MemoryRecord' IN labels(node)
      SET node.centrality = betweenness_centrality
      RETURN count(node) AS updated
    `, {}, { write: true });

    const updated = asInt(toPlainRecords(result ?? null as never)[0]?.["updated"], 0);
    if (updated > 0) log.info({ updated }, "Graph centrality updated");
    return updated;
  } catch (err) {
    log.warn({ err }, "Centrality update failed");
    return 0;
  }
}

/**
 * Run MAGE community_detection (Louvain) and write community IDs back to nodes.
 * Nodes in the same community share topic/domain clusters, enabling
 * cluster-aware search and batch outlier analysis.
 * Returns the number of nodes updated.
 */
export async function graphUpdateCommunities(): Promise<number> {
  if (!isGraphDbAvailable()) return 0;

  try {
    const result = await runCypher(`
      CALL community_detection.get()
      YIELD node, community_id
      WITH node, community_id
      WHERE 'MemoryRecord' IN labels(node)
      SET node.communityId = community_id
      RETURN count(node) AS updated
    `, {}, { write: true });

    const updated = asInt(toPlainRecords(result ?? null as never)[0]?.["updated"], 0);
    if (updated > 0) log.info({ updated }, "Graph communities updated");
    return updated;
  } catch (err) {
    log.warn({ err }, "Community detection failed");
    return 0;
  }
}

/**
 * Build SIMILAR_TO edges between MemoryRecord nodes using MemGraph's native
 * vector_search module. Only processes nodes that have embeddings stored.
 *
 * Pass newRecordIds to process only recently-written nodes (incremental mode).
 * Omit to process all nodes written in the past 24 hours (scheduled batch mode).
 *
 * Returns the number of SIMILAR_TO edges created.
 */
export async function graphBuildSimilarityLinks(newRecordIds?: string[]): Promise<number> {
  if (!isGraphDbAvailable()) return 0;

  const matchClause = newRecordIds && newRecordIds.length > 0
    ? "MATCH (m:MemoryRecord) WHERE m.id IN $ids AND m.embedding IS NOT NULL"
    : "MATCH (m:MemoryRecord) WHERE m.embedding IS NOT NULL AND m.updatedAt > $cutoff";

  try {
    // NOTE: explicit WITH clauses are required between MATCH/WHERE → CALL
    // and CALL/YIELD → WHERE on MemGraph (Neo4j tolerates both, MemGraph requires the split form)
    // implicitly but MemGraph rejects it as a parse error.
    const result = await runCypher(`
      ${matchClause}
      WITH m
      CALL vector_search.search("${VECTOR_INDEX_NAME}", 10, m.embedding)
      YIELD node AS candidate, similarity
      WITH m, candidate, similarity
      WHERE candidate.id <> m.id AND similarity > 0.82
      MERGE (m)-[s:SIMILAR_TO]->(candidate)
      SET s.similarity = similarity, s.method = 'embedding'
      RETURN count(s) AS created
    `, {
      ids: newRecordIds ?? [],
      cutoff: new Date(Date.now() - 86_400_000).toISOString(),
    }, { write: true });

    const created = asInt(toPlainRecords(result ?? null as never)[0]?.["created"], 0);
    if (created > 0) log.info({ created }, "Similarity links built");
    return created;
  } catch (err) {
    log.debug({ err }, "Similarity link building failed — vector index may not be populated yet");
    return 0;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function asFloat(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asInt(value: unknown, fallback: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}
