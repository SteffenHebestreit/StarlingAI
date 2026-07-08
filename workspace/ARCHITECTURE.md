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
shards without touching the loader. `config split` is the inverse (regenerate shards from a monolith):
it **derives placements from the current on-disk shards** (falling back to the hardcoded seed maps in
`scripts/config-layout.mjs` only for a fresh migration), routes any unrecognized top-level key to
`config/misc/90-uncategorized.jsonc`, and so is **content-lossless** (verified via a split→build
round-trip). Two caveats: it re-emits plain JSON, so it **strips all JSONC comments**, and it
overwrites the whole tree — so it **refuses to run against an existing layout without `--force`**.
Normal editing is hand-editing shards + `sai config build`; reserve `split` for migrating a flat config.

**Deploy:** `sai start --build` (rebuilds core + regenerates `starlingai.json`).

## 2. Agents — `workspace/agents/`

Wrapper keys matter: `00-platform.jsonc` uses `"agents"` (the **main assistant** + `defaults` +
`ephemeralGeneration` + `rateLimit` — platform config, *not* sub-agents). **Every sub-agent shard
uses `"subAgents"`.**

Sub-agents are sharded by **role**:

| File | Role | Agents |
|---|---|---|
| `00-platform.jsonc` | Platform config | `mainAssistant`, `defaults`, `ephemeralGeneration`, `rateLimit` |
| `10-core-agents.jsonc` | Core specialists (16) | `mission_coordinator`, `web_task_coordinator`, `project_planner`, `researcher`, `evidence_analyst`, `summarizer`, `content_writer`, `coder`, `web_coder`, `backend_coder`, `code_analyst`, `git_developer`, `shell_agent`, `quality_supervisor`, `qa_guard`, `diff_reviewer` |
| `20-primary-agents.jsonc` | Primary specialists (19) — pentest, browser/desktop, infra/ops, comms, self-improvement | `pentest_coordinator`, `recon_agent`, `web_auditor_agent`, `network_auditor_agent`, `exploit_agent`, `report_writer_agent`, `pentest_qa_validator`, `browser_agent`, `vision_browser_analyst`, `computer_use_agent`, `infrastructure_agent`, `ops_triage`, `devops_coordinator`, `mail_agent`, `calendar_agent`, `notification_agent`, `swarm_maintainer`, `tool_developer`, `prompt_optimizer` |
| `30-secondary-agents.jsonc` | Secondary specialists (13) — analysis, authoring, visuals, integration, review | `data_analyst`, `log_analyst`, `document_intake`, `paper_author`, `meeting_briefing_agent`, `diagram_designer`, `chart_designer`, `image_creator`, `image_sourcer`, `api_integrator`, `sql_specialist`, `source_verifier`, `policy_compliance_reviewer` |

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

Both `scenes/` and `jobs/` are **sharded by tier**: `10-core-scenes.jsonc` · `20-primary-scenes.jsonc` ·
`30-secondary-scenes.jsonc` · `40-capability-codev.jsonc` · `50-profile-fit.jsonc` (scenes), and
`10-core-jobs.jsonc` · `20-primary-jobs.jsonc` · `30-secondary-jobs.jsonc` · `40-capability-codev.jsonc`
(jobs — no `50-` shard). `build` globs them; `config split` reproduces this layout by deriving each
scene/job's shard from the current files (see §1), so it round-trips the on-disk tiers.

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

## 6. Memory vault — the reviewable Markdown layer

Durable memory lives as one JSON file per key under `<workspace>/.starlingai/memory/` (workspace
scope) and `SAI_USER_MEMORY_PATH` / `~/.starlingai/user-memory/` (user scope); skills are already
portable `SKILL.md`. Under `auth.enabled` the user-scope stores (user memory, the dialectic
user-model, and the personality override) are partitioned per authenticated user to
`<base>/users/<userId>/` (`runtime/user-scope.ts`); with auth disabled — the default — they stay at
the single shared path unchanged. The **memory vault** (`packages/core/src/memory/vault.ts`) mirrors all of that
into an **Obsidian-style Markdown vault** so a human can review, correct, and git/iCloud back up agent
memory in a plain-Markdown tool they trust — the same "Obsidian is the reviewable layer; memory stays
the execution context" split, but the **export is deterministic code** (never the slow local model),
so it can't drift.

```
<workspace>/vault/              (default; CLI can target an external Obsidian path)
  README.md                     index/hub
  memory/workspace/<key>.md     correctable durable facts (frontmatter starlingai_managed: true)
  memory/user/<key>.md
  tags/<tag>.md                 backlink/graph index ([[wikilinks]] to members)
  skills/<slug>.md              read-only mirror of SKILL.md
  sessions/<id>.md              read-only session summaries (best-effort)
```

- **Export** (`memory_export` tool, or `sai memory export [--vault <path>]`) is idempotent: it refreshes
  notes and **prunes** managed notes whose source record is gone.
- **Correction loop** — edit a managed note's body **above** the `%% starlingai:managed-footer %%`
  line, then **import** (`memory_import`, or `sai memory import`) to re-ingest edits (matched by
  `starlingai_key`) into the durable store. Read-only mirrors (`skills/`, `sessions/`, `tags/`) are
  never re-ingested.
- The agent-callable tools keep the vault inside the workspace; the CLI can point at an external vault.
  The `obsidian-vault` skill (seeded on first export) teaches the agent the review/correction loop.
- The default `vault/` is a generated review artifact — add your chosen vault path to `.gitignore`.
