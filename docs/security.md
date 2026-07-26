# Security Model

<p align="center">
	<img src="../assets/brand/swarmLogo.svg" alt="StarlingAI logo" width="180" />
</p>

StarlingAI is designed for self-hosted deployment with no assumption of a trusted network. The "Guarded" in StarlingAI reflects a fundamental constraint of the swarm architecture: agents in a starling murmuration are free to move, but StarlingAI agents operate within strict security boundaries. Speed and autonomy never come at the cost of control.

Every component applies defence-in-depth: authentication at the edge, tool access control in the runtime, secret scanning on outputs, and a complete audit trail. This security model is domain-agnostic — the same guardrails protect the swarm whether it is doing research, writing code, automating browsers, or managing communications.

The swarm is allowed to improve itself only within bounded non-crucial surfaces: prompts, user and workflow memory, sub-agent definitions, and approved tool assignments for those sub-agents. That self-improvement must remain faithful to the base README philosophy and may never weaken the security contract described here.

In particular, secrets are outside autonomous control. Stored credentials, tokens, and secret material must never be read into model context or surfaced as plain text to an agent. They may only be consumed through dedicated secret-safe tools under the existing approval, audit, and redaction rules.

See also: [Tool Tiers & Guardrails](tool-tiers.md) · [Configuration Layout](../config/README.md) · [REST API & WebSocket](api.md)

---

## Authentication

The gateway uses JWT tokens for both WebSocket and REST authentication.

### Signing Secret Priority

The JWT signing secret is resolved in this order:

1. `SAI_JWT_SECRET` environment variable (≥32 chars) — explicit override, recommended for production and CI.
2. `gateway.jwtSecret` in config (≥32 chars) — takes precedence over **both** persisted secret files below, so a value left here silently overrides the auto-generated one.
3. `./.starlingai/.jwt_secret` — auto-generated on first run, persisted in the workspace. Written with mode `0600`.
4. `~/.starlingai/.jwt_secret` — reused if a home-scoped secret from an older installation exists.

If none of the above is present, a cryptographically random secret is generated and written to option 3. Tokens are stable across restarts with zero configuration.

### Generating Tokens

```bash
# Default token
pnpm sai token

# Named user with role and custom expiry
pnpm sai token --user alice --role viewer --ttl 7d
pnpm sai token --user deploy-bot --role admin --ttl 30d
```

Tokens carry a `sub` claim holding the user id (the standard JWT subject — not a `user` claim), a `role` claim, and a standard `exp` expiry. The gateway validates `exp` on every request.

### Auth Failure Rate Limiting

Authentication failures are rate-limited to **10 attempts per 5-minute window per IP address** (`checkAuthRateLimit` in `packages/core/src/gateway/auth.ts`). A successful auth clears that IP's counter.

The limit covers exactly three surfaces: `POST /api/auth/login` (HTTP 429), `/ws` connections (closed with code 4429), and `/ws/browser-vnc` upgrades (HTTP 429). Every other `/api/*` route rejects an invalid or missing bearer token with a plain 401 and is **not** rate-limited — put a reverse proxy in front of the gateway if you need blanket per-IP throttling.

---

## Credential Store

The encrypted credential store holds secrets that should survive restarts but must not live in plain text on disk.

**Encryption:** AES-256-GCM with authenticated encryption. The key is derived from `SAI_MASTER_KEY` using scrypt.

**Location:**

- local development default: `./.starlingai/credentials.enc`
- Docker Compose default: `/workspace/.starlingai/credentials.enc` (Compose sets `SAI_CRED_STORE` explicitly)
- explicit override: `SAI_CRED_STORE`

**What is stored:**
- Channel configurations (bot tokens, signing secrets, access tokens)
- Site credentials (usernames, passwords, URL shortcuts)
- Scene definitions created via the dashboard
- Channel pairing state (authorized sender IDs)
- Any `secret:key` references used in `starlingai.json`

The store is read on startup and written on every change. The master key (`SAI_MASTER_KEY`) is the single point of trust — protect it as you would a root credential.

## Per-User Resource Access (RBAC)

When multi-user auth is enabled (`auth.enabled: true` with accounts in `auth.users[]`), shared resources can be bound to specific users with an **`allowedUsers`** list. The authenticated user (the JWT subject) is enforced against it before any access:

| Resource | Where to set `allowedUsers` |
|----------|-----------------------------|
| Mail / calendar / contacts accounts | `config/mail/accounts.json` per account |
| Stored site credentials | `sites.<host>` in `starlingai.json` (or the runtime credential store) |
| Computer-use nodes | `computerUse.nodes.<name>` in `starlingai.json` |

Semantics (backwards compatible):

- **Empty / omitted** `allowedUsers` → the resource is **shared** (every authenticated user may use it). Unbound-is-shared is by design; private-by-default would need a per-resource owner model.
- **No requesting user** + an **unbound** resource → allowed (the `allowedUsers` lists are inert until `auth.enabled`).
- **No requesting user** + a **bound** resource → **the two enforcement points differ here:**
  - *Stored site credentials and computer-use nodes* go through `canAccessResource` (`guardrails/resource-access.ts`), which **fails closed** under active multi-user auth — allowed only when `auth.enabled: false`.
  - *Mail / calendar / contacts accounts* are enforced by the mail-service instead (`packages/mail-service/src/account-access.ts`), which **allows** a user-less caller even for a bound account (`if (!user) return true`). The gateway forwards the authenticated user as `X-Sai-User`; when that header is absent the mail-service treats the request as unscoped. It has no visibility into `auth.enabled`, so it cannot make the same fail-closed decision.

  In practice the gateway sets the header for any JWT-authenticated request, so this gap is reachable only by a caller that bypasses user context (e.g. a service-token path). Treat `allowedUsers` on mail accounts as **advisory** rather than a hard boundary until the mail-service is given the auth state.
- Otherwise → access is allowed only if the user's username appears in the list (compared case-insensitively).

Enforcement is centralized: the gateway threads the authenticated user into tool execution and forwards it to the mail-service (`X-Sai-User` header); a restricted mail account returns 403 and a restricted node/credential is treated as not-found (no existence leak). See `guardrails/resource-access.ts` and the mail-service `account-access.ts`. Tool tiers, sandboxing, and approval gates remain global and are not affected by `allowedUsers`.

## Per-User Data Isolation

When `auth.enabled` is true, durable **user-scope** stores are partitioned per authenticated user so different logins never share personal data:

| Store | Partitioning |
|-------|--------------|
| Durable user memory | `<base>/users/<userId>/` (`memoryDirForScope('user')` → `userScopedDir`) |
| Dialectic user-model | per-user file under the same base |
| Personality | global default + per-user **override** (resolve order: override → global → built-in) |
| Graph L0 memory | user-scope nodes carry `m.tenant`; L0 retrieval filters by the reader's tenant (and includes it in the cache key) |

The whole turn — and every `/api/*` route — runs under the authenticated user's request context (`runWithRequestContext({ userId })`), and a delegated sub-agent inherits it, so prompt-assembly, memory, user-model, and personality all resolve to the caller. **`userScopedDir` gates on `auth.enabled` AND a present userId**, so single-operator / auth-off installs keep their original single shared path (fully back-compatible). **Workspace**-scope stores (durable workspace memory, skills, flow-memory) stay intentionally shared per project.

Editing the shared **global** personality under auth requires the **`admin`** role (rank 90 > operator 50 > viewer 10); a regular operator only edits their own override (`PUT`/`POST /api/personality?scope=global`).

Remaining gaps (acceptable for trusted-operator deployments): the graph's non-L0 rerank signals and the `graph_*` tools still operate on a shared instance graph. See `docs/memory-context-overview.md` §6 for the full account.

## Secret-Safe Login Automation

Stored credentials are designed to stay out of the LLM context even when the swarm automates logins.

- `get_site_credentials` returns only non-secret metadata such as the hostname, login URL, selectors, and notes.
- `site_fill_credentials` resolves the stored username and password internally and fills browser form fields without exposing either value to the model.
- `computer_type_credential` performs the same protected injection for remote desktop or computer-use sessions.
- Approval gates should target the secret-bearing action (`site_fill_credentials` or `computer_type_credential`), not the metadata lookup step.

Credential access and secure fill events are still audited, but secret values remain redacted in tool results and audit sinks.

---

## Guardrails Stack

Every message and tool call passes through four sequential guardrail layers. Layers run in order; a block at any layer prevents progression to the next.

### Layer 1 — Input Scanner

Applied to every user message before it reaches the orchestrator LLM.

Detects:
- **Prompt injection** — instruction override phrases ("ignore previous instructions", "you are now DAN", etc.)
- **Jailbreak templates** — known patterns for role confusion and authority escalation
- **Indirect injection** — instruction fragments embedded in content the agent is asked to process (web pages, documents, emails)
- **Credential-extraction phrasing** — requests such as "show me all API keys" (`extract_credentials`)
- **Padding / steganography heuristics** — zero-width and bidi-override characters, long base64 blobs, excessive character repetition

> **Layer 1 does not scan for secret or PII *values*.** There is no credit-card,
> SSN, or private-key detection on the input path — `INJECTION_PATTERNS`
> (`packages/core/src/guardrails/input.ts`) matches injection and jailbreak
> phrasing only. Secret *values* are caught on the way **out**, by the Layer 3/4
> output redaction (`guardrails/output.ts`). Do not rely on this layer to stop a
> user pasting credentials into the chat.

Blocked messages return `status: "blocked"` to the client. The block event is recorded in the audit log with the matched pattern type (but not the full pattern content, to avoid logging the injection attempt verbatim).

### Layer 2 — Tool Tier Check

Applied before any tool execution.

- Tier 0 tools execute immediately.
- Tier 1 tools execute with audit logging.
- Per-call approval is driven by each tool's own `requiresPerCallApproval` flag, **not by its tier number** — `executeTool` gates on that flag (`packages/core/src/tools/registry.ts`), and a scene's `humanInLoopSteps` can additionally force approval for any tool. Most Tier 2/3 tools set the flag (`shell_exec`, the `ssh_*` and infrastructure tools, credential injection, …), but some execution-tier tools deliberately do not — internal orchestration (`delegate_to_agent`, `swarm_delegate`, `parallel_delegate`, `run_workflow`, …) stays inside the guarded runtime, where the sub-agent's own tool calls are gated individually. **Check `docs/reference/tool-tiers.md` for the per-tool `approval` column rather than assuming from the tier.**
- Tier 4 tools are rejected immediately with no approval path.
- Unknown tools (not in any tier) are treated as Tier 4.

The tier assignment is hard-coded in the guardrail module. It cannot be modified via the REST API, config file, or any tool call — including by agents with admin-role tokens.

See [Tool Tiers & Guardrails](tool-tiers.md) for the full tier table.

### Layer 3 — Tool Output Scanner

Applied to every tool result before it is added to the LLM's context window.

This layer prevents the LLM from "seeing" (and potentially echoing) secrets that appear in tool output — for example, an environment variable dump from a shell command, or API keys in a config file read.

Scanned for: API key formats, JWT tokens, private key headers, password fields in JSON/YAML, connection strings with embedded credentials, common secret variable name patterns with non-empty values.

Matched content is replaced with `[REDACTED]` in the tool result. The redaction is recorded in the audit log.

### Layer 4 — Output Redactor

Applied to the final LLM response before it is sent to the user or written to the audit log.

This is a last-resort layer — it catches anything that slipped through Layer 3 (e.g., a secret reconstructed by the LLM from partial context). The same pattern set as Layer 3 is applied. Redacted tokens in the final output are replaced with `[REDACTED]`.

---

## Docker Sandboxing

`shell_exec` and `run_script` always execute inside a dedicated sandbox Docker container. There is no configuration option that routes these tools to the host. The sandbox container:

- Has **no network stack at all** (`docker run --network=none`, `tools/shell.ts`) — it cannot reach the host, other containers, or the internet
- Mounts only the workspace volume (read-write) and nothing else
- Runs as a non-root user
- Has a hard CPU and memory limit
- Is destroyed and recreated between executions

This means an agent that attempts to exfiltrate data, install software, or escalate privileges via shell commands is contained to the sandbox. It cannot reach the host filesystem, the Docker daemon, or the gateway process.

---

## Audit Log

Every event in StarlingAI is recorded to the audit log:

- User messages (content, session ID, channel, sender)
- Tool calls (tool name, arguments, result summary, tier, approval decision)
- Workflow execution events (`search_workflows`, `run_workflow`, workflow-scoped sessions)
- Sub-agent tool lifecycle events used for live shell previews and richer operator review
- Guardrail events (scanner matches, blocks, redactions)
- Auth events (login attempts, token validation failures, rate limit hits)
- Channel events (delivery, retry, dead-letter)
- Config reload events

**JSONL sink:** written to the path specified by `SAI_AUDIT_LOG`.

Default resolution:

- `./.starlingai/audit.jsonl` when running locally and no explicit override is set
- existing `~/.starlingai/audit.jsonl` only if that legacy path already exists
- `/workspace/.starlingai/audit.jsonl` in the Docker Compose setup, because Compose sets `SAI_AUDIT_LOG` explicitly

**PostgreSQL sink (optional):** when Postgres is configured, the gateway also writes audit events to `audit_events`.

**Real-time stream:** subscribe via WebSocket (`audit.subscribe` method) or view in the dashboard under the **Audit** tab. The stream delivers events as they are written.

The dashboard can filter tool activity, sub-agent tool events, and related audit categories, then export the filtered view as Markdown. Session-level audit bundles are also available through `GET /api/sessions/:sessionId/audit-markdown`, while `debug-markdown` remains the fuller transcript + history + audit export.

Secrets are redacted in audit entries using the same scanner as Layer 3/4 before the entry is written — the audit log itself never contains plain-text credentials.

---

## Security Checklist for Production

- [ ] Confirm `SAI_MASTER_KEY` is set to a randomly generated ≥32-character string. `scripts/setup-wizard.mjs` generates one automatically when it is missing or shorter than 32 chars — there is no shared default to replace, but verify the value was not copied between environments.
- [ ] Set `SAI_JWT_SECRET` explicitly — do not rely on the auto-generated file in production
- [ ] Set `gateway.publicUrl` in `starlingai.json` — required for channel webhook verification
- [ ] If the dashboard calls the gateway across origins, add the dashboard origin to `gateway.corsAllowedOrigins`
- [ ] Use `dmPolicy: "pairing"` or `"allowlist"` on all channels — never leave channels `"open"` in production
- [ ] Mount `/data` as a named Docker volume with restricted host permissions
- [ ] Do not expose ports 8765 or 5432 to the public internet — reverse proxy with TLS
- [ ] Prefer publishing only the web entrypoint on port 3001 and let its Nginx proxy forward `/api` and `/ws` to the gateway
- [ ] Review the audit log regularly; subscribe to the real-time stream for live monitoring
- [ ] Keep scene webhook keys at 16+ characters and prefer env-backed secrets over literals
