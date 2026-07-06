<table border="0" cellpadding="0" cellspacing="0" width="100%">
  <tr>
    <td valign="middle" width="25%">
      <img src="assets/brand/swarmLogo.svg" alt="StarlingAI logo" width="100%" />
    </td>
    <td valign="middle" width="75%">
      <strong style="font-size:1.4em;">StarlingAI</strong><br/>
      <sub>GUARDED AGENT SWARM &nbsp;&middot;&nbsp; <em>current main</em></sub>
    </td>
  </tr>
</table>

**A general-purpose AI agent swarm that tackles any task by composing the right specialists — not a collection of one-off pipelines.**

<a href="docs/architecture.md">Architecture</a> &middot;
<a href="docs/api.md">API</a> &middot;
<a href="docs/security.md">Security</a> &middot;
<a href="docs/tool-tiers.md">Tool Tiers</a> &middot;
<a href="http://localhost:3002">Tutorials</a>

---

## Latest Main-Branch Highlights

- **One-click Docker-only setup** — the only prerequisite is Docker. Double-click a launcher (`start.bat` on Windows, `start.command` on macOS, `./start.sh` on Linux) and a guided wizard runs inside Docker (no host Node/pnpm), picks your model backend, and brings the whole stack up.
- **Sharper decision flow** — the orchestrator answers trivial turns directly, records a first-class plan for complex ones (`record_plan`), bounds delegation depth and width so a task can't cascade into a runaway fan-out, and runs a risk-gated verification pass before shipping high-stakes answers.
- **Federated swarms** — instances delegate work to each other over HMAC-signed, peer-scoped tokens, while each side keeps full control of its own tool tiers and approval gates.
- **Open interoperability** — StarlingAI serves an MCP server (HTTP + stdio) and a public A2A protocol (server + client), so external clients and agents can use and collaborate with the swarm.
- **Procedural skill library** — agents author and refine reusable `SKILL.md` playbooks at runtime; `search_skills` / `record_skill` and a background distiller turn successful trajectories into discoverable procedures.
- **Cost & access controls** — token usage is aggregated with per-model pricing and budgets on a `/cost` dashboard, and optional per-user accounts gate the dashboard and API.

## The Starling Swarm — How Biology Inspired This Architecture

Watch a murmuration of starlings. Thousands of birds move as a single fluid shape — no conductor, no central plan, no bird that knows the full picture. Each one follows three simple local rules: **avoid collision**, **match speed**, **stay close**. From those rules alone, something extraordinary emerges: a shape-shifting, fault-tolerant, self-healing system that no individual member could produce alone.

That is the model for StarlingAI.

The starling swarm exhibits three core properties that translate directly into software architecture:

### Local Rules Instead of Central Control

**Biology:** Each bird follows only three simple rules. It knows nothing about the swarm as a whole — it reacts only to its 6–7 nearest neighbors.

**StarlingAI:** There is no "master controller" that scripts every step. Instead, each generated agent operates from a local rule base — collision avoidance (load distribution), synchronization (status exchange), and cohesion (the swarm stays functional even when individual agents fail or new ones join).

### Emergence — The Whole Is Greater Than the Sum of Its Parts

**Biology:** From the simple behavior of individual birds, a complex, flowing pattern emerges that is optimized for the swarm as a whole.

**StarlingAI:** Through the interaction of dynamically generated agents, complex solutions emerge for tasks that no single agent could handle alone. The system "emerges" into a solution that surpasses the sum of its individual parts.

### Robustness Through Redundancy and Self-Healing

**Biology:** When a bird drops out of the swarm, the others immediately compensate. The swarm as a whole remains intact.

**StarlingAI:** When a generated agent fails, the swarm detects this immediately and delegates the task to another, newly generated agent. The overall mission is never interrupted.

---

## Architecture Principles — The Swarm in Software

Most agent systems get orchestration backwards. They build a central planner that scripts every step, assigns every task, and fails completely when one step breaks. A starling swarm doesn't work that way — the intelligence is distributed, and robustness comes from local rules, not from a master controller.

### Dynamic Agent Generation

Tasks are not assigned to fixed agents. Each task triggers the creation of a specialized sub-agent tailored exactly to it — Researcher, Coder, DataAnalyst, or anything the task demands. When no existing specialist fits, the system designs and launches a purpose-built ephemeral agent on the fly. Successful configurations are automatically promoted to the permanent agent catalog.

### Emergent Execution

Independent sub-tasks run concurrently. Dependency-aware task graphs handle sequencing. Outcome-weighted routing improves specialist selection over time — the swarm gets smarter the more it works.

### Bounded Self-Improvement

The swarm is allowed to improve itself, but only inside non-crucial boundaries that preserve the base philosophy above. It can refine its own system-prompt, update durable user and workflow memory, create new sub-agents, improve existing sub-agents, and adjust which approved tools those sub-agents may use. This self-improvement is meant to strengthen the swarm's local rules and specialist fit over time, not to replace the guarded architecture or bypass operator intent.

The boundary is strict: the swarm must never read secrets or stored credentials into model context. Credentials may only be used through dedicated tool calls such as `site_fill_credentials` or `computer_type_credential`, under the existing approval and audit rules. Self-improvement may tune behavior, memory, prompts, and agent composition, but it must never weaken the guarded sandbox, tool-tier policy, approval gates, or the core README philosophy that speed and autonomy do not come at the cost of control.

### Guarded Sandboxing

Every agent runs in an isolated Docker container with `--cap-drop ALL`, `--read-only`, and `--network none` enforced. A four-layer guardrail stack (input scanner → tool-tier check → output scanner → final redactor) ensures speed and autonomy never come at the cost of control.

---

## What StarlingAI Can Do

- **Smart Routing** — Keyword, embedding, and outcome-based ranking surfaces the best specialist for every task. Circuit breakers automatically exclude failing agents.
- **Ephemeral Agents** — When no specialist fits, the swarm architects and launches a purpose-built agent on demand. Successful ones are promoted to the permanent catalog.
- **Parallel Delegation** — Independent sub-tasks run concurrently. Task graphs handle complex dependencies with per-node fallbacks.
- **Reusable Workflows** — Scenes and multi-step jobs can be discovered with `search_workflows` and executed inline with `run_workflow`, so recurring packets do not have to be replanned from scratch.
- **Collective Memory** — Agents share facts and partial results via a semantic memory layer backed by embeddings. Knowledge built by one agent is available to all.
- **Document RAG** — Files attached to a conversation are extracted to Markdown by the file-conversion service and indexed into the [engram](https://github.com/SteffenHebestreit/engram) graph-RAG store (chunk → keywords/summary → multi-channel embeddings → graph). Relevant excerpts are auto-retrieved and injected as context per turn, with a cross-encoder rerank (`bge-reranker-v2-m3` via a TEI sidecar). Scope is the conversation by default, extendable to the user's or the workspace's shared library from settings.
- **Knowledge Bases** — Named corpora crawled from documentation sites (`create_knowledge_base`) into the engram store via a bounded, robots-respecting, SSRF-guarded crawler, then queried with `search_knowledge_base` — excerpts cite their source page URLs. See [docs/knowledge-bases.md](docs/knowledge-bases.md).
- **Bounded Self-Improvement** — The swarm can improve prompts, user memory, flow memory, sub-agent definitions, and approved tool assignments for sub-agents, but only inside guarded, non-secret, non-crucial configuration boundaries.
- **Federated Swarms** — Instances delegate work to one another over HMAC-signed, short-lived, peer-scoped tokens. Each side keeps full control of its own tool tiers and approval policies — federation never bypasses local guardrails.
- **Open Interoperability** — StarlingAI both speaks and serves the open agent protocols: an MCP server (HTTP + stdio) exposes its tools to other clients, and a public A2A protocol (server + client) lets external agents collaborate with the swarm.
- **Skill Library** — Agents author and refine reusable `SKILL.md` procedures at runtime, so successful multi-step approaches are distilled into discoverable, improvable playbooks.
- **Plugin SDK** — Third-party tool packages auto-load from `~/.starlingai/plugins` at Tier 2 with tier-shadow rejection, so the toolset can grow without touching core.
- **Multimodal Tools** — Speech-to-text, speech synthesis, image analysis, file-to-markdown conversion, browser automation, shell execution, MCP, and webhooks — all behind the same gateway.
- **Server Operations Routing** — Headless server work such as SSH, Docker, `systemctl`, and log triage is routed to shell and ops specialists with `ssh_exec` support instead of desktop automation.
- **Credential-Safe Automation** — Stored site credentials never need to enter the LLM context. Agents inspect login metadata with `get_site_credentials` and inject secrets only through `site_fill_credentials` or `computer_type_credential` under approval.
- **Remote Access Sidecar** — Raw VNC, RDP, and SSH sessions can run through a dedicated `computer-remote` service so native desktop tooling stays isolated from the main gateway.
- **Human-in-the-Loop** — Approval gates via Slack, outbound webhook, or sync webhook with one-click HTTP callbacks before sensitive actions proceed.
- **Multi-Channel Messaging** — Webchat, Telegram, Slack, Discord, WhatsApp, and email with consistent delivery SLOs, dead-letter queues, and retry with backoff.
- **Warden Monitoring** — A background warden detects tool storms, escape attempts, failure spikes, and SLO breaches in real time.
- **Live Observability** — Token streaming to the dashboard via AG-UI SSE, live shell previews, per-turn performance telemetry, and audit/debug Markdown exports sit on top of the JSONL + PostgreSQL audit trail.
- **Distributed Tracing** — OpenTelemetry spans cover tool calls, sub-agents, and federation hops, with W3C `traceparent` propagated across instances for end-to-end visibility.
- **Cost Governance** — Token usage is aggregated with per-model pricing and budget thresholds, surfaced on a dedicated `/cost` dashboard.
- **Multi-User Access** — Optional per-user accounts (username + password) gate the dashboard and API; leaving auth disabled keeps the single-user setup fully backwards compatible.
- **Scenes And Jobs** — Reusable scene templates and multi-step jobs live in the workspace. Scenes remain launchable from chat, the dashboard, or webhooks and are tracked as async jobs.
- **Penetration Testing** — Full Kali Linux toolchain (nmap, nikto, gobuster, sqlmap, hydra, wpscan, sslscan, ffuf, Metasploit and more) wrapped in a scope-enforcing swarm with mandatory authorization.

---

## Quick Start

**The only prerequisite is [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine on Linux).** No Node, no pnpm — the guided setup runs inside Docker.

1. Install Docker and start it (wait for the whale icon to go green).
2. Download or clone StarlingAI, then **double-click the launcher for your system**:
   - **Windows** — `start.bat`
   - **macOS** — `start.command` (first time: right-click → *Open*)
   - **Linux** — `./start.sh`

The launcher runs a guided wizard (pick a model backend: an OpenAI-compatible endpoint you run, an Anthropic key, or a local model via Ollama that's pulled for you), then builds the images, starts every service, and opens the dashboard already signed in. First run takes a few minutes while images build; later starts are fast. Stop everything with `docker compose down`.

Open `http://localhost:3001` for the dashboard and `http://localhost:3002` for the interactive setup tutorials. The gateway listens on `http://localhost:8765`.

### From source (developers)

To run from source with the full Node toolchain (Node 22 + pnpm):

```bash
git clone https://github.com/SteffenHebestreit/StarlingAI starlingai
cd starlingai
pnpm install
pnpm sai setup        # check prerequisites, generate .env secrets
pnpm sai start        # build config, build images, start services
```

Repo-local launchers are available too: use `./sai ...` in Bash/WSL or `./sai ...` / `.\sai ...` from the repository root on Windows PowerShell.

## Repository Layout

The repository root is reserved for entrypoints, compose files, top-level docs, and the compiled `starlingai.json` artifact. Ad hoc helper scripts and generated reports should not live at the root.

```text
artifacts/              # Generated reports, exports, and operator-collected artifacts
assets/                 # Shared brand assets and static imagery for docs/tutorials
scripts/                # Maintained CLI and support scripts used by StarlingAI
scripts/devtools/       # One-off maintenance and debugging helpers
config/                 # Protected infrastructure configuration
workspace/              # Durable workspace definitions and runtime overlays
.starlingai/            # Runtime state, logs, recordings, promoted agents
```

### Internal Domain / HAProxy

For an internal domain behind HAProxy or another reverse proxy, publish the web entrypoint on port `3001` and route the domain to that service. The bundled Nginx layer already forwards `/api` and `/ws` to the gateway, so the browser can stay same-origin and the dashboard will auto-use the current host for WebSocket and REST calls.

```haproxy
frontend starling_https
  bind *:443 ssl crt /etc/haproxy/certs/starlingai.pem
  acl host_starling hdr(host) -i ai.internal.example
  use_backend starling_web if host_starling

backend starling_web
  option http-server-close
  server starling 127.0.0.1:3001 check
```

If you expose the gateway directly on a separate origin instead of going through the web entrypoint, update the gateway CORS allowlist first.

### Optional services

```bash
pnpm sai start --pentest           # include Kali Linux pentest service
pnpm sai start --computer-desktop  # include VNC desktop for computer-use
pnpm sai start --all               # all remaining optional services
```

**Document RAG services.** Document RAG adds three containers — `engram` (graph-RAG API), `engram-neo4j` (graph store with the GDS plugin), and `reranker` (a CPU HuggingFace TEI sidecar serving `bge-reranker-v2-m3`). They come up with the normal `sai start` / `docker compose up`. The reranker downloads its model (~2 GB) on first start, and `engram` points its embeddings + extraction LLM at the same primary model endpoint as the gateway (`SAI_PRIMARY_MODEL_URL`). See [`.env.example`](.env.example) for the `ENGRAM_*` / `RERANKER_MODEL` overrides. The gateway degrades gracefully if these are absent.

### Other CLI commands

```bash
pnpm sai stop                  # stop all services
pnpm sai stop --volumes        # stop + wipe all data
pnpm sai start --build         # force rebuild images
pnpm sai config build          # recompile config/ + workspace/ → starlingai.json
pnpm sai token                 # generate dashboard login JWT
pnpm sai health                # check service health endpoints
pnpm security:pack             # verify packed artifacts contain no .map or debug files
pnpm sai dev gateway           # start gateway in dev mode
pnpm sai dev web               # start web UI in dev mode
```

---

## Configuration — Two-Zone Layout

Configuration is split into two directories with a clear separation of concerns:

```
config/                  # Infrastructure — you set this up once
  providers/             # Model backends (LM Studio, Ollama, Anthropic)
  gateway/               # Gateway port, guardrails, sandbox policy
  channels/              # Messaging (Telegram, Slack, Discord, etc.)
  multimodal/            # STT, TTS, image generation service URLs
  integrations/          # n8n, webhooks, sites, approval channels
  tooling/               # Retrieval, computer-use, pentest, MCP servers

workspace/               # Agent-tunable — the swarm self-improves here
  agents/                # Agent definitions, sub-agent prompts & models
  jobs/                  # Operator-managed reusable job definitions
  scenes/                # Workflow / mission definitions
  runtime/               # runtime.overrides.json (live config changes)
```

**The agent cannot modify `config/`.** Within `workspace/`, only agent definitions and scene definitions are mutable by the config-assistant. `workspace/jobs/` is durable workspace data, but it is operator-managed rather than agent-writable.

Run `pnpm sai config build` to compile both zones into `starlingai.json` (the artifact Docker mounts). See [config/README.md](config/README.md) and [workspace/README.md](workspace/README.md) for details.

### Decision-flow controls (`orchestration.*`)

The orchestrator's flow is tunable without code edits (all optional, sensible defaults):

| Key | Default | Effect |
| --- | --- | --- |
| `maxParallelSlices` | `2` | Max parallel cross-check slices a coordinator may fan out (raise for multi-GPU / API backends). |
| `maxDelegationDepth` | `3` | Max sub-agent nesting depth; deeper agents must use their own tools instead of delegating — bounds the tree. |
| `planFirst` | `true` | Nudge the orchestrator to record a structured plan (`record_plan`) before fanning out on a complex turn. |
| `riskGatedQA` | `true` | Auto-verify high-stakes answers (sourced claims, external actions) against the plan's acceptance criteria before shipping. |
| `planApproval` | `false` | Pause a high-risk or wide plan for human approval in the operator dock before executing it. |

### Effort tiers (`effort.*`)

A single per-session **effort** dial bundles the latency / budget / size / depth / reasoning knobs (and, at the top tier, the quality gates above) into named profiles — so a long, maximum-quality deliverable (a detailed paper, a deep plan) isn't cut short by guardrails tuned for fast local turns.

| Tier | Behavior |
| --- | --- |
| `low` | Fast & tight — short timeout, fewer iterations, no extended reasoning. |
| `medium` | Balanced default — identical to today's behavior (zero overrides). |
| `high` | Thorough — long timeout, deeper delegation, full-length output, extended reasoning; **quality gates kept**. |
| `max` | Unbounded — no timeout, deepest budget, strongest reasoning; **relaxes the correctness/QA gates** (can ship ungrounded output). |

The tier is **per session** (persisted) and seeded by a configurable global default (`effort.default`, Settings → Agents → Orchestration Tuning, or the chat composer). Set it per message with the `--effort low|medium|high|max` override flag, alongside `--auto`, `--iter N`, `--agent NAME`, and `--timeout N`. Per-tier profiles are tunable in config (`effort.profiles.<tier>`; built-ins in `runtime/effort-context.ts`). Effort never touches the content-safety/security guardrails — only the orchestration quality/latency behavior.

Model wiring is environment-driven (the setup wizard writes these to `.env`): `SAI_PRIMARY_MODEL` pins the default agent model, `SAI_PRIMARY_MODEL_URL` / `SAI_PRIMARY_MODEL_KEY` point at your primary provider (any OpenAI-compatible server — LM Studio, Ollama, vLLM, llama.cpp, LocalAI, OpenRouter — or a remote box) or `ANTHROPIC_API_KEY` for Claude, and `SAI_MODEL_BACKEND=ollama` (with `SAI_OLLAMA_MODEL`) enables the bundled `docker-compose.ollama.yml` local-model overlay. The legacy `SAI_DEFAULT_MODEL` / `SAI_LMSTUDIO_URL` / `SAI_LMSTUDIO_API_KEY` names still work as aliases.

---

## Documentation

| Document | Purpose |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | System layout, swarm principles, and runtime boundaries |
| [docs/api.md](docs/api.md) | REST, WebSocket, scene job, approval, and A2A interfaces |
| [docs/channels.md](docs/channels.md) | Channel capability matrix and delivery model |
| [docs/channel-setup.md](docs/channel-setup.md) | Channel onboarding and configuration walkthrough |
| [docs/mail-service.md](docs/mail-service.md) | Headless mail-service architecture and API |
| [docs/knowledge-bases.md](docs/knowledge-bases.md) | Crawled documentation corpora: crawler scope/safety, storage, retrieval, config, and API |
| [docs/security.md](docs/security.md) | Auth, credential storage, sandboxing, and audit behavior |
| [docs/tool-tiers.md](docs/tool-tiers.md) | Hard-coded tool permission tiers and approval rules |
| [docs/forking.md](docs/forking.md) | Fork StarlingAI into a specialized swarm and stay rebase-clean with upstream |

For setup guides, channel configuration, agent details, and more, see the **[interactive tutorials](http://localhost:3002)** (available after `pnpm sai start`).

---

## License

[Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/)

You are free to share and adapt the material for non-commercial purposes, as long as you give appropriate credit. Commercial use is not permitted without explicit written permission.
