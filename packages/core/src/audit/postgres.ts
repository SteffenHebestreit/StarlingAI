import pg from "pg";
import type { AuditEvent } from "./schema.js";
import { childLogger } from "../logger.js";
import { registerPostgresSink } from "./logger.js";

const log = childLogger("audit:postgres");
const { Pool } = pg;

let _pool: pg.Pool | null = null;

export async function initPostgresAudit(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    log.warn("DATABASE_URL not set — Postgres audit sink disabled");
    return;
  }

  _pool = new Pool({ connectionString: url, max: 5 });

  try {
    await _pool.query(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id          UUID PRIMARY KEY,
        timestamp   TIMESTAMPTZ NOT NULL,
        type        TEXT NOT NULL,
        session_id  TEXT,
        user_id     TEXT,
        channel     TEXT,
        severity    TEXT NOT NULL DEFAULT 'info',
        data        JSONB NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events (session_id);
      CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events (type);
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events (timestamp DESC);
    `);
    log.info("Postgres audit table ready");

    registerPostgresSink(async (event: AuditEvent) => {
      if (!_pool) return;
      await _pool.query(
        `INSERT INTO audit_events (id, timestamp, type, session_id, user_id, channel, severity, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [event.id, event.timestamp, event.type, event.sessionId ?? null,
         event.userId ?? null, event.channel ?? null, event.severity, event.data]
      );
    });
  } catch (err) {
    log.error({ err }, "Failed to initialize Postgres audit — JSONL-only mode");
    _pool = null;
  }
}
