# StarlingAI Development Roadmap

This roadmap evolves StarlingAI from a centrally orchestrated agent system into a true decentralized "Starling Swarm" — a general-purpose agent platform governed by local rules, emergent behavior, self-healing, and robust dynamic sandboxing. The system is designed to tackle any task domain by composing the right specialists, not by building one-off pipelines.

## Current State: Stages 2–8 Complete, Remaining Backlog in Progress

The system has functional centralized orchestration with several swarm and evaluation capabilities now live:

- Hybrid agent routing (keyword + embedding + outcome boost ±12.5%)
- 25+ pre-configured specialist agents with explicit `domain`, `capabilities`, and `tags` metadata covering research, coding, browser, data, communication, workflow, and reliability domains
- Circuit breaker: agents with >60% failure rate over last 10 outcomes are automatically excluded from routing
- Routing confidence gate: `allLowConfidence` flag surfaces when all candidates score low
- Parallel delegation (up to 5 concurrent sub-tasks)
- Task graph execution (DAG with per-node fallbacks)
- Ephemeral agent creation via `create_ephemeral_agent`
- Four-layer guardrail stack (input scanner, tool-tier check, output scanner, final redactor)
- Docker sandboxing with unconditional security flags (`--cap-drop ALL`, `--read-only`, `--network none`)
- Container heartbeat protocol (stdio-based, 15s interval, 45s watchdog), graceful SIGTERM→SIGKILL shutdown, OOM detection, and partial result recovery
- Playwright-backed browser automation plus vision-model screenshot/image analysis for web and visual evidence tasks
- Six active messaging channels (webchat, Telegram, Slack, Discord, WhatsApp, Email)
- WhatsApp: signature verification, health checks, pairing persistence, rate limiting, and replay-window deduplication (5-min window)
- Outcome tracking in NDJSON log with routing feedback loop
- Complete audit trail (JSONL + PostgreSQL + real-time WebSocket stream)
- Hot-reloadable configuration with Zod validation
- Evaluation CI: regression comparison (`compareEvaluationReports`), `--baseline` CLI flag, routing accuracy benchmarks (75% gate, 18 cases)
- Model profiles tuned per agent role (orchestrator, deterministic tools, browser/workflow, writing)

### Known Implementation Gaps

| Area | Current State | Impact |
|---|---|---|
| **Routing centralization** | All delegation paths funnel through single `resolveAgentRouting()` | No autonomous agent-to-agent discovery |
| ~~Autonomous bidding (first-pass only)~~ | ✅ Resolved — `startBidderWorker()` runs a fully independent long-running bidder process alongside first-pass `startAutonomousBidding()` | — |
| **No dynamic replica scaling** | Per-agent concurrency caps and backpressure signals exist, but container replica count is static | Bottlenecked specialists still require manual operator tuning (requires K8s/Swarm) |
| **No native computer-use substrate** | Browser automation exists, but there is no first-class local desktop / remote workstation session model | Agents cannot safely operate VS Code, desktop apps, OS dialogs, or remote GUI sessions like a human operator |
| ~~No vector-backed shared-memory retrieval~~ | ✅ Resolved — `read_shared_facts(query=...)` uses embedding-backed lookup with keyword fallback | — |
| ~~No cold-start timing hooks~~ | ✅ Resolved — container worker emits `READY:<ms>`; runner records `containerColdStartMs`, `containerBootstrapMs`, `containerRuntimeMs` | — |
| ~~No adaptive timeout policy~~ | ✅ Resolved — rate-adaptive timeout derives bounded recommendation from recent outcome history | — |

### Current Priority Before New Platform Work

Before adding Keycloak/SSO or other new platform scope, the remaining roadmap backlog should be closed first:

- ✅ Complete fully independent long-running bidder processes so swarm discovery is no longer limited to first-pass event bidding.
- ✅ Replace the remaining centralized `run_task_graph` path with a true event-driven execution flow.
- ✅ Finish adaptive routing improvements by re-evaluating outcome boost during fallback chains, not only at initial delegation.
- Decide the production approach for dynamic replica scaling and resource reservation, or explicitly move it to an orchestration-specific roadmap.
- ✅ Expand the evaluation suite depth so new agents ship with stronger regression coverage by default.

The native computer-use / remote-access expansion below is now defined in this roadmap as a concrete future stage, but implementation should remain feature-flagged and policy-gated until the backlog above is closed or explicitly deferred.

---

## Stage 2: Decentralized Swarm Core

### 2.1 Event-Driven Swarm Bus (Rule_Sync) ✅ (infrastructure phase)

**Goal:** Replace top-down task assignment with an asynchronous event-driven model where agents can discover work autonomously.

- ✅ `packages/core/src/swarm/bus.ts` — Redis Pub/Sub bus with in-process EventEmitter fallback. Gracefully degrades when `REDIS_URL` is absent.
- ✅ `packages/core/src/swarm/locks.ts` — Distributed task locks via Redis `SET NX PX`. Falls back to in-process Map. Atomic owner-checked release via Lua script.
- ✅ `executeDelegationWithFallback()` emits `task_announced` → `task_claimed` → `task_completed`/`task_failed`. Lock acquired on claim, released on resolution.
- ✅ Container runner emits `task_requeued` with `{ reason: "heartbeat_lost", staleMs }` on watchdog fire (completing Stage 2.2 deferred item).
- ✅ Bus lifecycle wired into gateway startup/shutdown.
- ✅ 11 unit tests across bus delivery, event types, and lock behaviour (99 total passing).
- ✅ First-pass autonomous bidding — `task_announced` events with `dispatchMode: "autonomous_bidding"` now gather ranked `task_bid` offers over the swarm bus before local claim/execution
- ✅ Fully independent long-running bidder worker — `packages/core/src/swarm/bidder-worker.ts` runs a persistent process that scores every `task_announced` event against a keyword-based agent catalog, emits `task_bid` offers, and auto-refreshes the agent index on config changes.
- ✅ Event-driven `run_task_graph` — emits `graph_started`, `graph_node_ready`, `graph_node_blocked`, `graph_completed` lifecycle events over the swarm bus at every state transition.

Relevant code paths:
- `packages/core/src/swarm/bus.ts` — event bus (includes `graph_started`, `graph_node_ready`, `graph_node_blocked`, `graph_completed` event types)
- `packages/core/src/swarm/locks.ts` — distributed locks
- `packages/core/src/swarm/bidder-worker.ts` — long-running bidder worker process with keyword-based scoring and periodic catalog refresh
- `packages/core/src/tools/sub-agent.ts` — delegation emits swarm events; `run_task_graph` emits graph lifecycle events
- `packages/core/src/agent/container-runner.ts` — `task_requeued` on heartbeat loss
- `packages/core/src/tests/bidder-worker.test.ts` — 5 tests for bidder worker
- `packages/core/src/tests/graph-events.test.ts` — 3 tests for graph lifecycle events

### 2.2 Container Heartbeats and Self-Healing (Rule_Heal) ✅

**Goal:** Detect container failures in real-time and automatically re-queue tasks.

- ✅ Entrypoint writes `HEARTBEAT:<ms>` to stderr every 15s; runner strips and tracks timestamps
- ✅ Watchdog fires after 45s silence (with 20s warmup grace); graceful SIGTERM → SIGKILL after 5s
- ✅ OOM detection: exit code 137 + stderr pattern (`oom.kill|out of memory|killed`)
- ✅ Partial result recovery: `recoverPartialOutput()` extracts longest non-JSON line from stdout on abnormal exit
- ✅ `resolved` guard prevents double-resolution across concurrent exit paths
- Swarm event bus re-queue on heartbeat loss — deferred to Stage 2.1 (requires event infrastructure)

Relevant code paths:
- `packages/core/src/agent/container-entrypoint.ts` — heartbeat emission
- `packages/core/src/agent/container-runner.ts` — watchdog, graceful shutdown, OOM, partial recovery

### 2.3 Emergent Agent Architect ✅

**Goal:** When routing confidence is low for all existing agents, automatically create a tailored ephemeral agent instead of failing.

- ✅ `runArchitectFallback(task, ctx)` — when routing finds zero candidates, calls the LLM to design a purpose-built ephemeral agent spec (system prompt, tools from GRANTABLE_TOOLS, maxIterations)
- ✅ Spec is validated by `validateEphemeralToolSelection` before running
- ✅ On success: `maybePromoteEphemeral()` checks outcome history — if ≥3 successes with >60% rate, auto-promotes to `.starlingai/promoted_agents.json`
- ✅ Promoted agents are merged into `resolveAgentRouting()` and `list_agents` (surfaced as "auto-promoted"); they don't overwrite permanent config entries
- ✅ All paths audit-logged (`architect_fallback_started/completed/rejected/failed`)
- ✅ 9 unit tests for the promotion store

Relevant code paths:
- `packages/core/src/tools/sub-agent.ts` — `runArchitectFallback`, `maybePromoteEphemeral`, routing merge
- `packages/core/src/agent/promoted-agents.ts` — promotion store (read/write/promote/unpromote)

### 2.4 Collective Memory (Rule_Sync Enhancement) ✅

**Goal:** Share state across the swarm without central orchestration bottlenecking data handoffs.

- ✅ `packages/core/src/swarm/memory.ts` — session-scoped Redis Hash + List with in-process fallback. Facts expire after 4 hours. `writeSharedFact`, `readAllFacts`, `appendPartialResult`, `readPartialResults`, `formatSharedContextForPrompt`, `extractFactsFromOutput`.
- ✅ Automatic shared context injection: before each `runSubAgent` call, shared facts and recent partial results from the session are formatted and prepended to the `context` parameter — sibling agents see what peers already found.
- ✅ Automatic fact extraction: after each successful sub-agent, any `FACT: key = value` lines in the output are parsed and stored as shared facts for subsequent agents.
- ✅ Explicit `share_finding` tool: non-containerized sub-agents can publish findings mid-task via `share_finding(key, value)`. Parent session is derived from `sub:parentId:...` sessionId format.
- ✅ `read_shared_facts` tool: sub-agents can proactively check what peers have already discovered.
- ✅ `packages/core/src/swarm/concurrency.ts` — per-agent-type semaphore with FIFO queuing. Prevents container explosion under parallel_delegate load. `acquireSlot` / `releaseSlot`. Configurable via `maxConcurrent` per agent (default 3). Emits `task_requeued` backpressure event when queue wait exceeds 5 s.
- ✅ Container runner path wrapped with `acquireSlot`/`releaseSlot` in `agent/sub-agent.ts`.
- ✅ `maxConcurrent` field added to `SubAgentConfigSchema` (optional, default 3).
- ✅ `GET /api/swarm/status` — operator endpoint: bus connection mode, per-agent concurrency snapshot, bottleneck summary.
- ✅ 19 new tests across facts store, partial results, fact extraction, prompt formatting, and semaphore (118 total passing).
- ✅ Semantic shared-memory retrieval — shared facts now support embedding-backed lookup with keyword fallback through `read_shared_facts(query=...)`

Relevant code paths:
- `packages/core/src/swarm/memory.ts` — collective memory store
- `packages/core/src/swarm/concurrency.ts` — concurrency semaphore
- `packages/core/src/tools/memory.ts` — `share_finding`, `read_shared_facts` tools
- `packages/core/src/tools/sub-agent.ts` — context injection + fact extraction
- `packages/core/src/gateway/index.ts` — `GET /api/swarm/status`

---

## Stage 3: Dynamic Perimeters and Adaptation

### 3.1 The Warden Agent (Immune System) ✅

**Goal:** Enforce safety boundaries over unpredictable emergent behaviors with a runtime monitor.

- ✅ `startWarden()` subscribes to the live audit stream and runs a 30s sweep interval
- ✅ **tool_storm** — session accumulates >15 tool calls in 5 min → `warden_alert` (warn)
- ✅ **repeated_failures** — agent fails ≥3 times in 2 min → appends 3 synthetic failure outcomes to reinforce circuit breaker → `warden_alert` (error)
- ✅ **tool_escape_attempt** — sub-agent has ≥3 blocked tool calls in one session → circuit breaker reinforced → `warden_alert` (error)
- ✅ **rate_limit_flood** — sender rate-limited ≥5 times in 1 min → `warden_alert` (warn)
- ✅ All alerts appear in audit JSONL and real-time WebSocket dashboard stream
- ✅ 13 unit tests across all four anomaly classes + lifecycle
- Dynamic container halt on heartbeat loss — deferred to Stage 2.1 (requires event bus)

Relevant code paths:
- `packages/core/src/agent/warden.ts` — Warden implementation
- `packages/core/src/index.ts` — `startWarden()` / `stopWarden()` lifecycle

### 3.2 Swarm Morphing (Auto-Scaling) ✅

**Goal:** Automatically scale agent resources based on demand.

- ✅ Per-agent concurrency cap with FIFO queuing (see Stage 2.4 above — `swarm/concurrency.ts`)
- ✅ Backpressure detection: `task_requeued` bus event emitted when slot wait > 5 s, observable via `GET /api/swarm/status`
- ✅ `maxConcurrent` config per agent — operators can tune parallelism per specialist type
- ✅ Container OOM / timeout → `task_requeued` event enables future re-queue policies
- ✅ Wait-time pressure metrics — `/api/swarm/status` now surfaces per-agent queued wait statistics (`oldestQueuedMs`, `avgWaitMs`, `maxWaitMs`) to identify under-resourced specialists
- Dynamic Docker replica scaling (requires external orchestrator, e.g. Swarm/K8s) — deferred

- Auto-scale container replicas of bottlenecked agents when traffic spikes
- Downscale idle containers to reclaim resources
- Implement resource reservations to prevent starvation under high load

### 3.3 Adaptive Routing ✅

**Goal:** Make routing decisions that adapt in real-time, not just at delegation time.

- Re-evaluate outcome boost during fallback chains, not just at initial delegation
- ✅ Circuit breaker: `isCircuitOpen()` reads last 10 outcomes, trips when failure rate >60% (min 3 samples); tripped agents excluded from `resolveAgentRouting()` and surfaced in `search_agents`/`list_agents` output
- ✅ `allLowConfidence` flag on `AgentRoutingResolution` — true when all matched agents score low; `search_agents` surfaces a warning
- ✅ "Why this agent" routing rationale: when `delegate_to_agent` auto-routes via `resolveAgentRouting`, the result appends `↳ Auto-routed to <agent> (<confidence>, matched: <terms>)` and includes `routingReason: { confidence, matchedTerms, score }` in metadata

Relevant code paths:
- `packages/core/src/tools/sub-agent.ts` — circuit breaker + confidence gate
- `packages/core/src/providers/embeddings.ts` — routing explanation generation

---

## Stage 4: Agent Platform Maturity

### 4.1 Agent Catalog and Discovery ✅

The agent catalog should be treated as a first-class product feature, not a collection of ad-hoc config entries.

- ✅ `domain`, `capabilities`, and `tags` fields added to `SubAgentConfigSchema` (all optional for backwards compatibility)
- ✅ All 25 agents tagged with domain, capabilities, and tags in `starlingai.json`
- ✅ New specialist agents added: `retrieval_analyst`, `workflow_designer`, `channel_operator`, `incident_responder`, `prompt_optimizer`
- ✅ `list_agents` and `search_agents` surface domain and circuit-breaker state
- ✅ Per-agent cost profiles from outcome log: `computeAgentCostProfile()` returns `{ runs, successRate, avgTokens, avgIterations }` (min 3 samples); surfaced in both `list_agents` and `search_agents`/`formatRoutingCandidate`
- ✅ `computeOutcomeBoost` re-ranks routing scores from outcome history (±12.5% adjustment based on success rate)

Relevant code paths:
- `packages/core/src/config/schema.ts` — `domain`, `capabilities`, `tags` fields
- `starlingai.json` — all agent definitions
- `packages/core/src/tools/sub-agent.ts` — catalog output

### 4.2 Evaluation Discipline ✅

The current evaluation harness exists and works. Continuous integration is now in place:

- ✅ `compareEvaluationReports(baseline, current)` — flags newly-failed cases, latency spikes (>50%), token spikes (>30%)
- ✅ `--baseline <path>` CLI flag for `evaluation-cli.ts` — loads saved baseline JSON, exits 1 on regressions
- ✅ Routing accuracy benchmark: 18 query→agent test cases, 75% accuracy gate, catches routing regressions (`packages/core/src/tests/routing-accuracy.test.ts`)
- ✅ Circuit breaker unit tests: <3 samples, >60% trips, exactly 60% does not trip, lookback window

Remaining:
- Broaden case depth over time as new agents are added, using the checked-in `agent-eval.jsonc` canonical suite as the baseline

### 4.3 Model Tuning by Role ✅

Model defaults should be tuned per agent role, not applied universally:

| Role | Temperature | Top-P | Top-K | Repeat Penalty | Notes |
|---|---|---|---|---|---|
| Orchestrator | 0.2–0.3 | 0.8–0.9 | 20–40 | 1.05–1.1 | Stable routing decisions |
| Deterministic tools (code, shell, data) | 0.1–0.2 | low/unset | 20–30 | 1.0–1.05 | Minimal variance |
| Browser and workflow | 0.15–0.25 | 0.85–0.9 | 20–40 | 1.05 | Balanced exploration |
| Writing (proposals, emails, reports) | 0.5–0.7 | 0.9–0.95 | 40–60 | 1.1–1.15 | Creative output |

**Prompt structure guidance:**
- Hard tool rules in short bullets near the top
- Explicit tool-call budget per agent
- Concrete stop conditions
- Ordered workflows for browser and shell agents
- Role-specific system prompts — avoid generic filler

Relevant code paths:
- `packages/core/src/providers/lmstudio.ts`
- `packages/core/src/providers/index.ts`
- `starlingai.json`

---

## Stage 5: Communication Channel Hardening

### 5.1 Security Parity ✅

- ✅ Pairing state persisted in encrypted credential store (`credentials/pairings.ts`)
- ✅ WhatsApp webhook signature verification (`verifyWhatsappSignature` with HMAC-SHA256 + timing-safe compare)
- ✅ WhatsApp replay-window deduplication (5-min window keyed on `message.id`)
- ✅ WhatsApp health check (Graph API `?fields=id` probe with 5s timeout)
- ✅ Per-sender rate limiting enforced at channel adapter boundary (`checkChannelIngress`)
- ✅ Discord health check parity — `/users/@me` probe registered via `setChannelHealthCheck`

Relevant code paths:
- `packages/core/src/channels/whatsapp.ts` — signature verification, replay window, health check
- `packages/core/src/credentials/pairings.ts` — persistent pairing store
- `packages/core/src/channels/base.ts` — `checkChannelIngress` rate limiter

### 5.2 Operational Improvements ✅

- ✅ All five channel adapters (Slack, Discord, Telegram, Email, WhatsApp) use `deliverWithRetry` for consistent retry, dead-letter handling, and latency recording
- ✅ Per-channel latency percentiles (p50/p95/p99), delivery SLO pass rate, and dead-letter count via `GET /api/channels/:type`
- ✅ `incident_responder` system prompt updated with channel-specific recovery procedures for all five providers, warden alert scanning, and SLO degradation thresholds

Relevant code paths:
- `packages/core/src/channels/delivery.ts` — `deliverWithRetry` with latency recording
- `packages/core/src/channels/registry.ts` — per-channel latency percentiles + SLO summaries
- `packages/core/src/gateway/index.ts` — `GET /api/channels/:type` operator endpoint
- `starlingai.json` — `incident_responder` system prompt

---

## Stage 6: Performance Under Continuous Control

### 6.1 Latency Budgets ✅

- ✅ `agents.performance` config section: `orchestratorTurnSloMs` (120s), `subAgentTurnSloMs` (60s), `firstTokenSloMs` (30s), `promptBudgetChars` (32k)
- ✅ Warden 5th anomaly class: `turn_slo_breach` — fires immediately when a `turn_performance` audit event exceeds `orchestratorTurnSloMs` or `subAgentTurnSloMs` (sub-agent sessions detected by `sub:` prefix) or `firstTokenSloMs`
- ✅ 3 new warden tests for SLO breach detection (16 total warden tests)
- ✅ Cold-start measurements for containerized agents — agent-worker now emits `READY:<ms>` and the runner records `containerColdStartMs`, `containerBootstrapMs`, and `containerRuntimeMs` on containerized sub-agent completions
- ✅ Per-agent turn timeout overrides — `subAgents.<name>.turnTimeoutMs` now aborts delegated runs before the gateway-wide timeout

### 6.2 Observability ✅

- ✅ `turn_performance` audit events logged at every turn completion with full `TurnPerformanceMetrics`: `turnDurationMs`, `firstModelResponseMs`, `llmCalls`, `llmTimeMs`, `toolCallsRequested`, `toolExecutionTimeMs`, `systemPromptChars`, `collapsedHistoryMessages`, prompt/completion chars
- ✅ Prompt budget check: on every turn's first LLM call, if `systemPromptChars > promptBudgetChars`, logs a `prompt_budget_exceeded` audit event (warn severity) with excess char count
- ✅ Per-agent cost profiles (`computeAgentCostProfile`) surface avg token usage, avg iterations, success rate in `list_agents` and `search_agents` (min 3 outcome samples)
- ✅ Embedding query cache for agent-search semantic lookups — repeated queries are cached in-memory and invalidated when the agent index rebuilds

Relevant code paths:
- `packages/core/src/agent/runtime.ts` — `TurnPerformanceMetrics`, prompt budget check
- `packages/core/src/agent/warden.ts` — `turn_slo_breach` detection
- `packages/core/src/config/schema.ts` — `agents.performance` thresholds
- `packages/core/src/agent/outcomes.ts` — `computeAgentCostProfile`

### 6.3 Streaming Optimization ✅

- ✅ True token-by-token streaming: runtime now calls `provider.stream()` instead of `provider.complete()`. Each `text_delta` chunk fires `onChunk` immediately → WebSocket sends `agent.chunk` events per token. Frontend `streamingText` accumulates incremental deltas.
- ✅ `stream_options: { include_usage: true }` — usage stats (prompt/completion/total tokens) collected from the final streaming chunk and included in `LLMResponse`, preserving full observability.
- ✅ Per-turn performance metrics on WebSocket stream — `performance` field in `status` event (already existed via `TurnPerformanceMetrics`).
- ✅ Rate-adaptive timeout policy for sub-agents — when `turnTimeoutMs` is not explicitly set, the runner derives a bounded timeout recommendation from recent successful durations in the outcome log

---

## Stage 7: Multimodal Capabilities and Human-in-the-Loop

### 7.1 Multimodal Tool Suite ✅

**Goal:** Give agents first-class access to audio, image, and file content without requiring external orchestration pipelines.

- ✅ `extract_file_content` — converts workspace files (PDF, CSV, Markdown, images, etc.) to Markdown via file-conversion backend (MCP → REST → vision model fallback chain)
- ✅ `transcribe_audio` — speech-to-text with OpenAI-compatible STT API (`/v1/audio/transcriptions`) + `/transcribe` fallback for servers that don't implement the OpenAI endpoint
- ✅ `synthesize_speech` — text-to-speech, audio written to workspace; configurable voice, language, quality, speed
- ✅ `list_tts_voices` — enumerate available voices from the TTS backend
- ✅ `analyze_image` — vision-model analysis of workspace images via LM Studio chat completions (base64 inline), with structured Markdown output
- ✅ Browser tools — `browser_navigate`, `browser_snapshot`, `browser_wait_for`, `browser_click`, `browser_type`, `browser_select_option`, `browser_screenshot` registered as direct tools wrapping the Playwright MCP server
- ✅ `multimodal` config section in schema — `files`, `stt`, `tts`, `wakeWord` sub-sections with timeouts, model IDs, and MCP server references
- ✅ `GET/PUT /api/multimodal/config`, `GET /api/multimodal/status`, `POST /api/multimodal/file-to-markdown`, `POST /api/multimodal/transcribe`, `GET /api/multimodal/voices`, `POST /api/multimodal/tts` — all wired in gateway
- ✅ Frontend Pinia store (`packages/web/src/stores/multimodal.ts`) — config fetch/save, per-service health status, wake-word localStorage sync
- ✅ `default-tools.ts` — curated `DIRECT_MAIN_TOOL_NAMES` (20 tools) and `ORCHESTRATION_TOOL_NAMES` (7 tools) with `getMainAssistantToolNames()` combining both in policy order
- ✅ `mutable config overlay` — runtime config changes written to `SAI_MUTABLE_CONFIG_PATH` overlay without touching the base file; tested in `config-loader.test.ts`
- ✅ Comprehensive unit tests across all multimodal tools: REST path, MCP path, STT fallback, TTS binary write, voice list, vision model, browser wrappers, error cases, workspace escape rejection

Relevant code paths:
- `packages/core/src/tools/multimodal.ts` — all multimodal + browser tool registrations
- `packages/core/src/agent/default-tools.ts` — tool name registry for main assistant
- `packages/core/src/config/schema.ts` — `multimodal` config section
- `packages/core/src/gateway/index.ts` — multimodal API routes
- `packages/web/src/stores/multimodal.ts` — frontend store
- `packages/core/src/tests/multimodal-tools.test.ts` — 20 unit tests

### 7.2 Human-in-the-Loop Approval System ✅

**Goal:** Allow operators to gate any tool call on human approval before execution, with multiple notification channels.

- ✅ `approvalChannels` config section — named channels of type `slack`, `outbound_webhook`, or `sync_webhook`
- ✅ `requestApprovalViaChannel(channelName, toolName, args, sceneName)` — dispatcher routes to the correct channel adapter
- ✅ **Slack** — Block Kit formatted message with approve/deny one-click links, 15-minute countdown, sent to incoming webhook
- ✅ **Outbound webhook** — POSTs rich JSON payload (toolName, args, approveUrl, denyUrl, callbackUrl, expiresInMs) to arbitrary HTTP endpoint; env var header support; integrates with n8n
- ✅ **Sync webhook** — synchronous boolean response from internal rules engine or manager dashboard
- ✅ `approval/store.ts` — in-memory pending approval store with UUID keys, auto-deny on timeout, 60s cleanup sweep, full audit trail
- ✅ `GET /api/approval/:approvalId` — one-click HTML approval handler
- ✅ `POST /api/approval/:approvalId` — programmatic callback (for webhooks and n8n)
- ✅ `approval.respond` RPC method — WebSocket dashboard approval flow
- ✅ `syncApprovalRuntimeStatus()` — validates all referenced channels exist and that `gateway.publicUrl` is set for link-based channels; called at startup and on hot reload
- ✅ Per-scene `humanInLoopSteps` and per-tier approval checks wired into `registry.ts` `executeTool()`

Relevant code paths:
- `packages/core/src/approval/index.ts` — dispatcher
- `packages/core/src/approval/channels/slack.ts`, `outbound-webhook.ts`, `sync-webhook.ts`
- `packages/core/src/approval/store.ts`, `status.ts`
- `packages/core/src/gateway/index.ts` — approval HTTP routes
- `packages/core/src/gateway/rpc.ts` — `approval.respond` RPC
- `packages/core/src/tests/delegate-approval.test.ts` — approval flow tests

### 7.3 Intervention Diagnostics ✅

**Goal:** Classify tool failures into actionable operator notices so the runtime can surface recovery options rather than generic errors.

- ✅ `classifyToolIntervention(toolResult)` — inspects tool results and returns `InterventionNotice` with `kind` (stop_turn / new_session / request_approval), `severity`, `message`, and `suggestedActions`
- ✅ `buildWardenIntervention(event)` — maps warden alert events to intervention notices
- ✅ Diagnostic categories: malformed arguments, guardrail block, timeout/stuck process, approval required, network failure, generic tool failure, empty output, tool failure spike, turn SLO breach
- ✅ Intervention notices streamed to WebSocket clients as `intervention` events in `rpc.ts`

Relevant code paths:
- `packages/core/src/agent/interventions.ts`
- `packages/core/src/gateway/rpc.ts` — `onIntervention` WebSocket streaming
- `packages/core/src/tests/interventions.test.ts`

---

## Stage 8: Voice Interaction UX

### 8.1 Smart Speech Output in Wake-Word / Voice-Input Mode ✅

**Goal:** When the user activates the swarm via wake word or microphone, the response should be speakable — but without reading out the entire text reply. The full answer stays in the chat UI; only a concise spoken summary is synthesized and played back.

#### Problem

The current flow when speech input is used:
1. Wake word / mic button → user speaks task
2. Swarm executes, returns full text response
3. Response is rendered in chat — no speech output

The full response is often structured (bullet lists, code, tables) and cannot be spoken naturally. Feeding the entire response to TTS produces an unusable, overly long audio clip.

#### Desired Behaviour

- A **"Speak reply" toggle** appears in the chat UI whenever the voice-input mode is active (wake word detected or mic button held).
- When the toggle is **on** (user wants spoken feedback):
  - After the swarm response completes, a lightweight **summarizer step** condenses the reply into 1–3 spoken sentences.
  - The summary is passed to `synthesize_speech` and the resulting audio is played back automatically.
  - The **full response text** is still displayed in the chat UI unchanged.
- When the toggle is **off** (text-only, current default):
  - Behaviour is unchanged — no TTS synthesis is triggered.
- The toggle state is persisted in `localStorage` and synced to the multimodal Pinia store.

#### Implementation Plan

**Config additions** (`multimodal.tts`)
```jsonc
"tts": {
  "baseUrl": "http://localhost:5500",
  "defaultVoice": "en_US-lessac-medium",
  "outputDir": "/workspace/audio",
  // NEW — controls spoken reply behaviour in voice-input mode
  "speakReplySummary": false,          // default off; toggled per-session from UI
  "speakReplySummaryMaxSentences": 3   // how many sentences the summary may be
}
```

**Backend — summary + TTS pipeline** (`agent/runtime.ts` or `tools/multimodal.ts`)
- After a turn completes, if `speakReplySummary` is true and the session was started from a voice-input event:
  1. Call a single-shot LLM completion with the prompt:
     `"Summarise the following reply in {{maxSentences}} spoken sentences. Use natural language, no bullet points, no markdown:\n\n{{fullResponse}}"`
  2. Pass the summary text to `synthesize_speech(text, voice, outputPath)`.
  3. Emit a new WebSocket event `agent.speech_ready` with `{ audioUrl, summary }`.
- The full response text is emitted normally via the existing `agent.message` / streaming flow — no change to the text path.

**Frontend** (`packages/web/src/pages/Chat.vue`, `stores/multimodal.ts`)
- Add a **speaker icon toggle button** next to the mic button in the input toolbar. Only visible when `wakeWord.enabled` is true or the mic button has been pressed at least once in the session.
- On receiving `agent.speech_ready`:
  - Create an `<audio>` element, set `src` to `audioUrl`, and call `.play()`.
  - Show the summary text as a small caption below the full response bubble (styled differently, e.g. italic + muted colour).
- Store `speakReplySummary` in `multimodal` Pinia store, hydrate from `localStorage` key `sai_speak_reply`.

**Gateway** (`gateway/index.ts`)
- Expose `speakReplySummary` via `GET/PUT /api/multimodal/config` (already handled by the generic config overlay mechanism).
- The `agent.speech_ready` WebSocket event should include `{ sessionId, summary, audioUrl, durationSeconds }`.

#### Scope Boundaries

| In scope | Out of scope |
|---|---|
| Summary + TTS on completed turns (non-streaming) | Real-time spoken streaming mid-response |
| Toggle persisted in localStorage | Per-agent voice profile configuration |
| Summary via direct LLM call (not a full sub-agent delegation) | Wake-word engine integration (already in Stage 7.1) |
| Audio playback in the web dashboard | Mobile app or Telegram/Slack voice note delivery |

#### Acceptance Criteria

- [x] "Speak reply" toggle appears in the chat toolbar when voice-input mode is active.
- [x] Toggle state is persisted across page reloads.
- [x] When toggle is on: a spoken summary (≤3 sentences, no markdown) is synthesized and auto-played after every turn.
- [x] Full response text is always displayed in the chat bubble, regardless of toggle state.
- [x] Summary caption is shown beneath the audio player when speech was produced.
- [x] When TTS service is unavailable, a silent fallback (no audio, no error banner) applies and the text response is unaffected.
- [x] `GET /api/multimodal/config` reflects the current `speakReplySummary` value.

#### Relevant code paths

- `packages/core/src/config/schema.ts` — `speakReplySummary`, `speakReplySummaryMaxSentences` in `MultimodalTextToSpeechSchema`
- `packages/core/src/gateway/index.ts` — `POST /api/multimodal/summarize-for-speech`
- `packages/web/src/stores/gateway.ts` — `summarizeForSpeech()`
- `packages/web/src/stores/multimodal.ts` — extended `MultimodalTtsConfig`, `readSpeakReplySummaryStorage`, `writeSpeakReplySummaryStorage`
- `packages/web/src/pages/Chat.vue` — auto-speak toggle button, `speakReplyEnabled` storage ref, auto-speak watcher, spoken summary caption

---

## Stage 9: Native Computer Access and Remote Workstation Control (IN PROGRESS)

### 9.1 Product Goal and Operating Modes

**Goal:** Make computer-use a first-class StarlingAI execution family so agents can work inside VS Code, desktop applications, and managed remote workstations the way a human operator would — while remaining observable, interruptible, policy-gated, and replayable.

**Operating Modes (Adapters)**

| Adapter | Host / Remote | Requires | Use Case |
|---|---|---|---|
| `local_vscode` | Host | VS Code CLI (`code`) | Coding, diagnostics, workspace operations |
| `local_desktop` | Host | `@nut-tree/nut-js` (default) | General desktop automation |
| `remote_vnc` | Remote | VNC server on target | Remote Linux/macOS workstation |
| `remote_rdp` | Remote | `freerdp` CLI | Remote Windows workstation |
| `ephemeral_vm` | Docker | Docker daemon | Disposable sandboxed desktop session |

All adapters implement a shared `ComputerAdapter` interface and are gated by the same tier / approval / recording stack.

### 9.2 Session & Lease Model

Every computer interaction runs inside a **ComputerSession**, identified by a random UUID.

```
ComputerSessionState: initializing → active → paused → stopping → stopped | error
                                  ↗ (attach)         ↗ (heartbeat lost)
```

- **Single-controller lease** — only one owner (`leaseOwner`) may issue actions, preventing conflicts from concurrent agents.
- **Human takeover** — `forceAttach` lets an operator seize the lease; a `computer.lease_changed` WebSocket event notifies all observers.
- **Heartbeat watchdog** — reuses the container-runner pattern (15 s emit / 45 s timeout / 20 s warmup grace). Stale sessions are paused automatically.
- **Emergency stop** — revokes the lease, kills all pending actions, marks session `stopped`, emits `computer.emergency_stop` audit event. Triggered via REST API, WebSocket RPC, or Red Button in the web dashboard.
- **Session timeout** — sessions auto-stop after `sessionTimeoutMs` (default 30 min, configurable).

### 9.3 Configuration (Joi-validated)

A new `computerUse` section is added to the root config. Because the existing config schema uses Zod, the computer-use sub-schema is validated separately with **Joi** and merged at load time. This keeps the computer-use schema self-contained while remaining compatible with the Zod root.

```jsonc
// starlingai.json excerpt
"computerUse": {
  "enabled": false,                     // global kill-switch (opt-in only)
  "adapters": {
    "local_vscode":   { "codePath": "code" },
    "local_desktop":  { "backend": "nutjs" },
    "remote_vnc":     { "host": "10.0.0.5", "port": 5900, "credentials": "vault:vnc_pass" },
    "ephemeral_vm":   { "image": "starlingai/computer-desktop:dev", "memoryMb": 2048, "cpus": 2 }
  },
  "visionModel": "",                    // falls back to multimodal.files.visionModel
  "maxConcurrentSessions": 3,
  "sessionTimeoutMs": 1800000,          // 30 min
  "heartbeatIntervalMs": 15000,
  "heartbeatTimeoutMs": 45000,
  "recordingEnabled": false,
  "screenshotMaxWidth": 1920,
  "screenshotQuality": 0.8,
  "actionPacingMs": 500,                // min delay between actions (prevents click storms)
  "emergencyStopEnabled": true
}
```

**Joi schema** lives in `packages/core/src/config/computer-use-schema.ts`. The root config loader calls `computerUseSchema.validate()` on the `computerUse` block and merges the validated result before feeding the full config to Zod.

### 9.4 Tool Inventory and Tier Assignments

#### Session Management Tools

| Tool | Tier | Approval | Description |
|---|---|---|---|
| `computer_session_start` | 2 | Per-call | Create a new computer session (adapter, config) |
| `computer_session_attach` | 2 | Per-call | Attach to an existing session |
| `computer_session_stop` | 1 | — | Graceful session teardown |

#### Interaction Tools

| Tool | Tier | Approval | Description |
|---|---|---|---|
| `computer_snapshot` | 0 | — | Capture screenshot + accessibility tree, analyze via vision model |
| `computer_click` | 2 | Lease-auto | Click at (x, y) — button, double-click options |
| `computer_type` | 2 | Lease-auto | Type text — optional Enter after |
| `computer_hotkey` | 2 | Lease-auto | Send key combo (e.g. `ctrl+s`, `alt+tab`) |
| `computer_scroll` | 2 | Lease-auto | Scroll at (x, y) — direction, amount |
| `computer_drag` | 2 | Lease-auto | Drag from (x1, y1) to (x2, y2) |
| `computer_wait_for` | 0 | — | Poll screenshots until visual condition met |
| `computer_list_windows` | 0 | — | List open windows with titles, bounds |
| `computer_focus_window` | 2 | Per-call | Focus window by title pattern |
| `computer_capture_region` | 0 | — | Capture sub-region, analyze via vision model |
| `computer_clipboard_read` | 2 | **Always** | Read clipboard (secret exposure risk) |
| `computer_clipboard_write` | 2 | **Always** | Write to clipboard (data injection risk) |
| `computer_upload_file` | 2 | **Always** | Transfer file to remote session |
| `computer_download_file` | 2 | **Always** | Transfer file from remote session |

**Lease-scoped auto-approve:** After operator approves `computer_session_start`, subsequent "Lease-auto" tools within the same session are auto-approved for a rolling 15-min window (refreshed per action). Exceptions: clipboard and file-transfer tools always require per-call approval. Warden can revoke auto-approve on anomaly.

#### VS Code-Specific Tools

| Tool | Tier | Approval | Description |
|---|---|---|---|
| `vscode_open_file` | 1 | — | Open file in editor at optional line/column |
| `vscode_run_terminal_command` | 2 | Per-call | Run command in integrated terminal |
| `vscode_get_diagnostics` | 0 | — | Read problems panel |
| `vscode_focus_panel` | 1 | — | Focus terminal / problems / explorer / source-control |
| `vscode_search_workspace` | 0 | — | Full workspace text search |
| `vscode_command` | 2 | Per-call | Execute arbitrary VS Code command (escape hatch) |
| `vscode_get_active_editor` | 0 | — | Return current file, selection, cursor |
| `vscode_diff` | 0 | — | Open diff view for two files |

### 9.5 Warden Anomaly Detection

| Anomaly | Trigger | Action |
|---|---|---|
| `computer_focus_thrashing` | >10 `focus_window` calls in 1 min | Warn + surface intervention |
| `computer_click_storm` | >30 clicks in 1 min | Revoke lease auto-approve |
| `computer_credential_prompt_loop` | >3 password dialogs in 5 min | Emergency-stop session |
| `computer_clipboard_exfiltration` | >5 clipboard reads in 1 min | Emergency-stop session |
| `computer_stale_loop` | ≥3 identical screenshot hashes with actions between | Halt + surface recovery options |

### 9.6 Intervention Types

| Kind | Trigger | Suggested Actions |
|---|---|---|
| `computer_session_unavailable` | Adapter disabled or session creation failed | Enable adapter / check config |
| `computer_focus_lost` | Window no longer focused after focus attempt | Re-try focus, switch adapter |
| `computer_dialog_blocking` | Modal dialog detected | Dismiss / interact / human override |
| `computer_stale_screenshot` | Action against outdated frameId | Re-capture snapshot first |
| `computer_session_timeout` | Session exceeded max duration | Extend timeout or stop session |
| `computer_emergency_stopped` | Operator triggered emergency stop | Review actions, optionally restart |
| `computer_lease_conflict` | Another controller holds the lease | Wait, force-attach, or abort |

### 9.7 Vision-Guided Reasoning and Recovery

**Vision pipeline** (`packages/core/src/agent/computer-vision.ts`):
- `analyzeScreenshot(buffer, prompt?)` — sends screenshot to vision model (reuses `analyzeImageBytes` from `multimodal.ts`), returns `{ description, clickableElements, activeWindow, dialogs, textContent }`.
- `compareSnapshots(prev, current)` — hash comparison for loop detection + semantic diff for state-change verification.
- `detectDialog(analysis)` — classifies modal dialogs, file choosers, credential prompts, system notifications.
- `detectProgressIndicator(analysis)` — loading bars, spinners, "Installing…" text.
- `buildComputerPrompt(snapshot, analysis, taskContext)` — structured format: accessibility tree + OCR + visual description + clickable elements with DPI-normalized coordinates.

**Screenshot hash loop detection** (extends `runtime.ts`):
- After each `computer_*` action, capture screenshot hash.
- 3 consecutive identical hashes → stuck state detected.
- Classification: dialog appeared → route to dialog handler; nothing changed → emit `computer_stale_loop` Warden anomaly; window focus changed → re-orient agent.

**Recovery strategies** (`packages/core/src/agent/computer-recovery.ts`):
- `RecoveryStrategy`: `dismiss_dialog | click_retry | wait_and_retry | change_approach | request_human | abort`
- Dialog handling: OS auth → masked credential injection (never in model context), file chooser → type path, error dialog → read and adapt, confirmation → decide from task context.
- Progress bar: detect percentage, extend wait (5 s → 10 s → 30 s → 60 s), timeout after configurable max (default 5 min).
- Overlay/notification: dismiss if unrelated, wait if related, click-through if possible.

**Compact model-visible summaries** (extends `session.ts` `getCollapsedHistory()`):
- Screenshots → `[Desktop: <window title> – <brief description>]`
- Click/type → `[Clicked <element> at (x,y)]` / `[Typed "<text>" into <field>]`
- Window list → `[Open windows: <title1>, <title2>, …]`

### 9.8 Action Hierarchy (VS Code Mode)

When operating in VS Code context, the agent follows a strict **semantic-first** hierarchy:

1. **VS Code CLI** — `code --goto`, `code --diff`, `code -r`, etc.
2. **Filesystem tools** — `read_file`, `write_file`, `edit_file` (existing tools)
3. **Desktop GUI pixel control** — `computer_click`, `computer_type` (last resort)

Before executing any `computer_click`/`computer_type` in a VS Code window, the runtime checks if an equivalent VS Code CLI or filesystem operation exists. If yes → use the semantic action and log `semantic_preferred` audit event. Track `semanticActionsUsed` vs `guiActionsUsed` ratio per session.

### 9.9 Remote Workstation Support

**Adapters:**
- `packages/core/src/agent/computer-adapters/vnc.ts` — VNC RFB protocol client (screenshot via framebuffer, input via mouse/key events, clipboard via VNC extension, exponential-backoff reconnect).
- `packages/core/src/agent/computer-adapters/rdp.ts` — `freerdp` CLI wrapper with similar interface.
- `packages/core/src/agent/computer-adapters/ephemeral-vm.ts` — Spawns Docker container with XFCE desktop + VNC server, auto-cleanup on stop, file transfer via volume mount.

**Docker image** (`docker/computer-desktop/Dockerfile`):
- Lightweight XFCE desktop, pre-installed VS Code + Chrome, TigerVNC server, noVNC web client for operator observation.
- Non-root user, `--cap-drop ALL`, network-isolated by default.
- Health check endpoint.

**Session pool** (`packages/core/src/agent/computer-session-pool.ts`):
- Pre-warmed ephemeral VMs for fast start, configurable pool size, auto-cleanup of idle sessions, lease tracking.

**Reconnection:**
1. On disconnect → pause agent
2. Retry with exponential backoff (up to `reconnectAttempts`)
3. On success → fresh screenshot, verify state, resume
4. On failure → `computer_session_disconnected` event, mark error, surface intervention

**Latency-aware pacing:**
- Measure round-trip time per action (input → screenshot shows change).
- Adjust dynamically: `max(configuredPacing, measuredRTT × 1.5)`
- Log `inputRttMs` per action.

### 9.10 Evaluation, Recording, and Rollout

**Session recording** (`packages/core/src/agent/computer-recording.ts`):
- Records `{ timestamp, action, screenshot_before_hash, screenshot_after_hash, result }` per action.
- Storage: `.starlingai/recordings/{sessionId}.ndjson`, auto-prune after 7 days.
- Replay: deterministic playback against mock adapter for regression tests.

**Evaluation fixtures** (`packages/core/src/tests/computer-eval/`):
- VS Code coding: open project → find bug → fix → run tests
- Installer: download → install → verify
- Login: navigate → enter credentials (from credential store) → verify
- File upload: open dialog → navigate → select → confirm
- Dialog handling: OS auth, error, file chooser
- Remote reconnect: establish → disconnect → reconnect → resume
- Multi-monitor: actions targeting correct monitor

**Rollout configuration:**
- `computerUse.enabled` — global kill switch (default `false`)
- Per-adapter enable flags
- `computerUse.allowedScenes` — whitelist scenes that can use computer tools
- `scenes.<name>.allowComputerUse` / `allowRemoteAdmin`
- Per-agent `computerAccess: "none" | "vscode" | "desktop" | "remote" | "all"`

**New specialist agents** (added to `starlingai.json`):
- `computer_agent` — operates VS Code, desktop apps, remote workstations via vision-guided control. Vision-capable model, low temperature (0.15).
- `computer_task_coordinator` — plans and decomposes computer-use tasks into safe atomic steps.

### 9.11 Edge Cases — Complete Coverage Matrix

| # | Edge Case | Phase | Solution |
|---|---|---|---|
| 1 | Multi-monitor / DPI scaling | 9C | `DisplayTopology` with per-monitor DPI-aware coordinate transforms |
| 2 | Window focus drift | 9B | `computer_focus_window` verifies focus; intervention on failure |
| 3 | Modal dialogs / OS prompts | 9C | `detectDialog()` classifier routes to dialog-specific handler |
| 4 | Stale screenshots | 9C | `frameId` on each snapshot; tools reject actions against outdated IDs |
| 5 | Canvas / inaccessible UIs | 9C | OCR + screenshot analysis + `computer_capture_region` fallback |
| 6 | Remote disconnect | 9E | Heartbeat + exponential reconnect + fail-closed with resumable state |
| 7 | File chooser dialogs | 9C/9D | Type path into dialog, verify with vision |
| 8 | Secrets and MFA | 9B/9E | Encrypted store → masked approval → secure injection, never in model context |
| 9 | Human takeover | 9A | Single-controller lease, `forceAttach`, `lease_changed` event |
| 10 | Long-running installs | 9C | `detectProgressIndicator()` + increasing wait intervals (5 s → 60 s) |
| 11 | Locale / keyboard layout | 9B | Adapter reports layout, `computer_type` maps characters |
| 12 | Clipboard leakage | 9B | `computer_clipboard_read` always requires per-call approval + output scanner |
| 13 | VS Code dirty workspace | 9D | Check unsaved files, warn agent, optionally auto-save |
| 14 | RDP/VNC latency | 9E | Latency-aware pacing: `max(configured, RTT × 1.5)` |
| 15 | System notifications / overlays | 9C | `detectOverlay()` in vision pipeline — dismiss / wait / route |
| 16 | Privilege escalation attempt | 9B | sudo/UAC blocked at tier level; `ctrl+alt+delete` → Tier 4 blocked |
| 17 | Screenshot contains PII | 9B | Vision output → output scanner; screenshots stored only if recording enabled |
| 18 | Concurrent agents on same desktop | 9A | Session lease prevents concurrent control |
| 19 | Infinite retry loop | 9C | Screenshot hash dedup (3 identical → halt) + Warden anomaly |
| 20 | Resolution change mid-session | 9A | Adapter detects topology change, invalidates cached coordinates |
| 21 | Network partition (remote) | 9E | Heartbeat timeout → pause → reconnect → resume or fail closed |
| 22 | Container OOM (ephemeral VM) | 9E | Exit 137 detection, workspace data preserved in volume |
| 23 | Model hallucinates coordinates | 9C | Validate within display bounds; post-action screenshot verifies change |
| 24 | Tool budget exhaustion | 9C | Compact summaries reduce tokens; higher iteration limit for computer tasks |
| 25 | Session ID guessing | 9A | UUID lease ownership check on every tool call |
| 26 | Desktop resolution unknown at start | 9A | Adapter reports topology on init; reject actions until topology known |

### 9.12 Phased Delivery

| Sub-Phase | Name | Description | Gate |
|---|---|---|---|
| **9A** | Session & Adapter Foundation | Types, session manager, adapter interface, Joi config schema, gateway endpoints, WebSocket events, audit events | `computer-session.test.ts` green — session lifecycle, lease, heartbeat |
| **9B** | Minimal Safe Desktop Toolchain | 22 tools (14 `computer_*` + 8 `vscode_*`), tiers, lease-scoped auto-approve, intervention types, Warden anomalies | `computer-use-tools.test.ts` green — all tools against mock adapter |
| **9C** | Vision-Guided Reasoning & Recovery | Vision pipeline, screenshot loop detection, recovery strategies, compact summaries, multi-monitor/DPI | `computer-vision.test.ts` green — loops, dialogs, recovery |
| **9D** | VS Code-Native Work Mode | VS Code adapter, action hierarchy, specialist agents, dynamic turn guidance | `vscode-adapter.test.ts` green — CLI, hierarchy, fallback |
| **9E** | Remote Workstation Support | VNC/RDP/ephemeral-VM adapters, Docker image, session pool, reconnect, latency pacing, compose overlay | Integration test against ephemeral container |
| **9F** | Evaluation, Replay, Rollout | Recording, replay regression, eval fixtures, frontend observer, rollout config | Full eval suite + manual operator walkthrough |

### 9.13 Implementation Targets

#### Files to Modify

- `packages/core/src/config/schema.ts` — add `computerUse` to root config
- `packages/core/src/guardrails/tool-tiers.ts` — 22 tool tier entries
- `packages/core/src/tools/registry.ts` — lease-scoped auto-approve
- `packages/core/src/agent/runtime.ts` — screenshot hash loop detection, `isComputerUseTask()` guidance, compact summaries
- `packages/core/src/agent/session.ts` — collapse computer tool results in `getCollapsedHistory()`
- `packages/core/src/agent/interventions.ts` — 7 computer intervention types
- `packages/core/src/agent/warden.ts` — 5 computer anomaly classes
- `packages/core/src/tools/multimodal.ts` — reuse `analyzeImageBytes`
- `packages/core/src/gateway/index.ts` — computer session REST endpoints
- `packages/core/src/gateway/rpc.ts` — computer WebSocket events
- `packages/core/src/agent/default-tools.ts` — register computer tools
- `starlingai.json` — `computer_agent`, `computer_task_coordinator`, `computerUse` config
- `starlingai.example.json` — example configuration

#### New Files

- `packages/core/src/agent/computer-session.ts` — session types + manager
- `packages/core/src/config/computer-use-schema.ts` — Joi config schema
- `packages/core/src/agent/computer-adapters/base.ts` — adapter interface
- `packages/core/src/agent/computer-adapters/vscode.ts` — VS Code adapter
- `packages/core/src/agent/computer-adapters/desktop.ts` — local desktop adapter
- `packages/core/src/agent/computer-adapters/vnc.ts` — VNC adapter
- `packages/core/src/agent/computer-adapters/rdp.ts` — RDP adapter
- `packages/core/src/agent/computer-adapters/ephemeral-vm.ts` — ephemeral VM adapter
- `packages/core/src/agent/computer-vision.ts` — vision analysis pipeline
- `packages/core/src/agent/computer-recovery.ts` — recovery strategies
- `packages/core/src/agent/computer-recording.ts` — session recording & replay
- `packages/core/src/agent/computer-session-pool.ts` — remote session pool
- `packages/core/src/tools/computer-use.ts` — all computer-use tools
- `packages/core/src/tests/computer-session.test.ts`
- `packages/core/src/tests/computer-use-tools.test.ts`
- `packages/core/src/tests/computer-vision.test.ts`
- `packages/core/src/tests/vscode-adapter.test.ts`
- `packages/web/src/pages/ComputerSession.vue` — session observer view
- `packages/web/src/stores/computer.ts` — frontend state
- `docker/computer-desktop/Dockerfile` — ephemeral VM desktop image
- `docker-compose.computer.yml` — computer service compose overlay

#### New Dependencies

- `joi` — Joi validation for computer-use config schema
- `@nut-tree/nut-js` — cross-platform desktop automation (mouse, keyboard, screen capture)
- `sharp` — screenshot image processing / resizing / compression
- `node-vnc` (or equivalent) — VNC client for remote sessions
- `tesseract.js` (optional) — client-side OCR for inaccessible UIs (vision model preferred)

#### Key Decisions

- **Opt-in only** — `computerUse.enabled` defaults to `false`. Operators must explicitly enable adapters.
- **Joi for computer-use config** — keeps the computer-use schema self-contained; merged into Zod root at load-time.
- **Action hierarchy** — semantic/API actions always attempted before GUI pixel control (lower error rate, deterministic).
- **Single-controller lease** — one owner per session, human takeover via `forceAttach`, no simultaneous input without shared-control flag.
- **Vision model** — reuses `multimodal.files.visionModel` with override. Qwen2.5-VL-7B recommended.
- **Credential handling** — passwords never in model context. Encrypted store → masked approval → secure injection.
- **Recording** — opt-in, required for Tier 3+ actions. NDJSON with screenshot hashes (not full screenshots) by default.
- **Pacing** — configurable minimum delay (default 500 ms) prevents click storms and respects remote latency.
- **Not in scope (v1)** — autonomous background control without lease, privilege escalation/UAC bypass, mobile mirroring, replacing existing filesystem/shell/browser tools.

---

## Deferred: Keycloak / SSO Support

Keycloak-based single sign-on and delegated token support remain valid future work, but they are explicitly deferred until the existing roadmap backlog is complete.

When this work resumes, it should cover two areas:

- OIDC login for the dashboard and gateway.
- Delegated token handling for protected MCP endpoints and downstream services.

That future phase should only be reopened after the current unfinished swarm, routing, scaling, and evaluation items above are closed or intentionally moved to a later operations roadmap.

---

## Delivery Sequence

| Phase | Focus | Status |
|---|---|---|
| **Phase 1** | Event-driven swarm bus + container heartbeats | ✅ Complete (bus infrastructure + heartbeats + first-pass bidding + long-running bidder worker + event-driven task graph) |
| **Phase 2** | Emergent architect + collective memory | ✅ Complete (architect + collective memory + concurrency) |
| **Phase 3** | Warden agent + adaptive routing + circuit breakers | ✅ Complete (Warden + routing rationale + circuit breaker + swarm morphing) |
| **Phase 4** | Agent catalog enrichment + evaluation CI + model tuning | ✅ Complete |
| **Phase 5** | Channel hardening + security parity | ✅ Complete (5.1 + 5.2) |
| **Phase 6** | Performance SLOs + latency budgets + regression gates | ✅ Complete (6.1 + 6.2 + 6.3) |
| **Phase 7** | Multimodal tools + human-in-the-loop approvals + intervention diagnostics | ✅ Complete (7.1 + 7.2 + 7.3) |
| **Phase 8** | Voice interaction UX — smart spoken summaries + speak-reply toggle | ✅ Complete (8.1) |
| **Phase 9** | Native computer access + VS Code-native work mode + managed remote workstation control | 🔄 In Progress (sub-phases 9A–9F) |
| **Future** | Single sign-on + federated Keycloak token access for agents and MCP endpoints | Deferred until current backlog is complete |

## Success Criteria

- The swarm picks the right specialist without trial-and-error on the first call in the majority of tasks.
- Agents can discover and bid on work autonomously via the event bus (no central routing bottleneck).
- Failed agents are replaced within seconds via heartbeat-based failover.
- Successful ephemeral agent types are automatically promoted to the permanent catalog.
- Channel adapters expose consistent health, auth, and delivery states across all providers.
- Each major agent has a documented model profile and measurable quality target.
- Performance regressions are visible and block releases before users notice them.
- Native computer-use workflows operate through explicit session leases, approvals, recordings, and recovery paths instead of uncontrolled host automation.
- The system handles any task domain — not just the ones with pre-built pipelines.

