# StarlingAI Quick Start

Get a general-purpose AI agent swarm running locally in minutes. StarlingAI orchestrates specialist agents that collaborate on any task — research, coding, communication, data analysis, and more — all behind four-layer guardrails and Docker-sandboxed execution.

## Prerequisites

- **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** (Windows/macOS) or Docker Engine (Linux) — **the only prerequisite.**
- A model — your choice, picked in the setup wizard: an OpenAI-compatible endpoint you run (LM Studio, vLLM, llama.cpp…), an Anthropic API key, or a local model via Ollama that the wizard downloads for you.

No Node, no pnpm, no config files to edit by hand — the guided setup runs inside Docker.

## First Run (one-click)

1. Install Docker and start it (wait for the whale icon to go green).
2. Download or clone StarlingAI, then **double-click the launcher for your system**:
   - **Windows** — `start.bat`
   - **macOS** — `start.command` (first time: right-click → *Open*)
   - **Linux** — `./start.sh`

The launcher checks Docker, runs the guided wizard in a throwaway `node:22-alpine` container (generates secrets, wires your chosen model, bootstraps `starlingai.json`, mints a dashboard login token), then `docker compose up -d --build` and opens the dashboard already signed in. First run builds the images (a few minutes); later starts are fast. If you chose the local Ollama backend, the model is pulled automatically on first start.

Stop everything later with `docker compose down`.

### From source (developers)

To run from source with the full Node toolchain (Node 22 + pnpm):

```bash
pnpm install
pnpm sai setup        # check prerequisites, generate .env secrets (once)
pnpm sai start        # build config, build images, start core services, print login token
```

`pnpm sai start` compiles `config/` + `workspace/` into the generated `starlingai.json` artifact, builds images on first run, starts the stack, waits for health, and prints a dashboard login token. Repo-local launchers are available too: use `./sai ...` in Bash/WSL, or `./sai ...` / `.\sai ...` from the repository root in Windows PowerShell.

## `sai start` flags

| Flag | Effect |
|---|---|
| _(none)_ | Build if needed, start core services |
| `--build` | Force rebuild images, then start |
| `--no-cache` | Force rebuild with no Docker layer cache |
| `--fresh` | Wipe all volumes + rebuild + start (clean slate) |
| `--pentest` | Also start the Kali Linux pentest service |
| `--computer-desktop` | Also start the bundled VNC desktop for computer-use workflows |
| `--strix-halo` | Apply the Strix Halo ROCm compose overrides |
| `--all` | Start all remaining optional services |

Stopping the stack:

| Command | Effect |
|---|---|
| `pnpm sai stop` | Stop all containers and networks (data volumes preserved) |
| `pnpm sai stop --volumes` | Stop all services and wipe all data volumes |

## Optional Services

Optional services are gated behind Docker Compose profiles. The simplest way to include them is to pass the matching flag to `sai start` (see the table above). To toggle a single profile on an already-running stack without restarting the core services, drive Docker Compose directly:

```bash
docker compose --profile pentest up -d kali-pentest          # add pentest
docker compose --profile pentest stop kali-pentest           # stop pentest
docker compose --profile computer-desktop up -d computer-desktop
```

### Pentest service

```bash
pnpm sai start --pentest
# Then set the authorized scope before scanning:
PENTEST_SCOPE=192.168.1.0/24,target.example.com docker compose up -d kali-pentest
```

Tools available: nmap, nikto, gobuster, sqlmap, hydra, wpscan, sslscan, ffuf, dirb, whatweb, wafw00f, wfuzz, metasploit, and any other Kali tool via `pentest_exec`.

### Optional self-hosted model servers

If LM Studio cannot host a checkpoint you need, the `docker-compose.model-servers.yml` overlay provides vLLM-based OpenAI-compatible servers (coder, vision, reranker, guard, embedding) behind the `model-servers` profile:

```bash
docker compose -f docker-compose.model-servers.yml --profile model-servers up -d
```

Point the relevant `config/providers/` entry at the resulting endpoint.

## Open The Stack

| URL | Service |
|---|---|
| `http://localhost:3001` | Dashboard |
| `http://localhost:3002` | Tutorial / setup site |
| `http://localhost:8765/api` | Gateway REST API |
| `ws://localhost:8765/ws` | Gateway WebSocket |
| `http://localhost:8765/healthz` | Health check |

Paste the generated JWT into the dashboard login modal. Regenerate one any time with `pnpm sai token`.

## Minimum Config Checklist

Configuration lives in two zones — operator-owned `config/` and agent-tunable `workspace/` — which compile into `starlingai.json`. Edit the source files, then run `pnpm sai config build` (and restart the gateway). Start with:

- `config/providers/10-providers.jsonc` — point LM Studio or another provider at your reachable endpoint.
- `workspace/agents/10-core-agents.jsonc` — `agents.defaults.model` and `embeddingModel` for the swarm.
- `config/gateway/10-gateway.jsonc` — gateway port, bind host, session and turn timeouts, CORS allowlist.
- `config/tooling/10-platform.jsonc` — retrieval, computer-use, pentest, and MCP servers (keep only what you need).
- `config/channels/10-channels.jsonc` and `config/integrations/` — messaging channels, sites, approval channels, and webhooks.

See [config/README.md](config/README.md) and [workspace/README.md](workspace/README.md) for the full layout. `starlingai.example.json` is a reference dump of the compiled artifact, not a file to edit directly.

## Credential-Safe Logins

Store reusable site credentials either in the `sites` config or through the dashboard under Settings → Site Credentials. The runtime keeps those secrets out of the model context: `get_site_credentials` reveals only login metadata, browser logins should use `site_fill_credentials`, and desktop logins should use `computer_type_credential`. If you add scene approval gates, gate the secure fill tool rather than `get_site_credentials`.

## Remote Access

For raw VNC, RDP, or SSH targets, the default stack includes a dedicated `computer-remote` sidecar. The gateway talks to that service over HTTP, and the sidecar owns native tooling like FreeRDP and OpenSSH.

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

Launch that bundled desktop container with `pnpm sai start --computer-desktop`.

### Legacy Windows node host

For direct control of an interactive Windows desktop on the target machine itself, the legacy `remote_node` adapter is still available. Keep it only for cases where raw host-desktop capture and input injection are required; prefer `remote_vnc`, `remote_rdp`, or `remote_ssh` for new setups.

Gateway-side configuration:

```jsonc
"computerUse": {
	"enabled": true,
	"adapters": {
		"remote_node": {
			"baseUrl": "http://10.10.0.2:8877",
			"authToken": "$SAI_COMPUTER_NODE_TOKEN",
			"timeoutMs": 15000,
			"label": "Windows workstation"
		}
	}
}
```

On the target Windows machine, run the node host as a real Windows process (it needs direct access to the interactive desktop for screenshots, input injection, clipboard access, and window focus):

```bat
start-computer-node.bat
stop-computer-node.bat
```

Both forward to `scripts/computer-node-host.ps1`. Set `SAI_COMPUTER_NODE_TOKEN` to the shared secret before starting.

## Scenes: Missions for the Swarm

Scenes define missions that the swarm executes autonomously. Each scene specifies a `task` plus optional `params`, `allowedAgents`, `humanInLoopSteps`, `approvalChannel`, and `webhookKey`. The orchestrator routes the task to the right specialist agents, which collaborate and report results back.

You can trigger a scene in three ways:

- Chat: `/run <scene-name>`
- Dashboard: chat quick actions or Settings → Scenes
- API or webhook: `POST /api/scenes/<name>/run`

Scene runs are async. The trigger response returns a `jobId`, and the dashboard polls `GET /api/scenes/jobs/:jobId` until completion or failure.

## Development Mode

```bash
pnpm sai dev gateway    # or: pnpm gateway:dev
pnpm sai dev web        # or: pnpm web:dev
```

The Vite app proxies `/api` and `/ws` to the gateway.

## Troubleshooting

**LM Studio reachable but tool calls don't happen** — verify the loaded model supports function calling and that your selected model ID matches what LM Studio exposes.

**Dashboard loads but login fails** — regenerate a token with `pnpm sai token` and check whether `SAI_JWT_SECRET` changed between runs.

**Gateway takes a long time to start on first run** — model and image downloads happen on first launch. The gateway starts immediately; dependent capabilities become available once downloads complete.

**Services show `health: starting` for a long time** — normal on first run while model files download. Check progress with `docker compose logs -f <service>`.

**A scene never finishes** — inspect the Audit page and the scene job card in Chat first. Scene jobs log completion and failure events explicitly.

**kali-pentest returns scope error** — set `PENTEST_SCOPE` with the authorized targets before running any active scan. Use `pentest_set_scope` from the swarm to configure it interactively.
