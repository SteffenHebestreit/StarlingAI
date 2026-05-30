# @starlingai/core

The core runtime of StarlingAI — the agent swarm gateway, the tool registry, the channel integrations, and every sub-service that runs inside the gateway process.

## What this package is

`@starlingai/core` is a multi-entrypoint Node.js service. The main entrypoint boots the gateway (HTTP + WebSocket API, sub-agent orchestration, swarm bus, guardrails). The package also ships sibling entrypoints that can run standalone or alongside the gateway.

| Entry | Purpose | Script |
|---|---|---|
| `src/index.ts` | Gateway, swarm bus, runtime, channels, tools | `pnpm dev` · `pnpm start` |
| `src/computer-remote-main.ts` | Sidecar for `remote_vnc`/`remote_rdp`/`remote_ssh` | `pnpm dev:computer-remote` |
| `src/scene-worker-main.ts` | Out-of-process scene job worker (drains the shared job queue) | `pnpm dev:scene-worker` |

All four are built into `dist/` by `pnpm build` and shipped as part of the `starlingai/gateway` Docker image (for the main gateway) or run directly on a host for the computer-use sidecars.

## Subsystems

The source tree under `src/` is organized by concern. Each directory owns a runtime component and exposes a small surface consumed by the gateway bootstrap.

| Directory | Responsibility |
|---|---|
| `agent/` | Sub-agent creation, routing, session management, scene/job execution, warden, self-improvement hooks, tool-dev sessions |
| `approval/` | Human-in-the-loop approval routing (Slack, outbound webhook, sync webhook), decision store, status sync |
| `audit/` | JSONL + PostgreSQL audit sinks, event schema, audit-log queries, subscription feed for the WebSocket audit channel |
| `channels/` | Messaging adapters (Slack, Telegram, Discord, WhatsApp, Email, webchat), registry, dead-letter queue, health checks |
| `config/` | Zod schemas for every config section, loader (merges `config/` + `workspace/` + runtime overrides), hot-reload watcher |
| `credentials/` | Encrypted credential store (site logins, MCP secrets, webhook tokens); env-var reference resolution; no path into model context |
| `db/` | Postgres, MemGraph, and graph-schema bootstrap; helpers for durable memory and audit persistence |
| `gateway/` | Hono app, REST routes, WebSocket RPC dispatcher, JWT auth, session export, CORS and reverse-proxy config |
| `guardrails/` | Four-layer enforcement: input scanner → tool-tier check → output scanner → final redactor |
| `mcp/` | Model Context Protocol client registry: stdio, Docker container, and HTTP transports; tool bridging |
| `memory/` | User memory, flow memory, swarm facts; semantic search via the embedding provider |
| `multimodal/` | Speech-to-text, text-to-speech, image analysis, image generation, file-to-markdown conversion |
| `personality/` | Main assistant system prompt storage and live editing |
| `providers/` | LLM provider abstraction (Anthropic, OpenAI-compatible, LM Studio, Ollama); embedding provider; fallback logic; token counting |
| `retrieval/` | RAG pipeline — chunking strategies, reranking (BM25 + semantic), citation assembly |
| `runtime/` | Status snapshots, component health, job-trigger schedule, ephemeral store (Redis + Postgres), model-endpoint sync, graph jobs |
| `swarm/` | Autonomous bidding engine, swarm bus (Redis Pub/Sub with in-process fallback), distributed locks, checkpoints, bidder worker |
| `tools/` | ~40 built-in tools (filesystem, shell, SSH, web, computer-use, browser, workflow, etc.); tool registry; dynamic tool hot-loading |

Shared utilities live at the package root: `logger.ts` (pino child loggers), `scripts/` (smoke tests and evaluation CLIs).

## HTTP + WebSocket surface

The gateway exposes a REST API and a JSON-RPC 2.0 WebSocket channel. The full endpoint catalog lives in [`docs/api.md`](../../docs/api.md), and machine-readable schemas are in [`specs/core-gateway.openapi.yaml`](../../specs/core-gateway.openapi.yaml).

- REST base path: `http://localhost:${gateway.port}/api` (default `8765`)
- WebSocket: `ws://localhost:${gateway.port}/ws?token=<jwt>`
- Health: `GET /healthz`, `GET /readyz`

Auth is JWT via `Authorization: Bearer` (REST) or `?token=` (WebSocket). Scene webhooks are the only exception and may authenticate with `?key=` / `X-Scene-Key`.

## Running locally

```bash
# Full stack (recommended) — boots the gateway plus every dependency
pnpm -w sai start

# Gateway only, with live reload against a running Docker stack
pnpm dev

# Scene worker only (shares the job queue with the main gateway)
pnpm dev:scene-worker
```

`pnpm dev` reads config from `starlingai.json` at the repo root. For the workspace-split layout, run `pnpm -w sai config build` first.

## Testing

```bash
pnpm test                       # run the vitest suite once
pnpm test:watch                 # watch mode
pnpm check                      # type-check only (tsc --noEmit)
pnpm lint                       # eslint
pnpm agents:evaluate            # scripted agent evaluation CLI
pnpm runtime-guidance:evaluate  # live runtime-guidance eval
pnpm test:qwen-speech-smoke     # end-to-end Qwen speech check
```

## Build

```bash
pnpm build             # clean dist/ and run tsc for dist/ output
pnpm security:pack     # verify the packed artifact contains no .map or debug files
```

## Further reading

- [docs/architecture.md](../../docs/architecture.md) — swarm principles, runtime layering, boundary model
- [docs/api.md](../../docs/api.md) — REST and WebSocket endpoint catalog
- [docs/security.md](../../docs/security.md) — auth, credential handling, sandboxing, audit
- [docs/tool-tiers.md](../../docs/tool-tiers.md) — compile-time tool permission tiers and approval rules
- [docs/channels.md](../../docs/channels.md) and [docs/channel-setup.md](../../docs/channel-setup.md) — channel capability matrix and onboarding
