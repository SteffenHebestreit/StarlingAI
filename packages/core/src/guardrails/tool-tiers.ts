/**
 * HARD-CODED tool permission tiers.
 * These are NOT configurable at runtime — they are enforced in code.
 * Admins cannot override tier 3/4 restrictions via config.
 */

export const enum ToolTier {
  /** Always allowed — read-only, no side effects */
  ZERO_READ_ONLY = 0,
  /** Write ops within workspace — require session-level consent once */
  ONE_WRITE = 1,
  /** Execution — require per-invocation approval, always sandboxed */
  TWO_EXECUTE = 2,
  /** Privileged operations — require admin approval + audit entry */
  THREE_PRIVILEGED = 3,
  /** BLOCKED — never executable under any circumstances */
  FOUR_BLOCKED = 4,
}

interface ToolTierDef {
  tier: ToolTier;
  description: string;
  requiresPerCallApproval: boolean;
  requiresSandbox: boolean;
}

// Central registry of all tool names → tier definition
// This map is the single source of truth — if a tool is not listed, it defaults to FOUR_BLOCKED
const TOOL_TIER_MAP: Readonly<Record<string, ToolTierDef>> = Object.freeze({
  // ─── Tier 0: Read-only ───────────────────────────────────────────────────
  list_agents: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List available specialized sub-agents and their descriptions",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  search_agents: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Keyword search over sub-agent names and descriptions",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  get_swarm_state: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Read the current turn-local swarm task state and progress",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  read_file: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Read file within workspace directory",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  web_search: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Search the public web for documentation, news, and references",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  web_fetch: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Fetch and read content from a public URL",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  geocode_location: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Resolve a place name or address to geographic coordinates via OpenStreetMap",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  route_distance_time: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Calculate route distance and travel time between two coordinates",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  extract_file_content: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Convert a workspace file into Markdown using the configured file-conversion service",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  transcribe_audio: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Transcribe an audio file from the workspace using the configured STT backend",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  list_tts_voices: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List voices from the configured TTS backend",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  analyze_image: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Analyze an image from the workspace with the configured vision-capable LLM",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  browser_navigate: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Navigate the shared browser session to a URL",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  browser_snapshot: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Capture an accessibility snapshot of the current browser page",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  browser_wait_for: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Wait for text to appear or disappear on the current browser page",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  browser_screenshot: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Capture a screenshot of the current browser page",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  list_files: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List files/dirs within workspace",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  export_workspace_artifact: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Expose an existing workspace file or folder as a downloadable chat artifact",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  memory_search: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Search RAG memory store",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  assistant_personality_view: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Read the persistent main-assistant personality profile",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  read_shared_facts: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Read shared swarm facts collected during the current session",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  session_status: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Get current session metadata",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  workspace_search: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Full-text keyword search across workspace text files",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  git_status: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Show working tree status (porcelain v2)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  git_log: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Show commit history with optional path and count filters",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  git_diff: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Show diff of staged, unstaged, or between refs",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },

  // ─── Tier 0/1: Agent data store ─────────────────────────────────────────
  agent_store_read: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Read temporary data from the agent data store",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  agent_store_write: {
    tier: ToolTier.ONE_WRITE,
    description: "Write temporary data to the agent data store (24h TTL)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  agent_store_delete: {
    tier: ToolTier.ONE_WRITE,
    description: "Delete temporary data from the agent data store",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },

  // ─── Tier 0/2/3: Tool development ────────────────────────────────────────
  tool_dev_start: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Start a tool development session in the Docker sandbox",
    requiresPerCallApproval: true,
    requiresSandbox: true,
  },
  tool_dev_test: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Run tests against tool code in the Docker sandbox",
    requiresPerCallApproval: false,
    requiresSandbox: true,
  },
  tool_dev_submit: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Submit a tested tool for human approval and deployment",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },

  // ─── Tier 0/1: Self-improvement ──────────────────────────────────────────
  request_new_capability: {
    tier: ToolTier.ONE_WRITE,
    description: "Request development of a new tool to fill a capability gap",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  list_capability_gaps: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List detected capability gaps and their status",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },

  // ─── Tier 1: Write (workspace-scoped) ───────────────────────────────────
  write_file: {
    tier: ToolTier.ONE_WRITE,
    description: "Write/overwrite file within workspace",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  edit_file: {
    tier: ToolTier.ONE_WRITE,
    description: "Apply patch/edit to file within workspace",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  create_dir: {
    tier: ToolTier.ONE_WRITE,
    description: "Create directory within workspace",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  delete_file: {
    tier: ToolTier.ONE_WRITE,
    description: "Delete file within workspace (with confirmation)",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  memory_store: {
    tier: ToolTier.ONE_WRITE,
    description: "Store entry in RAG memory",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  memory_promote: {
    tier: ToolTier.ONE_WRITE,
    description: "Promote session or agent memory into durable workspace memory",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  memory_compact: {
    tier: ToolTier.ONE_WRITE,
    description: "Compact and deduplicate durable workspace memory",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  assistant_personality_update: {
    tier: ToolTier.ONE_WRITE,
    description: "Update the persistent main-assistant personality profile",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  synthesize_speech: {
    tier: ToolTier.ONE_WRITE,
    description: "Generate speech audio and save it inside the workspace",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  generate_image: {
    tier: ToolTier.ONE_WRITE,
    description: "Generate an image from text and save it inside the workspace",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  generate_chart_html: {
    tier: ToolTier.ONE_WRITE,
    description: "Generate an HTML chart report and save it inside the workspace",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  share_finding: {
    tier: ToolTier.ONE_WRITE,
    description: "Publish a finding into shared swarm memory for sibling agents",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  send_agent_message: {
    tier: ToolTier.ONE_WRITE,
    description: "Queue a direct message for another agent in the current swarm session",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  record_lesson: {
    tier: ToolTier.ONE_WRITE,
    description: "Record a lesson learned from a task execution into the agent outcome log",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },

  // ─── Tier 2: Execute ────────────────────────────────────────────────────
  delegate_to_agent: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Delegate a task to a specialized sub-agent with its own model and tool set",
    requiresPerCallApproval: false,  // sub-agent's own tool calls carry their own approvals
    requiresSandbox: false,
  },
  create_ephemeral_agent: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Spin up a purpose-built single-use agent from an inline spec and run it immediately",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  parallel_delegate: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Run multiple independent sub-agent tasks in parallel",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  run_task_graph: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Execute a dependency-aware swarm task graph with parallel ready nodes and fallback delegation",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  shell_exec: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Execute shell command in Docker sandbox",
    requiresPerCallApproval: true,
    requiresSandbox: true, // HARD — cannot be turned off
  },
  run_script: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Run script file in Docker sandbox",
    requiresPerCallApproval: true,
    requiresSandbox: true,
  },
  http_request: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Make an HTTP request to a URL (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS)",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  git_commit: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Stage files and create a git commit",
    requiresPerCallApproval: true,
    requiresSandbox: true,
  },
  git_checkout: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Switch or create branches, restore files",
    requiresPerCallApproval: true,
    requiresSandbox: true,
  },
  browser_click: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Click an element in the shared browser session",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  browser_type: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Type text into a form element in the shared browser session",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  browser_select_option: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Select an option in the shared browser session",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },

  // ─── Tier 2: Credentials (execute-level — logged, per-call approval) ────
  get_site_credentials: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Check whether stored credentials exist for a website and retrieve non-secret metadata (login URL, selectors)",
    requiresPerCallApproval: false,   // no longer exposes secrets — safe as read-only
    requiresSandbox: false,
  },
  site_fill_credentials: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Securely fill browser login form fields with stored credentials (password never visible to LLM)",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  computer_type_credential: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Type a stored credential (username or password) into the focused field on the remote desktop (value never visible to LLM)",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },

  // ─── Pentest / Security Assessment ──────────────────────────────────────
  // searchsploit is read-only (offline Exploit-DB search, no network to target)
  searchsploit_query: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Search Exploit-DB / SearchSploit for known CVEs and exploit PoCs (offline, no network traffic to target)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  pentest_report: {
    tier: ToolTier.ONE_WRITE,
    description: "Generate a structured pentest report from collected findings and save it to the workspace",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  generate_document: {
    tier: ToolTier.ONE_WRITE,
    description: "Generate and save a workspace document as Markdown, text, HTML, or JSON",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  generate_pdf: {
    tier: ToolTier.ONE_WRITE,
    description: "Generate and save a simple PDF document in the workspace",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  // Active scanning tools — Tier 3, per-call approval, require authorized scope
  nmap_scan: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Nmap port/service/OS scan — requires authorized pentest scope configured in the Kali service",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  nikto_scan: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Nikto web server vulnerability scan — requires authorized pentest scope",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  sqlmap_scan: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "SQLMap SQL injection test — requires authorized pentest scope",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  gobuster_scan: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Gobuster directory/DNS/vhost brute-force — requires authorized pentest scope",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  hydra_attack: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Hydra credential brute-force against an authorized service endpoint",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  metasploit_exec: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Metasploit Framework module/exploit execution — requires authorized pentest scope",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  pentest_exec: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Generic Kali Linux tool execution in the isolated pentest container — requires authorized pentest scope",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  pentest_set_scope: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Configure the authorized target scope for the current pentest engagement — requires per-call user approval",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },

  // ─── Tier 3: Privileged ──────────────────────────────────────────────────
  // Note: MCP tools are bridged as mcp__<server>__<tool> — matched by the
  // pattern in getToolTier() below. There is no generic "mcp_call" tool.
  send_telegram: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Send Telegram message",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  cron_create: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Create scheduled cron task",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  cron_list: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List active cron jobs",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  cron_remove: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Stop and remove a cron job",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  reminder_create: {
    tier: ToolTier.ONE_WRITE,
    description: "Create a one-time in-memory reminder notification",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  reminder_list: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List active reminders for the current session",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  reminder_remove: {
    tier: ToolTier.ONE_WRITE,
    description: "Remove a scheduled reminder",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  timer_start: {
    tier: ToolTier.ONE_WRITE,
    description: "Start a one-time in-memory timer notification",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  timer_list: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List active timers for the current session",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  timer_cancel: {
    tier: ToolTier.ONE_WRITE,
    description: "Cancel an active timer",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  git_clone: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Clone a remote repository (HTTPS only, network access required)",
    requiresPerCallApproval: true,
    requiresSandbox: true,
  },
  send_slack: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Send a message to a Slack channel or DM",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  send_discord: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Send a message to a Discord channel",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  send_email: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Send an email via configured SMTP",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  mail_list_accounts: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List configured mail accounts from the headless mail service",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  mail_list_mailboxes: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List mailboxes for a configured mail account",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  mail_search: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Search messages across one or more configured mail accounts",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  mail_read: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Read a specific mail message by account, mailbox, and UID",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  mail_list_unread: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List unread messages across one or more configured mail accounts",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  mail_get_draft: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Read a prepared mail draft from the headless mail service",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  mail_prepare_draft: {
    tier: ToolTier.ONE_WRITE,
    description: "Create a draft email for a specific configured mail account",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  mail_update_draft: {
    tier: ToolTier.ONE_WRITE,
    description: "Update an existing mail draft",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  mail_categorize: {
    tier: ToolTier.ONE_WRITE,
    description: "Persist local categories and notes for specific mail messages",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  mail_create_mailbox: {
    tier: ToolTier.ONE_WRITE,
    description: "Create a mailbox or folder for a configured mail account",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  mail_delete_mailbox: {
    tier: ToolTier.ONE_WRITE,
    description: "Delete an empty mailbox or folder for a configured mail account",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  mail_move: {
    tier: ToolTier.ONE_WRITE,
    description: "Move one or more mail messages into another mailbox or folder",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  mail_delete: {
    tier: ToolTier.ONE_WRITE,
    description: "Delete or trash one or more mail messages from a configured mail account",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  mail_send_draft: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Send a prepared mail draft through the configured mail account",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  ssh_exec: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Execute commands on a remote system over SSH",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  ssh_upload: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Upload workspace files or directories to a remote system over SCP",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  ssh_download: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Download files or directories from a remote system into the workspace over SCP",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  ansible_playbook: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Run an Ansible playbook for infrastructure automation",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  ansible_task: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Run a single Ansible ad-hoc task against a remote inventory",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  vm_manage: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Manage virtual machines through configured infrastructure backends",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  proxmox_vm: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Manage Proxmox virtual machines through the Proxmox VE API",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  terraform_exec: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Run Terraform for infrastructure provisioning and stateful changes",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  service_check: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Check remote infrastructure readiness over HTTP, TCP, SSH, or DNS from the host",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },

  // ─── Computer Use: Session Management (Stage 9) ─────────────────────────
  computer_list_nodes: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List configured computer nodes available for connection",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  computer_session_start: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Start a new computer session (adapter, config)",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  computer_session_attach: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Attach to an existing computer session",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  computer_session_stop: {
    tier: ToolTier.ONE_WRITE,
    description: "Graceful stop of a computer session",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },

  // ─── Computer Use: Interaction Tools (Stage 9) ──────────────────────────
  computer_snapshot: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Capture screenshot + accessibility tree, analyze via vision model",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  computer_click: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Click at (x, y) on the computer screen",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  computer_type: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Type text on the computer",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  computer_hotkey: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Send a keyboard shortcut (e.g. ctrl+s)",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  computer_scroll: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Scroll at a position on the screen",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  computer_drag: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Drag from one position to another",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  computer_wait_for: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Wait for a visual condition on screen (poll screenshots + vision)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  computer_list_windows: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List open windows with titles, process names, and bounds",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  computer_focus_window: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Focus a window by title pattern",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  computer_capture_region: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Capture a specific screen region and analyze with vision",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  computer_clipboard_read: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Read clipboard contents (potential secret exposure)",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  computer_clipboard_write: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Write to clipboard (potential data injection)",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  computer_upload_file: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Transfer a file to a remote computer session",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  computer_download_file: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Transfer a file from a remote computer session",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },

  // ─── VS Code Tools (Stage 9) ───────────────────────────────────────────
  vscode_open_file: {
    tier: ToolTier.ONE_WRITE,
    description: "Open a file in VS Code editor at optional line/column",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  vscode_run_terminal_command: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Run a command in VS Code integrated terminal",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  vscode_get_diagnostics: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Read VS Code problems panel diagnostics",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  vscode_focus_panel: {
    tier: ToolTier.ONE_WRITE,
    description: "Focus a VS Code panel (terminal, problems, explorer, source-control)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  vscode_search_workspace: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Full workspace text search in VS Code",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  vscode_command: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Execute an arbitrary VS Code command (escape hatch)",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  vscode_get_active_editor: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Return current VS Code file, selection, and cursor position",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  vscode_diff: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Open a diff view for two files in VS Code",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },

  // ─── Tier 4: Blocked — listed for documentation purposes ────────────────
  host_shell: {
    tier: ToolTier.FOUR_BLOCKED,
    description: "BLOCKED: Direct host shell access",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  docker_socket: {
    tier: ToolTier.FOUR_BLOCKED,
    description: "BLOCKED: Docker socket access",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  gateway_reconfigure: {
    tier: ToolTier.FOUR_BLOCKED,
    description: "BLOCKED: Runtime gateway reconfiguration",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  skills_install_remote: {
    tier: ToolTier.FOUR_BLOCKED,
    description: "BLOCKED: Install skills from external registry",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
});

export function getToolTier(toolName: string): ToolTierDef {
  const def = TOOL_TIER_MAP[toolName];
  if (def) return def;

  // Bridged MCP tools not explicitly listed above -> Tier 3, requires per-call approval.
  if (/^mcp__[a-z0-9_]+__[a-z0-9_]+$/i.test(toolName)) {
    return {
      tier: ToolTier.THREE_PRIVILEGED,
      description: `MCP bridge: ${toolName}`,
      requiresPerCallApproval: true,
      requiresSandbox: false,
    };
  }

  // Self-developed dynamic tools: selfdev__<name> → Tier 2, sandboxed, per-call approval
  if (/^selfdev__[a-z0-9_]+$/i.test(toolName)) {
    return {
      tier: ToolTier.TWO_EXECUTE,
      description: `Self-developed tool: ${toolName}`,
      requiresPerCallApproval: true,
      requiresSandbox: true,
    };
  }

  // Config-driven webhook tools: webhook__<name>  → Tier 1, no per-call approval
  if (/^webhook__[a-z0-9_]+$/i.test(toolName)) {
    return {
      tier: ToolTier.ONE_WRITE,
      description: `Webhook tool: ${toolName}`,
      requiresPerCallApproval: false,
      requiresSandbox: false,
    };
  }

  // Unknown tools default to BLOCKED
  return {
    tier: ToolTier.FOUR_BLOCKED,
    description: `BLOCKED: Unknown tool '${toolName}'`,
    requiresPerCallApproval: false,
    requiresSandbox: false,
  };
}

export function isToolAllowed(toolName: string): boolean {
  const def = getToolTier(toolName);
  return def.tier < ToolTier.FOUR_BLOCKED;
}

export function requiresSandbox(toolName: string): boolean {
  return getToolTier(toolName).requiresSandbox;
}

export function requiresApproval(toolName: string): boolean {
  return getToolTier(toolName).requiresPerCallApproval;
}

export function getRegisteredTools(): string[] {
  return Object.entries(TOOL_TIER_MAP)
    .filter(([, def]) => def.tier < ToolTier.FOUR_BLOCKED)
    .map(([name]) => name);
}
