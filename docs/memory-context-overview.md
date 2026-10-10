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
| **Workspace** | durable, per-project | durable memory, skills, flow-memory, agent outcomes, trajectory cache, graph nodes | **workspace directory**; under multi-user auth a turn's workspace directory is its account's own (`<ws>/users/<account id>/`), and the deployment-wide ledgers (flow-memory, agent outcomes) record the account per entry |
| **User** | durable, cross-workspace | user preferences, dialectic user model, personality | **per account** under multi-user auth (`<base>/users/<account id>/`); single shared path when auth is off — see [§6](#6-multi-user-isolation--the-honest-account) |

> **Multi-user note:** user-scope stores (memory, user-model, personality) are **partitioned per account**, keyed by the account's immutable id, never its username; session facts, RAG documents/KBs and a turn's workspace directory are too. The deployment-wide agent ledgers are shared, with each entry's text shown only to its account. See [§6](#6-multi-user-isolation--the-honest-account) for the full isolation account (and the remaining credential/graph gaps).

---

## 1. Memory stores — where remembered info lives

| Store | Scope | Storage | How it's managed | Lever |
|---|---|---|---|---|
| **Durable workspace memory** | workspace | one JSON file/key at `<ws>/.starlingai/memory/` (+ optional graph node) | `memory_store`; auto-consolidated from sessions; supersession + near-dup compaction + kind-decay | `memory.*`; `memory_store/search/promote/compact`; **Memory page** |
| **Durable user memory** | user | JSON files at `$SAI_USER_MEMORY_PATH` (docker `/data`) else `~/.starlingai/user-memory` | same pipeline; higher scope weight (0.34 vs 0.30) | `SAI_USER_MEMORY_PATH`; `memory_store scope:'user'` |
| **Session shared-facts** | session | Redis hash `starlingai:mem:{sessionId}:facts` (4h TTL); in-proc Map fallback | sub-agents `share_finding`/`share_evidence`; `read_shared_facts`; near-dup rejected (0.85); consolidated up on archive | code constants (`FACT_VALUE_MAX=2000`); `memory.autoConsolidateSessions` |
| **Partial results** | session | Redis list `starlingai:mem:{sid}:results` (4h, ltrim 50) | completed-output snippets for reuse | constants `RESULTS_MAX=50`, `RESULT_CONTENT_MAX=1200` |
| **Agent messages** | session | per-recipient Redis **Streams** `starlingai:msgs:{sid}:{recipient}` (+ `:seen` set, `:recipients`, dead-letter stream) | `send_agent_message` → claim/ack with visibility-timeout redelivery and a retry ceiling, **not** a destructive drain (ADR-003). The old `:messages` list is legacy and is drained into streams on claim. | see `swarm/memory.ts`; equivalent in-process fallback when Redis is absent |
| **Task checkpoints** | session | Redis 24h + fallback | written when a delegation pauses/times out (keyed by `taskId`) | module constant TTL |
| **Durable task-graph ledger** | session | per-session Redis slot | `run_task_graph` completed-node reuse | `orchestration.durableTaskGraph` (default **off**, eval-gated) |
| **Session record (history)** | session | Redis `sai:session:<id>` (**7d**, `SESSION_TTL_SECONDS`) + `sai:session-index` | the substrate the whole context-assembly layer replays | `REDIS_URL`; TTL is a constant, *not* the prune interval |
| **Agent memory** (outcomes + flow-memory lessons) | deployment (one ledger for every account) | append logs under the shared root's `.starlingai/` (`agent_outcomes.ndjson`, `flow_memory.ndjson`); under multi-user auth each entry records the account it was written for (its user-scope segment) | each run's outcome, `record_lesson` (filed under the calling run's own task) + config-assistant flow entries → surfaced as `scope:'agent'` records; under multi-user auth a reader sees only the caller's own entries ([§6](#6-multi-user-isolation--the-honest-account)) | a sub-agent's own lessons in its run guidance; `memory_search` / `recall_context` / `memory_promote` on demand |
| **Dialectic user model** | user | `user-model.json` in state dir | assistant calls `user_model_update`; caps `MAX_ITEMS=10`, 280 chars/item | `user_model_update` tool; **Memory page** |
| **Personality store** | user/global | `main-assistant-personality.json` | `assistant_personality_update` tool or UI; whole profile replaced | **Memory page → Personality**; `PUT /api/personality` |
| **Skills store** | workspace | `.starlingai/skills/<slug>/` | procedural memory — see the tuning doc | `skillLibrary.*`; **Skills page** |
| **Credential store** | workspace | encrypted (AES-256-GCM) | secrets referenced via `secret:` / `$ENV`; per-resource `allowedUsers` | guarded by `canAccessResource` (unbound = **shared to all** — [§6](#6-multi-user-isolation--the-honest-account)) |

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
| **engram Document-RAG** | attached files → graph-RAG chunks | source tokens `user:<id>` / `session:<id>` / `workspace:<name>` / `kb:<id>` + gateway RBAC + always-on client post-filter | `retrieval.documentRag.*`: `enabled`, `engramBaseUrl`(`http://engram:8088`), `autoIngestAttachments`(true), `retrievalTopK`(6), `maxContextChars`(6000), `includeUser/WorkspaceDocs` (schema **false**, deployment shard **true** — `config/tooling/10-platform.jsonc`). Inert if disabled / engram unreachable. Tools: `ingest_document`, `search_documents`, `list_documents`, `forget_document`. **Documents page** |
| **Knowledge Bases** | crawled docs sites → `kb:<id>` corpora | per-KB `KbScope` (session/workspace/user) + registry ACL | `retrieval.knowledgeBases.*` (crawl budgets). **HARD-depends on `documentRag.enabled`**. `create/search/manage_knowledge_base`. **Knowledge page** |
| **pgvector unified store** | RAG chunks (rag_* tools) | `metadata.sessionId` (session) or global; instance-global table | `DATABASE_URL` env (+ `SAI_PGVECTOR_POOL_MAX`); inert without it. `rag_*` tools (`scope`, `k`, `minScore`) |
| **MemGraph graph memory** | durable-memory nodes + `RETRIEVED` edges (E26) | one shared graph; under multi-user auth each memory node carries a `tenant` (its user, or the workspace root that stores it), and the readers (Critical Memory, the graph inspector, `graph_query`) show only the caller's own and the shared root's memory | `MEMGRAPH_URL`/`NEO4J_URL`; inert → silent flat-file fallback. Tuning is code constants |
| **Knowledge-graph tools** (`graph_*`) | entities/relations | instance-global (optional `sessionId` node scope); under multi-user auth `graph_query` returns another account's memory node as id/kind/scope only and refuses a query that reads memory text other than as a whole node, and the write tools do not write `MemoryRecord` | Tier 0/1 tools; `MEMGRAPH_URL`-gated |
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
| **Memory page → Knowledge Graph** | MemGraph nodes/edges | 👁 view (operator role under multi-user auth; own + shared memory only) |
| **Memory page → Curate** | steward report | ✅ apply (`POST /api/memory/curate`) |
| **Documents page** | personal/workspace document library (engram) | ✅ upload → auto-ingested as `[DOCUMENT CONTEXT]` |
| **Knowledge Bases page** | crawled corpora | ✅ create/crawl/search |
| **Agent tools** | `recall_context` (read all scopes), `memory_store/promote/compact` (write ws/user), `share_*` (session), `user_model_update` (user), `ingest_document`/`search_documents`, `curate_memory` | — |
| **CLI `sai memory export/import`** | durable memory → Obsidian vault (`workspace/vault/`) | ✅ backup/restore (`--vault`, `--no-sessions`) |

---

## 6. Multi-user isolation — the honest account

**What's genuinely isolated:**
- **Session** — the strong boundary. Everything is `sessionId`-namespaced; `deriveSharedSessionId` collapses `sub:`/`sub:sub:` agent ids to the **root** session so all agents in one turn share one bucket but never cross into another session; `_factKeysThisTurn` scopes delegation-reuse to the *current* turn (no stale prior-turn facts). No known cross-session leak.
- **Accounts, by immutable id** — under active multi-user auth every per-user store is keyed by the caller's **account id** (`<prefix>-<16 hex>`, minted at random when the account is created or, for an identity-provider subject, at its first sign-in; never derived from the username). An account deleted and created again under the same name, or an identity-provider subject that claims a released name, gets a new id and an empty bucket: nothing the old account left is reachable through the name. Everything that is not an account (a bootstrap token, a channel sender, an A2A peer, a scene/job/workflow run) is a principal, keyed by the segment its raw name always had, and never an account. Records carry their owner whole (`account` or `principal` with the name) and belong to the caller with the same identity (`ownsRecord`). See [security.md → Per-User Data Isolation](security.md#per-user-data-isolation).
- **User-scope durable stores** — **durable user memory, the dialectic user-model, and the personality are keyed per account** at `<base>/users/<account id>/`. The whole turn (and every `/api/*` route) runs under `runWithRequestContext({identity})`, so prompt-assembly, memory, user-model, and personality all resolve to the caller; a delegated sub-agent inherits the same identity (never writes to the shared bucket), and a tool call acts as one identity, never a name from one caller paired with another's account. Personality is *global default + per-user override* (override → global → built-in). `userScopedDir` gates on `auth.enabled` **and** a present caller, so single-operator / auth-off installs keep their original single path unchanged.
- **A turn's workspace directory** — under multi-user auth a turn works in its account's own root, `<ws>/users/<account id>/`: workspace-scope durable memory, skills and generated files written in a turn are the account's, and the turn's sandbox mounts that directory.
- **RAG stores** — engram source tokens (`user:`/`session:`/`workspace:`/`kb:`) with gateway RBAC (`callerManageableSources`/`callerCanAccessKb`) + an always-on client post-filter; pgvector `metadata.sessionId`. Under multi-user auth the user corpus is `user:<account id>` (it is `user:<userId>` with auth off, as always), plus the corpora from before account ids that the account adopted in the migration (aliases in `<ws>/.starlingai/document-aliases.json`, read by that account only). A user cannot list/download/delete another user's or another session's documents.

**Data from before account ids** sits under the segment of the username and is reachable by no account until an admin runs the account migration ([QUICKSTART](../QUICKSTART.md#upgrading-to-account-ids)): no read falls back to the old segment, because a fallback computed from the username is exactly what let a new account under an old name inherit. Until then a builtin account without an id cannot sign in, an identity-provider account with data under its name waits pending, chats from before ids are admin-only and read-only, and schedules from before ids do not fire.

**What's shared, not isolated (by design):**
- With auth off, or for what lives at the **shared workspace root** (the config zones, and what runs with no caller write), workspace durable memory, skills, trajectory cache, and graph nodes are a **single shared store per workspace directory** — every user of that directory reads/writes the same records.
- The **agent outcome ledger and flow memory** are one file each for the whole deployment, but their *text* is per account. Each entry records the account it was written for (its account id, or a principal's segment; never the raw user id): a run's outcomes and the lessons it records via `record_lesson` carry the account the run was delegated for, and a config-assistant entry the account that asked. Under multi-user auth every reader that shows an entry's task or lesson keeps to the caller's own entries — `memory_search`, `recall_context`, `memory_promote`, a sub-agent's lesson guidance, the user-profile prefetch, and the latest lesson in `GET /api/agents/outcomes`. An entry of another account, or one written before entries carried an account, is left out, and a request with no user sees none (`memory_search` then says the agent scope was not searched). The counts and rates (routing weights, circuit breaker, adaptive timeouts, the per-turn agent performance note, the counts in `GET /api/agents/outcomes`) stay deployment-wide. A config-assistant proposal or flow entry goes whole only to its author and to an admin: the request and everything written from it, which is the summary (an unparsed model reply included), the reasons and values of its config changes, the prompts and their rationale, the checks, the tags, the lesson and the feedback notes. Every other account gets its structure (ids, status, timestamps, config paths, prompt targets, outcomes), so authors and admins review in Settings as before. The learned flow guidance an agent or the config assistant is given keeps to the caller's own entries, chosen before anything is ranked.
- The **global default personality** — until a user saves their own override, everyone sees the shared persona. Editing the shared default while auth is on is intentionally not exposed to Wave-A users (everyone is an operator); it belongs with Wave-B roles.

**Guards that fail open (know before relying on them):**
- `canAccessResource(allowedUsers)` on credential/compute stores: empty/unset `allowedUsers` = **shared to all** (unbound is shared by design). For a resource *explicitly bound* via `allowedUsers`, a caller with no identity **fails closed when `auth.enabled` is true** and is allowed only when auth is off (`guardrails/resource-access.ts`). Under multi-user auth an entry matches by the caller's kind: `account:<id>` one account, a bare name an account by its (frozen) username or a bootstrap token by its `sub`, `principal:<raw>` a channel sender, peer or run; a principal never matches a bare name ([security.md](security.md#per-user-resource-access-rbac)). The mail-service enforces the same forms for mail/calendar/contacts accounts, but it cannot see `auth.enabled`: it **admits a request without the caller's headers** to a bound account unless it runs with `SAI_MAIL_REQUIRE_IDENTIFIED_USER=true`.
- MemGraph is **one graph partitioned at read time**: memory nodes carry a `tenant` under multi-user auth (the account id of a user-scope node, the root's id or `shared` for a workspace-scope node) and every reader that returns memory text filters on it, but nothing in the database separates accounts. `SIMILAR_TO` edges and the MAGE jobs still span accounts (a similarity edge can link two accounts' memories), FACT nodes from `graphPromoteFact` carry no tenant (so under auth no account sees their text), and the entity graph of the `graph_*` tools is instance-global. Under multi-user auth the graph holds no session id: Session nodes and `RETRIEVED` edges carry a digest of it keyed by the writing process (`graphSessionId`), so `graph_query` and the graph inspector give no account another's session ids. A session's records written before and after a restart hang off two Session nodes, and ids written before this change stay in the graph until it is wiped.
- `tenant_id` scope-sets are **planned, not built** (a forward-looking comment in `document-rag.ts`); today's cross-scope enforcement is the client post-filter + the optional (default-OFF) `serverSideScopeFilter`.

**Fixed by the security waves:** ~90 adversarial-review bugs including cross-user memory leaks; the anonymous-write downgrade; document-RAG RBAC + post-filter + engram v0.9.0 server-side sources filter; the 2+-level sub-agent session-id propagation fix; the cross-turn facts guard; secret-value redaction so credentials never enter transcripts.

**Bottom line:** StarlingAI is *session-*, *RAG-document-*, and *user-scope-durable-tenant-safe* — session facts, RAG documents/KBs, a turn's workspace directory, **and** durable user memory / user-model / personality are all partitioned per account, by an id that never passes to the next person given the same name. The deployment's agent ledger is shared, with each entry's text shown only to the account it was recorded for. The remaining cross-user gaps are narrower: unbound credential/mail/compute resources are shared by design and the mail-service admits a caller without headers unless told not to, and the memory graph is partitioned only at read time (similarity edges and graph jobs still span accounts). Those are the real items before exposing multi-user to *untrusted* accounts.

---

## 7. "I want to…" recipes

- **Make it remember a fact durably** → `memory_store` (pick `scope: workspace|user`) or add it on the **Memory page**.
- **Give it a document to reason over** → upload on the **Documents page**; it's auto-ingested and injected as `[DOCUMENT CONTEXT]` (needs engram).
- **Build a reusable knowledge corpus** → `create_knowledge_base` / **Knowledge page** (crawls a docs site into `kb:<id>`).
- **Control what enters the prompt** → `leanContextInjection` (lean digest + JIT recall vs always-on blocks) and `promptBudgetChars`; the model pulls detail via `recall_context`.
- **Change its personality** → **Memory page → Personality**.
- **Stop stale facts resurfacing** → already on (`memory.supersedeStaleFacts`); run **Curate** to compact duplicates.
- **Back up / move memory** → `sai memory export --vault <path>` (Obsidian vault), `sai memory import` to restore.
- **Isolate per user** → **already done.** Under active multi-user auth (`auth.enabled`), durable user memory, the dialectic user-model, and the personality override are each partitioned per account under `<base>/users/<account id>/` via `userScopedDir` and `segmentFor` (`runtime/user-scope.ts`) — see `memory/service.ts`, `user-model/service.ts`, `personality/service.ts`. RAG documents/KBs are scoped by engram `user:<account id>` source tokens. With auth disabled, every path collapses to the single shared location, preserving single-operator back-compat. Upgrading a deployment whose data predates account ids → the account migration ([QUICKSTART](../QUICKSTART.md#upgrading-to-account-ids)).

---

*Sources of truth: `packages/core/src/config/schema.ts` + `schemas/retrieval.ts` (keys), `memory/service.ts` · `swarm/memory.ts` · `session-redis.ts` (stores), `agent/turn-system-prompt.ts` (assembly), `retrieval/*` (RAG), `gateway/memory-graph-routes.ts` (UI routes). Generated from a code-grounded audit; when a key here disagrees with the schema, the schema wins.*
