/**
 * The live stores the harvest reads (harvest.ts): the Postgres audit and the Redis session store,
 * read-only. Every Postgres session is opened with default_transaction_read_only, so no statement of
 * this process can write the audit; Redis is only ever asked GET.
 *
 * The lab process unsets the shared-store variables before anything loads (bootstrap.ts); the CLI
 * reads the two addresses first and hands them here, so nothing else in the process reaches them.
 */
import pg from "pg";
import { SESSION_KEY } from "../agent/session-redis.js";
import type { HarvestStores, HistoryMessage, ScorecardRow, TurnEventRow } from "./harvest.js";

const TURN_EVENT_TYPES = ["sub_agent_started", "sub_agent_tool_call", "tool_call_completed", "tool_call_failed"];
const MAX_TURN_EVENTS = 2_000;
/** Every statement on these connections runs in a read-only transaction. */
export const READ_ONLY_SESSION_OPTIONS = "-c default_transaction_read_only=on";

interface RedisGetClient {
  get(key: string): Promise<string | null>;
  quit(): Promise<unknown>;
}

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function openHarvestStores(urls: { databaseUrl: string; redisUrl?: string }): Promise<{ stores: HarvestStores; close(): Promise<void> }> {
  const pool = new pg.Pool({ connectionString: urls.databaseUrl, max: 1, options: READ_ONLY_SESSION_OPTIONS });
  let redis: RedisGetClient | null = null;
  if (urls.redisUrl) {
    const mod = await import("ioredis");
    const IORedis = (mod.default ?? mod) as unknown as new (url: string, opts: Record<string, unknown>) => RedisGetClient;
    redis = new IORedis(urls.redisUrl, { maxRetriesPerRequest: 1, enableReadyCheck: false, lazyConnect: false });
  }

  const stores: HarvestStores = {
    async failedScorecards(sinceIso, limit) {
      const { rows } = await pool.query(
        `SELECT timestamp, session_id, user_id, channel, data FROM audit_events
          WHERE type = 'turn_scorecard' AND data->>'learningOutcome' = 'failure'
            AND timestamp >= $1 AND session_id IS NOT NULL
          ORDER BY timestamp DESC LIMIT $2`,
        [sinceIso, limit],
      );
      return rows.map((row): ScorecardRow => ({
        timestamp: iso(row.timestamp),
        sessionId: String(row.session_id),
        userId: row.user_id ?? null,
        channel: row.channel ?? null,
        data: (row.data ?? {}) as Record<string, unknown>,
      }));
    },
    async turnStart(sessionId, at) {
      const { rows } = await pool.query(
        `SELECT max(timestamp) AS started FROM audit_events
          WHERE type = 'message_received' AND session_id = $1 AND timestamp <= $2`,
        [sessionId, at],
      );
      return rows[0]?.started ? iso(rows[0].started) : null;
    },
    async turnEvents(sessionId, fromIso, toIso) {
      // A sub-agent run's session id carries its root's between colons (sub:<root>:<agent>:<ts>, nested alike).
      const { rows } = await pool.query(
        `SELECT type, timestamp, session_id, data FROM audit_events
          WHERE (session_id = $1 OR session_id LIKE $2 ESCAPE '\\')
            AND timestamp >= $3 AND timestamp <= $4 AND type = ANY($5)
          ORDER BY timestamp LIMIT ${MAX_TURN_EVENTS}`,
        [sessionId, `%:${escapeLike(sessionId)}:%`, fromIso, toIso, TURN_EVENT_TYPES],
      );
      return rows.map((row): TurnEventRow => ({
        type: String(row.type),
        timestamp: iso(row.timestamp),
        sessionId: String(row.session_id),
        data: (row.data ?? {}) as Record<string, unknown>,
      }));
    },
    async sessionHistory(sessionId) {
      if (!redis) return null;
      const raw = await redis.get(SESSION_KEY(sessionId));
      if (!raw) return null;
      try {
        const record = JSON.parse(raw) as { history?: unknown };
        return Array.isArray(record.history) ? record.history as HistoryMessage[] : null;
      } catch {
        return null;
      }
    },
  };

  return {
    stores,
    async close() {
      await pool.end().catch(() => undefined);
      await redis?.quit().catch(() => undefined);
    },
  };
}
