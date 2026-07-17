# ADR-002: Task lease TTL, renewal, fencing, takeover, and result-following

**Status:** draft (documents the DST-102 implementation in `packages/core/src/swarm/locks.ts`; result-following [DST-103] is deferred and marked open)
**Date:** 2026-07-16
**Plan reference:** the R0–R5 agent-swarm development program (completed 2026-07-17) — P0 "Distributed task claims do not prevent duplicate work", packages `DST-102`/`DST-103`.

## Context

The previous `acquireTaskLock` provided neither exclusion nor fencing: a fixed 30-second TTL with no renewal (agents routinely run 4–12 minutes), a Redis key containing only the bare `taskId` (cross-session collisions on ids like `task_1`), lock acquisition *after* the task was announced and marked running, and execution continuing when acquisition returned `null`.

## Decision

### Lease identity

A lease key is `starlingai:lease:task:<sha256(scope)>` where scope is the sorted serialization of `{tenantId, userId, workspacePath, sessionId, taskId, taskSignature}` with explicit defaults (`default`/`anonymous`) for absent fields (`taskLeaseKey`). Hashing prevents both cross-scope collisions and unbounded/unsafe key material.

### Acquisition ordering

`executeDelegationWithFallback` acquires the lease **before** emitting `task_claimed`, before mutating task state to running, and before counting the delegation attempt. Acquisition failure is fail-closed: the worker does not execute and reports the contention (`leaseContended: true` metadata + audit event `delegation_result_reused`).

### TTL and renewal

- Initial TTL = min(configured agent/turn timeout, remaining turn deadline), clamped to [5 s, 60 s] (`resolveTaskLeaseTtlMs`). The clamp keeps orphaned leases short; long work holds ownership through renewal, not long TTLs.
- A heartbeat (`startTaskLeaseHeartbeat`) renews via an atomic compare-and-expire (Lua `GET == value → PEXPIRE`). Renewal succeeds only for the current owner value; the heartbeat exposes `lost` when renewal fails so the worker can stop publishing.

### Fencing

- Each acquisition atomically increments a *separate, non-expiring* counter key (`<lease-key>:fence`) and stores `owner:token` as the lease value. Tokens are therefore monotonic across the lease's whole lifetime, surviving expiry and takeover.
- Completion paths call `isTaskLeaseCurrent(lease)` before publishing results; a stale owner (expired or superseded) routes to `abandonLostLease`, which marks the attempt failed and publishes nothing.

### Backend selection

- Redis (via `REDIS_URL`) is the coordination backend. The in-process map adapter is permitted **only** when `deployment.mode === "single_process"` (`allowsLocalFallback`); in clustered modes, Redis acquisition failure fails closed (no lease, no execution) and `/readyz` reports 503 (see DST-101/`evaluateDeploymentReadiness`).
- Known edge (accepted for single-process, tracked for cluster hardening): when configuration is unavailable (`getConfig()` throws — early bootstrap, some test harnesses), local fallback is currently permitted. This must be revisited when `trusted_cluster` mode is actually deployed.

### Takeover

Takeover is implicit: a crashed or stalled owner stops renewing, the lease expires (≤ 60 s), and the next contender acquires a fresh lease with a higher fencing token. The stale owner's late completion is rejected by the `isTaskLeaseCurrent` check.

## Verification (2026-07-16)

Two-process proof against the real compose Redis and the compiled module (two
`docker compose exec` Node processes, `packages/core/tmp/lease-proof.mjs`):
100 contended rounds → 100 total acquisitions, 0 rounds won by both workers,
100/100 rounds covered (86/14 split). Semantics pass: heartbeat renewal held
ownership past the initial TTL, a contender was blocked while held, takeover
after expiry produced a monotonically higher fence (1→2), and the stale owner
failed both `renewTaskLease` and `isTaskLeaseCurrent`. Unit coverage lives in
`packages/core/src/tests/task-lease.test.ts` (local backend).

## Open items (explicitly not decided here)

- ~~Result-following (DST-103)~~ — implemented 2026-07-16 via a fence-guarded per-task result record on the lease key (`publishTaskLeaseResult` / `waitForTaskLeaseResult`): stale-fence publishes are atomically refused, contenders follow the winner's durable result within a bounded wait. The full mission event stream (ADR-001) can later subsume this record.
- **Repeatable CI integration test:** the two-process proof above is ad-hoc; the R1 merge gate needs it encoded as a CI-runnable integration test with real Redis.
- **Takeover policy:** whether a taken-over task restarts from scratch or resumes from checkpoints belongs to the mission store design (ADR-001).
- **Lease metrics:** contention rate, renewal failure rate, and takeover count are not yet exported.

## Consequences

- Duplicate execution across processes is prevented by exclusion + fencing rather than prompt discipline.
- A healthy long-running task retains ownership indefinitely via renewal; a dead owner blocks a task for at most one TTL (≤ 60 s).
- Single-process dev deployments keep working with no Redis.
- Contended delegations currently surface to the orchestrator as non-executed tasks; until DST-103 lands, the orchestrator may retry (bounded by its usual attempt caps) rather than await the winner.
