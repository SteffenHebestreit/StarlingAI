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
`userProfilePrefetch`, vLLM-inspired (`quorumEarlySynthesis`, `subAgentDisagreementVerify`),
efficiency (`detectWriteChurnOverwrite`, `crossAgentArtifactReuse`).

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
