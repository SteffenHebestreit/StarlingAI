<table border="0" cellpadding="0" cellspacing="0" width="100%">
  <tr>
    <td valign="middle" width="25%">
      <img src="swarmLogo.svg" alt="StarlingAI logo" width="100%" />
    </td>
    <td valign="middle" width="75%">
      <strong style="font-size:1.4em;">StarlingAI</strong><br/>
      <sub>GUARDED AGENT SWARM &nbsp;·&nbsp; <em>under development</em></sub>
    </td>
  </tr>
</table>

**A general-purpose AI agent swarm that tackles any task by composing the right specialists — not a collection of one-off pipelines.**

<a href="docs/architecture.md">Architecture</a> ·
<a href="docs/agents.md">Agents</a> ·
<a href="docs/api.md">API</a> ·
<a href="docs/model-serving.md">Model Serving</a> ·
<a href="docs/security.md">Security</a> ·
<a href="docs/pentest.md">Pentesting</a> ·
<a href="docs/strix-halo.md">Strix Halo</a> ·
<a href="QUICKSTART.md">Quick Start</a>

---

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

### Guarded Sandboxing

Every agent runs in an isolated Docker container with `--cap-drop ALL`, `--read-only`, and `--network none` enforced. A four-layer guardrail stack (input scanner → tool-tier check → output scanner → final redactor) ensures speed and autonomy never come at the cost of control.

---

## What StarlingAI Can Do

- **Smart Routing** — Keyword, embedding, and outcome-based ranking surfaces the best specialist for every task. Circuit breakers automatically exclude failing agents.
- **Ephemeral Agents** — When no specialist fits, the swarm architects and launches a purpose-built agent on demand. Successful ones are promoted to the permanent catalog.
- **Parallel Delegation** — Independent sub-tasks run concurrently. Task graphs handle complex dependencies with per-node fallbacks.
- **Collective Memory** — Agents share facts and partial results via a semantic memory layer backed by embeddings. Knowledge built by one agent is available to all.
- **Multimodal Tools** — Speech-to-text, speech synthesis, image analysis, file-to-markdown conversion, browser automation, shell execution, MCP, and webhooks — all behind the same gateway.
- **Human-in-the-Loop** — Approval gates via Slack, outbound webhook, or sync webhook with one-click HTTP callbacks before sensitive actions proceed.
- **Multi-Channel Messaging** — Webchat, Telegram, Slack, Discord, WhatsApp, and email with consistent delivery SLOs, dead-letter queues, and retry with backoff.
- **Warden Monitoring** — A background warden detects tool storms, escape attempts, failure spikes, and SLO breaches in real time.
- **Live Observability** — Token streaming to the dashboard via AG-UI SSE, full per-turn performance telemetry, and a complete audit trail in JSONL + PostgreSQL.
- **Model Routing UI** — The dashboard can now edit separate OpenAI-compatible endpoints for the orchestrator, embeddings, reranker, and guard moderation roles, with live model-advertisement health checks.
- **Scenes** — Reusable workflows launchable from chat, the dashboard, or webhooks and tracked as async jobs.
- **Penetration Testing** — Full Kali Linux toolchain (nmap, nikto, gobuster, sqlmap, hydra, wpscan, sslscan, ffuf, Metasploit and more via `pentest_exec`) wrapped in a scope-enforcing swarm. A mandatory authorization workflow prevents any active scanning without written consent. Partial results are preserved on timeout. Loop detection and tool-suggestion hints prevent agents getting stuck. Findings are compiled into a structured Markdown report.

---

## Quick Start

```bash
git clone https://github.com/SteffenHebestreit/StarlingAI starlingai
cd starlingai
node scripts/setup.mjs   # generates .env secrets (first run only)
cp starlingai.example.json starlingai.json
./start.sh               # builds images + starts all core services
```

Windows CMD: `start.bat`

Open `http://localhost:3001` for the dashboard and `http://localhost:3002` for the interactive setup guide. The gateway listens on `http://localhost:8765`.

The bundled multimodal stack defaults to Qwen3 across the board: Qwen3.5 for agent reasoning, Qwen3-ASR for speech-to-text, and Qwen3-TTS for speech synthesis with optional voice cloning.

### Optional services

```bash
./extras.sh pentest on   # start Kali Linux pentest service
./extras.sh image on     # start image-generation service
./extras.sh all on       # start both
./extras.sh status       # show what's running
```

Windows CMD: `extras.bat pentest on` etc.

> See [QUICKSTART.md](QUICKSTART.md) for detailed setup steps and configuration options.

---

## Documentation

| Document | Purpose |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | System layout, swarm principles, and runtime boundaries |
| [docs/configuration.md](docs/configuration.md) | `starlingai.json` schema and environment variables |
| [docs/model-serving.md](docs/model-serving.md) | Running unsupported Qwen checkpoints on separate OpenAI-compatible servers |
| [docs/agents.md](docs/agents.md) | Agent catalog, routing, ephemeral agents, and evaluation |
| [docs/channels.md](docs/channels.md) | Channel support matrix, policies, runtime behavior, and APIs |
| [docs/channel-setup.md](docs/channel-setup.md) | Practical setup steps for each channel |
| [docs/api.md](docs/api.md) | REST, WebSocket, scene job, approval, and A2A interfaces |
| [docs/security.md](docs/security.md) | Auth, credential storage, sandboxing, and audit behavior |
| [docs/tool-tiers.md](docs/tool-tiers.md) | Hard-coded tool permission tiers and approval rules |
| [docs/pentest.md](docs/pentest.md) | Kali Linux pentest swarm — setup, authorization workflow, tools, and agents |

---

## License

[Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/)

You are free to share and adapt the material for non-commercial purposes, as long as you give appropriate credit. Commercial use is not permitted without explicit written permission.
