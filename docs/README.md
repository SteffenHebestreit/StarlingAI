# StarlingAI Documentation

An index of the `docs/` folder. **Reference** docs are evergreen and kept current; **guides** are task-oriented; **point-in-time** docs are snapshots of a specific analysis/eval round and are dated in their filename (kept for the record, not continuously maintained).

## Reference

| Doc | What it covers |
|-----|----------------|
| [architecture.md](architecture.md) | System architecture — gateway, swarm, subsystems |
| [api.md](api.md) | Gateway HTTP/WS API reference |
| [security.md](security.md) | Security model — auth, RBAC, per-user data isolation, guardrails, sandboxing |
| [iam-sso-oidc.md](iam-sso-oidc.md) | Pluggable identity — built-in accounts vs OpenID Connect (Keycloak) SSO + A2A machine auth |
| [uploads-storage-scanning.md](uploads-storage-scanning.md) | Upload storage (S3-compatible / SeaweedFS / AWS S3) + ClamAV malware scanning |
| [tool-tiers.md](tool-tiers.md) | Tool permission tiers (0 read → 4 blocked) and gating |
| [swarm-tuning-overview.md](swarm-tuning-overview.md) | **Control panel:** every lever to extend/adjust the swarm + its self-learning loops |
| [memory-context-overview.md](memory-context-overview.md) | **Data plane:** memory stores, knowledge/RAG, and context assembly across session/workspace/user scopes |
| [knowledge-bases.md](knowledge-bases.md) | Knowledge Bases — crawl a docs site into a queryable corpus |
| [channels.md](channels.md) | Inbound messaging channels overview |
| [mail-service.md](mail-service.md) | Mail/calendar/contacts service |

## Guides

| Doc | What it covers |
|-----|----------------|
| [channel-setup.md](channel-setup.md) | Step-by-step channel configuration |
| [forking.md](forking.md) | Forking / self-hosting the project |
| [fork-boilerplate-plan.md](fork-boilerplate-plan.md) | Boilerplate plan for a downstream fork |

## Point-in-time analysis (snapshots — not maintained)

| Doc | What it captured |
|-----|------------------|
| [staged-orchestration.md](staged-orchestration.md) | Staged small-prompt orchestration pipeline design (referenced by `runtime.ts`) |
| [engram-reevaluation-2026-07.md](engram-reevaluation-2026-07.md) | Engram (document-RAG) re-evaluation + adoption decision (referenced by `retrieval/*`) |

> These two are retained because code comments cite them as decision-records. They are not kept in sync with the code; when a fact here disagrees with the schema/source, the code wins.
