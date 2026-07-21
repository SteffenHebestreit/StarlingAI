# Forking StarlingAI — build a specialized swarm

StarlingAI is designed to be forked. A fork specializes the platform for a
domain (the reference fork is **MFA-AI**, a German medical-office swarm)
while staying trivially updatable from upstream: all fork code lives on
**fork-owned surfaces** that upstream guarantees never to touch, so

```bash
git fetch upstream && git rebase upstream/develop
```

stays conflict-free by construction.

## The four fork-owned surfaces

| Surface | What it carries |
|---------|-----------------|
| `product.json` (repo root) | Identity: product name, slug, tagline, state-dir name, config file name, env prefix, web theme |
| `packages/core/src/extensions/<name>/` | Domain backend: tools (with tiers), gateway routes, guardrails, roles, audit events, db/boot hooks |
| `packages/web/src/extensions/<name>/` | Domain frontend: pages, routes, nav entries |
| `workspace/` overlays | Agents, jobs, scenes, knowledge — numbered JSONC files merged by the loader |

Everything else is upstream-owned. If you find yourself editing an upstream
file, stop: either the platform is missing an extension point (contribute it
upstream — see [fork-boilerplate-plan.md](fork-boilerplate-plan.md)) or
there's a config knob you missed.

## Naming: every fork-owned path carries your slug

Fork-owned paths are named after your `product.json` **`slug`**. Upstream ships
no `product.json`, so upstream has no slug and can never own these names — which
means ownership is *decidable from the path alone*, with no hand-maintained
list, and two forks of this repo never collide with each other:

| Kind | Path |
|------|------|
| Core extension | `packages/core/src/extensions/<slug>/` |
| Web extension | `packages/web/src/extensions/<slug>/` |
| Config shard | `config/<zone>/<NN>-<slug>[-topic].jsonc` |
| Workspace overlay | `workspace/<kind>/<NN>-<slug>[-topic].jsonc` |
| Grouped config | `config/<slug>/…`, `workspace/<slug>/…` |
| Compose overlay | `docker-compose.<slug>.yml` |
| Anything else at the repo root | declare it in `product.json` `rootAllowlist` |

**Numbered shards: upstream reserves `00`–`59`; forks use `60`–`99`.** This is
not cosmetic. Shards are merged in lexicographic path order and the *later* one
wins, so a fork shard numbered `20` merges before every upstream shard numbered
above it — any key it means to override is silently re-overridden by upstream,
and the fork's customisation quietly does nothing. Numbering above upstream's
range makes your shard win by construction, and leaves upstream room to grow.

If your fork adopted shorter directory names before this convention existed, you
can list them in `product.json` as `"surfaceNames": ["mfa-ai", "mfa"]` instead of
renaming the tree; new forks should just use the slug.

Verify at any time — this is the real measure of whether your next rebase is
clean, and it is worth wiring into CI:

```bash
node scripts/check-upstream.mjs --remote upstream --strict
```

It reports **surface drift**: upstream files your fork modified or deleted (drive
this to zero) and shards numbered below the fork range.

## Step by step

### 1. Fork and rename

Fork the repo, then commit a `product.json` at the repo root:

```jsonc
{
  "name": "MFA-AI",
  "slug": "mfa-ai",
  "tagline": "Medizinische Fachangestellte",
  "stateDirName": ".mfa-ai",
  "configFileName": "mfa-ai.json",
  "envPrefix": "MFA_AI",
  "legacyStateDirNames": [".starlingai"],   // read fallbacks after the rename
  "legacyEnvPrefixes": ["STARLINGAI"],
  "theme": { "accent": "sky" }
}
```

Upstream ships no `product.json` (defaults apply), so this file never
conflicts. Everything follows it: config resolution, state directories,
`<PREFIX>_*` env vars, startup banners, MCP/A2A agent cards, document
metadata, and `GET /api/product` for the web shell.

A fork that adds its own repo-root files or runtime directories can declare
them in `product.json` too, so `pnpm check`'s root-layout gate passes without
editing the upstream script:

```jsonc
{
  // ...identity fields above...
  "rootAllowlist": {
    "files": ["DEVPLAN.md", "docker-compose.myfork.yml"],
    "directories": ["uploads"]
  }
}
```

### 2. Disable built-in tool families you don't want

Don't delete upstream tool files — deletions are the worst rebase-conflict
source. Disable them in your config instead:

```jsonc
// mfa-ai.json
{ "tools": { "disabledGroups": ["pentest", "infrastructure"], "disabledTools": [] } }
```

Group names live in `packages/core/src/tools/groups.ts` (`pentest`,
`infrastructure`, `kubernetes`, `observability`, …). Disabled tools are
skipped at registration: invisible to the LLM, the dashboard, and the API.

### 3. Add your domain backend as a core extension

Copy `packages/core/src/extensions/_example/` to `extensions/<name>/` and
fill in the manifest ([SDK](../packages/core/src/extension/index.ts)):

```ts
import { defineCoreExtension, ToolTier } from "../../extension/index.js";

export default defineCoreExtension({
  name: "mfa",
  version: "1.0.0",
  tools: [{
    name: "mfa_icd10_lookup",
    description: "Look up ICD-10-GM diagnosis codes",
    tier: ToolTier.ZERO_READ_ONLY,        // trusted first-party code declares tiers
    parameters: { /* JSON schema */ },
    async execute(args, ctx) { /* ... */ },
  }],
  auditEvents: ["patient_data_accessed"],  // logged as "mfa.patient_data_accessed"
  roles: [{ name: "doctor", description: "Arzt — sign-off authority", rank: 80 }],
  guardrails: { checkOutput: (text) => ({ allowed: true, redacted: pseudonymize(text) }) },
  registerRoutes(app, ctx) { app.get("/api/mfa/knowledge/status", handler); },
  // Declarative RBAC: role lists per route pattern, enforced by the gateway
  // gate before handlers run — also works for CORE routes, so forks tighten
  // built-in endpoints without touching them.
  routePolicies: [
    { method: "POST", pattern: "/api/knowledge/refresh", roles: ["mfa", "doctor", "admin"] },
    { pattern: "/api/admin/*", roles: ["admin"] },
  ],
  configSchema: z.object({ praxisTyp: z.string().default("hausarzt") }),
  async boot(ctx) { await initBillingGraphSchema(); },
  async shutdown() { /* ... */ },
});
```

Notes:

- Extension tools default to the tool group `<name>`, so users can disable
  your whole extension with `tools.disabledGroups: ["mfa"]`.
- Extension config lives at `extensions.<name>` in the root config and is
  validated by your `configSchema` at boot.
- A failing extension is logged + audited and skipped; it cannot take the
  gateway down.
- This is **trusted, repo-compiled code** — for runtime-installed third-party
  tools use the [Plugin SDK](../packages/core/src/plugin/README.md) instead
  (fixed Tier 2, sandboxed, per-call approval).

### 4. Add your domain frontend as a web extension

Copy `packages/web/src/extensions/_example/` to `extensions/<name>/`:

```ts
import { defineWebExtension } from "../registry";

export default defineWebExtension({
  name: "mfa",
  routes: [{ path: "/mfa/patients", component: () => import("./pages/PatientList.vue") }],
  nav: [{ label: "Patienten", path: "/mfa/patients", roles: ["mfa", "doctor", "admin"], order: 10 }],
});
```

Routes merge behind all core routes; nav entries render after the core
navigation. Branding (name/tagline/accent) comes from `GET /api/product`
automatically.

### 5. Add workspace content

Agents, jobs, scenes, and knowledge are numbered JSONC overlay files —
fork files sort after upstream files and win on conflict:

```
workspace/agents/40-subagents-mfa.jsonc
workspace/jobs/20-mfa-jobs.jsonc
workspace/scenes/20-mfa-scenes.jsonc
workspace/knowledge/icd10gm/…
```

### 6. Heavy capabilities: run them as services, not code

If your specialization needs a model server or heavyweight service (e.g.
MFA-AI's medBERT NER), don't compile it in — run it out of process and
connect it via configuration:

- **MCP server**: expose tools; register under `mcp.servers` in config.
- **A2A peer**: expose a whole agent (agent-card discovery, `tasks/send`);
  register under `a2a.peers`.
- **docker-compose overlay**: add `docker-compose.<name>.yml` next to the
  base file; never edit the base compose files.

Zero code changes in either repo; the swarm discovers the capability from
config.

## Staying updated

One-time setup in your fork:

```bash
git remote add upstream https://github.com/SteffenHebestreit/StarlingAI
```

Then, whenever you want upstream's latest:

```bash
node scripts/check-upstream.mjs --fetch --remote upstream   # drift report (exit 1 = drift)
git rebase upstream/develop                                  # conflict-free if you stayed on fork-owned surfaces
pnpm -r check && pnpm build                                   # verify
```

The drift checker writes a JSON report under `<stateDir>/upstream-reports/`
and is cron-friendly (schedule it as a job and alert on exit code 1).

## Rules of thumb

1. **Never edit upstream files in a fork.** Missing extension point → add it
   upstream first, then use it in the fork.
2. **Never delete upstream files.** Use `tools.disabledGroups` /
   `disabledTools`, or config toggles.
3. **Namespace everything** with your extension name: tools (`mfa_*` by
   convention), audit events (enforced: `mfa.*`), routes (`/api/mfa/*`),
   web paths (`/mfa/*`).
4. **Workspace overlays over prompt edits** — override agent prompts with a
   higher-numbered JSONC file, don't edit upstream's.
