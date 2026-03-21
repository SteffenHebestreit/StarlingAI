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
node scripts/setup.mjs        # generate .env secrets (only needed once)
cp starlingai.example.json starlingai.json
pnpm install
./start.sh                    # build images + start core services + show login token
```

Windows CMD users:
```bat
node scripts\setup.mjs
copy starlingai.example.json starlingai.json
pnpm install
start.bat
```

The `start.sh` / `start.bat` script handles everything: prerequisite checks, first-time image build, health monitoring, and dashboard token generation.

## start.sh flags

| Flag | Effect |
|---|---|
| _(none)_ | Build if needed, start core services |
| `--build` | Force rebuild, then start |
| `--no-cache` | Force rebuild with no Docker layer cache |
| `--fresh` | Wipe all volumes + rebuild + start (clean slate) |
| `--pentest` | Also start the Kali Linux pentest service |
| `--image` | Also start the image-generation service |
| `--down` | Stop all services |
| `--down --volumes` | Stop all services and wipe all data volumes |

## Optional Services

Optional services run under Docker Compose profiles and can be added or removed from a running stack without restarting core services.

```bash
# Add/remove individual services while the stack is running:
./extras.sh pentest on         # start kali-pentest
./extras.sh pentest off        # stop kali-pentest
./extras.sh image on           # start image-generation
./extras.sh image off          # stop image-generation
./extras.sh all on             # start both
./extras.sh all off            # stop both
./extras.sh status             # show current state
```

Windows CMD: `extras.bat pentest on` etc.

### Pentest service

```bash
./extras.sh pentest on
# Then set the authorized scope before scanning:
PENTEST_SCOPE=192.168.1.0/24,target.example.com docker compose up -d kali-pentest
```

Tools available: nmap, nikto, gobuster, sqlmap, hydra, wpscan, sslscan, ffuf, dirb, whatweb, wafw00f, wfuzz, metasploit, and any other Kali tool via `pentest_exec`.

### Image generation service

```bash
./extras.sh image on
# Model loads automatically (FLUX.1-schnell by default — may take a few minutes)
```

## Open The Stack

| URL | Service |
|---|---|
| `http://localhost:3001` | Dashboard |
| `http://localhost:3002` | Tutorial / setup site |
| `http://localhost:8765/api` | Gateway REST API |
| `ws://localhost:8765/ws` | Gateway WebSocket |
| `http://localhost:8765/healthz` | Health check |

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
- Dashboard: chat quick actions or Settings → Scenes
- API or webhook: `POST /api/scenes/<name>/run`

Scene runs are async. The trigger response returns a `jobId`, and the dashboard polls `GET /api/scenes/jobs/:jobId` until completion or failure.

## Development Mode

```bash
pnpm gateway:dev
pnpm web:dev
```

The Vite app proxies `/api` and `/ws` to the gateway.

## Troubleshooting

**LM Studio reachable but tool calls don't happen** — verify the loaded model supports function calling and that your selected model ID matches what LM Studio exposes.

**Dashboard loads but login fails** — regenerate a token with `node scripts/gen-token.mjs` and check whether `SAI_JWT_SECRET` changed between runs.

**Gateway takes a long time to start on first run** — the Qwen3-ASR model downloads on first launch (several hundred MB). The gateway starts immediately; ASR/TTS become available once the download completes.

**Services show `health: starting` for a long time** — normal on first run while model files download. Check progress with `docker compose logs qwen3-asr-service`.

**A scene never finishes** — inspect the Audit page and the scene job card in Chat first. Scene jobs log completion and failure events explicitly.

**kali-pentest returns scope error** — set `PENTEST_SCOPE` with the authorized targets before running any active scan. Use `pentest_set_scope` from the swarm to configure it interactively.
