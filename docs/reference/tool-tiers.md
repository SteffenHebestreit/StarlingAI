<!-- GENERATED FILE — do not edit by hand. Regenerate with `pnpm docs:reference`.
     Source of truth: packages/core/src/guardrails/tool-tiers.ts (TOOL_TIER_MAP). CI fails when this file drifts from the code. -->


# Tool permission tiers (enforced in code)

Tiers are hard-coded and cannot be overridden at runtime; a tool absent from the map is blocked (tier 4). `approval` = per-invocation human approval required by the tier itself (scene `humanInLoopSteps` can additionally force approval for any tool).

## Tier 0 — read-only

Always allowed; no side effects.

| Tool | Approval | Sandbox | Description |
| --- | --- | --- | --- |
| `agent_catalog` | — | — | Flat directory of all specialist sub-agents and their capabilities (answers 'what agents exist') |
| `agent_store_read` | — | — | Read temporary data from the agent data store |
| `alertmanager_silences_list` | — | — | List active silences on an external Alertmanager instance (read-only) |
| `analyze_image` | — | — | Analyze an image from the workspace with the configured vision-capable LLM |
| `ask_user` | — | — | Pause execution and ask the human user a question with optional choices |
| `assistant_personality_view` | — | — | Read the persistent main-assistant personality profile |
| `browser_axe_audit` | — | — | Run an axe-core WCAG accessibility audit against the current Playwright browser page |
| `browser_navigate` | — | — | Navigate the shared browser session to a URL |
| `browser_screenshot` | — | — | Capture a screenshot of the current browser page |
| `browser_snapshot` | — | — | Capture an accessibility snapshot of the current browser page |
| `browser_wait_for` | — | — | Wait for text to appear or disappear on the current browser page |
| `calendar_list_calendars` | — | — | List available CalDAV calendars for a configured account |
| `calendar_list_events` | — | — | List events in a CalDAV calendar within a date range |
| `computer_capture_region` | — | — | Capture a specific screen region and analyze with vision |
| `computer_list_nodes` | — | — | List configured computer nodes available for connection |
| `computer_list_sessions` | — | — | List currently open computer sessions for reuse or attach |
| `computer_list_windows` | — | — | List open windows with titles, process names, and bounds |
| `computer_snapshot` | — | — | Capture screenshot + accessibility tree, analyze via vision model |
| `computer_wait_for` | — | — | Wait for a visual condition on screen (poll screenshots + vision) |
| `contacts_list_address_books` | — | — | List available CardDAV address books for a configured account |
| `contacts_search` | — | — | Search contacts in a CardDAV address book |
| `cron_list` | — | — | List active cron jobs |
| `datetime_arithmetic` | — | — | Date/time arithmetic — add or subtract durations, compute differences, format/parse without delegating |
| `export_workspace_artifact` | — | — | Expose an existing workspace file or folder as a downloadable chat artifact |
| `extract_calendar` | — | — | Parse an .ics file into a structured event list |
| `extract_email` | — | — | Parse an .eml or single-message .mbox file into headers, body, and attachment list |
| `extract_file_content` | — | — | Convert a workspace file into Markdown using the configured file-conversion service |
| `extract_notebook` | — | — | Convert a Jupyter .ipynb notebook into a single Markdown document with code, outputs, and image refs |
| `federated_workspace_search` | — | — | Broadcast workspace_search across federated peer instances and merge ranked results |
| `get_crypto_price` | — | — | Fetch real-time crypto-asset prices in any quote currency (CoinGecko) |
| `get_fx_rate` | — | — | Convert fiat currencies using free ECB reference rates (Frankfurter) |
| `get_news_headlines` | — | — | Fetch recent news headlines from a free public source (Hacker News, Reddit, RSS) |
| `get_site_credentials` | — | — | Check whether stored credentials exist for a website and retrieve non-secret metadata (login URL, selectors) |
| `get_swarm_budget` | — | — | Aggregate token, tool-call, and wall-clock spending across swarm tasks; flags budget breaches |
| `get_swarm_state` | — | — | Read the current turn-local swarm task state and progress |
| `get_weather` | — | — | Fetch current weather and short-term forecast for a lat/lon (Open-Meteo by default) |
| `git_diff` | — | — | Show diff of staged, unstaged, or between refs |
| `git_log` | — | — | Show commit history with optional path and count filters |
| `git_status` | — | — | Show working tree status (porcelain v2) |
| `github_actions_runs_list` | — | — | List GitHub Actions workflow runs (read-only) |
| `github_check_runs_list` | — | — | List CI check runs for a commit on a remote GitHub repository (read-only) |
| `github_pr_get` | — | — | Fetch a single pull request by number from a remote GitHub repository (read-only) |
| `github_pr_list` | — | — | List pull requests on a remote GitHub repository (read-only) |
| `grafana_alerts_list` | — | — | List Grafana unified-alerting rules (read-only) |
| `grafana_dashboard_search` | — | — | Search Grafana dashboards by query / tag / folder (read-only) |
| `graph_find_paths` | — | — | Find shortest relationship paths between graph entities |
| `graph_query` | — | — | Run read-only Cypher queries against the MemGraph knowledge graph |
| `hash_compute` | — | — | Compute md5/sha1/sha256/sha512 hash of a UTF-8 string — useful for content fingerprints, dedup checks, integrity comparisons |
| `helm_list` | — | — | List Helm releases in the target Kubernetes cluster (read-only) |
| `json_query` | — | — | Extract values from a JSON document via a dot/bracket path expression (jq-lite — no piping or transforms) |
| `kubectl_describe` | — | — | Describe a Kubernetes resource in detail (read-only) |
| `kubectl_get` | — | — | Get Kubernetes resources from an external cluster (read-only) |
| `kubectl_logs` | — | — | Fetch container logs from a pod in an external Kubernetes cluster (read-only) |
| `kubectl_top` | — | — | Report current CPU and memory usage for pods or nodes (read-only, requires Metrics API) |
| `lighthouse_audit` | — | — | Run a Google PageSpeed Insights (Lighthouse) audit against a public URL |
| `list_agents` | — | — | List available specialized sub-agents and their descriptions |
| `list_capability_gaps` | — | — | List detected capability gaps and their status |
| `list_data_feeds` | — | — | List all registered data-feed providers and whether they are enabled |
| `list_documents` | — | — | List documents available to this conversation's RAG library (engram) |
| `list_federation_peers` | — | — | List configured federation peer instances and their advertised agent + tool surface |
| `list_files` | — | — | List files/dirs within workspace |
| `list_knowledge_bases` | — | — | List crawled knowledge bases with status/size, or one KB's crawl progress detail |
| `list_pdf_form_fields` | — | — | Inspect AcroForm fields in an existing PDF file |
| `list_skills` | — | — | List Skill Library entries with status and reliability stats |
| `list_tts_voices` | — | — | List voices from the configured TTS backend |
| `log_stream` | — | — | Tail and filter container logs or workspace log files (read-only) |
| `mail_get_draft` | — | — | Read a prepared mail draft from the headless mail service |
| `mail_list_accounts` | — | — | List configured mail accounts from the headless mail service |
| `mail_list_mailboxes` | — | — | List mailboxes for a configured mail account |
| `mail_list_unread` | — | — | List unread messages across one or more configured mail accounts |
| `mail_read` | — | — | Read a specific mail message by account, mailbox, and UID |
| `mail_search` | — | — | Search messages across one or more configured mail accounts |
| `memory_search` | — | — | Search RAG memory store |
| `metric_list_tables` | — | — | List available QuestDB time-series tables |
| `metric_query` | — | — | Run read-only SQL queries against QuestDB time-series data |
| `prometheus_query` | — | — | Run a PromQL query against an external Prometheus instance (read-only) |
| `rag_search` | — | — | Semantic search over previously ingested RAG documents (pgvector) |
| `read_file` | — | — | Read file within workspace directory |
| `read_rss_feed` | — | — | Read latest items from a public RSS or Atom feed URL (SSRF-guarded) |
| `read_shared_facts` | — | — | Read shared swarm facts collected during the current session |
| `recall_context` | — | — | Pull a compact planning-context pack (user model, working facts, memory, sessions, skills) for a task |
| `regex_test` | — | — | Test a regex against sample text and return matches with capture groups |
| `request_human_assist` | — | — | Pause and ask a human to take over the live browser to clear a CAPTCHA/verification, then resume |
| `research_notes_read` | — | — | Read accumulated research scratchpad notes for the current session |
| `research_notes_summary` | — | — | Summarize research scratchpad notes by topic and importance |
| `schedule_list` | — | — | List persistent scheduled tasks |
| `search_agents` | — | — | Semantic capability search over specialized sub-agents; falls back to guarded routing heuristics when embeddings are unavailable |
| `search_documents` | — | — | Graph-RAG search over attached/uploaded documents (engram), scoped to the conversation/user/workspace |
| `search_knowledge_base` | — | — | Scoped graph-RAG search over one crawled knowledge base, excerpts cite source page URLs |
| `search_sessions` | — | — | Full-text search over past conversations with optional LLM summarization |
| `search_skills` | — | — | Search the Skill Library for reusable procedures learned from past work |
| `search_tools` | — | — | Semantic search over registered tools — returns relevant tool names and descriptions for a task |
| `search_workflows` | — | — | Search reusable scenes and jobs in the workflow catalog |
| `searchsploit_query` | — | — | Search Exploit-DB / SearchSploit for known CVEs and exploit PoCs (offline, no network traffic to target) |
| `session_status` | — | — | Get current session metadata |
| `spreadsheet_read` | — | — | Read a workspace spreadsheet (XLSX, XLS, ODS, CSV) and return sheets as JSON row arrays |
| `swarm_validate` | — | — | Validate self-authored scenes, jobs, and agent definitions (read-only, no apply) |
| `text_diff` | — | — | Line-by-line unified diff between two text strings (no git required) — useful for comparing snippets, draft revisions, or expected vs actual |
| `transcribe_audio` | — | — | Transcribe an audio file from the workspace using the configured STT backend |
| `transcribe_video` | — | — | Transcribe the audio track of a workspace video file via the configured STT backend |
| `url_inspect` | — | — | HEAD-probe a URL — returns status code, final URL after redirects, content-type, content-length, server header (no body fetched) |
| `user_model_view` | — | — | Read the agent's evolving model of the current user |
| `vscode_diff` | — | — | Open a diff view for two files in VS Code |
| `vscode_get_active_editor` | — | — | Return current VS Code file, selection, and cursor position |
| `vscode_get_diagnostics` | — | — | Read VS Code problems panel diagnostics |
| `vscode_search_workspace` | — | — | Full workspace text search in VS Code |
| `web_fetch` | — | — | Fetch and read content from a public URL |
| `web_search` | — | — | Search the public web for documentation, news, and references |
| `wikipedia_lookup` | — | — | Look up a Wikipedia article summary by title or free-text term |
| `workspace_search` | — | — | Full-text keyword search across workspace text files |

## Tier 1 — workspace writes

Write operations inside the workspace; session-level consent once.

| Tool | Approval | Sandbox | Description |
| --- | --- | --- | --- |
| `agent_store_delete` | — | — | Delete temporary data from the agent data store |
| `agent_store_write` | — | — | Write temporary data to the agent data store (24h TTL) |
| `assistant_personality_update` | — | — | Update the persistent main-assistant personality profile |
| `bundle_artifact_zip` | — | — | Bundle workspace files, directories, or inline content into a single .zip in the workspace |
| `calendar_create_event` | per-call | — | Create a new event in a CalDAV calendar |
| `calendar_delete_event` | per-call | — | Delete an event from a CalDAV calendar |
| `calendar_update_event` | per-call | — | Update an existing event in a CalDAV calendar |
| `computer_session_stop` | — | — | Graceful stop of a computer session |
| `contacts_create` | per-call | — | Create a new contact in a CardDAV address book |
| `contacts_delete` | per-call | — | Delete a contact from a CardDAV address book |
| `contacts_update` | per-call | — | Update an existing contact in a CardDAV address book |
| `create_dir` | — | — | Create directory within workspace |
| `create_knowledge_base` | — | — | Create a knowledge base and recursively crawl a documentation site into engram (background, bounded, SSRF-guarded) |
| `curate_memory` | — | — | Review durable memory health and optionally consolidate duplicates |
| `delete_file` | per-call | — | Delete file within workspace (with confirmation) |
| `edit_file` | — | — | Apply patch/edit to file within workspace |
| `export_evidence_ledger` | — | — | Write a validated evidence ledger artifact into the workspace and share its path |
| `fetch_image` | — | — | Download + verify a real image from a URL/page and save it into the workspace |
| `forget_document` | — | — | Remove a document from the engram library (scope reference or hard delete) |
| `generate_chart_html` | — | — | Generate an HTML chart report and save it inside the workspace |
| `generate_document` | — | — | Generate and save a workspace document as Markdown, text, HTML, or JSON |
| `generate_docx` | — | — | Generate a Microsoft Word .docx in the workspace from Markdown content or structured blocks |
| `generate_ics` | — | — | Emit an iCalendar (.ics) file from a structured event list |
| `generate_image` | — | — | Generate an image from text and save it inside the workspace |
| `generate_mermaid_diagram` | — | — | Generate a Mermaid diagram source artifact and save it inside the workspace |
| `generate_pdf` | — | — | Generate and save a simple PDF document in the workspace |
| `generate_pptx` | — | — | Generate a PowerPoint .pptx in the workspace from a structured slide list |
| `generate_presentation` | — | — | Generate a self-contained reveal.js HTML slide deck in the workspace from a structured slide list |
| `generate_qr_code` | — | — | Encode text or URL into a QR code SVG and write it to the workspace |
| `generate_svg` | — | — | Write a raw SVG illustration or data visualization to the workspace |
| `generate_website` | — | — | Generate a complete multi-page static website in the workspace (HTML + CSS + optional assets) |
| `graph_delete_node` | — | — | Delete a node and its relationships from the MemGraph knowledge graph |
| `graph_relate` | — | — | Create or update a relationship between graph entities |
| `graph_upsert_entity` | — | — | Create or update a node in the MemGraph knowledge graph |
| `ingest_document` | — | — | Extract a workspace file and index it into the engram document library at a chosen scope |
| `mail_categorize` | — | — | Persist local categories and notes for specific mail messages |
| `mail_create_mailbox` | — | — | Create a mailbox or folder for a configured mail account |
| `mail_delete` | per-call | — | Delete or trash one or more mail messages from a configured mail account |
| `mail_delete_mailbox` | per-call | — | Delete an empty mailbox or folder for a configured mail account |
| `mail_move` | — | — | Move one or more mail messages into another mailbox or folder |
| `mail_prepare_draft` | — | — | Create a draft email for a specific configured mail account |
| `mail_update_draft` | — | — | Update an existing mail draft |
| `manage_knowledge_base` | — | — | Re-crawl, cancel a crawl, or delete a knowledge base and its indexed pages |
| `memory_compact` | — | — | Compact and deduplicate durable workspace memory |
| `memory_export` | — | — | Mirror durable memory into an Obsidian-style Markdown vault for review |
| `memory_import` | — | — | Re-ingest edited memory-vault notes back into the durable store |
| `memory_promote` | — | — | Promote session or agent memory into durable workspace memory |
| `memory_store` | — | — | Store entry in RAG memory |
| `metric_write` | — | — | Write a measurement into QuestDB time-series storage |
| `pentest_report` | — | — | Generate a structured pentest report from collected findings and save it to the workspace |
| `rag_forget` | — | — | Delete this session's ingested RAG documents from the pgvector store |
| `rag_ingest` | — | — | Chunk + embed large text/attachments into the pgvector RAG store for later retrieval |
| `record_lesson` | — | — | Record a lesson learned from a task execution into the agent outcome log |
| `record_plan` | — | — | Record the orchestrator's structured plan for a complex turn |
| `record_skill` | — | — | Author a reusable procedure (skill) in the Skill Library from experience |
| `request_new_capability` | — | — | Request development of a new tool to fill a capability gap |
| `research_note` | — | — | Write a research finding into the durable scratchpad for the current session |
| `research_notes_clear` | — | — | Clear research scratchpad notes for the current session |
| `run_tool_pipeline` | — | — | Batch several tool calls in one step; each sub-call keeps its own tier and approval gate |
| `send_agent_message` | — | — | Queue a direct message for another agent in the current swarm session |
| `share_evidence` | — | — | Publish a source-backed evidence record into shared swarm memory for sibling agents |
| `share_finding` | — | — | Publish a finding into shared swarm memory for sibling agents |
| `skill_manage` | — | — | Create, patch, pin, archive, and maintain Skill Library procedures and support files |
| `spreadsheet_write` | — | — | Write JSON row data to an XLSX file in the workspace |
| `synthesize_speech` | — | — | Generate speech audio and save it inside the workspace |
| `use_knowledge_base` | — | — | Run a knowledge base's single-use worker agent on a task, grounded in that KB (may inspect live targets and write outputs) |
| `user_model_update` | — | — | Revise the agent's evolving model of the current user |
| `vscode_focus_panel` | — | — | Focus a VS Code panel (terminal, problems, explorer, source-control) |
| `vscode_open_file` | — | — | Open a file in VS Code editor at optional line/column |
| `write_file` | — | — | Write/overwrite file within workspace |

## Tier 2 — execution

Code/command execution; per-invocation approval; always sandboxed.

| Tool | Approval | Sandbox | Description |
| --- | --- | --- | --- |
| `alertmanager_silence_create` | per-call | — | Create a silence on an external Alertmanager instance (mutates alert routing) |
| `alertmanager_silence_expire` | per-call | — | Expire a silence on an external Alertmanager instance |
| `browser_click` | — | — | Click an element in the shared browser session |
| `browser_select_option` | — | — | Select an option in the shared browser session |
| `browser_type` | — | — | Type text into a form element in the shared browser session |
| `computer_click` | per-call | — | Click at (x, y) on the computer screen |
| `computer_clipboard_read` | per-call | — | Read clipboard contents (potential secret exposure) |
| `computer_clipboard_write` | per-call | — | Write to clipboard (potential data injection) |
| `computer_download_file` | per-call | — | Transfer a file from a remote computer session |
| `computer_drag` | per-call | — | Drag from one position to another |
| `computer_focus_window` | per-call | — | Focus a window by title pattern |
| `computer_hotkey` | per-call | — | Send a keyboard shortcut (e.g. ctrl+s) |
| `computer_scroll` | per-call | — | Scroll at a position on the screen |
| `computer_session_attach` | per-call | — | Attach to an existing computer session |
| `computer_session_start` | per-call | — | Start a new computer session (adapter, config) |
| `computer_type` | per-call | — | Type text on the computer |
| `computer_type_credential` | per-call | — | Type a stored credential (username or password) into the focused field on the remote desktop (value never visible to LLM) |
| `computer_upload_file` | per-call | — | Transfer a file to a remote computer session |
| `create_ephemeral_agent` | — | — | Spin up a purpose-built single-use agent from an inline spec and run it immediately |
| `delegate_to_agent` | — | — | Delegate a task to a specialized sub-agent with its own model and tool set |
| `delegate_to_remote_agent` | — | — | Federated delegation — ship a task to a sub-agent running on a peer StarlingAI instance |
| `git_checkout` | per-call | required | Switch or create branches, restore files |
| `git_commit` | per-call | required | Stage files and create a git commit |
| `git_push` | per-call | required | Push commits or tags to a remote git repository (network-enabled sandbox) |
| `git_tag` | per-call | required | Create an annotated or lightweight git tag |
| `github_actions_trigger` | per-call | — | Trigger a workflow_dispatch run for a GitHub Actions workflow |
| `github_pr_comment` | per-call | — | Post an issue-style comment on a pull request thread |
| `github_pr_create` | per-call | — | Open a new pull request on a remote GitHub repository |
| `github_release_create` | per-call | — | Create a GitHub Release pointing at a tag with optional release notes |
| `grafana_alert_apply` | per-call | — | Create or update a Grafana unified-alerting rule via the provisioning API |
| `grafana_dashboard_apply` | per-call | — | Create or update a Grafana dashboard via /api/dashboards/db |
| `http_request` | per-call | — | Make an HTTP request to a URL (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS) |
| `parallel_delegate` | — | — | Run multiple independent sub-agent tasks in parallel |
| `pdf_fill` | per-call | — | Fill AcroForm fields in an existing PDF file and save the result to the workspace |
| `run_script` | per-call | required | Run script file in Docker sandbox |
| `run_task_graph` | — | — | Execute a dependency-aware swarm task graph with parallel ready nodes and fallback delegation |
| `run_test_suite` | per-call | required | Run a named test suite inside a Docker sandbox and return the output |
| `run_workflow` | — | — | Execute a reusable scene or job inline inside a temporary workflow session |
| `shell_exec` | per-call | required | Execute shell command in Docker sandbox |
| `site_fill_credentials` | per-call | — | Securely fill browser login form fields with stored credentials (password never visible to LLM) |
| `sql_query` | per-call | — | Run a parameterised SQL query against a PostgreSQL or MySQL/MariaDB database |
| `swarm_define_agent` | per-call | — | Durably author a new sub-agent shard and apply it live (validated, approval-gated) |
| `swarm_delegate` | — | — | Delegate a task without naming an agent — the swarm routing system picks the best specialist |
| `swarm_save_job` | per-call | — | Durably author a new job/workflow shard and apply it live (validated, approval-gated) |
| `swarm_save_scene` | per-call | — | Durably author a new scene shard and apply it live (validated, approval-gated) |
| `tool_dev_start` | per-call | required | Start a tool development session in the Docker sandbox |
| `tool_dev_test` | — | required | Run tests against tool code in the Docker sandbox |
| `verify_app` | — | — | Verify a serve_app app boots and serves (server-side HTTP/content check + container error logs) |
| `vscode_command` | per-call | — | Execute an arbitrary VS Code command (escape hatch) |
| `vscode_run_terminal_command` | per-call | — | Run a command in VS Code integrated terminal |

## Tier 3 — privileged

Privileged operations; admin approval plus audit entry.

| Tool | Approval | Sandbox | Description |
| --- | --- | --- | --- |
| `ansible_playbook` | per-call | — | Run an Ansible playbook for infrastructure automation |
| `ansible_task` | per-call | — | Run a single Ansible ad-hoc task against a remote inventory |
| `cron_create` | per-call | — | Create scheduled cron task |
| `cron_remove` | per-call | — | Stop and remove a cron job |
| `git_clone` | per-call | required | Clone a remote repository (HTTPS only, network access required) |
| `gobuster_scan` | per-call | — | Gobuster directory/DNS/vhost brute-force — requires authorized pentest scope |
| `helm_rollback` | per-call | — | Roll back a Helm release to a previous revision |
| `helm_upgrade` | per-call | — | Upgrade (or install with install=true) a Helm release against an external cluster |
| `hydra_attack` | per-call | — | Hydra credential brute-force against an authorized service endpoint |
| `kubectl_apply` | per-call | — | Apply a Kubernetes manifest (create or update) against an external cluster |
| `kubectl_delete` | per-call | — | Delete a Kubernetes resource by name or label selector |
| `kubectl_rollout_restart` | per-call | — | Trigger a rolling restart of a Deployment, StatefulSet, or DaemonSet |
| `kubectl_scale` | per-call | — | Scale a workload to a specific replica count |
| `mail_send_draft` | per-call | — | Send a prepared mail draft through the configured mail account |
| `metasploit_exec` | per-call | — | Metasploit Framework module/exploit execution — requires authorized pentest scope |
| `nikto_scan` | per-call | — | Nikto web server vulnerability scan — requires authorized pentest scope |
| `nmap_scan` | per-call | — | Nmap port/service/OS scan — requires authorized pentest scope configured in the Kali service |
| `pentest_exec` | per-call | — | Generic Kali Linux tool execution in the isolated pentest container — requires authorized pentest scope |
| `pentest_set_scope` | per-call | — | Configure the authorized target scope for the current pentest engagement — requires per-call user approval |
| `proxmox_vm` | per-call | — | Manage Proxmox virtual machines through the Proxmox VE API |
| `schedule_remove` | per-call | — | Remove a persistent scheduled task |
| `schedule_task` | per-call | — | Schedule a recurring task that runs as a real autonomous turn (standing agent) |
| `send_discord` | per-call | — | Send a message to a Discord channel |
| `send_email` | per-call | — | Send an email via configured SMTP |
| `send_slack` | per-call | — | Send a message to a Slack channel or DM |
| `send_telegram` | per-call | — | Send Telegram message |
| `serve_app` | per-call | — | Launch/stop a live web app as a dedicated container exposed via the gateway proxy |
| `service_check` | per-call | — | Check remote infrastructure readiness over HTTP, TCP, SSH, or DNS from the host |
| `sqlmap_scan` | per-call | — | SQLMap SQL injection test — requires authorized pentest scope |
| `ssh_download` | per-call | — | Download files or directories from a remote system into the workspace over SCP |
| `ssh_exec` | per-call | — | Execute commands on a remote system over SSH |
| `ssh_upload` | per-call | — | Upload workspace files or directories to a remote system over SCP |
| `terraform_exec` | per-call | — | Run Terraform for infrastructure provisioning and stateful changes |
| `tool_dev_submit` | — | — | Submit a tested tool for human approval and deployment |
| `vm_manage` | per-call | — | Manage virtual machines through configured infrastructure backends |

## Tier 4 — blocked

Never executable under any circumstances; cannot be enabled by config.

| Tool | Approval | Sandbox | Description |
| --- | --- | --- | --- |
| `docker_socket` | — | — | BLOCKED: Docker socket access |
| `gateway_reconfigure` | — | — | BLOCKED: Runtime gateway reconfiguration |
| `host_shell` | — | — | BLOCKED: Direct host shell access |
| `skills_install_remote` | — | — | BLOCKED: Install skills from external registry |
