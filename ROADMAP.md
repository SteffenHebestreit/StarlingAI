# StarlingAI — Roadmap

> **Last updated:** 2026-04-19 · **Current release:** v0.6.4 (multi-instance gateway clustering + configurable approval timeouts)

This roadmap tracks both the completed architecture milestones and the honest gap analysis of where the implementation diverges from the swarm philosophy. It is a living document — the swarm may self-update entries in the `workspace/` area, but the core architecture decisions here are operator-owned.

---

## Completed Stages (v0.1 – v0.3.1)

| Stage | Name | Status |
|-------|------|--------|
| 1 | Sub-agent routing, parallel delegation, task graphs, four-layer guardrails | ✅ Complete |
| 2 | Swarm bus, distributed locks, container heartbeats, architect fallback, auto-promotion, autonomous bidding | ✅ Complete |
| 3 | Warden agent, swarm morphing, collective memory, adaptive routing, circuit breaker | ✅ Complete |
| 4 | 25+ specialist agents, cost profiles, evaluation CI | ✅ Complete |
| 5 | Channel hardening (5 channels), delivery guarantees, p50/p95/p99 latency, SLO tracking | ✅ Complete |
| 6 | Token streaming, turn performance metrics, adaptive timeouts, embedding cache | ✅ Complete |
| 7 | Multimodal tools (STT/TTS/image/file/browser), human-in-the-loop approvals, intervention diagnostics | ✅ Complete |
| 8 | Container opt-out model, self-improvement audit trail, Warden config-proposal flood, selfdev__ guard | ✅ Complete (v0.3.2) |
| 9 | A2A messaging, long-running task checkpoints, tool promotion queue, skill-gap auto-detection, swarm dashboard, GPU routing | ✅ Complete (v0.4.0) |

---

## Architecture Gap Analysis (Honest Assessment)

These are gaps between the stated philosophy and the current implementation. Every gap is acknowledged so the team can make deliberate choices rather than carry hidden debt.

### GAP-1 — Container Isolation Is Opt-In, Not Universal

> **Status: ✅ Closed — `defaultContainerized` defaults to `true`, with a startup Docker reachability gate**

**Philosophy stated:** *"Every agent runs in an isolated Docker container with `--cap-drop ALL`, `--read-only`, and `--network none` enforced."*

**Reality today (post-fix):** Sub-agents now run **containerized by default**. The `agents.defaultContainerized` config flag defaults to `true`. Trusted read-mostly agents (research, analysis, orchestration, browser interpretation, productivity) are pre-marked with `container.disabled: true`; everything else (shell exec, SSH, terraform, git writes, DB writes, external mail/notify, computer-use) runs containerized through `container-runner.ts`.

**Startup safety gate:** When `defaultContainerized: true`, the gateway runs `probeDockerReachability()` before binding the listen socket. If `docker version` fails or times out (5 s default), startup aborts with an actionable error rather than silently falling back to in-process execution. Operators who genuinely want the legacy in-process default must set the flag explicitly to `false`.

**v0.3.2 (Stage 8.1):** Added `agents.defaultContainerized` flag and `container.disabled` per-agent escape hatch; trusted read-only agents pre-marked in the workspace catalog.

**Closing change (post-v0.6.4 on develop):** Default flipped from `false` → `true` in `config/schema.ts`, with a `STARLINGAI_DEFAULT_CONTAINERIZED=false` escape hatch used by the test environment. Four additional agents marked opt-out (`agent_architect`, `agent_factory`, `quality_supervisor`, `productivity_agent` — all read-only or pure-orchestration); the workspace catalog now opts 27 agents out of containerization where Tier 0/1 tools or in-process-only MCP connections make a sandbox redundant. New `probeDockerReachability()` helper in `container-runner.ts`; `createGateway().start()` calls it pre-listen and refuses to start when the flag is on but Docker is unreachable.

**Mid-session safety net:** The startup probe catches a dead daemon before the gateway accepts traffic, but the daemon can also die mid-session. `runSubAgentInContainer` now pattern-matches Docker CLI errors (`Cannot connect to the Docker daemon`, `ENOENT` on `docker`, etc.) and emits a `docker_daemon_unreachable` audit event. The Warden subscribes to that event and raises an error-severity `docker_daemon_unreachable` alert with an intervention notice pointing operators to Docker Desktop / dockerd or the `STARLINGAI_DEFAULT_CONTAINERIZED=false` escape hatch. Rate-limited to once per 60 s to avoid flooding.

**Operator migration:** Existing deployments that lack a Docker daemon must add `"agents": { "defaultContainerized": false }` to their gateway config to retain the previous behavior. New deployments get container isolation out of the box.

---

### GAP-2 — Autonomous Bidding Is a Last-Resort Fallback, Not the Primary Routing Path

> **Status: ✅ Behavioral fix implemented in v0.3.2**

**Philosophy stated:** *"Outcome-weighted routing improves specialist selection over time — the swarm gets smarter the more it works."*

**Reality today:** The bidding system (`swarm/bidding.ts`) activates only when:
1. The caller does **not** explicitly name an agent in `delegate_to_agent`.
2. The candidate queue is empty (all named fallbacks exhausted).

In practice, the orchestrator LLM almost always names agents explicitly after calling `search_agents` or `list_agents`. This means the bidding protocol (`task_announced → task_bid → collect bids`) is rarely the primary routing path — the deterministic `resolveAgentRouting` algorithm (keyword + embedding + outcome boost) is.

**Why this is still valuable:** The bidding system is the correct fallback for undirected tasks, and its bid scores feed back into swarm state via `task_announced`/`task_bid` events on the bus. The architecture is correct; the orchestrator guidance just favors explicit naming.

**v0.3.2 fix (Stage 8.2):** Updated the main assistant's `customInstructions` in `10-core-agents.jsonc` to explicitly prefer calling `delegate_to_agent` **without an agent name** for tasks where the specialist is not immediately obvious. Reserve explicit naming for known specialists with proven routing history.

**Remaining work:** None — `swarm_delegate` tool ships as a dedicated no-`agentName` counterpart to `delegate_to_agent`. Agents that have `swarm_delegate` in their tool set are recognized as coordinators by the routing system.

---

### GAP-3 — Self-Improvement Lacks Structured Attribution Audit Trail

> **Status: ✅ Implemented in v0.3.2**

**Philosophy stated:** *"Bounded self-improvement... refine its own system-prompt, update durable user and workflow memory, create new sub-agents."*

**Reality today (pre-v0.3.2):** The `config-assistant.ts` proposal system gates changes behind human approval, and `flow-memory.ts` records outcomes. However, there is no structured audit entry that links a specific `workspace/agents/*.jsonc` change to the agent that proposed it and the turn in which it was approved. An operator reviewing the git diff cannot tell which agent made a change and why.

**v0.3.2 fix (Stage 8.3):** Added three new structured audit events to `audit/schema.ts` and emitted from `gateway/index.ts`:
- `config_proposal_created` — fires when a proposal is drafted (proposingAgent, targetAgent, mode, summary)
- `config_proposal_applied` — fires when an operator approves and applies (proposalId, proposingAgent, targetAgent)
- `self_improvement_applied` — fires alongside `config_proposal_applied` with full detail: configChanges (path + newValue), promptChanges (agentName + strategy), summary

---

### GAP-4 — Warden Has No Self-Improvement Abuse Detection

> **Status: ✅ Fully closed (April 2026 — `tier_escalation_attempt` + `self_improve_loop`)**

**Reality today (pre-v0.3.2):** The Warden monitors for `tool_storm`, `repeated_failures`, `tool_escape_attempt`, `rate_limit_flood`, and computer-use anomalies. It does **not** watch for:
- A single agent/session flooding the config-assistant with rapid proposals (`config_proposal_flood`)
- Repeated self-improvement cycles that keep failing and re-trying (`self_improve_loop`)
- An agent repeatedly trying to grant itself higher tool tiers

**v0.3.2 fix (Stage 8.3):** Added `config_proposal_flood` check (#7) to `warden.ts`: more than 5 `config_proposal_created` events from a single session within 10 minutes triggers a `warden_alert` (severity: warn) and clears the session's proposal counter.

**April 2026 closure:** Added the two missing checks.

- **`tier_escalation_attempt`** — `dynamic-tools.ts` `validateDefinition()` and `approvePromotion()` now reject any self-developed tool whose bare name collides with a compile-time-mapped built-in (using `isCompileTimeMappedTool()` from `tool-tiers.ts`). A promoted dynamic tool with a colliding name would otherwise shadow the built-in's tier semantics. Both rejection paths emit a `tier_escalation_attempt` audit event with stage / attemptedName / collidingTier; the Warden surfaces every such event as an immediate operator-visible alert.
- **`self_improve_loop`** — Warden accumulates `config_proposal_rejected`, `tool_promotion_rejected`, `tool_dev_session_terminated`, and `tier_escalation_attempt` events per session. Three or more in a 30-minute window fire a `self_improve_loop` warn alert. The window resets after firing so a single burst alerts once.

**Defense in depth:** `deployApprovedTool` now runs `validateDefinition` at the public deploy boundary (previously the validator only ran from the file-watcher). This closes the direct-API bypass path.

---

### GAP-5 — Navigation Tools Scope

> **Status: Closed (not a gap) — navigation tools belong to `distance_specialist`, not the main agent**

**Clarification:** `geocode_location` and `route_distance_time` are correctly scoped to the `distance_specialist` sub-agent and are not appropriate for the main agent's direct tool set. The main agent's role is orchestration; delegating navigation queries to a specialist is the intended design, not a workaround. No fix required.

---

### GAP-6 — Dynamic Tool Name Collision Risk (selfdev__ Prefix Stacking)

> **Status: ✅ Implemented in v0.3.2**

**Reality today (pre-v0.3.2):** A self-developed tool named `selfdev__something` would register as `selfdev__selfdev__something`, which still matches the `selfdev__` Tier 2 pattern. No security bypass is possible (the Tier 2 sandbox enforcement still applies), but the double-prefix is confusing and may cause unexpected routing behavior.

**v0.3.2 fix (Stage 8.4):** Added a prefix guard in `dynamic-tools.ts` `validateDefinition()` — tool definitions whose `name` starts with `selfdev__` are now rejected with a validation failure. The prefix is the system's namespace, not the tool author's.

---

## Stage 8 — Swarm Integrity & Scale (In Progress, 2026 Q2)

**Theme:** Close the architecture gaps identified above and harden the system for multi-instance deployments.

| Task | Priority | GAP | Status |
|------|----------|-----|--------|
| Default-containerized sub-agents (opt-out model) | High | GAP-1 | ✅ Closed — `defaultContainerized` now defaults to `true`; gateway aborts startup if Docker is unreachable |
| Undirected delegation guidance + `swarm_delegate` tool | Medium | GAP-2 | ✅ Instructions updated; `swarm_delegate` tool implemented |
| `self_improvement_applied` audit events | High | GAP-3 | ✅ v0.3.2 |
| Warden `config_proposal_flood` check | High | GAP-4 | ✅ v0.3.2 |
| Navigation tools scope | Low | GAP-5 | ✅ Not a gap — correctly scoped to distance_specialist |
| `selfdev__` prefix guard in dynamic-tools.ts | Low | GAP-6 | ✅ v0.3.2 |
| Multi-instance gateway clustering (Redis-backed session sharding) | Medium | — | ✅ v0.6.4 |
| Configurable approval timeout per scene | Low | — | ✅ v0.6.4 |

---

## Stage 9 — Advanced Swarm Behaviors (In Progress, 2026 Q2)

**Theme:** True peer-to-peer swarm coordination. Direct agent messaging without orchestrator mediation, resumable long-running tasks, tool promotion pipeline, and GPU-aware routing.

| Feature | Status | Notes |
|---------|--------|-------|
| Direct A2A messaging | ✅ v0.4.0 | `consumeAgentMessages()` called at sub-agent start; pending mailbox messages injected as context before each run; `a2a_messages_delivered` audit event |
| Swarm-native long-running tasks | ✅ v0.4.0 | `swarm/checkpoints.ts` — createCheckpoint / pauseCheckpoint / resumeCheckpoint / completeCheckpoint; disk-persistent (24h TTL); REST API at `/api/checkpoints` |
| Dynamic tool promotion from `selfdev__` to catalog | ✅ v0.4.0 | Runtime call stats tracked per tool; auto-nominated at 10 calls + ≥80% success; operator approve/reject via REST + dashboard; promoted tools re-registered without prefix at Tier 2 |
| Skill-gap auto-detection | ✅ v0.4.0 | `recordCapabilityGap()` auto-called on zero-result and low-confidence routing failures in both `search_agents` and `delegate_to_agent`; gaps surfaced in dashboard |
| Operator dashboard for swarm health | ✅ v0.4.0 | `SwarmDashboard.vue` at `/swarm` — warden alert ring (last 200), capability gaps, promotion queue with approve/reject, paused task checkpoints, dynamic tool stats; `/api/swarm/health` endpoint |
| GPU-aware agent routing | ✅ v0.4.0 | `compute` field on `SubAgentConfigSchema` (gpuPreferred, gpuTier, minVramMb); `computeGpuAffinityAdjustment()` boosts GPU-capable agents for compute-heavy queries; `computeProfile` exposed in routing candidates |

---

## Stage 10 — Workflow, Scene & Agent Expansion (Active, 2026 Q2–Q3)

**Theme:** Make the swarm immediately useful for the most common real-world work patterns. Adds purpose-built scenes, multi-step jobs, standard agents, and missing tool coverage so operators can wire high-value workflows without writing custom code.

### 10.1 — Scenes

**Status:** ✅ All 15 scenes shipped (workspace/scenes/10-scenes.jsonc, 2026-04-22) — every scene resolves against the agent catalog and parses cleanly under `SceneConfigSchema`.

| Scene | Purpose | Status | Notes |
|-------|---------|--------|-------|
| `security_audit` | CVE research + static code analysis + compliance check → risk report | ✅ | |
| `software_bug_fix` | Diagnose → minimal fix → test cycle → change summary | ✅ | Max 2 fix-test cycles |
| `incident_response` | Triage → root-cause → remediate → post-incident brief | ✅ | Human-in-loop on infra apply |
| `accessibility_audit` | WCAG 2.2 browser-driven audit → structured issue report | ✅ | |
| `data_pipeline_review` | Schema quality, null rates, anomaly detection → data quality report | ✅ | Uses `sql_specialist` + `data_analyst` |
| `competitive_analysis` | Multi-competitor parallel research → comparison table + visual brief | ✅ | |
| `release_notes_draft` | Git log + diff analysis → Keep-a-Changelog notes + optional broadcast | ✅ | |
| `translation_task` | Document/message translation with optional QA spot-check | ✅ | |
| `infrastructure_change` | Plan → compliance review → human-approved apply → verify | ✅ | HITL: `terraform_apply`, `ansible_apply`, `infrastructure_apply`, `ssh_exec` |
| `calendar_scheduling` | Check availability → book event → channel confirmation | ✅ | |
| `onboarding_packet` | Gather resources → translate → structured onboarding Markdown doc | ✅ | |
| `code_refactor` | Diagnose → minimal targeted refactor → test verification → clean commit | ✅ | Max 2 refactor-test cycles |
| `content_creation` | Research → draft → quality-check audience-ready content | ✅ | Uses `content_writer` |
| `database_migration` | Inspect schema → write idempotent migration → compliance gate → apply → verify | ✅ | HITL: `sql_query`, `db_query_write`, `database_apply` |
| `contract_review` | Intake → clause inventory → risk table → negotiation points | ✅ | Legal analysis only — requires human review |

**Human-in-loop gates added:** `infrastructure_apply`, `terraform_apply`, `ansible_apply`, `db_query_write`, `sql_query` (write path), `monitoring_apply`, `prometheus_apply`, `grafana_apply`, `plan_finalize`, `project_planner_handoff` — all require explicit operator approval before execution.

### 10.2 — Jobs (Multi-Step Workflows)

**Status:** ✅ All 9 jobs shipped and now resolve against Stage 10.1 scenes (2026-04-22). 5 additional jobs are live in `workspace/jobs/10-jobs.jsonc` beyond the initial roster: `daily_ops_brief`, `deep_research_packet`, `database_analysis`, `research_visual_digest`, `source_grounded_paper_packet`.

| Job | Steps | Trigger |
|-----|-------|---------|
| `weekly_security_digest` | `security_audit` → `multi_channel_broadcast` | API + `/security-digest` slash |
| `release_broadcast` | `release_notes_draft` → `multi_channel_broadcast` | API + `/release` slash |
| `incident_postmortem` | `incident_response` → `source_backed_paper` → `multi_channel_broadcast` | API + `/incident` slash |
| `competitive_snapshot` | `competitive_analysis` | API + `/competitive` slash |
| `data_quality_report` | `data_pipeline_review` → `multi_channel_broadcast` | API |
| `morning_briefing` | `deep_research` (today's news) → `multi_channel_broadcast` | API + `/morning` slash |
| `scheduled_code_review` | `code_review` → `multi_channel_broadcast` | API + `/code-review` slash |
| `onboarding_delivery` | `onboarding_packet` → `multi_channel_broadcast` | API + `/onboard` slash |
| `content_pipeline` | `content_creation` → `multi_channel_broadcast` | API + `/content` slash |

### 10.3 — Agents

**Status:** ✅ All 6 agents present in `workspace/agents/*.jsonc`.


| Agent | Role | Key Tools |
|-------|------|-----------|
| `devops_coordinator` | CI/CD orchestration, rollout coordination, rollback decisions | `shell_exec`, `ssh_exec`, `service_check`, delegation tools |
| `test_generator` | Unit/integration test generation from code or specs (Vitest, Jest, pytest) | `workspace_search`, `read_file`, `write_file`, `shell_exec` |
| `log_analyst` | Structured log parsing, anomaly detection, incident timeline extraction | `read_file`, `ssh_exec`, `shell_exec`, `metric_write` |
| `sql_specialist` | SQL querying, authoring, optimization, schema migrations, index recommendations, data export | `sql_query`, `get_site_credentials`, `spreadsheet_write`, `write_file` |
| `finance_analyst` | Balance sheet, budget, cash-flow, and KPI analysis from spreadsheet or file data | `spreadsheet_read`, `extract_file_content`, `generate_chart_html` |
| `content_writer` | Blog posts, product copy, newsletters, documentation, and press releases from a brief | `read_file`, `write_file`, `generate_document` |

### 10.4 — Additions (Shipped in v0.5.1)

| Item | Type | Status | Notes |
|------|------|--------|-------|
| `http_request` tool | Tool | ✅ Pre-existing | Available since Stage 9; direct GET/POST/PUT/DELETE without spawning `api_integrator` |
| `run_test_suite` tool | Tool | ✅ v0.5.1 | Tier-2 Docker-sandboxed test runner; supports vitest/jest/pytest/mocha/go/cargo/make/npm/custom with optional filter pattern |
| `log_stream` tool | Tool | ✅ v0.5.1 | Tier-1 read-only; tails Docker Compose service logs or workspace log files with substring filter and line limit |
| `git_tag` / `git_push` tools | Tool | ✅ v0.5.1 | Tier-2 sandbox; `git_tag` creates annotated or lightweight tags; `git_push` is approval-gated with network enabled |
| `translate_text` tool | Tool | ✅ v0.5.1 | Tier-0 inline LLM translation; max 4 000 chars; auto-detects source language; no agent spawn required |
| `ask_user` tool | Tool | ✅ v0.5.1 | HITL pause-and-ask; supports multiple-choice and free-text input; routed via WebSocket `agent.input_needed` event |
| `contract_analyst` agent | Agent | ✅ v0.5.1 | Deep legal document analysis with risk scoring, clause inventory, and jurisdiction comparison; routes to `contract_review` scene |
| `monitoring_setup` scene | Scene | ✅ 2026-04-22 | Define alert rules, thresholds, and dashboards; human-in-loop approval before applying alert config. Previously listed as v0.5.1; scene definition actually landed 2026-04-22 alongside the Stage 10.1 completion wave. HITL: `monitoring_apply`, `prometheus_apply`, `grafana_apply`, `infrastructure_apply` |
| `feature_planning` scene | Scene | ✅ 2026-04-22 | Product feature → acceptance criteria → task graph → `project_planner` handoff; human approval gates. Previously listed as v0.5.1; scene definition actually landed 2026-04-22. HITL: `plan_finalize`, `project_planner_handoff` |
| `database_analysis` job | Job | ✅ v0.5.1 | Scheduled schema + data quality check via `data_pipeline_review` scene; broadcasts weekly digest to configured channels |

---

## Multi-User Authentication — Wave A (April 2026)

Multiple operator-level accounts with username + password login.  No
role split yet; every authenticated user gets full operator privileges
(Wave B will introduce viewer accounts and per-route gating).

| Capability | Status | Description |
|-----------|--------|-------------|
| Per-user accounts | ✅ shipped (Wave A) | `auth.users[]` in config; passwords stored as bcrypt hashes; usernames match `^[a-z0-9_.-]+$` |
| `POST /api/auth/login` | ✅ shipped | Username/password → JWT scoped to that username (`sub` claim).  Honors the existing IP-based `checkAuthRateLimit` so brute-force gets blocked.  Returns 503 when `auth.enabled` is false. |
| `GET /api/auth/me` | ✅ shipped | Returns `{ username, role, displayName? }` for the JWT holder. |
| `POST /api/auth/users` | ✅ shipped | Creates an account; auto-enables `auth.enabled` on first add.  Validates password length (≥8) and username pattern. |
| `DELETE /api/auth/users/:username` | ✅ shipped | Removes an account.  Refuses to delete the last user. |
| Audit attribution | ✅ shipped (Wave A) | `auth_user_created`, `auth_user_deleted`, plus `auth_success` now carries `userId` |
| LoginModal UX | ✅ shipped | Vue dashboard's modal has a username/password tab (default) and a token tab (legacy); the form calls `/api/auth/login` and stores the returned JWT in localStorage |
| Header user pill + sign-out | ✅ shipped | App header shows the current user (display name or username) with a sign-out button when not the legacy `admin` token |
| Backwards compat | ✅ shipped | When `auth.enabled` is false (the default) the bootstrap admin token printed at startup still works — operators upgrade by setting the flag. |
| Role split (operator/viewer) | ⏳ Wave B | Per-route gating, viewer-only UI affordances |

---

## OpenTelemetry Distributed Tracing (April 2026)

End-to-end tracing across tool calls, sub-agent runs, and federation
delegations. Trace context is propagated over the standard W3C
`traceparent` / `tracestate` headers so a delegation that hops three
StarlingAI instances appears as one trace in Jaeger / Tempo / Honeycomb.

| Capability | Status | Description |
|-----------|--------|-------------|
| Lazy SDK init | ✅ shipped | `initTracing(config)` is called at the top of bootstrap; failures log + continue (a misconfigured exporter cannot block startup) |
| Config | ✅ shipped | `tracing.{enabled,otlpEndpoint,otlpHeaders,sampleRate,serviceName}` with `ParentBasedSampler` over `TraceIdRatioBasedSampler` |
| Tool-call spans | ✅ shipped | Every `executeTool()` call produces a span with name, tier, session id, agent name, success flag |
| Sub-agent spans | ✅ shipped | `runSubAgentWithStats` wraps in a span carrying agent name, parent session, iterations, tool count, terminal state, total tokens |
| Federation outbound | ✅ shipped | `delegateToRemotePeer` + streaming variant produce spans; `fetchWithTimeout` injects `traceparent` into every federation HTTP call (delegate, search, peers-known, capabilities, health) |
| Federation inbound | ✅ shipped | `/api/federation/delegate` + `/delegate/stream` extract the inbound `traceparent` and run their span tree inside that context |
| No-op when disabled | ✅ shipped | Helpers (`withSpan`, `injectTraceContext`, `withExtractedContext`, `setSpanAttributes`) all short-circuit cheaply when `tracing.enabled` is false — callers can call them unconditionally |
| Dashboard endpoint | ✅ shipped | `GET /api/tracing/status` returns configured / active / endpoint / serviceName / sampleRate |

Run a local Jaeger/Tempo via Docker, point `tracing.otlpEndpoint` at its
OTLP-HTTP port, set `tracing.enabled: true`, and traces start flowing.
The tool-call → sub-agent → federation hierarchy yields a single tree
per turn even across multiple instances.

---

## Plugin SDK (April 2026)

Third-party tool packages loaded from a directory at gateway startup.
Author-facing API in `packages/core/src/plugin/index.ts`; loader +
auto-discovery in `packages/core/src/plugin/loader.ts`.

| Capability | Status | Description |
|-----------|--------|-------------|
| `defineTool` / `definePlugin` API | ✅ shipped | Identity helpers giving plugin authors typed completion |
| Auto-discovery from `~/.starlingai/plugins/` | ✅ shipped | Configurable via `STARLINGAI_PLUGINS_DIR` env or `plugins.dir` in starlingai.json |
| Single-file + directory plugin layouts | ✅ shipped | `<plugin>.js` or `<plugin>/index.{js,mjs}` |
| Tier gating | ✅ shipped | All plugin tools register at **Tier 2** (sandboxed, per-call approval); plugins cannot self-elevate |
| Tier-shadow rejection | ✅ shipped | Plugin tool names that collide with built-ins are rejected + audited as `tier_escalation_attempt` (closes the same vector closed for dynamic tools in GAP-4) |
| Dashboard inspection | ✅ shipped | `GET /api/plugins` returns the loaded plugin list with version + advertised tool names |
| Audit | ✅ shipped | `plugin_loaded` and `plugin_tool_rejected` events |

Plugins are loaded once at startup. Hot-reload during a running session is
deferred — operators restart the gateway after dropping a new plugin in.

---

## Stage 11 — Federated Swarms (MVP shipped April 2026)

Two or more StarlingAI instances delegate tasks cross-instance. Each instance remains fully self-governing; federation is purely additive and cannot override another instance's tool policies or guardrails.

### Capabilities

| Capability | Status | Description |
|-----------|--------|-------------|
| Manual peer registry | ✅ shipped | `federation.peers[]` in `starlingai.json` lists outbound peers (id + URL + tags) |
| HMAC bearer auth | ✅ shipped | All federation requests carry HS256 JWTs (5-min TTL) signed with `federation.sharedSecret`; both peers must share the secret |
| Capability advertisement | ✅ shipped | `GET /api/federation/capabilities` returns `{instanceId, agents, toolNames, protocolVersion}`; only Tier 0/1/2 tools are advertised |
| Cross-instance delegation | ✅ shipped | `delegate_to_remote_agent(peerId, agentName, task, context)` Tier-2 tool calls peer's `POST /api/federation/delegate` and returns synthesized output |
| Peer discovery tool | ✅ shipped | `list_federation_peers({ ping, refreshCapabilities })` returns the cached capability table for orchestrator routing |
| Policy isolation | ✅ shipped | Peer enforces ITS OWN tool tiers, agent allowlist, and `humanInLoopSteps` via `runSubAgentWithStats` — no override path |
| Audit trail | ✅ shipped | `federation_delegate_started/completed/failed` on the caller; `federation_request_received/completed/failed` on the peer |
| `exposeAgents` allowlist | ✅ shipped | Per-instance allowlist of agent names exposed to peers (empty array = all) |
| Capability cache | ✅ shipped | Peer capabilities cached for `federation.capabilityCacheTtlMs` (default 5 min) |
| Streaming delegation progress | ✅ shipped (wave 2) | `POST /api/federation/delegate/stream` emits SSE; `delegate_to_remote_agent` defaults `stream=true` and forwards peer progress to `ctx.onSubAgentProgress` |
| Federated workspace_search | ✅ shipped (wave 2) | `broadcastWorkspaceSearch` fans out across peers in parallel; `federated_workspace_search` Tier-0 tool merges local + peer matches grouped by source |
| Dashboard panel | ✅ shipped (wave 2) | `/federation` Vue page with peer cards + recent activity timeline; backed by `/api/federation/peers` and `/api/federation/activity` |
| Auto peer discovery | ✅ shipped (wave 3) | Transitive — each instance asks configured peers "who else do you talk to?" via `GET /api/federation/peers-known`, probes candidates via the existing health endpoint, and adds successfully-authed peers to an in-memory cache.  No new deps, no broadcast — trust is the existing shared HMAC.  Configurable refresh interval; discovered peers are forgotten on restart.  Audit: `federation_peer_discovered`, `federation_peer_unreachable`. |

### Configuration

```json
{
  "federation": {
    "enabled": true,
    "instanceId": "primary",
    "sharedSecret": "<32+ char shared HMAC secret — same on every peer>",
    "peers": [
      { "id": "ops", "url": "https://ops.example.com:8765", "tags": ["production"] }
    ],
    "exposeAgents": [],
    "delegationTimeoutMs": 600000,
    "capabilityCacheTtlMs": 300000
  }
}
```

When `enabled` is false the gateway routes return 404 and the federation tools refuse to execute, regardless of tier.

### Prerequisites (met)

- Stage 8 container isolation is complete on participating instances
- All instances must run protocol version `1.0` (currently advertised by every build)
- Peer authentication uses shared HMAC secrets configured per-instance via `starlingai.json`

---

## Invariants — What Will Never Change

These properties are not on any roadmap because they will never be relaxed:

1. **Tool tiers are compile-time, not runtime.** No API call, config change, or self-improvement action can reclassify a tool tier.
2. **Credentials never enter model context.** `site_fill_credentials` and `computer_type_credential` are the only approved consumption paths.
3. **Shell execution always runs in a Docker sandbox.** `shell_exec` and `run_script` will never be allowed to run on the host, regardless of operator config.
4. **Tier 4 is absolute.** `host_shell`, `docker_socket`, and `gateway_reconfigure` are permanently blocked with no bypass mechanism.
5. **Human approval gates are unconditional.** `humanInLoopSteps` cannot be bypassed by `--auto` flags, agent instructions, or self-improvement actions.
6. **The Warden always ships.** The self-improvement pipeline (dynamic tools, config proposals) is never deployed without the Warden co-shipping.
