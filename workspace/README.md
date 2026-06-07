# StarlingAI — Agent Workspace

This directory holds configuration that the **agent swarm can self-tune** at runtime. The config-assistant and dashboard write changes here.

## Structure

| Folder | What it configures |
|---|---|
| `agents/` | Main assistant settings + sub-agent definitions, **sharded by role** (`21-orchestration`, `22-research-analysis`, `23-authoring-content`, …) |
| `jobs/` | Operator-managed reusable job definitions exposed by the dashboard/API |
| `scenes/` | Named workflow / mission definitions |
| `runtime/` | `runtime.overrides.json` — live overrides written by the config-assistant |

> See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full role taxonomy, the agent→file map, the
> tool organization, and the **separation-of-concerns contract** (coordinators orchestrate; only
> authoring agents persist deliverables).

## How it works

Files here are merged on top of `config/` (infrastructure zone) during config loading. The agent can propose and apply changes to paths under `agents`, `subAgents`, and `scenes` via the config-assistant. Changes are persisted to `runtime/runtime.overrides.json`.

`jobs/` lives in the workspace because it is durable operator data, but it is not part of the config-assistant mutable allowlist.

Protected paths (providers, gateway, guardrails, channels, credentials, etc.) are structurally blocked — the agent cannot modify infrastructure config.

## Creating Workflows

StarlingAI has two reusable workflow layers:

- `scenes/`: one reusable workflow prompt or mission template
- `jobs/`: an ordered chain of scenes with optional triggers

Create a scene when you want one reusable orchestration pattern with a stable goal, stable allowed agents, and optional templated params. Scenes are sharded by category under `workspace/scenes/` (`10-research`, `20-content-media`, `30-engineering-data`, `40-ops-comms`) — add yours to the best-fit shard.

Create a job when you want multiple scenes to run in sequence. Jobs are sharded by the same categories under `workspace/jobs/`.

Scene checklist:

- give it a stable snake_case name
- keep the description short and specific so `search_workflows` can match it
- write the task as the exact orchestration recipe you want reused
- declare `params` for the variable parts instead of hardcoding them
- set `allowedAgents` to keep routing bounded and predictable
- set `humanInLoopSteps` when a step needs approval

Job checklist:

- break the mission into 2-4 clear scene steps
- keep each step label outcome-oriented
- pass only the params each step actually needs
- use a job only when the ordering is intentional and durable

## Improving Workflows

The fastest improvements are usually structural, not prompt-length changes:

- prefer a reusable scene or job over a fresh mission_coordinator plan when the task shape repeats
- split large catch-all workflows into smaller scenes with clearer acceptance criteria
- tighten `allowedAgents` so the orchestrator cannot fan out into unrelated specialists
- move recurring deliverables like papers, briefs, reviews, inspections, and broadcast packets into named scenes/jobs
- keep scene descriptions aligned with the user language you expect, because catalog matching uses names and descriptions heavily
- if a workflow often needs the same review or quality gate, encode that directly in the scene or job instead of hoping the orchestrator remembers it

Practical rule:

- if the task is one reusable pattern, add or improve a scene
- if the task is a repeatable multi-phase packet, chain scenes in a job
