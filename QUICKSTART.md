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

## start script flags

| Flag | Effect |
|---|---|
| _(none)_ | Build if needed, start core services |
| `--build` | Force rebuild, then start |
| `--no-cache` | Force rebuild with no Docker layer cache |
| `--fresh` | Wipe all volumes + rebuild + start (clean slate) |
| `--pentest` | Also start the Kali Linux pentest service |
| `--image` | Also start the image-generation service |
| `--computer-desktop` | Also start the bundled VNC desktop for computer-use workflows |
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

The bundled VNC desktop is started with the main launcher rather than `extras`:

```bash
./start.sh --computer-desktop
```

Windows CMD: `start.bat --computer-desktop`

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

## Credential-Safe Logins

Store reusable site credentials either in `sites` inside `starlingai.json` or through the dashboard under Settings → Site Credentials. The runtime keeps those secrets out of the model context: `get_site_credentials` reveals only login metadata, browser logins should use `site_fill_credentials`, and desktop logins should use `computer_type_credential`. If you add scene approval gates, gate the secure fill tool rather than `get_site_credentials`.

## Remote Access

For raw VNC, RDP, or SSH targets, the default stack now includes a dedicated `computer-remote` sidecar. The gateway talks to that service over HTTP, and the sidecar owns native tooling like FreeRDP and OpenSSH.

Gateway-side configuration:

```jsonc
"computerUse": {
	"enabled": true,
	"remoteAccessService": {
		"baseUrl": "http://computer-remote:8890",
		"authToken": "$SAI_COMPUTER_REMOTE_TOKEN",
		"timeoutMs": 20000,
		"label": "Remote access sidecar"
	},
	"nodes": {
		"win-rdp": {
			"adapter": "remote_rdp",
			"host": "10.10.0.2",
			"port": 3389,
			"protocol": "rdp",
			"credentials": "Administrator:password",
			"displayResolution": "1920x1080",
			"label": "Windows RDP workstation"
		}
	}
}
```

You can also point at the bundled ephemeral desktop with a named VNC node:

```jsonc
"desktop": {
	"adapter": "remote_vnc",
	"host": "computer-desktop",
	"port": 5901,
	"protocol": "vnc",
	"credentials": "starling",
	"label": "Ephemeral VNC desktop"
}
```

To launch that bundled desktop container locally:

```bash
./start.sh --computer-desktop
```

Windows CMD: `start.bat --computer-desktop`

### Legacy Windows node host

For direct control of an interactive Windows desktop on the target machine itself, the legacy `remote_node` adapter is still available. Keep it only for cases where raw host-desktop capture and input injection are required; prefer `remote_vnc`, `remote_rdp`, or `remote_ssh` for new setups.

Gateway-side configuration:

```jsonc
"computerUse": {
	"enabled": true,
	"adapters": {
		"remote_node": {
			"baseUrl": "http://10.10.0.2:8877",
			"authToken": "$STARLING_COMPUTER_NODE_TOKEN",
			"timeoutMs": 15000,
			"label": "Windows workstation"
		}
	}
}
```

Target Windows machine:

```bat
set SAI_COMPUTER_NODE_TOKEN=replace-with-shared-secret
pnpm --filter @starlingai/core dev:computer-node
```

For a one-click local Windows startup that also launches the node host, use:

```bat
start.bat --computer-node
```

That launches the normal Docker services and also starts the desktop node host in the background. `start.bat --down` stops both.

If you only want to manage the desktop node host itself, use:

```bat
start-computer-node.bat
stop-computer-node.bat
```

The node host runs as a real Windows process rather than a container because it needs direct access to the interactive desktop for screenshots, input injection, clipboard access, and window focus.

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
