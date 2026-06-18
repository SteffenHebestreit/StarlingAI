# Contributing to StarlingAI

## Toolchain

- **Node** ≥ 22.12, **pnpm** 10.6.0 (pinned via `packageManager` in `package.json`; `corepack enable` picks it up).
- pnpm workspace — **do not** create an `npm` `package-lock.json`. The only lockfile is `pnpm-lock.yaml`.

```bash
pnpm install            # install all workspaces
pnpm check              # root-layout guard + typecheck every package (tsc / vue-tsc)
pnpm lint               # eslint flat config — bug-class rules on core + mail-service
pnpm test               # run every package's tests
pnpm build              # production build of every package
pnpm config:build       # compile config/ + workspace/ -> starlingai.json
pnpm config:audit-flags # report config flags defined in schema but never read
```

CI (`.github/workflows/ci.yml`) runs `check`, `lint`, `test`, `build`, and `config:build` on push to `main`/`develop`/`private/**` and on PRs to `main`/`develop`.

### Lint gate

`pnpm lint` runs an [eslint flat config](eslint.config.mjs) (`eslint.config.mjs`) over **production** TypeScript in `@starlingai/core` and `@starlingai/mail-service`. It is a **bug gate, not a style gate**: `error`-level rules are the regression classes — unhandled/floating promises (`no-floating-promises`, `no-misused-promises`), unused imports, empty blocks, constant conditions. Stylistic concerns (`any`, escapes, dead locals, `preserve-caught-error`) are `warn` or off and do not block CI. Tests and the Vue web package are out of scope for now. Errors must be zero; warnings are tracked for incremental cleanup.

### Running tests — important

Always run tests through `pnpm test` (which runs `pnpm -r test`, executing each package's `vitest` **from its own directory**). Several core tests resolve config paths relative to `packages/core`, so running `vitest` from the repo root produces **false** path-resolution failures (`ENOENT … F:\workspace\agents\…`). To run a single core file:

```bash
cd packages/core && pnpm exec vitest run src/tests/<file>.test.ts
```

Tests that are environment-coupled or pending a behavior decision are marked `it.skip` with a `QUARANTINED (DEVPLAN …)` note explaining what to confirm before re-enabling. Don't silently delete them.

### Reliability eval (`pass^k`) before trusting a prompt/agent change

`pnpm agents:evaluate <plan.jsonc> [--baseline base.json] [--repeat k]` runs each case against the live model. Use `--repeat k` (or `repeat` in the plan) to run each case **k times** and report **pass^k** — a case counts only if *every* run passes; one that passes some runs is flagged **flaky**. This is the gate for changes to tuned prompts/routing (e.g. trimming an agent's system prompt): pass@1 hides run-to-run variance, so a single green run is not evidence the change is safe — `pass^k` against a baseline is.

Running it from a checkout needs two env vars (the gateway gets them from `env_file`; the CLI does not):
```bash
cd packages/core
SAI_CONFIG_PATH=<repo>/starlingai.json \  # else it loads a STALE packages/core/starlingai.json (0 sub-agents)
SAI_LMSTUDIO_API_KEY=<key from .env> \    # the generated config carries only the "lm-studio" default
  pnpm exec tsx src/agent/evaluation-cli.ts plan.jsonc out.json --baseline base.json --repeat 5
```
The harness registers the full tool surface (via `tools/register-builtins.js`), so evaluated agents can actually call `write_file`/`generate_document`/etc. The latency-regression check uses the **median** run, so a single cold-start outlier on a small sample is not flagged.

For **file-writing builders** (content_writer, coders), `expectIncludes` only sees the returned summary — add **`expectArtifact`** (`{ path, includes?, minBytes? }`; `path` may be a file or directory) to gate on the PRODUCED files' completeness (catches a dropped/stubbed section a summary would hide). In-process eval only — a `--via-gateway` run writes inside the gateway container, out of the harness's reach. To evaluate web/computer/docker/coordinator agents in their real runtime, use `--via-gateway` (the agent runs through the gateway; output is its returned text, so prefer `expectIncludes`, not `expectArtifact`).

## Branching & releases

Three long-lived branches:

| Branch | Role |
|---|---|
| `main` | Release. Tagged `vX.Y.Z`. Protected — changes land via PR only. |
| `develop` | Integration. Features merge here first. |
| `private/**` | Personal working branches (e.g. `private/local`). |

**Flow:** branch off `develop` → open a PR into `develop` → cut a release by PR from `develop` into `main`, then tag `main`.

**Keep the branches reconcilable.** A past rebase left `main`, `develop`, and `private/local` with the *same logical history under different SHAs*, so a plain `git merge` between them explodes into spurious conflicts and a fix often has to be applied three times (this caused the May 2026 `qwen3.5` model-id outage — the 3.6 migration never reached `main`/`develop`). Until the histories are unified, propagate a change set with **`git cherry-pick`** of just its commits onto each branch, not a full-branch merge. Validate each branch after cherry-picking with `pnpm check && pnpm test`.

## Configuration

- `config/` is operator-owned and the agent swarm cannot modify it; `workspace/` is the agent-tunable zone. The loader merges `config/` → `workspace/` → `workspace/runtime/runtime.overrides.json`.
- `starlingai.json` is a **generated artifact** (gitignored) — never hand-edit it. After changing `config/` or `workspace/`, run `pnpm config:build` and restart the gateway container.
- Model identifiers must be valid for the configured provider (e.g. `lmstudio/qwen3.6-35b-a3b`). A typo or stale id (`lmstudio/qwen/qwen3.5-35b-a3b`) makes the gateway reject every turn with `400 Invalid model identifier`. The CI `config:build` step catches build-time config errors.
- Feature flags `skillLibrary`, `toolPipeline`, and `agents.mainAssistant.trustModelRouting` are documented in [config/README.md](config/README.md).

## Adding capabilities

- **Agents** — define under `workspace/agents/*.jsonc` (description, tags, capabilities, tools, model). Prefer semantic discovery (`search_agents`) over hard-coded names.
- **Scenes / jobs** — `workspace/scenes/` and `workspace/jobs/`; discoverable via `search_workflows` / `run_workflow`.
- **Skills** — authored at runtime (`record_skill` / the distiller) as `SKILL.md` procedures under `.starlingai/skills/`; see [docs/architecture.md](docs/architecture.md).
- **Tools** — register in `packages/core/src/tools/`, and add a tier entry in `guardrails/tool-tiers.ts` (an unlisted tool defaults to BLOCKED and `registerTool` throws at boot).

### Prompts are a map, not a manual

Context is a scarce resource: a long system prompt crowds out the actual task, buries the few constraints that matter among many that don't, and rots as the code moves. So:

- An **agent system prompt** should say *who the agent is, when to act, and which tools/skills to reach for* — not embed a reference manual. Push reusable procedure into **skills** (pulled on demand via `recall_context` / `list_skills`) and use-case-specific deliverable shapes into **scenes/jobs**, leaving the prompt short.
- Keep use-case-specific rules **out of the core runtime and base prompt** — they belong in workspace scenes/agents (the [workflows-not-core principle](docs/architecture.md)).
- Run `pnpm config:audit-prompts` to see per-agent prompt sizes and which exceed the "manual smell" threshold. Trim **deliberately and with eval** — a prompt tuned to prevent a specific failure (e.g. chunked-write discipline) may justify its length; the audit makes the bloat visible, not automatically wrong.

## Commits & PRs

- Conventional-style prefixes: `feat`, `fix`, `chore`, `docs`, `test`, `ci`.
- A PR must pass `pnpm check && pnpm lint && pnpm test && pnpm build` locally before review.
- Root stays tidy — the `check-root-layout` guard rejects stray files at the repo root; put generated output under `artifacts/` and helper scripts under `scripts/`.
