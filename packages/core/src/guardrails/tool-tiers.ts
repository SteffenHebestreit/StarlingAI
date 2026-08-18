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

export interface ToolTierDef {
  tier: ToolTier;
  description: string;
  requiresPerCallApproval: boolean;
  requiresSandbox: boolean;
}

// Central registry of all tool names → tier definition
// This map is the single source of truth — if a tool is not listed, it defaults to FOUR_BLOCKED
const TOOL_TIER_MAP: Readonly<Record<string, ToolTierDef>> = Object.freeze({
  // ─── Tier 0: Read-only ───────────────────────────────────────────────────
  agent_catalog: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Flat directory of all specialist sub-agents and their capabilities (answers 'what agents exist')",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  list_agents: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List available specialized sub-agents and their descriptions",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  search_agents: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Semantic capability search over specialized sub-agents; falls back to guarded routing heuristics when embeddings are unavailable",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  search_tools: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Semantic search over registered tools — returns relevant tool names and descriptions for a task",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  load_tool: {
    // Tier 0: loading only re-offers a tool the turn's tool mode already permits.
    // The loaded tool is still gated by its OWN tier when it is actually called.
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Pull an available-but-not-offered tool into the current turn (lean tool catalog)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  list_federation_peers: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List configured federation peer instances and their advertised agent + tool surface",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  federated_workspace_search: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Broadcast workspace_search across federated peer instances and merge ranked results",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  search_workflows: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Search reusable scenes and jobs in the workflow catalog",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  get_swarm_state: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Read the current turn-local swarm task state and progress",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  get_swarm_budget: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Aggregate token, tool-call, and wall-clock spending across swarm tasks; flags budget breaches",
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
  fetch_image: {
    tier: ToolTier.ONE_WRITE,
    description: "Download + verify a real image from a URL/page and save it into the workspace",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  extract_file_content: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Convert a workspace file into Markdown using the configured file-conversion service",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  list_pdf_form_fields: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Inspect AcroForm fields in an existing PDF file",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  spreadsheet_read: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Read a workspace spreadsheet (XLSX, XLS, ODS, CSV) and return sheets as JSON row arrays",
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
  research_notes_read: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Read accumulated research scratchpad notes for the current session",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  research_notes_summary: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Summarize research scratchpad notes by topic and importance",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  graph_query: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Run read-only Cypher queries against the MemGraph knowledge graph",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  graph_find_paths: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Find shortest relationship paths between graph entities",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  metric_query: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Run read-only SQL queries against QuestDB time-series data",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  metric_list_tables: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List available QuestDB time-series tables",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  memory_search: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Search RAG memory store",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  search_skills: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Search the Skill Library for reusable procedures learned from past work",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  recall_context: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Pull a compact planning-context pack (user model, working facts, memory, sessions, skills) for a task",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  list_skills: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List Skill Library entries with status and reliability stats",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  search_sessions: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Full-text search over past conversations with optional LLM summarization",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  assistant_personality_view: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Read the persistent main-assistant personality profile",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  user_model_view: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Read the agent's evolving model of the current user",
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

  // ─── Tier 0: Inline computation utilities ───────────────────────────────
  datetime_arithmetic: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Date/time arithmetic — add or subtract durations, compute differences, format/parse without delegating",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  json_query: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Extract values from a JSON document via a dot/bracket path expression (jq-lite — no piping or transforms)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  regex_test: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Test a regex against sample text and return matches with capture groups",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  url_inspect: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "HEAD-probe a URL — returns status code, final URL after redirects, content-type, content-length, server header (no body fetched)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  text_diff: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Line-by-line unified diff between two text strings (no git required) — useful for comparing snippets, draft revisions, or expected vs actual",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  hash_compute: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Compute md5/sha1/sha256/sha512 hash of a UTF-8 string — useful for content fingerprints, dedup checks, integrity comparisons",
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
  swarm_validate: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Validate self-authored scenes, jobs, and agent definitions (read-only, no apply)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  // Durable swarm self-authoring (P2): write a validated agent/scene/job shard + apply it live.
  // Config-zone mutations that re-wire the swarm → approval-gated; no sandbox (must reach workspace).
  swarm_define_agent: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Durably author a new sub-agent shard and apply it live (validated, approval-gated)",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  swarm_save_scene: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Durably author a new scene shard and apply it live (validated, approval-gated)",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  swarm_save_job: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Durably author a new job/workflow shard and apply it live (validated, approval-gated)",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },

  // ─── Tier 0: Real-time data feeds (free public APIs) ────────────────────
  get_weather: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Fetch current weather and short-term forecast for a lat/lon (Open-Meteo by default)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  get_news_headlines: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Fetch recent news headlines from a free public source (Hacker News, Reddit, RSS)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  read_rss_feed: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Read latest items from a public RSS or Atom feed URL (SSRF-guarded)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  get_fx_rate: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Convert fiat currencies using free ECB reference rates (Frankfurter)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  get_crypto_price: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Fetch real-time crypto-asset prices in any quote currency (CoinGecko)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  wikipedia_lookup: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Look up a Wikipedia article summary by title or free-text term",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  list_data_feeds: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List all registered data-feed providers and whether they are enabled",
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
  memory_export: {
    tier: ToolTier.ONE_WRITE,
    description: "Mirror durable memory into an Obsidian-style Markdown vault for review",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  memory_import: {
    tier: ToolTier.ONE_WRITE,
    description: "Re-ingest edited memory-vault notes back into the durable store",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  record_skill: {
    tier: ToolTier.ONE_WRITE,
    description: "Author a reusable procedure (skill) in the Skill Library from experience",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  record_plan: {
    tier: ToolTier.ONE_WRITE,
    description: "Record the orchestrator's structured plan for a complex turn",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  skill_manage: {
    tier: ToolTier.ONE_WRITE,
    description: "Create, patch, pin, archive, and maintain Skill Library procedures and support files",
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
  curate_memory: {
    tier: ToolTier.ONE_WRITE,
    description: "Review durable memory health and optionally consolidate duplicates",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  run_tool_pipeline: {
    tier: ToolTier.ONE_WRITE,
    description: "Batch several tool calls in one step; each sub-call keeps its own tier and approval gate",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  assistant_personality_update: {
    tier: ToolTier.ONE_WRITE,
    description: "Update the persistent main-assistant personality profile",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  user_model_update: {
    tier: ToolTier.ONE_WRITE,
    description: "Revise the agent's evolving model of the current user",
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
  generate_mermaid_diagram: {
    tier: ToolTier.ONE_WRITE,
    description: "Generate a Mermaid diagram source artifact and save it inside the workspace",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  research_note: {
    tier: ToolTier.ONE_WRITE,
    description: "Write a research finding into the durable scratchpad for the current session",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  research_notes_clear: {
    tier: ToolTier.ONE_WRITE,
    description: "Clear research scratchpad notes for the current session",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  rag_ingest: {
    tier: ToolTier.ONE_WRITE,
    description: "Chunk + embed large text/attachments into the pgvector RAG store for later retrieval",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  rag_search: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Semantic search over previously ingested RAG documents (pgvector)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  rag_forget: {
    tier: ToolTier.ONE_WRITE,
    description: "Delete this session's ingested RAG documents from the pgvector store",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  search_documents: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Graph-RAG search over attached/uploaded documents (engram), scoped to the conversation/user/workspace",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  list_documents: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List documents available to this conversation's RAG library (engram)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  ingest_document: {
    tier: ToolTier.ONE_WRITE,
    description: "Extract a workspace file and index it into the engram document library at a chosen scope",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  forget_document: {
    tier: ToolTier.ONE_WRITE,
    description: "Remove a document from the engram library (scope reference or hard delete)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  list_knowledge_bases: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List crawled knowledge bases with status/size, or one KB's crawl progress detail",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  search_knowledge_base: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Scoped graph-RAG search over one crawled knowledge base, excerpts cite source page URLs",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  create_knowledge_base: {
    tier: ToolTier.ONE_WRITE,
    description: "Create a knowledge base and recursively crawl a documentation site into engram (background, bounded, SSRF-guarded)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  manage_knowledge_base: {
    tier: ToolTier.ONE_WRITE,
    description: "Re-crawl, cancel a crawl, or delete a knowledge base and its indexed pages",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  use_knowledge_base: {
    tier: ToolTier.ONE_WRITE,
    description: "Run a knowledge base's single-use worker agent on a task, grounded in that KB (may inspect live targets and write outputs)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  graph_upsert_entity: {
    tier: ToolTier.ONE_WRITE,
    description: "Create or update a node in the MemGraph knowledge graph",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  graph_relate: {
    tier: ToolTier.ONE_WRITE,
    description: "Create or update a relationship between graph entities",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  graph_delete_node: {
    tier: ToolTier.ONE_WRITE,
    description: "Delete a node and its relationships from the MemGraph knowledge graph",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  metric_write: {
    tier: ToolTier.ONE_WRITE,
    description: "Write a measurement into QuestDB time-series storage",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  share_finding: {
    tier: ToolTier.ONE_WRITE,
    description: "Publish a finding into shared swarm memory for sibling agents",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  share_evidence: {
    tier: ToolTier.ONE_WRITE,
    description: "Publish a source-backed evidence record into shared swarm memory for sibling agents",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  export_evidence_ledger: {
    tier: ToolTier.ONE_WRITE,
    description: "Write a validated evidence ledger artifact into the workspace and share its path",
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
  delegate_to_remote_agent: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Federated delegation — ship a task to a sub-agent running on a peer StarlingAI instance",
    requiresPerCallApproval: false,  // peer enforces its own per-tool tier checks
    requiresSandbox: false,
  },
  swarm_delegate: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Delegate a task without naming an agent — the swarm routing system picks the best specialist",
    requiresPerCallApproval: false,
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
  run_workflow: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Execute a reusable scene or job inline inside a temporary workflow session",
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
  sql_query: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Run a parameterised SQL query against a PostgreSQL or MySQL/MariaDB database",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  pdf_fill: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Fill AcroForm fields in an existing PDF file and save the result to the workspace",
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
  git_tag: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Create an annotated or lightweight git tag",
    requiresPerCallApproval: true,
    requiresSandbox: true,
  },
  git_push: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Push commits or tags to a remote git repository (network-enabled sandbox)",
    requiresPerCallApproval: true,
    requiresSandbox: true,
  },
  run_test_suite: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Run a named test suite inside a Docker sandbox and return the output",
    requiresPerCallApproval: true,
    requiresSandbox: true,
  },
  log_stream: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Tail and filter container logs or workspace log files (read-only)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  ask_user: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Pause execution and ask the human user a question with optional choices",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  request_human_assist: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Pause and ask a human to take over the live browser to clear a CAPTCHA/verification, then resume",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  // Browser interactive tools no longer require approval on EVERY call — the
  // gating per-click made browser_agent runs unusable (every navigation step
  // waited on a human). Safety still comes from: (a) the live browser preview
  // (operator can watch + emergency-stop), (b) request_human_assist for the
  // CAPTCHA / verification handoff, and (c) per-scene humanInLoopSteps for the
  // few clicks/typings a scene wants gated (e.g. the final application submit).
  // Scenes opt IN to approval per tool via humanInLoopSteps; the tier no longer
  // forces it OR-style.
  browser_click: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Click an element in the shared browser session",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  browser_type: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Type text into a form element in the shared browser session",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  browser_select_option: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Select an option in the shared browser session",
    requiresPerCallApproval: false,
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
  glob_files: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Find workspace files by path pattern (glob)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  grep_files: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Search file contents by regular expression with surrounding context",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  generate_document: {
    tier: ToolTier.ONE_WRITE,
    description: "Generate and save a workspace document as Markdown, text, HTML, or JSON",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  spreadsheet_write: {
    tier: ToolTier.ONE_WRITE,
    description: "Write JSON row data to an XLSX file in the workspace",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  generate_pdf: {
    tier: ToolTier.ONE_WRITE,
    description: "Generate and save a simple PDF document in the workspace",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  render_pdf: {
    tier: ToolTier.ONE_WRITE,
    description: "Render Markdown or HTML into a typeset, send-ready PDF via a browser engine",
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
  schedule_task: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Schedule a recurring task that runs as a real autonomous turn (standing agent)",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  schedule_list: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List persistent scheduled tasks",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  schedule_remove: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Remove a persistent scheduled task",
    requiresPerCallApproval: true,
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

  // ─── CalDAV Calendar Tools ───────────────────────────────────────────────
  calendar_list_calendars: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List available CalDAV calendars for a configured account",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  calendar_list_events: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List events in a CalDAV calendar within a date range",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  calendar_create_event: {
    tier: ToolTier.ONE_WRITE,
    description: "Create a new event in a CalDAV calendar",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  calendar_update_event: {
    tier: ToolTier.ONE_WRITE,
    description: "Update an existing event in a CalDAV calendar",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  calendar_delete_event: {
    tier: ToolTier.ONE_WRITE,
    description: "Delete an event from a CalDAV calendar",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },

  // ─── CardDAV Contacts Tools ──────────────────────────────────────────────
  contacts_list_address_books: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List available CardDAV address books for a configured account",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  contacts_search: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Search contacts in a CardDAV address book",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  contacts_create: {
    tier: ToolTier.ONE_WRITE,
    description: "Create a new contact in a CardDAV address book",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  contacts_update: {
    tier: ToolTier.ONE_WRITE,
    description: "Update an existing contact in a CardDAV address book",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  contacts_delete: {
    tier: ToolTier.ONE_WRITE,
    description: "Delete a contact from a CardDAV address book",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },

  ssh_exec: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Execute commands on a remote system over SSH",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  serve_app: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Launch/stop a live web app as a dedicated container exposed via the gateway proxy",
    requiresPerCallApproval: true,
    requiresSandbox: false, // manages docker itself on the host network — cannot run inside a sandbox
  },
  verify_page: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Execute a built page's JavaScript against a minimal DOM and report uncaught errors",
    requiresPerCallApproval: false, // read-only self-check, runs in the builder's fix loop
    requiresSandbox: false, // node:vm with a bare context, no network, no filesystem beyond the read
  },
  verify_app: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Verify a serve_app app boots and serves (server-side HTTP/content check + container error logs)",
    requiresPerCallApproval: false, // read-only verification, runs in the builder's self-correct loop
    requiresSandbox: false, // reaches the app container + reads docker logs on the gateway host network
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
  kubectl_get: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Get Kubernetes resources from an external cluster (read-only)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  kubectl_describe: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Describe a Kubernetes resource in detail (read-only)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  kubectl_logs: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Fetch container logs from a pod in an external Kubernetes cluster (read-only)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  kubectl_top: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Report current CPU and memory usage for pods or nodes (read-only, requires Metrics API)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  helm_list: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List Helm releases in the target Kubernetes cluster (read-only)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  kubectl_apply: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Apply a Kubernetes manifest (create or update) against an external cluster",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  kubectl_delete: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Delete a Kubernetes resource by name or label selector",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  kubectl_rollout_restart: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Trigger a rolling restart of a Deployment, StatefulSet, or DaemonSet",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  kubectl_scale: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Scale a workload to a specific replica count",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  helm_upgrade: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Upgrade (or install with install=true) a Helm release against an external cluster",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  helm_rollback: {
    tier: ToolTier.THREE_PRIVILEGED,
    description: "Roll back a Helm release to a previous revision",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  prometheus_query: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Run a PromQL query against an external Prometheus instance (read-only)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  alertmanager_silences_list: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List active silences on an external Alertmanager instance (read-only)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  alertmanager_silence_create: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Create a silence on an external Alertmanager instance (mutates alert routing)",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  alertmanager_silence_expire: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Expire a silence on an external Alertmanager instance",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  grafana_dashboard_search: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Search Grafana dashboards by query / tag / folder (read-only)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  grafana_alerts_list: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List Grafana unified-alerting rules (read-only)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  grafana_dashboard_apply: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Create or update a Grafana dashboard via /api/dashboards/db",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  grafana_alert_apply: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Create or update a Grafana unified-alerting rule via the provisioning API",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  generate_website: {
    tier: ToolTier.ONE_WRITE,
    description: "Generate a complete multi-page static website in the workspace (HTML + CSS + optional assets)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  generate_presentation: {
    tier: ToolTier.ONE_WRITE,
    description: "Generate a self-contained reveal.js HTML slide deck in the workspace from a structured slide list",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  extract_notebook: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Convert a Jupyter .ipynb notebook into a single Markdown document with code, outputs, and image refs",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  extract_email: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Parse an .eml or single-message .mbox file into headers, body, and attachment list",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  extract_calendar: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Parse an .ics file into a structured event list",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  transcribe_video: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Transcribe the audio track of a workspace video file via the configured STT backend",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  generate_svg: {
    tier: ToolTier.ONE_WRITE,
    description: "Write a raw SVG illustration or data visualization to the workspace",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  generate_qr_code: {
    tier: ToolTier.ONE_WRITE,
    description: "Encode text or URL into a QR code SVG and write it to the workspace",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  generate_ics: {
    tier: ToolTier.ONE_WRITE,
    description: "Emit an iCalendar (.ics) file from a structured event list",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  generate_docx: {
    tier: ToolTier.ONE_WRITE,
    description: "Generate a Microsoft Word .docx in the workspace from Markdown content or structured blocks",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  generate_pptx: {
    tier: ToolTier.ONE_WRITE,
    description: "Generate a PowerPoint .pptx in the workspace from a structured slide list",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  bundle_artifact_zip: {
    tier: ToolTier.ONE_WRITE,
    description: "Bundle workspace files, directories, or inline content into a single .zip in the workspace",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  github_pr_list: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List pull requests on a remote GitHub repository (read-only)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  github_pr_get: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Fetch a single pull request by number from a remote GitHub repository (read-only)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  github_check_runs_list: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List CI check runs for a commit on a remote GitHub repository (read-only)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  github_actions_runs_list: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List GitHub Actions workflow runs (read-only)",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  github_pr_create: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Open a new pull request on a remote GitHub repository",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  github_pr_comment: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Post an issue-style comment on a pull request thread",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  github_actions_trigger: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Trigger a workflow_dispatch run for a GitHub Actions workflow",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  github_release_create: {
    tier: ToolTier.TWO_EXECUTE,
    description: "Create a GitHub Release pointing at a tag with optional release notes",
    requiresPerCallApproval: true,
    requiresSandbox: false,
  },
  browser_axe_audit: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Run an axe-core WCAG accessibility audit against the current Playwright browser page",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  lighthouse_audit: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "Run a Google PageSpeed Insights (Lighthouse) audit against a public URL",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },

  // ─── Computer Use: Session Management (Stage 9) ─────────────────────────
  computer_list_nodes: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List configured computer nodes available for connection",
    requiresPerCallApproval: false,
    requiresSandbox: false,
  },
  computer_list_sessions: {
    tier: ToolTier.ZERO_READ_ONLY,
    description: "List currently open computer sessions for reuse or attach",
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

/**
 * Tiers declared by first-party core extensions (extension/loader.ts).
 * Extensions are repo-compiled code, so this is still "enforced in code", not
 * runtime config: nothing reachable from config files can write here, and
 * built-in names cannot be shadowed.
 */
const EXTENSION_TIER_MAP = new Map<string, ToolTierDef>();

/** @internal extension-loader-only. Throws on built-in shadowing or blocked tiers. */
export function registerExtensionToolTier(toolName: string, def: ToolTierDef, source: string): void {
  if (Object.prototype.hasOwnProperty.call(TOOL_TIER_MAP, toolName)) {
    throw new Error(`extension "${source}" must not shadow built-in tool "${toolName}"`);
  }
  if (def.tier >= ToolTier.FOUR_BLOCKED) {
    throw new Error(`extension "${source}" tool "${toolName}": registering at FOUR_BLOCKED is not allowed`);
  }
  EXTENSION_TIER_MAP.set(toolName, Object.freeze({ ...def, description: `[ext:${source}] ${def.description}` }));
}

/** Test hook: clear extension-declared tiers. */
export function _resetExtensionToolTiersForTests(): void {
  EXTENSION_TIER_MAP.clear();
}

export function getToolTier(toolName: string): ToolTierDef {
  const def = TOOL_TIER_MAP[toolName] ?? EXTENSION_TIER_MAP.get(toolName);
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

  // Federated A2A tools: a2a__<peer>__<tool> → Tier 3, per-call approval.
  // Same treatment as the MCP bridge above, and for the same reason: it is a remote
  // capability we do not control. Without this the prefix fell through to the
  // fail-closed default and every federated tool was BLOCKED, with a warning that
  // blamed a missing tier entry rather than the missing fallback — so A2A could not
  // work at all, no matter how it was configured.
  if (/^a2a__[a-z0-9_-]+__[a-z0-9_]+$/i.test(toolName)) {
    return {
      tier: ToolTier.THREE_PRIVILEGED,
      description: `A2A federation: ${toolName}`,
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

  // Plugin SDK tools: plugin__<plugin-name>__<tool-name>  → Tier 2, per-call
  // approval. Plugins are third-party JS loaded from the plugins directory and
  // execute IN-PROCESS (plugin/loader.ts wires their execute directly), so they
  // do NOT get sandbox isolation — requiresSandbox is false so the tier reflects
  // reality (executeTool fail-closes any in-process tool that falsely claims a
  // sandbox). Per-call approval is the real containment: the operator authorizes
  // every plugin invocation, and the plugin runs with no more authority than any
  // other in-process tool. (Genuine sandboxing of plugin code would require
  // running it in an isolated worker/container — tracked separately.)
  if (/^plugin__[a-z][a-z0-9_-]{0,32}__[a-z][a-z0-9_]{0,48}$/i.test(toolName)) {
    return {
      tier: ToolTier.TWO_EXECUTE,
      description: `Plugin tool: ${toolName}`,
      requiresPerCallApproval: true,
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

/**
 * DOC-504: read-only dump of every compile-time tier assignment (including
 * blocked tier-4 entries) for the generated policy reference. The map itself
 * stays private — this is metadata export, not an override surface.
 */
export function listToolTierDefs(): Array<{ name: string } & ToolTierDef> {
  return Object.entries(TOOL_TIER_MAP)
    .map(([name, def]) => ({ name, ...def }))
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
}

/**
 * Returns true when `toolName` is mapped at compile time — i.e. it is a
 * built-in tool with an explicit tier assignment in TOOL_TIER_MAP.  Used by
 * the dynamic-tool validator to reject self-developed tools whose bare names
 * would shadow a privileged built-in (closes a GAP-4 vector where a promoted
 * dynamic tool could override e.g. `read_file` and inherit its Tier-0 callsite
 * permissions).  Pattern-matched namespaces (`mcp__*`, `a2a__*`, `selfdev__*`,
 * `webhook__*`) are NOT considered compile-time mapped.
 */
export function isCompileTimeMappedTool(toolName: string): boolean {
  // Extension tiers count as compile-time mappings: they ship in the repo and
  // must be just as un-shadowable by runtime plugins as built-ins are.
  return Object.prototype.hasOwnProperty.call(TOOL_TIER_MAP, toolName) || EXTENSION_TIER_MAP.has(toolName);
}
