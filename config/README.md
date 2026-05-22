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

## Skill Library & Tool Pipeline

Two feature sections control the self-improving procedural-memory layer. Both can be edited in the dashboard under **Settings → Agents → Skill Library & Automation**, or in config:

```jsonc
{
  // Procedural memory: swarm-authored, self-improving SKILL.md procedures.
  "skillLibrary": {
    "enabled": true,            // retrieve + inject "Learned Procedures" at planning time
    "autoAuthor": true,         // distill skill drafts from successful multi-step turns
    "minStepsToAuthor": 3,      // min delegations in a turn before auto-authoring
    "maxInjected": 3,           // max skills injected into the planner prompt per turn
    "retireBelowSuccessRate": 0.34, // archive skills below this success rate…
    "retireMinUses": 5,         // …once they have at least this many recorded uses
    "autoPromoteToScene": true  // promote consistently reliable skills to workflow scenes
  },
  // Batched, guarded tool execution.
  "toolPipeline": {
    "enabled": true,            // allow run_tool_pipeline for agents granted the tool
    "maxSteps": 8,              // max steps in one pipeline
    "maxTemplateOutputChars": 4000 // cap on a prior step's output substituted into later args
  }
}
```

Skills are workspace-scoped under `.starlingai/skills/<slug>/SKILL.md` (gitignored). Authoring is automatic via the distiller, and any agent granted `record_skill` can author explicitly; recall/curation tools (`search_skills`, `search_sessions`, `curate_memory`) and `run_tool_pipeline` are granted per-agent in `workspace/agents/`. Every pipeline step still passes the normal tier + approval checks **and** is restricted to the calling agent's own tool allowlist.

## Main-Assistant Routing

```jsonc
{
  "agents": {
    "mainAssistant": {
      "toolMode": "orchestration_only", // hybrid | orchestration_only | delegate_only
      "trustModelRouting": true          // see below
    }
  }
}
```

- **`trustModelRouting`** (default `true`) — trusts the model's own decision to answer a turn directly. The weak, false-positive-prone **freshness** keyword heuristic (`jetzt`/`now`/`latest`) no longer *forces* delegation; it stays as advisory guidance in the turn prompt. **Source-sensitive** intent — explicit `cite official sources`, `search online`, product/hardware research — still forces delegation for anti-hallucination value. Set `false` to also force delegation on freshness signals (the stricter, legacy behavior).
- Regardless of this flag, a turn **never ends empty**: if the model is nudged to delegate but still answers directly, its draft is released (after the security output scan + redactor) rather than being blocked.

## How it works

The config loader reads `.json` and `.jsonc` files recursively in **lexicographic** path order, then deep-merges them. Prefix filenames with numbers (e.g. `10-`, `20-`) to control merge order.

After loading `config/`, the loader merges in `workspace/` (agent-mutable zone) on top, then applies `workspace/runtime/runtime.overrides.json` as the final overlay.

Run `pnpm sai config build` to compile everything into the root `starlingai.json` artifact that Docker mounts.

The repository root should stay limited to entrypoints, compose files, core docs, and compiled artifacts. Helper scripts belong under `scripts/` or `scripts/devtools/`, and generated reports belong under `artifacts/`.

## Gateway Reverse Proxy Note

When the dashboard calls the gateway from a different browser origin, add that dashboard origin under `gateway.corsAllowedOrigins` in `config/gateway/*.jsonc`. The origin from `gateway.publicUrl` is also accepted automatically.
