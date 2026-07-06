# Eval guide — July 2026 flag round

What to enable, what to watch, and what changed since the last eval round. Companion to
`docs/architecture-research-2026-07.json` (the research that motivated the new flags) and
`docs/honesty-restoration-2026-07.md`.

## 1. New flags to enable for this round

Add to `config/gateway/40-orchestration.jsonc` (then `sai start --build`). All three are
fail-open and reversible by deleting the lines.

```jsonc
// QA evidence discipline (slice 1) — a PASS from the QA reviewer must cite a concrete
// verifiable ground ("PASS — evidence: …"); a bare PASS still SHIPS but gets the bilingual
// "Unverified" caveat instead of counting as QA-confirmed. Kills rubber-stamp passes.
// WATCH: flow_verification_passed{reason:"qa_delivery_loop", unverified:true} +
// guardrail_flagged{details:"qa_delivery_loop_unverified"}.
"qaEvidenceRequired": true,

// QA tool judge (slice 2) — when the turn produced artifacts (files / served URLs), the
// verdict comes from a FRESH-context sub-agent with read-only inspection tools
// (read_file/verify_app/url_inspect) that must OPEN each artifact before judging, instead
// of a prose-only model call. Implies evidence discipline on its own (post-28f8aa5).
// Falls back to the prose check on any error. Adds one bounded sub-agent run (≤5 iters,
// ≤120s) per QA'd artifact turn — expect extra latency on those turns only.
// WATCH: a sub_agent_started for agentName:"qa_tool_judge" during finalization; planted-
// defect test: serve a truncated HTML app and check the verdict FAILs with an observed fact.
"qaToolJudge": true,

// Durable task-graph node reuse — completed run_task_graph nodes are recorded per-session
// (structural hash of id+task+deps); a re-issued graph in the same session pre-completes
// hash-matching nodes instead of re-running them. Reuse is strictly conservative (only
// skips already-succeeded work) and re-hydrates shared context for dependents (post-28f8aa5).
// WATCH: graph_node_reused swarm event + delegation_result_reused audit row + the graph
// summary line "(reused prior completed result)". Test: run a 3-node graph at a short
// timeout so it dies mid-graph, then say "try again" — node 1 should NOT re-execute.
"durableTaskGraph": true,
```

**Engram flags** — added to `config/tooling/10-platform.jsonc` under `retrieval.documentRag`
(docs/engram-reevaluation-2026-07.md §5). Both fail-safe and reversible by deleting the lines.

```jsonc
// CRAG confidence demotion: on a weak engram retrieval-confidence signal (score_gap
// below threshold), the injected [DOCUMENT CONTEXT] is framed "possibly-relevant —
// verify" instead of "authoritative". DEMOTE-ONLY: excerpts are never suppressed, the
// retrieval-failure / existence honesty notes are untouched. WATCH: the "you have no
// CV/documents" false-negative must NOT reappear; the demoted framing shows only on
// genuinely weak matches (with a tiny corpus score_gap is null → no demotion, expected).
"confidenceDemotion": true,
// Server-side scope filter: /search carries the active scope sources so the engram store
// filters in-store (engram feat/sources-scope-filter, pinned @049cec2). The client
// post-filter stays on as defense-in-depth. WATCH: 0 cross-session/cross-user doc leakage
// + no recall regression on in-scope docs.
"serverSideScopeFilter": true,
```

**Validation (2026-07-06, this session) — PASS end-to-end.** After the AG-UI scope fix
(§5, now resolved), the full flag eval passes: session A's canary never leaks into session B
(0-leak isolation through the whole stack), the in-scope document is retrieved + `[DOCUMENT
CONTEXT]` injected, a strong match keeps the authoritative framing (`confidenceDemotion` does
not over-fire), and the existence question is answered honestly (no "you have no documents"
false-negative). One expected caveat: with a tiny (2-doc) corpus engram returns
`score_gap: null` (needs ≥3 results), so the demoted framing does not appear — re-verify the
demotion wording on a larger corpus. engram-level 0-leak was also proven directly (a
`/search` probe with `[session:X, user:admin, workspace:workspace]` returns only the in-scope
doc; unknown source → empty). Both flags are safe and validated; still run your own pass^k for
the behavioral-quality signal.

## 2. Bugs fixed since the last round (28f8aa5) — why re-testing matters

A 14-agent adversarial review of the eval-pending code found and fixed 7 confirmed bugs
before this eval. The two you would have hit:

- **D5 deadline inversion (default-ON code):** with a turn timeout > 30 min, the first
  delegation *shortened* the turn to 30 min instead of extending it. If your eval uses
  `--timeout` or an effort profile above 30 min, it now behaves correctly (the configured
  budget is honored; the ceiling caps only the extension).
- **PASS-with-"fail"-evidence misparse:** `"PASS — evidence: the test suite reported 0
  failures"` was flipped to FAIL by a substring match, burning improve/escalate rounds on
  correct answers. Fixed (leading-PASS wins; FAIL matched at a word boundary).

Also fixed: qaToolJudge-without-qaEvidenceRequired shipped uninspected bare passes as
QA-confirmed (now implied); durableTaskGraph reused nodes were invisible to re-executing
dependents (now re-hydrated); stale judge refs after a coordinator-escalation rebuild
(now recomputed per round); the backend-unreachable breaker permanently blocked a family
on 2 transient stalls (now only genuinely-terminal errnos: ENOTFOUND/ECONNREFUSED/
EHOSTUNREACH/ENETUNREACH).

## 3. Already enabled in the shard (carried from previous rounds)

Staged orchestration S1/S3/S4 (`leanSynthesisPrompt`, `qaDeliveryLoop`+2 rounds,
`discoveryPrefetch`), honesty guards (`freshnessHonestyGuard`, `citationHonestyGuard`,
`urlFetchEnforcement`, `ungroundedFactualAnswerGuard`, `failedResearchHonestyBackstop`),
vLLM-inspired (`quorumEarlySynthesis`, `subAgentDisagreementVerify`), efficiency
(`detectWriteChurnOverwrite`, `crossAgentArtifactReuse`).

**`userProfilePrefetch` was DISABLED (was inert).** A third adversarial review found it gates on
a `userOwnFacts` turn signal the de-lexicalization hardwired to `false` (`intent-classifier.ts:269`),
so enabling it did nothing — the eval would have tested dead code. To actually use it, a structural
`userOwnFacts` signal must be restored in `computeDynamicTurnGuidance` (and added to its `flags`
object). Left `false` until then.

### Bugs fixed by the third review (shard flags)
- **quorumEarlySynthesis:** the straggler-grace timer was never cleared (leaked a live timer per
  fan-out); an already-aborted parent turn was ignored (launched N fresh sub-agents on a cancelled
  turn). Both fixed.
- **subAgentDisagreementVerify:** the verdict parser matched "DISAGREE" anywhere, so a chatty
  "AGREE — they do not disagree" reply spuriously injected a reconcile marker — now anchored to
  the leading verdict token.
- **discoveryPrefetch:** the capsule could recommend a meta/factory agent the coordinator can't
  auto-delegate to — now filtered out.
- **urlFetchEnforcement:** forced a needless fetch when the user pasted the page body alongside its
  URL — now exempt when substantial inline content is present.

## 4. What to watch across the run (north-star lens)

1. **Validated answers:** QA'd artifact turns should show the tool judge's sub-agent run and
   evidence-bearing verdicts; unverified passes must carry the caveat, never a silent pass.
2. **No unnecessary calls:** `ungroundedFactualAnswerGuard` over-fire (a legitimate direct
   answer converted to a delegation) — `guardrail_flagged{type:"tool_free_research_answer_rejected"}`
   on a general-knowledge question means flip it off. Same for `detectWriteChurnOverwrite`
   nudging legitimate rewrites.
3. **Knowledge sharing:** after `crossAgentArtifactReuse`, later agents should `read_file`
   prior artifacts instead of re-authoring; with `durableTaskGraph`, retried graphs reuse.
4. **Timing sanity (D5):** delegating turns should not time out while children work
   (`turn_performance.effortSloBudgetMs` vs actual); low-effort leaf agents wrap by ~90s.

## 5. Environment blockers from the last live session (still open)

- `browser-vnc` Playwright container was down (`getaddrinfo ENOTFOUND browser-vnc`) — browser
  logins can't work until it's up.
- The freelancermap.de credential exists but is RBAC-restricted: add `admin` to its
  `allowedUsers` (Settings → Site Credentials) — do NOT re-add the credential. The tools now
  report denied/unresolved/not-found honestly.
- **FIXED (2026-07-06, `d1d7473`) — AG-UI `/api/chat/stream` document-scope gap (was separate from any flag).**
  Driving a turn through the REST AG-UI endpoint retrieves **workspace**-scoped docs but NOT
  **session**- or **user**-scoped ones, and the per-turn `[DOCUMENT CONTEXT]` auto-injection
  never fires there (the agent still finds workspace docs via the `search_documents` tool).
  Root cause: `gateway/agui.ts` `handleAguiStream` calls `runTurn({ session, userMessage })`
  **without threading `userId`**, and the session scope isn't reaching the tool's
  `RagScopeContext` — so `activeScopeSources` drops `session:<id>` / `user:<id>` and keeps only
  `workspace:<name>`. The dashboard's WS **RPC `chat.send`** path threads both correctly, so
  this only affects the AG-UI REST entrypoint and any eval harness built on it. Fix candidate:
  pass the authenticated `userId` + confirm `session.id` reaches `ragCtx` in the AG-UI path;
  add a regression test. Until then, run doc-RAG evals through the RPC path.
