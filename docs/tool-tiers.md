# Tool Tiers & Guardrails

<p align="center">
	<img src="../assets/brand/swarmLogo.svg" alt="StarlingAI logo" width="180" />
</p>

StarlingAI enforces a five-tier tool classification system on every tool call. This is the enforcement mechanism for the "Guarded" principle: agents in the swarm have freedom to discover, compose, and execute within their domain, but escalation is strictly controlled. The tiers are hard-coded at compile time — they cannot be changed via config or the API at runtime. The design principle is **default-deny with minimum privilege**: agents get the least access needed for their declared purpose, and escalation requires explicit per-call approval.

This classification system is domain-agnostic. Whether the swarm is analyzing data, writing code, automating browsers, or sending emails, the same tier checks apply to every tool invocation.

See also: [Security Model](security.md) · [Architecture & Design](architecture.md)

---

## The Five Tiers

| Tier | Name | Behaviour |
|------|------|-----------|
| **0** | Read-only | Always allowed. No side effects. No approval required. |
| **1** | Write | Workspace-scoped writes. No approval required but all writes are audited. |
| **2** | Execute | Requires per-call approval. Shell execution always in Docker sandbox. |
| **3** | Privileged | Requires per-call approval + generates audit entry with full args. |
| **4** | Blocked | Never executed. Hard-coded reject. |

**Philosophy:** Tier 0 tools can never cause harm — they only read information the agent already has access to. Each tier above adds a capability (network egress, filesystem writes, process execution, external service calls) and a corresponding control. Tier 4 tools represent actions that would give an agent uncontained access to the host environment; they are removed from the tool registry entirely.

This tier model is also the hard boundary for self-improvement. The swarm may refine prompts, memory, agent definitions, and approved tool assignments for specialists, but it may not use self-improvement to reclassify tools, weaken approvals, expose secrets, or bypass the guarded contract. Credential-bearing actions remain secret-safe tool calls, never plain-text reads into model context.

---

## Full Tool Registry

### Tier 0 — Read-Only (Always Allowed)

| Tool | Description |
|------|-------------|
| `list_agents` | List all registered sub-agents and their capabilities |
| `search_agents` | Score agents against a query using hybrid routing |
| `read_file` | Read a file from the workspace |
| `list_files` | List files in a workspace directory |
| `export_workspace_artifact` | Surface an existing workspace file or folder as a downloadable chat artifact |
| `web_search` | Search via the configured web-search backend with SearXNG, Playwright, and DuckDuckGo fallback |
| `web_fetch` | Fetch a URL and return text content, preferring rendered browser content for HTML pages |
| `workspace_search` | Full-text search across workspace files |
| `memory_search` | Search the agent memory store |
| `session_status` | Read current session metadata |
| `get_site_credentials` | Check whether stored site credentials exist and return non-secret login metadata |

### Tier 1 — Write (Workspace-Scoped)

All writes are confined to the configured `workspacePath`. The agent cannot write outside this directory.

| Tool | Description | Approval |
|------|-------------|---------|
| `write_file` | Write or overwrite a file in the workspace | None |
| `edit_file` | Make targeted edits to an existing file | None |
| `create_dir` | Create a directory in the workspace | None |
| `delete_file` | Delete a file from the workspace | None |
| `memory_store` | Write a key/value entry to the memory store | None |
| `record_lesson` | Append a lesson-learned entry to memory | None |
| `generate_document` | Save generated content as Markdown, text, HTML, or JSON in the workspace | None |
| `generate_chart_html` | Save an HTML chart report with embedded visualization data in the workspace | None |
| `generate_mermaid_diagram` | Save a Mermaid diagram artifact in the workspace for direct preview in chat | None |
| `generate_pdf` | Save a simple PDF document in the workspace | None |
| `n8n_fetch_leads` | Fetch lead data from an n8n workflow | None |
| `n8n_mark_applied` | Mark a lead as applied in n8n | None |
| `webhook__<name>` | Any auto-registered webhook tool | None (auto-classified Tier 1) |

### Tier 2 — Execute (Per-Call Approval, Docker Sandbox)

| Tool | Description | Approval | Sandbox |
|------|-------------|---------|---------|
| `delegate_to_agent` | Delegate a task to a named sub-agent via A2A | Per-call | No |
| `create_ephemeral_agent` | Create a temporary sub-agent from a spec | Per-call | No |
| `parallel_delegate` | Run up to 5 agents concurrently | Per-call | No |
| `shell_exec` | Execute a shell command | Per-call | Yes — Docker container |
| `run_script` | Run a script file | Per-call | Yes — Docker container |
| `site_fill_credentials` | Securely fill stored credentials into browser login fields | Per-call | No |
| `computer_type_credential` | Securely type stored credentials into a desktop login form | Per-call | No |

`shell_exec` and `run_script` **always** run inside the Docker sandbox container. There is no code path that can execute these on the host.

`get_site_credentials` is Tier 0 because it returns metadata only. The secret-bearing actions stay approval-gated through `site_fill_credentials` and `computer_type_credential`.

### Tier 3 — Privileged (Admin Approval + Audit)

| Tool | Description | Approval |
|------|-------------|---------|
| `send_telegram` | Send a Telegram message via the bot | Per-call + audit |
| `cron_create` | Register a new cron schedule | Per-call + audit |
| `vm_manage` | Manage VMs through configured infrastructure backends | Per-call + audit |
| `proxmox_vm` | Manage Proxmox VMs via the Proxmox VE API | Per-call + audit |
| `terraform_exec` | Run Terraform provisioning and stateful changes | Per-call + audit |
| `ansible_playbook` | Run an Ansible playbook for privileged infrastructure changes | Per-call + audit |
| `ansible_task` | Run a single Ansible ad-hoc task against remote inventory | Per-call + audit |
| `service_check` | Check remote infrastructure readiness from the host | Per-call + audit |
| `ssh_exec` | Run a remote SSH command on a target host | Per-call + audit |
| `ssh_upload` | Upload files or directories to a remote host | Per-call + audit |
| `ssh_download` | Download files or directories from a remote host | Per-call + audit |
| `mcp__<server>__<tool>` (unlisted) | Any MCP tool not explicitly listed in Tier 0 | Per-call + audit |

**MCP tools default rule:** any MCP tool that is not explicitly classified in Tier 0 is automatically assigned Tier 3. This means new MCP servers get privileged-but-allowed behaviour by default — they require per-call approval and generate an audit entry, but they are not blocked outright.

### Tier 4 — Blocked (Never Executed)

| Tool | Why Blocked |
|------|-------------|
| `host_shell` | Direct host process execution — uncontained |
| `docker_socket` | Would give the agent control over the Docker daemon |
| `gateway_reconfigure` | Would allow runtime modification of security config |
| `skills_install_remote` | Would allow arbitrary code installation |

Any tool **not listed** in tiers 0–3 defaults to **Tier 4 (Blocked)**. Unknown tool names are rejected before the LLM response is even parsed.

---

## Guardrail Stack

Every message and tool call passes through four sequential layers:

### Layer 1 — Input Scanner

Runs before the user message reaches the orchestrator LLM. Detects:
- Prompt injection patterns (instruction override attempts)
- Jailbreak templates
- Sensitive data in user input (credit card numbers, SSNs, tokens)

Messages that trigger the scanner are rejected with a `blocked` status event. The rejection is recorded in the audit log.

### Layer 2 — Tool Tier Check

Runs before any tool is executed. Enforces the tier table above. Per-call approval requests are routed to the configured approval channel (Slack or webhook) and block execution until approved or denied. Denied tool calls are logged.

### Layer 3 — Tool Output Scanner

Runs after a tool returns its result, before the result is passed back to the LLM. Scans for:
- Secrets and credentials in command output
- API keys and tokens in file content
- Passwords in web-fetched content

### Layer 4 — Output Redactor

Runs on the final LLM response before it is sent to the user. Any content that matches the secret scanner patterns is replaced with `[REDACTED]`. This is a last-resort layer — the output scanner should catch most issues earlier.

---

## Input Guardrails: Prompt Injection Detection

The input scanner uses pattern matching to detect common prompt injection techniques:

- Instruction override: "ignore previous instructions", "disregard your system prompt", etc.
- Role confusion: attempts to redefine the agent's identity or authority
- Indirect injection: content that contains instruction fragments designed to be included in subsequent prompts (e.g., inside web-fetched pages or documents)

Web-fetched content and file reads are scanned separately from direct user input — injections embedded in external content are flagged even if the user's original message was clean.

---

## Output Guardrails: Secret Scanning

The output scanner and redactor run on:
- Tool results before they reach the LLM context
- The final response before it reaches the user
- Audit log entries (secrets are redacted in logs too)

Patterns matched include: API key formats, JWT tokens, private key headers, password fields in JSON, connection strings with credentials, and common secret variable names with non-empty values.

---

## Rate Limiting

Rate limiting is Redis-backed and applied per session (not per IP, except for auth endpoints). Two independent limits apply:

- **Request rate**: maximum messages per session per minute
- **Tool-call rate**: maximum tool executions per session per minute

Both limits are configurable via `PUT /api/guardrails`. Exceeding either limit returns a `status: "blocked"` event to the client and logs the event to the audit stream.

Auth failure rate limiting (10 attempts per 5-minute window per IP) is handled separately at the gateway layer. See [Security Model](security.md).
