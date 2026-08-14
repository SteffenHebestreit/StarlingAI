import { getAllTools } from "../tools/registry.js";
import { getConfig } from "../config/loader.js";

export type MainAssistantToolMode = "hybrid" | "orchestration_only" | "delegate_only";

export const ALWAYS_AVAILABLE_MAIN_TOOL_NAMES = [
  "memory_store",
  "memory_search",
  "assistant_personality_view",
  "assistant_personality_update",
  "user_model_update",
  // Durable self-improvement: the main assistant can author its own reusable
  // skills (same Tier 1, no-approval profile as memory_store). No-ops gracefully
  // when skillLibrary.enabled is false.
  "record_skill",
  "skill_manage",
  // Self-report a capability gap ("no tool/agent can do X") and read the gap
  // ledger. Tier 0/1, no-approval; no-ops gracefully when selfImprovement is
  // disabled. Without this grant the gap-detection path was unreachable from the
  // orchestrator — only an autonomous routing-failure could ever record a gap.
  "request_new_capability",
  "list_capability_gaps",
  // Mid-turn clarify: pause and ask the human a blocking question (with optional
  // clickable choices) when genuine ambiguity would otherwise force a guess. The
  // tool no-ops when no input channel is present, so it is safe to always offer.
  "ask_user",
  // First-class plan checkpoint: on a complex turn the orchestrator records a
  // short structured plan (objective, reuse-or-delegate steps, acceptance
  // criteria) that QA checks against and the operator dock can surface/approve.
  "record_plan",
  // Just-in-time planning context: one read-only call that aggregates the user
  // model, working-memory facts, long-term memory, recent sessions, and skills —
  // so the planner can hydrate context before delegating instead of the prompt
  // always carrying it.
  "recall_context",
  // Retrieval-augmented prompting for large inputs: offload a long message,
  // pasted document, or attachment into the pgvector RAG store (rag_ingest) and
  // pull back only the relevant chunks on demand (rag_search) instead of
  // carrying the whole thing in context. No-op without pgvector.
  "rag_ingest",
  "rag_search",
  // Document RAG over attached/uploaded files (engram graph-RAG). Retrieval +
  // listing are always available; the runtime also auto-injects relevant
  // excerpts and auto-ingests session attachments. No-op when documentRag is
  // disabled or engram is unreachable.
  "search_documents",
  "list_documents",
  // Knowledge bases (crawled documentation corpora): discovery + scoped
  // retrieval are always offered, mirroring the documents pair above. No-op
  // when documentRag/knowledgeBases is disabled.
  "list_knowledge_bases",
  "search_knowledge_base",
  // Build / maintain / apply knowledge bases. All always-available (not DIRECT):
  // the default toolMode is "orchestration_only", where DIRECT tools are withheld
  // — so "crawl site X into a KB" / "use KB X to do Y" would otherwise be
  // unreachable and the orchestrator would delegate to a mismatched specialist
  // instead. These are direct platform actions, not delegate-to-specialist work.
  // No-op gracefully when documentRag/knowledgeBases is disabled.
  "create_knowledge_base",
  "manage_knowledge_base",
  "use_knowledge_base",
  // Flat agent capability directory so the assistant can answer "what agents do
  // you have / what can they do" without a semantic query (search_agents and
  // list_agents both require one and never dump the catalog).
  "agent_catalog",
] as const;

export const DIRECT_MAIN_TOOL_NAMES = [
  "read_file",
  "list_files",
  "export_workspace_artifact",
  "workspace_search",
  "search_sessions",
  "read_shared_facts",
  "session_status",
  "send_agent_message",
  "web_search",
  "web_fetch",
  "extract_file_content",
  // Ingest a workspace file into / remove a document from the engram library.
  "ingest_document",
  "forget_document",
  "transcribe_audio",
  "synthesize_speech",
  "list_tts_voices",
  "analyze_image",
  "generate_image",
  "generate_document",
  "generate_mermaid_diagram",
  "generate_chart_html",
  "generate_pdf",
  "render_pdf",
  "get_site_credentials",
  "site_fill_credentials",
  "browser_navigate",
  "browser_snapshot",
  "browser_wait_for",
  "browser_click",
  "browser_type",
  "browser_select_option",
  "browser_screenshot",
  // Git read-only tools — available directly for quick repo insight
  "git_status",
  "git_log",
  "git_diff",
  // HTTP request — available directly for API interaction
  "http_request",
  // Real-time data feeds (free public APIs)
  "get_weather",
  "get_news_headlines",
  "read_rss_feed",
  "get_fx_rate",
  "get_crypto_price",
  "wikipedia_lookup",
  "list_data_feeds",
  // computer_* and vscode_* tools are delegated to the computer_use_agent
  // sub-agent to prevent hallucinated tool-call patterns in the orchestrator.
  // Pentest tools — available to main assistant; active tools require PENTEST_SCOPE
  "searchsploit_query",
  "pentest_report",
  "nmap_scan",
  "nikto_scan",
  "gobuster_scan",
  "sqlmap_scan",
  "hydra_attack",
  "metasploit_exec",
  "pentest_exec",
  "pentest_set_scope",
] as const;

export const ORCHESTRATION_TOOL_NAMES = [
  "delegate_to_agent",
  "swarm_delegate",
  "list_agents",
  "search_agents",
  "search_tools",
  "search_workflows",
  "run_workflow",
  "search_skills",
  "parallel_delegate",
  "create_ephemeral_agent",
  "get_swarm_state",
  "get_swarm_budget",
  "run_task_graph",
] as const;

function getAvailableToolNames(): Set<string> {
  return new Set(getAllTools().map(tool => tool.name));
}

function resolveToolMode(mode?: MainAssistantToolMode): MainAssistantToolMode {
  return mode ?? getConfig().agents.mainAssistant.toolMode;
}

export function getAvailableDirectMainToolNames(mode?: MainAssistantToolMode): string[] {
  const available = getAvailableToolNames();
  const alwaysAvailable = ALWAYS_AVAILABLE_MAIN_TOOL_NAMES.filter(name => available.has(name));
  if (resolveToolMode(mode) !== "hybrid") return alwaysAvailable;
  // Lean catalog (B37): withhold the direct capability tools from iteration 0 and
  // let the model pull the one it needs with load_tool. Orchestration tools are
  // untouched, so delegation/routing behaviour is identical either way.
  if (getConfig().agents.performance.leanToolCatalog) {
    // load_tool is only offered when something was actually withheld — otherwise
    // it would cost every deployment a tool schema for a no-op.
    return available.has("load_tool") ? [...alwaysAvailable, "load_tool"] : alwaysAvailable;
  }
  return [...alwaysAvailable, ...DIRECT_MAIN_TOOL_NAMES.filter(name => available.has(name))];
}

/**
 * Tool names the orchestrator may pull in mid-turn with `load_tool` — exactly the
 * direct capability tools the lean catalog withheld. Anything already offered, or
 * never offered in this mode, is not loadable: load_tool widens the live turn to
 * what the mode ALREADY permits, it never escalates past the tool-mode boundary.
 */
export function getLoadableDirectMainToolNames(mode?: MainAssistantToolMode): string[] {
  if (resolveToolMode(mode) !== "hybrid") return [];
  const available = getAvailableToolNames();
  return DIRECT_MAIN_TOOL_NAMES.filter(name => available.has(name));
}

export function getAvailableOrchestrationToolNames(mode?: MainAssistantToolMode): string[] {
  const available = getAvailableToolNames();
  if (resolveToolMode(mode) === "delegate_only") {
    return ORCHESTRATION_TOOL_NAMES.filter(name => name === "delegate_to_agent" && available.has(name));
  }
  return ORCHESTRATION_TOOL_NAMES.filter(name => available.has(name));
}

export function getMainAssistantToolNames(mode?: MainAssistantToolMode): string[] {
  return [...getAvailableDirectMainToolNames(mode), ...getAvailableOrchestrationToolNames(mode)];
}