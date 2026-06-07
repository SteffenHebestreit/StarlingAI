/**
 * PostgreSQL backend for ephemeral store.
 *
 * Stores structured records in `agent_data_store` table with
 * indexed namespace/key lookups and TTL-based expiration.
 *
 * Reuses pg.Pool pattern from audit/postgres.ts.
 */
import pg from "pg";
import { childLogger } from "../../logger.js";
import type {
  EphemeralBackendDriver,
  EphemeralCleanupResult,
  EphemeralEntry,
  EphemeralQueryFilter,
} from "./types.js";

const log = childLogger("ephemeral:postgres");
const { Pool } = pg;

let _pool: pg.Pool | null = null;
let _initialized = false;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS agent_data_store (
    namespace    TEXT NOT NULL,
    key          TEXT NOT NULL,
    value        TEXT NOT NULL,
    session_id   TEXT,
    agent_name   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (namespace, key)
  );
  CREATE INDEX IF NOT EXISTS idx_ads_expires ON agent_data_store (expires_at);
  CREATE INDEX IF NOT EXISTS idx_ads_session ON agent_data_store (session_id) WHERE session_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_ads_agent   ON agent_data_store (agent_name) WHERE agent_name IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_ads_ns_prefix ON agent_data_store (namespace, key text_pattern_ops);
`;

async function getPool(): Promise<pg.Pool | null> {
  if (_initialized) return _pool;

  const url = process.env["DATABASE_URL"];
  if (!url) {
    _initialized = true;
    return null;
  }

  try {
    _pool = new Pool({ connectionString: url, max: 3 });
    await _pool.query(CREATE_TABLE_SQL);
    _initialized = true;
    log.info("Postgres ephemeral store table ready");
    return _pool;
  } catch (err) {
    log.error({ err }, "Failed to initialize Postgres ephemeral store");
    _pool = null;
    _initialized = true;
    return null;
  }
}

export const postgresBackend: EphemeralBackendDriver = {
  name: "postgres",

  async init(): Promise<boolean> {
    return (await getPool()) !== null;
  },

  async put(entry: EphemeralEntry): Promise<void> {
    const pool = await getPool();
    if (!pool) throw new Error("Postgres not available");

    await pool.query(
      `INSERT INTO agent_data_store (namespace, key, value, session_id, agent_name, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (namespace, key)
       DO UPDATE SET value = $3, session_id = $4, agent_name = $5, created_at = $6, expires_at = $7`,
      [
        entry.namespace,
        entry.key,
        entry.value,
        entry.sessionId ?? null,
        entry.agentName ?? null,
        entry.createdAt,
        entry.expiresAt,
      ],
    );
  },

  async get(namespace: string, key: string): Promise<EphemeralEntry | null> {
    const pool = await getPool();
    if (!pool) return null;

    const { rows } = await pool.query(
      `SELECT namespace, key, value, session_id, agent_name, created_at, expires_at
       FROM agent_data_store
       WHERE namespace = $1 AND key = $2 AND expires_at > NOW()`,
      [namespace, key],
    );

    if (rows.length === 0) return null;
    return rowToEntry(rows[0]);
  },

  async query(filter: EphemeralQueryFilter): Promise<EphemeralEntry[]> {
    const pool = await getPool();
    if (!pool) return [];

    const limit = filter.limit ?? 100;
    const conditions: string[] = ["namespace = $1", "expires_at > NOW()"];
    const params: unknown[] = [filter.namespace];
    let idx = 2;

    if (filter.keyPrefix) {
      conditions.push(`key LIKE $${idx}`);
      params.push(`${filter.keyPrefix}%`);
      idx++;
    }
    if (filter.sessionId) {
      conditions.push(`session_id = $${idx}`);
      params.push(filter.sessionId);
      idx++;
    }
    if (filter.agentName) {
      conditions.push(`agent_name = $${idx}`);
      params.push(filter.agentName);
      idx++;
    }

    params.push(limit);
    const sql = `
      SELECT namespace, key, value, session_id, agent_name, created_at, expires_at
      FROM agent_data_store
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx}
    `;

    const { rows } = await pool.query(sql, params);
    return rows.map(rowToEntry);
  },

  async delete(namespace: string, key: string): Promise<boolean> {
    const pool = await getPool();
    if (!pool) return false;

    const { rowCount } = await pool.query(
      `DELETE FROM agent_data_store WHERE namespace = $1 AND key = $2`,
      [namespace, key],
    );
    return (rowCount ?? 0) > 0;
  },

  async cleanupExpired(): Promise<EphemeralCleanupResult> {
    const start = Date.now();
    const pool = await getPool();
    if (!pool) {
      return { backend: "postgres", deletedCount: 0, durationMs: 0, error: "not connected" };
    }

    try {
      const { rowCount } = await pool.query(
        `DELETE FROM agent_data_store WHERE expires_at <= NOW()`,
      );
      return { backend: "postgres", deletedCount: rowCount ?? 0, durationMs: Date.now() - start };
    } catch (err) {
      return { backend: "postgres", deletedCount: 0, durationMs: Date.now() - start, error: String(err) };
    }
  },

  async close(): Promise<void> {
    if (_pool) {
      await _pool.end();
      _pool = null;
    }
    _initialized = false;
  },
};

 
function rowToEntry(row: any): EphemeralEntry {
  return {
    namespace: row.namespace,
    key: row.key,
    value: row.value,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    sessionId: row.session_id ?? undefined,
    agentName: row.agent_name ?? undefined,
  };
}
