# Fork-Boilerplate Refactor — Design & Roadmap

> Status: **in progress** (started 2026-06-13).
> Goal: make StarlingAI a clean boilerplate for specialized swarm forks
> (reference fork: MFA-AI). A fork should express **all** of its
> specialization through fork-owned surfaces that upstream never touches, so
> `git rebase upstream/develop` (or a merge) is conflict-free by construction.

## Why

The MFA-AI fork currently diverges from upstream v0.33.0 by **65 modified +
12 deleted + 50 added files** inside `packages/`. Every upstream release
costs a manual cherry-pick / read-tree merge session. Auditing the diff shows
the modifications fall into a small number of recurring causes — each one is
a missing extension point in upstream:

| # | Fork change pattern | Today's mechanism | Files hit |
|---|---------------------|-------------------|-----------|
| 1 | Product identity (`.starlingai` state dir → `.mfa-ai`, `starlingai.json` → `mfa-ai.json`, `STARLINGAI_*` env → `MFA_AI_*`, app name/tagline/theme) | String literals hardcoded in ~110 core files + web shell | config/loader, plugin/loader, gateway/auth, audit/logger, credentials/store, App.vue, dozens of tests |
| 2 | Remove unwanted built-in tools (pentest, ssh, proxmox, terraform, ansible, service-check) | Delete the files + edit `index.ts` side-effect imports | 12 deletions, guaranteed conflict on every upstream touch |
| 3 | Add domain tools (25 × `mfa-*` tools) | New files + edit `index.ts` imports + edit `guardrails/tool-tiers.ts` tier map | index.ts, tool-tiers.ts |
| 4 | New audit event types | Edit the `AuditEventType` union in `audit/schema.ts` | audit/schema.ts |
| 5 | New roles (patient/mfa/doctor/admin) + RBAC | Edit `auth/roles.ts`, `gateway/auth.ts`, `gateway/middleware.ts`, web `stores/auth.ts` | 4+ files |
| 6 | New gateway API routes (knowledge freshness, user mgmt, approvals) | Edit `gateway/index.ts` (+398 lines) | gateway/index.ts |
| 7 | Boot/lifecycle work (billing graph schema, knowledge-base load, billing context) | Edit `main()` in `index.ts` | index.ts |
| 8 | Domain guardrails (medical, billing, PII redactor) | New files + wire into guardrail pipeline | guardrails/input.ts etc. |
| 9 | Web pages (`/mfa/*`), nav entries, role badges, theme | New `.vue` files + edit `router/index.ts`, `App.vue`, `stores/auth.ts`, `style.css` | 4 shared web files |
| 10 | Config schema additions (praxis type, knowledge sources) | Edit `config/schema.ts` | schema.ts |
| 11 | Workspace content (agents/jobs/scenes/knowledge) | Numbered JSONC overlay files — **already conflict-free** | none ✓ |

Pattern 11 is the model: fork-owned files that upstream's loader discovers by
convention. The refactor extends that model to code.

## Target architecture

A fork owns exactly **four surfaces**; upstream guarantees it never ships
files at those paths (beyond documented examples):

```
fork repo
├── product.json                       ← identity: name, slug, state dir, env prefix, theme
├── packages/core/src/extensions/      ← in-process trusted extensions (TS, compiled with core)
│   └── mfa/
│       ├── index.ts                   ← defineCoreExtension({ tools, tiers, roles, routes, guardrails, boot… })
│       └── …domain code…
├── packages/web/src/extensions/       ← web extension modules (routes + nav + theme), glob-discovered
│   └── mfa/…
└── workspace/                         ← agents / jobs / scenes / knowledge overlays (existing mechanism)
```

(Core extensions live inside `packages/core/src/` rather than at the repo root
so they compile with core's existing tsconfig — zero build wiring. Upstream
ships only `extensions/README.md` + the dormant `_example/`.)

Everything else is upstream-owned. The fork's git history on top of upstream
touches only these paths → rebase/merge never conflicts.

### WS1 — Product identity module (`packages/core/src/product/`)

Single source of truth for every identity string, loaded synchronously at
module init from `product.json` at the repo root (falling back to built-in
StarlingAI defaults when absent — upstream itself ships **no** product.json):

```jsonc
// product.json (fork-owned; upstream has none)
{
  "name": "MFA-AI",
  "slug": "mfa-ai",
  "tagline": "Medizinische Fachangestellte",
  "stateDirName": ".mfa-ai",
  "configFileName": "mfa-ai.json",
  "envPrefix": "MFA_AI",
  "legacyStateDirNames": [".starlingai"],   // migration fallbacks
  "legacyEnvPrefixes": ["STARLINGAI"],
  "webTheme": { "accent": "sky", … }
}
```

Exports: `PRODUCT` (the resolved identity), `productEnv("PLUGINS_DIR")`
(checks `<PREFIX>_PLUGINS_DIR` then legacy prefixes), path helpers for
home/workspace state dirs. All `.starlingai` / `STARLINGAI_` /
`starlingai.json` literals in core are replaced by these exports; web reads
identity + theme from a new `GET /api/product` endpoint with StarlingAI
defaults at build time.

### WS2 — Tool groups + config-driven disabling

Every built-in tool registration declares a `group`
(`infrastructure`, `pentest`, `observability`, `office`, …). New config:

```jsonc
{ "tools": { "disabledGroups": ["pentest", "infrastructure"], "disabledTools": [] } }
```

Disabled tools are skipped at registration. Forks stop **deleting** upstream
files (deletions are the worst rebase conflict source) and disable via
config. MFA-AI will restore the 12 deleted files in its migration.

### WS3 — Core extension SDK (`extensions/` at repo root)

Distinct from the existing **runtime plugin SDK** (`~/.<product>/plugins`,
Tier-2-only, per-call approval, for end users). Extensions are *first-party
fork code*: TypeScript, type-checked and compiled with core, trusted.

`defineCoreExtension({...})` manifest registers, in one place:

- `tools` — with explicit tier definitions (extensions are trusted; tier map
  merges into `tool-tiers`)
- `auditEvents` — namespaced (`mfa.patient_data_accessed`); `AuditEventType`
  widens to accept `<ext>.<event>` template-literal types
- `roles` — role definitions + capability flags consumed by gateway RBAC and
  surfaced to web via `/api/product`
- `guardrails` — input/output/tool-call pipeline hooks appended after built-ins
- `routes(app, ctx)` — mounts gateway API routes under a namespace
- `configSchema` — zod schema mounted at `extensions.<name>` in the config
- `boot(ctx)` / `shutdown()` — lifecycle hooks (db schema init, KB load, …)

Discovery: at boot, core scans the compiled `extensions/*/` output and
imports each module — forks add a directory, never edit `index.ts`.

### WS4 — Web extension points

- `packages/web/src/extensions/*/index.ts` discovered with
  `import.meta.glob`; each exports `routes` (RouteRecordRaw[]) and `nav`
  entries (label, icon, path, requiredRole). Router and App-shell nav render
  from the merged registry.
- Branding (name, tagline, logo, accent palette) comes from `/api/product`
  → CSS custom properties; `App.vue` contains no product-specific markup.
- Role display metadata (badge labels/colors per role) is served by the role
  registry, not hardcoded in `stores/auth.ts`.

### WS5 — Service-communication path (out-of-process specialization)

For heavy or independently-deployable domain capabilities (e.g. MFA's
medBERT NER service), document and prefer the **sidecar** pattern over
in-process code:

- expose the capability as an **MCP server** (tools) or **A2A peer**
  (delegated tasks, agent card discovery via `/.well-known`) — both already
  exist in core (`src/mcp`, `src/a2a`, `src/federation`);
- register it purely via config (`a2a.peers`, MCP server entries) — zero
  code in either repo;
- docker-compose overlay files (`docker-compose.<fork>.yml`) instead of
  editing the base compose file.

### WS6 — Fork docs + drift tooling (upstream-owned)

- `docs/forking.md` — the step-by-step "create a specialized swarm" guide:
  fork → write `product.json` → scaffold an extension → add workspace
  overlays → disable unwanted tool groups → update loop
  (`git fetch upstream && git rebase upstream/develop`).
- Generalize MFA-AI's `scripts/check-upstream.mjs` (patch-equivalence drift
  report) and ship it upstream so every fork gets it.
- `extensions/example/` — a tiny documented sample extension kept green by CI.

### WS7 — MFA-AI migration (after WS1–WS6 land + fork syncs)

1. Sync fork to the refactored upstream (existing cherry-pick/read-tree
   recipe, one last time).
2. Add `product.json`; revert all identity edits in upstream files.
3. Restore the 12 deleted infra/pentest files; add `tools.disabledGroups`.
4. Move `mfa-*` tools, tiers, guardrails, roles, audit events, gateway
   routes, boot hooks into `extensions/mfa/`.
5. Move `/mfa/*` pages + nav into `packages/web/src/extensions/mfa/`;
   delete edits to `App.vue` / `router` / `stores/auth.ts` / `style.css`.
6. Verify: `git diff upstream/develop` touches only fork-owned paths;
   dry-run a rebase; full test suite.

## Execution order

| Step | Scope | Status |
|------|-------|--------|
| 1 | Plan + recon (this doc) | ✅ 2026-06-13 |
| 2 | WS1 product module + core literal sweep incl. tests + `GET /api/product` | ✅ e73f8fe |
| 3 | WS1 web-shell branding from /api/product | pending (waits for in-flight App.vue work to land) |
| 4 | WS2 tool groups + config | ✅ b565554 |
| 5 | WS3 extension SDK + discovery + example + guardrail hooks | ✅ (this commit) |
| 6 | WS4 web extension points | pending |
| 7 | WS5+WS6 docs (forking.md), drift script, compose overlays | pending |
| 8 | WS7 MFA-AI migration | pending |
| 9 | End-to-end verification: build, tests, rebase dry-run in MFA-AI | pending |

## Non-goals

- Rewriting MFA-AI git history. The clean-rebase property starts at the
  migration commit; older history keeps using the documented sync recipe.
- Moving the runtime plugin SDK (Tier-2 user plugins) — it stays as-is;
  extensions are a separate, trusted tier.
- Web micro-frontends / module federation — build-time glob discovery is
  enough; forks compile their own web bundle anyway.
