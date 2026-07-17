# ADR-003: Agent message delivery guarantee and idempotent processing boundary

**Status:** partially implemented 2026-07-16 (`swarm/memory.ts`: per-recipient streams, claim/ack, visibility-timeout redelivery, retry-ceiling dead-letter, ack-time idempotency, legacy-list drain, equivalent in-process fallback; unit-tested in `tests/agent-message-claims.test.ts`). Deferred ack is wired at both production consumers: the sub-agent runner acks in `recordOutcome` on success/partial outcomes, the dispatch layer acks when the attempt records completed/partial — failed or crashed runs leave the claim pending for redelivery. An adversarial review pass (2026-07-16) was applied: claim visibility now scales with the recipient run's budget (2×, capped 30 min) per this ADR's prescription, the legacy drain is loss-safe (transfer-then-remove), locally-parked messages drain back into streams on Redis recovery, malformed payloads dead-letter instead of pinning the reclaim window, redelivery preserves order, and `/api/swarm/status` reads stream lag/pending + dead-letter depth. Open: live-Redis validation after the next image rebuild.
**Date:** 2026-07-16
**Plan reference:** [agent-swarm-development-plan-2026-07.md](../agent-swarm-development-plan-2026-07.md) — P0 "Agent messages can be lost during consume", package `DST-104`.

## Context

`swarm/memory.ts:consumeAgentMessages` does `LRANGE` → filter in memory → `DEL` the whole list → `RPUSH` unmatched entries back. Concurrent senders/consumers overwrite each other, a crash after the delete loses messages, and two consumers can both take the same entry. There is no acknowledgement, retry, or dead-letter path.

## Decision

### Transport: Redis Streams, one stream per recipient

- `starlingai:msgs:<tenant>:<recipient-agent>` with a consumer group per recipient. Per-recipient streams keep fan-in cheap, make backlog per recipient observable, and avoid group-wide head-of-line blocking.
- Envelope fields (from the plan's `MessageEnvelope`): `id`, `missionId`, `taskId`, `sender`, `recipient`, `type`, `payloadRef` (inline under a size bound, content-addressed blob above it), `idempotencyKey`, `retryCount`, `traceContext`.

### Delivery guarantee: at-least-once transport, exactly-once effect

- **Claim:** `XREADGROUP` delivers; unacknowledged entries become reclaimable via `XAUTOCLAIM` after a visibility timeout (default: 2× the recipient's turn timeout, capped).
- **Acknowledgement boundary:** `XACK` happens **only after** the message's effect is committed to durable turn/checkpoint state (the persisted sub-agent turn record, or the mission event once ADR-001 lands) — never merely after prompt injection. A crash between processing and ack causes redelivery, which is the accepted failure direction.
- **Idempotent processing:** consumers keep a bounded per-recipient set of processed `idempotencyKey`s (Redis SET with TTL ≥ max redelivery window). Redelivered keys are acked without reprocessing. This is the exactly-once *effect* boundary; the transport remains at-least-once.
- **Retry ceiling and dead letter:** after `maxRetries` (default 3) reclaim cycles, the entry moves to `starlingai:msgs:dead:<tenant>` with the failure reason; dead-letter depth and oldest-age are exported for readiness/operator UI (plan acceptance gate).

### Compatibility

`send_agent_message` / prompt-injection call sites keep their signatures; a flag switches the backing store (legacy list → stream). During migration the consumer dual-reads (stream first, then legacy list drain) so in-flight messages survive the flip. Rollback returns to legacy reads without deleting stream data.

### Mode behavior

Streams require Redis. In `single_process` mode a local in-memory queue with the same claim/ack/idempotency API is permitted; clustered modes fail readiness without Redis (DST-101), consistent with ADR-002.

## Alternatives considered

- **Fix the list with WATCH/MULTI:** still destructive-read, no group semantics, no dead-letter — rejected.
- **One global stream + routing in consumers:** simpler key space but head-of-line blocking across recipients and noisy reclaim scans — rejected.
- **Postgres queue (SKIP LOCKED):** durable, but puts high-frequency chat on the slow store and duplicates Redis's role in the storage-responsibility split — rejected for v1; revisit if Redis persistence guarantees prove insufficient.

## Consequences

- No acknowledged message is lost on crash; duplicates are bounded and filtered at the effect boundary.
- Backlog, retry, and dead-letter metrics become first-class operator signals.
- Slightly higher per-message cost (stream + ack + idempotency set) — acceptable against the P0 loss modes it removes.
