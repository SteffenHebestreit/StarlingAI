# StarlingAI — Roadmap

> **Last updated:** 2026-04-04 · **Current release:** v0.3.1 (Stage 7 complete)

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

---

## Architecture Gap Analysis (Honest Assessment)

These are gaps between the stated philosophy and the current implementation. Every gap is acknowledged so the team can make deliberate choices rather than carry hidden debt.

### GAP-1 — Container Isolation Is Opt-In, Not Universal

**Philosophy stated:** *"Every agent runs in an isolated Docker container with `--cap-drop ALL`, `--read-only`, and `--network none` enforced."*

**Reality today:** Sub-agent LLM loops run **in-process** inside the main gateway Node.js process by default. Isolation applies to:
- **`shell_exec` / `run_script`** → always routed to the dedicated `sandbox` container ✅
- **`selfdev__*` dynamic tools** → always sandboxed ✅
- **Sub-agent with `container.enabled: true`** → uses `container-runner.ts` with full Docker isolation ✅
- **All other sub-agents** → run in-process, sharing the gateway memory space ❌

**Impact:** A compromised or misbehaving sub-agent could in theory interfere with other in-process sessions, escalate through shared module state, or read environment variables that other agents left in memory.

**Planned fix (Stage 8.1):** Add an opt-out flag `container.disabled: true` instead of the current opt-in `container.enabled: true`. All agents default to containerized execution. Operators can opt out for trusted low-latency agents (e.g., `read_file`-only specialists).

**Interim mitigation:** The four-layer guardrail stack, tool-tier enforcement, and Warden monitoring provide meaningful defense in depth. Runtime credential isolation (AES-256-GCM store, no secrets in model context) remains fully enforced regardless of process boundary.

---

### GAP-2 — Autonomous Bidding Is a Last-Resort Fallback, Not the Primary Routing Path

**Philosophy stated:** *"Outcome-weighted routing improves specialist selection over time — the swarm gets smarter the more it works."*

**Reality today:** The bidding system (`swarm/bidding.ts`) activates only when:
1. The caller does **not** explicitly name an agent in `delegate_to_agent`.
2. The candidate queue is empty (all named fallbacks exhausted).

In practice, the orchestrator LLM almost always names agents explicitly after calling `search_agents` or `list_agents`. This means the bidding protocol (`task_announced → task_bid → collect bids`) is rarely the primary routing path — the deterministic `resolveAgentRouting` algorithm (keyword + embedding + outcome boost) is.

**Why this is still valuable:** The bidding system is the correct fallback for undirected tasks, and its bid scores feed back into swarm state via `task_announced`/`task_bid` events on the bus. The architecture is correct; the orchestrator guidance just favors explicit naming.

**Planned fix (Stage 8.2):** Update the main assistant's `customInstructions` to prefer calling `delegate_to_agent` **without an agent name** for tasks where the specialist is not obvious. Let the swarm decide. Reserve explicit naming only for well-established specialists and known-good routing paths.

**Supporting change:** Add a `swarm_delegate` shorthand tool that forces undirected delegation (no `agentName` field), nudging the LLM toward emergent routing rather than scripted assignment.

---

### GAP-3 — Self-Improvement Lacks Structured Attribution Audit Trail

**Philosophy stated:** *"Bounded self-improvement... refine its own system-prompt, update durable user and workflow memory, create new sub-agents."*

**Reality today:** The `config-assistant.ts` proposal system gates changes behind human approval, and `flow-memory.ts` records outcomes. However, there is no structured audit entry that links a specific `workspace/agents/*.jsonc` change to the agent that proposed it and the turn in which it was approved. An operator reviewing the git diff cannot tell which agent made a change and why.

**Planned fix (Stage 8.3):** When `config-assistant` applies an approved proposal, write a structured `self_improvement_applied` audit event containing: proposing agent name, target file, field changed, old value, new value, approval channel, and session ID. This makes the self-improvement loop fully traceable.

---

### GAP-4 — Warden Has No Self-Improvement Abuse Detection

**Reality today:** The Warden monitors for `tool_storm`, `repeated_failures`, `tool_escape_attempt`, `rate_limit_flood`, and computer-use anomalies. It does **not** watch for:
- A single agent/session flooding the config-assistant with rapid proposals (`config_proposal_flood`)
- Repeated self-improvement cycles that keep failing and re-trying (`self_improve_loop`)
- An agent repeatedly trying to grant itself higher tool tiers

**Planned fix (Stage 8.3 — ships with GAP-3 fix):** Add `config_proposal_flood` check to Warden: more than 5 config proposals from a single session within 10 minutes triggers a `warden_alert` and suspends further proposals from that session until operator acknowledgement.

---

### GAP-5 — Navigation Tools Not in Main Agent's Hybrid-Mode Direct Set

**Reality today:** `geocode_location` and `route_distance_time` are correctly registered as Tier 0 read-only tools, and the `distance_specialist` sub-agent has them. The `buildDynamicTurnGuidance` function correctly routes navigation queries to `distance_specialist` in `orchestration_only` mode.

**Gap:** In `hybrid` mode, the main agent cannot call navigation tools directly — it must always delegate to `distance_specialist` even for trivial one-step queries (e.g., "how far is Berlin from Hamburg"). The round-trip delegation adds latency and an extra LLM call.

**Planned fix (Stage 8.4 — already partially implemented in this release):** Add `geocode_location` and `route_distance_time` to `DIRECT_MAIN_TOOL_NAMES` so the main agent in hybrid mode can call them directly for simple queries while still delegating complex routing tasks to `distance_specialist`.

---

### GAP-6 — Dynamic Tool Name Collision Risk (selfdev__ Prefix Stacking)

**Reality today:** A self-developed tool named `selfdev__something` would register as `selfdev__selfdev__something`, which still matches the `selfdev__` Tier 2 pattern. No security bypass is possible (the Tier 2 sandbox enforcement still applies), but the double-prefix is confusing and may cause unexpected routing behavior.

**Planned fix (Stage 8.4):** Add a validation check in `dynamic-tools.ts` that rejects tool names starting with `selfdev__` — the prefix is the system's namespace, not the tool author's.

---

## Stage 8 — Swarm Integrity & Scale (Planned, 2026 Q2)

**Theme:** Close the architecture gaps identified above and harden the system for multi-instance deployments.

| Task | Priority | GAP |
|------|----------|-----|
| Default-containerized sub-agents (opt-out model) | High | GAP-1 |
| Undirected delegation guidance + `swarm_delegate` tool | Medium | GAP-2 |
| `self_improvement_applied` audit events | High | GAP-3 |
| Warden `config_proposal_flood` check | High | GAP-4 |
| Navigation tools in `DIRECT_MAIN_TOOL_NAMES` | Low | GAP-5 |
| `selfdev__` prefix guard in dynamic-tools.ts | Low | GAP-6 |
| Multi-instance gateway clustering (Redis-backed session sharding) | Medium | — |
| Configurable approval timeout per scene | Low | — |

---

## Stage 9 — Advanced Swarm Behaviors (Planned, 2026 Q3)

**Theme:** True peer-to-peer swarm coordination. Today all agent-to-agent communication routes through the orchestrator's tool layer. Stage 9 explores direct agent messaging via the swarm bus without orchestrator mediation.

| Feature | Description |
|---------|-------------|
| Direct A2A messaging | Agents publish `agent_message` events on the bus; peers subscribe and respond without orchestrator involvement |
| Swarm-native long-running tasks | Tasks that span multiple turns, with resumability and cross-turn memory |
| Dynamic tool promotion from `selfdev__` to catalog | Promote battle-tested dynamic tools to Tier 1/2 with human approval and full integration testing |
| Skill-gap auto-detection | System detects recurring "no suitable agent" routing failures and auto-files a capability gap record with suggested new agent spec |
| Operator dashboard for swarm health | Dedicated swarm health view: bid success rates, circuit-breaker states, promotion queue, warden alert timeline |
| GPU-aware agent routing | Route compute-heavy tasks to agents backed by models that have GPU headroom |

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
