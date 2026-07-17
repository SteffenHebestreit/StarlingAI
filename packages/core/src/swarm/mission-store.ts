/**
 * Mission store — durable root of one user-visible objective (MIS-201, ADR-001).
 *
 * Event-sourced core: the append-only mission_events stream is the source of
 * truth; the missions row is a materialized projection updated in the SAME
 * transaction as the append (read-your-writes without distributed machinery).
 * Every append is optimistically versioned and idempotency-keyed; a projection
 * can always be rebuilt from events (`rebuildMissionProjection`).
 *
 * Backends follow the repo convention: PostgreSQL (DATABASE_URL) is the system
 * of record; a process-local adapter serves single-process/dev and tests.
 * Rollout is flag-gated (`mission.store`: off | shadow) — "shadow" records
 * mission events from the swarm bus without changing any execution behavior.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { onSwarmEvent, type SwarmEvent } from "./bus.js";
import { deriveSharedSessionId } from "../tools/memory.js";

const { Pool } = pg;
const log = childLogger("swarm:mission-store");

// ── Types (plan: "Canonical control-plane data model") ──────────────────────

export type MissionStatus = "active" | "completed" | "failed" | "cancelled";

export interface MissionRecord {
  id: string;
  rootSessionId: string;
  tenantId: string;
  userId?: string;
  workspacePath?: string;
  objective: string;
  status: MissionStatus;
  /** Optimistic-concurrency version — bumps on every accepted append. */
  version: number;
  /** Last applied event sequence (per-mission monotonic). */
  eventCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MissionEventRecord {
  missionId: string;
  sequence: number;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  ts: string;
}

export interface MissionScope {
  rootSessionId: string;
  tenantId?: string;
  userId?: string;
  workspacePath?: string;
  objective?: string;
}

export interface AppendMissionEventInput {
  type: string;
  actor?: string;
  payload?: Record<string, unknown>;
  /** Crash-retry safety: a second append with the same key is a no-op that
   *  returns the original sequence. */
  idempotencyKey?: string;
}

export type AppendMissionEventResult =
  | { accepted: true; sequence: number; duplicate?: false }
  | { accepted: true; sequence: number; duplicate: true }
  | { accepted: false; reason: "version_conflict"; currentVersion: number };

export interface MissionStore {
  getOrCreateMissionForSession(scope: MissionScope): Promise<MissionRecord>;
  getMission(missionId: string): Promise<MissionRecord | null>;
  getMissionBySession(rootSessionId: string): Promise<MissionRecord | null>;
  appendMissionEvent(missionId: string, event: AppendMissionEventInput, opts?: { expectedVersion?: number }): Promise<AppendMissionEventResult>;
  listMissionEvents(missionId: string, opts?: { fromSequence?: number; limit?: number }): Promise<MissionEventRecord[]>;
  /** UX-501: most-recently-updated missions first, for the flight recorder list. */
  listMissions(opts?: { limit?: number }): Promise<MissionRecord[]>;
  /** Recompute the projection purely from events (event log is the truth). */
  rebuildMissionProjection(missionId: string): Promise<MissionRecord | null>;
}

/** Status transitions are derived ONLY from events (ADR-001 invariant). */
export function reduceMissionStatus(current: MissionStatus, eventType: string): MissionStatus {
  switch (eventType) {
    case "mission_completed": return "completed";
    case "mission_failed": return "failed";
    case "mission_cancelled": return "cancelled";
    default: return current;
  }
}

// ── Local adapter (single-process/dev/tests) ────────────────────────────────

class LocalMissionStore implements MissionStore {
  private readonly missions = new Map<string, MissionRecord>();
  private readonly bySession = new Map<string, string>();
  private readonly events = new Map<string, MissionEventRecord[]>();
  private readonly idempotency = new Map<string, Map<string, number>>();

  /** Return copies, never live internals — parity with Postgres row semantics,
   *  and callers must not be able to mutate the projection out-of-band. */
  private snapshot(mission: MissionRecord): MissionRecord {
    return { ...mission };
  }

  async getOrCreateMissionForSession(scope: MissionScope): Promise<MissionRecord> {
    const existingId = this.bySession.get(scope.rootSessionId);
    if (existingId) {
      const existing = this.missions.get(existingId)!;
      // Mirror the Postgres objective backfill: first non-empty objective wins.
      const candidate = scope.objective?.trim();
      if (candidate && existing.objective === "") existing.objective = candidate;
      return this.snapshot(existing);
    }
    // Bounded growth: any bus peer can name sessions — cap retained missions.
    if (this.missions.size >= 500) {
      const oldest = [...this.missions.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))[0];
      if (oldest) {
        this.missions.delete(oldest.id);
        this.bySession.delete(oldest.rootSessionId);
        this.events.delete(oldest.id);
        this.idempotency.delete(oldest.id);
      }
    }
    const now = new Date().toISOString();
    const mission: MissionRecord = {
      id: randomUUID(),
      rootSessionId: scope.rootSessionId,
      tenantId: scope.tenantId?.trim() || "default",
      ...(scope.userId ? { userId: scope.userId } : {}),
      ...(scope.workspacePath ? { workspacePath: scope.workspacePath } : {}),
      objective: scope.objective ?? "",
      status: "active",
      version: 0,
      eventCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.missions.set(mission.id, mission);
    this.bySession.set(scope.rootSessionId, mission.id);
    this.events.set(mission.id, []);
    this.idempotency.set(mission.id, new Map());
    await this.appendMissionEvent(mission.id, { type: "mission_created", actor: "system", payload: { objective: mission.objective } });
    return this.snapshot(this.missions.get(mission.id)!);
  }

  async getMission(missionId: string): Promise<MissionRecord | null> {
    const mission = this.missions.get(missionId);
    return mission ? this.snapshot(mission) : null;
  }

  async getMissionBySession(rootSessionId: string): Promise<MissionRecord | null> {
    const id = this.bySession.get(rootSessionId);
    const mission = id ? this.missions.get(id) : undefined;
    return mission ? this.snapshot(mission) : null;
  }

  async listMissions(opts: { limit?: number } = {}): Promise<MissionRecord[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    return [...this.missions.values()]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, limit)
      .map((m) => this.snapshot(m));
  }

  async appendMissionEvent(missionId: string, event: AppendMissionEventInput, opts: { expectedVersion?: number } = {}): Promise<AppendMissionEventResult> {
    const mission = this.missions.get(missionId);
    if (!mission) return { accepted: false, reason: "version_conflict", currentVersion: -1 };
    if (typeof opts.expectedVersion === "number" && opts.expectedVersion !== mission.version) {
      return { accepted: false, reason: "version_conflict", currentVersion: mission.version };
    }
    const idem = this.idempotency.get(missionId)!;
    if (event.idempotencyKey) {
      const existing = idem.get(event.idempotencyKey);
      if (existing !== undefined) return { accepted: true, sequence: existing, duplicate: true };
    }
    const sequence = mission.eventCount + 1;
    const record: MissionEventRecord = {
      missionId,
      sequence,
      type: event.type,
      actor: event.actor ?? "",
      payload: event.payload ?? {},
      ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
      ts: new Date().toISOString(),
    };
    this.events.get(missionId)!.push(record);
    if (event.idempotencyKey) idem.set(event.idempotencyKey, sequence);
    mission.eventCount = sequence;
    mission.version += 1;
    mission.status = reduceMissionStatus(mission.status, event.type);
    mission.updatedAt = record.ts;
    return { accepted: true, sequence };
  }

  async listMissionEvents(missionId: string, opts: { fromSequence?: number; limit?: number } = {}): Promise<MissionEventRecord[]> {
    const all = this.events.get(missionId) ?? [];
    const from = opts.fromSequence ?? 0;
    const filtered = all.filter((event) => event.sequence > from);
    return typeof opts.limit === "number" ? filtered.slice(0, Math.max(0, opts.limit)) : filtered;
  }

  async rebuildMissionProjection(missionId: string): Promise<MissionRecord | null> {
    const mission = this.missions.get(missionId);
    if (!mission) return null;
    const events = this.events.get(missionId) ?? [];
    let status: MissionStatus = "active";
    for (const event of events) status = reduceMissionStatus(status, event.type);
    mission.status = status;
    mission.eventCount = events.length ? events[events.length - 1]!.sequence : 0;
    return this.snapshot(mission);
  }

  reset(): void {
    this.missions.clear();
    this.bySession.clear();
    this.events.clear();
    this.idempotency.clear();
  }
}

// ── PostgreSQL adapter (system of record) ───────────────────────────────────

class PostgresMissionStore implements MissionStore {
  private readonly pool: pg.Pool;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 5 });
  }

  /**
   * Memoized, cross-process-safe init. A plain boolean guard let N concurrent
   * first-use callers race the DDL (CREATE TABLE IF NOT EXISTS is not
   * concurrency-safe in Postgres) — the loser's throw silently fell back to the
   * process-local adapter, splitting one session's missions across backends and
   * letting enforce-mode budgets run against a fresh empty ledger. The advisory
   * lock serializes DDL across PROCESSES; the memoized promise serializes it
   * in-process and clears on failure so later calls retry instead of degrading.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initPromise ??= this.runDdl()
      .then(() => { this.initialized = true; })
      .catch((error) => { this.initPromise = null; throw error; });
    return this.initPromise;
  }

  private async runDdl(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(7264510001)"); // constant app-wide DDL lock
      await client.query(`
      CREATE TABLE IF NOT EXISTS missions (
        id               UUID PRIMARY KEY,
        root_session_id  TEXT NOT NULL UNIQUE,
        tenant_id        TEXT NOT NULL DEFAULT 'default',
        user_id          TEXT,
        workspace_path   TEXT,
        objective        TEXT NOT NULL DEFAULT '',
        status           TEXT NOT NULL DEFAULT 'active',
        version          INTEGER NOT NULL DEFAULT 0,
        event_count      INTEGER NOT NULL DEFAULT 0,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS mission_events (
        mission_id       UUID NOT NULL REFERENCES missions(id),
        sequence         INTEGER NOT NULL,
        type             TEXT NOT NULL,
        actor            TEXT NOT NULL DEFAULT '',
        payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
        idempotency_key  TEXT,
        ts               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (mission_id, sequence)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_events_idem
        ON mission_events (mission_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_missions_session ON missions (root_session_id);
    `);
      await client.query("COMMIT");
      log.info("Mission store tables ready");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* already rolled back */ }
      // A concurrent creator (another process past the advisory lock first)
      // already won: duplicate_table/duplicate_object/unique_violation on the
      // catalog mean the schema EXISTS — that is success, not failure.
      const code = (error as { code?: string }).code;
      if (code === "42P07" || code === "23505" || code === "42710") {
        log.info({ code }, "Mission store tables already created by a concurrent process");
        return;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private rowToMission(row: Record<string, unknown>): MissionRecord {
    return {
      id: String(row["id"]),
      rootSessionId: String(row["root_session_id"]),
      tenantId: String(row["tenant_id"]),
      ...(row["user_id"] ? { userId: String(row["user_id"]) } : {}),
      ...(row["workspace_path"] ? { workspacePath: String(row["workspace_path"]) } : {}),
      objective: String(row["objective"] ?? ""),
      status: String(row["status"]) as MissionStatus,
      version: Number(row["version"]),
      eventCount: Number(row["event_count"]),
      createdAt: new Date(row["created_at"] as string | Date).toISOString(),
      updatedAt: new Date(row["updated_at"] as string | Date).toISOString(),
    };
  }

  async getOrCreateMissionForSession(scope: MissionScope): Promise<MissionRecord> {
    await this.init();
    const existing = await this.getMissionBySession(scope.rootSessionId);
    if (existing) {
      await this.maybeBackfillObjective(existing, scope.objective);
      return (await this.getMission(existing.id))!;
    }
    const id = randomUUID();
    // Creation and its mission_created event commit ATOMICALLY — a crash between
    // them can neither lose the creation event nor invert sequences, and
    // concurrent creators race on UNIQUE(root_session_id): loser reads the winner.
    const client = await this.pool.connect();
    let created = false;
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO missions (id, root_session_id, tenant_id, user_id, workspace_path, objective, version, event_count)
         VALUES ($1, $2, $3, $4, $5, $6, 1, 1)
         ON CONFLICT (root_session_id) DO NOTHING
         RETURNING id`,
        [id, scope.rootSessionId, scope.tenantId?.trim() || "default", scope.userId ?? null, scope.workspacePath ?? null, scope.objective ?? ""],
      );
      if (inserted.rows.length > 0) {
        await client.query(
          `INSERT INTO mission_events (mission_id, sequence, type, actor, payload, idempotency_key)
           VALUES ($1, 1, 'mission_created', 'system', $2::jsonb, $3)`,
          [id, JSON.stringify({ objective: scope.objective ?? "" }), `mission_created:${id}`],
        );
        created = true;
      }
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    } finally {
      client.release();
    }
    if (created) return (await this.getMission(id))!;
    const winner = (await this.getMissionBySession(scope.rootSessionId))!;
    await this.maybeBackfillObjective(winner, scope.objective);
    return (await this.getMission(winner.id))!;
  }

  /** First non-empty objective wins (race-safe via the WHERE guard): the budget
   *  path creates missions with no objective; the first task event backfills it. */
  private async maybeBackfillObjective(mission: MissionRecord, objective?: string): Promise<void> {
    const candidate = objective?.trim();
    if (!candidate || mission.objective !== "") return;
    try {
      await this.pool.query(
        `UPDATE missions SET objective = $2, updated_at = NOW() WHERE id = $1 AND objective = ''`,
        [mission.id, candidate],
      );
    } catch { /* backfill is best-effort */ }
  }

  async getMission(missionId: string): Promise<MissionRecord | null> {
    await this.init();
    const result = await this.pool.query(`SELECT * FROM missions WHERE id = $1`, [missionId]);
    return result.rows.length ? this.rowToMission(result.rows[0]) : null;
  }

  async getMissionBySession(rootSessionId: string): Promise<MissionRecord | null> {
    await this.init();
    const result = await this.pool.query(`SELECT * FROM missions WHERE root_session_id = $1`, [rootSessionId]);
    return result.rows.length ? this.rowToMission(result.rows[0]) : null;
  }

  async listMissions(opts: { limit?: number } = {}): Promise<MissionRecord[]> {
    await this.init();
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    const result = await this.pool.query(`SELECT * FROM missions ORDER BY updated_at DESC LIMIT $1`, [limit]);
    return result.rows.map((row) => this.rowToMission(row));
  }

  async appendMissionEvent(missionId: string, event: AppendMissionEventInput, opts: { expectedVersion?: number } = {}): Promise<AppendMissionEventResult> {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        `SELECT version, event_count, status FROM missions WHERE id = $1 FOR UPDATE`,
        [missionId],
      );
      if (current.rows.length === 0) {
        await client.query("ROLLBACK");
        return { accepted: false, reason: "version_conflict", currentVersion: -1 };
      }
      const version = Number(current.rows[0].version);
      const eventCount = Number(current.rows[0].event_count);
      const status = String(current.rows[0].status) as MissionStatus;
      if (typeof opts.expectedVersion === "number" && opts.expectedVersion !== version) {
        await client.query("ROLLBACK");
        return { accepted: false, reason: "version_conflict", currentVersion: version };
      }
      if (event.idempotencyKey) {
        const dup = await client.query(
          `SELECT sequence FROM mission_events WHERE mission_id = $1 AND idempotency_key = $2`,
          [missionId, event.idempotencyKey],
        );
        if (dup.rows.length > 0) {
          await client.query("ROLLBACK");
          return { accepted: true, sequence: Number(dup.rows[0].sequence), duplicate: true };
        }
      }
      const sequence = eventCount + 1;
      await client.query(
        `INSERT INTO mission_events (mission_id, sequence, type, actor, payload, idempotency_key)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [missionId, sequence, event.type, event.actor ?? "", JSON.stringify(event.payload ?? {}), event.idempotencyKey ?? null],
      );
      await client.query(
        `UPDATE missions SET event_count = $2, version = version + 1, status = $3, updated_at = NOW() WHERE id = $1`,
        [missionId, sequence, reduceMissionStatus(status, event.type)],
      );
      await client.query("COMMIT");
      return { accepted: true, sequence };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async listMissionEvents(missionId: string, opts: { fromSequence?: number; limit?: number } = {}): Promise<MissionEventRecord[]> {
    await this.init();
    const limit = Math.max(1, Math.min(1_000, opts.limit ?? 500));
    const result = await this.pool.query(
      `SELECT * FROM mission_events WHERE mission_id = $1 AND sequence > $2 ORDER BY sequence ASC LIMIT $3`,
      [missionId, opts.fromSequence ?? 0, limit],
    );
    return result.rows.map((row: Record<string, unknown>) => ({
      missionId: String(row["mission_id"]),
      sequence: Number(row["sequence"]),
      type: String(row["type"]),
      actor: String(row["actor"] ?? ""),
      payload: (row["payload"] ?? {}) as Record<string, unknown>,
      ...(row["idempotency_key"] ? { idempotencyKey: String(row["idempotency_key"]) } : {}),
      ts: new Date(row["ts"] as string | Date).toISOString(),
    }));
  }

  async rebuildMissionProjection(missionId: string): Promise<MissionRecord | null> {
    await this.init();
    // Page through the FULL event log — a capped single read would regress
    // event_count below the true tail and brick appends on PK collisions.
    let status: MissionStatus = "active";
    let lastSequence = 0;
    let sawAny = false;
    for (;;) {
      const batch = await this.listMissionEvents(missionId, { fromSequence: lastSequence, limit: 1_000 });
      if (batch.length === 0) break;
      sawAny = true;
      for (const event of batch) status = reduceMissionStatus(status, event.type);
      lastSequence = batch[batch.length - 1]!.sequence;
      if (batch.length < 1_000) break;
    }
    if (!sawAny) return await this.getMission(missionId);
    await this.pool.query(
      `UPDATE missions SET status = $2, event_count = $3, updated_at = NOW() WHERE id = $1`,
      [missionId, status, lastSequence],
    );
    return await this.getMission(missionId);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ── Facade + rollout flag ────────────────────────────────────────────────────

let _local: LocalMissionStore | null = null;
let _postgres: PostgresMissionStore | null = null;

export async function getMissionStore(): Promise<MissionStore> {
  const url = process.env["DATABASE_URL"];
  if (url) {
    if (!_postgres) _postgres = new PostgresMissionStore(url);
    try {
      await _postgres.init();
      return _postgres;
    } catch (error) {
      log.warn({ error }, "Mission store Postgres unavailable — using process-local adapter");
    }
  }
  if (!_local) _local = new LocalMissionStore();
  return _local;
}

/** Reset all state — for use in tests only. */
export async function resetMissionStoreForTests(): Promise<void> {
  _local?.reset();
  _local = null;
  if (_postgres) {
    try { await _postgres.close(); } catch { /* ignore */ }
    _postgres = null;
  }
}

// ── Swarm-event bridge (shadow mode) ─────────────────────────────────────────

const MISSION_TASK_EVENTS = new Set<string>(["task_claimed", "task_completed", "task_partial", "task_failed"]);
let _bridgeStop: (() => void) | null = null;

/**
 * Shadow-mode bridge (mission.store = "shadow"): records task-lifecycle swarm
 * events as mission events without changing any execution behavior — the
 * additive first rollout stage the plan prescribes. Bus event ids double as
 * idempotency keys, so a Redis-delivered duplicate of a locally-emitted event
 * cannot double-append.
 */
export function startMissionEventBridge(): () => void {
  if (_bridgeStop) return _bridgeStop;
  const off = onSwarmEvent((event: SwarmEvent) => {
    if (!MISSION_TASK_EVENTS.has(event.type)) return;
    void recordSwarmEvent(event).catch((error) => {
      log.debug({ error, type: event.type }, "Mission event bridge append failed (shadow mode — non-fatal)");
    });
  });
  _bridgeStop = () => {
    off();
    _bridgeStop = null;
  };
  log.info("Mission event bridge started (shadow mode)");
  return _bridgeStop;
}

async function recordSwarmEvent(event: SwarmEvent): Promise<void> {
  if (!event.sessionId) return; // a mission is rooted in a session
  const store = await getMissionStore();
  const mission = await store.getOrCreateMissionForSession({
    rootSessionId: deriveSharedSessionId(event.sessionId),
    objective: event.task ?? "",
  });
  await store.appendMissionEvent(mission.id, {
    type: event.type,
    actor: event.agentName ?? "",
    payload: {
      ...(event.taskId ? { taskId: event.taskId } : {}),
      ...(event.task ? { task: event.task } : {}),
      ...(event.data ? { data: event.data } : {}),
    },
    idempotencyKey: event.id,
  });
}

/** Config-gated boot hook: no-op unless mission.store is enabled. */
export function maybeStartMissionEventBridge(): void {
  try {
    if (getConfig().mission.store !== "off") startMissionEventBridge();
  } catch { /* config not loaded yet — caller retries after load */ }
}
