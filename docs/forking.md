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
    // Nested paths work too — the natural home for fork repo tooling, so your
    // scripts don't have to live in upstream's scripts/.
    "directories": ["uploads", "scripts/myfork"]
  }
}
```

Three upstream files forks reliably get wrong, and what to do instead:

- **`.env.example`** — upstream appends to it at EOF, so a fork that adds its own
  vars conflicts on almost every sync. Nothing parses this file (`.env` is written
  by the setup wizard and checked by `scripts/check-env-refs.mjs`, which reads
  `.env` only), so ship a fork-owned `<slug>.env.example` and declare it in
  `rootAllowlist.files`.
- **Root `.gitignore`** — upstream-owned. To ignore your renamed state directory,
  commit a *self-ignoring* `<stateDirName>/.gitignore` containing `*` and
  `!.gitignore` instead of editing the root file.
- **`pnpm-lock.yaml`** — generated; never hand-merge it. Upstream marks it
  `-merge` in `.gitattributes`, so resolve conflicts by regenerating:
  `git checkout --theirs pnpm-lock.yaml && pnpm install`.

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

For anything else upstream ships that you want *gone* — a sub-agent, a webhook,
an approval channel — list its dot-path in `configRemovals` from your own shard:

```jsonc
// config/tooling/60-<slug>.jsonc
{
  "configRemovals": [
    "subAgents.pentest_coordinator",
    "approvalChannels.pager"
  ]
}
```

This exists because shard merging never deletes — it only adds or overwrites, so
one shard cannot accidentally null out another's key. Without `configRemovals`
the only way to drop something upstream ships would be to edit the upstream
shard, which is precisely the conflict this whole model avoids. Paths are
deleted after every `config/` + `workspace/` shard has merged and before the
schema runs, so a section emptied this way falls back to its default, and a path
that matches nothing is a warning rather than a failed boot (upstream may rename
or drop it later without breaking your fork).

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
    // Optional: checked before any approval card, like a built-in tool's refuse.
    refuse: (args) => (isIcdCode(args.code) ? undefined : "Give an ICD-10-GM code such as J06.9."),
    async execute(args, ctx) { /* ... */ },
  }],
  auditEvents: ["patient_data_accessed"],  // logged as "mfa.patient_data_accessed"
  roles: [{ name: "doctor", description: "Arzt — sign-off authority", rank: 80 }],
  guardrails: { checkOutput: (text) => ({ allowed: true, redacted: pseudonymize(text) }) },
  // Veto ANY tool call (core or extension) for the role it answers to, before
  // the tool's own refuse and before any approval card. Return a reason to refuse.
  authorizeToolCall: ({ name, ctx }) =>
    name === "create_knowledge_base" && ctx.userRole === "doctor" ? "Ask the practice admin to add a source." : undefined,
  registerRoutes(app, ctx) { app.get("/api/mfa/knowledge/status", handler); },
  // Declarative RBAC: role lists per route pattern, enforced by the gateway
  // gate before handlers run — also works for CORE routes, so forks tighten
  // built-in endpoints without touching them.
  routePolicies: [
    { method: "POST", pattern: "/api/knowledge/refresh", roles: ["mfa", "doctor", "admin"] },
    { pattern: "/api/admin/*", roles: ["admin"] },
  ],
  // The same for the WebSocket RPC (/ws): replace a method's default minimum
  // role with a role list, or refuse roles and keep the default for the rest.
  rpcPolicies: [
    { method: "computer.*", denyRoles: ["doctor"] },  // no computer-use controls for this role
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
- `ctx.userRole` is the role of the person the call answers to. It is the same
  in the orchestrator's tool calls and in every run they start (sub-agents,
  workflow steps). A2A and MCP agent runs carry the signed-in caller's role.
  A job a person queued, and each run of a schedule a person made with
  `schedule_task`, runs with its owner's role as the account holds it when the
  run starts, and fails if the account no longer signs in. It is unset where
  nobody signed in (a channel message, a configured cron or webhook-key run, a
  federated peer). With auth off it is what the surface read from the token: a
  WebSocket chat and `/job` carry the `role` claim as given (none without one),
  AG-UI turns and the REST scene and job run routes carry `operator` without
  one, and A2A and MCP runs carry none. So an unset role does not always mean
  that nobody signed in (a WebSocket chat while auth is off, a job or schedule
  queued before roles were recorded): decide in your hook what it means for
  your tools.
- `authorizeToolCall` runs for every call that reaches the tool registry, in
  extension load order; the first refusal wins, and a hook that throws refuses
  the call. A refusal is audited as `tool_call_refused` with the tool, the role
  and your extension's name, never the arguments. A check inside `execute()`
  runs only after the person approved the call; put role checks in the hook or
  in `refuse`. The hook runs in the processes that load extensions: the gateway
  and its embedded scene worker. A standalone scene worker
  (`scene-worker-main.ts`) loads none, so neither your tools nor your hook
  exist there. It declares your roles, though, and nothing else of your
  extension, so a job of a builtin account holding one of them runs there with
  that role; if your module does not import there or its manifest is refused,
  your roles are not declared there either, and those jobs fail. To read the
  roles it imports your module, so its top-level code runs there too (`boot`
  does not): keep work out of it. A hook that is not a function refuses every
  call, and a tool whose `refuse` is not a function is not registered. Both
  are logged at boot, and the extension still loads, with its roles.
- A tool's `effect` block (ADR-005) is honoured like a built-in's, so an
  irreversible external mutation falls under `guardrails.effectContracts`.
- A failing extension is logged + audited and skipped; it cannot take the
  gateway down. Its roles go with it: under multi-user auth an account that
  holds one of them cannot sign in, every token carrying one is refused (401,
  `/ws` closes with 4401), and its queued jobs and scheduled runs fail, until
  the extension loads again or the account's role is changed. Those failed
  jobs are not queued again, and a schedule ends after such runs as after any
  failed ones (a one-shot at once, a repeating one after three). The gateway
  logs each such account with the role and the account id. Before, such an
  account signed in as `operator`. See
  [security.md](security.md#roles-nobody-declares) for getting accounts back
  in, and for what that old rule left behind in chats and schedules.
- Every WebSocket RPC method has a default minimum role (reading: viewer;
  anything that changes something, `session.create` and `chat.send` included:
  operator), compared by rank, so an extension role at rank 50 passes operator
  and one at rank 10 does not (table in [api.md](api.md#websocket-rpc)).
  `rpcPolicies` changes that per method: `method` is a method name,
  `"prefix.*"` or `"*"`, and the first matching policy wins, in load order.
  `{ method, roles }` *replaces* the default, admitting exactly the listed roles
  (a listed built-in role admits the higher built-ins); list `operator` too or
  operators lose the method. `{ method, denyRoles }` refuses the listed roles
  and leaves everyone else to the default. A mistake in a policy is logged at
  boot and never widens access; the extension still loads, with its roles. The
  entry registers in its place as one that refuses every caller: for its
  `method`, or for every method when `method` is not a method name,
  `"prefix.*"` or `"*"`, or `rpcPolicies` is not a list. An extension that
  fails to load for another reason registers none of its RPC policies.
- To let a role below operator chat (e.g. a portal user), open what a turn
  needs along with `chat.send`: `session.create`, `chat.cancel` (Stop) and the
  answers a turn waits for, `approval.respond`, `input.respond` and
  `userInput.respond` / `userInput.hold` / `userInput.preview`. A turn's
  approvals and questions go to the socket that started it, so without these
  its turns cannot be stopped and every approval waits until it times out and
  is denied. For the same reason `approval.respond` answers only the approvals
  of turns started on the caller's own connection: limiting it to a sign-off
  role does not route other users' approvals to that role. A role that may call
  `chat.send` may also use its inline overrides (`--agent`, `--iter`,
  `--timeout`, `--effort`, `/run`, `/job`); only `--auto` has a floor of its
  own (`gateway.overrides.autoApproveMinRole`, rank-based like the default).
  The web offers a connection only the controls it may use: `hello-ok` lists
  the methods it may call.
- This is **trusted, repo-compiled code** — for runtime-installed third-party
  tools use the [Plugin SDK](../packages/core/src/plugin/README.md) instead
  (fixed Tier 2, sandboxed, per-call approval).

**Route policies.** Each entry sets exactly one of two forms:

- `roles: [...]` lets only the listed roles through. A listed built-in role
  also admits the higher built-ins (viewer < operator < admin); extension roles
  never inherit. A caller without a token gets 401, any other role 403.
- `denyRoles: [...]` refuses the listed roles with 403 and passes everyone
  else on, callers without a token included. Use it to keep a low role off a
  whole prefix without breaking what sits under it: public routes
  (`/api/product`, `/api/auth/mode`, the OIDC callback), routes that take
  `?token=` or a cookie (served sites, the live-app proxy), and routes that take
  a scoped capability token. It checks every session token a request presents
  (Authorization header, `?token=`, the served-site cookies), so moving the
  token elsewhere does not get past it.

Policies are consulted in registration order, and an extension's register
before core's own:

- The first matching `roles` policy decides; nothing after it is consulted.
- A matching deny policy in front of it refuses the roles it names and passes
  everyone else on to the next matching policy, then to the route's own auth. A
  deny policy therefore only ever subtracts: whoever it does not name gets the
  answer they would get without it, from core's own policies too. Core
  registers these: the knowledge-base writes (`POST /api/knowledge-bases`,
  `PATCH` and `DELETE /api/knowledge-bases/:id`, `POST
  /api/knowledge-bases/:id/crawl` and `/cancel`) admit `operator` (and so
  `admin`, but no extension role), and `POST /api/admin/account-migration`
  admits `admin`.
- `denyRoles: []` refuses nobody and drops every deny policy after it, never a
  `roles` policy. It carves an exception out of a broader deny policy:

```ts
routePolicies: [
  { pattern: "/api/product", denyRoles: [] },   // the exception comes first
  { pattern: "/api/*", denyRoles: ["guest"] },
  { pattern: "/ws", denyRoles: ["guest"] },
  { pattern: "/mcp", denyRoles: ["guest"] },
  { pattern: "/a2a/*", denyRoles: ["guest"] },
],
```

A `roles` policy of yours decides every route it matches, core's policed ones
included: `{ pattern: "/api/*", roles: [...] }` in front of core's policies
takes their place, so list in it only roles that may do everything under the
prefix.

Policies reach every `/api/*` route and the surfaces the gateway answers before
its router:

| Surface | Refusal |
|---|---|
| `POST /api/chat/stream` (AG-UI) | 401/403 JSON |
| `/mcp` | 401/403 JSON |
| `POST /a2a/v1`, `POST /a2a/agents/:name` | 401/403 JSON-RPC (`-32003` for a refused role) |
| `GET /.well-known/agent-card.json` | 401/403 JSON |
| `/ws` (matched as `GET`) | the handshake completes, then close code 4403 (4401 without a token) |
| `/ws/browser-vnc` and `/ws/browser-vnc/*` (matched as `GET`) | HTTP 403/401 before the upgrade |

A browser sees only the close code of a socket, so `/ws` closes rather than
failing the handshake; the dashboard then stops reconnecting and says the
account has no access to the live dashboard, keeping its sign-in. An open `/ws`
is checked again when its account's role changes: once the policy refuses the
new role, the socket closes with 4403 at its next message or pushed event. The
agent name in `/a2a/agents/:name` is matched percent-decoded, as the route reads
it. On these surfaces a `roles` policy also takes the token as `?token=`; on
`/api/*` it reads the Authorization header only, as it always has. `POST
/api/federation/delegate/stream` is never policed (it authenticates a federation
peer by HMAC, not a user), and other paths outside `/api/` (channel webhooks,
`/healthz`) are not policed either. A refusal is audited as `rbac_denied` with
`surface` `rest`, `raw` or `ws`.

A mistake in a policy is logged at boot and never widens access. An entry with
a path `pattern` but a malformed form (both forms, neither, a role list that is
not a list of names) refuses every caller on that path until it is fixed; the
extension still loads, with its roles, tools and hooks. An entry without a path
pattern, or a `routePolicies` that is not a list, registers nothing. A policy
that names a role which is neither built-in nor declared by a loaded extension
is logged as well: no caller ever holds such a role, so a deny list refuses
nobody by it.

**Who approves a call.** `requiresPerCallApproval` alone asks whoever the
call's approval callback reaches, which in a chat is the person who asked. To
make a sign-off mean something, name the roles that may grant it:

```ts
{
  name: "record_release",
  tier: ToolTier.THREE_PRIVILEGED,
  requiresPerCallApproval: true,
  approval: { approverRoles: ["reviewer"], distinctApprover: true },
  async execute(args, ctx) {
    // ctx.approval: { via: "requester" | "routed", approvalId?, approvedBy?, approverRole? }
    await recordSignOff(args, ctx.approval?.approvedBy, ctx.approval?.approverRole);
    /* ... */
  },
}
```

The requester is the person who sent the message, with the role they hold
now. That is not always the chat's owner or the role the chat was created
with. When `approverRoles` admits that role and the chat is the requester's
own, they approve on their own card, as before. Every other call waits until
a signed-in approver decides it under Operator requests:

- a role the policy does not admit;
- someone else's chat, which an admin may drive;
- a call that needs a second person (`distinctApprover`);
- an approval nobody would really be asked for (`--auto`, the legacy A2A
  route's `autoApprove`, a scene's approval channel).

The requester's chat says it is waiting for approval by the listed roles. The
wait holds the turn's clocks. `approverRoles` may name built-in roles or any extension's roles. They
are matched like `routePolicies`: an extension role is never admitted through
rank. Record who approved from `ctx.approval`, not from the fact that the
handler ran. See [Tool Tiers](tool-tiers.md#who-may-approve-a-call-approval-policies).

A malformed policy is logged at boot, and that tool is not registered: no
approver role, a name that is no role name, a `distinctApprover` that is not a
boolean, or a policy on a tool without `requiresPerCallApproval: true`. The
rest of the extension still loads, with its roles.

**CLI subcommands.** Drop a file at `extensions/<name>/cli/<command>.{mjs,js,ts}`
and it becomes `sai <command>`, with everything after the command name passed
through:

```
packages/core/src/extensions/mfa-ai/cli/user.mjs   →   sai user list --json
```

Discovery only runs for a name no built-in command claimed, so an extension can
never shadow a core command — the same rule the SDK applies to routes and tool
tiers. Naming a file after a built-in is ignored with a warning rather than
silently dropped, so a future upstream command with that name can't quietly
take over. `sai help` lists whatever your fork provides.

**Who may run the maintenance agents.** Agents with `workspaceAccess: "full"`
(upstream: `swarm_maintainer`, `prompt_optimizer`) maintain the deployment: they
work from the shared root, edit `agents/`, `scenes/` and `jobs/` for every
account, and can read every account's root. Under multi-user auth a run whose
role ranks below `agents.fullScopeMinRole` (default `operator`) is refused before
it starts, whichever path reached the agent: `delegate_to_agent`, `--agent`,
`run_workflow`, A2A, MCP, or the turn of a queued job (`/job`, the scene and job
run routes) or of a scheduled run. Such a job or run answers to the role its
account holds when it runs. `search_agents`/`list_agents` do not offer the agents
to a role below the floor. The floor refuses no run whose role is unknown: a
channel, a cron or channel trigger, a federation peer, or a queued run of an
identity-provider account that carries no role (the IdP grants that role at
sign-in, and no store keeps it). To refuse those, or any agent for any caller,
add `authorizeAgentRun`:

```ts
export default defineCoreExtension({
  // ...name, version, tools, roles as above...
  // Asked before every sub-agent run, on every surface, ahead of the role floor.
  authorizeAgentRun: ({ agentConfig, role }) =>
    agentConfig.workspaceAccess === "full" && role === undefined
      ? "Maintenance agents run only for a signed-in account"
      : undefined,
});
```

The first refusal of any extension wins, also over the floor; a hook that throws
refuses the run, and one that is not a function refuses every run (logged at
boot; the extension still loads, with its roles). Every refusal writes an
`agent_run_refused` audit row.

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
navigation. Components that every page needs (an alert watcher, a toast
region) go in `shellComponents`: the app shell keeps them mounted whatever
page is open, each behind its own error boundary — see
[the web extensions README](../packages/web/src/extensions/README.md).
Branding (name/tagline/accent) comes from `GET /api/product` automatically.

### 5. Add workspace content

Agents, jobs, scenes, and knowledge are numbered JSONC overlay files. They
merge in lexicographic order and the later file wins, so a fork file only
overrides upstream when its number is **higher than every upstream file in
that directory** — hence the `60`+ fork range:

```
workspace/agents/60-mfa-ai-subagents.jsonc
workspace/jobs/60-mfa-ai-jobs.jsonc
workspace/scenes/60-mfa-ai-scenes.jsonc
workspace/knowledge/icd10gm/…
```

Numbering a fork overlay inside upstream's `00`–`59` range is the classic
mistake: it loads *before* upstream's own higher-numbered overlays, so any
entry it means to override is silently overridden right back and the
customisation appears to do nothing.

### 6. Heavy capabilities: run them as services, not code

If your specialization needs a model server or heavyweight service (e.g.
MFA-AI's medBERT NER), don't compile it in — run it out of process and
connect it via configuration:

- **MCP server**: expose tools; register under `mcp.servers` in config.
- **A2A peer**: expose a whole agent (agent-card discovery, `tasks/send`);
  register under `a2a.peers`.
- **docker-compose overlay**: add `docker-compose.<name>.yml` next to the
  base file; never edit the base compose files. `docker-compose.override.yml`
  is the one overlay `sai start`, `sai stop` and the one-click launchers load
  on their own (last, so its settings win); pass any other with `-f`. An
  overlay's `tmpfs` and `ports` entries are added to the base file's, not
  swapped in: never list a tmpfs path again that the base already mounts
  (the web service's `/var/cache/nginx`; resize it with `SAI_WEB_TMPFS_SIZE`).

Zero code changes in either repo; the swarm discovers the capability from
config.

## Staying updated

One-time setup in your fork:

```bash
git remote add upstream https://github.com/SteffenHebestreit/StarlingAI
```

Then, whenever you want upstream's latest:

```bash
pnpm upstream:check --fetch --remote upstream   # drift report (exit 1 = commit drift)
git rebase upstream/develop                      # conflict-free if you stayed on fork-owned surfaces
pnpm -r check && pnpm build                       # verify
```

The report covers two independent things. **Commit drift** is how far the
histories have diverged. **Surface drift** is the list of upstream-shipped files
your fork modified or deleted — only that second number predicts rebase
conflicts, and driving it to zero is the entire point of this model. Add
`--strict` to fail on it, which makes a useful CI gate once you are at zero.

The checker writes a JSON report under `<stateDir>/upstream-reports/` and is
cron-friendly (schedule it as a job and alert on a non-zero exit).

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
