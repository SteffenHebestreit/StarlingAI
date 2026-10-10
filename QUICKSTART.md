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

Paste the generated JWT into the dashboard login modal. Regenerate one any time with `pnpm sai token`. It is a bootstrap admin token: it works whatever accounts exist, and it is never one of them (see [Accounts](#accounts)).

## Minimum Config Checklist

Configuration lives in two zones — operator-owned `config/` and agent-tunable `workspace/` — which compile into `starlingai.json`. Edit the source files, then run `pnpm sai config build` (and restart the gateway). Start with:

- `config/providers/10-providers.jsonc` — point LM Studio or another provider at your reachable endpoint.
- `workspace/agents/00-platform.jsonc` — `agents.defaults.model` and `embeddingModel` for the swarm.
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
			"host": "192.0.2.10",
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

For controlling an external host, the `computer_use_agent` connects through the `computer-remote` service to a host on its access list (`remote_vnc`, `remote_rdp`, or `remote_ssh` adapters) — add the host's URL/credentials under `computerUse.adapters` in config.

## Scenes: Missions for the Swarm

Scenes define missions that the swarm executes autonomously. Each scene specifies a `task` plus optional `params`, `allowedAgents`, `humanInLoopSteps`, `approvalChannel`, and `webhookKey`. The orchestrator routes the task to the right specialist agents, which collaborate and report results back.

You can trigger a scene in three ways:

- Chat: `/run <scene-name>`
- Dashboard: chat quick actions or Settings → Scenes
- API or webhook: `POST /api/scenes/<name>/run`

Scene runs are async. The trigger response returns a `jobId`, and the dashboard polls `GET /api/scenes/jobs/:jobId` until completion or failure.

## Accounts

With multi-user auth on (`auth.enabled: true`, as the shipped `config/gateway/30-auth.jsonc` sets), each person signs in with an account: one an admin creates on the **Users** page (`auth.provider: "builtin"`), or one their identity provider signs in ([docs/iam-sso-oidc.md](docs/iam-sso-oidc.md)). Every account has an immutable id, and its memory, files, chats, jobs, schedules and documents are keyed by that id, never by the username: an account deleted and created again under the same name starts empty. `pnpm sai token` mints a bootstrap token, an instance credential for whoever holds the JWT secret in `.env`: it is never an account, and `--user alice` does not sign in as alice. See [docs/security.md](docs/security.md#per-user-data-isolation).

### Upgrading to account ids

A deployment whose data predates account ids has it stored under the usernames. Nothing moves it on its own, and nothing reads it by a guess: until an admin runs the account migration, a builtin account without an id cannot sign in ("This account has no account id yet"), an identity-provider user with data under their name waits pending ("Account storage migration pending; ask an admin"), chats from before ids are read-only and shown to admins only, and schedules from before ids do not fire. Dashboard tokens minted before the upgrade stop working, the setup wizard's 30-day `.starlingai/dashboard-token.txt` included; `pnpm sai start` prints a new one, as does `pnpm sai token`. The bootstrap token always works, so the migration can always run.

You own the rebuild and both gateway restarts below.

1. **Rebuild** with this version. The gateway logs one warning with what waits (`accountsWithoutId`, `pendingIdentityProviderAccounts`, `legacySessions`, `legacyBuckets`).
2. **Dry run:** `pnpm sai migrate-account-ids`. It runs against the live gateway (`localhost:8765`; `--url` or `SAI_GATEWAY_URL` for another) and writes nothing. It lists every identity with its kind, what happens to its data (`adopt` moves it to an account, `hold` leaves it where it is, `archive` moves it to `users/.retired/`, `in-place` is a bootstrap token's, a channel sender's, a run's or an extension provider user's, which stay where they are), what is stored under it, notes, and the plan hash. It mints a 15-minute bootstrap token from `.env`, so run it on the host; an admin role from the identity provider is not enough.
3. **Identity-provider users** who should keep their data: ask them to sign in once. They see "migration pending", and the dry run then lists their account with issuer, subject and first sign-in. Someone who should start fresh instead: `POST /api/admin/accounts/<id>/decline-legacy` (admin, on the live gateway). Users with no data from before ids sign in as usual.
4. **Builtin accounts in a config shard** (your own `config/gateway/30-auth.jsonc`, say): the gateway does not write shards, so the dry run prints an `"id": "…"` line per record. Paste it into that record and run `pnpm sai config build`. For the e2e accounts run `pnpm e2e:setup` instead. Accounts created on the Users page live in the runtime overlay, and the apply writes their ids itself. An account whose id you pasted can sign in from then on, and what it writes lands under its id: an adoption into a directory that already exists is refused (nothing is merged), so paste, adopt and apply in one sitting.
5. **Decide the adoptions** and run the dry run again with them. Without an adoption flag, nothing moves to an account.
   - `--adopt <user>` for a record the apply gives its id to (one in the runtime overlay);
   - `--adopt <user>=<id>` for a record that has an id (a pasted one, an identity-provider account's);
   - `--adopt-legacy-records` for every id-less record in the overlay.

   Data of a builtin account that was deleted is archived to `users/.retired/` (`--hold <user>` keeps it in place); data nobody can be mapped to is held (`--archive-unmapped` archives it). A bootstrap token's name is never adopted: on a deployment whose identity provider has an `admin` user, that user starts empty and the data stays with `sai token`. Note the plan hash.
6. **Apply in a maintenance boot.** Add `SAI_MAINTENANCE=account-migration` to `.env` and start the stack the way you usually do (`pnpm sai start` with your usual flags): the gateway's environment changed, so its container is created again and reads the line. A plain `docker compose restart` keeps the old environment. The gateway then serves only the migration; no chat, channel, schedule or job runs, so nothing else writes. Run `pnpm sai migrate-account-ids <the same flags> --apply --plan <hash>`. A 409 "State changed since the dry run" means a decision changed: run the dry run again and apply its hash. Then remove the line from `.env` and start the stack the same way again.
7. **Check:** the dry run once more must say "Nothing to migrate"; what it still lists stays held where it is.
8. **Later sign-ins** with data from before ids: decline them on the live gateway, or adopt them in the next maintenance window.

The same command covers the rest, each applied the same way (a dry run first, then `--apply --plan <hash>` in a maintenance boot):

| Flag | Effect |
|---|---|
| `--reset` | every account starts empty: account data from before ids is archived, principals keep theirs |
| `--adopt-retired <archive>=<id>` | restores an archive from `users/.retired/` into a living account |
| `--purge-retired <id>` | removes what a deleted or retired account left (directories, ledger entries, chats, knowledge bases, documents, graph nodes); the audit log and the job and mission rows stay |
| `--oidc-issuer-alias <old>=<new>` | renames an identity provider's issuer in the account registry |
| `--json` | prints the gateway's answer as JSON |

Each apply is recorded in `<workspace>/.starlingai/account-migrations.ndjson` and audited (`account_migration_applied`). Every step can run again: after a failure, fix the cause and repeat the dry run and the apply. The apply gives a record its id, or turns a pending identity-provider account active, as its last step, so such an account cannot sign in before all of its data has moved.

## Development Mode

```bash
pnpm sai dev gateway    # or: pnpm gateway:dev
pnpm sai dev web        # or: pnpm web:dev
```

The Vite app proxies `/api` and `/ws` to the gateway.

## Troubleshooting

**LM Studio reachable but tool calls don't happen** — verify the loaded model supports function calling and that your selected model ID matches what LM Studio exposes.

**Dashboard loads but login fails** — regenerate a token with `pnpm sai token` and check whether `SAI_JWT_SECRET` changed between runs. Under multi-user auth, tokens minted before account ids stop working once an account exists.

**"This account has no account id yet" or "Account storage migration pending"** — the account's data predates account ids and waits for the account migration: see [Upgrading to account ids](#upgrading-to-account-ids).

**SSO says "This username is held by another account"** — another account holds the name, or held it (a retired or deleted one, or one renamed since). An admin decides: see [docs/iam-sso-oidc.md](docs/iam-sso-oidc.md#managing-accounts).

**Gateway takes a long time to start on first run** — model and image downloads happen on first launch. The gateway starts immediately; dependent capabilities become available once downloads complete.

**Services show `health: starting` for a long time** — normal on first run while model files download. Check progress with `docker compose logs -f <service>`.

**A scene never finishes** — inspect the Audit page and the scene job card in Chat first. Scene jobs log completion and failure events explicitly.

**kali-pentest returns scope error** — set `PENTEST_SCOPE` with the authorized targets before running any active scan. Use `pentest_set_scope` from the swarm to configure it interactively.
