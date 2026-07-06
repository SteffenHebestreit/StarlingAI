# Knowledge Bases

<p align="center">
  <img src="../assets/brand/swarmLogo.svg" alt="StarlingAI logo" width="180" />
</p>

A knowledge base (KB) is a named corpus built by recursively crawling a documentation site — a wiki, a standard, a product manual — into the [engram](https://github.com/SteffenHebestreit/engram) graph-RAG store. A KB is **workspace-shared by default**, but can be [scoped](#scope) to one user or a single conversation, and can carry a [worker](#worker-per-kb-temporary-agent) — a purpose-built single-use agent that knows how to apply it to a task. Every crawled page becomes one engram document under the KB's `kb:<id>` source token, and agents query the corpus with `search_knowledge_base`, getting back excerpts **with their source page URLs** so answers cite the site.

The crawler is deliberately deterministic — no LLM in the loop. Fetching pages and following links is mechanical work, so a bounded BFS is cheaper, politeness-bounded, and reproducible. Agents operate *above* that layer: create the KB, poll its status, then ground answers in it.

Knowledge bases require Document RAG (`retrieval.documentRag.enabled` and a reachable engram service). With that off, every KB tool and route no-ops gracefully with an explanatory error.

See also: [REST API](api.md) · [Security Model](security.md) · [Architecture & Design](architecture.md)

## The Canonical Workflow — Audit A Site Against The W3C Accessibility Docs

The intended flow is "make this site our knowledge, then use it". Example: index the WCAG 2.2 documentation once, then audit any website against it.

**1. Create the KB** (`create_knowledge_base`). The tool returns immediately; the crawl runs in the background.

```json
{
  "name": "W3C Accessibility Docs",
  "seed_urls": ["https://www.w3.org/WAI/WCAG22/"],
  "description": "WCAG 2.2 reference and understanding docs for accessibility audits"
}
```

The id is derived from the name (`w3c-accessibility-docs`), and the crawl stays on `www.w3.org` under the `/WAI/WCAG22/` path prefix, up to the KB's page and depth budgets.

**2. Poll until ready** (`list_knowledge_bases` with `knowledge_base="w3c-accessibility-docs"`). The detail view reports live crawl progress — pages visited/ingested/failed, the URL currently being processed, and the frontier size. Crawls of large sites can take several minutes.

**3. Search during the audit** (`search_knowledge_base`). For each finding, query the KB and cite the returned page URLs:

```json
{
  "knowledge_base": "w3c-accessibility-docs",
  "query": "minimum contrast ratio for large-scale text"
}
```

Excerpts come back ranked, each with its source page URL — e.g. an audit finding can cite `https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html` directly instead of paraphrasing from model memory.

**4. Keep it fresh** (`manage_knowledge_base` with `action="recrawl"`). Unchanged pages are skipped by content hash, changed pages are replaced in place, and pages that disappeared from the site are pruned.

## How Crawling Works

A crawl is a bounded breadth-first search over the site, run by a small worker pool (`concurrency`, default 2) over a shared frontier seeded with the KB's seed URLs.

### URL normalization

Every URL (seed, link, redirect target) is normalized before scope checks and dedup: fragments and credentials are stripped, tracking query params are dropped (`utm_*`, `fbclid`, `gclid`, `msclkid`, `ref`), the remaining query is sorted, and non-http(s) URLs are rejected. The normalized URL is also what the page's stable document id is derived from.

### Scope — what gets crawled

Per URL, in order:

1. **`excludePatterns` veto** — a URL matching any exclude regex is never crawled. Wins over everything.
2. **Seed-prefix rule or `includePatterns` widening** — a URL is in scope when it starts with a seed's *scope prefix*, or matches any include regex. A seed's scope prefix is its directory: a seed ending in `/` is its own prefix (`https://www.w3.org/WAI/WCAG22/` covers everything under that path); otherwise the final path segment is dropped (`…/docs/index.html` → `…/docs/`).
3. **`sameOriginOnly`** (default `true`) — additionally restricts the crawl to the seed URLs' origins. Setting it to `false` **requires** non-empty `includePatterns`, otherwise the frontier would be unbounded; creation/update rejects that combination.

Links are extracted from HTML anchors (honoring `<base href>`), skipping `rel=nofollow` and `mailto:`/`javascript:`/`tel:`/`data:`/`ftp:` targets. Asset URLs are skipped by path extension — images, CSS/JS, archives, audio/video, fonts, binaries, and office files (kept out to keep the frontier lean). **PDF is deliberately allowed.**

### robots.txt

With `respectRobots` (default `true`, per-KB), each origin's `robots.txt` is fetched once per crawl and parsed with a minimal parser: the `User-agent` groups matching the crawler's User-Agent token apply (falling back to `*`), longest-match wins, `Allow` beats `Disallow` on equal length, and `*` wildcards / `$` anchors in rule paths are supported. A `4xx`/`5xx`/unreachable robots.txt is treated as "no restrictions" — it never blocks the crawl. Disallowed URLs are skipped *without* a fetch, so they do not consume the page budget.

### Politeness and safety

- **Per-host delay** — at least `requestDelayMs` (default 300 ms) between two request *starts* to the same host, across all workers.
- **SSRF guard** — the same discipline as `web_fetch`: redirects are followed manually (at most 5 hops), and on *every* hop the target hostname is checked against the private-host blocklist plus a DNS re-resolution of all records. `retrieval.knowledgeBases.allowPrivateHosts` (default `false`) disables this check — turn it on **only** for instances that need to index an internal wiki and trust their operators. A redirect that lands off-scope or on an already-crawled page is dropped.
- **Budgets** — the crawl stops gracefully (keeping the partial corpus) at the first of: `maxPages` fetch attempts (per-KB, clamped to `maxPagesCap`), the `maxCrawlMs` wall-clock deadline, or a cancel. `maxDepth` bounds link depth from the seeds (0 = seeds only). Pages larger than `maxPageBytes` are skipped (pre-checked via `Content-Length` when present, re-checked on the actual body). The frontier itself is hard-capped at `max(maxPages × 5, 500)` queued URLs.

### Content types

| Content | Handling |
| --- | --- |
| `text/html`, `application/xhtml` | Title extracted (`<title>`, falling back to the first `<h1>`); in-scope links enqueued; converted to Markdown by the file-conversion service (`multimodal.files`), with a **built-in HTML→Markdown fallback** (headings, lists, tables preserved; nav/header/footer/aside boilerplate dropped) when that service is down |
| `application/pdf` (or a `%PDF-` magic-byte body) | Converted to Markdown by the file-conversion service |
| `text/plain`, `text/markdown` | Ingested as-is |
| Anything else | Skipped |

The ingested document is framed with a title heading plus `Source URL:` and `Knowledge base:` lines before the page content, so retrieval excerpts stay attributable even inside engram.

## Storage Model

**engram is the source of truth for the index.** Each page is one engram document under the single source token `kb:<id>`, with a stable document id derived from the KB id and the normalized page URL (`kb-<id>-<24-hex-hash>`). Stable ids are what make crawls idempotent:

- **Unchanged page** — the ingested text's SHA-256 matches the stored hash → skipped (`pagesSkippedUnchanged`), only its last-seen marker is refreshed.
- **Changed page** — re-ingested under the *same* document id, replacing the old version in place.
- **Removed page** — pruned from engram **only after a complete crawl** (stop reason `completed`, i.e. the frontier was exhausted). A partial run — page/time budget hit, or cancelled — simply didn't visit the rest of the site, and pruning on it would shred the corpus, so it never prunes.

Because a KB document has exactly one source token, deleting a KB can hard-delete its documents without ever touching session/user/workspace document scopes.

**The manifest** lives at `<workspace>/uploads/.knowledge-bases.json` and carries what engram does not store: each KB's crawl configuration, page URLs (for citation), content hashes (change detection), and crawl status/stats. It sits deliberately beside the document registry so the same uploads cleanup / `sai stop --volumes` (`docker compose down -v`) lifecycle that drops the engram graph clears the KB manifest too — neither can outlive the other.

KB status lifecycle: `idle` (created, never crawled) → `crawling` → `ready` or `failed`. A cancelled crawl leaves the KB `ready` when it already holds pages (they are kept), `idle` otherwise. A finished run that visited pages but ingested nothing (and found nothing unchanged) is marked `failed` with a hint to check the seed URLs, robots policy, and engram availability.

## Scope

A KB carries a **visibility scope** — the same three-scope model as documents and memory:

| Scope | Who can see / search / manage it | Ownership stamp |
| --- | --- | --- |
| `workspace` | everyone on the instance (**the default**) | — |
| `user` | the owning user, across all their chats | `ownerId` |
| `session` | only the conversation that created it | `sessionId` |

Access is decided by `callerCanAccessKb(kb, { userId?, sessionId? })`:

- **workspace** — always visible.
- **user** — visible when the KB's `ownerId` equals the caller's `userId`. A user KB written with **no** owner (single-user / auth-disabled mode) stays visible to everyone, matching the flat instance-wide document view when auth is off.
- **session** — visible only when the caller presents the owning `sessionId`.

**Legacy KBs** created before scoping have no `scope` field and are treated as `workspace` — nothing to migrate.

### Isolation is at the ACL layer, not the index

The engram source token stays `kb:<id>` (one token per KB) regardless of scope — scope does **not** change how documents are stored. Isolation is enforced *above* the index, in the registry ACL:

- every `search_knowledge_base` / `use_knowledge_base` call targets exactly one KB and access-checks it first — an out-of-scope id returns the **same** not-found message as a genuinely missing one (no existence disclosure);
- `list_knowledge_bases` and the `GET /api/knowledge-bases` list are filtered to the caller's accessible KBs (`filterAccessibleKbs`);
- the ambient-retrieval union (`ambientKbSources`) only unions in ready+ambient KBs the caller may access.

So a user- or session-scoped KB never leaks into another user's or conversation's list, search, or ambient context, even though its documents live under the same kind of `kb:<id>` token.

### Setting the scope

- **Create tool** — `create_knowledge_base` takes `scope: "session" | "user" | "workspace"` (default `workspace`). The tool stamps `ownerId`/`sessionId` from the caller's context; you never pass them in the args.
- **REST** — `POST /api/knowledge-bases` accepts `scope` and `sessionId` in the body; `ownerId` is always taken from the auth token, **never** the body. `PATCH /api/knowledge-bases/:id` changes the scope later, re-stamping ownership for the new scope and clearing the stamps that no longer apply. Session-scoped access over REST is presented via the `?sessionId=` query param on the list/detail/crawl/cancel/delete routes.
- **Dashboard** — the Knowledge Bases page create/edit form drives the same `POST`/`PATCH` body.

Creation/update rules: `session` scope requires a `sessionId`, `user` scope requires an authenticated user (`ownerId`); either is rejected with a clear error when its identity is missing.

## Retrieval

### Explicit: `search_knowledge_base`

The primary query path. Retrieval is scoped to the one KB via engram's server-side `sources` filter (`kb:<id>`; older engram releases ignore the unknown field), **and** a client-side post-filter against the KB's own page registry stays on as defense-in-depth — the same two-layer discipline as the main document-RAG scope path. Results reuse the Document RAG knobs: `top_k` defaults to `retrieval.documentRag.retrievalTopK` (capped at 20), and chunks below `minRerankScore` are dropped. Every excerpt carries its source page URL.

### Ambient: `ambientRetrieval` (opt-in, default off)

A KB with `ambientRetrieval: true` and status `ready` joins **every turn's** `[DOCUMENT CONTEXT]` retrieval union alongside the session/user/workspace document scopes — but only for turns whose caller can [access](#scope) it: a workspace ambient KB joins every turn, a user's ambient KB only that user's turns, a session's ambient KB only that conversation's turns. The default is off on purpose — always-on corpora add retrieval noise and prompt weight to every turn, and the lean default is to query KBs explicitly when the task calls for them. Reserve ambient mode for a corpus that genuinely belongs in every conversation (e.g. an internal product wiki). Ambient sources are snapshot-cached for 5 seconds (as scope-tagged descriptors, so the access filter still runs per call), so a toggle takes effect nearly immediately. KB pages never appear in the `list_documents` inventories — corpora are inspected via `list_knowledge_bases` instead.

### Retrieval confidence (CRAG)

When `retrieval.documentRag.confidenceDemotion` is enabled and engram reports low retrieval confidence for a query, `search_knowledge_base` appends a note telling the agent to treat the excerpts as possibly-relevant leads and verify against the cited pages; ambient injection frames its context block the same way. Confidence demotion never suppresses excerpts. Two other failure shapes are reported distinctly: an unreachable store returns an explicit "retrieval failed — this is NOT evidence the topic is absent" error, and zero hits over a healthy corpus suggests re-phrasing or widening the crawl.

## Worker (Per-KB Temporary Agent)

`search_knowledge_base` grounds *the current agent* in a KB. A **worker** goes one step further: it packages "how to use this KB for a task" as a per-KB template, so `use_knowledge_base` can spin up a single-use temporary agent purpose-configured for the corpus — rather than the orchestrator guessing which general specialist to route to. The template is stored on the KB record (`worker`) and is scoped exactly like the KB itself.

### `KbWorkerSpec`

Every field is optional; an empty spec normalizes to *no worker*.

| Field | Type | Notes |
| --- | --- | --- |
| `instructions` | string | System prompt for the worker — how to apply this KB to a task. Max 8000 characters. When unset, a built-in grounding prompt is used. |
| `tools` | string[] | Extra tools the worker gets **beyond** the always-granted KB retrieval tools. Max 20 entries; de-duplicated, and filtered to the ephemeral-agent grantable set at run time (unknown names are skipped and reported). |
| `model` | `{ primary?, temperature?, maxTokens? }` | Model hints for the run. `primary` must be an already-configured model id or it is ignored (no hallucinated model names). |
| `maxIterations` | number | Tool-call budget for the worker, clamped to 1–10 (default 6). |
| `timeoutMs` | number | Wall-clock budget for the run, clamped to 60000–600000 ms. |

A worker is reported as **configured** (`hasWorker: true`, shown as "custom template" in tool output) only when it has `instructions` or at least one `tool`. A spec carrying *only* `model`/`maxIterations`/`timeoutMs` still runs, but the KB is listed as using the default worker.

### `use_knowledge_base` (tier 1)

The agent tool that applies a KB to a task. Parameters: `knowledge_base` (id or exact name) and `task` (what to do — include any target URL/subject).

It resolves and access-checks the KB (an out-of-scope id returns the same not-found message as a missing one) and fails clearly if the KB has no indexed pages yet (still crawling, or empty). Then it instantiates the KB's worker as a single-use ephemeral agent — backed by `runEphemeralWorker()`, run **in-process** (containerization disabled) so gateway-bound tools (KB retrieval, web, browser) resolve — with these tools:

- **Always granted:** `search_knowledge_base`, `list_knowledge_bases` — so the worker can actually query the KB.
- **Plus** the template's `tools`, **or**, when the KB has no worker template, the default read-only web/site-inspection set: `web_fetch`, `browser_navigate`, `browser_snapshot`, `browser_axe_audit`, `lighthouse_audit` — so "evaluate site X against this KB" works out of the box.

The system prompt is the template's `instructions`, or a built-in prompt telling the worker to search the KB first, cite the source page URLs it returns, inspect any live target with its granted tools, and never invent findings. The KB id is appended so the worker knows what to pass to `search_knowledge_base`. The tool returns the grounded result and notes any requested tools that were not grantable.

There is **no REST route** for `use_knowledge_base` — it runs an agent, so it is chat/agent-driven only (there is no `/api/knowledge-bases/:id/use`).

### Worked example — an accessibility-audit worker

**1. Create a KB with a worker** (`create_knowledge_base`):

```json
{
  "name": "W3C Accessibility",
  "seed_urls": ["https://www.w3.org/WAI/WCAG22/"],
  "scope": "workspace",
  "worker_instructions": "Audit the target with browser_axe_audit, then map every violation to the relevant WCAG 2.2 success criterion by searching this knowledge base, and cite the W3C page URL for each finding. Be honest about anything you could not verify.",
  "worker_tools": ["browser_axe_audit", "browser_navigate"]
}
```

**2. Use it from chat** — "use w3c-accessibility to audit https://example.com". The orchestrator calls:

```json
{
  "knowledge_base": "w3c-accessibility",
  "task": "Audit https://example.com against WCAG 2.2 and cite the W3C pages."
}
```

That spins up the KB's worker granted `search_knowledge_base` + `list_knowledge_bases` (always) **plus** `browser_axe_audit` + `browser_navigate` (from the template), runs the axe audit, maps each violation back to the crawled WCAG docs, and returns findings that cite the W3C page URLs.

> The `create_knowledge_base` tool exposes only `worker_instructions` and `worker_tools`. The full `KbWorkerSpec` (including `model`, `maxIterations`, `timeoutMs`) is set by passing a `worker` object to the `POST`/`PATCH` REST routes; `worker: null` on `PATCH` clears the template.

## Configuration Reference — `retrieval.knowledgeBases.*`

This block holds the crawler's global safety rails; the per-KB bounds (`maxPages`, `maxDepth`, patterns) live on each KB record and are clamped to the caps here. Configuration is compiled from `config/**` + `workspace/**` shards (the `retrieval` block lives in `config/tooling/`) — edit the shard and run `pnpm sai config build`; never hand-edit `starlingai.json`.

| Key | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | Master switch for the KB surface (tools + routes). The hard dependency is `retrieval.documentRag.enabled` — with that off, KBs are inert regardless. |
| `userAgent` | `StarlingAI-KBCrawler/1.0` | User-Agent for crawl requests (sites use it for rate/robots policy). |
| `defaultMaxPages` | `150` | Default page budget for a KB when none is specified at creation. |
| `maxPagesCap` | `1000` | Hard cap on any KB's page budget (create/update requests are clamped). |
| `defaultMaxDepth` | `4` | Default link depth from the seed URLs (0 = seeds only). |
| `maxDepthCap` | `8` | Hard cap on any KB's link depth. |
| `concurrency` | `2` | Concurrent page fetches within one crawl (keep small — politeness). |
| `requestDelayMs` | `300` | Minimum interval between two requests to the SAME host. |
| `pageTimeoutMs` | `15000` | Per-page fetch timeout. |
| `maxPageBytes` | `2000000` | Pages larger than this are skipped (pre-checked via `Content-Length` when present). |
| `maxCrawlMs` | `1800000` | Wall-clock budget for one crawl run; the crawl stops gracefully (partial corpus is kept). |
| `maxConcurrentCrawls` | `2` | How many KBs may crawl at the same time in this process. |
| `allowPrivateHosts` | `false` | Allow crawling private/internal hosts (RFC1918, `*.internal` …). Off = the `web_fetch` SSRF guard applies per redirect hop. Turn on ONLY for instances that need to index an internal wiki and trust their operators. |

KB retrieval additionally uses the Document RAG knobs `retrieval.documentRag.retrievalTopK` (6), `candidateTopK` (30), `minRerankScore` (0), and the `confidenceDemotion` flag — see the doc-comments in `packages/core/src/config/schemas/retrieval.ts`.

## API Reference

### REST routes

All routes require a Bearer token; the mutating routes are **operator-only** via the declarative route policy. Full request/response shapes are in [docs/api.md](api.md#knowledge-bases).

All list/detail/lifecycle routes are additionally **access-filtered** to the caller's [scope](#scope); pass `?sessionId=` to act on session-scoped KBs.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/knowledge-bases` | list **accessible** KB summaries (each with `scope`, `ownerId?`, `hasWorker`) plus `{ enabled, ragConfigured }`; `?sessionId=` includes session KBs |
| `POST` | `/api/knowledge-bases` | create a KB; body `{ name, seedUrls, …, scope?, sessionId?, worker?, crawlNow? }` (crawl starts by default; `ownerId` comes from the token) → `201 { id, crawlStarted, crawlError? }` — operator |
| `GET` | `/api/knowledge-bases/:id` | detail: summary (incl. `scope`/`ownerId`/`hasWorker`) + robots/pattern fields + `worker` (spec or `null`), page list (≤1000, URL-sorted) with `pagesTruncated`, live `crawling` flag; `404` when not accessible |
| `PATCH` | `/api/knowledge-bases/:id` | update any create field except `id` (incl. `scope`, `sessionId`, `worker`; `worker: null` clears) → `{ knowledgeBase }`; `404` when not accessible — operator |
| `POST` | `/api/knowledge-bases/:id/crawl` | start a (re-)crawl → `{ id, crawlStarted: true }`; `409` when already crawling or the concurrent-crawl limit is hit; `404` when not accessible — operator |
| `POST` | `/api/knowledge-bases/:id/cancel` | request cancellation → `{ id, cancelRequested: true }`; `409` when no crawl is running; `404` when not accessible — operator |
| `DELETE` | `/api/knowledge-bases/:id` | delete the KB and its engram documents → `{ id, removed: true, documentsRemoved, documentsFailed }`; `404` when not accessible — operator |

Creation validation: `name` is required; `id` (optional, otherwise derived from the name) must be a slug (lowercase letters, digits, hyphens, max 63 chars); 1–20 http(s) seed URLs; include/exclude patterns must be valid regexes; `sameOriginOnly: false` requires non-empty `includePatterns`; `scope: "session"` requires a `sessionId` and `scope: "user"` requires an authenticated user (`ownerId`).

### Agent tools

| Tool | Tier | Purpose |
| --- | --- | --- |
| `list_knowledge_bases` | 0 (read-only) | List the KBs **you can access** with status/size, or pass `knowledge_base` for one KB's detail including live crawl progress and worker status — the polling surface. |
| `search_knowledge_base` | 0 (read-only) | Query one KB (`knowledge_base`, `query`, optional `top_k` ≤ 20); excerpts cite source page URLs. |
| `create_knowledge_base` | 1 (write) | Create a KB and start the background crawl (`name`, `seed_urls`, optional `description`, `id`, `max_pages`, `max_depth`, `include_patterns`, `exclude_patterns`, `scope`, `worker_instructions`, `worker_tools`). |
| `use_knowledge_base` | 1 (write) | Apply a KB to a task by spinning up its single-use [worker](#worker-per-kb-temporary-agent) agent (`knowledge_base`, `task`); the worker is granted the KB's retrieval tools plus its template tools (or the default web/site-inspection set) and returns a grounded, cited result. |
| `manage_knowledge_base` | 1 (write) | `action`: `recrawl` (refresh; unchanged pages skipped, removed pages pruned), `cancel` (stop a running crawl; indexed pages kept), `delete` (remove the KB and all its indexed pages). |

The read-only pair is always offered to the main agent (mirroring `search_documents`/`list_documents`); the write trio (`create`/`use`/`manage`) is part of the direct main toolset. Tools accept a KB **id or its exact name** (case-insensitive), and every tool [access-checks](#scope) the caller — an out-of-scope id returns the same not-found message as a missing one. `sameOriginOnly`, `respectRobots`, `ambientRetrieval`, and the full worker template (`model`/`maxIterations`/`timeoutMs`) are not settable from the tools — those are REST/dashboard-only; the create tool exposes `scope`, `worker_instructions`, and `worker_tools`.

## Operational Notes

- **Crawls run in-process** in the gateway as a fire-and-forget background task; there is no separate crawler service. Progress is persisted to the manifest at page granularity (throttled to ~2 s), which is what `GET /api/knowledge-bases/:id` and `list_knowledge_bases` report.
- **Crawls are idempotent.** Stable per-URL document ids + hash-skip mean a crash, restart, or overlap just costs re-fetches — never duplicate documents. A KB stuck in `crawling` after a gateway restart is normalized to `failed` with the error `crawl interrupted (process restarted) — start a re-crawl`; the fix is exactly that re-crawl.
- **Cancellation is cooperative and cross-process.** Cancel aborts the local run immediately and sets the `cancelRequested` flag in the record; a crawl owned by *another* process (e.g. a standalone scene worker) reads the flag at its next progress checkpoint and stops at the page boundary. Already-indexed pages are always kept.
- **Concurrency is capped per process** (`maxConcurrentCrawls`, default 2); starting a crawl beyond the cap — or a second crawl for the same KB — is rejected with a `409`/error rather than queued.
- **Delete is best-effort against engram.** Deleting a KB cancels any running crawl, hard-deletes each page document from engram, then drops the record. After **10 consecutive** engram delete failures it stops grinding (engram is clearly down), counts the rest as failed, and removes the record anyway — an unreachable engram must not make a KB undeletable. The response reports `documentsRemoved`/`documentsFailed`; orphaned chunks can be cleaned up later by an engram wipe.
- **Graceful degradation.** With `retrieval.knowledgeBases.enabled: false` or Document RAG disabled, every tool and crawl start returns a clear "disabled" error instead of failing obscurely; `GET /api/knowledge-bases` reports both flags (`enabled`, `ragConfigured`) so the dashboard can explain the state.
