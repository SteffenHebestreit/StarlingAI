# engram feature spec: read-side `sources` scope filter (for engram vNEXT)

**Consumer:** StarlingAI Phase 2 (docs/engram-reevaluation-2026-07.md §5/§6) — server-side
scope isolation for document search, chosen over `tenant_id` stamping (decision 2026-07-06).

## Why not `tenant_id`

Verified against engram v0.8.0 source: `tenant_id` is single-valued at ingest and namespaces
document ids (`core/ingest.py compute_document_id` → `f"{tenant_id}:{base}"`), so the same
content under two tenants becomes two documents. StarlingAI deliberately relies on the
opposite: it never passes `document_id`, engram content-hash-derives it, and the same bytes
ingested under `session:A` + `session:B` + `workspace` converge on ONE document whose
multi-valued `sources` array is reference-counted (`add_document_source`, scoped DELETE).
That dedup **is** StarlingAI's promotion path and delete semantics. Additionally, untagged
legacy chunks are excluded from every tenant-scoped read (null stamp fails membership in all
three backends) and there is no retag/backfill endpoint — so tenant adoption would force a
full re-ingest migration.

The `sources` array, by contrast, is already stored document-level in every backend and is
exactly the axis StarlingAI post-filters on client-side today (`document-rag.ts`
`retrieveDocumentContextWithStatus`: list documents → keep those whose sources intersect the
active scope set → post-filter search hits). This spec moves that filter server-side.

## API

`SearchRequest` (core/models.py) gains:

```python
# optional source scope-set: when set, only chunks belonging to a document whose
# `sources` array intersects this set are surfaced (documents are multi-source /
# reference-counted, so this is a SET-vs-SET intersection at the document level —
# unlike tenant_id, which is a single per-chunk stamp). None = no source filter.
sources: str | list[str] | None = None
```

- Normalization mirrors `tenant_scopes`: bare string → 1-element set; `[]` → None.
- **Independent of `tenant_id`; AND-composed when both are given.**
- Ingest, `GET /documents`, `DELETE /documents/{id}?source=`, invalidation: **unchanged**
  (the write path already maintains `sources`; this is purely read-side).
- MCP `search` tool: pass-through parameter, same as `tenant_id` today.

## Semantics

A chunk is surfaced iff `document(chunk).sources ∩ requested_sources ≠ ∅`. This must hold on
**every chunk-surfacing read**, mirroring where the tenant filter already sits:

| Read | v0.8.0 tenant anchor | sources filter |
|---|---|---|
| vector_search | graph.py:254 / store_pgvector.py:584 / store_engramdb.py:258,291,300 | same position, doc-level lookup |
| fulltext_search | graph.py:334 / store_pgvector.py:663 / engramdb `_tenant_ok` (:429) | same |
| nearest_chunks (ingest dedup) | graph.py:298 / store_pgvector.py:617 | same |
| graph siblings | core/search.py:153-160 final gate | same gate, `doc_sources(s["document_id"]) ∩ set` |
| memory_candidates (feedback boost) | engramdb `_tenant_ok` | same |

Per-backend sketch:

- **neo4j:** chunks carry no sources; join to the document node:
  `MATCH (c)-[:PART_OF]->(d) … WHERE $sources IS NULL OR any(s IN d.sources WHERE s IN $sources)`
  (or pre-resolve the matching doc-id set with one indexed query and filter `c.document_id IN $ids`
  — preferable when the doc count is small relative to chunks).
- **pgvector:** `AND (%(sources)s::text[] IS NULL OR EXISTS (SELECT 1 FROM documents d
  WHERE d.id = chunks.document_id AND d.sources && %(sources)s::text[]))` — or the same
  pre-resolved doc-id set. `&&` is the array-overlap operator.
- **engramdb:** documents dict already holds `sources` (store_engramdb.py `self._docs`);
  add `_sources_ok(rec)` beside `_tenant_ok` doing
  `doc = self._docs.get(rec["document_id"]); bool(set(doc["sources"]) & requested)` and apply
  it in the exact-matmul mask, the usearch-ANN scan, the b1 rescore recheck, BM25, and
  memory_candidates — the same five sites the tenant mask touches.

**Recall over-fetch:** the filter is post-index on the ANN paths, so reuse
`store_common.tenant_fetch_k` (trigger over-fetch when *either* tenant scopes or source
scopes are set) — consider renaming to `scoped_fetch_k`.

**Invalidation interaction:** none — the `invalidated_documents` drop already happens
independently; sources filtering composes.

## Tests (mirror the 0-leak tenant suite)

- `tests/test_store_contract.py`: for each backend — doc A `sources=["session:s1"]`, doc B
  `sources=["session:other"]`, shared doc C `sources=["session:s1","workspace:w"]`; search
  with `sources=["session:s1"]` must surface A + C, never B, across vector / fulltext /
  graph-sibling / memory_candidates paths. Search with `sources=None` unchanged (sees all).
- Graph-sibling bypass test: B reachable as a keyword sibling of A must still be dropped.
- `[]` normalizes to unfiltered; bare-string equivalent to 1-element list.

## StarlingAI integration contract (already pre-wired, flag-gated)

- Client sends `sources: [...activeScopeSources]` on `POST /search` when
  `retrieval.documentRag.serverSideScopeFilter` is enabled (default off). Older engram
  ignores the unknown field (pydantic default `extra='ignore'`) — behavior identical.
- The client-side post-filter **stays on permanently as defense-in-depth** (it also carries
  per-document metadata the injection needs); the server filter's job is 0-leak enforcement
  and recall efficiency (`final_top_k` no longer wasted on off-scope hits — today the client
  requests `candidateTopK=30` mostly to survive the post-filter).
- No migration: `sources` is already populated on every existing document.

## Non-goals

- Not a multi-instance tenancy boundary (that stays `tenant_id`, unchanged).
- No write-path changes, no id-namespacing changes, no backfill needed.
