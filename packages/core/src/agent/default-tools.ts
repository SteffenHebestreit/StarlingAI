import { getAllTools } from "../tools/registry.js";
import { getConfig } from "../config/loader.js";

export type MainAssistantToolMode = "hybrid" | "orchestration_only" | "delegate_only";

export const ALWAYS_AVAILABLE_MAIN_TOOL_NAMES = [
  "assistant_personality_view",
  "assistant_personality_update",
] as const;

export const DIRECT_MAIN_TOOL_NAMES = [
  "read_file",
  "list_files",
  "export_workspace_artifact",
  "workspace_search",
  "memory_search",
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
  // Navigation tools — available directly for quick geocoding/routing queries in hybrid mode
  "geocode_location",
  "route_distance_time",
  // Git read-only tools — available directly for quick repo insight
  "git_status",
  "git_log",
  "git_diff",
  // HTTP request — available directly for API interaction
  "http_request",
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
  "list_agents",
  "search_agents",
  "parallel_delegate",
  "create_ephemeral_agent",
  "get_swarm_state",
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