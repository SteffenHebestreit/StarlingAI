# StarlingAI Quick Start

Get a general-purpose AI agent swarm running locally in minutes. StarlingAI orchestrates specialist agents that collaborate on any task — research, coding, communication, data analysis, and more — all behind four-layer guardrails and Docker-sandboxed execution.

## Prerequisites

- Node.js 22+
- pnpm
- Docker Desktop
- LM Studio running with at least one tool-capable model loaded

In LM Studio, enable function calling for the models you plan to use. The default configuration assumes an OpenAI-compatible LM Studio endpoint at `http://host.docker.internal:1234/v1`. The swarm works with any tool-capable model — Qwen3.5, Llama, Mistral, or cloud providers like Anthropic as fallback.

## First Run

```bash
pnpm setup
pnpm install
docker compose up -d --build
pnpm token
```

Windows CMD users can run `scripts\gen-token.bat`. The setup script generates `.env` values such as `SAI_MASTER_KEY` and `POSTGRES_PASSWORD` if they do not exist yet.

The default Docker stack now brings up Qwen3-ASR and Qwen3-TTS for speech features. If you want cloned speech by default, set `multimodal.tts.voiceSamplePath` and optionally `multimodal.tts.voiceSampleText` in `starlingai.json`.

## Open The Stack

- Dashboard: `http://localhost:3001`
- Tutorial/setup site: `http://localhost:3002`
- Gateway REST: `http://localhost:8765/api`
- Gateway WebSocket: `ws://localhost:8765/ws`
- Health: `http://localhost:8765/healthz`

Paste the generated JWT into the dashboard login modal.

## Minimum Config Checklist

Copy `starlingai.example.json` to `starlingai.json` and update these sections first:

- `providers`: point LM Studio or another provider at your reachable endpoint.
- `agents.defaults.model`: choose the main orchestration model and optional embedding model.
- `workspacePath`: set the mounted workspace path the file and shell tools should see.
- `mcp.servers`: keep only the MCP servers you actually want to auto-start.
- `sites`, `scenes`, `channels`, `approvalChannels`, `integrations`, and `webhooks`: add only what you need.

## Scenes: Missions for the Swarm

Scenes define missions that the swarm executes autonomously. Each scene specifies a `task` plus optional `params`, `allowedAgents`, `humanInLoopSteps`, `approvalChannel`, and `webhookKey`. The orchestrator routes the task to the right specialist agents, which collaborate and report results back.

You can trigger a scene in three ways:

- Chat: `/run <scene-name>`
- Dashboard: chat quick actions or Settings -> Scenes
- API or webhook: `POST /api/scenes/<name>/run`

Scene runs are async. The trigger response returns a `jobId`, and the dashboard polls `GET /api/scenes/jobs/:jobId` until completion or failure.

## Development Mode

```bash
pnpm gateway:dev
pnpm web:dev
```

The Vite app proxies `/api` and `/ws` to the gateway.

## Troubleshooting

If LM Studio is reachable but tool calls do not happen, verify that the loaded model supports function calling and that your selected model ID matches what LM Studio exposes.

If the dashboard loads but login fails, regenerate a token and check whether `SAI_JWT_SECRET`, `gateway.jwtSecret`, or the persisted `.starlingai/.jwt_secret` changed between runs.

If a scene never finishes, inspect the Audit page and the scene job card in Chat first. Scene jobs now log completion and failure events explicitly.
