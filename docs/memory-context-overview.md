# StarlingAI — Memory, Knowledge & Context Overview

*Companion to [`swarm-tuning-overview.md`](./swarm-tuning-overview.md). Where that doc covers the swarm's **capabilities and behavior**, this one covers the **data plane**: where remembered information lives, how it enters the model's context each turn, the knowledge/RAG subsystems, and how it's all scoped across **session / workspace / user**.*

Current as of 2026-07-08. Config keys cite `packages/core/src/config/schema.ts` (+ `schemas/*.ts`), the source of truth.

---

## The mental model

Four layers, read across three scopes:

| Layer | Question | Examples |
|---|---|---|
| **Stores** | *Where does remembered info live?* | durable memory, session facts, user model, RAG corpora |
| **Context assembly** | *How does it enter the prompt?* | base prompt, `recall_context`, history compaction, evidence blocks |
| **Knowledge / RAG** | *How is external/attached content indexed & retrieved?* | engram documents, knowledge bases, pgvector, graph memory |
| **Autonomous management** | *What does the swarm do to its own memory?* | consolidation, supersession, steward, embedding backfill |

The spine of all of it is **scope**:

| Scope | Lifetime | Holds | Isolated by |
|---|---|---|---|
| **Session** | one conversation (Redis, 4h facts / 7d record) | shared-facts, partial-results, agent messages, checkpoints, history | **`sessionId`** (strong) |
| **Workspace** | durable, per-project | durable memory, skills, flow-memory, agent outcomes, trajectory cache, graph nodes | **workspace directory** (no user partition) |
| **User** | durable, cross-workspace | user preferences, dialectic user model, personality | **per authenticated user** under multi-user auth (`<base>/users/<id>/`); single shared path when auth is off — see [§6](#6-multi-user-isolation--the-honest-account) |

> **Multi-user note:** user-scope stores (memory, user-model, personality) are **partitioned per authenticated user**; session facts and RAG documents/KBs are too. **Workspace**-scope stores stay intentionally shared per project. See [§6](#6-multi-user-isolation--the-honest-account) for the full isolation account (and the remaining credential/graph gaps).

---

## 1. Memory stores — where remembered info lives

| Store | Scope | Storage | How it's managed | Lever |
|---|---|---|---|---|
| **Durable workspace memory** | workspace | one JSON file/key at `<ws>/.starlingai/memory/` (+ optional graph node) | `memory_store`; auto-consolidated from sessions; supersession + near-dup compaction + kind-decay | `memory.*`; `memory_store/search/promote/compact`; **Memory page** |
| **Durable user memory** | user | JSON files at `$SAI_USER_MEMORY_PATH` (docker `/data`) else `~/.starlingai/user-memory` | same pipeline; higher scope weight (0.34 vs 0.30) | `SAI_USER_MEMORY_PATH`; `memory_store scope:'user'` |
| **Session shared-facts** | session | Redis hash `starlingai:mem:{sessionId}:facts` (4h TTL); in-proc Map fallback | sub-agents `share_finding`/`share_evidence`; `read_shared_facts`; near-dup rejected (0.85); consolidated up on archive | code constants (`FACT_VALUE_MAX=2000`); `memory.autoConsolidateSessions` |
| **Partial-results + agent messages** | session | Redis lists `:results` / `:messages` (4h, ltrim 50) | completed-output snippets for reuse; `send_agent_message` → destructive drain on recipient's next turn | constants `RESULTS_MAX=50`, `RESULT_CONTENT_MAX=1200` |
| **Task checkpoints** | session | Redis 24h + fallback | written when a delegation pauses/times out (keyed by `taskId`) | module constant TTL |
| **Durable task-graph ledger** | session | per-session Redis slot | `run_task_graph` completed-node reuse | `orchestration.durableTaskGraph` (default **off**, eval-gated) |
| **Session record (history)** | session | Redis `sai:session:<id>` (**7d**, `SESSION_TTL_SECONDS`) + `sai:session-index` | the substrate the whole context-assembly layer replays | `REDIS_URL`; TTL is a constant, *not* the prune interval |
| **Agent memory** (outcomes + flow-memory lessons) | workspace | append logs under `.starlingai/` | `record_lesson` + per-delegation flow entries → surfaced as `scope:'agent'` records | injected when `leanContextInjection=false` |
| **Dialectic user model** | user | `user-model.json` in state dir | assistant calls `user_model_update`; caps `MAX_ITEMS=10`, 280 chars/item | `user_model_update` tool; **Memory page** |
| **Personality store** | user/global | `main-assistant-personality.json` | `assistant_personality_update` tool or UI; whole profile replaced | **Memory page → Personality**; `PUT /api/personality` |
| **Skills store** | workspace | `.starlingai/skills/<slug>/` | procedural memory — see the tuning doc | `skillLibrary.*`; **Skills page** |
| **Credential store** | workspace | encrypted (AES-256-GCM) | secrets referenced via `secret:` / `$ENV`; per-resource `allowedUsers` | guarded by `canAccessResource` (**fails open** — [§6](#6-multi-user-isolation--the-honest-account)) |

---

## 2. Context assembly — how it enters the prompt each turn

The **master switch is `agents.performance.leanContextInjection` (default `true`).** When ON, heavy always-on blocks are replaced by a compact 600-char durable-facts digest + a *retrieve-first* pointer, and the model pulls what it needs via the `recall_context` tool (JIT). When OFF, the always-on blocks return.

| Injection point | Scope read | When | Lever |
|---|---|---|---|
| **Base/system prompt** | session | always (root) | `systemPrompt` at session start; compacted under budget |
| **`recall_context` (JIT pack)** | session+workspace+user+agent | on demand (primary path when lean) | tool args `query/limit/include` |
| **Skills "Learned Procedures"** | workspace | retrieval match | `skillLibrary.enabled/maxInjected` |
| **Scoped long-term memory** | workspace+user | when `lean=false` | `maxChars` = 8% of budget; via `memory_store` |
| **Dialectic user-model / flow-memory** | user / workspace | when `lean=false` (else via recall) | user-model / flow-memory subsystems |
| **`[DOCUMENT CONTEXT]`** (attachment auto-ingest) | session | attachments present | `retrieval.documentRag.*` (see §3) |
| **`[SHARED FINDINGS AVAILABLE]`** | session | after delegation | always-on when facts exist |
| **`[CACHED RECENT EVIDENCE]`** (trajectory) | workspace | similar recent query (≥0.82) | trajectory-cache subsystem |
| **Shared-facts → sub-agent context** | session | every delegation | core behavior |
| **History compaction** (pin + rolling digest + active window) | session | over context pressure | `agents.defaults.model.contextWindow` (32768); 0.75 fill, minKeep 6 (constants) |
| **Prompt-budget trimmer** | cross-cutting | every turn | `agents.performance.promptBudgetChars` (32000) — also sizes memory/skill blocks |
| **Session pruning** | user | interval sweep | `agents.sessionPruneIntervalMs` (60000) = *how often the pruner runs* (record TTL is separate, §1) |

Several soft nudges also ride here, all eval-gated default-OFF: `splitOrchestrationPrompt`, `taskConditionalPrompt` (reverted), `orchestration.discoveryPrefetch`, `orchestration.userProfilePrefetch` (inert — `userOwnFacts` hardwired false post-de-lex), `orchestration.freshnessHonestyGuard`, `orchestration.reuseSessionEvidenceOnRefinement`.

---

## 3. Knowledge / RAG — indexing & retrieval

| Subsystem | What it indexes | Scope / isolation | Config + inert-when |
|---|---|---|---|
| **engram Document-RAG** | attached files → graph-RAG chunks | source tokens `user:<id>` / `session:<id>` / `workspace:<name>` / `kb:<id>` + gateway RBAC + always-on client post-filter | `retrieval.documentRag.*`: `enabled`, `engramBaseUrl`(`http://engram:8088`), `autoIngestAttachments`(true), `retrievalTopK`(6), `maxContextChars`(6000), `includeUser/WorkspaceDocs`(true). Inert if disabled / engram unreachable. Tools: `ingest_document`, `search_documents`, `list_documents`, `forget_document`. **Documents page** |
| **Knowledge Bases** | crawled docs sites → `kb:<id>` corpora | per-KB `KbScope` (session/workspace/user) + registry ACL | `retrieval.knowledgeBases.*` (crawl budgets). **HARD-depends on `documentRag.enabled`**. `create/search/manage_knowledge_base`. **Knowledge page** |
| **pgvector unified store** | RAG chunks (rag_* tools) | `metadata.sessionId` (session) or global; instance-global table | `DATABASE_URL` env (+ `SAI_PGVECTOR_POOL_MAX`); inert without it. `rag_*` tools (`scope`, `k`, `minScore`) |
| **MemGraph graph memory** | durable-memory nodes + `RETRIEVED` edges (E26) | scope/domain on nodes (workspace/user); **no `tenant_id`** | `MEMGRAPH_URL`/`NEO4J_URL`; inert → silent flat-file fallback. Tuning is code constants |
| **Knowledge-graph tools** (`graph_*`) | entities/relations | instance-global (optional `sessionId` node scope) | Tier 0/1 tools; `MEMGRAPH_URL`-gated |
| **Reranker sidecar** | reorders RAG candidates | global infra (serves routing + RAG) | `retrieval.reranker.*`: `enabled`, `mode`(tei), `model`(Qwen3-Reranker-0.6B). Needs the GPU sidecar |
| **Embeddings provider** | vectors for all semantic search | global | `agents.defaults.model.embeddingModel` (Qwen3-Embedding-0.6B, 1024d). Inert → everything falls back to keyword |

**Two eval-gated read-side flags** (schema OFF, deployment shard ON, awaiting the 0-leak `pass^k` eval): `retrieval.documentRag.confidenceDemotion` (low-confidence RAG → *demote* not suppress) and `retrieval.documentRag.serverSideScopeFilter` (push the `sources` scope filter into engram instead of relying on the client post-filter).

---

## 4. Autonomous memory management — what the swarm does to its own memory

| Loop | Scope | Trigger | What it changes | Lever (default) |
|---|---|---|---|---|
| **Session auto-consolidation** | session → workspace | session archive (turnCount≥1) | promotes durable-worthy session facts into workspace memory | `memory.autoConsolidateSessions`(**on**), `maxConsolidatedPerSession`(8) |
| **Sleep-time consolidation** | workspace+user | every 30 min (idle) | compacts near-dups, backfills embeddings | `memory.sleepTimeConsolidation`(**on**), `consolidationIntervalMs` |
| **Temporal supersession** | workspace+user | every durable write | marks older same-subject fact stale (kept for forensics) | `memory.supersedeStaleFacts`(**on**) |
| **Embedding backfill** | durable (+ transient at search) | sweep step 2 / on write | vectors records lacking embeddings | transitively via consolidation + an embedding provider |
| **E26 graph feedback** | cross-cutting (session edges) | retrieval + outcome | credits/penalizes memories by usefulness | active when MemGraph reachable (no flag) |
| **MAGE graph jobs** | shared graph | cron (centrality hourly, communities daily, decay 03:40) | PageRank / communities / similarity / decay | hard-coded cron in `graph-jobs.ts`; MemGraph-gated |
| **Trajectory write + self-invalidate** | workspace | turn finalize (had `share_finding`, >50-char answer) | caches evidence; bad outcomes invalidate | module constants (no flag) |
| **User-model updates** | user | assistant `user_model_update` | evolves the theory-of-user | granted tool; caps 10 items/280 chars |
| **Memory steward** | workspace+user | on demand | dry-run curation report + nudge; never deletes silently | `curate_memory(apply=true)`; **Memory page → Curate** |

---

## 5. Control surfaces — how a human manages it

| Surface | Manages | Create/edit? |
|---|---|---|
| **Memory page → Memory Store** | durable workspace/user records (scope dropdown) | ✅ edit/delete (`PATCH/DELETE /api/memory/entries/:key`) |
| **Memory page → Personality** | main-assistant persona | ✅ (`PUT /api/personality`) |
| **Memory page → Session Facts** | current session's shared-facts | 👁 view (`GET /api/sessions/:id/shared-facts`) |
| **Memory page → Knowledge Graph** | MemGraph nodes/edges | 👁 view |
| **Memory page → Curate** | steward report | ✅ apply (`POST /api/memory/curate`) |
| **Documents page** | personal/workspace document library (engram) | ✅ upload → auto-ingested as `[DOCUMENT CONTEXT]` |
| **Knowledge Bases page** | crawled corpora | ✅ create/crawl/search |
| **Agent tools** | `recall_context` (read all scopes), `memory_store/promote/compact` (write ws/user), `share_*` (session), `user_model_update` (user), `ingest_document`/`search_documents`, `curate_memory` | — |
| **CLI `sai memory export/import`** | durable memory → Obsidian vault (`workspace/vault/`) | ✅ backup/restore (`--vault`, `--no-sessions`) |

---

## 6. Multi-user isolation — the honest account

**What's genuinely isolated:**
- **Session** — the strong boundary. Everything is `sessionId`-namespaced; `deriveSharedSessionId` collapses `sub:`/`sub:sub:` agent ids to the **root** session so all agents in one turn share one bucket but never cross into another session; `_factKeysThisTurn` scopes delegation-reuse to the *current* turn (no stale prior-turn facts). No known cross-session leak.
- **User-scope durable stores** *(as of the per-user partitioning fix)* — under active multi-user auth, **durable user memory, the dialectic user-model, and the personality are keyed per authenticated user** at `<base>/users/<userId>/`. The whole turn (and every `/api/*` route) runs under `runWithRequestContext({userId})`, so prompt-assembly, memory, user-model, and personality all resolve to the caller; a delegated sub-agent inherits the same userId (never writes to the shared bucket). Personality is *global default + per-user override* (override → global → built-in). `userScopedDir` gates on `auth.enabled` **and** a present userId, so single-operator / auth-off installs keep their original single path unchanged.
- **RAG stores** — engram source tokens (`user:`/`session:`/`workspace:`/`kb:`) with gateway RBAC (`callerManageableSources`/`callerCanAccessKb`) + an always-on client post-filter; pgvector `metadata.sessionId`. A user cannot list/download/delete another user's or another session's documents.

**What's shared, not isolated (by design):**
- **Workspace** durable memory, skills, flow-memory, agent outcomes, trajectory cache, and graph nodes are a **single shared store per workspace directory** — every user of that workspace reads/writes the same records. This is intentional: a workspace is a shared project, not a personal space.
- The **global default personality** — until a user saves their own override, everyone sees the shared persona. Editing the shared default while auth is on is intentionally not exposed to Wave-A users (everyone is an operator); it belongs with Wave-B roles.

**Guards that fail open (know before relying on them):**
- `canAccessResource(allowedUsers)` on credential/mail/compute stores: empty/unset `allowedUsers` = shared to all, and `undefined userId` (token/anon/auth-off) = allowed. It only restricts a resource **explicitly bound** to users under active multi-user auth.
- MemGraph nodes carry `scope`/`domain` but **no `tenant_id`** — no DB-level per-user partition. `graph_*` tools default to a shared global graph.
- `tenant_id` scope-sets are **planned, not built** (a forward-looking comment in `document-rag.ts`); today's cross-scope enforcement is the client post-filter + the optional (default-OFF) `serverSideScopeFilter`.

**Fixed by the security waves:** ~90 adversarial-review bugs including cross-user memory leaks; the anonymous-write downgrade; document-RAG RBAC + post-filter + engram v0.9.0 server-side sources filter; the 2+-level sub-agent session-id propagation fix; the cross-turn facts guard; secret-value redaction so credentials never enter transcripts.

**Bottom line:** StarlingAI is *session-*, *RAG-document-*, and now *user-scope-durable-tenant-safe* — session facts, RAG documents/KBs, **and** durable user memory / user-model / personality are all partitioned per authenticated user. **Workspace**-scope stores remain intentionally shared per project. The remaining cross-user gaps are narrower: the credential/mail/compute `canAccessResource` guard still fails open, and MemGraph nodes still carry no `tenant_id` (memory-graph rerank/L0 is a shared graph). Those are the real items before exposing multi-user to *untrusted* accounts.

---

## 7. "I want to…" recipes

- **Make it remember a fact durably** → `memory_store` (pick `scope: workspace|user`) or add it on the **Memory page**.
- **Give it a document to reason over** → upload on the **Documents page**; it's auto-ingested and injected as `[DOCUMENT CONTEXT]` (needs engram).
- **Build a reusable knowledge corpus** → `create_knowledge_base` / **Knowledge page** (crawls a docs site into `kb:<id>`).
- **Control what enters the prompt** → `leanContextInjection` (lean digest + JIT recall vs always-on blocks) and `promptBudgetChars`; the model pulls detail via `recall_context`.
- **Change its personality** → **Memory page → Personality**.
- **Stop stale facts resurfacing** → already on (`memory.supersedeStaleFacts`); run **Curate** to compact duplicates.
- **Back up / move memory** → `sai memory export --vault <path>` (Obsidian vault), `sai memory import` to restore.
- **Isolate per user** → today, only RAG documents/KBs are per-user; durable memory/personality are shared (see §6). File a hardening task if you need per-account durable isolation.

---

*Sources of truth: `packages/core/src/config/schema.ts` + `schemas/retrieval.ts` (keys), `memory/service.ts` · `swarm/memory.ts` · `session-redis.ts` (stores), `agent/turn-system-prompt.ts` (assembly), `retrieval/*` (RAG), `gateway/memory-graph-routes.ts` (UI routes). Generated from a code-grounded audit; when a key here disagrees with the schema, the schema wins.*
