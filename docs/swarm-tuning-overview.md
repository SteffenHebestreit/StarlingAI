# StarlingAI — Swarm Tuning & Capability Overview

*A single control-panel reference: every lever to **extend** what the swarm can do, **adjust** how it behaves, and the **self-learning** loops it runs on its own — with the exact config key / tool / page for each.*

*Companion: [`memory-context-overview.md`](./memory-context-overview.md) covers the data plane — memory stores, knowledge/RAG, and context assembly across session/workspace/user scopes.*

Current as of 2026-07-08. Config keys cite `packages/core/src/config/schema.ts` (and `schemas/*.ts`) which is the source of truth — line numbers drift, key names don't.

---

## The mental model

Everything below falls on **three planes**, plus the **mechanics** that let you change any of it:

| Plane | Question it answers | Examples |
|---|---|---|
| **Capabilities** | *What can the swarm DO?* | skills, scenes, jobs, agents, tools, knowledge bases, integrations |
| **Behavior** | *How does it ACT?* | personality, model preset, effort tier, orchestration flags |
| **Self-learning** | *What does it change about itself?* | skill distillation, memory consolidation, self-improvement, warden |

One clarification that removes most confusion (see [primitives taxonomy](#a-note-on-scenes-jobs-and-workflows)): **"Workflow" is not a distinct thing you author** — it's the verb (`run_workflow`) for running a saved **scene** (one turn) or **job** (a chain of scenes). There are really four capability primitives — Skill, Scene, Job, Agent — plus Tools and the things that feed them.

---

## 0. How to change anything (the mechanics)

**Config is generated from shards.** The live `starlingai.json` (~273 KB) is *compiled* from JSONC shards; never hand-edit the compiled file. Two zones:

- `config/**` — **infrastructure** (gateway, DB, RAG, security). Operator-owned.
- `workspace/**` — **swarm-mutable** capability catalog (`agents/`, `scenes/`, `jobs/` shards, split `00-platform` → `10-core` → `20-primary` → `30-secondary` → `50-authored-*`).

**The loop for any durable change:** edit a shard → `sai config build` → restart (or one-shot `sai start --build`). Swarm-authored changes (via `swarm_save_scene` / `swarm_define_agent` / `swarm_save_job`) write a `50-authored-*.jsonc` shard **and** apply live via a runtime overlay without a restart.

**Live edits from the UI:** the Settings, Memory, Skills, Knowledge, MCP, and Users pages write through the gateway to the store backend (config-sourced entries are locked; store-sourced ones are editable).

**Two safety disciplines to know:**
- **Flag-gating + eval.** Most *behavior* changes ship as a flag that is `false` by default until validated by a `pass^k` eval. Capability additions (a new scene/agent) are not eval-gated; behavior changes (a routing/honesty flag) are.
- **Tool security tiers.** Every tool has a tier: **0** read (always allowed) · **1** write (session consent) · **2** execute (per-call approval, sandboxed) · **3** privileged (admin approval + audit) · **4** blocked. Self-authored/plugin/MCP tools land at Tier 2 and **cannot self-escalate** (tier-shadow rejection). Secrets use `$ENV` or `secret:` (AES-256-GCM store) references, never plaintext.

---

## 1. Capabilities — extend what the swarm can DO

### The core primitives

| Primitive | What it is | Author it via | Runs when |
|---|---|---|---|
| **Skill** | A Markdown *procedure* (`SKILL.md`) retrieved and injected as planning guidance. No code, no privilege. | Swarm auto-distills; `record_skill` tool; **Skills page** (create/edit); or a hand-written file | Retrieved into the prompt (never "runs") |
| **Scene** | A parameterized task template = one scoped orchestrator turn, optional `allowedAgents`, `expectArtifact`, `triggers` | `scenes.<name>` shard, or `swarm_save_scene` tool | `run_workflow`, webhook, or as a job step |
| **Job** | An ordered chain of scene steps + triggers (api/cron/channel) | `jobs.<name>` shard, or `swarm_save_job` tool; **Jobs page** monitors | Its trigger, or `run_workflow` |
| **Agent** | A worker persona: model + system prompt + tool allowlist + routing tags | `subAgents.<name>` shard, or `swarm_define_agent`; **Agents page** | Delegated to by the orchestrator |

**Skills** — `skillLibrary.*`: `enabled`(true), `autoAuthor`(true), `minStepsToAuthor`(3), `maxInjected`(3), `retireBelowSuccessRate`(0.34), `retireMinUses`(5), `autoPromoteToScene`(true), `holdoutRate`(0). Stored at `.starlingai/skills/<slug>/`. Inert until skills exist; semantic retrieval needs an embedding provider (falls back to keyword).

**Scenes** — `SceneConfigSchema`: `task`(required), `params`, `allowedAgents`, `humanInLoopSteps`, `expectArtifact`, `triggers`, `approvalChannel`. A scene with `triggers` (regex `all` + optional `requiresActionVerb`) auto-trips the workflow guardrail; without them it's still discoverable via `search_workflows` but never force-routes. **No dedicated frontend page** — shards or `swarm_save_scene` only.

**Jobs** — `JobConfigSchema`: `steps[]` (each references a scene), `triggers[]` (`api` / `cron` `expression` / `channel` pattern), `params`. Cron fires from the gateway scheduler automatically.

**Agents** — `SubAgentConfigSchema`: `description`(required), `capabilities[]`/`tags[]` (routing), `model` override, `systemPrompt`, `tools[]` (omit = inherit all), `maxIterations`(5), `container`, `workspaceAccess`(`generated`|`full`). `defaultContainerized=true` (all agents Dockerized unless `container.disabled`) — needs reachable Docker or startup aborts. `workspaceAccess:'generated'` confines file tools to `generated/`+`uploads/`; `'full'` exposes config zones (reserved for self-maintenance agents).

- **Ephemeral agents** (`create_ephemeral_agent`) — single-use, defined inline, discarded after one run. **To extend what they can do, add the tool to `GRANTABLE_TOOLS`** in `tools/ephemeral-agent-factory.ts` (~50 tier-0/1 read/browser/computer/KB tools today). *Prefer this over hardcoding a permanent agent for one-off tasks.*
- **Promoted agents** — an ephemeral that proves reliable is auto-promoted into `subAgents` (thresholds `PROMOTION_MIN_SUCCESSES` / `PROMOTION_MIN_SUCCESS_RATE` in `promoted-agents.ts`). The emergent counterpart to the deliberate `swarm_define_agent`.

### Tools & extensions

| Extension | What it adds | Lever |
|---|---|---|
| **Built-in tools** | The core registered tool surface (tiered) | Disable families/tools: `tools.disabledGroups[]` (only 4 valid names: `pentest`, `infrastructure`, `kubernetes`, `observability`) and `tools.disabledTools[]`. New tools added in code via `registerTool()` + `TOOL_TIER_MAP` |
| **Dynamic / self-authored tools** | Swarm-built `selfdev__` tools (Tier 2, sandboxed) | `toolDevelopment.enabled`(false→true) for the sandbox; `selfImprovement.enabled` for the autonomous gap→tool loop |
| **Plugins** | Explicitly trusted third-party tool packages loaded at boot | `plugins.enabled`(**false**), `plugins.dir`(default `~/.starlingai/plugins`); **Plugins page** (view) |
| **MCP servers (inbound)** | Bridge an external MCP server's tools in (`mcp__<server>__<tool>`) | `mcp.servers.<name>` (stdio/docker/docker-exec/http/tcp); `mcp.autoReconnect`; **MCP page** or `mcp-add` tool |
| **MCP expose (outbound)** | Publish StarlingAI *as* an MCP server for Claude Desktop/Cursor/etc. | `mcp.expose.*`: `enabled`(false), `exposeTools/Agents/Scenes[]`, `allowTier2`(false), `http.requireAuth`(true) |
| **Webhooks** | Turn any HTTP endpoint (n8n/Zapier/internal API) into a Tier-1 tool `webhook__<key>` | `webhooks.<key>` = `{ url, method, headers }`; `$ENV` in header values |
| **Tool pipeline** | Batch several tool calls in one turn (fewer round-trips, no escalation) | `toolPipeline.*`: `enabled`(true), `maxSteps`(8); grant `run_tool_pipeline` per agent |
| **Knowledge Bases** | Crawl a docs site into a queryable corpus (`kb:<id>`) | `retrieval.knowledgeBases.*` safety rails; `create_knowledge_base` tool; **Knowledge page**. **HARD-depends on `retrieval.documentRag.enabled` (engram)** — no-ops when off |
| **Integration adapter families** | Light up whole tool families for external systems | `infrastructure.*`, `monitoring.*` (Prometheus/Grafana), `sourceForge.github.*`, `pentest.*`, `mail`, `dataFeeds.*`, `sites.<host>` (browser-login creds). All empty by default → tools inert until a profile is added |
| **Approval channels** | Deliver human approval requests when no dashboard is open | `approvalChannels.<name>` — types: `slack`, `outbound_webhook`, `sync_webhook` (needs `gateway.publicUrl` for one-click links) |

### Networked / interop capabilities (default-OFF)

| Capability | What it is | Lever |
|---|---|---|
| **Federation** | Cross-instance HMAC-signed delegation between StarlingAI nodes | `federation.*`: `enabled`(**false**), `instanceId`, `sharedSecret`, peers |
| **A2A protocol** | Public agent-to-agent interop endpoint + agent card | `a2a.*`: `enabled`(**false**), `inboundBearerToken`, `exposeAgents` |
| **Computer-use / desktop** | GUI automation via VNC/RDP/VSCode adapters | `computerUse.*`: `enabled`(**false**), `adapters` (`config/computer-use-schema.ts`) |
| **Multimodal generation** | Image/audio/file conversion families | `multimodal.*`: `maxUploadBytes`(20 MB), `files.*`, TTS/STT services |
| **Inbound channels** | Telegram/Slack/Discord/WhatsApp/webchat message ingress | `channels.*` (`schemas/channels.ts`) — `webchat` on (port 3001); others opt-in |

### A note on scenes, jobs, and workflows

There is **no `Workflow` type** — `run_workflow` is a uniform verb over `WorkflowType = "scene" | "job"`. A scene = one templated turn; a job = an ordered chain of scenes + triggers. A 1-step job is just a triggered scene. Keep the four primitives (Skill/Scene/Job/Agent); drop "workflow" from your mental vocabulary as anything other than "the run verb."

---

## 2. Behavior & Personality — adjust how it ACTS

### Identity & voice

| Lever | Default | How to adjust |
|---|---|---|
| **Personality profile** (identity/voice/collaboration/growth) | built-in default persona | **Memory page** (Personality tab, inline edit) or the personality store; the swarm can revise it too |
| **Model preset** (Local ⇄ Claude) | unset = pure local | `agents.activeModelPreset` + header switch in App.vue; `modelPresetScope`(`all`) controls breadth |
| **Per-agent provider/model mixing** | agents inherit `agents.defaults.model` | override `model` on `subAgents.<name>` (e.g. OpenRouter for `coder`) |
| **Effort tier** (low/med/high/max) | `effort.default`=`medium` | per-session dial (Chat composer) or `effort.default`; `effort.profiles` to override what a tier bundles (timeout/iters/depth/reasoning) |
| **Thinking toggle** (extended reasoning) | `enableThinking`=**false** | per-model-family `enableThinking`; `reasoningEffort`(low/med/high) for graded thinking; per-session toggle in composer |
| **Tool mode** | `orchestration_only` | `subAgents.main-assistant.toolMode` = `orchestration_only` / `hybrid` / `delegate_only` |
| **Custom instructions** | a substantial one is set in the workspace shard | `subAgents.main-assistant.customInstructions` (base-prompt behavioral override) |

### Orchestration behavior flags

These live in `config/schemas/orchestration.ts`. **Most are default-ON and shipped** (don't re-propose); the honesty/reuse family is default-OFF pending eval. Note two flipped ON in the deployment shard `config/gateway/40-orchestration.jsonc`: `planDrivenContinuation` and `autonomousModeAntiRefusal`.

| Family | Flags (default) | Purpose |
|---|---|---|
| **Planning** | `planFirst`(on), `planApproval`(off), `planDrivenContinuation`(schema off / **shard on**) | Record a plan; optionally pause for approval; finish *every* planned deliverable, not just step 1 |
| **QA / delivery** | `riskGatedQA`(on), `finalResponseQaGate`(on), `qaDeliveryLoop`(schema off / **shard on**), `autoResearchOnRefusal`(on), `autoBuildAfterResearch`(on), `autonomousModeAntiRefusal`(**shard on**) | Verify-and-repair high-stakes turns; build the artifact if missing; loop QA until the reviewer passes; never dead-end a `--auto` turn in a refusal |
| **Routing** | `trustModelRouting`(on), `softRoutingEnforcement`(off), `urlFetchEnforcement`, `relaySingleDeliverable`(on), `forceToolChoiceWhenOrchestrationRequired`(on), `midTurnSteering`(on) | Soft hints vs hard gates; force a real fetch/tool when required |
| **Honesty guards** | all **default-OFF** (eval-gated) | Don't dress up / fabricate / oversell; add unverified-source caveats |
| **Grounding** | `qaEvidenceAnchoring`(on), `qaEvidenceRequired`(off) | No PASS without evidence |
| **Oversight** | `oversight`(on, off at max effort), `maxEffortTurnOversight` | Runtime goal-satisfied / stall checks |
| **Reuse / anti-dup** | all default-OFF | Detect and reuse prior deliverables |
| **Caps / depth / parallelism** | `perTurnCaps`/`subAgentToolCaps`/`coordinatorToolCaps`={} | Throttle tool calls, delegation depth, fan-out |

> **Hard ceiling correction:** the absolute per-turn abort is `gateway.turnTimeoutMs` (**600000 = 10 min**), *not* an effort/orchestration key. Effort tiers set SLO *budgets* (`agents.performance.*SloMs`), not the kill-switch.

### Guardrails & fast-lane

| Lever | Default | Key |
|---|---|---|
| **Guardrails** (prompt-injection block, secret scan, moderation) | mostly on | `guardrails.*`: `promptInjectionBlock`(true), `outputSecretScan`(true), `moderation` |
| **Receptionist fast-lane** (cheap short-answer bypass) | off | `receptionist.*`: `enabled`(false), `maxResponseChars`(400), `alwaysEscalate` |
| **Model sampling / context / cache** | per model | `agents.defaults.model.*`: `contextWindow`(32768), `temperature`, tiers, `promptCache` |
| **Base-prompt assembly** | lean on | `leanContextInjection`(true), `taskConditionalPrompt`(false, reverted), split-orchestration, cache-warm |

---

## 3. Self-learning — what it changes about ITSELF

The swarm autonomously improves along these loops. **Most memory/skill loops are default-ON and safe; the tool-authoring loop is opt-in.**

| Loop | What it does autonomously | Trigger | Lever (default) |
|---|---|---|---|
| **Skill distillation** | Condenses a successful trajectory into a reusable `SKILL.md` draft | successful multi-step turn (≥120-char answer, ≥`minStepsToAuthor` delegations) | `skillLibrary.autoAuthor`(**on**) |
| **Skill lifecycle driver** | Retires low-lift skills, merges duplicates, **promotes proven skills → scenes** | every 30 min | `retireBelowSuccessRate`(0.34), `retireMinUses`(5), `autoPromoteToScene`(**on**) |
| **Skill lift / holdout** | Withholds a skill some % of the time to measure whether it *actually helps* | per-turn probability | `skillLibrary.holdoutRate`(**0 = off**; 0.15 to measure) |
| **Trajectory cache (G33)** | Injects a semantically-similar recent turn's evidence to avoid re-researching | new turn matches a cached query (≥0.82) | **no flag** — governed by embedding availability; disable only by disabling embeddings |
| **Graph-memory feedback (E26)** | Credits memories that helped (+importance), penalizes ones that didn't | turn outcome | **no flag** — active when a graph DB (`MEMGRAPH_URL`/`NEO4J_URL`) is configured |
| **Sleep-time consolidation** | Compacts near-duplicate durable memories, backfills embeddings | idle, every 30 min | `memory.sleepTimeConsolidation`(**on**), `consolidationIntervalMs` |
| **Session auto-consolidation** | Promotes a closing session's durable facts into long-term memory | session archive | `memory.autoConsolidateSessions`(**on**), `maxConsolidatedPerSession`(8) |
| **Temporal supersession** | Marks an older same-subject fact stale when a new one arrives | conflicting durable write | `memory.supersedeStaleFacts`(**on**) |
| **Self-improvement driver** | Detects capability gaps → LLM-designs → sandbox-builds → **human-approves** a new tool | failure threshold crossed | `selfImprovement.enabled`(**off**), `minFailuresBeforeProposal`(3), `promotionMinSuccessRate`(0.8) |
| **Ephemeral auto-generation** | Spins an ephemeral agent when a skill/capability match is strong | request-time match | `agents.ephemeralGeneration.enabled`(on), `skillMatchThreshold`(0.7) |
| **`request_new_capability`** | An agent flags a missing capability for the improvement loop | agent call | tool granted per-agent |
| **Warden** | Watches ~20 anomaly classes; aborts runaway turns, reinforces breakers, emergency-stops | 30 s sweep + audit stream | **always on** (no flag); SLO budgets via `agents.performance.*SloMs` |
| **Memory steward** | Computes a curation report + one-line nudge; never deletes silently | on demand | agent acts via `curate_memory(apply=true)` |
| **Dialectic user model** | Evolving theory of the user (goals, style, open questions) | `update_user_model` call | editable on the Memory page |
| **Cost governance** | Rolls up token cost, alerts on budget thresholds | audit events | `cost.enabled`(**off**), `cost.budgets.dailyUsd`/`monthlyUsd` |

---

## 4. Infrastructure & operations knobs

| Knob | Default | Key |
|---|---|---|
| **Rate limits / concurrency ceiling** | 60 req/min, 20 tool-calls/turn | `agents.rateLimit.*` |
| **Session pruning / soft budgets** | 60 s prune interval | `agents.sessionPruneIntervalMs`, `agents.defaults.budgets.maxToolCalls` |
| **Gateway server** | 10-min turn ceiling, 1-h session TTL | `gateway.*`: `turnTimeoutMs`(600000), `sessionTtlMs`, `publicUrl` |
| **Sub-agent resources** | 512 MB / 0.5 cpu | `subAgents.<name>.container.memoryMb`/`cpus`/`timeoutMs`, `compute` (GPU) |
| **RBAC / multi-user** | `auth.enabled`=false (back-compat) | **Users page** once enabled; per-credential `allowedUsers` |
| **OpenTelemetry tracing** | off | `tracing.*`: `enabled`(false), `otlpEndpoint` |
| **Web-search backend** | auto | `retrieval.search.backend` (`searxng`/`playwright`/`duckduckgo`) |
| **Reranker / Document-RAG** | reranker off; RAG inert without engram | `retrieval.reranker.*`, `retrieval.documentRag.*` |

---

## 5. Frontend control map — which page does what

| Page | Controls | Create/edit? |
|---|---|---|
| **Settings** (`/settings`, `/agents`) | Scenes, Jobs, Sub-Agents, Skill Library & Automation, Config Assistant | ✅ create/edit (config-sourced entries locked) |
| **Memory** (`/memory`) | Durable memory stores **+ Personality** | ✅ edit |
| **Skills** (`/skills`) | Skill Library | ✅ create/edit/archive/delete *(new)* |
| **Knowledge** (`/knowledge`) | Knowledge Bases | ✅ (inert without engram) |
| **MCP** (`/mcp`) | MCP servers | ✅ |
| **Users** (`/users`) | RBAC accounts/roles | ✅ (when `auth.enabled`) |
| **Agents catalog** (`/catalog`) | Agent catalog | 👁 view |
| **Jobs** (`/jobs`) | Job run monitor | 👁 view (define in Settings) |
| **Plugins** (`/plugins`) | Loaded plugins | 👁 view |
| **App header / Chat composer** | Model preset switch · Effort tier · Thinking toggle | ✅ per-session |
| **Sessions / Cost / Audit / Swarm / Documents / A2A / Federation** | Observability | 👁 view |

---

## 6. "I want to…" quick recipes

- **Add a reusable capability** → author a **scene** (deliverable template) in a `workspace/scenes/*.jsonc` shard, or a **sub-agent** if it's a new worker persona. For a one-off, extend `GRANTABLE_TOOLS` and let an **ephemeral agent** do it.
- **Make it learn procedures on its own** → already on (`skillLibrary.autoAuthor`); watch the Skills page fill up. Turn on `holdoutRate: 0.15` to measure which skills actually help.
- **Let it build its own tools** → `toolDevelopment.enabled: true` + `selfImprovement.enabled: true` (+ an `approvalChannel` — deploys stay human-gated).
- **Change its personality/voice** → Memory page → Personality tab.
- **Make it faster / cheaper** → lower the effort tier, set `perTurnCaps`, enable `cost.enabled` + a daily budget.
- **Connect an external system** → an **integration profile** (Proxmox/Grafana/GitHub), an **MCP server**, a **webhook** tool, or crawl its docs into a **Knowledge Base**.
- **Tune a behavior** (routing/QA/honesty) → flip the flag in `config/gateway/40-orchestration.jsonc`, `sai config build`, restart, and validate with a `pass^k` eval before making it a default.

---

*Sources of truth: `packages/core/src/config/schema.ts` + `config/schemas/*.ts` (config keys), `config/**` and `workspace/**` (shipped values), `packages/web/src/pages/*` (frontend surfaces). This overview was generated from a code-grounded audit; when a key here disagrees with the schema, the schema wins.*
