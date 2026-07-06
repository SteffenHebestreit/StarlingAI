# Engram Re-Evaluation (July 2026): from doc-RAG to agent-memory?

> **Update 2026-07-06 (post-analysis):** the maintainer released **v0.7.0** (3-layer
> restructure, `ENGRAM_MODE`, PPR removed, `HYDE_ENABLED` default → false), **v0.7.1**
> (CI-green patch) and **v0.8.0** ("name-complete": package `app` → `engram`, per-layer
> pip extras) — answering open question §8.1. StarlingAI's pin was bumped
> `d81a488` → **`v0.8.0`** (Dockerfile entrypoint updated to `engram.interfaces.main:app`;
> an explicitly-set `STORE_BACKEND` still wins over `ENGRAM_MODE`, so our compose env is
> unchanged; the HTTP contract of the five endpoints we call verified unchanged through the
> v0.8.0 CHANGELOG + config module). The Phase 0b endpoint smoke test runs at the next
> `rag`-profile build. Phases 1–3 (CRAG demotion / scope-sets / invalidation) remain
> flag-gated pending eval, per §5.

## TL;DR

- **What engram is now:** the same document-RAG engine StarlingAI already runs, re-labeled by its v0.6.0 CHANGELOG as "the agent-memory pivot" — but that is a *repositioning plus additive write-path capabilities on an intact RAG read path*, **not** a fork, rewrite, or a new kind of memory. `main` is the only branch; the README still leads with "A retrieval engine for agents."
- **What its "agent memory" actually is:** document-centric — supersede/invalidate whole documents, learn query→chunk associations. It provides **no** episodic / semantic / procedural / working memory (none is mentioned anywhere in engram's docs) and has **no** agent-self-editing memory blocks. Its temporal validity is only deterministic document-level supersession ("bi-temporal stage 1"); full edge validity is engram's own self-admitted GAP.
- **What we use it for today:** doc-RAG only — 5 of ~14 HTTP endpoints, none of the MCP tools, with scoping reimplemented client-side because engram `/search` is global per instance.
- **The honest-negative eval:** engram's own scorecard says its architecture delta is ~+1.4 nDCG over naive dense+rerank but **not statistically significant**, and a tie vs a strong hybrid+rerank baseline. The case for leaning in is **operational** (native multi-scope reads, non-destructive supersession, retrieval-confidence signals, embedded speed), **not** better search.
- **StarlingAI already owns richer memory:** kind/subject-typed, RBAC-scoped, supersession-aware durable flat-file memory + MemGraph + swarm facts + user-model. engram's chunk store has no auth model.
- **Recommendation (decisive):** keep engram a thin, optional, gracefully-degrading doc-RAG surface. Adopt **only** the cheap read-path wins that improve honesty and/or delete StarlingAI code — CRAG retrieval-confidence gating, native `tenant_id` scope-sets, non-destructive document invalidation — all **flag-gated default-off pending the user's pass^k eval**.
- **Reject** unifying memory onto engram and its graph / community / MCP-memory surfaces: they duplicate working StarlingAI subsystems, return **501/empty** on the `engramdb` backend, and would drag a Neo4j+GDS server back into the stack against the lean-base + de-homelab direction.
- **Corrected since the first draft:** the pin is **17 commits behind main HEAD** (13 behind the `v0.6.0` tag), and the `v0.6.0` tag is **not** main HEAD — three relied-upon capabilities live *past the tag* in `[Unreleased]`. The pin bump is an **eval-gated behavioral change**, not a "free/zero-behavior" unlock.

---

## 1. What StarlingAI uses engram for today

StarlingAI uses engram for **document-RAG only**. The client `packages/core/src/retrieval/engram.ts` calls exactly **5** of engram's ~14 HTTP endpoints:

| Endpoint | Use |
|---|---|
| `GET /health` | liveness |
| `POST /documents` | ingest `{text, source, title?, document_id?}` |
| `POST /search` | `{query, tuning.final_top_k}` → snake_case chunk results |
| `GET /documents` | list with `source` refs |
| `DELETE /documents/{id}?source=` | scoped ref-drop or hard delete |

It uses **none** of the MCP tools.

Because engram `/search` is **global per instance**, StarlingAI reimplements scoping in `retrieval/document-rag.ts` (`retrieveDocumentContextWithStatus`, ~:216–244): list all docs → keep those whose `source` tokens (`session:<id>` / `user:<id>` / `workspace:<name>`) intersect the active scope → search with a generous `candidateTopK(30)` → post-filter to in-scope docs above `minRerankScore` → trim to `retrievalTopK(6)`. A separate `listInScopeDocuments` path answers **existence** questions ("do you have my CV?") that content-relevance retrieval misses.

The `/search` result fields are mapped **by snake_case key** (not positionally): `r['chunk_id']`, `r['document_id']`, `r['text']`, `r['summary']`, `r['keywords']`, `r['origin']`, `r['graph_distance']`, `r['graph_proximity']`, `r['retrieval_score']`, `r['median_score']`, `r['fused_score']`, `r['rerank_score']`, each with `?? 0` / `?? ''` fallbacks.

**Deployment:** an **optional** docker service behind the off-by-default `rag` compose profile, `STORE_BACKEND=engramdb` (in-process, no Neo4j server), `ENGRAMDB_QUANTIZATION=f16`, Qwen 1024-d embeddings via the same model server as the gateway, reranked by the one shared Qwen3-Reranker GPU sidecar.

**Graceful degradation is load-bearing and real:** the gateway has **no** `depends_on` engram; every client path returns `null`/`[]` and never throws; `searchTimeoutMs` was tightened to `8000` precisely so a hung engram can't stall every turn. Config lives in `config/tooling/10-platform.jsonc` (`documentRag.enabled=true`, `reranker.enabled=true`) and must stay in `config/**` shards because `starlingai.json` is regenerated on every build.

---

## 2. What the newest engram actually is

**Reconciled honestly.** The v0.6.0 CHANGELOG is literally titled *"The agent-memory pivot: engram is now an agent-memory engine (RAG is its read path)"* — verified verbatim. But this is a **repositioning + additive write-path on an intact RAG core**, not a fork or rewrite. The RAG substrate (chunking, HyDE, multi-channel fusion, graph-expansion, cross-encoder rerank) is intact, and `POST /documents` + `POST /search` keep their request shape.

So "changed from RAG to agent-memory" is best stated as: **new write-path capabilities on a RAG core, where the "agent memory" is document-centric** (supersede/invalidate documents, learn query→chunk associations). It is **not** cognitive memory:

- engram provides **no episodic / semantic / procedural / working memory** — none is mentioned in any engram doc.
- There are **no agent-self-editing memory blocks** anywhere in the repo.
- Its "temporal validity" is only **deterministic document-level supersession** ("bi-temporal stage 1": a single `invalidated` marker + `include_invalidated` audit reads). Full `valid_from`/`valid_to`/`invalid_at` edge validity remains engram's **own self-admitted GAP** (vs Zep).
- The scorecard frames engram as *"a retrieval + memory engine … not an answer generator and not an orchestration framework"*; its memory features are recency (`RECENCY_ENABLED=false` default) + document supersession/invalidation + a feedback/`mark_used` boost (`MEMORY_BOOST_ENABLED=false` default).

> **Correction from the adversarial pass:** an earlier draft attributed "the scorecard marks episodic/semantic/procedural/working memory *absent*" to engram's own scorecard. That is a **fabricated citation** — those terms and the word "absent" appear nowhere in engram's docs. The conclusion (engram has no cognitively-typed memory) is correct and independently supported, but it is grounded in *what the docs do say* (above), not in a scorecard enumeration that does not exist.

### Branch / release / version reality

- **Branch:** `main` is the only branch.
- **Versioning is inconsistent — tags are the truth.** GitHub Releases stop at `v0.1.2` (Jun 14, hence the README badge) and `app/main.py:55` hardcodes `version="0.5.0"`, but git **tags** run `v0.1.0 .. v0.6.0`.
- **The `v0.6.0` tag is NOT main HEAD.** The tag points to commit `e5e3a83b`, which is commit **#13 of a 17-commit delta**. Main is **4 commits ahead of the tag**.
- **StarlingAI's pin `d81a488` is a clean ancestor of `main`:** `ahead_by 0`, **`behind_by 17`** to main HEAD (13 behind the `v0.6.0` tag). It sits exactly **1 commit past the `v0.5.0` tag** (that 1 commit is the yake no-LLM-ingest default) — post-v0.5.0, pre the whole v0.6.0 pivot.

> **Correction:** an earlier draft said "behind_by 16 / 16-commit delta." The verified live compare is **17 commits behind main HEAD**, 13 behind the `v0.6.0` tag. Neither figure is 16.

### What the delta adds — and where each capability actually lives

**In the `v0.6.0` tag (`e5e3a83b`) — you get these by pinning the tag:**
- `tenant_id` as `str | list[str]` **scope-sets** (`ff7af2d1`) — obsoletes the client-side post-filter *(verified: `models.py` is `str | list[str] | None` on main/tag vs `str | None` at the pin)*.
- `top_rerank_score` + `score_gap` **CRAG-confidence** fields on `SearchResponse` (`ec1e27be`) — optional, `float | None`, computed via `retrieval_confidence()` *(verified absent at pin)*.
- `POST /documents/{id}/invalidate` bi-temporal supersession (`5eea6c17`) — docstring literally calls it "the agent-memory supersession write"; MCP tool count goes 5→6 (`invalidate_document` added).
- Near-dup **contradiction guard** (`e51b5be3`) — `scoring.numeric_conflict` in `_collapse_near_dups` won't collapse near-dups whose numbers disagree.

**POST-tag, on `main` only, in the `[Unreleased]` CHANGELOG section — the `v0.6.0` tag does NOT deliver these:**
- `INVALIDATION_OVERFETCH` recall guard (`b9c683fc`).
- MCP `search` returns the **full response envelope** `{results, top_rerank_score, score_gap}` (`43f7c48e`).
- `GET /chunks/{id}/context` honors the **default-valid contract** (`8ac3087c`, main HEAD, 2026-07-05).

> **Important migration consequence:** to get `INVALIDATION_OVERFETCH`, the MCP envelope, and the `/chunks/{id}/context` gating you must pin **main HEAD (`8ac3087c`)** or wait for a `v0.6.1` tag. Pinning the `v0.6.0` tag omits all three.

**Already present AT the pin but UNUSED by StarlingAI:** single-string `tenant_id`, `GET /chunks/{id}/context` (line 246), `POST /feedback` + `mark_used` memory-boost (v0.5.0, off by default), yake zero-LLM ingest default, engramdb `b1` quant.

**Critically INACTIVE on the `engramdb` backend regardless of pin:** `/graph/entities`, `/graph/relations` (raise **501** — `store_engramdb` raises "structured-entity ingest is neo4j-only"), `/communities/*` and MCP `search_themes` (return **empty**). These are **Neo4j+GDS-only** *(verified)*.

**Compatibility:** no breaking change to the 5 requests StarlingAI sends; `/search` only *gained* optional fields; `tenant_id`-as-list is opt-in; `final_top_k` is still a live tunable (`search.py`: `final_top_k = top_k or settings.final_top_k`). The client keeps working — the work is **adopting**, not repairing.

---

## 3. Capability decision space

| Capability | Could use for | Overlaps (existing StarlingAI subsystem) | Rec | Effort | Risk |
|---|---|---|---|---|---|
| **Pin bump `d81a488` → main HEAD / tag** (enabling meta-move) | Unlock scope-sets, invalidation, CRAG-confidence, contradiction guard | `docker/engram/Dockerfile` `ARG ENGRAM_REF` + compose build-arg + `.env.example` | **adopt (eval-gated)** | S | Med |
| **CRAG retrieval-confidence** (`top_rerank_score` + `score_gap`) | Down-weight weak/low-margin matches instead of presenting them as authoritative | `document-rag.ts` `minRerankScore` (:233) + forced-synthesis honesty stamps | **adopt** | S | Low-Med |
| **`tenant_id` scope-sets** (`str|list`) | Native multi-scope reads; retire client post-filter loop | `document-rag.ts` scope post-filter (:229–243) | **adopt** | M→L | Med-High |
| **Document invalidation** (`POST /documents/{id}/invalidate`) | Non-destructive soft-delete/supersede with audit trail | `memory/service.ts` `supersedeOlderSubjectFacts`; iter26 memory-page soft-delete UI; **existing** `engramDeleteDocument` ref-count soft-delete | **pilot** | M | Med |
| **Near-dup contradiction guard** | Stop dedup from dropping a chunk that contradicts a near-identical one | complements partial-sample/consistency honesty guards | **adopt (rides the pin)** | S | Low |
| **`GET /chunks/{id}/context`** (main HEAD only for default-valid gating) | Expand a short high-scoring chunk with neighbors → cut dropped-section hallucination | `buildInlineDocumentContext` + `inlineSmallDocuments` | **pilot** | S | Low |
| **Feedback write-path** (`POST /feedback` + `mark_used`, `MEMORY_BOOST_ENABLED`) | Cross-session learning / recurring-query personalization | `memory/graph-service.ts` `RETRIEVED wasUseful` feedback | **defer** | M | Med |
| **MCP memory server** (6 tools) | Expose engram as agent-facing memory tools over MCP | `tools/memory.ts` scoped `memory_store/search/promote`, `share_finding` w/ tier+RBAC | **reject** | M | High |
| **`/graph/entities` + `/graph/relations`** | Entity/relation graph over documents | `tools/graph.ts` + `memory/graph-service.ts` MemGraph | **reject** | L | High |
| **`/communities/*` + `search_themes`** | GraphRAG-style community/theme synthesis | `memory/graph-service.ts` MAGE Louvain pass (dormant) | **reject** | L | High |
| **engramdb `b1` quantization** (f16→b1) | Cut vector-memory footprint on constrained hosts | none (ops knob) | **defer** | S | Low-Med |
| **yake zero-LLM ingest** | LLM-free, cheaper/faster ingest metadata | none | **available (opt-in, currently OFF)** | S | Low |
| **HyDE / fusion / graph-expansion read path** | Core doc-RAG quality | already consumed (`engram.ts` maps `median_score`/`fused_score`/`graph_proximity`/`rerank_score`) | **keep (status quo)** | S | Low |

### Per adopt/pilot row

**Pin bump (adopt, eval-gated).** `behind_by 17` clean-ancestor bump with **no** breaking change to the 5 requests the client sends; `/search` only gains optional fields. It gates everything else. **This is not a zero-behavior-change move:** it wholesale-adopts server-side read-path changes (the near-dup contradiction guard alters dedup output/ranking) that are default-on and **not** flag-gateable from StarlingAI's side. Treat it as an eval-gated behavioral change — canary a candidate `ENGRAM_REF`, run the retrieval smoke, keep the old pin as instant rollback. **Pin main HEAD (`8ac3087c`), not the `v0.6.0` tag**, if you want `INVALIDATION_OVERFETCH` + the MCP envelope + `/chunks/context` gating.

**CRAG retrieval-confidence (adopt).** Cheapest honesty lever. Response-only optional fields → the absent-field path is exactly today's behavior, so it degrades gracefully pre-bump and when engram is down. **Critical implementation constraint:** do **not** suppress the `[DOCUMENT CONTEXT]` block on low confidence — that risks regressing a shipped honesty fix (`document-rag.ts` `retrievalFailed` stamp ~:414–421 and the partial-sample/`ingestedNames` hint ~:429–435, which exist to stop the model falsely concluding "you have no CV/documents"; audit `ef9bd480`, session `9b0414e3`). Instead **demote wording** (drop "Treat as authoritative source context" → "possibly-relevant excerpt"), compose with `listInScopeDocuments` so the existence acknowledgment survives at low retrieval confidence, and **never early-return past the honesty stamps**. Gate + eval specifically for the false-negative regression.

**`tenant_id` scope-sets (adopt, M→L).** The real unlock: single-string `tenant_id` (already at pin) can't express StarlingAI's multi-source-per-session reads; the v0.6.0 **list** form can. But it is **narrower than "the single largest simplification"** — it replaces only the ~15-line retrieval post-filter loop. It does **not** remove `listInScopeDocuments` (the existence path), `callerManageableSources` (the gateway's cross-user RBAC boundary for list/download/delete — keep regardless), the `retrievalFailed`-vs-empty distinction, or the `ENGRAM_DOC_LIST_TTL` doc-list cache. engram "holds no auth model" (verbatim in the CHANGELOG, with a stated 0%-leakage guarantee backed by `tests/test_store_contract.py`), so **StarlingAI owns the scope contract** — a tenant-mapping bug = cross-user doc leak. Keep the client post-filter as **defense-in-depth** until a security-grade eval proves 0 cross-scope leakage; only then retire it. Size the phase to include that leak eval.

**Document invalidation (pilot).** Non-destructive and auditable. **But it FORKS the delete story rather than unifying it:** StarlingAI already has a non-destructive, scope-aware soft delete — `engramDeleteDocument(id, source)` drops only that source ref and the document survives if other sources hold it (`engram.ts` ~:229–245; `forgetDocument` `document-rag.ts` ~:453–488). Adding `invalidated_at` layers a **second** soft-delete model on the same object with unresolved interactions (invalidate a doc that still has other source refs → reference-count vs `invalidated_at`? does an invalidated doc still answer the existence path?). Crucially, invalidate must **not** `rm` the persisted original (or it can't reinstate), which means a **different** registry/file lifecycle than `forgetDocument`. Reconcile the two models and pick one before adopting; this is a new lifecycle state (`active`/`invalidated`/`hard-deleted`) threaded through engram + registry + files + UI + existence path — more than "one endpoint + UI wiring."

**`GET /chunks/{id}/context` (pilot).** A targeted, cheaper alternative to inlining whole documents; complements rather than replaces `inlineSmallDocuments`. Fetch neighbor context only when a chunk scores high but is short. Note the **default-valid gating** lives at main HEAD (`8ac3087c`), not the `v0.6.0` tag. Cap added context chars.

---

## 4. Strategic options

### A. Thin optional doc-RAG + adopt the cheap read-path wins (RECOMMENDED)

Keep engram exactly where it is architecturally — optional, profile-gated, gracefully-degrading doc-RAG — but bump the pin and adopt only capabilities that improve honesty and/or delete StarlingAI code: CRAG confidence, native `tenant_id` scope-sets, non-destructive invalidation, plus the free near-dup contradiction guard.

- **Pros:** lean-base aligned (eventually retires the scope post-filter); every adopted piece degrades gracefully and stays flag-gated default-off; honesty gains (confidence demotion, contradiction guard) serve "prevent hallucinations at all costs"; low blast radius (no new subsystem, no backend change, no per-turn tool bloat); respects engram's honest-negative by leaning on operational value.
- **Cons:** leaves feedback/memory-boost, chunk-context deep-adoption, and MCP tools unadopted (deliberately); does **not** consolidate StarlingAI's memory stores; requires a re-ingest/registry reconcile for `tenant_id` (see §6); **during the flag-gated period it is net-additive LOC** (adds `tenant_id` plumbing + keeps the post-filter) — the "deletes code" payoff only lands *after* the leak eval passes.

### B. Adopt engram's MCP memory tools as an agent-facing memory surface

Expose engram's 6 MCP tools (`search`/`get_chunk_context`/`list_documents`/`search_themes`/`mark_used`/`invalidate_document`) to agents.

- **Pros:** ready-made tool surface without bespoke client code; aligns with the MCP interop investment.
- **Cons:** **duplicates** StarlingAI's scoped `memory_store`/`memory_search`/`share_finding` (tier+RBAC) with a **second, unscoped** path (engram holds no auth model); adds tools to per-turn context against the lean-base/lean-prompt direction; `search_themes` returns empty on engramdb; memory-boost is n.s.; the MCP search envelope changed shape post-tag → new coupling to an evolving surface.

### C. Unify durable-memory + knowledge-graph + doc-RAG onto engram

Make engram the single memory backend.

- **Pros:** one store instead of many; follows the "agent-memory pivot" marketing at face value.
- **Cons:** **overclaim trap** — engram's "agent memory" is document-centric, not the episodic/semantic/procedural/working memory StarlingAI models (engram doesn't model those at all); would discard StarlingAI's kind/subject-typed, RBAC-scoped, supersession-aware memory for a chunk store with no auth; engramdb has no entity/community graph (501/empty), so unification forces a Neo4j+GDS backend, re-homelabbing against de-lex; massive migration + eval cost for negative architectural value.

### D. Replace MemGraph with engram's graph

Retire StarlingAI's MemGraph/Neo4j knowledge graph for engram's `/graph` + `/communities`.

- **Pros:** one fewer graph backend *if it worked*.
- **Cons:** engram's `/graph` and `/communities` are **501/empty** on the engramdb backend StarlingAI runs — inactive regardless of pin; would require standing up the exact Neo4j+GDS server StarlingAI removed; MemGraph is already wired to memory write-through, `graph_upsert`/`relate` tools, and the dashboard graph view; engram's graph is chunk/document-centric, not the memory-object graph. Pure duplication + regression risk.

---

## 5. Recommended path

**Take Option A, phased**, with the pin bump as an **eval-gated** enabling first move and every behavioral change flag-gated default-off pending the user's pass^k eval.

**Rationale.** engram's own eval says the win is **operational, not quality**, so the right move is to harvest the specific operational/honesty capabilities that (a) eventually delete StarlingAI code (scope-sets → retire the post-filter *after* a leak eval), (b) improve faithfulness (CRAG confidence *demotion* + near-dup guard), and (c) can pair with the memory-management UI just shipped (invalidation as a document analog of the iter26 soft-delete) — while **rejecting** the graph/community/MCP-memory surfaces that are inert on engramdb, duplicate working subsystems, and would drag a Neo4j server back in.

**Decouple the clean win from the eval-gated batch.** The four behavioral phases add four new default-off flags onto an already-long eval-pending backlog (`taskGraphFailureDisposition`, `clampSubAgentTimeoutToParent`, `userProfilePrefetch`, `progressVerifierSemantic`, …). To avoid the recurring dead-flag accretion, **ship the no-flag ops-housekeeping (Phase 0c) now**, and **gate the four behavioral phases behind ONE combined eval**, not four.

**Phasing:**

- **Phase 0 (S, eval-gated):** pin bump (candidate `ENGRAM_REF` → canary → promote) + smoke test + ops housekeeping. Adopts the near-dup contradiction guard; adopting the server-side read-path changes is itself the behavioral change that needs an eval gate + rollback.
- **Phase 1 (S):** CRAG confidence **demotion** (not suppression), flag default-off — cheapest, highest honesty value, degrades to today's behavior when fields/engram absent, must compose with the `retrievalFailed`/`ingestedNames` honesty stamps.
- **Phase 2 (M→L):** `tenant_id` scope-sets behind a flag, **keeping** the post-filter as defense-in-depth until a security eval proves 0 cross-scope leakage, then retire only the post-filter loop.
- **Phase 3 (M):** document invalidation, but **only after** reconciling it with the existing reference-count soft-delete and defining the new lifecycle state.
- **Phase 4 (S, pilot):** `GET /chunks/{id}/context` (main HEAD for default-valid gating) to cut dropped-section hallucination.
- **DEFER:** feedback/memory-boost, `b1` quant, recency/adaptive routing (eval-gated, unproven).
- **REJECT:** graph, communities, MCP-as-memory, unify.

This keeps engram optional, portable, and gracefully degrading throughout.

---

## 6. Migration & integration steps

1. **Phase 0a — Pin bump.** Change `docker/engram/Dockerfile` `ARG ENGRAM_REF` from `d81a488…`. **Decide the target explicitly:** the `v0.6.0` tag (`e5e3a83b`) gives scope-sets + CRAG fields + invalidation + near-dup guard; **main HEAD (`8ac3087c`)** additionally gives `INVALIDATION_OVERFETCH` + the MCP full-envelope + `/chunks/{id}/context` default-valid gating. Update the compose build-arg default and the `.env.example` example line (currently shows `v0.5.0`). Rebuild (the `ARG` change re-triggers the shallow fetch). Document the "tags-are-truth, `main.py` version string lags" convention at the pin site. **Treat this as eval-gated: canary the ref, keep `d81a488` as instant rollback.**

2. **Phase 0b — Smoke test the 5 existing endpoints** against the rebuilt image: `GET /health`, `POST /documents`, `POST /search`, `GET /documents`, `DELETE /documents/{id}?source=`. **Confirm** `tuning.final_top_k` is still honored (it is a live tunable in `search.py`, so this is a smoke-test not a likely break — if it ever stops, switch the client to top-level `top_k`) **and** that the snake_case result field names are unchanged. The client maps **by key** with `?? 0`/`?? ''` fallbacks (`engram.ts` ~:172–185), so a renamed/dropped field does **not** shift others — it **silently zeroes** that field (e.g. `rerankScore → 0`, which then trips `minRerankScore` and drops the chunk, making RAG appear to return nothing). This phase picks up the contradiction guard for free.

3. **Phase 0c — Ops housekeeping (no flag, ship now).** Fix the **stale `engram-neo4j` references** in `scripts/sai.mjs` (lines ~288, 333, 357, and the cypher-shell wipe at ~400–404) — they target a container that does not exist under the `engramdb` backend and would error/no-op. *(Do not bother "confirming the `ENGRAMDB_PATH` snapshot volume" — `docker-compose.yml:274` already sets `ENGRAMDB_PATH=/data/engramdb.pkl` with the `engram-data` volume mounted and commented; that sub-item is a no-op.)*

4. **Phase 1 — CRAG confidence (flag default-off).** Extend `EngramSearch` handling in `engram.ts` to read response-level `top_rerank_score` and `score_gap`; in `document-rag.ts`, **demote wording** in `formatDocumentContext` when `score_gap`/`top_rerank` fall below a conservative threshold (authoritative → possibly-relevant excerpt) instead of suppressing the block. Absent fields (pre-bump / engram down) fall through to today's behavior. **Never early-return past** the `retrievalFailed` / `ingestedNames` honesty stamps; compose with `listInScopeDocuments` so existence acknowledgment survives at low confidence. Eval specifically for the false-negative regression.

5. **Phase 2 — Scope-sets (flag default-off).** Send `tenant_id` as the list of active scope sources on `POST /search`, and stamp `tenant_id` on `POST /documents`, in `engram.ts`/`document-rag.ts`. **Keep** the client-side post-filter (`document-rag.ts` ~:229–243) running as defense-in-depth. Run a **security-grade eval asserting 0 cross-scope/cross-user leakage**; only after it passes, retire the post-filter loop. **Keep** `callerManageableSources` (RBAC), `listInScopeDocuments` (existence), and the doc-list cache — `tenant_id` does not replace them. **Migration nuance:** `tenant_id`-on-ingest is a **metadata backfill, not an embedding recompute**; old untagged docs will simply **lack** the tag and a tenant-filtered search will **miss** them (false-negative during transition). Before any wipe, run a **re-ingest-from-persisted-originals** (originals are on disk via the registry `relativePath`, per `forgetDocument`'s `rm` path) or a registry-reconcile step, so the persistent document-registry and the engram index never diverge (a naive wipe leaves `listInScopeDocuments` saying "you have a CV" while retrieval returns nothing — a silent user-visibility loss even though the bytes are disposable).

6. **Phase 3 — Document invalidation (flag default-off).** **First reconcile with the existing reference-count soft-delete** (`engramDeleteDocument`/`forgetDocument`) and pick one model. If invalidate wins: add `engramInvalidate(documentId)` to `engram.ts` (`POST /documents/{id}/invalidate`); define its interaction with existing source refs; **keep the persisted original** (diverge from `forgetDocument`'s `rm`) so it can reinstate; decide whether invalidated docs answer the existence path; wire the Documents-page delete to soft-invalidate as default with a 2-step hard-DELETE, mirroring the iter26 memory-page UX (`0a43fe7`). Verify the `invalidated_at` marker persists across an engramdb snapshot. Size for the new `active`/`invalidated`/`hard-deleted` lifecycle, not one endpoint.

7. **Phase 4 — Pilot `GET /chunks/{id}/context` (flag default-off).** When a retrieved chunk scores high but is short, fetch its neighbor context to reduce dropped-section hallucination (audit `ef9bd480`), as a cheaper complement to `inlineSmallDocuments`. Cap added context chars. Requires main HEAD for the default-valid contract.

8. **DEFER** (revisit only on a positive controlled internal eval): `POST /feedback` + `mark_used` memory-boost; `ENGRAMDB_QUANTIZATION` f16→b1 (a true embedding/store schema-signature change → forces a full re-ingest, distinct from the `tenant_id` metadata backfill); recency decay / adaptive query routing. Note: **yake** zero-LLM ingest is available but currently **overridden off** — `docker-compose.yml:254` sets `METADATA_EXTRACTOR=${ENGRAM_METADATA_EXTRACTOR:-default}`, so StarlingAI runs the LLM `default` extractor; enabling yake is a deliberate opt-in worth its own quick quality check, not a no-op.

9. **REJECT** (do not implement): `/graph/entities`, `/graph/relations`, `/communities/*`, and engram's MCP memory tools — 501/empty on engramdb, duplicate MemGraph + the scoped memory tool layer, and would require a Neo4j+GDS backend against the lean-base/de-homelab direction.

10. **Throughout:** keep engram behind the off-by-default `rag` profile, keep every client path returning `null`/`[]` on failure (never throw), and keep all config in `config/tooling/10-platform.jsonc` shards (`starlingai.json` is regenerated on every build).

---

## 7. Risks & how we keep engram optional/portable

- **Cross-user document leak** if the `tenant_id` scope-set mapping is wrong — engram "holds no auth model," so StarlingAI owns the scope contract. *Mitigation:* keep the client-side post-filter as defense-in-depth until a security eval proves 0 leakage before retiring it; keep `callerManageableSources` RBAC independent of retrieval `tenant_id`.
- **Pin bump adopts 16-17 commits of server-side behavior at once** — the near-dup contradiction guard (and any read-path tweaks) are default-on and **not** flag-gateable from StarlingAI's side. *Mitigation:* canary `ENGRAM_REF`, run the retrieval/pass^k smoke before promoting, keep `d81a488` as instant rollback. Do not label the bump "zero-risk."
- **Tag-vs-main confusion** — pinning the `v0.6.0` **tag** silently omits `INVALIDATION_OVERFETCH`, the MCP envelope, and `/chunks/context` gating. *Mitigation:* pin main HEAD (`8ac3087c`) if those are needed; document the target commit and why.
- **CRAG false-negative regression** — a block-level suppress-on-low-confidence re-opens the "you have no CV/documents" hallucination the `retrievalFailed`/`ingestedNames` stamps fixed. *Mitigation:* demote wording, never suppress; never early-return past the honesty stamps; eval the false-negative class.
- **Registry/index divergence on re-ingest** — a naive engramdb wipe desyncs the persistent document-registry from an emptied index (existence path says "you have a CV," retrieval returns nothing). *Mitigation:* re-ingest from persisted originals (registry `relativePath`) or reconcile the registry; never leave a half-migrated store.
- **Silent `/search` field zeroing** — a renamed field coerces to `0`/`''` via the client fallbacks and drops chunks. *Mitigation:* Phase 0b field-name smoke test.
- **Portability regression** — any adoption must keep engram optional + gracefully degrading; a confidence gate or invalidation path that hard-depends on engram would break the no-`depends_on`/never-throw invariant and stall turns when engram is down (the 8s-timeout lesson). *Mitigation:* every path returns `null`/`[]`; absent CRAG fields = today's behavior.
- **Delete-model fork (Phase 3)** — layering `invalidated_at` on the existing reference-count soft-delete risks "duplicate a subsystem without removing it." *Mitigation:* reconcile to one model before shipping.
- **Overclaim/scope-creep toward B/C/D** — engram's "agent memory" is document-centric; unifying StarlingAI's RBAC-scoped stores onto it discards richer subsystems and re-adds Neo4j. *Mitigation:* hold the line at Option A.
- **Dead-flag accretion** — four new default-off flags that never get evaluated. *Mitigation:* ship Phase 0c now with no flag; gate the four behavioral phases behind ONE combined eval or defer until eval bandwidth exists.

---

## 8. Open questions for the maintainer (you)

1. **Pin target:** the `v0.6.0` **tag** (`e5e3a83b`) or **main HEAD** (`8ac3087c`)? Only main HEAD carries `INVALIDATION_OVERFETCH`, the MCP full-envelope, and the `/chunks/{id}/context` default-valid gating — will you cut a `v0.6.1` tag, or should we pin main HEAD directly? Relatedly, will you cut GitHub Releases for `v0.2.0..v0.6.0` (the Releases UI stopping at `0.1.2` is a downstream-pinning liability)?
2. **`final_top_k`:** confirmed still a live tunable — do you want the client to keep sending `tuning.final_top_k`, or move to the top-level `top_k` field for robustness?
3. **Scope-sets as a trust boundary:** given engram "holds no auth model," do you consider native `tenant_id` isolation a trustworthy boundary for cross-**user** separation — and should StarlingAI keep its post-filter as defense-in-depth **permanently**, or retire the loop once a 0-leak eval passes?
4. **Invalidation vs the existing ref-count soft-delete:** should `invalidated_at` **replace** the current `engramDeleteDocument` reference-count model, or coexist? Is bi-temporal "stage 1" stable enough to back a user-facing Documents-page soft-delete, or should it stay a pilot?
5. **Dogfood the write path?** Do you want StarlingAI to exercise `/feedback` + `mark_used` (`MEMORY_BOOST`) to gather real signal, accepting it is n.s. on quality and operational-only — or keep it off until an internal eval shows lift?
6. **engramdb permanence:** is `engramdb` the permanent backend? If so, `/graph/entities+relations` and `/communities/*` are permanently inert (501/empty) and should be dropped from the candidate list entirely. A future Neo4j+GDS backend would change the graph/community calculus.
7. **yake:** it is currently **overridden off** in compose (`METADATA_EXTRACTOR=default`). Do you want to opt into yake (`ENGRAM_METADATA_EXTRACTOR=yake`) for cheaper/faster ingest, accepting it is a behavior change worth a quick quality check?
8. **One-shot live `/search`** to confirm the exact snake_case result field names (`chunk_id`, `graph_distance`, `graph_proximity`, `retrieval_score`, `median_score`, `fused_score`, `rerank_score`) survive before merging the bump — will you run it, or should the canary cover it?

---

## Appendix: verification notes

An adversarial pass fact-checked every engram endpoint/tool/version claim against live primary sources (the engram `main` branch, the pinned SHA, and the GitHub compare/tags/releases API) and stress-tested Option A against the StarlingAI codebase.

**Confirmed (verbatim / against source):**
- v0.6.0 CHANGELOG title *"The agent-memory pivot: engram is now an agent-memory engine (RAG is its read path)"* and README *"A retrieval engine for agents"* — the "repositioning + additive write-path on an intact RAG core, not a fork/rewrite" framing is accurate.
- `app/main.py:55` hardcodes `version="0.5.0"`; GitHub Releases return exactly 3, stopping at `v0.1.2`; git tags run `v0.1.0..v0.6.0`. "Tags are the truth" is correct.
- Pin `d81a488` is a clean ancestor, exactly **1 commit past `v0.5.0`** (that commit = yake no-LLM-ingest default), post-v0.5.0 / pre the v0.6.0 pivot.
- All **14 HTTP endpoints** enumerated as in `main.py`, including `POST /documents/{doc_id}/invalidate` (new; docstring "the agent-memory supersession write") and `GET /chunks/{chunk_id}/context` (pre-existing at the pin, line 246).
- Exactly **6 MCP tools** (`search`, `get_chunk_context`, `list_documents`, `search_themes`, `mark_used`, `invalidate_document`); only 5 at the pin (no `invalidate_document`) — the +1 correctly attributed to v0.6.0.
- `models.py` `SearchRequest.tenant_id` is `str | list[str] | None` on main vs `str | None` at the pin (list/scope-set form genuinely new); `SearchResponse` gained `top_rerank_score` + `score_gap` (`float|None`) via `retrieval_confidence()`, absent at pin.
- `/graph/entities` + `/graph/relations` raise **501** on engramdb; `/communities/rebuild` → 501, `GET /communities` + community vectors return `[]`. Graph/community/theme layer is **Neo4j+GDS-only**, inert on engramdb regardless of pin.
- Honest-negative eval: scorecard states ~+1.4 nDCG over naive dense+rerank but **n.s.** (95% CI straddles 0, sign-p>0.05) and a **tie** vs a strong hybrid+rerank baseline; PPR is ~65% of latency at 20k and recommended off. "Operational win, not a quality win" is faithful.
- `MEMORY_BOOST_ENABLED=false` and `RECENCY_ENABLED=false` by default; yake is engram's default extractor with a separate `EXTRACTION_LLM_*` endpoint; `b1` quant ~32x less vector memory "at the same quality" per README.
- "engram holds no auth model, same trust contract as single-tenant reads" is **verbatim** in the CHANGELOG scope-sets entry, with a 0%-leakage guarantee backed by `tests/test_store_contract.py` — grounding the cross-user-leak caution.
- The central skepticism target holds: engram provides **no agent-self-editing memory blocks**; its temporal validity is only deterministic document-level supersession ("bi-temporal stage 1"); LLM-driven auto-invalidation and full `valid_from/valid_to` edge validity remain engram's own GAP. It is **doc-RAG-with-a-graph plus a document-level write path**.
- The free near-dup contradiction guard (`scoring.numeric_conflict` in `_collapse_near_dups`) and `INVALIDATION_OVERFETCH` exist; `final_top_k` is still live (`final_top_k = top_k or settings.final_top_k`).
- StarlingAI current-state accurate: exactly the 5 endpoints, client-side source-token post-filter with a separate `listInScopeDocuments` existence path, config in the `10-platform.jsonc` shard, off-by-default `rag` profile with no `depends_on` engram, every client path catch-and-returns.
- Option A's **direction** is sound and creates no hard engram dependency; the **reject** of B/C/D is well-founded (the duplicate StarlingAI subsystems `tools/memory.ts`, `tools/graph.ts`, `memory/graph-service.ts` all exist; engram's graph/communities are genuinely inert on engramdb).

**Corrected:**
- **Fabricated citation dropped:** the claim that engram's scorecard "marks episodic/semantic/procedural/working memory *absent*" — those terms and "absent" appear nowhere in engram's docs. Restated as "engram provides no such cognitive memory (none is mentioned)," grounded in what the docs do say.
- **Commit count:** the pin is **17 commits behind main HEAD** (13 behind the `v0.6.0` tag), not 16.
- **Tag ≠ main HEAD:** the `v0.6.0` tag is commit #13 of 17; `INVALIDATION_OVERFETCH`, the MCP full-envelope, and `/chunks/context` default-valid gating are **post-tag `[Unreleased]` on main** — a tag pin does not deliver them.
- **Pin bump is not "zero-behavior-change":** it adopts server-side read-path changes that are default-on and not flag-gateable — reframed as an eval-gated behavioral change with canary + rollback.
- **CRAG must demote, not suppress:** block-level suppression risks regressing the `retrievalFailed`/`ingestedNames` honesty fix (audit `ef9bd480`).
- **`tenant_id` scoped down:** replaces only the ~15-line post-filter loop, not `listInScopeDocuments`/`callerManageableSources`/doc-list cache; net-additive LOC during the flag-gated period; resized M→L to include the leak eval.
- **`tenant_id`-on-ingest is a metadata backfill, not an embedding recompute:** old untagged docs become false-negatives; a re-ingest-from-originals / registry reconcile is required to prevent registry↔index divergence.
- **Invalidation forks, not unifies, the delete story:** StarlingAI already has a reference-count soft-delete; the two models must be reconciled and a new lifecycle state accounted for.
- **`/search` mapping is by key, not positional:** a renamed field silently zeroes that field (dropping chunks via `minRerankScore`), not a skewed count.
- **yake is overridden off** in `docker-compose.yml:254` — "already in production behavior" was false; it is an opt-in.
- **`ENGRAMDB_PATH` volume item is a no-op** (already set at compose:274) — dropped from Phase 0c, which now focuses solely on the confirmed stale `engram-neo4j` references in `scripts/sai.mjs`.

**Could not verify (confirm in repo / live):**
- Whether v0.6.0 preserves the exact snake_case `/search` result field names the client maps (Phase 0b live `/search` smoke test) — *(unverified — confirm in repo)*.
- Whether `tuning.final_top_k` remains honored end-to-end in the deployed image (it is still a source-level tunable, so this is a smoke test, not a likely break) — *(unverified — confirm in repo)*.
- engramdb persistence/snapshot semantics for the `invalidated_at` marker across a restart — *(unverified — confirm in repo)*.
- Whether the `b1` quant flip is genuinely quality-neutral on StarlingAI's own document set — *(unverified — confirm via isolated eval)*.