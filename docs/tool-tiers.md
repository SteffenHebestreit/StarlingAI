# Tool Tiers & Guardrails

<p align="center">
	<img src="../assets/brand/swarmLogo.svg" alt="StarlingAI logo" width="180" />
</p>

StarlingAI enforces a five-tier tool classification system on every tool call. This is the enforcement mechanism for the "Guarded" principle: agents in the swarm have freedom to discover, compose, and execute within their domain, but escalation is strictly controlled. The tiers are hard-coded at compile time — they cannot be changed via config or the API at runtime. The design principle is **default-deny with minimum privilege**: agents get the least access needed for their declared purpose, and escalation requires explicit per-call approval.

This classification system is domain-agnostic. Whether the swarm is analyzing data, writing code, automating browsers, or sending emails, the same tier checks apply to every tool invocation.

See also: [Security Model](security.md) · [Architecture & Design](architecture.md)

> **This page is the narrative explanation, not the tier registry.** The tool tables below are illustrative and cover only part of the surface. The complete, always-current tier assignment is generated from `TOOL_TIER_MAP` into **[reference/tool-tiers.md](reference/tool-tiers.md)** (regenerate with `pnpm docs:reference`; CI fails when it drifts). When the two disagree, the generated file wins.

---

## The Five Tiers

| Tier | Name | Behaviour |
|------|------|-----------|
| **0** | Read-only | Always allowed. No side effects. No approval required. |
| **1** | Write | Workspace-scoped writes. No approval required but all writes are audited. |
| **2** | Execute | Execution-tier actions. Internal swarm orchestration is auto-allowed; external execution still requires per-call approval. Shell execution always stays in Docker sandbox. |
| **3** | Privileged | Requires per-call approval + generates audit entry with full args. |
| **4** | Blocked | Never executed. Hard-coded reject. |

**Philosophy:** Tier 0 tools can never cause harm — they only read information the agent already has access to. Each tier above adds a capability (network egress, filesystem writes, process execution, external service calls) and a corresponding control. Tier 4 tools represent actions that would give an agent uncontained access to the host environment; they are removed from the tool registry entirely.

Tier 2 is intentionally split. Orchestration-only tools such as `delegate_to_agent`, `parallel_delegate`, `run_task_graph`, and `run_workflow` stay inside the guarded swarm runtime and do not require human approval. Command execution, scripts, HTTP requests, and git mutations remain approval-gated, and shell/script execution still runs only inside the Docker sandbox.

This tier model is also the hard boundary for self-improvement. The swarm may refine prompts, memory, agent definitions, and approved tool assignments for specialists, but it may not use self-improvement to reclassify tools, weaken approvals, expose secrets, or bypass the guarded contract. Credential-bearing actions remain secret-safe tool calls, never plain-text reads into model context.

---

## Full Tool Registry

### Tier 0 — Read-Only (Always Allowed)

| Tool | Description |
|------|-------------|
| `list_agents` | Search registered sub-agents semantically — requires a query, returns top matches (no full catalog dump) |
| `search_agents` | Score agents against a query using hybrid routing — returns the single best match |
| `search_tools` | Semantic search over registered tools — find which tool handles a sub-task without loading all tool schemas. A match the caller cannot call is marked: loadable with `load_tool`, or not in its tools with up to three agents that hold it (ranked like `search_agents`) to delegate to |
| `search_workflows` | Search reusable scenes and jobs in the workflow catalog |
| `read_file` | Read a file from the workspace |
| `list_files` | List files in a workspace directory |
| `export_workspace_artifact` | Surface an existing workspace file or folder as a downloadable chat artifact |
| `web_search` | Search via the configured web-search backend with SearXNG, Playwright, and DuckDuckGo fallback |
| `web_fetch` | Fetch a URL and return text content, preferring rendered browser content for HTML pages |
| `workspace_search` | Full-text search across workspace files |
| `memory_search` | Search the agent memory store |
| `session_status` | Read current session metadata |
| `get_site_credentials` | Check whether stored site credentials exist and return non-secret login metadata |
| `extract_file_content` | Convert a workspace file (PDF/DOCX/PPTX/XLSX/image) to Markdown via the multimodal backend |
| `extract_notebook` | Parse a Jupyter `.ipynb` into Markdown with code, outputs, and image refs |
| `extract_email` | Parse `.eml` or single-message `.mbox` into headers, body, and attachment list |
| `extract_calendar` | Parse a `.ics` file into a structured event list |
| `spreadsheet_read` | Read a workspace spreadsheet (XLSX/CSV/ODS) and return sheets as JSON row arrays |
| `list_pdf_form_fields` | Inspect AcroForm fields in an existing PDF |
| `analyze_image` | Analyze a workspace image with the configured vision-capable LLM |
| `transcribe_audio` | Transcribe an audio file via the configured STT backend |
| `transcribe_video` | Transcribe the audio track of a workspace video file via the same STT backend |
| `list_tts_voices` | List voices available from the configured TTS backend |
| `metric_query` | Run read-only SQL queries against QuestDB time-series data |
| `metric_list_tables` | List available QuestDB time-series tables |
| `log_stream` | Tail and filter Docker Compose service logs or workspace log files |
| `agent_store_read` | Read from per-agent durable key-value storage |
| `research_notes_read` / `research_notes_summary` | Read accumulated research scratchpad notes |
| `assistant_personality_view` | Read the persistent main-assistant personality profile |
| `graph_query` | Run read-only Cypher queries against the MemGraph knowledge graph |
| `graph_find_paths` | Find shortest relationship paths between graph entities |
| `read_shared_facts` | Read the per-session shared swarm fact ledger |
| `get_swarm_state` | Read the current turn-local swarm task state and progress |
| `get_swarm_budget` | Aggregate token, tool-call, and wall-clock spending across swarm tasks |
| `kubectl_get` | List/fetch Kubernetes resources from an external cluster |
| `kubectl_describe` | Describe a Kubernetes resource (events, conditions, related state) |
| `kubectl_logs` | Fetch container logs from a pod, with tail/since/previous filters |
| `kubectl_top` | Report pod or node CPU/memory usage (requires Metrics API) |
| `helm_list` | List Helm releases in the target Kubernetes cluster |
| `prometheus_query` | Run a PromQL instant or range query against an external Prometheus instance |
| `alertmanager_silences_list` | List active silences on an external Alertmanager instance |
| `grafana_dashboard_search` | Search Grafana dashboards by query, tag, or folder |
| `grafana_alerts_list` | List Grafana unified-alerting rules in a folder |
| `github_pr_list` | List pull requests on a remote GitHub repository |
| `github_pr_get` | Fetch a single pull request by number |
| `github_check_runs_list` | List CI check runs for a commit / PR head SHA |
| `github_actions_runs_list` | List GitHub Actions workflow runs (across all workflows or one) |
| `browser_navigate` / `browser_snapshot` / `browser_screenshot` / `browser_wait_for` | Navigate / inspect / capture the shared browser session |

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
| `generate_docx` | Save a Microsoft Word `.docx` from Markdown content or structured blocks | None |
| `generate_pptx` | Save a PowerPoint `.pptx` from a structured slide list (5 layouts) | None |
| `generate_website` | Save a complete multi-page static website (HTML + theme CSS + assets) in one call | None |
| `generate_svg` | Write a raw SVG illustration or data visualization to the workspace | None |
| `generate_qr_code` | Encode text/URL/Wi-Fi/vCard data as a QR-code SVG | None |
| `generate_ics` | Emit an iCalendar `.ics` file from a structured event list | None |
| `generate_image` | Generate a raster image via the configured image-generation backend | None |
| `synthesize_speech` | Generate a WAV audio artifact via the configured TTS backend | None |
| `bundle_artifact_zip` | Package workspace files / directories / inline content into a single `.zip` | None |
| `pdf_fill` | Fill form fields in an existing PDF and write the result to the workspace | None |
| `spreadsheet_write` | Write tabular data to a spreadsheet file (xlsx, csv) in the workspace | None |
| `metric_write` | Write rows to QuestDB time-series tables | None |
| `agent_store_write` / `agent_store_delete` | Per-agent durable key-value store (Redis/Postgres backed) | None |
| `research_note` / `research_notes_clear` | Research scratchpad note write/clear | None |
| `share_finding` / `share_evidence` | Publish a finding or evidence record to the shared swarm fact ledger | None |
| `record_plan` | Record the orchestrator's structured plan (objective, steps, acceptance criteria) for a complex turn | None |
| `graph_upsert_entity` / `graph_relate` / `graph_delete_node` | Write to the MemGraph knowledge graph | None |
| `memory_promote` / `memory_compact` | Promote ephemeral memory to durable; compact memory store | None |
| `n8n_fetch_leads` | Fetch lead data from an n8n workflow | None |
| `n8n_mark_applied` | Mark a lead as applied in n8n | None |
| `webhook__<name>` | Any auto-registered webhook tool | None (auto-classified Tier 1) |
| `mail_list_accounts` | List configured mail accounts | None |
| `mail_list_mailboxes` | List mailboxes for a mail account | None |
| `mail_search` | Search email across one or more accounts | None |
| `mail_read` | Read a specific email message | None |
| `mail_save_attachment` | Save a mail attachment into the workspace after a fail-closed virus scan | None |
| `mail_list_unread` | List unread messages in a mailbox | None |
| `mail_create_mailbox` | Create a mailbox folder | None |
| `mail_delete_mailbox` | Delete an empty mailbox folder | None |
| `mail_move` | Move messages to a different mailbox folder | None |
| `mail_delete` | Delete messages (move to Trash or permanent) | None |
| `mail_prepare_draft` | Create a draft message for review before sending | None |
| `mail_update_draft` | Update a saved draft | None |
| `mail_get_draft` | Read a saved draft | None |
| `mail_categorize` | Attach a category label and note to a message | None |
| `mail_send_draft` | Send an approved draft — requires human approval | Per-call |
| `calendar_list_calendars` | List CalDAV calendars for a mail account | None |
| `calendar_list_events` | List events in a calendar within a date range | None |
| `calendar_create_event` | Create a new calendar event | None |
| `calendar_update_event` | Update an existing calendar event | None |
| `calendar_delete_event` | Delete a calendar event | None |
| `contacts_list_address_books` | List CardDAV address books for a mail account | None |
| `contacts_search` | Search or list contacts in an address book | None |
| `contacts_create` | Create a new contact | None |
| `contacts_update` | Update an existing contact | None |
| `contacts_delete` | Delete a contact | None |

### Tier 2 — Execute (Execution-Tier, Approval Depends On Tool)

| Tool | Description | Approval | Sandbox |
|------|-------------|---------|---------|
| `delegate_to_agent` | Delegate a task to a named or auto-routed sub-agent via A2A | None | No |
| `swarm_delegate` | Delegate undirected — the swarm routing system picks the best specialist automatically | None | No |
| `create_ephemeral_agent` | Create a temporary sub-agent from a spec | None | No |
| `parallel_delegate` | Run up to 5 agents concurrently | None | No |
| `run_task_graph` | Execute a dependency-aware swarm task graph | None | No |
| `run_workflow` | Execute a reusable scene or job inline in a temporary workflow session | None | No |
| `sql_query` | Run a parameterised query against a PostgreSQL / MySQL / MariaDB database (writes too) | Per-call | No |
| `shell_exec` | Execute a shell command | Per-call | Yes — Docker container |
| `run_script` | Run a script file | Per-call | Yes — Docker container |
| `run_test_suite` | Docker-sandboxed test runner (vitest/jest/pytest/mocha/go/cargo/make/npm/custom) | Per-call | Yes — Docker container |
| `http_request` | Make an outbound HTTP request | Per-call | No |
| `git_commit` | Stage files and create a git commit | Per-call | Yes — Docker container |
| `git_checkout` | Switch or create branches, restore files | Per-call | Yes — Docker container |
| `git_clone` | Clone a remote repository over HTTPS | Per-call | Yes — Docker container |
| `git_tag` | Create annotated or lightweight git tags | Per-call | Yes — Docker container |
| `git_push` | Push a branch / tag to a remote (GitHub / GitLab / etc.) | Per-call | Yes — Docker container |
| `kubectl_apply` | Apply a Kubernetes manifest (create/update) — supports server-side apply, prune, dry-run | Per-call | No |
| `kubectl_delete` | Delete a Kubernetes resource by name or label selector | Per-call | No |
| `kubectl_rollout_restart` | Trigger a rolling restart of a Deployment / StatefulSet / DaemonSet | Per-call | No |
| `kubectl_scale` | Scale a workload to a specific replica count (with current-replicas precondition) | Per-call | No |
| `helm_upgrade` | Upgrade (or install with `install=true`) a Helm release | Per-call | No |
| `helm_rollback` | Roll back a Helm release to a previous revision | Per-call | No |
| `alertmanager_silence_create` | Create an Alertmanager silence (mute alerts during maintenance) | Per-call | No |
| `alertmanager_silence_expire` | Expire an Alertmanager silence by id | Per-call | No |
| `grafana_dashboard_apply` | Create or update a Grafana dashboard via `/api/dashboards/db` | Per-call | No |
| `grafana_alert_apply` | Create or update a Grafana unified-alerting rule via the provisioning API | Per-call | No |
| `github_pr_create` | Open a new pull request on a remote GitHub repository | Per-call | No |
| `github_pr_comment` | Post an issue-style comment on a pull request thread | Per-call | No |
| `github_actions_trigger` | Trigger a `workflow_dispatch` run for a GitHub Actions workflow | Per-call | No |
| `github_release_create` | Create a GitHub Release pointing at a tag with optional release notes | Per-call | No |
| `ask_user` | Pause execution and surface a question to the operator (multi-choice or free-text) | None | No |
| `tool_dev_start` / `tool_dev_submit` | Start / submit a self-developed tool for review | Per-call | Yes — Docker sandbox |
| `cron_remove` / `cron_list` | Remove or list scheduled cron jobs | Per-call | No |
| `schedule_list` | List the scheduled tasks: what runs later or repeats, and what each watch waits for | None | No |
| `request_new_capability` / `list_capability_gaps` | Capability-gap signaling for the self-improvement loop | None | No |
| `swarm_validate` | Validate self-authored scenes/jobs/agent definitions (JSON, schema, references) before applying — read-only | None | No |
| `assistant_personality_update` | Update the persistent main-assistant personality profile | Per-call | No |
| `mail_send_draft` | Send an approved mail draft (mail composition is otherwise Tier 1) | Per-call | No |
| `site_fill_credentials` | Securely fill stored credentials into browser login fields | Per-call | No |
| `computer_type_credential` | Securely type stored credentials into a desktop login form | Per-call | No |
| `browser_click` / `browser_type` / `browser_select_option` | Mutating browser interactions in the shared session | Per-call | No |
| `computer_*` (mouse / keyboard / file transfer) | Remote desktop interactions via the computer-use agent | Per-call | No |

Internal orchestration tools stay inside the guarded runtime, so they do not need per-call approval even though they are execution-tier. Tools that execute commands, mutate git state, or reach outside the workspace remain approval-gated.

`shell_exec` and `run_script` **always** run inside the Docker sandbox container. There is no code path that can execute these on the host.

`get_site_credentials` is Tier 0 because it returns metadata only. The secret-bearing actions stay approval-gated through `site_fill_credentials` and `computer_type_credential`.

### Tier 3 — Privileged (Per-Call Approval + Audit)

The tier says that a call needs approval, not who gives it. Without an [approval policy](#who-may-approve-a-call-approval-policies) the approval goes wherever the call's approval callback reaches: in a chat, that is the person who asked.

| Tool | Description | Approval |
|------|-------------|---------|
| `send_telegram` | Send a Telegram message via the bot | Per-call + audit |
| `send_slack` | Send a Slack message via the bot | Per-call + audit |
| `send_discord` | Send a Discord message via the bot | Per-call + audit |
| `send_email` | Send an email message (separate from `mail_send_draft`) | Per-call + audit |
| `send_agent_message` | Direct A2A message to another sub-agent (Stage 9 messaging) | Per-call + audit |
| `cron_create` | Register a new cron schedule | Per-call + audit |
| `schedule_task` | Run a task later, once or repeating, as a turn of its own, and post what it finds into the conversation it was made in; with `until`, a watch that stays silent until the awaited thing has happened. Held by the main assistant. A scheduled run has nobody to approve a call, so it cannot schedule more | Per-call + audit |
| `schedule_remove` | Remove a scheduled task | Per-call + audit |
| `vm_manage` | Manage VMs through configured infrastructure backends | Per-call + audit |
| `proxmox_vm` | Manage Proxmox VMs via the Proxmox VE API | Per-call + audit |
| `terraform_exec` | Run Terraform provisioning and stateful changes | Per-call + audit |
| `ansible_playbook` | Run an Ansible playbook for privileged infrastructure changes | Per-call + audit |
| `ansible_task` | Run a single Ansible ad-hoc task against remote inventory | Per-call + audit |
| `service_check` | Check remote infrastructure readiness from the host | Per-call + audit |
| `ssh_exec` | Run a remote SSH command on a target host, optionally via a configured `remote_ssh` `nodeName` | Per-call + audit |
| `ssh_upload` | Upload files or directories to a remote host | Per-call + audit |
| `ssh_download` | Download files or directories from a remote host | Per-call + audit |
| `mcp__<server>__<tool>` (unlisted) | Any MCP tool not explicitly listed in Tier 0 | Per-call + audit |
| `selfdev__<name>` | Self-developed dynamic tools (sandbox-loaded from `.starlingai/dynamic_tools/`) | Per-call + sandbox + audit |

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

Runs before any tool is executed. Enforces the tier table above. A per-call approval request blocks execution until it is approved or denied, and a denied call is logged. Where the request goes depends on the run: a chat turn shows an approval card on the requester's own socket; a scene or job run sends it to the scene's approval channel (Slack or a webhook). A tool with an approval policy decides this itself (next section).

### Who may approve a call: approval policies

A tool that requires per-call approval can name the roles that may grant it. Core tools declare none. An extension declares a policy on its tool (see [Forking](forking.md#3-add-your-domain-backend-as-a-core-extension)):

```ts
{ name: "record_export", tier: ToolTier.THREE_PRIVILEGED, requiresPerCallApproval: true,
  approval: { approverRoles: ["reviewer"], distinctApprover: true }, /* ... */ }
```

- **`approverRoles`**: role names as JWT `role` claims carry them, matched like route policies (`policyAdmitsRole`): a listed name, and among the built-in roles every higher one (`operator` admits `admin`). An extension role is never admitted through rank.
- **`distinctApprover`**: a second person must approve. The requester never decides their own call, whatever their role.

The requester is the person who sent the message: the signed-in caller of the chat socket or of the AG-UI request, with the role they hold now. Sub-agent and workflow calls inherit them. This is not always the session's owner and its stored role. A session keeps the role it was created with, and an admin may drive another account's chat. Where nobody sent a message (a job, A2A, MCP), the requester is the call's own identity and role.

`executeTool` keeps the requester's own approval card only when all of these hold:

- a person sent the message, and the chat is their own. An admin driving another account's chat is routed, and is recorded as the one who asked;
- the policy admits the role they hold when the call is made. An unknown role is admitted by no policy;
- no second person is required;
- the turn is not running with `--auto`; and
- the callback is the chat's own approval card. A callback that answers by itself never grants such a call: `--auto`, the legacy A2A route's `autoApprove`, a scene's approval channel.

Their role is read again when they answer the card. A requester who no longer holds an approver role then does not grant the call.

Every other call is **routed**:

1. It waits in the approval store as a `routed` entry with no secret.
2. The approvers get a notification. Only connections whose role the policy admits receive it.
3. The requester's chat shows `agent.approval_pending`, with no answer button.
4. `GET /api/approvals/pending` lists the entry only to callers the policy admits, and with `distinctApprover` not to the requester. A viewer's list is empty.
5. `POST /api/approval/:id` decides it for a signed-in approver only. Any other signed-in caller gets `403`, and the requester under `distinctApprover` gets `403 A second person must approve this request`. The one-click link, the approval secret and a request without a session get the answer an unknown id gets (`404`).
6. With no decision within `approvals.routedTimeoutMs` (default: `gateway.approvalTimeoutMs`), the call is denied. A stopped turn withdraws its request.
7. While it waits, the run's clocks hold, as they do for an `ask_user` question: the turn deadline, the chat's watchdog and a sub-agent's deadline. Each is credited the wait's length afterwards. So `routedTimeoutMs` bounds the wait, not what is left of the turn's budget. The turn's 24-hour ceiling still applies.

The tool's handler learns how the call was approved from `ctx.approval`:

- `{ via: "requester", approvedBy, approverRole }` when the requester approved on their own card: who they are, and their role when they answered.
- `{ via: "routed", approvalId, approvedBy, approverRole }` when an approver decided it.

Calls of tools without a policy run with their context unchanged, except that a call made from inside a policy tool's handler does not inherit its `ctx.approval`. The audit log records `approval_routed_requested` (tool, approval id, approver roles, requester) and `approval_routed_resolved` (who decided, with which role, or how the wait ended), never the arguments.

`executeTool` (`tools/registry.ts`) checks a call in this order, and the first check that says no ends it:

1. Tier 4 (Blocked) and unregistered names are refused.
2. Every core extension's `authorizeToolCall` hook, in load order. A refusal is audited as `tool_call_refused` (tool, role, extension; never the arguments). A hook that throws refuses the call.
3. A tool that claims `requiresSandbox` without a sandboxed execution path is refused.
4. The tool's own `refuse` (argument checks).
5. The effect retry guard (an identical retry of a mutation whose outcome is unknown).
6. The approval gate: tier `requiresPerCallApproval`, a scene's `humanInLoopSteps`, or the effect policy under `guardrails.effectContracts: "enforce"`.

Steps 2 and 4 come before the approval gate, so nobody is asked to approve a call that would then be refused.

**The caller's role.** `ToolContext.userRole` is the authenticated role of the person a call answers to. A chat turn takes it from its session, and every run the turn starts inherits it through the request context (`RequestContext.callerRole`): sub-agents, workflow steps and their nested turns, ephemeral agents. A2A `tasks/send`, the legacy A2A route and MCP agent and scene calls set it from the signed-in account. A job a person queued, and each run of a schedule a person made with `schedule_task`, records the role it was queued with; the scene worker runs it with the owner's role as the account holds it when the run starts, and fails a job whose owner no longer signs in before it runs. Every claimed job runs in a request context of its own, so nothing reaches it from the work that queued it or woke the worker. Channel messages, configured cron and webhook-key runs, federated peers, and jobs and schedules queued before roles were recorded carry no role. With auth off a surface takes the role from the token: a WebSocket chat and `/job` carry the `role` claim as given (none without one), AG-UI turns and the REST scene and job run routes carry `operator` without one, and A2A and MCP runs carry none. Role-aware tools treat a missing role as before: knowledge-base management and schedules apply no role rule, and under multi-user auth the model switch refuses (with auth off it always allows).

A standalone scene worker (`scene-worker-main.ts`) reads its config and the account registry once, when it starts, and loads no extensions: of each extension it declares only the roles, also when it starts. In a split deployment it checks a job's owner against the accounts as they were then: a demotion or a deletion reaches queued jobs once the worker restarts, and a job queued by an account of an extension's auth provider fails there. A builtin account holding an extension's role runs its jobs there with that role. An extension that does not load in the worker (its module does not import there, or its manifest is refused) declares no role there, so those jobs fail and their schedules end as after any failed runs ([Roles Nobody Declares](security.md#roles-nobody-declares)).

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
