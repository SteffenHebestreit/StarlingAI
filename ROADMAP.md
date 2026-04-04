# StarlingAI — Roadmap

> **Last updated:** 2026-04-04 · **Current release:** v0.4.0 (Stage 9 shipped)

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

> **Status: ✅ Partially implemented in v0.3.2 — opt-out model deployed**

**Philosophy stated:** *"Every agent runs in an isolated Docker container with `--cap-drop ALL`, `--read-only`, and `--network none` enforced."*

**Reality today:** Sub-agent LLM loops run **in-process** inside the main gateway Node.js process by default. Isolation applies to:
- **`shell_exec` / `run_script`** → always routed to the dedicated `sandbox` container ✅
- **`selfdev__*` dynamic tools** → always sandboxed ✅
- **Sub-agent with `container.enabled: true`** → uses `container-runner.ts` with full Docker isolation ✅
- **All other sub-agents** → run in-process, sharing the gateway memory space ❌

**Impact:** A compromised or misbehaving sub-agent could in theory interfere with other in-process sessions, escalate through shared module state, or read environment variables that other agents left in memory.

**v0.3.2 fix (Stage 8.1):** Added `agents.defaultContainerized: boolean` global flag to config schema and `container.disabled: true` per-agent escape hatch. When `defaultContainerized: true`, all agents run containerized unless they explicitly opt out. 15 trusted read-only agents in `20-subagents-general.jsonc` are pre-marked `container.disabled: true`. Operators can enable the default-containerized mode by setting `agents.defaultContainerized: true` in gateway config.

**Remaining work (Stage 8.1 completion):** Enable `defaultContainerized: true` by default in the shipped config once the container image build pipeline is verified in CI.

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

**Remaining work:** A dedicated `swarm_delegate` tool (no `agentName` field, forces undirected delegation) would further nudge the LLM away from scripted assignment — planned for Stage 8.2 completion.

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

> **Status: ✅ Implemented in v0.3.2**

**Reality today (pre-v0.3.2):** The Warden monitors for `tool_storm`, `repeated_failures`, `tool_escape_attempt`, `rate_limit_flood`, and computer-use anomalies. It does **not** watch for:
- A single agent/session flooding the config-assistant with rapid proposals (`config_proposal_flood`)
- Repeated self-improvement cycles that keep failing and re-trying (`self_improve_loop`)
- An agent repeatedly trying to grant itself higher tool tiers

**v0.3.2 fix (Stage 8.3):** Added `config_proposal_flood` check (#7) to `warden.ts`: more than 5 `config_proposal_created` events from a single session within 10 minutes triggers a `warden_alert` (severity: warn) and clears the session's proposal counter. The Warden now subscribes to `config_proposal_created` and `config_proposal_applied` events on the audit bus.

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
| Default-containerized sub-agents (opt-out model) | High | GAP-1 | ✅ v0.3.2 (enable `defaultContainerized: true` to activate) |
| Undirected delegation guidance + `swarm_delegate` tool | Medium | GAP-2 | ✅ Instructions updated; `swarm_delegate` tool pending |
| `self_improvement_applied` audit events | High | GAP-3 | ✅ v0.3.2 |
| Warden `config_proposal_flood` check | High | GAP-4 | ✅ v0.3.2 |
| Navigation tools scope | Low | GAP-5 | ✅ Not a gap — correctly scoped to distance_specialist |
| `selfdev__` prefix guard in dynamic-tools.ts | Low | GAP-6 | ✅ v0.3.2 |
| Multi-instance gateway clustering (Redis-backed session sharding) | Medium | — | Planned |
| Configurable approval timeout per scene | Low | — | Planned |

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

## Stage 10 — Federated Swarms (Exploratory)

Two or more StarlingAI instances discover each other via the swarm bus and can delegate tasks cross-instance. Each instance remains fully self-governing; the federation is purely additive and cannot override another instance's tool policies or guardrails.

This stage is exploratory — it depends on Stage 8 container isolation being complete and validated.

---

## Invariants — What Will Never Change

These properties are not on any roadmap because they will never be relaxed:

1. **Tool tiers are compile-time, not runtime.** No API call, config change, or self-improvement action can reclassify a tool tier.
2. **Credentials never enter model context.** `site_fill_credentials` and `computer_type_credential` are the only approved consumption paths.
3. **Shell execution always runs in a Docker sandbox.** `shell_exec` and `run_script` will never be allowed to run on the host, regardless of operator config.
4. **Tier 4 is absolute.** `host_shell`, `docker_socket`, and `gateway_reconfigure` are permanently blocked with no bypass mechanism.
5. **Human approval gates are unconditional.** `humanInLoopSteps` cannot be bypassed by `--auto` flags, agent instructions, or self-improvement actions.
6. **The Warden always ships.** The self-improvement pipeline (dynamic tools, config proposals) is never deployed without the Warden co-shipping.
