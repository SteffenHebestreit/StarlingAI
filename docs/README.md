# StarlingAI Documentation

An index of the `docs/` folder. **Reference** docs are evergreen and kept current; **guides** are task-oriented; **point-in-time** docs are snapshots of a specific analysis/eval round and are dated in their filename (kept for the record, not continuously maintained).

## Reference

| Doc | What it covers |
|-----|----------------|
| [architecture.md](architecture.md) | System architecture — gateway, swarm, subsystems |
| [api.md](api.md) | Gateway HTTP/WS API reference |
| [security.md](security.md) | Security model — auth, RBAC, per-user data isolation, guardrails, sandboxing |
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
| [eval-guide-2026-07.md](eval-guide-2026-07.md) | Current flag-eval round — what to enable, what to watch |
| [honesty-restoration-2026-07.md](honesty-restoration-2026-07.md) | Honesty-guard restoration + how to eval it (companion to the eval guide) |

## Point-in-time analysis (snapshots — not maintained)

| Doc | What it captured |
|-----|------------------|
| [improvement-roadmap-2026-06.md](improvement-roadmap-2026-06.md) | 62-item ranked improvement roadmap (June 2026 audit) |
| [capability-codevelopment-roadmap-2026-06.md](capability-codevelopment-roadmap-2026-06.md) | Roadmap for human+swarm co-development of a full-stack capability |
| [staged-orchestration.md](staged-orchestration.md) | Staged small-prompt orchestration pipeline design |
| [engram-reevaluation-2026-07.md](engram-reevaluation-2026-07.md) | Engram (document-RAG) re-evaluation + adoption decision |
| architecture-research-2026-07.json | 900K-token architecture research dump (companion to the eval guide) |

> Point-in-time docs are retained as a record of the reasoning behind shipped changes. They are not kept in sync with the code; when a fact here disagrees with the schema/source, the code wins.
