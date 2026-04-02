# Security Model

<p align="center">
	<img src="../swarmLogo.svg" alt="StarlingAI logo" width="180" />
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
2. `./.starlingai/.jwt_secret` — auto-generated on first run, persisted in the workspace. Written with mode `0600`.
3. `~/.starlingai/.jwt_secret` — reused if a home-scoped secret from an older installation exists.

If none of the above is present, a cryptographically random secret is generated and written to option 2. Tokens are stable across restarts with zero configuration.

### Generating Tokens

```bash
# Default token
pnpm sai token

# Named user with role and custom expiry
pnpm sai token --user alice --role viewer --ttl 7d
pnpm sai token --user deploy-bot --role admin --ttl 30d
```

Tokens carry a `user` claim (default: `admin`), a `role` claim, and a standard `exp` expiry. The gateway validates `exp` on every request.

### Auth Failure Rate Limiting

Authentication failures are rate-limited to **10 attempts per 5-minute window per IP address**. After the limit is reached, all requests from that IP return HTTP 429 until the window expires. This limit applies to WebSocket upgrade attempts and REST API calls with invalid or missing tokens.

---

## Credential Store

The encrypted credential store holds secrets that should survive restarts but must not live in plain text on disk.

**Encryption:** AES-256-GCM with authenticated encryption. The key is derived from `SAI_MASTER_KEY` using scrypt.

**Location:**

- local development default: `./.starlingai/credentials.enc`
- Docker Compose default: `/data/credentials.enc`
- explicit override: `SAI_CRED_STORE`

**What is stored:**
- Channel configurations (bot tokens, signing secrets, access tokens)
- Site credentials (usernames, passwords, URL shortcuts)
- Scene definitions created via the dashboard
- Channel pairing state (authorized sender IDs)
- Any `secret:key` references used in `starlingai.json`

The store is read on startup and written on every change. The master key (`SAI_MASTER_KEY`) is the single point of trust — protect it as you would a root credential.

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
- **Sensitive input data** — credit card numbers, SSNs, private key headers in user messages

Blocked messages return `status: "blocked"` to the client. The block event is recorded in the audit log with the matched pattern type (but not the full pattern content, to avoid logging the injection attempt verbatim).

### Layer 2 — Tool Tier Check

Applied before any tool execution.

- Tier 0 tools execute immediately.
- Tier 1 tools execute with audit logging.
- Tier 2 and Tier 3 tools require per-call approval. Approval requests are routed to the configured approval channel (Slack or webhook). Execution blocks until approved or denied.
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

- Has no access to the host network (isolated bridge network)
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
- Guardrail events (scanner matches, blocks, redactions)
- Auth events (login attempts, token validation failures, rate limit hits)
- Channel events (delivery, retry, dead-letter)
- Config reload events

**JSONL sink:** written to the path specified by `SAI_AUDIT_LOG`.

Default resolution:

- `./.starlingai/audit.jsonl` when running locally and no explicit override is set
- existing `~/.starlingai/audit.jsonl` only if that legacy path already exists
- `/data/audit.jsonl` in the Docker Compose setup because Compose sets `SAI_AUDIT_LOG`

**PostgreSQL sink (optional):** when Postgres is configured, the gateway also writes audit events to `audit_events`.

**Real-time stream:** subscribe via WebSocket (`audit.subscribe` method) or view in the dashboard under the **Audit** tab. The stream delivers events as they are written.

Secrets are redacted in audit entries using the same scanner as Layer 3/4 before the entry is written — the audit log itself never contains plain-text credentials.

---

## Security Checklist for Production

- [ ] Set `SAI_MASTER_KEY` to a randomly generated ≥32-character string (not the default from `setup.mjs`)
- [ ] Set `SAI_JWT_SECRET` explicitly — do not rely on the auto-generated file in production
- [ ] Set `gateway.publicUrl` in `starlingai.json` — required for channel webhook verification
- [ ] Use `dmPolicy: "pairing"` or `"allowlist"` on all channels — never leave channels `"open"` in production
- [ ] Mount `/data` as a named Docker volume with restricted host permissions
- [ ] Do not expose ports 8765 or 5432 to the public internet — reverse proxy with TLS
- [ ] Review the audit log regularly; subscribe to the real-time stream for live monitoring
- [ ] Keep scene webhook keys at 16+ characters and prefer env-backed secrets over literals
