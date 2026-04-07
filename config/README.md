# StarlingAI — Infrastructure Config

This directory holds the **user-managed** configuration that defines how StarlingAI connects to providers, channels, tooling and external services. The agent swarm **cannot** modify files in this directory.

## Structure

| Folder | What it configures |
|---|---|
| `providers/` | Model backends — LM Studio, Ollama, Anthropic, OpenAI-compatible |
| `gateway/` | Gateway port / bind, guardrails, sandbox policy |
| `channels/` | Messaging — webchat, Telegram, Slack, Discord, WhatsApp, Email, Signal |
| `infrastructure/` | Proxmox, Terraform, Ansible, SSH targets |
| `multimodal/` | File handling, STT, TTS, image generation service URLs |
| `integrations/` | n8n, webhooks, sites, approval channels, workspace path |
| `tooling/` | Retrieval, computer-use adapters, pentest scope, MCP servers |

## How it works

The config loader reads `.json` and `.jsonc` files recursively in **lexicographic** path order, then deep-merges them. Prefix filenames with numbers (e.g. `10-`, `20-`) to control merge order.

After loading `config/`, the loader merges in `workspace/` (agent-mutable zone) on top, then applies `workspace/runtime/runtime.overrides.json` as the final overlay.

Run `pnpm sai config build` to compile everything into the root `starlingai.json` artifact that Docker mounts.

The repository root should stay limited to entrypoints, compose files, core docs, and compiled artifacts. Helper scripts belong under `scripts/` or `scripts/devtools/`, and generated reports belong under `artifacts/`.

## Gateway Reverse Proxy Note

When the dashboard calls the gateway from a different browser origin, add that dashboard origin under `gateway.corsAllowedOrigins` in `config/gateway/*.jsonc`. The origin from `gateway.publicUrl` is also accepted automatically.
