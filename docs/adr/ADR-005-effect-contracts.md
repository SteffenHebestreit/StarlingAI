# ADR-005: Effect classes, unknown outcomes, idempotency, and compensation

**Status:** proposed (design for `SEC-106`; requires approval before implementation per the dev plan's governance rule)
**Date:** 2026-07-16
**Plan reference:** the R0–R5 agent-swarm development program (completed 2026-07-17) — P1 "External side effects are not represented consistently by tool tiers", package `SEC-106`.

## Context

Tool tiers express *privilege*, not *effect*: a config-generated `webhook__*` tool is Tier 1 with no per-call approval even when its endpoint triggers a production deployment, while a harmless calendar write requires approval. Retried side effects have no idempotency contract, and a timed-out outward call has no representation distinguishing "didn't happen" from "happened but unconfirmed".

## Decision

### Effect metadata on tool registration

Extend `registerTool` metadata (additive, optional — untouched tools behave as today) with an `effect` block:

| Field | Values | Meaning |
| --- | --- | --- |
| `domain` | `local_workspace` \| `messaging` \| `calendar` \| `web_mutation` \| `infrastructure` \| `payment` \| `federation` | What kind of world-state the call can change |
| `target` | resolver `(args) => string` | Normalized destination (host, mailbox, repo, endpoint) computed from the RESOLVED call, not the tool name |
| `reversibility` | `pure` \| `idempotent` \| `compensatable` \| `irreversible` | The plan's effect classes |
| `dataClassification` | `public` \| `internal` \| `sensitive` | What the payload may carry |
| `supportsDryRun` | boolean | Whether a preview invocation exists |
| `compensation` | optional tool name + arg mapping | How to undo, when compensatable |

### Policy evaluation at call time

- Approval policy evaluates `(tier, effect.domain, effect.reversibility, resolved target)` — not the tool name alone. Default: **external mutation (`web_mutation`, `messaging`, `infrastructure`, `payment`, `federation` with `compensatable`/`irreversible` reversibility) requires explicit approval** unless a standing grant covers it.
- **Standing grants** are resource-scoped (`domain` + target pattern), time-bounded (expiry required), usage-limited (max calls), revocable, and audited. No unscoped grants.
- Browser interaction distinguishes **inspection** (navigate/read/screenshot — ergonomic, no per-call approval) from **commit/submit** (form submit, click on destructive controls — `web_mutation`, policy applies).

### Effect receipts and unknown outcomes

- Every external-mutation call writes an **EffectReceipt** (plan data model): effect id, tool, normalized target, request hash/idempotency key, approval/grant reference, start time, outcome (`succeeded` \| `failed` \| `unknown`), compensation reference.
- A timeout/connection-loss after dispatch records outcome **`unknown`** — never silently retried. Retry of a mutation requires either a verified receipt showing non-execution, an idempotency key honored by the destination, or operator resolution (the plan's transition invariant).

### Storage

Receipts append to the audit log immediately (existing substrate) and migrate to the mission store (`MIS-201`/ADR-001) when it lands. Grants persist in the runtime config overlay with the same durability as approvals (`durableApprovals`).

## Migration

Additive: tools without effect metadata keep current tier behavior. First wave annotates the highest-risk families (`webhook__*`, browser submit/click, mail send, git push/PR, infrastructure/deploy, federation dispatch) with generated defaults reviewed by hand; the dead-flag/registry CI gains a check that Tier-≥1 tools in those families declare effect metadata.

## Acceptance (from the plan)

- A webhook that can deploy cannot execute under an unscoped Tier-1 grant.
- Standing grants are resource-specific, time-bounded, revocable, auditable.
- Retried side effects use idempotency keys or stop for operator resolution.
