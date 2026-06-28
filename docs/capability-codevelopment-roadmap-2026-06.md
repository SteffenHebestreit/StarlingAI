# Guided Capability Co-Development — Roadmap (June 2026)

> **Question:** can a human and the swarm TOGETHER, in guided stages, co-develop a brand-new
> full-stack capability — and capture it as durable, reusable swarm machinery?
> **Running example:** a "map" capability — (A) an OpenStreetMap Overpass/Nominatim POI backend,
> (B) a Leaflet/OSM frontend, (C) persisted as reusable workflows/agents/tools/skills.
> Maps are only the example; the feature is **general** guided capability co-development.
>
> Source: a 14-agent analysis workflow (8 subsystem readers → 4 stage gap-analysts → architect
> synthesis → adversarial completeness/correctness critic). Critic verdict: **solid**. Every
> load-bearing current-state claim was independently spot-checked against source.

## Verdict

**Not end-to-end today — but ~80% of the gap is wiring, UX, and persistence glue over subsystems
that already ship.** Only **two** pieces are genuinely net-new (a network-capable connector path,
and a first-class *Project* entity). The single best insight: an external-API connector should be
built as a **served backend** (`backend_coder` + `serve_app`, which already has egress + npm), **not**
a `--network=none` self-dev snippet — a pure routing/prompt change that dissolves the Stage-A blocker.

## Stage health map

| Stage | Have a good flow? | Headline |
|---|---|---|
| **B — Leaflet/OSM frontend** | ✅ yes | `serve_app` (egress + npm install) + `verify_app` + `/api/app/:id/*` live proxy all ship and default-on. Strongest stage. |
| **A — POI backend connector** | ❌ no | Self-dev tool sandbox is hard-coded `--network=none` → external fetch can't pass tests OR run; both master flags default off. **Fix = reframe as served backend.** |
| **C — persist as reusable** | ⚠️ partial | Skill persists free; self-dev tool persists if flags on; but a durable **agent** + **scene/job** need a maintainer hand-editing `workspace/**.jsonc` + `config build`. No swarm-callable shard writer. `saveScene` was lossy. |
| **D — guided multi-stage** | ❌ no | No first-class Project entity. `TurnPlan` is single-turn/4h-TTL/overwritten; plan-approval default-off + raw-JSON UI; `ask_user` was granted to no agent. |

### Verified current-state facts (the load-bearing ones)
- Self-dev sandbox egress: `shell.ts:75` `--network=none`. `serve_app` egress: `serve-app.ts:117,171` (`starlingai-public` + npm install).
- Master flags default off: `config/schema.ts:1252` (`toolDevelopment.enabled`), `:1269` (`selfImprovement.enabled`).
- Severed autonomous loop: `startToolDevelopmentForGap` creates a session but never tests/deploys (`agent/self-improve.ts:408-465`); only routing-total-failure records a gap (`tools/sub-agent.ts`).
- `saveScene` lossy: stored only description/task/webhookKey (`credentials/scenes.ts`). `ask_user` / `request_new_capability` / `list_capability_gaps` absent from all grant lists (`agent/default-tools.ts`).
- `ephemeralGeneration.enabled=false` (`workspace/agents/00-platform.jsonc:33`) → autonomous agent-promotion dead.

## North-star flow (what we're building toward)

A user says *"Build me a reusable capability: show points-of-interest near any place on an OSM map."*
The orchestrator opens a **Project** (durable, resumable — not a 4h session slot), uses `ask_user`
to ask blocking questions with clickable choices (OSM+Overpass or hosted? standalone or widget?),
records a **3-stage plan** the human approves as a real plan card. **Stage A:** `backend_coder` +
`serve_app` stand up the POI service with full egress + a real Nominatim User-Agent; `verify_app` +
a browser DOM check confirm `/api/pois` returns data. The human steers mid-run, the project
checkpoints, **they walk away and resume next session at Stage B.** **Stage B:** `web_coder` builds
the Leaflet UI; `browser_snapshot` confirms the map actually painted tiles + markers. **Stage C (new):**
at completion the swarm drafts a **capability bundle** — a `cartographer` agent shard + a `pois_near`
scene + the connector tool + a skill recipe — the human approves **once**, an **in-process config
build** makes them live with no maintainer CLI step. Next week, *"POIs near Berlin"* routes straight
to the cartographer — **reproducible from committed shards, surviving a fresh wipe.**

## Phases

| Phase | Title | Effort | Risk | Depends | Status |
|---|---|---|---|---|---|
| **P0** | Unblock connector (reframe) + reach the gap-loop | M | med | — | ✅ shipped `faac2d4` |
| **P1** | Client-render verification + non-lossy scene store | M | low | — (∥ P0) | ✅ shipped `a2d651f` |
| **P2** | Swarm-callable durable shard authoring + live apply | L | high | P0 | ✅ shipped `c342eee` |
| **P3** | Resumable multi-stage spine | XL→M | high | P2 | ✅ shipped `f5fed13` (via existing job+checkpoint, no new store); typed handoff + dedicated Project store = enhancement |
| **P4** | Staged approval + blocking `ask_user` | L | med | P3 | ◐ backend shipped (P0 `ask_user`/approval); plan-card Vue UI = enhancement |
| **P5** | `capture_capability` + `co_develop_capability` | L | med | P2,P3 | ✅ shipped `f5fed13` |

### P0 — Unblock + reach ✅ shipped (`faac2d4`)
- Grant `request_new_capability` + `list_capability_gaps` + `ask_user` to the orchestrator (all Tier 0/1, no-op-safe). The gap self-report path was unreachable; `ask_user` was plumbed-but-ungranted.
- Connector-as-served-backend reframe: structural predicate in `selectAutoBuildBuilderAgent` (build-architecture nouns + integrate/wrap/query verbs near api/endpoint/service — topic-agnostic) + `tool_developer` retargeted to pure-compute only.
- Files: `agent/default-tools.ts`, `agent/deliverable-intent.ts`, `workspace/agents/20-primary-agents.jsonc`.
- _Deferred from P0 (deliberate):_ the project-scoped flag opt-in and the optional egress-allowed self-dev sandbox mode — the reframe sidesteps the need; revisit only if a pure-compute self-dev tool genuinely needs config/egress (see Non-goals).

### P1 — Prove it painted ✅ shipped (`a2d651f`)
- `verify_app` detects a client-rendered shell and returns "PASS (server) — RENDER UNCONFIRMED" (a JS/tile error leaves the same passing shell; client errors never reach server logs) with `clientRendered`/`renderConfirmed` metadata + a demand to browser_navigate + browser_snapshot/evaluate. `backend_coder` surfaces it honestly (it owns no browser tools; the orchestrator confirms the paint).
- Non-lossy store-backed scenes: `saveScene` now round-trips allowedAgents/params/triggers/expectArtifact as one JSON meta blob (back-compatible); dashboard POST passes them through.
- Files: `tools/serve-app.ts`, `credentials/scenes.ts`, `gateway/index.ts`, `workspace/agents/10-core-agents.jsonc`.

### P2 — Swarm-callable durable shard authoring + live apply ✅ shipped (`c342eee`)
Built `swarm_define_agent` / `swarm_save_scene` / `swarm_save_job` (maintainer-only, approval-gated): validate → write durable `workspace/{agents,scenes,jobs}/50-authored-<name>.jsonc` shard → `validateWorkspaceConfig` cross-ref gate (revert on error) → apply live via `updateConfig` runtime overlay (trips the watcher → agent-index rebuild). Feasibility audit found the deployed gateway runs file-mode (`:ro` compiled config), so the overlay is the only in-container live path; reuses the exported validator + element schemas (no `config-layout.mjs` reimpl). Below is the original plan.

#### Original P2 plan
The single biggest Stage-C unblocker. New `swarm_define_agent` / `swarm_save_scene` / `swarm_save_job`
tools that write **full-schema** JSONC into `workspace/{agents,scenes,jobs}/` shards, zod-validated +
`swarm_validate`-gated + one human approval, granted only to a `swarm_maintainer` (`workspaceAccess:full`).
Plus an **in-process `configBuild()`+reload** so the gateway rebuilds `starlingai.json` from shards live.
- **Critic correction:** `config-layout.mjs` is NOT importable as-is (runs CLI logic on import; merge fns unexported) → P2 must **extract** the deep-merge into an exported pure function, not "reuse" it.
- Files: `tools/self-improve-tools.ts`, `config/loader.ts`, `scripts/config-layout.mjs`, `config/validate-workspace.ts`, `guardrails/tool-tiers.ts`, `agent/default-tools.ts`.
- Validation: `swarm_save_scene` writes a full shard → `swarm_validate` passes → in-process build+reload makes `run_workflow` find it in the SAME process and it survives a fresh checkout. Security: scoped agents can't write outside `generated/`; credential-like keys rejected.

### P3 — Resumable multi-stage spine ✅ shipped the on-principle way (`f5fed13`)
**Key decision:** the existing multi-step **job worker + B31 checkpoint/resume IS the resumable
multi-stage store.** The `co_develop_capability` job's stages are checkpointed job steps, so a crash
or a next-session resume picks up at the next stage — the "resumable project" with **no new Postgres
table** (exactly the critic's "extend SceneJob, don't build a parallel store", taken to its
conclusion). **Enhancements deferred** (not blockers — the flow works without them): the typed
inter-stage handoff (stages currently hand off via the shared session/shared-facts), a dedicated
`/api/projects` surface, and lifting the TurnPlan normalizer into per-stage plans. The original
heavier plan below is retained for reference.

#### Original P3 plan (heavier — deferred)
The cross-stage spine. A `Project` record in Postgres (like SceneJob) with `stages[]`
(pending→approved→built→reviewed→persisted), per-stage acceptance criteria, links to produced
artifacts. **Extend** the SceneJob store + B31 checkpoint/resume — do NOT build a parallel store.
A typed inter-stage handoff (backend URL/route as a structured param to the frontend stage) replaces
free-text plumbing. HTTP + `project_stage_*` audit surface.
- **Critic correction:** served apps are ephemeral (`--rm`); Stage-B resume must re-launch `serve_app` from `generated/<app>` or the "resume next session" promise has a hole. The typed handoff is independently valuable and could land before the full entity.
- Files: `agent/jobs.ts`, `agent/scene-worker.ts`, `agent/turn-plan.ts`, `gateway/index.ts`, `audit/schema.ts`.

### P4 — Staged approval UX + blocking clarify (planned)
Make approve-as-you-go and stop-and-ask real. `ask_user` is now granted (P0) — add a real plan/stage
card in the web UI (replace the raw `JSON.stringify` dump in `Chat.vue`), per-stage `planApproval`
reusing the existing `approvalCallback`, and wire Project stage boundaries to pause/resume on approval.
- Files: `agent/runtime.ts`, `packages/web/src/pages/Chat.vue`, `OperatorRequestsDock.vue`, `tools/turn-plan-tool.ts`, `config/schema.ts`.

### P5 — Capture-as-machinery + the guided job ✅ shipped (`f5fed13`)
Shipped as workspace shards (on-principle: use-case machinery lives in workspace, not core): the
`capture_capability` scene (swarm_maintainer turns what was built+verified into durable machinery via
the P2 tools — bundle composition decided from what exists, not a fixed quadruple) and the
`co_develop_capability` job (build+verify backend → build+verify frontend → capture). `config build`
merges cleanly; all cross-refs resolve. Below is the original plan.

#### Original P5 plan
A `capture_capability` transaction that, given a completed Project, drafts a **capability bundle** and
persists all parts atomically via the P2 authoring tools + `writeSkill`. A general `co_develop_capability`
job sequences clarify+plan+approve → build+review backend → build+review frontend → capture. A persist-stage
QA gate (config-side sibling of `verify_app`) runs `swarm_validate` + a smoke `run_workflow` before done.
- **Critic correction (anti-overfit):** the bundle COMPOSITION (which artifact kinds) must be **plan-derived per project**, not a fixed agent+scene+tool+skill quadruple — a weather capability might need no separate agent.
- Validation: a single guided project for a **non-map** capability (weather-near-X) ends with a committed agent+scene+tool+skill a fresh turn discovers via `run_workflow`, surviving a config split round-trip.

## Quick wins (status)
- ✅ Grant `request_new_capability` + `list_capability_gaps` to the orchestrator (P0).
- ✅ Grant `ask_user` + (lean) rely on its self-describing tool description, no prompt bloat (P0).
- ✅ Connector-as-served-backend reframe (P0).
- ✅ `verify_app` client-render honesty (P1).
- ✅ Non-lossy `saveScene` (P1).

## Non-goals (explicitly descoped)
- **Full autonomy of the capability-gap loop.** The severed driver (`startToolDevelopmentForGap`
  creates a session but never tests/deploys) and its narrow trigger (routing-total-failure only) are
  real, but the user asked for **guided**, not autonomous, co-development. Re-wiring full autonomy is a
  later, optional follow-up — never a P0–P5 dependency.
- **Passing config to sandboxed self-dev tools** (base URLs, a Nominatim User-Agent, optional keys)
  past the blanket `process.env` ban. The connector reframe (served backend) sidesteps this for the
  connector case; a genuinely-sandboxed pure-compute tool that needs runtime config stays out of scope.

## Risks
- **P2 is highest-leverage AND highest-risk:** a malformed/malicious shard write could corrupt live config. Mitigation: mandatory `swarm_validate` gate + human approval + `workspaceAccess:full` only + the existing `NON_CONFIG_WORKSPACE_ZONES` guard.
- **P3 is XL and tempting to over-engineer** into a new store. Hold the line: extend SceneJob + B31 checkpoint/resume.
- **Any flag opt-in must be project-scoped, not a global default-on** — the default-off flags protect against autonomous tool-building.
- `serve_app` requires the dockerized gateway with docker-socket access; a bare-node deploy silently loses the served path. Hard prerequisite.
- `verify_app` browser DOM checks add a flaky external dependency; keep the server-side status+log check as the baseline and the DOM assertion additive so a browser-tool outage degrades gracefully.

## Anti-overfit
Every roadmap piece is a **general** capability-co-development primitive; nothing encodes "map",
"Leaflet", "Overpass", or "POI" in core. The connector reframe keys off structural phrasing via the
existing topic-agnostic `selectAutoBuildBuilderAgent`; the render check applies to any interactive/canvas
app; the shard-authoring tools, Project entity, staged approval, and `capture_capability` are use-case-
neutral. The only map-specific shapes (a cartographer agent, a `pois_near` scene, an OSM connector tool)
are authored at runtime INTO `workspace/{agents,scenes,jobs}/` shards by the swarm — exactly where
use-case-specific machinery belongs — never into core routing or the tool catalog. P5 validation uses a
non-map example to force generality.
