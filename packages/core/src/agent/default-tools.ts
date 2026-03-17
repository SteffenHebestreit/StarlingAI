import { getAllTools } from "../tools/registry.js";

export const DIRECT_MAIN_TOOL_NAMES = [
  "read_file",
  "list_files",
  "workspace_search",
  "memory_search",
  "read_shared_facts",
  "web_search",
  "web_fetch",
  "extract_file_content",
  "transcribe_audio",
  "synthesize_speech",
  "list_tts_voices",
  "analyze_image",
  "get_site_credentials",
  "browser_navigate",
  "browser_snapshot",
  "browser_wait_for",
  "browser_click",
  "browser_type",
  "browser_select_option",
  "browser_screenshot",
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

export function getAvailableDirectMainToolNames(): string[] {
  const available = getAvailableToolNames();
  return DIRECT_MAIN_TOOL_NAMES.filter(name => available.has(name));
}

export function getAvailableOrchestrationToolNames(): string[] {
  const available = getAvailableToolNames();
  return ORCHESTRATION_TOOL_NAMES.filter(name => available.has(name));
}

export function getMainAssistantToolNames(): string[] {
  return [...getAvailableDirectMainToolNames(), ...getAvailableOrchestrationToolNames()];
}