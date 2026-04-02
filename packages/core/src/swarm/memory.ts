/**
 * Collective Memory — session-scoped shared state for swarm sub-agents.
 *
 * Agents within the same parent session can publish "shared facts" that are
 * automatically injected as context into subsequent sub-agent invocations.
 * This eliminates redundant work: if agent A already resolved a hostname or
 * fetched an API response, agent B can read that result directly.
 *
 * Storage layout (Redis):
 *   starlingai:mem:{sessionId}:facts      — Hash  (key → value strings)
 *   starlingai:mem:{sessionId}:results    — List  (JSON entries, newest last)
 *   starlingai:mem:{sessionId}:messages   — List  (JSON entries, pending direct messages)
 *
 * Both keys expire after SESSION_TTL_S (4 h). When Redis is absent, an
 * in-process Map provides the same API with process-lifetime scope.
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

// ── Redis client (lazy, reuses REDIS_URL) ────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _redis: any = null;
let _redisReady = false;

async function getRedis(): Promise<unknown | null> {
  if (_redisReady) return _redis;
  if (_redis !== null) return null;

  const url = process.env["REDIS_URL"];
  if (!url) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

/**
 * Write a shared fact for the session.
 * key: short identifier, e.g. "resolved_hostname" or "user_email"
 * value: the fact value (truncated to FACT_VALUE_MAX chars)
 */
export async function writeSharedFact(sessionId: string, key: string, value: string): Promise<void> {
  const safeVal = value.slice(0, FACT_VALUE_MAX);
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

  if (opts.provider && opts.embeddingModel) {
    try {
      const cache = await buildFactEmbeddingCache(sessionId, entries, opts.provider, opts.embeddingModel);
      const [queryVector] = await opts.provider.embed([trimmedQuery], opts.embeddingModel);
      if (!queryVector) return [];

      return cache
        .map((entry) => ({
          key: entry.key,
          value: entry.value,
          score: cosineSimilarity(queryVector, entry.vector),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, maxResults);
    } catch (err) {
      log.warn({ err, query: trimmedQuery }, "Semantic shared-fact search failed — falling back to keyword match");
    }
  }

  return keywordSearchSharedFacts(entries, trimmedQuery, maxResults);
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

// ── Direct agent messages ───────────────────────────────────────────────────

export async function appendAgentMessage(entry: AgentMessage & { sessionId: string }): Promise<void> {
  const { sessionId, ...rest } = entry;
  const safeEntry: AgentMessage = {
    ...rest,
    content: rest.content.slice(0, RESULT_CONTENT_MAX),
  };
  const redis = await getRedis();

  if (redis) {
    try {
      const key = messagesKey(sessionId);
      await (redis as { rpush: (k: string, v: string) => Promise<void> })
        .rpush(key, JSON.stringify(safeEntry));
      await (redis as { ltrim: (k: string, s: number, e: number) => Promise<void> })
        .ltrim(key, -RESULTS_MAX, -1);
      await (redis as { expire: (k: string, ttl: number) => Promise<void> }).expire(key, SESSION_TTL_S);
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

export async function consumeAgentMessages(sessionId: string, agentName: string): Promise<AgentMessage[]> {
  const redis = await getRedis();
  if (redis) {
    try {
      const key = messagesKey(sessionId);
      const raw = await (redis as { lrange: (k: string, s: number, e: number) => Promise<string[]> })
        .lrange(key, 0, -1);
      const parsed = raw
        .map((value) => {
          try {
            return JSON.parse(value) as AgentMessage;
          } catch {
            return null;
          }
        })
        .filter((value): value is AgentMessage => value !== null);

      const matched = parsed.filter((message) => message.toAgent === agentName);
      const remaining = parsed.filter((message) => message.toAgent !== agentName);

      await (redis as { del: (k: string) => Promise<void> }).del(key);
      if (remaining.length > 0) {
        await (redis as { rpush: (k: string, ...v: string[]) => Promise<void> })
          .rpush(key, ...remaining.map((message) => JSON.stringify(message)));
        await (redis as { expire: (k: string, ttl: number) => Promise<void> }).expire(key, SESSION_TTL_S);
      }

      return matched;
    } catch (err) {
      log.warn({ err, agentName }, "consumeAgentMessages Redis failed — using in-process");
    }
  }

  const list = _messages.get(sessionId) ?? [];
  const matched = list.filter((message) => message.toAgent === agentName);
  const remaining = list.filter((message) => message.toAgent !== agentName);
  if (remaining.length > 0) {
    _messages.set(sessionId, remaining);
  } else {
    _messages.delete(sessionId);
  }
  return matched;
}

export function getAgentMessageBacklogSnapshot(): AgentMessageBacklogSnapshot[] {
  return [..._messages.entries()]
    .map(([sessionId, messages]) => ({
      sessionId,
      pending: messages.length,
      targets: messages.reduce<Record<string, number>>((acc, message) => {
        acc[message.toAgent] = (acc[message.toAgent] ?? 0) + 1;
        return acc;
      }, {}),
    }))
    .filter((entry) => entry.pending > 0)
    .sort((left, right) => right.pending - left.pending || left.sessionId.localeCompare(right.sessionId));
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
  opts: { includeFacts?: boolean; includeResults?: boolean; maxResults?: number; agentName?: string } = {},
): Promise<string> {
  const { includeFacts = true, includeResults = true, maxResults = 5, agentName } = opts;

  const sections: string[] = [];

  if (agentName) {
    const messages = await consumeAgentMessages(sessionId, agentName);
    if (messages.length > 0) {
      sections.push(
        "## Direct Messages (from other agents this session)\n" +
        messages.map((message) => `- **${message.fromAgent}**: ${message.content}`).join("\n"),
      );
    }
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
  _factEmbeddingCache.clear();
  if (_redis) {
    try { await (_redis as { quit: () => Promise<void> }).quit(); } catch { /* ignore */ }
  }
  _redis = null;
  _redisReady = false;
}

async function buildFactEmbeddingCache(
  sessionId: string,
  entries: Array<[string, string]>,
  provider: LMStudioProvider,
  embeddingModel: string,
): Promise<Array<{ key: string; value: string; vector: Float32Array }>> {
  const signature = entries
    .slice()
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("\n");

  const cached = _factEmbeddingCache.get(sessionId);
  if (cached && cached.signature === signature) {
    return cached.vectors;
  }

  const documents = entries.map(([key, value]) => `${key}: ${value}`);
  const vectors = await provider.embed(documents, embeddingModel);
  const prepared = entries.map(([key, value], index) => ({
    key,
    value,
    vector: vectors[index]!,
  }));
  _factEmbeddingCache.set(sessionId, { signature, vectors: prepared });
  return prepared;
}

function keywordSearchSharedFacts(entries: Array<[string, string]>, query: string, maxResults: number): SharedFactMatch[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries
    .map(([key, value]) => {
      const haystack = `${key} ${value}`.toLowerCase();
      const matched = tokens.filter((token) => haystack.includes(token)).length;
      return { key, value, score: tokens.length > 0 ? matched / tokens.length : 0 };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxResults);
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
