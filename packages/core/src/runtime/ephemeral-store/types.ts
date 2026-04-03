/**
 * Ephemeral Store — unified temporary data storage for agents.
 *
 * Agents store working data here during task execution. All entries have
 * a 24-hour TTL and are purged by a nightly cleanup job.
 *
 * Three backends are supported: Redis (fast KV), PostgreSQL (structured),
 * and MongoDB (flexible documents). The frontend routes by namespace so
 * agents never choose a backend directly.
 */

// ── Namespace → backend routing ─────────────────────────────────────────────
// Each namespace is pinned to a specific backend based on access patterns.

export type EphemeralBackend = "redis" | "postgres" | "mongo";

export const NAMESPACE_ROUTES: Record<string, EphemeralBackend> = {
  // Redis: fast KV, locks, counters, iteration state, queues, leases
  "loop-metrics":      "redis",
  "agent-state":       "redis",
  "dev-session-lease": "redis",
  "agent-kv":          "redis",

  // Postgres: structured records, searchable audit-grade data
  "tool-candidates":     "postgres",
  "promotion-history":   "postgres",
  "test-results":        "postgres",
  "capability-gaps":     "postgres",

  // MongoDB: flexible JSON documents, irregular artifacts
  "tool-drafts":        "mongo",
  "test-fixtures":      "mongo",
  "sandbox-transcripts": "mongo",
  "agent-artifacts":    "mongo",
};

/** Fallback backend when namespace is not explicitly routed */
export const DEFAULT_BACKEND: EphemeralBackend = "redis";

export function routeNamespace(namespace: string): EphemeralBackend {
  return NAMESPACE_ROUTES[namespace] ?? DEFAULT_BACKEND;
}

// ── Data model ──────────────────────────────────────────────────────────────

export interface EphemeralEntry {
  /** Logical grouping: e.g. "tool-drafts", "agent-kv", "test-results" */
  namespace: string;
  /** Unique key within namespace (e.g. "session:abc:my_tool") */
  key: string;
  /** JSON-serializable value */
  value: string;
  /** ISO 8601 timestamp */
  createdAt: string;
  /** ISO 8601 timestamp — entry removed after this time */
  expiresAt: string;
  /** Optional: session that owns this entry */
  sessionId?: string;
  /** Optional: agent that owns this entry */
  agentName?: string;
}

export interface EphemeralQueryFilter {
  namespace: string;
  /** Prefix match on key */
  keyPrefix?: string;
  /** Only entries for this session */
  sessionId?: string;
  /** Only entries for this agent */
  agentName?: string;
  /** Max results (default 100) */
  limit?: number;
}

export interface EphemeralCleanupResult {
  backend: EphemeralBackend;
  deletedCount: number;
  durationMs: number;
  error?: string;
}

// ── Backend interface ───────────────────────────────────────────────────────

export interface EphemeralBackendDriver {
  readonly name: EphemeralBackend;

  /** Initialize connection (lazy, idempotent) */
  init(): Promise<boolean>;

  /** Store or overwrite an entry */
  put(entry: EphemeralEntry): Promise<void>;

  /** Retrieve a single entry by namespace + key */
  get(namespace: string, key: string): Promise<EphemeralEntry | null>;

  /** Query entries by filter */
  query(filter: EphemeralQueryFilter): Promise<EphemeralEntry[]>;

  /** Delete a single entry */
  delete(namespace: string, key: string): Promise<boolean>;

  /** Delete all expired entries. Returns count of deleted records. */
  cleanupExpired(): Promise<EphemeralCleanupResult>;

  /** Graceful shutdown */
  close(): Promise<void>;
}
