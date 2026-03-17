# REST API, WebSocket, And Streaming

<p align="center">
  <img src="../swarmLogo.svg" alt="StarlingAI logo" width="180" />
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
./scripts/gen-token.sh
scripts\gen-token.bat
```

Scene webhooks are the main exception: `POST /api/scenes/:name/run` can authenticate with either a Bearer token or the scene webhook secret via `?key=` or `X-Scene-Key`.

## Health And Status

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/healthz` | returns `{ "status": "ok" }` |
| `GET` | `/readyz` | returns readiness plus active-session count |
| `GET` | `/api/status` | authenticated summary of uptime and active sessions |
| `GET` | `/api/runtime/status` | authenticated component health snapshot |

## REST Endpoints

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
| `GET` | `/api/scenes/jobs/:jobId` | poll a scene job |

`POST /api/scenes/:name/run` returns immediately:

```json
{
  "ok": true,
  "sceneName": "apply_jobs",
  "jobId": "...",
  "sessionId": "...",
  "status": "running"
}
```

Polling `GET /api/scenes/jobs/:jobId` returns the current job record:

```json
{
  "id": "...",
  "sceneName": "apply_jobs",
  "sessionId": "...",
  "status": "running",
  "startedAt": "2026-03-15T12:00:00.000Z",
  "completedAt": "2026-03-15T12:04:12.000Z",
  "response": "...",
  "toolCallsExecuted": 6,
  "blocked": false,
  "performance": {},
  "error": "..."
}
```

If a scene exceeds `gateway.turnTimeoutMs`, the job fails and its scene session is ended.

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
| `session.list` | none |
| `session.reset` | `{ sessionId? }` |
| `scenes.list` | none |
| `approval.respond` | `{ approvalId, approved }` |
| `chat.send` | `{ sessionId, message, requestId? }` |
| `audit.subscribe` | none |

`chat.send` also supports chat-triggered scenes via `/run <sceneName> key=value ...`.

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

When a turn times out, the gateway now emits an error message that explicitly says the session was ended.

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
