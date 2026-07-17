# ADR-006: Evidence claim identity, conflict handling, freshness, and retention

**Status:** proposed; slice 1 implemented 2026-07-16 (`swarm/evidence-ledger.ts` — append-only claims, write-time same-subject conflict detection, bounded prompt projection, shadow dual-write from `share_evidence`)
**Date:** 2026-07-16
**Plan reference:** the R0–R5 agent-swarm development program (completed 2026-07-17) — P1 "Shared facts are mutable strings, not an evidence ledger", packages `EVD-301..303`.

## Context

`writeSharedFact` is last-writer-wins by short key with silent 2,000-char truncation; `share_evidence` collects rich provenance (source, dates, trust scores, validation state) and then flattens it into one such string. Conflicting agents overwrite each other; the synthesizer cannot ask who observed what, from which source, when.

## Decision

- **Claim identity:** a claim is an immutable append-only record: `claimId` (uuid), `subject` (raw) + `canonicalSubject` (lowercased, whitespace-collapsed), `value` (raw, never truncated in the canonical record), `valueNorm` (comparison form), source ref (title/url/publisher/dates), `observedAt`/`retrievedAt`, `agent`, `mission`/root session scope, `confidence` scores, `validationState` (`unverified | tentative | validated | disputed`), optional `relations` (`supports | contradicts | supersedes | derived_from` → claimIds).
- **Conflicts coexist:** a write whose `canonicalSubject` matches an existing claim but whose `valueNorm` differs marks BOTH sides disputed in the subject index and emits an `evidence_conflict_detected` audit — nothing is overwritten; material-conflict verification routing is EVD-302.
- **Projection vs record:** prompts receive a bounded projection (`formatEvidenceForPrompt`); truncation applies ONLY there, never to the stored claim.
- **Freshness:** claims carry both observed and retrieved times; staleness policy (supersedes-by-recency for volatile subjects) is EVD-302 scope.
- **Retention:** session-scoped keys carry the shared 4 h TTL in Redis (local fallback is process-lifetime); durable mission-scoped retention moves to the mission store once EVD-303 migrates reads.
- **Migration (EVD-303):** `share_evidence` dual-writes (flag `mission.evidence`: off | shadow) — the legacy string fact stays authoritative for readers until parity is shown; `FACT:`-extracted writes will be marked `unverified` at that stage.
