# StarlingAI Documentation

An index of the `docs/` folder. **Reference** docs are evergreen and kept current; **generated reference** is derived from code and enforced by CI; **guides** are task-oriented; **ADRs** are dated decisions whose status line says whether they were implemented; **point-in-time** docs are snapshots of a specific analysis/eval round, dated in their filename and not continuously maintained.

## Reference

| Doc | What it covers |
|-----|----------------|
| [architecture.md](architecture.md) | System architecture — gateway, swarm, subsystems |
| [api.md](api.md) | Gateway HTTP/WS API reference |
| [security.md](security.md) | Security model — auth, RBAC, per-user data isolation, guardrails, sandboxing |
| [iam-sso-oidc.md](iam-sso-oidc.md) | Pluggable identity — built-in accounts vs OpenID Connect (Keycloak) SSO + A2A machine auth |
| [uploads-storage-scanning.md](uploads-storage-scanning.md) | Upload storage (S3-compatible / SeaweedFS / AWS S3) + ClamAV malware scanning |
| [tool-tiers.md](tool-tiers.md) | Tool permission tiers (0 read → 4 blocked) and gating — narrative; see `reference/` below for the generated registry |
| [swarm-tuning-overview.md](swarm-tuning-overview.md) | **Control panel:** every lever to extend/adjust the swarm + its self-learning loops |
| [memory-context-overview.md](memory-context-overview.md) | **Data plane:** memory stores, knowledge/RAG, and context assembly across session/workspace/user scopes |
| [knowledge-bases.md](knowledge-bases.md) | Knowledge Bases — crawl a docs site into a queryable corpus |
| [channels.md](channels.md) | Inbound messaging channels overview |
| [mail-service.md](mail-service.md) | Mail/calendar/contacts service |

## Generated reference (`reference/`)

Derived from code at build time — **do not edit by hand.** Regenerate with `pnpm docs:reference`; CI fails when a file drifts from its source of truth. When one of these disagrees with a hand-written doc, the generated file wins.

| Doc | Generated from |
|-----|----------------|
| [reference/tool-tiers.md](reference/tool-tiers.md) | `packages/core/src/guardrails/tool-tiers.ts` (`TOOL_TIER_MAP`) — the complete tier assignment for every tool |
| [reference/config-flags.md](reference/config-flags.md) | `scripts/audit-config-flags.mjs` (schema walk + read-site scan) — every config flag and where the runtime reads it |
| [reference/deployment-modes.md](reference/deployment-modes.md) | `packages/core/src/runtime/deployment-mode.ts` (`evaluateDeploymentReadiness`) |

## Guides

| Doc | What it covers |
|-----|----------------|
| [channel-setup.md](channel-setup.md) | Step-by-step channel configuration |
| [forking.md](forking.md) | Forking / self-hosting the project |
| [fork-boilerplate-plan.md](fork-boilerplate-plan.md) | Boilerplate plan for a downstream fork |

## Architecture decision records (`adr/`)

Dated decision records. **Status is part of the record** — several are `proposed` designs that are not implemented; read the status line before treating one as a description of current behaviour. (There is no ADR-004; the number was never used.)

| ADR | Decision | Status |
|-----|----------|--------|
| [ADR-001](adr/ADR-001-mission-event-store.md) | Mission event store and projection consistency model | proposed — not implemented |
| [ADR-002](adr/ADR-002-task-lease-semantics.md) | Task lease TTL, renewal, fencing, takeover, result-following | draft — documents `swarm/locks.ts`; result-following deferred |
| [ADR-003](adr/ADR-003-agent-message-delivery.md) | Agent message delivery guarantee + idempotent processing boundary | partially implemented (`swarm/memory.ts`) |
| [ADR-005](adr/ADR-005-effect-contracts.md) | Effect classes, unknown outcomes, idempotency, compensation | proposed — needs approval before implementation |
| [ADR-006](adr/ADR-006-evidence-ledger.md) | Evidence claim identity, conflict handling, freshness, retention | proposed; slice 1 implemented (`swarm/evidence-ledger.ts`) |
| [ADR-007](adr/ADR-007-plugin-isolation.md) | Plugin isolation process model and capability RPC | proposed; first slice (default-off + trust warning) shipped |
| [ADR-008](adr/ADR-008-security-robustness-hardening-2026-07.md) | Security & robustness hardening wave | accepted — implemented 2026-07-21 |
| [ADR-009](adr/ADR-009-research-routing-upfront-classifier-2026-07.md) | Upfront source-sensitivity classifier routes product/model questions to the researcher | accepted — implemented 2026-07-24 |

## Point-in-time analysis (snapshots — not maintained)

| Doc | What it captured |
|-----|------------------|
| [staged-orchestration.md](staged-orchestration.md) | Staged small-prompt orchestration pipeline design (referenced by `runtime.ts`) |
| [engram-reevaluation-2026-07.md](engram-reevaluation-2026-07.md) | Engram (document-RAG) re-evaluation + adoption decision (referenced by `retrieval/*`) |

> These two are retained because code comments cite them as decision-records. They are not kept in sync with the code; when a fact here disagrees with the schema/source, the code wins.
