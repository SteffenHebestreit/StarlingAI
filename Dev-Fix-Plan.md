# StarlingAI Dev-Fix Plan

Scope: agent swarm, orchestration, tool calling, memory, retrieval, and the
glue that should make a "what are today's headlines" request finish in ~30s
with a usable answer instead of a 222s timeout with no reply.

This plan is grounded in:

- Audit `starlingai-session-37d2f229-audit.md` (2026-04-20).
- Current behavior of `packages/core/src/tools/sub-agent.ts`,
  `packages/core/src/agent/runtime.ts`,
  `packages/core/src/agent/sub-agent.ts`, and the workspace catalog under
  `workspace/agents/`.

---

## 0. Implementation status (2026-04-20)

Phases A–D from the original plan are **complete**, plus the first three items of
Phase E and one of Phase F. Test suite: **702/702 passing**, routing-accuracy
benchmark: 50/50 (100%).

| # | Item | Status | Landed in |
|---|------|--------|-----------|
| A1 | Coordinator micro-completion → failure | ✅ | `tools/sub-agent.ts` |
| A2 | Auto-synthesize on partial+timeout | ✅ | `agent/runtime.ts` |
| A3 | 32 KB hard cap on tool result size | ✅ | `tools/result-shaping.ts` (new) |
| A4 | `retrieval_analyst` defined in catalog | ✅ | `workspace/agents/20-subagents-general.jsonc` |
| A5 | Force `share_finding` after substantive evidence | ✅ | `agent/sub-agent.ts` |
| B6 | Coordinator output contract (planning-only stubs ⇒ failure) | ✅ | `tools/sub-agent.ts` |
| B7 | Cross-agent context handoff via `context` field | ✅ | `tools/sub-agent.ts` |
| B8 | "Enough evidence" stop nudge (`shareFindingCallCount ≥ 3`) | ✅ | `agent/sub-agent.ts` |
| B9 | `web_task_coordinator` default parallel breadth | ✅ | catalog system prompt |
| C13 | Findings deduplication (≥85% Jaccard overlap) | ✅ | `tools/memory.ts` |
| D14 | Single `classifyDelegationResult()` function | ✅ | `tools/sub-agent.ts` |
| D16 | Warden forces synthesis on 2 consecutive failures | ✅ | `agent/runtime.ts` |
| D17 | Real-world routing scenarios (headlines, weather, CVE, lottery) | ✅ | `tests/routing-accuracy.test.ts` |
| Cross | `bytesByTool` in `sub_agent_completed` audit | ✅ | `agent/sub-agent.ts` |
| E18 | Soft deadline for specialists (70% of effective timeout) | ✅ | `agent/sub-agent.ts`, `tools/sub-agent.ts` |
| E21 | Source-diversity tracking + `[BREADTH SUFFICIENT]` nudge | ✅ | `agent/sub-agent.ts` |
| F29 | Per-turn `turn_scorecard` audit event (all 3 turn-end paths) | ✅ | `agent/runtime.ts`, `audit/schema.ts` |

### D14 / E21 / E18 / F29 — landing notes & gotchas

- **D14**: `DelegationClassification` has six variants. The two "partial" cases
  must stay distinct or routing breaks: `"partial"` ⇒ stop the loop and return
  the partial as the result; `"weak_partial"` ⇒ save to `bestPartialResult`
  and try the next candidate. The call-site condition is
  `if (classification !== "success" && classification !== "partial")`.
- **E21**: The diversity tracker reads `tc.arguments` (not `tc.args` — that
  variable does not exist in the tool loop and was a silent no-op in the
  first draft).
- **F29 regression** (caught & fixed): inserting the F29 delegation counter
  before the existing tool-loop body displaced
  `const perTurnToolLimit = getPerTurnToolCallLimit(tc.name)`. When adding
  any new accumulator inside the `for (const tc of llmResponse.tool_calls)`
  loop, re-verify the per-tool-limit declaration is still present.
- **F29 coverage**: scorecard now fires on the happy path **and** on both
  `delegate_loop_terminated` early returns (per-turn-limit hit and
  identical-output loop break). Any new early-return path must emit it too.

### Still open from the original plan

| # | Item | Reason it stayed open |
|---|------|-----------------------|
| C10 | Persistent semantic memory of findings across sessions | Folded into E22 (trajectory cache) below |
| C11 | Embedding-ranked tool selection inside an agent | Folded into E20 below |
| C12 | Embedding-ranked source selection in researcher/browser_agent | Folded into E20 below |
| D15 | Per-role soft/hard deadlines | Soft side landed as E18; hard-side budgets become G33 |

---

## 1. Concrete failure pattern (from the audit)

Single user turn `Was sind die Headlines von Heute?` (33 chars).

1. `delegate_to_agent` (no `agentName`) → routed to `web_task_coordinator`.
2. `web_task_coordinator` ran for **746 ms**, returned **63 chars**, terminal
   state `completed`, outcome `success`. This is almost certainly the
   "exited with code 125" stub or an empty plan, not a real coordination run.
   Today the runtime treats this as success.
3. Auto-fallback then tried `browser_agent` (medium-confidence routing,
   score 0.575). Good — that is the new behavior we want.
4. `browser_agent` did 7 tool calls in ~3 min:
   - `read_shared_facts` (empty, nothing has been written),
   - 3× `web_search`,
   - `browser_navigate` Tagesschau (77 KB snapshot),
   - `browser_navigate` Reuters (401, 518 chars),
   - `browser_navigate` Wikipedia "Current events / April 2026"
     (**902 KB snapshot in a single tool result**).
   - **Zero `share_finding` calls.**
5. `browser_agent` hit its 180 s `turnTimeoutMs` and returned a 310-char
   "partial" timeout output.
6. Main turn then issued another `delegate_to_agent`, which was blocked by
   `tool_calls_after_synthesis_required`.
7. Turn ended `finishReason: max_tool_iterations`, total **222.7 s**, no
   user-visible answer beyond the timeout summary.

Diagnoses:

- **Stop conditions are missing.** Both layers (`web_task_coordinator` and
  `browser_agent`) have no "I have enough — synthesize and exit" rule.
- **Coordinator is not coordinating.** It returned in 746 ms and was
  classified as success despite producing essentially nothing. The runtime
  has no minimum bar for a coordinator output.
- **Agents do not collaborate.** `read_shared_facts` returned empty,
  `share_finding` was never called, so the second agent could not pick up
  any work the first did, and the synthesizer had nothing to synthesize.
- **Context is unbounded.** A single browser snapshot was 902 KB. The
  agent's prompt budget is being burned by raw HTML/AX dumps, leaving no
  room to reason or finish.
- **Routing is good enough; execution is the bottleneck.** `web_task_coordinator`
  was correctly chosen, the right specialist was used as fallback. The
  failure is in how those agents work, not in who was picked.

---

## 2. Root-cause clusters

### C1. Coordinator/specialist contracts are not enforced

- A "completed" terminal state is treated as success even when the output is
  shorter than the task description. There is no minimum-evidence check.
- Coordinators (`web_task_coordinator`, `mission_coordinator`,
  `pentest_coordinator`) are not required to actually emit a delegation
  plan or shared facts. They can no-op and the runtime will accept it.
- Specialists are not required to call `share_finding` before exiting,
  even when the system prompt strongly suggests it.

### C2. No "good enough, stop" semantics

- Sub-agents have only two stop conditions: `max_iterations` and
  `turnTimeoutMs`. There is no "I have enough evidence to answer" gate.
- The coordinator has no instruction like "if browser_agent published
  ≥3 findings on this query, do not delegate further; synthesize."
- The main turn loop has no "delegated agent already produced enough
  evidence — stop chaining tool calls and resynthesize" check.

### C3. Memory/shared state is dead on arrival

- `read_shared_facts` and `share_finding` are exposed but never required.
- Sub-agents do not persist intermediate findings, so when one agent times
  out, the next cannot build on its work.
- `partialResults` and `sharedFacts` exist but the orchestrator does not
  inject a "here is what already exists for this task" preamble into a
  fallback agent's prompt.
- The catalog references agents that do not exist (e.g. tests assume
  `retrieval_analyst`); this confirms there is no canonical roster
  enforced anywhere.

### C4. Tool outputs blow the context budget

- A single `browser_navigate` returned **902 476 chars** to the model.
- We have no per-tool result truncation, no AX-tree summarizer, no
  evidence-extractor pass between the browser and the LLM.
- Once a 900 KB tool result is in the conversation, the rest of the turn
  is effectively lobotomized and the agent stops thinking and just spins.

### C5. Routing chooses well; tool selection inside agents is naive

- `web_task_coordinator` was a high-confidence pick (good).
- But inside `browser_agent`, tool ordering is "navigate, search, navigate,
  search, navigate" with no embedding/heuristic ranking of which source is
  most likely to contain the answer.
- We do hybrid (keyword + embedding) routing for *agents* but not for
  *tools-within-agents* and not for *URL/source ranking*.

### C6. Failure-classification is still partially miscalibrated

- `web_task_coordinator` returning 63 chars is classified as success.
- A 310-char "I gathered some headlines but ran out of time" reply was
  classified `partial` (correct), but the main turn still tried to
  re-delegate instead of synthesizing the partial.
- The main turn's "synthesize partials" path is wired but not the default
  recovery for coordinator-style timeouts.

### C7. Embeddings/semantic memory are under-used

- Embeddings are used in `resolveAgentRouting` for agent selection only.
- They are not used to:
  - cluster sources during a research task ("we already covered Tagesschau,
    pick a different domain"),
  - dedupe or summarize prior `share_finding` entries,
  - rank tools/URLs by semantic relevance to the current sub-task,
  - retrieve prior session findings on similar questions.

---

## 3. Fix plan — phased

Each item lists: file(s) to touch, expected behavior, and a test to add.

### Phase A — Stop the bleeding (small, surgical, this week)

1. **Treat micro-completions from coordinators as failure.**
   - File: `packages/core/src/tools/sub-agent.ts`
     (`looksLikeFailureResult` / `executeDelegationWithFallback`).
   - Rule: if the agent is in a coordinator role
     (`tags` contains `coordination` or name ends in `_coordinator`),
     and `output.length < max(120, taskTitle.length)` AND no
     `share_finding` was emitted AND no delegation was issued, classify
     `weak`.
   - Test: extend `swarm-orchestration.test.ts` with
     `coordinator returning a 60-char stub triggers fallback`.

2. **Auto-synthesize when a partial delegated result already contains the
   answer signal.**
   - File: `packages/core/src/agent/runtime.ts`
     (`shouldResynthesizeUserFacingResponse`).
   - Rule: when the latest tool result has
     `delegationOutcome === "partial"` AND
     `metadata.terminalState === "timeout"` AND output ≥ N chars,
     force a synthesis turn instead of allowing another `delegate_to_agent`.
   - Test: extend `runtime-delegation-loop.test.ts` with
     `partial-timeout delegated result triggers synthesis, blocks another
     delegate_to_agent`.

3. **Hard cap on raw tool result size.**
   - File: new helper `packages/core/src/tools/result-shaping.ts`
     applied in the tool-call dispatch in `runtime.ts` and inside
     `runSubAgent`.
   - Rule: any single tool result > 32 KB is auto-truncated, with a
     deterministic head/tail slice and a marker
     `[truncated: original 902476 chars, kept 32768]`.
     Snapshots use a structured AX summarizer when available.
   - Test: `tool-result-shaping.test.ts` ensures truncation is applied
     before the result is added to history.

4. **Fix the catalog mismatch.**
   - File: `workspace/agents/20-subagents-general.jsonc` (and any
     test/eval files that reference `retrieval_analyst`).
   - Either define `retrieval_analyst` for real, or replace those
     fallback chains with `researcher` + `browser_agent`. Pick one,
     document it in `/memories/repo/agents.md`.

5. **Force `share_finding` after substantive evidence.**
   - File: `packages/core/src/agent/sub-agent.ts` post-tool hook.
   - Rule: after any successful `web_fetch`, `browser_snapshot` ≥ 5 KB,
     `extract_file_content`, or 2nd `web_search`, inject a single-line
     system reminder:
     `You have collected evidence. Call share_finding with the strongest
      facts now, then either continue or finish.`
   - Test: `sub-agent-share-finding-nudge.test.ts`.

### Phase B — Make the swarm actually a swarm (next iteration)

6. **Coordinator output contract.**
   - Coordinators must emit a structured plan envelope:
     `<plan> ... </plan>` with at least one `delegate_to_agent` /
     `parallel_delegate` step or a clear `direct_answer` justification.
   - File: `workspace/agents/20-subagents-general.jsonc` system prompts +
     a runtime validator in `sub-agent.ts` that classifies a coordinator
     run with no plan and no delegation as `failed`.

7. **Cross-agent context handoff.**
   - File: `packages/core/src/swarm/memory.ts` +
     `executeDelegationWithFallback`.
   - Rule: when a fallback agent is started for the same `taskId`, the
     orchestrator prepends a deterministic "Prior agent activity" block
     containing:
     - what the previous agent attempted,
     - shared facts written so far,
     - artifact paths produced so far,
     - explicit "do not repeat these searches/URLs" list.
   - Test: `swarm-orchestration.test.ts` already has scaffolding; add
     `fallback agent receives prior-agent activity preamble`.

8. **"Enough evidence" stop heuristic for research tasks.**
   - File: new `packages/core/src/agent/stop-conditions.ts`.
   - Rule: a sub-agent in `research` / `web` mode stops calling tools and
     returns a final answer once it has either:
     - ≥3 distinct domains in its `web_fetch` / `browser_navigate` history
       AND ≥3 `share_finding` entries, OR
     - ≥1 source where the page snapshot itself satisfies the task
       (matched by an embedding similarity check against the task).
   - The runner enforces this between iterations.
   - Test: `sub-agent-stop-conditions.test.ts`.

9. **Coordinator default: parallel breadth, then synthesize.**
   - For freshness-sensitive research, `web_task_coordinator` should
     default to `parallel_delegate` of `researcher` + `browser_agent`
     with disjoint source sets, then synthesize, instead of single-thread
     chaining.
   - File: prompt update in `web_task_coordinator` system prompt +
     a small heuristic in `sub-agent.ts` to expose `parallel_delegate`
     as the recommended next call when both specialists are present.

### Phase C — Memory and retrieval as first-class (after B is stable)

10. **Persistent semantic memory of findings.**
    - File: `packages/core/src/memory/graph-service.ts` already promotes
      facts. Extend with embeddings-indexed findings store keyed by
      `(workspace, query_embedding)`.
    - On a new turn, before delegation, the orchestrator queries this
      store. If a recent finding (≤24h for freshness-sensitive,
      configurable) covers the query with high similarity, it is injected
      into the system prompt as "Cached recent evidence (verify if you
      use it)".
    - Test: `findings-store.test.ts` (write, retrieve by similarity,
      decay).

11. **Embedding-ranked tool selection inside an agent.**
    - When an agent has many tools (`browser_agent` has 13), the runner
      should rerank the tool list by embedding similarity to the current
      sub-task and pin the top K to the model's tool list. The rest are
      hidden but still callable through a `more_tools` lookup.
    - File: `packages/core/src/tools/registry.ts` +
      `packages/core/src/agent/sub-agent.ts`.
    - Test: `tool-reranking.test.ts`.

12. **Embedding-ranked source selection inside research.**
    - When `researcher` / `browser_agent` has multiple candidate URLs from
      `web_search`, rank them by embedding similarity to the task before
      visiting. Hard cap to top 3 unless the agent explicitly justifies
      visiting more.
    - File: `packages/core/src/tools/web-search.ts` (new helper) +
      runner-side prompt nudge.
    - Test: `web-source-ranking.test.ts`.

13. **Findings deduplication.**
    - On every `share_finding`, embed the finding text and reject
      near-duplicates of facts already shared this session.
    - File: `packages/core/src/swarm/memory.ts`.
    - Test: `share-finding-dedupe.test.ts`.

### Phase D — Architectural cleanups (ongoing)

14. **Single source of truth for "what makes a delegation successful".**
    - Today the rules are spread across `looksLikeFailureResult`,
      `looksLikePlanningOnlyResult`, `shouldAcceptPartialDelegation`,
      `terminalState` checks, `<final_answer>` parsing,
      and `stats.outcome`. Consolidate into one
      `classifyDelegationResult(stats, output, agentCfg, request)` that
      returns one of `success | partial | failure | infrastructure_failure`.
    - File: `packages/core/src/tools/sub-agent.ts`.
    - Test: comprehensive unit table in `delegation-classification.test.ts`.

15. **Per-role timeout budgets, not just per-agent.**
    - 180 s for `browser_agent` is fine for one navigation, not for a
      breadth-first headlines sweep. Coordinators should hand specialists
      a `softDeadlineMs` and a `hardDeadlineMs`, derived from the parent
      turn budget. Specialists must self-finalize at `softDeadlineMs`
      (publish what they have, return), not get killed at `hardDeadlineMs`.
    - File: `packages/core/src/agent/sub-agent.ts`.
    - Test: `soft-deadline.test.ts`.

16. **Warden / supervisory loop owns the "stop, synthesize, answer the
    user" decision.**
    - Today the warden raises alerts but does not change behavior in the
      current turn. Give it authority to force a synthesis pass when:
      - 2 consecutive sub-agent failures, OR
      - Any sub-agent that produced ≥1 useful `share_finding` then timed
        out, OR
      - Total turn time exceeds N% of `turnTimeoutMs`.
    - File: `packages/core/src/audit/warden.ts` +
      `packages/core/src/agent/runtime.ts`.
    - Test: `warden-forces-synthesis.test.ts`.

17. **Promote `tests.json` to be the contract for routing accuracy.**
    - Add real-world-shaped scenarios:
      - "Was sind die Headlines von Heute?"
      - "what's the weather in Heraklion next Friday?"
      - "summarize today's CVE feed"
    - Each must finish in ≤45 s with a non-empty answer in CI's mock
      mode. This is the regression that the current bug should never
      have escaped.

---

## 4. Cross-cutting improvements

- **Observability:** every audit event should already include a stable
  `taskId` + `attemptedAgents`. Add `iterationsByTool` and `bytesByTool`
  to `sub_agent_completed` so context-budget runaway is visible without
  reading the conversation. (~10 LOC in `sub-agent.ts`.)
- **One canonical "done" signal:** standardize on `<final_answer
  status="success|partial|failure">…</final_answer>` for every sub-agent
  reply, parsed once in the classifier. Remove the parallel paths.
- **Configuration hygiene:** move all numeric heuristics (skill match
  threshold, soft/hard deadlines, max tool result size, dedupe similarity)
  into `config/gateway/10-gateway.jsonc` under a single `swarm` block,
  with sensible defaults and per-agent overrides.
- **Documentation:** keep `/memories/repo/agents.md` authoritative for
  agent roles. Add `/memories/repo/orchestration.md` for the contracts
  introduced by this plan (coordinator output, shared-facts contract,
  stop conditions, soft deadlines).

---

## 5. Acceptance criteria

A user typing `Was sind die Headlines von Heute?` should observe:

- Total turn time ≤ 45 s in normal conditions.
- At most 1 coordinator call + at most 2 specialist calls.
- ≥3 `share_finding` entries persisted before the answer is rendered.
- A user-visible final reply listing concrete headlines with sources,
  not a "(no response)" placeholder and not a 222 s timeout.
- Re-asking the same question within the freshness window returns from
  cached findings in ≤5 s.

A regression test in `tests.json` (or a new `routing-accuracy` scenario
file) enforces all of the above with mocked tool outputs.

---

## 6. Suggested execution order

1. Phase A items 1–5 — these are localized, each ≤200 LOC, and they
   directly fix the audit's failure mode.
2. Phase B items 6–9 — these change agent contracts and require a
   coordinated catalog + prompt + runtime change.
3. Phase C items 10–13 — these are net-new capabilities and should be
   done after the swarm is reliable, not before.
4. Phase D items 14–17 — refactors that pay off once the above land.

---

## 7. Broader swarm analysis (post-Phase-D review)

With Phases A–D landed, the failure mode that motivated this plan
(coordinator no-op → specialist times out → no answer) is now defended in
depth. The remaining quality ceiling comes from architectural choices
that we never had to revisit while we were firefighting. This section
catalogs them.

### O1. Topology is implicitly star-shaped

Today every sub-agent is reached through the orchestrator. The
"coordinator" agents (`web_task_coordinator`, `mission_coordinator`,
`pentest_coordinator`) call `delegate_to_agent`, which round-trips back
through the same dispatcher used by the main turn. There is no genuine
peer-to-peer step.

Consequences:

- A coordinator's evidence reaches its own siblings only via the shared
  facts store. There is no direct "researcher pulls partial draft from
  paper_author" channel.
- Parallel breadth is bounded by orchestrator concurrency rather than
  by the natural data dependency graph of the task.
- A coordinator that wants to run a tight loop (e.g. "scout 5 sources,
  pick the top 2, dive deeper") pays orchestrator overhead on every step.

### O2. Stop conditions live in three places

After Phases A/B we have:

- **Per-tool** caps (32 KB, retry guard).
- **Per-iteration** loops (identical-output, tool-streak, blocked-iteration).
- **Per-turn** disposition (`classifyPostOrchestrationDisposition`,
  `_consecutiveDelegationFailures`).

But there is still no single declarative budget object that the runtime,
warden, and coordinators all agree on. The warden enforces wall-clock
limits, the runner enforces iteration limits, the orchestrator enforces
delegation caps — each in isolation.

### O3. Findings memory is session-local and write-only

`share_finding` and `share_evidence` are the right primitives, but:

- Nothing reads them across sessions. A user who asks the same question
  the next morning starts from scratch.
- Nothing decays them. A "headlines from 2026-04-20" finding will look
  authoritative on 2026-04-21.
- Nothing scores them. A finding from a known-good source and a finding
  from a 401 page are equally weighted.
- The dedupe added in C13 is structural (token overlap) — it will not
  catch "Apple stock $195" vs "AAPL closed at 195 USD".

### O4. No outcome learning

Agent outcomes (`appendOutcome`) feed the circuit breaker but nothing
else. We do not currently:

- Promote agents that consistently produce useful `share_finding` entries.
- Demote agents that consistently time out for a class of tasks.
- Adjust routing scores based on past success on similar queries.
- Auto-adjust per-agent `maxIterations` or `turnTimeoutMs` based on the
  empirical p95 of successful runs.

### O5. Tool diversity collapses under stress

`browser_agent` exposes 13 tools. Under time pressure the model still
prefers the first one it tried that worked. There is no:

- Diversity bonus for using a different tool than the previous iteration.
- Source-domain diversity bonus (we punish identical URLs but accept
  three searches that all return the same top hit).
- Cost/latency-aware ordering (web_search is cheap, browser_navigate is
  expensive — the model treats them as equivalent).

### O6. Synthesis is a single-shot LLM call

When the orchestrator forces synthesis, it is one untemplated LLM turn
over whatever evidence happens to be in the context window. There is no:

- Structured synthesis prompt that enumerates `share_finding` entries by
  source, freshness, and validation status.
- Verifier pass that checks the synthesis against the cited evidence.
- Fall-back to a smaller, cheaper model when the synthesis is short.

### O7. The Warden is reactive, not predictive

The warden currently fires on observed thresholds (3 failures, 15 tool
calls). It does not project. We could detect "this turn is on track to
hit 90% of `turnTimeoutMs` before any `share_finding`" and intervene at
50% rather than after the failure.

---

## 8. Phase E — Swarm intelligence and adaptive behavior (proposed)

These items address O1–O7. None are required for correctness; all of
them raise the ceiling on quality, latency, or cost.

18. **Declarative turn budget object.**
    - Replace ad-hoc deadlines with a `TurnBudget` carried alongside
      every sub-agent context: `wallClockBudgetMs`, `softDeadlineMs`,
      `hardDeadlineMs`, `maxBytesIngested`, `maxToolCalls`,
      `parentTurnId`, `inheritedFromCoordinator`.
    - Coordinators allocate fractions of their own budget when they
      delegate. Specialists self-finalize at `softDeadlineMs`.
    - Subsumes D15. Read by warden, runner, and `classifyDelegationResult`.
    - Files: new `packages/core/src/agent/turn-budget.ts`;
      consumed by `runtime.ts`, `sub-agent.ts`, `warden.ts`.
    - Test: `turn-budget.test.ts`.

19. **Predictive warden interventions.**
    - Extend warden to track turn-progress velocity (bytes ingested per
      second, share_findings per minute) and project end-state.
    - Trigger early `[CHECKPOINT REQUIRED]` injection when projection
      shows the turn will overrun without a finding.
    - File: `packages/core/src/agent/warden.ts`.
    - Test: `warden-projection.test.ts`.

20. **Unified tool metadata + embedding rerank.**
    - Extend `registerTool()` with structured metadata: `costEstimate`,
      `latencyEstimate`, `embeddingDescription`, `outputSchemaHint`.
    - Inside a sub-agent run, rerank the exposed tool list by embedding
      similarity to the current task description. Pin top-K, hide the
      rest behind a `more_tools` lookup.
    - Subsumes C11 and C12.
    - Files: `packages/core/src/tools/registry.ts`,
      `packages/core/src/agent/sub-agent.ts`.
    - Test: `tool-reranking.test.ts`.

21. **Source-diversity scoring for research.**
    - Track a per-task set of (domain, content-hash) pairs.
    - When ranking next URL to fetch, apply a diversity bonus to unseen
      domains and a penalty to already-seen content hashes.
    - When the diversity score plateaus (no new domain in last 2
      fetches), inject `[BREADTH SUFFICIENT]` system message.
    - File: `packages/core/src/tools/web-search.ts` +
      `packages/core/src/agent/sub-agent.ts`.
    - Test: `source-diversity.test.ts`.

22. **Trajectory cache (cross-session memory).**
    - Persist successful `(query_embedding, share_findings,
      finalAnswer, ttlSeconds)` tuples to a workspace-scoped store.
    - On a new turn, before delegation, look up by embedding similarity
      with a configurable freshness window. Inject as
      `[CACHED RECENT EVIDENCE — verify before reuse]`.
    - Subsumes C10.
    - Files: new `packages/core/src/memory/trajectory-cache.ts`;
      consumed by `runtime.ts`.
    - Test: `trajectory-cache.test.ts`.

23. **Outcome-driven routing weights.**
    - Extend `appendOutcome` to record (agent, task_class_embedding,
      success, durationMs, sharedFindingsCount).
    - `resolveAgentRouting` applies a learned multiplier to embedding
      similarity scores based on historical success rate for the
      agent on similar task classes.
    - File: `packages/core/src/agent/embeddings.ts` +
      `packages/core/src/agent/outcomes.ts`.
    - Test: `routing-learned-weights.test.ts`.

24. **Structured synthesis with verification.**
    - When synthesis is forced (D16 or A2 path), template the prompt:
      enumerate `share_finding` entries with key, source, freshness,
      validation status; ask the model to produce a final answer
      followed by a self-grading rubric (claims-cited count vs total).
    - Optional verifier sub-agent (`source_verifier` already exists)
      runs as a quality gate when corroborationScore is below threshold.
    - Files: `packages/core/src/agent/synthesis.ts` (new helper used
      by `runtime.ts`).
    - Test: `synthesis-rubric.test.ts`.

25. **Cost/latency-aware model selection.**
    - Today every sub-agent uses its configured `model.primary`.
    - Add a `model.tier` ladder: `routing` (small), `default` (medium),
      `synthesis` (large). The runner picks the tier based on the
      operation: routing/classification calls use `routing`,
      tool-loop iterations use `default`, forced synthesis uses
      `synthesis`.
    - File: `packages/core/src/providers/index.ts` +
      `packages/core/src/agent/sub-agent.ts`.
    - Test: `model-tier-selection.test.ts`.

26. **Peer-to-peer agent messaging beyond shared facts.**
    - `appendAgentMessage` already exists as a one-shot mailbox.
    - Promote it to a typed channel: `request_help(taskFragment) →
      response`. Lets a researcher ask a `data_analyst` for normalization
      mid-flight without going back through the orchestrator.
    - Bound by warden anti-flood (already present).
    - Files: `packages/core/src/swarm/memory.ts` +
      `packages/core/src/tools/memory.ts`.
    - Test: `agent-rpc.test.ts`.

---

## 9. Phase F — Evaluation and continuous improvement (proposed)

The Phase A–D fixes are protected by 691 unit tests, but most of those
tests are at the function/module level. We need higher-altitude
guarantees so a future prompt change cannot silently regress the
end-to-end behavior we just restored.

27. **End-to-end scenario harness with mocked tools.**
    - A scenario is a JSON file: user message, tool-call mocks
      (matched by tool name + arg pattern), assertions on final
      answer + audit events + total wall-clock.
    - Runs in CI in <60 s per scenario. Lives next to `tests.json`.
    - Seed scenarios: the four D17 routing queries, an end-to-end
      "summarize this PDF" flow, a multi-step pentest
      (`pentest_set_scope` + scan + report).
    - File: `packages/core/src/tests/scenarios/` +
      `packages/core/src/tests/scenario-harness.test.ts`.

28. **Trajectory replay tool.**
    - CLI: given an audit log JSONL, reconstruct the turn timeline,
      annotate each `delegate_to_agent` with its outcome, and produce a
      Mermaid flow diagram of the swarm execution.
    - Lets engineers diagnose new audits (like 37d2f229) in seconds
      instead of reading the raw log line by line.
    - File: new `scripts/replay-audit.mjs`.

29. **Per-task quality scorecard.**
    - At the end of every turn, the runtime emits a
      `turn_scorecard` audit event: number of delegations, byte budget
      used, share_findings count, dedup rate, final-answer length,
      whether forced synthesis fired, whether warden intervened.
    - Dashboard view (`AuditLog.vue`) renders a sparkline so the
      operator can see drift on the `headlines` query class day over
      day.
    - File: `packages/core/src/agent/runtime.ts` +
      `packages/web/src/pages/AuditLog.vue`.

30. **LLM-as-judge regression gate.**
    - For any scenario where the answer is open-ended, a small judge
      model rates the final answer on grounding (1–5), completeness
      (1–5), citation accuracy (1–5).
    - CI fails when the rolling 7-day average drops more than 0.5
      points on any scenario.
    - File: `scripts/judge-regression.mjs`.

31. **Prompt-change diff guard.**
    - Any PR that touches a system prompt under `workspace/agents/`
      must run the scenario harness + LLM judge and attach the
      scorecard to the PR. A flat or worse score blocks merge.
    - File: `.github/workflows/prompt-change.yml` +
      `scripts/prompt-change-guard.mjs`.

---

## 10. Long-horizon ideas (not yet planned)

These are intentionally not scheduled; they are listed so we do not
rediscover them later as if they were new.

- **Speculative parallel strategies.** When a task can plausibly be
  solved by ≥2 strategies (e.g. browser scrape vs RSS feed), race
  them and accept the first one to publish 3 share_findings. The
  loser is cancelled.
- **Negotiated approvals.** Replace the binary
  `requiresPerCallApproval` with a negotiation: the agent proposes,
  the warden accepts/modifies/rejects with a reason that the agent
  can act on.
- **Cross-workspace lessons-learned.** Anonymized failure patterns
  promoted from `outcomes.ndjson` into the user-global memory tier so
  StarlingAI learns once, applies everywhere.
- **Differential routing policies per channel.** Telegram and Slack
  users have different latency tolerances. Routing weights and
  budgets should be per-channel-class, not global.
- **Auto-spawned ephemeral specialists.** When no catalog agent
  matches a task with `confidence ≥ medium`, the orchestrator drafts
  a one-shot ephemeral agent with a generated prompt + tool list, and
  promotes it to the catalog if the next 3 runs all succeed.


Stop after Phase A and re-run the audit scenario before starting Phase B.
If Phase A alone makes the headlines query work end-to-end, B and C are
still worth doing but can be paced.

---

## 11. Phase G — General-purpose swarm capability (next focus, 2026-04-20)

The README opens with **"A general-purpose AI agent swarm that tackles any
task by composing the right specialists — not a collection of one-off
pipelines."** Phases A–D made the swarm reliable on the queries we
already know about. Phase G is what closes the gap to *any task*.

The four items below are ordered by leverage-per-LOC and are independent
enough that they can land in any order.

### G32. Outcome-driven routing weights (subsumes E23, addresses O4)

**Today.** `appendOutcome` writes to `outcomes.ndjson` and feeds only the
circuit breaker (`recentFailureBurst`) and a small reputation score
applied to ephemeral promotion. `resolveAgentRouting` itself is purely
keyword + embedding similarity — it has no memory of which agents
actually finished similar tasks well.

**Change.** Extend `OutcomeEntry` with a coarse task-class fingerprint
(top 3 task keywords + 8-bin embedding bucket) and `sharedFindingsCount`.
Inside `resolveAgentRouting`, after the base similarity score, multiply
by `(1 + 0.15 * tanh(historicalSuccessRateForBucket - 0.5))`. Hard cap
the multiplier at ±20% so it tunes the existing ranking, never overrides
it.

- Files: `agent/outcomes.ts` (new bucket helper),
  `agent/embeddings.ts` (similarity score post-processing),
  `tools/sub-agent.ts` (`resolveAgentRouting` + `executeDelegationWithFallback`).
- Tests: `tests/routing-learned-weights.test.ts` — same query, with
  vs. without seeded outcome history, expects ranking to flip toward
  the historically-successful agent.
- Risk: routing oscillation. Mitigation is the ±20% cap and a min-25-sample
  floor before the multiplier is applied.

### G33. Trajectory cache — reuse what the swarm already learned (subsumes C10/E22, addresses O3)

**Today.** Findings die with the session. A user asking
"Was sind die Headlines von Heute?" at 09:00 and again at 09:05 pays
the full delegation cost twice.

**Change.** New `memory/trajectory-cache.ts` stores
`{ queryEmbedding, normalizedQuery, sharedFindings[], finalAnswer,
finishedAt, ttlSeconds, channel }` per workspace. Before the runtime
issues the first `delegate_to_agent`, it queries by embedding similarity
(threshold 0.86) and freshness window (defaults: 24 h, 30 min for
freshness-sensitive queries identified by `initialDynamicGuidance`).
On hit, the cached findings are injected as
`[CACHED RECENT EVIDENCE — verify before reuse]` system message and the
synthesis path is preferred over re-delegation.

- Files: `memory/trajectory-cache.ts` (new), `agent/runtime.ts`
  (lookup before first delegation; write on `message_sent` for any turn
  that produced ≥1 `share_finding`).
- Tests: `tests/trajectory-cache.test.ts` — write/read round-trip,
  freshness decay, embedding similarity threshold, redaction of any
  credential-shaped tokens before persisting.
- Security: never persist tool results that contain `redacted=true`
  metadata or any value mentioned in `tool-tiers.md`'s credential list.
  Cache lives under the workspace, never user-global, to honour the
  README's "guarded sandboxing" rule.

### G34. Auto-spawn + auto-promote ephemeral specialists for novel tasks

**Today.** `create_ephemeral_agent` exists but is rarely used because
the orchestrator falls back to a "best-fit" catalog agent even when
confidence is low. The promotion path (`promoteEphemeralAgent`) is
guarded by `PROMOTION_MIN_SUCCESSES` / `PROMOTION_MIN_SUCCESS_RATE`
but nothing actually triggers ephemeral creation in the routing flow.

**Change.** When `resolveAgentRouting` returns `confidence === "low"`
AND the task has not been seen before in the trajectory cache (G33),
have the orchestrator draft a one-shot ephemeral agent: prompt the
default model with a structured spec
(`{ task, allowed_tool_tier, peer_agents }`) → returns
`{ name, systemPrompt, tools[], maxIterations }` → run it under the
existing tool-tier and approval guardrails. This is the README's
"specialist designed on the fly" promise made concrete.

- Files: `tools/sub-agent.ts` (new `draftEphemeralAgent` helper called
  from the routing fallback), `workspace/agents/` (template for the
  ephemeral spec).
- Tests: `tests/ephemeral-auto-spawn.test.ts` — low-confidence routing
  with no cache hit triggers spec draft → ephemeral run → outcome
  recorded. Mock the spec model so the test is deterministic.
- Guardrails: ephemeral agents inherit the parent's tool-tier and never
  receive credentials. Promotion still requires the existing 3-success
  threshold.

### G35. End-to-end scenario harness with mocked tools (was F27, lift to next)

**Today.** Unit coverage is excellent (702 tests). End-to-end coverage
is `routing-accuracy.test.ts` only — it asserts agent selection but
does not run the full turn loop with realistic tool results.

**Change.** A new `tests/scenarios/*.json` format describing
`{ userMessage, toolMocks: [{ tool, argMatcher, response }],
assertFinal: { containsAll[], maxWallMs, maxDelegations,
minShareFindings } }`. The harness replays each scenario through the
real `_runTurn` with mocked LLM and tools. Seed scenarios:

- `headlines-de.json` — the audit-37d2f229 query.
- `weather-heraklion.json` — freshness + location + travel.
- `cve-summary.json` — security-research + structured output.
- `pdf-summarize.json` — document ingestion.
- `pentest-scope-then-scan.json` — multi-step workflow with approval.

Each must complete in ≤45 s wall-clock with mocked tools and produce a
non-empty answer. CI gates on this.

- Files: `tests/scenarios/` (new), `tests/scenario-harness.test.ts`
  (new).
- Risk: brittle on prompt drift. Mitigation: assertions are
  intentionally coarse (`containsAll: ["Tagesschau", "Reuters"]`),
  not exact string match.

---

## 12. Cross-cutting follow-ups discovered while reviewing the last changes

These are small, correctness-grade items found during the D14/E18/E21/F29
review. None block Phase G; do them as you pass through the relevant code.

- **`turn_scorecard` is collected but not surfaced in the dashboard.**
  Add a sparkline to `packages/web/src/pages/AuditLog.vue` keyed on
  `turn_scorecard` events so operator-visible drift detection becomes
  possible. (~50 LOC.)
- **E21 plateau nudge currently triggers on domain repetition only.**
  Extend `consecutiveStaleDomainFetches` with a content-hash
  comparison so two different URLs that return the same body also count
  as stale. Reuses `summarizeText` for the hash key.
- **F29 sparkline needs a stable bucket.** When G35 lands, emit
  `scenarioId` alongside `turn_scorecard` so the dashboard can group by
  query class instead of plotting a single global series.
- **Soft deadline never fires when `toolCount === 0`.** That is correct
  for true no-op specialists but masks "specialist stuck thinking with
  no tools called" cases. Consider a separate iteration-based nudge at
  `iterations >= maxIterations * 0.7` regardless of `toolCount`.
- **Outcomes file unbounded growth.** `appendOutcome` writes to NDJSON
  forever. Add a 30-day rolling window (or 50 000 line cap) at write
  time so very long-lived workspaces do not pay O(n) read cost on every
  routing call.

---

## 13. README alignment scorecard (2026-04-20)

How does the current implementation map to the README's headline promises?

| README claim | Current state | Gap closed by |
|---|---|---|
| "Tackles **any** task by composing the right specialists" | Catalog-bound today; low-confidence routing falls back to a misfit | **G34** (auto-spawn ephemerals) |
| "Each task triggers the creation of a specialized sub-agent" | True for ephemerals, but rarely invoked | **G34** |
| "Successful configurations are automatically promoted" | Implemented (`promoteEphemeralAgent`), but rarely triggered because G34 is missing | **G34** |
| "Independent sub-tasks run concurrently" | `parallel_delegate` works; coordinators default to it for web tasks (B9) | ✅ |
| "Outcome-weighted routing improves specialist selection over time" | Outcomes recorded, but feed only circuit breaker | **G32** |
| "Self-healing — when a generated agent fails, the swarm detects this immediately and delegates to another" | D14/D16 + fallback chain | ✅ |
| "Bounded self-improvement — refine prompts, memory, agent composition" | Memory + dedupe land; prompt self-improvement still manual | Out of scope here; tracked separately |
| "Guarded sandboxing — Docker `--cap-drop ALL --read-only --network none`" | Enforced in `docker/agent-worker/Dockerfile` and `tools/registry.ts` tier checks | ✅ |
| "Re-asking returns from cached findings in ≤5 s" (§5 acceptance) | Not implemented | **G33** (trajectory cache) |

Phase G closes the four highlighted gaps. After G lands, the swarm is
materially closer to the README's "general-purpose, composes specialists
on demand" promise rather than "reliable on the queries we already wrote
agents for."
