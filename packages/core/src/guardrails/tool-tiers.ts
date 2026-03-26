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
  memory_search: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Search RAG memory store",
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
  share_finding: {
    tier: ToolTier.ONE_WRITE,
    description: "Publish a finding into shared swarm memory for sibling agents",
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
    tier: ToolTier.TWO_EXECUTE,
    description: "Retrieve stored username + password for a website (for browser login automation)",
    requiresPerCallApproval: true,   // always ask before exposing a password to the LLM
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
