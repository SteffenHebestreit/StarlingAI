# Contributing to StarlingAI

## Toolchain

- **Node** ≥ 22.12, **pnpm** 10.6.0 (pinned via `packageManager` in `package.json`; `corepack enable` picks it up).
- pnpm workspace — **do not** create an `npm` `package-lock.json`. The only lockfile is `pnpm-lock.yaml`.

```bash
pnpm install            # install all workspaces
pnpm check              # root-layout guard + typecheck every package (tsc / vue-tsc)
pnpm test               # run every package's tests
pnpm build              # production build of every package
pnpm config:build       # compile config/ + workspace/ -> starlingai.json
```

CI (`.github/workflows/ci.yml`) runs `check`, `test`, `build`, and `config:build` on push to `main`/`develop`/`private/**` and on PRs to `main`/`develop`.

### Running tests — important

Always run tests through `pnpm test` (which runs `pnpm -r test`, executing each package's `vitest` **from its own directory**). Several core tests resolve config paths relative to `packages/core`, so running `vitest` from the repo root produces **false** path-resolution failures (`ENOENT … F:\workspace\agents\…`). To run a single core file:

```bash
cd packages/core && pnpm exec vitest run src/tests/<file>.test.ts
```

Tests that are environment-coupled or pending a behavior decision are marked `it.skip` with a `QUARANTINED (DEVPLAN …)` note explaining what to confirm before re-enabling. Don't silently delete them.

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

## Commits & PRs

- Conventional-style prefixes: `feat`, `fix`, `chore`, `docs`, `test`, `ci`.
- A PR must pass `pnpm check && pnpm test && pnpm build` locally before review.
- Root stays tidy — the `check-root-layout` guard rejects stray files at the repo root; put generated output under `artifacts/` and helper scripts under `scripts/`.
