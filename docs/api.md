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
| `GET` | `/readyz` | returns readiness, active-session count, latest event-loop lag, and in-flight provider activity (producing / prefill / stalled) |
| `GET` | `/api/status` | authenticated summary of uptime and active sessions |
| `GET` | `/api/runtime/status` | authenticated component health snapshot |
| `GET` | `/api/health/subsystems` | authenticated deep self-checks (embeddings, vector store, graph, telemetry, event loop, provider activity); 503 if any subsystem is unavailable |
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
| `PATCH` | `/api/agents/:name/model` | hot-patch allowed model fields |
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

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/knowledge-bases` | `{ knowledgeBases: [summary], enabled, ragConfigured }` |
| `POST` | `/api/knowledge-bases` | create (and by default start crawling) a KB → `201` |
| `GET` | `/api/knowledge-bases/:id` | detail + page list (≤1000, URL-sorted) + live `crawling` flag |
| `PATCH` | `/api/knowledge-bases/:id` | update any create field except `id` → `{ knowledgeBase }` |
| `POST` | `/api/knowledge-bases/:id/crawl` | start a (re-)crawl → `{ id, crawlStarted: true }`; `409` if one is already running or the concurrent-crawl limit is hit |
| `POST` | `/api/knowledge-bases/:id/cancel` | request cooperative cancellation → `{ id, cancelRequested: true }`; `409` when no crawl is running |
| `DELETE` | `/api/knowledge-bases/:id` | delete the KB and its engram documents → `{ id, removed: true, documentsRemoved, documentsFailed }` |

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
  "crawlNow": true
}
```

and returns `201` with `{ "id": "w3c-accessibility-docs", "crawlStarted": true }` (plus `crawlError` when the KB was created but the crawl could not start). Validation errors return `400 { "error": "..." }`: `name` and 1–20 http(s) `seedUrls` are required, `id` must be a slug (lowercase letters, digits, hyphens, max 63 chars), patterns must be valid regexes, and `sameOriginOnly: false` requires non-empty `includePatterns`. `maxPages`/`maxDepth` are clamped to the `retrieval.knowledgeBases` caps.

Each summary carries `id`, `name`, `description?`, `seedUrls`, `status` (`idle` | `crawling` | `ready` | `failed`), `ambientRetrieval`, `pageCount`, `chunkCount`, `maxPages`, `maxDepth`, `createdAt`, `updatedAt`, and `lastCrawl?` (the crawl-stats object with `pagesVisited` / `pagesIngested` / `pagesSkippedUnchanged` / `pagesFailed`, plus `currentUrl` and `queueRemaining` while running and `stopReason` / `error` when finished). The detail route adds `includePatterns`, `excludePatterns`, `sameOriginOnly`, `respectRobots`, `createdBy`, the `pages` array (`{ url, title, chunkCount, lastIngestedAt }`), and `pagesTruncated`.

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

`POST /api/chat` exists for future simple integrations but currently returns `501` with `Use WebSocket for chat. REST chat coming in v0.2.`

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
| `gateway.status` | none |
| `session.create` | `{ channel, userId?, workspacePath? }` |
| `session.end` | `{ sessionId? }` |
| `session.get` | `{ sessionId?, limit?, beforeMessageId? }` |
| `session.list` | none |
| `session.archive` | `{ sessionId? }` |
| `session.delete` | `{ sessionId? }` |
| `session.reset` | `{ sessionId? }` |
| `session.updateSettings` | `{ sessionId?, effort?, turnTimeoutSec? }` |
| `scenes.list` | none |
| `approval.respond` | `{ approvalId, approved }` |
| `chat.send` | `{ sessionId, message, requestId?, enableThinking?, effort? }` |
| `audit.subscribe` | none |

`chat.send` also supports chat-triggered scenes via `/run <sceneName> key=value ...`, and inline override flags in the `message`: `--auto`, `--iter N`, `--agent NAME`, `--timeout N`, and `--effort low|medium|high|max` (a one-off effort tier for that message).

`session.updateSettings` persists per-session controls: `effort` (`low|medium|high|max`, or `null`/`"default"` to clear → inherit the global default) and `turnTimeoutSec` (independent time-limit override; `0` = unlimited, `null`/`""` to clear). It returns `{ settings }`. The active effort tier bundles the orchestration/latency/reasoning knobs into a profile (see the Effort tiers section of the README); the global default lives at `effort.default` and is editable via `GET`/`PUT /api/effort/config`.

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
      "timestamp": "2026-03-15T11:00:01.000Z"
    }
  ],
  "totalMessages": 8,
  "nextBeforeMessageId": "session:0",
  "settings": { "effort": "medium" }
}
```

`settings` carries the per-session effort tier (and any `turnTimeoutSecOverride`); `effort` falls back to the global `effort.default` when the session has none set.

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
| `audit.event` | only after `audit.subscribe` |

Final `status` payloads can include:

- `response`
- `toolCallsExecuted`
- `guardrailEvents`
- `usage`
- `swarmState`
- `performance`
- `error`

When a turn times out, the gateway now emits an error message that explicitly says the session was archived.

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
    "sessionId": "optional-parent-session"
  }
}
```

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
