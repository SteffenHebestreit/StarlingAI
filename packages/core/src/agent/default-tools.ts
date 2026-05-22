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
  "transcribe_audio",
  "synthesize_speech",
  "list_tts_voices",
  "analyze_image",
  "generate_image",
  "generate_document",
  "generate_mermaid_diagram",
  "generate_chart_html",
  "generate_pdf",
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
  return [...alwaysAvailable, ...DIRECT_MAIN_TOOL_NAMES.filter(name => available.has(name))];
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