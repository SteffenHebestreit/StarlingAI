# REST API, WebSocket, And Streaming

<p align="center">
  <img src="../assets/brand/swarmLogo.svg" alt="StarlingAI logo" width="180" />
</p>

The StarlingAI gateway exposes four externally useful surfaces for interacting with the agent swarm. These interfaces are domain-agnostic — they work the same way regardless of what kind of task the swarm is handling.

- REST endpoints under `/api/*`
- WebSocket RPC at `/ws`
- AG-UI token streaming at `/api/chat/stream`
- A2A JSON-RPC at `/a2a/agents/:name`

See also: [Security Model](security.md) · [Architecture & Design](architecture.md)

## Authentication

Most HTTP routes and the WebSocket upgrade require a JWT.

Recommended transport:

```http
Authorization: Bearer <token>
```

The WebSocket path also accepts a query token:

```text
ws://localhost:8765/ws?token=<jwt>
```

Generate tokens with:

```bash
pnpm token
pnpm sai token
```

Scene webhooks are the main exception: `POST /api/scenes/:name/run` can authenticate with either a Bearer token or the scene webhook secret via `?key=` or `X-Scene-Key`.

## Health And Status

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/healthz` | returns `{ "status": "ok" }` |
| `GET` | `/readyz` | returns readiness, active-session count, deployment-mode dependencies, latest event-loop lag, and in-flight provider activity (producing / prefill / stalled); clustered modes return `503` when Redis or PostgreSQL is unavailable |
| `GET` | `/api/status` | authenticated summary of uptime and active sessions |
| `GET` | `/api/runtime/status` | authenticated component health snapshot |
| `GET` | `/api/health/subsystems` | authenticated deep self-checks (embeddings, vector store, graph, telemetry, event loop, provider activity, and a sandbox canary: a `docker run` through shell_exec must hand back what it printed on stdout and on stderr, else `degraded`, never 503; a verdict serves 5 minutes, carries `checkedAt` and `ageMs` (its age on the gateway's clock), and is not re-measured while a turn is running); 503 if any subsystem is unavailable |
| `GET` | `/api/observability/recovery-nets` | authenticated firing counts per orchestration recovery net (which autopilots actually fire) |

## REST Endpoints

### Live App Proxy

| Method | Path | Notes |
| --- | --- | --- |
| `ANY` | `/api/app/:id/*` | reverse-proxy to a running `serve_app` container (auth: `?token=` once → cookie, or `Authorization: Bearer`) |
| `ANY` | `/api/app/:id` | redirects to `/api/app/:id/` (preserves `?token=`) |

The `backend_coder` agent builds a Node/Express app under `generated/<dir>` and launches it with the `serve_app` tool, which runs it as a dedicated container (`sai-app-<id>`) on the gateway's docker network (`SAI_APP_NETWORK`, default `starlingai-public`). The gateway forwards authenticated requests to the container by name and injects a `<base href="/api/app/<id>/">` into HTML so relative asset and `/api/...` URLs resolve under the subpath. The first navigation carries `?token=<jwt>`, mirrored into a path-scoped `HttpOnly` cookie so sub-resource requests authenticate. Static sites/decks do **not** use this — they are served by `/api/workspace/preview`. `serve_app` is Tier 3 (per-call approval); apps are in-process state and do not survive a gateway restart. Env: `SAI_APP_NODE_IMAGE` (default `node:22-alpine`), `SAI_APP_PORT` (3000), `SAI_APP_HEALTH_TIMEOUT_MS` (180000), `SAI_APP_MAX` (5).

### Sites

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/sites` | list redacted site credentials |
| `POST` | `/api/sites/:hostname` | create or update a dashboard-managed site |
| `DELETE` | `/api/sites/:hostname` | remove a dashboard-managed site |

Config-file sites are read-only from the dashboard API.

### Guardrails

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/guardrails` | current guardrail state |
| `PUT` | `/api/guardrails` | partial update |
| `POST` | `/api/guardrails/reset` | reset to config defaults |

### Model Presets

The dashboard "Local ⇄ Claude" switch. A preset is a named alternate for the
default chat model (`agents.defaults.modelPresets`); an implicit `claude`
preset (model `providers.anthropic.defaultModel`, default
`anthropic/claude-sonnet-4-6`) appears whenever Claude is usable — a config
`apiKey` (`sk-ant-api...`, pay-per-use) or `authToken` (`sk-ant-oat...`), **or**
a browser-connected subscription token (see Anthropic Subscription OAuth below).
While a preset is active the whole swarm — orchestrator and every sub-agent,
including agents with their own model override — runs on the preset model, the
previous primary becomes the failover fallback, the routing/synthesis tier
ladder is bypassed, and embeddings stay on the local provider. The choice
persists in the runtime overlay and is audit-logged as `model_preset_switched`.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/models/preset` | active preset, default model, and the switchable preset list |
| `POST` | `/api/models/preset` | body `{ "preset": "claude" }` to activate, `{ "preset": null }` to return to the local default |

### Anthropic Subscription OAuth

The "Connect Claude" browser-verification flow — the same PKCE login Claude
Code uses, producing a Claude Pro/Max **subscription** access+refresh token so
the swarm runs on Claude billed to the subscription instead of API pay-per-use.
The dashboard is the PKCE client: `start` returns the authorize URL plus the
verifier/state it holds; the operator authorizes on `claude.ai`, copies the
`code#state` the callback page shows, and `complete` exchanges it. The token
set is **encrypted at rest** in the gateway credential store
(`credentials/store.ts`), auto-refreshed, and sent only to Anthropic as the
`Authorization` header — never placed in a model prompt or sent to another
provider. Subscription tokens are Claude-Code-scoped, so the provider injects
the required Claude Code system identity as the first system block on each call.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/models/anthropic/oauth/status` | `{ connected, expiresAt }` |
| `POST` | `/api/models/anthropic/oauth/start` | returns `{ authorizeUrl, verifier, state }` (PKCE; dashboard holds verifier/state) |
| `POST` | `/api/models/anthropic/oauth/complete` | body `{ code, verifier, state }` → exchanges + stores the token set |
| `POST` | `/api/models/anthropic/oauth/disconnect` | clears the stored token; reverts an active `claude` preset to local |
| `GET` | `/api/models/anthropic/model` | current Claude model for the implicit preset + curated choices |
| `POST` | `/api/models/anthropic/model` | body `{ "model": "claude-opus-4-8" }` → sets `providers.anthropic.defaultModel` (free-text ids accepted); applies immediately |

> Using a subscription token from a third-party app is the operator's call —
> Anthropic intends these tokens for Claude Code. The API-key path
> (`providers.anthropic.apiKey`) is the officially-sanctioned alternative.
> Requires `SAI_MASTER_KEY` (the credential store's encryption key) to be set.

### Agents

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/agents` | list configured sub-agents |
| `GET` | `/api/agents/resolve` | route a natural-language query |
| `PATCH` | `/api/agents/:name/model` | set allowed model fields, saved to the config overlay; `null` clears one, and so does an empty `primary` |
| `GET` | `/api/agents/outcomes` | aggregate agent outcome statistics |

`GET /api/agents/resolve` query parameters:

| Param | Values |
| --- | --- |
| `query` | required free text |
| `minConfidence` | `high`, `medium`, or `low` |

Example response shape:

```json
{
  "query": "browser automation for login forms",
  "minConfidence": "medium",
  "mode": "hybrid",
  "results": [],
  "weakCandidates": [],
  "gated": false
}
```

### Scenes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/scenes` | list config and store scenes |
| `POST` | `/api/scenes/:name` | create or update a dashboard scene |
| `DELETE` | `/api/scenes/:name` | delete a dashboard scene |
| `POST` | `/api/scenes/:name/run` | trigger an async scene job |
| `GET` | `/api/scenes/jobs` | list recent scene jobs, optionally filtered by status |
| `GET` | `/api/scenes/jobs/:jobId` | poll a scene job |
| `POST` | `/api/scenes/jobs/:jobId/cancel` | cancel a queued or running scene job |

`POST /api/scenes/:name/run` returns immediately:

```json
{
  "ok": true,
  "sceneName": "apply_jobs",
  "jobId": "...",
  "sessionId": "...",
  "status": "queued"
}
```

Polling `GET /api/scenes/jobs/:jobId` returns the current job record:

```json
{
  "id": "...",
  "sceneName": "apply_jobs",
  "sessionId": "...",
  "createdAt": "2026-03-15T11:59:58.000Z",
  "status": "running",
  "startedAt": "2026-03-15T12:00:00.000Z",
  "completedAt": "2026-03-15T12:04:12.000Z",
  "response": "...",
  "toolCallsExecuted": 6,
  "blocked": false,
  "progress": {
    "stage": "tool",
    "message": "Completed tool web_search",
    "percent": 48,
    "toolCallsRequested": 4,
    "toolCallsCompleted": 3,
    "approvalsRequested": 0,
    "subAgentsStarted": 1,
    "swarmTasksTotal": 2,
    "swarmTasksCompleted": 1,
    "lastEventAt": "2026-03-15T12:01:40.000Z",
    "lastEventType": "tool_call_completed"
  },
  "performance": {},
  "error": "..."
}
```

`GET /api/scenes/jobs` returns recent jobs ordered by most recently updated first. Use `?limit=50` to cap the result set and `?status=running` to filter by a specific lifecycle state.

`POST /api/scenes/jobs/:jobId/cancel` returns the updated job record. Queued jobs become `cancelled` immediately. Running jobs enter `cancelling` until the worker aborts the turn and marks the job `cancelled`.

For split deployments, run a standalone worker with `pnpm --filter @starlingai/core worker:scene` and set `SAI_DISABLE_EMBEDDED_SCENE_WORKER=1` on the gateway process.

If a scene exceeds `gateway.turnTimeoutMs`, the job fails and its scene session is archived.

These scene-job records are runtime execution instances created by `/api/scenes/:name/run`. They are distinct from the reusable workflow `jobs` stored under `workspace/jobs`, which are discovered inside chat with `search_workflows` and executed via `run_workflow`.

### Approvals

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/approval/:approvalId` | one-click approve or deny HTML response |
| `POST` | `/api/approval/:approvalId` | programmatic approval callback |

Accepted POST forms:

```json
{ "approved": true, "secret": "..." }
```

or `Authorization: Bearer <secret>` with `{ "approved": true }`.

### Sessions And Exports

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/sessions/:sessionId/debug-markdown` | authenticated Markdown export with transcript, raw session history, and matching audit events |
| `GET` | `/api/sessions/:sessionId/audit-markdown` | authenticated Markdown export with focused audit evidence only |

The debug Markdown export is intended for operator review, incident handling, and release validation. It bundles:

- session metadata and the active system prompt
- the user-visible transcript, including tool-only assistant turns
- raw persisted session history with tool call ids and metadata
- audit events for the session and related sub-agent sessions

The audit-only Markdown export is the lighter-weight companion. It keeps the session metadata and matching audit events for the session plus related sub-agent and workflow sessions, but omits the transcript and raw-history sections.

### Channels

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/channels` | runtime status array for known channel types |
| `GET` | `/api/channels/dead-letters` | `{ count, entries }` |
| `GET` | `/api/channels/:type` | redacted effective config plus runtime status |
| `PUT` | `/api/channels/:type` | store override and reload runtime |
| `DELETE` | `/api/channels/:type` | remove store override and reload |

`GET /api/channels` currently returns an array, not a wrapped object:

```json
[
  {
    "type": "telegram",
    "enabled": false,
    "running": false,
    "supported": true,
    "reason": null,
    "error": null,
    "health": {
      "healthy": true,
      "latencyMs": 42,
      "checkedAt": "2026-03-15T12:00:00.000Z"
    },
    "metrics": {
      "delivered": 12,
      "deliveryFailures": 1,
      "ingressDenied": 0,
      "lastDeliveryError": "...",
      "lastIngressDeniedAt": "...",
      "deliveryLatency": {
        "sampleCount": 13,
        "lastMs": 184,
        "maxMs": 912,
        "p50Ms": 96,
        "p95Ms": 420,
        "p99Ms": 912
      },
      "deliverySlo": {
        "totalDeliveries": 13,
        "delivered": 12,
        "failed": 1,
        "successRatePct": 92.31
      },
      "deliveryWindows": {
        "last5m": {
          "windowMs": 300000,
          "totalDeliveries": 4,
          "delivered": 3,
          "failed": 1,
          "successRatePct": 75,
          "p95Ms": 420
        },
        "last1h": {
          "windowMs": 3600000,
          "totalDeliveries": 13,
          "delivered": 12,
          "failed": 1,
          "successRatePct": 92.31,
          "p95Ms": 420
        }
      }
    },
    "operatorState": {
      "severity": "warning",
      "summary": "Recent delivery failures require attention"
    }
  }
]
```

`GET /api/channels/:type` remains backward-compatible for dashboard config reads and now adds a `status` block:

```json
{
  "type": "slack",
  "source": "store",
  "config": {
    "enabled": true,
    "botToken": "••••••••"
  },
  "status": {
    "type": "slack",
    "enabled": true,
    "running": true,
    "supported": true,
    "health": {
      "healthy": true,
      "latencyMs": 41,
      "checkedAt": "2026-03-15T12:00:00.000Z"
    },
    "metrics": {
      "deliveryLatency": {
        "sampleCount": 13,
        "p50Ms": 96,
        "p95Ms": 420,
        "p99Ms": 912
      },
      "deliverySlo": {
        "totalDeliveries": 13,
        "successRatePct": 92.31
      }
    },
    "operatorState": {
      "severity": "warning",
      "summary": "1 delivery failure in the last 5 minutes"
    }
  },
  "operator": {
    "recentDeadLetters": [
      {
        "channel": "slack",
        "messagePreview": "hello",
        "error": "temporary failure",
        "attempts": 3,
        "ts": "2026-03-15T12:00:00.000Z"
      }
    ],
    "recoveryProcedures": [
      "Verify botToken and signingSecret are set and that Slack auth.test succeeds.",
      "If using Events API, confirm the public callback URL is reachable and still matches Slack app settings.",
      "If using Socket Mode, confirm appToken is present and reinstall the app after scope changes."
    ]
  }
}
```

### Knowledge Bases

Named corpora crawled from documentation sites into the engram document store, then queried by agents with citations — see [Knowledge Bases](knowledge-bases.md) for the crawler, storage, and retrieval model. All routes require a Bearer token; the mutating routes (`POST`, `PATCH`, `DELETE`) are **operator-only** via the route policy. Crawls run in the background — the create/crawl routes return immediately and clients poll `GET` for the progress persisted in the KB record.

Each KB has a **visibility scope** (`workspace` default, or `user`/`session` — see [Scope](knowledge-bases.md#scope)). The list and every `:id` route are **access-filtered** to the caller: workspace KBs are visible to all, user KBs to their owner (`ownerId`, taken from the token), and session KBs to the conversation that presents the owning `sessionId`. Pass `?sessionId=<id>` as a query param on the list/detail/lifecycle routes to act on session-scoped KBs. A KB the caller cannot access returns `404` (the same shape as a missing one — no existence disclosure). Under multi-user auth a `sessionId`, in the query or in a `POST`/`PATCH` body, must name a session the caller may use, as on `/api/sessions/:sessionId`; another account's session gets `404` with `Session not found`. The `/api/documents` routes apply the same rule to their `sessionId`.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/knowledge-bases` | accessible KBs → `{ knowledgeBases: [summary], enabled, ragConfigured }`; `?sessionId=` includes session KBs |
| `POST` | `/api/knowledge-bases` | create (and by default start crawling) a KB → `201`; body may set `scope`/`sessionId`/`worker` (`ownerId` comes from the token) |
| `GET` | `/api/knowledge-bases/:id` | detail (incl. `scope`/`ownerId`/`hasWorker`/`worker`) + page list (≤1000, URL-sorted) + live `crawling` flag; `404` when not accessible |
| `PATCH` | `/api/knowledge-bases/:id` | update any create field except `id` (incl. `scope`/`sessionId`/`worker`) → `{ knowledgeBase }`; `404` when not accessible |
| `POST` | `/api/knowledge-bases/:id/crawl` | start a (re-)crawl → `{ id, crawlStarted: true }`; `409` if one is already running or the concurrent-crawl limit is hit; `404` when not accessible |
| `POST` | `/api/knowledge-bases/:id/cancel` | request cooperative cancellation → `{ id, cancelRequested: true }`; `409` when no crawl is running; `404` when not accessible |
| `DELETE` | `/api/knowledge-bases/:id` | delete the KB and its engram documents → `{ id, removed: true, documentsRemoved, documentsFailed }`; `404` when not accessible |

`POST /api/knowledge-bases` accepts:

```json
{
  "name": "W3C Accessibility Docs",
  "seedUrls": ["https://www.w3.org/WAI/WCAG22/"],
  "id": "optional-slug",
  "description": "optional",
  "maxPages": 150,
  "maxDepth": 4,
  "includePatterns": ["optional regexes that widen the seed-path scope"],
  "excludePatterns": ["optional regexes that veto URLs"],
  "sameOriginOnly": true,
  "respectRobots": true,
  "ambientRetrieval": false,
  "scope": "workspace",
  "sessionId": "required only for scope=session",
  "worker": {
    "instructions": "how the worker applies this KB to a task",
    "tools": ["browser_axe_audit", "browser_navigate"],
    "model": { "primary": "optional-configured-model-id", "temperature": 0.1, "maxTokens": 6144 },
    "maxIterations": 6,
    "timeoutMs": 300000
  },
  "crawlNow": true
}
```

and returns `201` with `{ "id": "w3c-accessibility-docs", "crawlStarted": true }` (plus `crawlError` when the KB was created but the crawl could not start). `scope` is one of `session`/`user`/`workspace` (default `workspace`); `ownerId` is **always** taken from the auth token, never the body. `worker` is the [`KbWorkerSpec`](knowledge-bases.md#kbworkerspec) — all fields optional (`instructions` ≤ 8000 chars, `tools` ≤ 20, `maxIterations` clamped 1–10, `timeoutMs` clamped 60000–600000); on `PATCH`, `worker: null` clears the template. Validation errors return `400 { "error": "..." }`: `name` and 1–20 http(s) `seedUrls` are required, `id` must be a slug (lowercase letters, digits, hyphens, max 63 chars), patterns must be valid regexes, `sameOriginOnly: false` requires non-empty `includePatterns`, `scope: "session"` requires a `sessionId`, and `scope: "user"` requires an authenticated user. `maxPages`/`maxDepth` are clamped to the `retrieval.knowledgeBases` caps.

Each summary carries `id`, `name`, `description?`, `seedUrls`, `status` (`idle` | `crawling` | `ready` | `failed`), `ambientRetrieval`, `scope` (`session` | `user` | `workspace`), `ownerId?`, `hasWorker`, `pageCount`, `chunkCount`, `maxPages`, `maxDepth`, `createdAt`, `updatedAt`, and `lastCrawl?` (the crawl-stats object with `pagesVisited` / `pagesIngested` / `pagesSkippedUnchanged` / `pagesFailed`, plus `currentUrl` and `queueRemaining` while running and `stopReason` / `error` when finished). The detail route adds `includePatterns`, `excludePatterns`, `sameOriginOnly`, `respectRobots`, `createdBy`, `worker` (the full `KbWorkerSpec` or `null`), the `pages` array (`{ url, title, chunkCount, lastIngestedAt }`), and `pagesTruncated`.

### Multimodal

These authenticated routes provide the backend bridge for the multimodal stack used here: `fastapi_mcp_template` for file and image ingestion, Qwen3-ASR for speech-to-text, browser-side wake listening modeled after `wake-word-detection`, and `tts-stt-playground` for Qwen3-TTS speech synthesis and cloning.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/multimodal/status` | upstream health plus wake-word defaults |
| `GET` | `/api/multimodal/config` | resolved multimodal config currently active in the gateway |
| `PUT` | `/api/multimodal/config` | persist multimodal config to the writable runtime config |
| `POST` | `/api/multimodal/file-to-markdown` | multipart upload, proxies to `file_to_markdown` |
| `POST` | `/api/multimodal/transcribe` | multipart upload, proxies to `/v1/audio/transcriptions` |
| `GET` | `/api/multimodal/voices` | proxy to the configured TTS voice list |
| `POST` | `/api/multimodal/tts` | JSON request, returns `audio/wav` |

`GET /api/multimodal/config` returns the fully resolved `multimodal` section from the active runtime config.

`PUT /api/multimodal/config` expects the full `multimodal` object and writes it back to the active writable config target. In local development that is typically `starlingai.json`; in Docker Compose it defaults to `/data/starlingai.runtime.json` layered on top of the read-only base config. The saved object includes:

- `maxUploadBytes`
- `files.baseUrl`, `files.apiKey`, `files.timeoutMs`, `files.toolName`
- `stt.baseUrl`, `stt.apiKey`, `stt.timeoutMs`, `stt.model`
- `tts.baseUrl`, `tts.apiKey`, `tts.timeoutMs`, `tts.model`, `tts.defaultLanguage`, `tts.defaultSpeaker`, `tts.defaultVoiceId`, `tts.voiceSamplePath`, `tts.voiceSampleText`, `tts.defaultQuality`
- `wakeWord.enabled`, `wakeWord.language`, `wakeWord.keywords`, `wakeWord.stopPhrases`, `wakeWord.silenceTimeoutMs`

`POST /api/multimodal/file-to-markdown` expects multipart form data with a `file` part and returns the upstream converter payload, typically including `success`, `filename`, `title`, and `markdown`.

`POST /api/multimodal/transcribe` accepts:

```text
file: <audio file>
language: optional
prompt: optional
model: optional
```

and returns a normalized payload:

```json
{
  "text": "transcribed speech",
  "language": "en",
  "duration": 1.2
}
```

`POST /api/multimodal/tts` accepts a Qwen3-compatible JSON body:

```json
{
  "text": "Hello from StarlingAI",
  "language": "English",
  "speaker": "Vivian",
  "voiceId": "optional-saved-voice-id",
  "audioExamplePath": "samples/assistant-voice.wav",
  "referenceText": "Hello from the reference speaker",
  "saveVoiceAs": "optional-voice-cache-name"
}
```

When `voiceId` is present, the gateway uses Qwen3-TTS's fast saved-voice route. When `audioExamplePath` is present, the gateway reads that workspace audio file and calls Qwen3's cloning endpoint, using `referenceText` when provided for higher quality.

The response body is raw WAV audio.

### Chat

`POST /api/chat` is **not implemented** and always returns `501` (after authenticating) — a turn is inherently streaming, so there is no useful synchronous response shape. Use `POST /api/chat/stream` (AG-UI SSE, below) or the WebSocket RPC channel instead. The endpoint is kept so integrators hitting the obvious path get a pointer rather than a `404`.

## WebSocket RPC

Connect to:

```text
ws://localhost:8765/ws?token=<jwt>
```

After auth, the server sends `hello-ok`.

Request shape:

```json
{ "id": "req-1", "method": "session.create", "params": { "channel": "webchat" } }
```

Response shape:

```json
{ "type": "rpc.response", "id": "req-1", "ok": true, "payload": { "sessionId": "..." } }
```

Supported RPC methods:

| Method | Params |
| --- | --- |
| `gateway.status` | `{ requestId? }` |
| `session.create` | `{ channel, userId?, workspacePath? }` |
| `session.end` | `{ sessionId? }` |
| `session.get` | `{ sessionId?, limit?, beforeMessageId? }` |
| `session.list` | none |
| `session.archive` | `{ sessionId? }` |
| `session.delete` | `{ sessionId? }` |
| `session.reset` | `{ sessionId? }` |
| `session.rewind` | `{ sessionId?, historyIndex }` |
| `session.updateSettings` | `{ sessionId?, effort?, turnTimeoutSec?, imageSettingsPrompt? }` |
| `scenes.list` | none |
| `approval.respond` | `{ approvalId, approved }` |
| `input.respond` | `{ inputId, answer }` |
| `userInput.respond` | `{ inputId, answer }` |
| `userInput.hold` | `{ inputId }` |
| `userInput.preview` | `{ inputId, candidateId }` |
| `chat.send` | `{ sessionId, message, requestId?, enableThinking?, effort? }` |
| `chat.cancel` | `{ requestId }` |
| `audit.subscribe` | none |

`gateway.status` with a `requestId` adds `{ requestId, activeTurn }`: whether that turn is running in this process, for any session the connection may use, not only a turn this connection started.

`chat.send` also supports chat-triggered scenes via `/run <sceneName> key=value ...`, and inline override flags in the `message`: `--auto`, `--iter N`, `--agent NAME`, `--timeout N`, and `--effort low|medium|high|max` (a one-off effort tier for that message).

`--agent NAME` hands the turn to that agent: the turn delegates to it before it answers. A name that is neither a configured nor a promoted agent starts no turn; the reply is `accepted: false`, with a `blocked` status whose `response` names the agent. A deployment with no agents at all checks no name, as `delegate_to_agent` does.

`chat.send` answers once the turn has started; the turn itself reports through the events below. The reply:

```json
{
  "accepted": true,
  "requestId": "req-7f4",
  "unreadSteering": [
    { "id": "steer-blue-01", "text": "make it blue", "requestId": "req-7f3" }
  ]
}
```

- `accepted` is `false` when nothing was started: a message that is empty once the flags are stripped, an unknown `/run` scene, or a `/job` that is unknown or could not be queued. A `status` event says why. `/job <name>` answers `{ accepted: true, queued: true, requestId, jobId }`. `/jobs` and `/job help` answer in a `status` event and start no turn.
- `unreadSteering` is present only when this start retired steering messages that earlier turns of the session never read (see [Mid-turn steering](#mid-turn-steering)), and only for the session owner or an admin. It has the same shape as in `session.get`. The web stops a turn with `chat.cancel` and only then sends the next message; a stopped turn that finished unwinding in between would otherwise have its leftovers dropped by this start without anyone seeing them.
- A turn already running on the session is superseded, whichever connection started it: it is aborted and reports its own leftovers on its own final `status`. The new turn runs alone on the history.
- A `requestId` that a running turn still uses is refused with the RPC error `requestId <id> is already in use by a running turn`, before anything is sent under it.
- A `requestId` must be 1 to 64 characters of `A-Za-z0-9_-`, as every history message of the turn is saved with it. Any other is refused with the RPC error `requestId must be 1 to 64 characters of A-Za-z0-9_-`, and no turn starts. Without one, the gateway picks one.

`chat.cancel` stops a turn by its request id and answers `{ cancelled, requestId, known }`. It reaches any turn in a session the caller may stop (its owner or an admin, as for `POST /api/sessions/:sessionId/stop`), not only a turn this connection started: a reloaded page still follows its turn by request id. `cancelled` says whether this call stopped the turn. `known` says whether this process runs the turn or ended it within the last ten minutes (at most 1,000 ended turns are remembered), for a caller who may stop it. `cancelled: false, known: true` means the turn was already stopped or is over; only `known: false` calls for stopping the session some other way. A Stop also settles the turn's open questions at once.

`session.rewind` truncates the raw session history before `historyIndex`: entries `0 … historyIndex-1` stay. It answers `{ rewound: true, historyIndex }`. An index at or past the end removes nothing. A negative or non-integer index is an RPC error. It drops the session's `unreadSteering` only when it actually removed something.

`session.updateSettings` persists per-session controls: `effort` (`low|medium|high|max`, or `null`/`"default"` to clear → inherit the global default), `turnTimeoutSec` (independent time-limit override; `0` = unlimited, `null`/`""` to clear) and `imageSettingsPrompt` (`"auto"`: `generate_image` stops asking for render settings in this chat; `"ask"`, `null`, `""` or `"default"`: it asks, the default; anything else is an RPC error). It returns `{ settings }` in the shape `session.get` shows, with the defaults filled in. The active effort tier bundles the orchestration/latency/reasoning knobs into a profile (see the Effort tiers section of the README); the global default lives at `effort.default` and is editable via `GET`/`PUT /api/effort/config`.

`session.list` returns session summaries for both active and archived sessions. `session.get` supports optional transcript paging with `limit` and `beforeMessageId`. When `limit` is omitted, the full transcript is returned. With `limit`, the response returns the newest page before the optional cursor.

`session.get` returns:

```json
{
  "session": {
    "id": "...",
    "channel": "webchat",
    "createdAt": "2026-03-15T11:00:00.000Z",
    "updatedAt": "2026-03-15T11:10:00.000Z",
    "archivedAt": null,
    "turns": 4,
    "messageCount": 8,
    "lastMessageAt": "2026-03-15T11:09:58.000Z",
    "preview": "Latest assistant or user text snippet"
  },
  "transcript": [
    {
      "id": "session:0",
      "role": "user",
      "content": "hello",
      "timestamp": "2026-03-15T11:00:01.000Z",
      "requestId": "req-7f4"
    }
  ],
  "totalMessages": 8,
  "nextBeforeMessageId": "session:0",
  "settings": { "effort": "medium", "imageSettingsPrompt": "ask" },
  "activeTurn": true,
  "activeTurnRequestId": "req-7f4",
  "activeTurnStartedAt": 1790153205322,
  "openUserInputs": [],
  "unreadSteering": [
    { "id": "steer-blue-01", "text": "make it blue", "requestId": "req-7f3" }
  ],
  "serverNow": 1790153290114
}
```

`settings` carries the per-session effort tier (and any `turnTimeoutSecOverride`) and `imageSettingsPrompt`; `effort` falls back to the global `effort.default` when the session has none set, and `imageSettingsPrompt` to `"ask"`.

A transcript entry of a turn started by `chat.send` carries that turn's `requestId`: its opening message, every assistant entry, and each message sent into it while it ran (`midTurn: true`), which names the turn that read it. The id is saved with the history, so it survives a restart. Entries of other turns (AG-UI, jobs, channels) and of history saved before the field existed have none. Assistant entries of two different turns are never merged into one, so a stopped turn that writes after its replacement has started keeps its own entry.

The rest lets a page reloaded mid-turn, or a second tab, pick the turn up:

- `activeTurn` is `true` while any turn holds the session, including one started over AG-UI and one that was stopped and is still unwinding.
- `activeTurnRequestId` and `activeTurnStartedAt` (epoch ms) name the running turn when it is a WebSocket turn of this process that has not been stopped. The page can steer it or stop it with `chat.cancel`; a `chat.send` it makes anyway supersedes it.
- `openUserInputs` lists the session's open structured questions (see [Structured user input](#structured-user-input)) that the caller may answer, each in the `agent.user_input_needed` shape. It is `[]` for anyone else.
- `unreadSteering` is present only when it is not empty, and only for the session owner or an admin, since these are the person's own words. It lists steering messages that finished turns never read and whose final `status` found the connection that started them gone, each naming that turn as `requestId`. They are kept for at most an hour. The next `chat.send` of the session hands them back and retires them, and a reset, a delete or a rewind that removes something drops them. A turn still running then does not add the messages queued before it (see [Mid-turn steering](#mid-turn-steering)).
- `serverNow` is the gateway clock (epoch ms) at the answer. The `expiresAt` deadlines of `openUserInputs` are server times, and the page needs the skew to count them down.

For the owner or an admin, `session.get` also subscribes the connection to the session's `agent.user_input_needed`, `agent.user_input_resolved` and `agent.unread_steering` events. A turn's other events go only to the connection that started it.

`session.end` remains accepted for backward compatibility and now archives the session instead of deleting it. Use `session.delete` to permanently remove stored session state.

### Streaming Events

During `chat.send`, the gateway emits streamed events:

| Event | Notes |
| --- | --- |
| `status` | `accepted`, `ok`, `blocked`, or `error` |
| `agent.chunk` | token or chunk text |
| `agent.tool_start` | tool name and args |
| `agent.tool_done` | tool name and truncated result |
| `agent.swarm` | live swarm state snapshot |
| `agent.approval_needed` | approval id, tool name, and args |
| `agent.input_needed` | an `ask_user` question: `{ requestId, inputId, question, choices, timeoutMs, expiresAt }`, answered with `input.respond` |
| `agent.steering_consumed` | the turn read queued steering messages (see [Mid-turn steering](#mid-turn-steering)) |
| `agent.user_input_needed` | a structured question from a tool (see [Structured user input](#structured-user-input)) |
| `agent.user_input_resolved` | that question was answered, expired or settled |
| `agent.unread_steering` | a finished turn's unread steering messages, pushed to the session's open pages |
| `audit.event` | only after `audit.subscribe` |

Final `status` payloads can include:

- `response`
- `toolCallsExecuted`
- `guardrailEvents`
- `usage`
- `swarmState`
- `performance`
- `error`
- `unconsumedSteering`: `[{ id, text }]`, the steering messages the turn never read
- `finishReason`: `"timeout"` on the answer delivered for a turn that ran out of time

When a turn exceeds its time limit, the gateway parks the session (the next message continues it) and delivers the best answer it can recover as `status: "ok"` with `finishReason: "timeout"`. When it cannot recover one, it sends an `error` status saying the session is parked.

`input.respond` answers `{ ok: true }`, or `{ ok: false, errors: [{ "field": "inputId", "message": "expired" }] }` when this connection has no such open question, for example because it timed out. `ask_user` questions belong to the connection that started the turn. They are settled with an empty answer when the turn is stopped or times out, or when that connection closes.

### Mid-turn steering

A message sent while a turn runs is folded into that turn at its next safe point instead of starting a new one. It is sent with `POST /api/sessions/:sessionId/steer` and a body of `{ message, clientMessageId?, requestId? }`. The reply `{ steered, active, id? }` says whether the message was queued. `id` is the `clientMessageId` when that has the accepted shape (8 to 64 of `A-Za-z0-9_-`), and a server id otherwise. A retry with the same id is queued once.

`requestId` names the `chat.send` turn the message was typed into, and only that turn takes it. When another turn holds the session, or none does, nothing is queued and the reply (HTTP 200) is:

```json
{
  "steered": false,
  "active": true,
  "activeTurnRequestId": "req-7f4",
  "replaced": true,
  "replacedBy": "req-7f4",
  "error": "The turn this was typed into has ended."
}
```

`active` says whether any turn holds the session, and `activeTurnRequestId` names the running turn as `session.get` does. `replaced` says another turn took the session from the turn the message was typed into, and `replacedBy` names it when it was a `chat.send` turn, for example a send from another tab (a job or an AG-UI turn has no id to name, so it gives `replaced` alone). Both are absent when that turn simply ended, and both stay set after the replacing turn has ended too, so a client can tell a replaced turn from an ended one when `active` is `false`. Both are kept per session: request ids are the client's, and one session's id never names another session's turn. The server remembers the last 1,000 replacements across all sessions; past that, an older replaced turn reads as one that ended. A turn that was stopped and is still unwinding still takes a message that names it, though `session.get` no longer names that turn; what it does not read comes back on its final `status`. Without `requestId`, the message goes to whichever turn holds the session.

When the turn reads queued messages, the connection that started it gets:

```json
{
  "type": "agent.steering_consumed",
  "data": {
    "requestId": "req-7f3",
    "iteration": 2,
    "at": "2026-09-24T10:15:02.114Z",
    "discardedDraft": false,
    "messages": [{ "id": "steer-blue-01", "text": "make it blue" }],
    "segmentText": "Found three candidates, checking prices next."
  }
}
```

`segmentText` is the text the transcript keeps for the part of the answer before this cut, or `""` when that part wrote none. Like the transcript, it passes over an entry another turn wrote, such as the late write of a turn this one replaced. A live view splits the answer there, so it matches what a reload shows.

Messages the turn never read ride its final `status` as `unconsumedSteering`, and the client sends them on as the next turn. When that status cannot be delivered because the connection that started the turn is gone, the session keeps them. `session.get` lists them as `unreadSteering`, the next `chat.send` reply hands them back, and they are pushed at once to the session's open connections:

```json
{
  "type": "agent.unread_steering",
  "data": {
    "sessionId": "...",
    "messages": [{ "id": "steer-blue-01", "text": "make it blue", "requestId": "req-7f3" }]
  }
}
```

The push covers a stopped turn that is slow to notice its Stop and finishes unwinding after the next `chat.send` has started. Neither `session.get` nor that send's reply saw its leftovers then. It reaches the connections that loaded the session with `session.get` or started an interactive (not `--auto`) turn on it, and only those of the session owner or an admin (anyone's, for a session with no owner). Each message names, as `requestId`, the turn that ended without reading it. One message can arrive by more than one of these routes, so clients drop repeats by `id`.

A reset, a delete or a rewind that removes something does not stop a running turn, and leaves what it has queued alone: the turn still folds those messages in, and its final `status` still lists the ones it did not read, for the connection that started it. When that status cannot be delivered, the session neither keeps nor pushes a message queued before the reset, delete or rewind, as the history it belongs to is gone. The rule is per message: one steered into the turn afterwards is kept and pushed like any other.

### Structured user input

A tool at any depth, including a specialist several delegations down, can ask the person behind an interactive turn (not `--auto`) a question with a typed answer. The question belongs to the turn, not to the socket. It stays open across a reload until its own deadline, and any connection of the session owner or an admin can answer it. The turn's end, a Stop, a supersede or the watchdog settle it. While it is open, the turn's clocks hold, the gateway watchdog included, and the waited time is credited back.

- `agent.user_input_needed`: `{ requestId, sessionId, inputId, kind, title, toolCallId?, sourceAgent?, payload, timeoutMs, expiresAt }`. `kind` picks the card the client renders, for example `image_settings`, and `payload` is that card's JSON. `session.get` lists the open ones as `openUserInputs`.
- `agent.user_input_resolved`: `{ requestId, sessionId, inputId, outcome, reason?, summary? }`.
  - `outcome` is `configured`, `auto` or `cancelled`.
  - `reason` is one of `user`, `timeout`, `session_preference`, `no_channel`, `turn_aborted`, `user_skipped` or `disconnected_expired`.
- `userInput.respond` `{ inputId, answer }` answers `{ ok: true }` or `{ ok: false, errors: [{ field, message }] }`.
  - A rejected answer leaves the question open to be corrected.
  - `answer` is JSON. It is size-capped (64 KiB by default; the asking tool sets its own cap) and passes the input guardrail before the tool's own validator.
  - An unknown or expired `inputId`, and one the caller may not answer, both get `[{ "field": "inputId", "message": "expired" }]`.
- `userInput.hold` `{ inputId }` answers `{ expiresAt }` when the person opens the full form. The deadline moves to the question's configure window from now, never past the first window plus one configure window. Otherwise it fails with the RPC error `User input request not found or expired`.
- `userInput.preview` `{ inputId, candidateId }` answers `{ dataUrl, width, height }`, a full-size view of something the payload offered, resolved by the asking tool itself. Otherwise it fails with the RPC error `Preview not available`.

## AG-UI Streaming

The SSE endpoint is:

```http
POST /api/chat/stream
Authorization: Bearer <token>
Content-Type: application/json
```

Body:

```json
{ "sessionId": "...", "message": "Summarise the quarterly report" }
```

`sessionId` is optional. An id no session has starts a new session under that id, owned by the caller, so a client may pre-generate one (a UUID, say). Under multi-user auth a session another account owns gets `404`. So does an id no session has unless it is 1 to 128 letters, digits, `_` or `-` (a UUID is fine). An id with a colon is read as naming another session: one in a namespace the system mints ids in for runs no chat started (`sub:`, `workflow:`, `a2a-in:`, `a2a-out:`, `a2a:`, `mcp:`, `fed:`, `eval:`, `eval-judge:`, `scene-eval:`, `selfimprove:`, `job:`), whose shared facts live under its id, and one ending in `:ephemeral`, whose sub-agent runs resolve to the session named before it.

It emits the same logical event types used by the WebSocket flow.

In addition to the normal text and tool events, the stream can emit:

| Event | Meaning |
| --- | --- |
| `OPERATOR_INTERVENTION` | runtime guidance telling the client that the user can stop the current run, start a fresh session, or ask for approval to stop a stuck external process |

Example payload:

```json
{
  "type": "OPERATOR_INTERVENTION",
  "runId": "...",
  "notice": {
    "reasonCode": "network_failure",
    "severity": "warn",
    "summary": "web_fetch hit a network or service failure",
    "detail": "You can stop this run, start a new one, or ask the agent to stop and restart the affected process with approval.",
    "toolName": "web_fetch",
    "actions": [
      { "kind": "stop_turn", "label": "Stop this run" },
      { "kind": "new_session", "label": "Start a new session" },
      {
        "kind": "request_approval",
        "label": "Ask the agent to stop it with approval",
        "prompt": "Stop the current external process or stuck task. Ask for approval before taking any destructive action."
      }
    ]
  }
}
```

## A2A JSON-RPC

Endpoint:

```http
POST /a2a/agents/:name
Authorization: Bearer <token>
Content-Type: application/json
```

The current method name is `tasks/send`.

Request:

```json
{
  "jsonrpc": "2.0",
  "id": "call-1",
  "method": "tasks/send",
  "params": {
    "task": "Summarise the following text",
    "context": "optional extra context",
    "sessionId": "optional-session-id"
  }
}
```

`sessionId` names the session the run works in: the run reads and writes that session's shared facts, peer messages and checkpoints. Leave it out and the run gets a new session of its own. With auth off the id is used as given, so it can name a chat session. Under multi-user auth (`auth.enabled`) it names a session in the caller's own namespace instead, derived from the caller's account and the id: the same id from the same account reaches the same session on this route and on `tasks/send` at `/a2a/v1`, and it never joins an existing chat session, the caller's own included. The response does not carry the session id.

Under multi-user auth the task also runs as the account the token names, with the workspace root and memory that account's chat runs have. A signed token whose account has been removed gets `401`, as on `/api`.

Response:

```json
{
  "jsonrpc": "2.0",
  "id": "call-1",
  "result": {
    "output": "...",
    "agentName": "summarizer"
  }
}
```

Calling any other method returns `-32601` with `Method not found — use tasks/send`.

### Public A2A surface

`POST /a2a/v1` (JSON-RPC `tasks/send`, `tasks/get`) and its agent card at `GET /.well-known/agent-card.json` are served when `a2a.enabled` is set. The JSON-RPC endpoint takes the shared `a2a.inboundBearerToken` when one is configured, and otherwise a gateway token (or, with OIDC A2A on, a peer's token from the identity provider). Under multi-user auth a gateway token whose account has been removed gets `401`, as on `/api`, and a `tasks/send` task runs as the account the token names, with the workspace root and memory that account's chat runs have. A caller with the shared bearer or an OIDC peer's token is no account of this deployment, and its task runs in the shared workspace root.

## MCP server

`/mcp` serves the MCP streamable HTTP transport when `mcp.expose.enabled` and `mcp.expose.http.enabled` are set. With `mcp.expose.http.requireAuth` (the default) it takes a gateway token, in the `Authorization` header or a `?token=` query parameter. Under multi-user auth the token's account is looked up on every request, as on `/api`: a token whose account has been removed gets `401`, and a caller has the role its account has now, not the one the token was signed with. Calls run as that account, with the workspace root and memory its chat runs have. An `mcp-session-id` is served only to the account that opened the session; any other caller gets `404` with `Unknown MCP session`, the reply an unknown id gets. With `requireAuth` off every caller is anonymous, with the operator role, and its calls run in the shared workspace root.
