# @starlingai/web

The StarlingAI dashboard — a Vue 3 + Vite single-page app for chatting with the swarm, inspecting audit trails, approving gated tool calls, and managing the live configuration.

## What this package is

A pure frontend. There is no backend code in this package; the app consumes the gateway's REST API and WebSocket RPC from [`@starlingai/core`](../core/README.md). In production, the built bundle is served by the Nginx container defined in the root `docker-compose.yml`, which also forwards `/api` and `/ws` to the gateway so the browser stays same-origin.

## Stack

- **Vue 3** with `<script setup>` SFCs
- **Pinia** for state management
- **Vue Router** for client-side routing
- **Vite** as the bundler and dev server
- **Tailwind CSS** + typography plugin for styling
- **mermaid**, **marked**, **dompurify** for rendering chat artifacts (diagrams, Markdown, sanitized HTML)
- **three.js** for the swarm visualization
- **@vueuse/core** for composables

## Source layout

| Directory | Contents |
|---|---|
| `src/components/` | Reusable presentational components (chat bubbles, audit rows, approval prompts, artifact previews, dashboard widgets) |
| `src/pages/` | Route-level views (Chat, Settings, Audit, Swarm dashboard, Scenes, Workflows, Tutorials, etc.) |
| `src/router/` | Vue Router config and route guards |
| `src/stores/` | Pinia stores for auth, session, audit stream, channel state, live config |
| `src/App.vue` / `src/main.ts` | App shell and bootstrap |
| `public/` | Static assets served as-is |

## Running locally

```bash
# From the repo root — starts the gateway + web UI together
pnpm sai start
# Dashboard:  http://localhost:3001

# Dev mode — Vite with HMR, proxies /api and /ws to the gateway
pnpm sai dev web
# or, directly:
pnpm dev
```

The Vite dev config proxies `/api` and `/ws` to the gateway at `http://localhost:8765`, so you can run `pnpm sai dev gateway` and `pnpm sai dev web` in parallel and get hot reload on both ends.

## Build

```bash
pnpm build            # runs vue-tsc type-check and vite build
pnpm preview          # preview the built bundle locally
pnpm check            # type-check only
pnpm lint             # eslint
```

The build output is consumed by the Docker image that serves the dashboard at port `3001`.

## Auth

The app expects a JWT in localStorage (key `sai.token`). Get one from `pnpm sai token` or from the token printed at the end of `pnpm sai start`. The login modal accepts the token and persists it.

## Reverse proxy / custom domain

When you put the dashboard behind HAProxy, Traefik, or another reverse proxy, publish the container's port `3001`. The bundled Nginx forwards `/api` and `/ws` to the gateway internally, so the browser stays same-origin. If you route the gateway's origin through a different domain instead, add that origin to `gateway.corsAllowedOrigins` in `config/gateway/*.jsonc`.

## Further reading

- [README.md](../../README.md) — top-level overview and repo layout
- [QUICKSTART.md](../../QUICKSTART.md) — local setup walkthrough
- [docs/api.md](../../docs/api.md) — the REST and WebSocket surface this app consumes
