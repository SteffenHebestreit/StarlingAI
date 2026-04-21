# Architecture & Design Philosophy

<p align="center">
    <img src="../assets/brand/swarmLogo.svg" alt="StarlingAI logo" width="180" />
</p>

StarlingAI is a general-purpose AI agent swarm built around four principles borrowed from the murmuration of starlings, extended with an explicit security contract. The system is designed to tackle any task domain by dynamically composing the right specialist agents — not by building one-off pipelines for specific workflows.

Recurring task shapes can also be encoded as reusable scenes and jobs in the workflow catalog, discovered with `search_workflows`, and executed inline with `run_workflow` before the swarm invents a fresh coordinator plan.

This document explains how the system implements each swarm principle at the code level, describes the full runtime architecture, and maps the flow from user message to final response.

See also: [Security Model](security.md) · [Tool Tiers & Guardrails](tool-tiers.md) · [Workspace Layout](../workspace/README.md)

---

## From Starling Swarm to Software Architecture

The starling murmuration (*Sternschnuppen-Schwarm*) is a self-organizing system where thousands of birds move as one fluid shape without any conductor or central plan. Each bird follows three simple local rules — avoid collision, match speed, stay close — reacting only to its 6–7 nearest neighbors. From these rules alone, complex emergent behavior arises that is more robust and adaptive than any centrally planned formation.

Most agent systems get this backwards: they build a central planner that scripts every step, assigns every task, and fails completely when one step breaks. StarlingAI takes the opposite approach. The intelligence is distributed. The robustness comes from local rules, not from a master controller.

---

## The Schwarm Principles

### 1. Lokale Regeln statt zentraler Steuerung (Local Rules, No Central Controller)

In a starling murmuration each bird follows three local rules and ignores global state. StarlingAI applies the same model: there is no monolithic planner that knows the full task graph. The orchestrator LLM emits tool calls; each sub-agent receives only its own prompt and context window; results flow back through the A2A protocol. No agent can directly instruct another without going through the orchestrator's tool layer.

This applies to any task domain — whether the swarm is analyzing market data, writing code, orchestrating browser automation, or managing communications:

At the code level this means:
- The orchestrator model runs in `packages/core/src/agent/` and communicates with sub-agents exclusively via `delegate_to_agent` / `parallel_delegate` tool calls.
- Reusable scenes and jobs act as local rules too: the orchestrator can search the workflow catalog with `search_workflows` and execute a matched reusable flow with `run_workflow` instead of rebuilding the same plan turn after turn.
- Sub-agents are isolated at the tool and session boundary. They do not coordinate directly with each other; delegation always flows back through the orchestrator tool layer. Some agents run in ephemeral containers with full heartbeat lifecycle management.
- Config hot-reload updates local rule sets (system prompts, model parameters, tool policies) without restarting the cluster.
- Heuristic routing now separates headless server administration from desktop automation: SSH, Docker, `systemctl`, `journalctl`, and log-triage requests prefer `shell_agent` or `ops_triage`, while desktop/UI work still prefers `computer_use_agent`.
- The swarm bus (`swarm/bus.ts`) extends local-rule coordination to an event-driven pub/sub layer: agents emit `task_announced` events and peers respond with ranked `task_bid` offers, enabling autonomous peer discovery without a central planner.
- A default tool registry (`agent/default-tools.ts`) defines two canonical tool sets: `DIRECT_MAIN_TOOL_NAMES` (20 tools for direct-response agents) and `ORCHESTRATION_TOOL_NAMES` (7 tools for orchestrators), so each agent role follows a consistent local ruleset.

**Current status:** Implemented. The orchestrator composes specialists without scripting their internals. Autonomous bidding via the swarm bus is active.

### 2. Emergenz (The Whole Is More Than the Sum of Its Parts)

Complex capabilities emerge from the interaction of simple agents. A user asks for a source-backed paper on a technical topic — the orchestrator does not need a hard-coded handler for this. It can first reuse a matching workflow such as `protocol_comparison_paper` or `source_grounded_paper_packet` via the workflow catalog, and if no reusable fit exists it can still chain `researcher` → `paper_author` → `source_verifier` dynamically using the hybrid routing layer. The same mechanism works for any domain: financial analysis, content creation, DevOps automation, data processing, or multimodal workflows involving PDFs, audio, and images.

This emergence is reproducible and auditable: every delegation is recorded in the audit log with inputs, outputs, and token counts. Outcome-weighted routing means the swarm continuously improves its specialist selection without manual tuning.

When no registered agent matches a task strongly enough, the **emergent architect fallback** activates: if the best routed or bid specialist scores below the configured skill-match threshold (default `0.75`), the dedicated `agent_architect` specialist designs a purpose-built ephemeral agent on the fly and that generated agent runs immediately on the original task. If the ephemeral agent succeeds repeatedly, it is auto-promoted to `.starlingai/promoted_agents.json` and becomes a permanent catalog member. This creates a self-growing specialist registry.

The collective memory layer (`swarm/memory.ts`) gives agents a shared knowledge pool backed by Redis Hash/List structures with embedding-backed semantic lookup (`write_shared_fact`, `read_shared_facts`, `share_finding`), so discoveries made by one agent in a session are available to all peers.

**Current status:** Implemented. Parallel delegation, task graphs, outcome-boosted routing, emergent architect fallback, auto-promotion, and collective memory all operate in production.

### 3. Robustheit durch Redundanz (Robustness Through Redundancy)

If a sub-agent times out or errors, the orchestrator retries with the next-best candidate from the routing result list. No single agent failure terminates the session. The `ops_triage` agent monitors provider, gateway, and channel health and can trigger corrective actions without human intervention.

At the infrastructure level:
- Docker Compose restarts failed service containers automatically.
- Outbound channel messages use `deliverWithRetry` across all five channels with exponential-backoff and fall back to the dead-letter queue. Per-channel latency percentiles (p50/p95/p99) and SLO pass rates are tracked in the channel registry.
- Container heartbeats run on a 15-second interval with a 45-second watchdog. Containers that miss the deadline receive SIGTERM followed by SIGKILL. OOM events are detected and partial results are recovered where possible.
- Chat sessions are durable and resumable until explicitly archived or deleted; durable state such as scene jobs, credentials, stored scenes, channel overrides, and audit logs persists separately, with Postgres used for scene jobs when `DATABASE_URL` is configured.
- Fallback routing exhausts explicit candidates, then auto-routes using semantic search for general-purpose coverage. A circuit breaker triggers when an agent exceeds a 60% failure rate, marking it unavailable until it recovers.
- Per-agent `turnTimeoutMs` overrides and a rate-adaptive timeout derived from outcome history prevent slow agents from blocking the swarm.

**Current status:** Implemented. Delegation fallback chains, retry logic, dead-letter queues, container heartbeats, circuit breakers, and adaptive timeouts all provide layered fault tolerance.

### 3.5. Begrenzte Selbstverbesserung (Bounded Self-Improvement)

The swarm is designed to learn and improve from outcomes, but only within bounded non-crucial surfaces. In practice this means StarlingAI may refine its managed prompts, update user or workflow memory, create new sub-agents, improve existing sub-agents, and adjust approved tool assignments for those agents when the change stays inside the platform's declared security envelope.

This does not override the earlier principles; it extends them. Self-improvement strengthens local rules, specialist matching, and long-term operator fit, but it must never replace the guarded contract with unconstrained autonomy. The swarm is allowed to tune itself only insofar as it remains faithful to the README philosophy and the compile-time/runtime controls that enforce it.

The hard boundary is secrets and privilege escalation. Stored credentials must never be read into model context or exposed as plain text to an agent. They may only be consumed through dedicated secret-handling tools such as `site_fill_credentials` and `computer_type_credential`, under approval and audit. The same rule applies to sandboxing, tool tiers, approval gates, and host access: self-improvement may optimize behavior, but it may not weaken the controls.

**Current status:** Partially implemented and intentionally guarded. Flow memory, proposal-based config changes, prompt refinement, and agent evolution exist; privileged boundaries still remain outside autonomous control.

### 4. Guarded (The Watched Swarm)

Every agent action passes through a four-layer guardrail stack before it can affect the outside world. Tool calls are classified into five tiers at compile time — not runtime-configurable. A shell command always runs inside a Docker sandbox, never on the host. Outputs are scanned for secrets before being returned to the user.

The **Warden agent** (`agent/warden.ts`) subscribes to the live audit stream and autonomously detects erratic behavior: `tool_storm`, `repeated_failures`, `tool_escape_attempt`, `rate_limit_flood`, `turn_slo_breach`, and infrastructure failures such as `docker_daemon_unreachable` when containerized delegations lose access to the Docker daemon mid-session. On detection it can halt containers, revoke capabilities, or escalate to a human operator. Swarm morphing enforces per-agent concurrency semaphores with FIFO queuing and emits backpressure events when the swarm is under load.

The **human-in-the-loop approval system** (`approval/`) adds a third layer of oversight beyond guardrails and the Warden. Per-scene `humanInLoopSteps` configuration gates specific tool calls or delegation chains behind explicit human approval via Slack Block Kit, outbound webhook, or synchronous webhook. One-click HTTP callbacks and a WebSocket `approval.respond` RPC allow operators to approve or reject in seconds without leaving their existing tooling.

**Intervention diagnostics** (`agent/interventions.ts`) classify every tool-call intervention into one of nine categories and stream the result to the WebSocket as an `intervention` event, giving operators a real-time feed of why the guardrail stack intervened.

The "Guarded" in StarlingAI reflects a fundamental constraint: agents in a starling murmuration are free to move, but StarlingAI agents operate within strict security boundaries. Speed and autonomy never come at the cost of control. This security contract applies regardless of what task domain the swarm is working in.

**Current sandbox scope — important clarification:** Sandboxing applies at the tool-execution level, not the agent-process level. `shell_exec`, `run_script`, and all `selfdev__*` dynamic tools always execute inside the dedicated `sandbox` Docker container (`--cap-drop ALL`, `--read-only`, `--network none`). Individual sub-agents that have `container.enabled: true` in their config also run their entire LLM loop in an isolated container via `container-runner.ts`. However, sub-agents without that flag run in-process inside the gateway. Stage 8 will invert this to an opt-out model: all sub-agents default to containerized execution.

**Current status:** Implemented. Four-layer guardrails, hard-coded tool tiers, Docker sandboxing for tool execution, AES-256-GCM credential store, comprehensive audit trail, active Warden agent, human-in-the-loop approval gates, and intervention diagnostics are all operational. See [ROADMAP.md](../ROADMAP.md#gap-1--container-isolation-is-opt-in-not-universal) for the planned Stage 8 container isolation improvements.

See [Tool Tiers & Guardrails](tool-tiers.md) and [Security Model](security.md) for the full specification.

---

## Implementation Status

The system has completed **Stage 9** of the swarm vision. The current codebase extends the `v0.5.0` release line with workflow-catalog reuse, server-aware ops routing, richer session and audit exports, and inline Markdown artifact previews.

| Feature | Stage | Status | Notes |
|---|---|---|---|
| **Sub-agent routing & parallel delegation** | 1 | Implemented | Task graphs, four-layer guardrails, Docker sandbox (shell tools + opt-in/opt-out container model), outcome tracking, audit trail, hot-reload config |
| **Swarm bus** | 2 | Implemented | Redis Pub/Sub with in-process EventEmitter fallback (`swarm/bus.ts`) |
| **Distributed task locks** | 2 | Implemented | `swarm/locks.ts` — prevents duplicate execution across workers |
| **Container heartbeat protocol** | 2 | Implemented | 15s interval, 45s watchdog, SIGTERM→SIGKILL, OOM detection, partial result recovery |
| **Emergent architect fallback** | 2 | Implemented | `agent_architect` designs ephemeral agents when no catalog match clears the skill threshold |
| **Auto-promotion** | 2 | Implemented | Successful ephemeral agents promoted to `.starlingai/promoted_agents.json` |
| **Autonomous bidding** | 2 | Implemented | `task_announced` / `task_bid` events; ranked offers collected before routing |
| **Warden agent** | 3 | Implemented | Detects tool_storm, repeated_failures, tool_escape_attempt, rate_limit_flood, turn_slo_breach, **config_proposal_flood** (v0.3.2), **docker_daemon_unreachable** (mid-session infra health, rate-limited to 1/min per process) |
| **Swarm morphing** | 3 | Implemented | Per-agent concurrency semaphores with FIFO queuing and backpressure events |
| **Collective memory** | 3 | Implemented | Redis Hash+List shared facts, `write_shared_fact`, `read_shared_facts`, embedding-backed semantic lookup, `share_finding` tool |
| **Adaptive routing** | 3 | Implemented | Circuit breaker (>60% failure rate), `allLowConfidence` flag, routing rationale output |
| **25+ specialist agents** | 4 | Implemented | Domain/capabilities/tags metadata, per-agent cost profiles in list_agents/search_agents |
| **Evaluation CI** | 4 | Implemented | Regression comparison, --baseline flag, routing accuracy benchmarks (75% gate, 18 cases) |
| **Channel hardening** | 5 | Implemented | WhatsApp signature verification, replay-window deduplication, `deliverWithRetry` for all 5 channels, p50/p95/p99 latency, SLO pass rate, Discord health check parity |
| **Turn performance metrics** | 6 | Implemented | `turn_performance` audit events with full `TurnPerformanceMetrics`; cold-start: `containerColdStartMs`, `containerBootstrapMs`, `containerRuntimeMs` |
| **Per-agent adaptive timeouts** | 6 | Implemented | `turnTimeoutMs` overrides + rate-adaptive timeout derived from outcome history |
| **Token-by-token streaming** | 6 | Implemented | True streaming via `provider.stream()`; embedding query cache for semantic routing |
| **Multimodal tools** | 7 | Implemented | `extract_file_content`, `transcribe_audio`, `synthesize_speech`, `list_tts_voices`, `analyze_image` |
| **Browser tools** | 7 | Implemented | `browser_navigate`, `browser_snapshot`, `browser_wait_for`, `browser_click`, `browser_type`, `browser_select_option`, `browser_screenshot` (Playwright MCP wrappers) |
| **Human-in-the-loop approvals** | 7 | Implemented | Slack Block Kit, outbound webhook, sync webhook; per-scene `humanInLoopSteps`; one-click HTTP callbacks; WebSocket `approval.respond` RPC |
| **Intervention diagnostics** | 7 | Implemented | `classifyToolIntervention()` with 9 categories; streamed to WebSocket as `intervention` events |
| **Default tool registry** | 7 | Implemented | `DIRECT_MAIN_TOOL_NAMES` (20 tools) + `ORCHESTRATION_TOOL_NAMES` (7 tools) |
| **Standalone scene worker** | 7 | Implemented | `pnpm --filter @starlingai/core worker:scene` runs queued scene jobs outside the gateway process; set `SAI_DISABLE_EMBEDDED_SCENE_WORKER=1` on the gateway when splitting processes |
| **Container opt-out model** | 8 | Implemented (v0.3.2, default flipped post-v0.6.4) | `agents.defaultContainerized: true` global flag (set `STARLINGAI_DEFAULT_CONTAINERIZED=false` to opt out in tests) + per-agent `container.disabled: true` escape hatch; 27 trusted agents pre-opted-out in the workspace catalog (see GAP-1 in ROADMAP) |
| **Self-improvement audit trail** | 8 | Implemented (v0.3.2) | `config_proposal_created` / `config_proposal_applied` / `self_improvement_applied` audit events with full attribution (proposingAgent, targetAgent, changes); Warden detects proposal floods |
| **selfdev__ prefix guard** | 8 | Implemented (v0.3.2) | Dynamic tool validator rejects any tool definition whose name starts with `selfdev__` (prefix stacking attack blocked) |
| **Grounded chart and Mermaid artifacts** | 9.1 | Implemented (v0.4.1) | `generate_chart_html` can carry explicit source attachments; `generate_mermaid_diagram` produces previewable diagram artifacts end-to-end |
| **Browser-backed search and fetch fallback** | 9.1 | Implemented (v0.4.1) | Search can fall back through Playwright when SearXNG is unavailable; `web_fetch` prefers rendered HTML for JavaScript-heavy pages |
| **Session debug Markdown export** | 9.1 | Implemented (v0.4.1) | REST export combines transcript, raw history, and audit evidence for operator review |
| **Workflow catalog reuse** | 9.2 | Implemented | `search_workflows` and `run_workflow` let coordinators reuse scenes/jobs before inventing new orchestration for recurring packets |
| **Server-aware SSH and ops routing** | 9.2 | Implemented | Headless server tasks prefer `shell_agent` / `ops_triage`; `ssh_exec` can resolve configured `remote_ssh` nodes, including password-backed targets |
| **Markdown artifact previews + audit-only exports** | 9.2 | Implemented | Markdown artifacts render inline in chat; sessions can export focused audit-only Markdown alongside the full debug bundle |
| **Live shell preview and synthetic swarm status** | 9.2 | Implemented | The dashboard can surface shell/SSH activity and keep showing swarm progress from audit events even when explicit swarm-state updates lag |

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Clients                                                             │
│  Vue 3 Dashboard (WebSocket / SSE, audit export, shell preview)     │
│  ·  REST  ·  Message Channels                                       │
└────────────────────────┬────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────────┐
│  Gateway  (packages/core/src/gateway/)                               │
│  Hono HTTP server                                                    │
│  ├─ WebSocket RPC     ws://host:8765/ws?token=<jwt>                 │
│  │    approval.respond  ·  intervention events  ·  audit stream     │
│  ├─ AG-UI SSE         POST /api/chat/stream                         │
│  ├─ REST API          /api/*                                         │
│  │    /api/multimodal/config  ·  /api/multimodal/status             │
│  │    /api/multimodal/file    ·  /api/multimodal/stt                │
│  │    /api/multimodal/tts     ·  /api/multimodal/voices             │
│  └─ A2A JSON-RPC      POST /a2a/agents/:name                        │
└────────────────────────┬────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────────┐
│  Guardrails stack  (packages/core/src/guardrails/)                   │
│  Input scanner → Tool tier check → Rate limiter → Output scanner    │
│                          │ intervention event (9 categories)        │
└────────────────────────┬─┴───────────────────────────────────────── ┘
                         │
┌────────────────────────▼────────────────────────────────────────────┐
│  Approval gate  (packages/core/src/approval/)                        │
│  humanInLoopSteps check → Slack / outbound-webhook / sync-webhook   │
│  approval store  ·  one-click HTTP callback  ·  WS approval.respond │
└────────────────────────┬────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────────┐
│  Orchestrator Agent  (packages/core/src/agent/)                      │
│  LLM: configurable model via LM Studio / Anthropic                  │
│  Tools: search_agents, search_workflows, run_workflow,              │
│         delegate_to_agent, parallel_delegate                        │
│         + all Tier 0–3 tools + multimodal tools + browser tools     │
└────────┬───────────────┬──────────────────────────┬────────────────┘
         │               │ task_announced (bus)      │ parallel_delegate
         │         ┌─────▼──────────────────┐        │
         │         │  Swarm Bus             │        │
         │         │  (swarm/bus.ts)        │        │
         │         │  Redis Pub/Sub +       │        │
         │         │  EventEmitter fallback │        │
         │         │                        │        │
         │         │  task_announced        │        │
         │         │  task_bid              │        │
         │         │  task_assigned         │        │
         │         │  task_completed        │        │
         │         │  backpressure          │        │
         │         └─────┬──────────────────┘        │
         │               │                           │
┌────────▼───────────────▼───────────────────────────▼──────────────┐
│  Sub-Agent Runners                                                  │
│  ├─ Per-agent concurrency semaphore (swarm/concurrency.ts)         │
│  ├─ Distributed task lock (swarm/locks.ts)                         │
│  ├─ Container runner with heartbeat (15s/45s watchdog)             │
│  └─ Ephemeral architect fallback → auto-promote to catalog         │
└────────┬───────────────────────────────────────────────────────────┘
         │
┌────────▼───────────────────────────────────────────────────────────┐
│  Warden  (agent/warden.ts)                                          │
│  Subscribes to live audit stream                                    │
│  Detects: tool_storm · repeated_failures · tool_escape_attempt     │
│           rate_limit_flood · turn_slo_breach                        │
│  Actions: halt container · revoke capability · escalate to human   │
└────────┬───────────────────────────────────────────────────────────┘
         │
┌────────▼───────────────────────────────────────────────────────────┐
│  Collective Memory  (swarm/memory.ts)                               │
│  Redis Hash+List shared facts                                       │
│  Embedding-backed semantic lookup                                   │
│  Tools: write_shared_fact · read_shared_facts · share_finding      │
└────────┬───────────────────────────────────────────────────────────┘
         │
┌────────▼───────────────────────────────────────────────────────────┐
│  Providers  (packages/core/src/providers/)                          │
│  LM Studio (OpenAI-compatible, port 1234) — primary                │
│  Anthropic cloud — optional fallback                                │
│  provider.stream() — true token-by-token streaming                 │
│  embeddings.ts — semantic agent search index + query cache         │
└────────────────────────────────────────────────────────────────────┘
```

### Transport Layers

| Layer | Protocol | Path | Purpose |
|-------|----------|------|---------|
| WebSocket RPC | JSON over WS | `ws://host:8765/ws` | Interactive chat, durable session management, audit streaming, approval responses, intervention events |
| AG-UI SSE | Server-Sent Events | `POST /api/chat/stream` | Token-level streaming to the Vue dashboard |
| REST API | HTTP/JSON | `/api/*` | Programmatic control, health, metrics, multimodal file/STT/TTS endpoints |
| A2A JSON-RPC 2.0 | HTTP/JSON | `POST /a2a/agents/:name` | Agent-to-agent delegation |

---

## The Multi-Agent Loop

```
User message
    │
    ▼
[1] Gateway authenticates JWT, enforces IP rate limit, and restores durable session context when a sessionId is supplied
    │
    ▼
[2] Input guardrail scans for prompt injection
    │  → classifyToolIntervention() emits intervention event (9 categories)
    │
    ▼
[3] Approval gate checks humanInLoopSteps for this scene
    │  → if step is gated: notify operator via Slack / webhook
    │  → wait for approval.respond RPC or HTTP callback before proceeding
    │
    ▼
[4] Orchestrator LLM receives message + conversation history
    │
    ▼
[5] Orchestrator emits tool call: search_agents(query)
    │
    ▼
[6] Hybrid router scores all agents
    │  keyword score
    │  + cosine similarity on embeddings (query cache applied)
    │  + outcome boost (±12.5% from outcome history)
    │  + circuit breaker suppression (>60% failure rate)
    │  → allLowConfidence flag triggers emergent architect fallback
    │
    ▼
[7] Swarm bus: orchestrator emits task_announced event
    │  → peers respond with ranked task_bid offers
    │  → highest-bid agent receives task_assigned
    │
    ▼
[8] Orchestrator emits tool call: delegate_to_agent(name, task)
     or: parallel_delegate([{name, task}, ...]) for concurrent work
    │
    ▼
[9] Sub-agent runner:
    │  - Acquires distributed task lock (swarm/locks.ts)
    │  - Acquires per-agent concurrency semaphore (swarm/concurrency.ts)
    │  - Builds prompt from system prompt + task + context
    │  - Calls provider with agent's model config (streaming)
    │  - Executes any tool calls the sub-agent makes
    │    (multimodal: extract_file_content, transcribe_audio,
    │     synthesize_speech, analyze_image, browser_* tools)
    │  - Records containerColdStartMs, containerBootstrapMs,
    │    containerRuntimeMs in turn_performance audit event
    │  - Returns result to orchestrator; releases lock and semaphore
    │
    ▼
[10] If ephemeral agent succeeded → auto-promote to catalog
     Collective memory updated via write_shared_fact / share_finding
     │
    ▼
[11] Warden samples audit stream in background
     → detects anomalies; can halt container or escalate
     │
    ▼
[12] Orchestrator incorporates result, continues reasoning
     (steps 5–12 repeat until no more tool calls)
    │
    ▼
[13] Output guardrail scans for secrets, redacts if needed
    │
    ▼
[14] Response streamed to client via AG-UI SSE / WebSocket
```

---

## Hybrid Agent Routing

The `search_agents` tool scores every registered agent against the query using four signals:

**Keyword scoring** — TF-IDF-style term overlap between the query and the agent's description, tags, capabilities, and tool list. Always available, zero latency.

**Cosine similarity on embeddings** — when an embedding model is loaded (via LM Studio or configured provider), each agent's full profile is embedded at startup and re-indexed on hot-reload. Query embeddings are computed on demand, compared via cosine similarity, and cached to avoid redundant inference on repeated or similar queries.

**Outcome boost** — `agent_outcomes.ndjson` records the result (success/failure) of every delegation. The `computeOutcomeBoost` function applies a ±12.5% multiplier to the combined score based on each agent's rolling success rate. Agents that have been failing recently are ranked lower; agents with high historical accuracy are ranked higher. This creates a self-tuning routing layer without any manual configuration.

**Circuit breaker suppression** — agents exceeding a 60% failure rate within a rolling window are removed from the routing result set until their failure rate recovers. When all candidates score below the confidence threshold, the `allLowConfidence` flag is set and the emergent architect fallback designs a purpose-built ephemeral agent.

Per-agent cost profiles (token usage estimates and latency percentiles from the catalog metadata) are surfaced in `list_agents` and `search_agents` responses, allowing the orchestrator to make cost-aware delegation decisions.

Routing accuracy is validated by the evaluation CI pipeline at a 75% gate across 18 benchmark cases, with regression comparison and a `--baseline` flag for tracking improvement over time.

---

## Project Structure

```
packages/
  core/                     Gateway, agent runtime, guardrails, tools, providers
    src/
      agent/                session.ts — conversation and tool loop
                            runtime.ts — agent config loader and lifecycle
                            sub-agent.ts — A2A delegation client
                            container-runner.ts — Docker sandbox runner + heartbeat
                            container-entrypoint.ts — in-container bootstrap
                            warden.ts — audit stream monitor and anomaly responder
                            outcomes.ts — outcome recording and boost computation
                            promoted-agents.ts — ephemeral agent auto-promotion
                            interventions.ts — classifyToolIntervention (9 categories)
                            jobs.ts — background job scheduler
                            evaluation.ts — routing accuracy evaluation engine
                            evaluation-cli.ts — CLI runner for evaluation CI
                            default-tools.ts — DIRECT_MAIN_TOOL_NAMES + ORCHESTRATION_TOOL_NAMES
      approval/             index.ts — approval request orchestration
                            store.ts — pending approval state
                            status.ts — approval lifecycle tracking
                            channels/slack.ts — Slack Block Kit approval messages
                            channels/outbound-webhook.ts — fire-and-forget webhook
                            channels/sync-webhook.ts — synchronous approval webhook
      audit/                logger.ts — JSONL sink + turn_performance events
                            postgres.ts — optional PostgreSQL sink
                            schema.ts — Zod schemas for all audit event types
      channels/             base.ts — channel interface contract
                            delivery.ts — deliverWithRetry + dead-letter queue
                            registry.ts — health checks, p50/p95/p99 latency, SLO pass rate
                            runtime.ts — channel lifecycle management
                            dead-letter.ts — failed message persistence
                            telegram.ts · slack.ts · discord.ts · whatsapp.ts · email.ts
      config/               loader.ts — JSON5 loader + hot-reload watcher
                            schema.ts — Zod config schema
      credentials/          store.ts — AES-256-GCM encrypted credential store
                            scenes.ts · sites.ts · channels.ts · pairings.ts
      gateway/              index.ts — Hono HTTP server, routing, middleware
                            auth.ts — JWT authentication + IP rate limiting
                            rpc.ts — WebSocket JSON-RPC handler
                            agui.ts — AG-UI SSE streaming endpoint
      guardrails/           input.ts — prompt injection scanner
                            output.ts — secret scanner and redactor
                            tool-tiers.ts — compile-time tool tier classification
                            rate-limiter.ts — per-user and per-agent rate limits
                            store.ts — guardrail state persistence
                            redis-client.ts — shared Redis connection
      mcp/                  client.ts — MCP protocol client
                            registry.ts — MCP tool-bridge registry
      providers/            index.ts — LM Studio + Anthropic adapters, provider.stream()
                            lmstudio.ts — OpenAI-compatible local model adapter
                            embeddings.ts — semantic agent search index + query cache
      swarm/                bus.ts — Redis Pub/Sub bus + EventEmitter fallback
                            locks.ts — distributed task locks
                            memory.ts — collective memory (Redis Hash+List + embeddings)
                            concurrency.ts — per-agent semaphores with FIFO queuing
                            bidding.ts — task_announced / task_bid auction protocol
      tools/                registry.ts — tool registration and tier enforcement
                            sub-agent.ts — delegate_to_agent / parallel_delegate
                            filesystem.ts · shell.ts · web.ts · memory.ts
                            webhooks.ts · credentials.ts · workspace-search.ts
                            multimodal.ts — extract_file_content, transcribe_audio,
                                            synthesize_speech, list_tts_voices,
                                            analyze_image, browser_* (Playwright MCP)
  web/                      Vue 3 dashboard (Vite + Tailwind + Three.js)
    src/
      components/           MessageBubble.vue — chat message renderer
                            LoginModal.vue — JWT login
                            OrbCanvas.vue — Three.js swarm visualizer
                            SwarmStatusPanel.vue — live agent and bus status
                            ToolCallCard.vue — tool call inspector
                            ToggleSwitch.vue — settings toggle
                            ChannelIcon.vue — channel type icon
      pages/                Chat.vue — main chat interface with streaming
                            Settings.vue — agent, guardrail, channel configuration
                            AuditLog.vue — real-time audit event viewer
                            Sessions.vue — session history browser
      stores/               gateway.ts — WebSocket connection and RPC
                            agents.ts — agent catalog and routing state
                            guardrails.ts — guardrail configuration
                            channels.ts — channel status and metrics
                            sites.ts · scenes.ts — credential management
                            audit.ts — audit event stream
                            runtime.ts — swarm runtime status
                            multimodal.ts — multimodal config and status
docker/
  gateway/Dockerfile        Gateway service container
  web/Dockerfile            Nginx-served Vue dashboard
  web/nginx.conf            Nginx reverse proxy config
  sandbox/Dockerfile        Isolated Docker sandbox for shell tool execution
scripts/
  setup.mjs                 First-run setup utility
  gen-token.mjs / .sh / .bat  JWT token generation
tutorials/                  Interactive HTML tutorials for agents, channels, scenes
```
