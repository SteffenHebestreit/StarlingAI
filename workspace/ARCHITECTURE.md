# StarlingAI Configuration Architecture

This document is the canonical map of how **agents**, **tools**, and **scenes / jobs / workflows**
are organized, and the separation-of-concerns rules that keep the swarm predictable. It complements
[`README.md`](./README.md) (which covers the agent-mutable zone and authoring workflows).

## 1. Two config zones → one built file

| Zone | Path | Who owns it | Contains |
|---|---|---|---|
| Infrastructure | `config/` | Operators only (structurally blocked from the agent) | providers, gateway, guardrails, channels, multimodal, integrations, platform/tooling |
| Agent-mutable | `workspace/` | Operators **and** the self-improvement agents | `agents/`, `scenes/`, `jobs/`, `runtime/` |

`node scripts/sai.mjs config build` (alias `pnpm config:build`) **globs every `*.jsonc` shard** in
`config/` then `workspace/` and deep-merges them into the root `starlingai.json` that the runtime
loads. Because build is glob-based, the file layout below is free to evolve — add or rename role
shards without touching the loader. `config split` is the inverse (regenerate shards from a monolith)
and is kept consistent with this layout via `AGENT_ROLE_FILES` in `scripts/config-layout.mjs`.

**Deploy:** `sai start --build` (rebuilds core + regenerates `starlingai.json`).

## 2. Agents — `workspace/agents/`

Wrapper keys matter: `10-core-agents.jsonc` uses `"agents"` (the **main assistant** + `defaults` +
`ephemeralGeneration` + `rateLimit` — platform config, *not* sub-agents). **Every sub-agent shard
uses `"subAgents"`.**

Sub-agents are sharded by **role**:

| File | Role | Agents |
|---|---|---|
| `10-core-agents.jsonc` | Platform config | `mainAssistant`, `defaults`, `ephemeralGeneration`, `rateLimit` |
| `21-orchestration.jsonc` | Orchestration & planning | `mission_coordinator`, `web_task_coordinator`, `devops_coordinator`, `project_planner`, `agent_factory` |
| `22-research-analysis.jsonc` | Research & analysis | `researcher`, `evidence_analyst`, `data_analyst`, `research_librarian`, `document_intake`, `log_analyst`, `finance_analyst`, `distance_specialist` |
| `23-authoring-content.jsonc` | Authoring & content | `content_writer`, `paper_author`, `meeting_briefing_agent`, `summarizer`, `translator`, `diagram_designer`, `chart_designer`, `image_creator`, `image_sourcer` |
| `24-engineering.jsonc` | Engineering | `coder`, `code_analyst`, `test_generator`, `diff_reviewer`, `integration_builder`, `api_integrator`, `git_developer`, `sql_specialist` |
| `25-infra-ops.jsonc` | Infrastructure & ops | `shell_agent`, `infrastructure_agent`, `ops_triage` |
| `26-web-browser.jsonc` | Web & browser | `browser_agent`, `vision_browser_analyst`, `accessibility_tester`, `computer_use_agent` |
| `27-quality-review.jsonc` | Quality & review | `qa_guard`, `quality_supervisor`, `source_verifier`, `policy_compliance_reviewer`, `contract_analyst` |
| `28-comms-productivity.jsonc` | Communications & productivity | `notification_agent`, `mail_agent`, `calendar_agent`, `productivity_agent` |
| `29-platform.jsonc` | Platform & self-improvement | `swarm_maintainer`, `tool_developer`, `prompt_optimizer`, `agent_architect` |
| `30-subagents-pentest.jsonc` | Pentest (profile-gated) | `pentest_coordinator`, `recon_agent`, `web_auditor_agent`, `network_auditor_agent`, `exploit_agent`, `report_writer_agent` |

To locate an agent's shard, grep its name across `agents/*.jsonc`.

### Separation of concerns (the contract)

Each role holds **only** the tools its concern needs. The load-bearing rule, and the one most worth
enforcing, is that **coordinators orchestrate; they never author or persist deliverables**:

| Role | Holds (tools) | Must NOT hold | Why |
|---|---|---|---|
| **Orchestration** | `delegate_to_agent`, `parallel_delegate`, `run_task_graph`, `run_workflow`, `create_ephemeral_agent`, `read_shared_facts`, `share_finding`, read-only context (`read_file`, `list_files`, `workspace_search`, `search_*`) | **Artifact-authoring tools** (`write_file`, `generate_document`, `generate_website`, `generate_presentation`, `generate_pdf/docx/pptx`, `export_workspace_artifact`) | A coordinator that tries to emit a large document inline truncates on the slow local model and wastes the turn (audit `5fec8427`). It must delegate authoring to an author specialist. |
| **Authoring & content** | The artifact-authoring tools above (with chunked/append discipline built for the slow model) | — | The **only** agents that persist large deliverables. |
| **Research & analysis** | `web_search`, `web_fetch`, `url_inspect`, research notes/graph tools, `share_finding` (+ `write_file` for *notes*, not the deliverable) | the final user-facing deliverable | Gather evidence and publish it; an author turns it into the deliverable. |
| **Engineering / Infra-ops** | code/shell/VCS execution tools (`write_file`/`edit_file` are their execution output) | — | Their file writes *are* the work product (code, configs). |
| **Quality & review** | read-only inspection (`read_file`, `read_shared_facts`, `workspace_search`) + `share_finding` | authoring/execution tools | They judge work products; they don't re-author them. |

Author-primary specialists may hold a single `delegate_to_agent` for one scoped sub-task (e.g.
`paper_author` delegates a research gather when its evidence ledger is thin) — that is correct, not a
coordinator. Keep every agent's `tools` array minimal (no over-permissioning) and aligned with its row.

## 3. Tools — `packages/core/src/tools/` (code, not config)

Tools are **TypeScript modules** registered with `registerTool(...)`; they are *not* defined in
workspace config. The runtime exposes their schemas to agents. They are organized by domain file —
e.g. `filesystem.ts` (`read_file`/`write_file`/`edit_file`/`export_workspace_artifact`),
`document-output.ts` (`generate_document`/`generate_pdf`), `website.ts`
(`generate_website`/`generate_presentation`), `web.ts` (`web_search`/`web_fetch`/`fetch_image`),
and `sub-agent.ts` (the orchestration tools).

An agent's `tools` array in its shard **selects** which registered tools it may call. Tools carry a
tier/cost/latency hint; Tier 0/1 read-only tools run in-process, higher tiers are sandboxed or
approval-gated. New tool code → `tool_developer`; never invent tool names in a shard.

## 4. Scenes, jobs & workflows — `workspace/scenes/`, `workspace/jobs/`

- **Scene**: a reusable agent-pipeline **template** — `description`, `task` (the orchestration
  recipe), `allowedAgents` (bounds routing), `params`, optional `humanInLoopSteps`.
- **Job**: an ordered chain of **scene steps** with `triggers` (scheduled or keyword).
- **"Workflow"** is the umbrella term for scenes + jobs surfaced through `search_workflows` /
  `run_workflow`.

Both `scenes/` and `jobs/` are **sharded by category** (same numbering on each side):
`10-research.jsonc` · `20-content-media.jsonc` · `30-engineering-data.jsonc` ·
`40-ops-comms.jsonc`. `build` globs them; `config split` reshards them via
`SCENE_CATEGORY_FILES` / `JOB_CATEGORY_FILES` (unmapped → `90-uncategorized.jsonc`).

Scenes encode the **same separation of concerns** via `allowedAgents` — the canonical pipeline is
**gather → author → review**:

```
research/gather   →   author              →   quality gate
researcher,           content_writer,         quality_supervisor,
evidence_analyst,     paper_author,           source_verifier,
data_analyst          meeting_briefing_agent  qa_guard
```

e.g. `source_backed_paper` (document_intake → evidence_analyst → **paper_author** → source_verifier →
qa_guard), `content_creation` (researcher → **content_writer** → quality_supervisor),
`deep_research` / `competitive_analysis` (**mission_coordinator** orchestrates; **paper_author**
authors). A standalone coordinator delegates authoring the same way a scene routes it.

## 5. Changing config safely

1. Edit the relevant shard (the smallest targeted change — never regenerate a whole file).
2. `swarm_validate` (JSON syntax + schema + reference integrity: scenes→agents, jobs→scenes, agents→tools).
3. `pnpm config:build` to regenerate `starlingai.json`.
4. `sai start --build` to deploy.

Tests assert agent prompt/tool **content** by merging `agents/*.jsonc` (see
`config-loader.test.ts` / `workspace-catalog.test.ts`), so they are layout-agnostic — adding a role
shard does not require touching them.
