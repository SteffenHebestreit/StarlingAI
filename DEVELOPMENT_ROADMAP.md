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
| **Future** | Single sign-on + federated Keycloak token access for agents and MCP endpoints | Deferred until current backlog is complete |

## Success Criteria

- The swarm picks the right specialist without trial-and-error on the first call in the majority of tasks.
- Agents can discover and bid on work autonomously via the event bus (no central routing bottleneck).
- Failed agents are replaced within seconds via heartbeat-based failover.
- Successful ephemeral agent types are automatically promoted to the permanent catalog.
- Channel adapters expose consistent health, auth, and delivery states across all providers.
- Each major agent has a documented model profile and measurable quality target.
- Performance regressions are visible and block releases before users notice them.
- The system handles any task domain — not just the ones with pre-built pipelines.

