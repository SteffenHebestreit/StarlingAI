# ADR-001: Mission event store and projection consistency model

**Status:** proposed (design for `MIS-201`; nothing implemented yet)
**Date:** 2026-07-16
**Plan reference:** [agent-swarm-development-plan-2026-07.md](../agent-swarm-development-plan-2026-07.md) — "Canonical control-plane data model", packages `MIS-201`/`MIS-202`, R2.

## Context

Mission state today is spread across session transcripts, audit JSONL, Redis keys, in-process swarm state, task checkpoints, and artifacts. Nothing durable owns the lifecycle of one user-visible objective, so restarts lose ownership context, operators cannot replay decisions, and budgets/evidence/receipts have no root entity to attach to.

## Decision

### Event-sourced core, projected views

- The **append-only `MissionEvent` stream is the source of truth** for mission lifecycle: `sequence`, `missionId`, `type`, `actor`, `timestamp`, `payload/ref`, trace context. Terminal mission history is never derived solely from mutable rows.
- **Materialized projections** (`Mission`, `MissionTask`, `Attempt`, `BudgetAccount` balances, status views) are derived from events and carry the `sequence` they reflect. Projections are rebuildable; a projection/event divergence is a diagnostic event, and the event log wins.
- Writes append the event and update the projection **in one PostgreSQL transaction** when Postgres is configured. This gives read-your-writes on the projection without distributed-transaction machinery.

### Storage responsibility (mirrors the plan)

- **PostgreSQL**: events + projections + receipts — the durable system of record.
- **Redis**: leases, budget atomics, queues/streams, hot projections. Never the only copy of terminal history.
- **Object/workspace storage**: artifacts and large raw evidence by content hash; DB rows carry references + integrity hashes.
- **Single-process mode**: a documented local adapter (SQLite or JSON-per-mission under the state dir) with the same event-first API. Clustered modes fail readiness when Postgres/Redis are unavailable (DST-101), never silently degrading.

### Consistency choices

- **Per-mission total order**: `sequence` is a per-mission monotonic integer allocated inside the append transaction (no global ordering requirement across missions).
- **Optimistic concurrency**: every status-mutating append carries the expected current projection version; a mismatch rejects the append (caller re-reads and retries). Attempt-terminal events additionally carry the lease fencing token (ADR-002) and are rejected when stale.
- **Idempotent appends**: events carry an idempotency key (`missionId`, `type`, producer attempt/fencing token, logical step) so crash-retry cannot double-append.
- **Session compatibility**: existing session APIs remain the caller surface; a `sessionId → missionId` adapter maps current turns onto missions during migration (dual-write, shadow-read, then flip, per the plan's migration strategy).

## Alternatives considered

- **Mutable rows only (no events):** simpler, but loses replay/audit and makes projection drift undetectable — rejected.
- **Redis Streams as the event store:** fast, but makes Redis the system of record for terminal history, contradicting the storage-responsibility rule — rejected.
- **Audit JSONL as the event source:** append-only already, but unindexed, unversioned, and observation-oriented; the plan explicitly keeps audit separate from the transactional store — rejected.

## Consequences

- Restart-safe missions and deterministic replay become possible (flight recorder, chaos suites).
- One more schema to migrate; mitigated by versioned events (`version` field per event type) and the additive migration strategy.
- Single-process installs keep a zero-dependency path.
