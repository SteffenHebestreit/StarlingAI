# Core extensions

Fork-owned, first-party extension packages. Each subdirectory is one
extension: `<name>/index.ts` default-exports a `defineCoreExtension({...})`
manifest (SDK: `../extension/index.ts`). The loader discovers and registers
every extension at gateway startup — no edits to `index.ts`, the tool
registry, the tier map, the audit union, or the gateway required.

**Upstream ships nothing here except this README and `_example/`** (the
underscore prefix keeps it dormant — copy it to start your own). That makes
this directory a fork-owned surface: a fork's commits under
`src/extensions/<your-name>/` can never conflict with upstream changes on
rebase. See `docs/fork-boilerplate-plan.md` for the full forking model.

What a manifest can declare:

| Field            | Effect                                                          |
|------------------|-----------------------------------------------------------------|
| `tools`          | Tools with explicit tiers (0–3), grouped under the extension name for config-driven disabling |
| `auditEvents`    | Audit events, namespaced `<name>.<event>`                        |
| `roles`          | Auth roles + badge metadata, surfaced via `GET /api/product`. Under multi-user auth an account holding a role that no loaded extension declares cannot sign in (`docs/security.md`, "Roles Nobody Declares") |
| `authProvider`   | Credential backend for the core `/api/auth` routes; one per process. A standalone scene worker registers it too, without `boot`: `getUserById` must answer without it |
| `toolKeywords`   | Embedding-reranker routing keywords for domain vocabulary (pattern → keywords) |
| `llmBoundary`    | LLM-boundary transformer for provider-bound messages / model responses |
| `guardrails`     | `checkInput` / `checkOutput` hooks appended after built-ins      |
| `routePolicies`  | Declarative RBAC: role-name lists per gateway route pattern      |
| `rpcPolicies`    | Who may call which WebSocket RPC method: replace a method's default minimum role (`roles`) or refuse roles (`denyRoles`) |
| `registerRoutes` | Gateway routes (mounted after core routes; prefix `/api/<name>/`)|
| `configSchema`   | Zod schema validating the `extensions.<name>` config slice       |
| `boot`/`shutdown`| Lifecycle hooks (db schema init, knowledge loads, teardown)      |

Extensions are trusted code compiled with the repo — the same trust level as
any other file here. For *runtime-installed, untrusted* tool packages use the
Plugin SDK (`../plugin/`) instead.
