# StarlingAI — Agent Workspace

This directory holds configuration that the **agent swarm can self-tune** at runtime. The config-assistant and dashboard write changes here.

## Structure

| Folder | What it configures |
|---|---|
| `agents/` | Main assistant settings, sub-agent definitions (prompts, models, capabilities) |
| `jobs/` | Operator-managed reusable job definitions exposed by the dashboard/API |
| `scenes/` | Named workflow / mission definitions |
| `runtime/` | `runtime.overrides.json` — live overrides written by the config-assistant |

## How it works

Files here are merged on top of `config/` (infrastructure zone) during config loading. The agent can propose and apply changes to paths under `agents`, `subAgents`, and `scenes` via the config-assistant. Changes are persisted to `runtime/runtime.overrides.json`.

`jobs/` lives in the workspace because it is durable operator data, but it is not part of the config-assistant mutable allowlist.

Protected paths (providers, gateway, guardrails, channels, credentials, etc.) are structurally blocked — the agent cannot modify infrastructure config.
