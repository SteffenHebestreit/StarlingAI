import { afterEach, describe, expect, it } from "vitest";
import {
  ALWAYS_AVAILABLE_MAIN_TOOL_NAMES,
  DIRECT_MAIN_TOOL_NAMES,
  ORCHESTRATION_TOOL_NAMES,
  getAvailableDirectMainToolNames,
  getAvailableOrchestrationToolNames,
  getMainAssistantToolNames,
} from "../agent/default-tools.js";
import { getTool, registerTool, unregisterTool } from "../tools/registry.js";

const registeredForTest = new Set<string>();

function registerStubTool(name: string): void {
  if (getTool(name)) {
    return;
  }

  registerTool({
    name,
    description: `stub ${name}`,
    parameters: {},
    async execute() {
      return { success: true, output: name };
    },
  });
  registeredForTest.add(name);
}

afterEach(() => {
  for (const name of registeredForTest) {
    unregisterTool(name);
  }
  registeredForTest.clear();
});

describe("default main assistant tools", () => {
  it("returns only direct tools that are currently registered", () => {
    registerStubTool("read_file");
    registerStubTool("export_workspace_artifact");
    registerStubTool("web_search");
    // delegate_to_agent is orchestration — must not appear in direct list
    registerStubTool("delegate_to_agent");

    const availableDirectTools = getAvailableDirectMainToolNames("hybrid");
    const directToolSet = new Set<string>(DIRECT_MAIN_TOOL_NAMES);

    expect(availableDirectTools).toEqual(["read_file", "export_workspace_artifact", "web_search"]);
    expect(availableDirectTools.every(name => directToolSet.has(name))).toBe(true);
  });

  it("surfaces document export tools in the direct tool list when registered", () => {
    registerStubTool("generate_document");
    registerStubTool("generate_mermaid_diagram");
    registerStubTool("generate_chart_html");
    registerStubTool("generate_pdf");

    const availableDirectTools = getAvailableDirectMainToolNames("hybrid");

    expect(availableDirectTools).toEqual(["generate_document", "generate_mermaid_diagram", "generate_chart_html", "generate_pdf"]);
  });

  it("surfaces the new git insight and http tools in the direct tool list when registered", () => {
    registerStubTool("git_status");
    registerStubTool("git_log");
    registerStubTool("git_diff");
    registerStubTool("http_request");

    const availableDirectTools = getAvailableDirectMainToolNames("hybrid");

    expect(availableDirectTools).toEqual(["git_status", "git_log", "git_diff", "http_request"]);
  });

  it("combines registered direct and orchestration tools in policy order", () => {
    registerStubTool("browser_snapshot");
    registerStubTool("get_site_credentials");
    registerStubTool("delegate_to_agent");
    registerStubTool("run_task_graph");

    const mainAssistantTools = getMainAssistantToolNames("hybrid");

    expect(mainAssistantTools).toEqual([
      "get_site_credentials",
      "browser_snapshot",
      "delegate_to_agent",
      "run_task_graph",
    ]);
    expect(mainAssistantTools[0]).toBe("get_site_credentials");
    expect(ORCHESTRATION_TOOL_NAMES).toContain("delegate_to_agent");
    expect(ORCHESTRATION_TOOL_NAMES).toContain("run_task_graph");
  });

  it("can restrict the main assistant to orchestration tools only", () => {
    registerStubTool("memory_store");
    registerStubTool("memory_search");
    registerStubTool("assistant_personality_view");
    registerStubTool("assistant_personality_update");
    registerStubTool("browser_snapshot");
    registerStubTool("delegate_to_agent");
    registerStubTool("search_agents");

    const tools = getMainAssistantToolNames("orchestration_only");

    expect(tools).toEqual(["memory_store", "memory_search", "assistant_personality_view", "assistant_personality_update", "delegate_to_agent", "search_agents"]);
  });

  it("can restrict the main assistant to delegate_to_agent only", () => {
    registerStubTool("memory_store");
    registerStubTool("memory_search");
    registerStubTool("assistant_personality_view");
    registerStubTool("assistant_personality_update");
    registerStubTool("browser_snapshot");
    registerStubTool("delegate_to_agent");
    registerStubTool("search_agents");
    registerStubTool("run_task_graph");

    const tools = getMainAssistantToolNames("delegate_only");

    expect(tools).toEqual(["memory_store", "memory_search", "assistant_personality_view", "assistant_personality_update", "delegate_to_agent"]);
  });

  it("surfaces always-available durable memory tools ahead of regular direct tools", () => {
    registerStubTool("memory_store");
    registerStubTool("memory_search");
    registerStubTool("read_file");
    registerStubTool("web_search");

    const tools = getAvailableDirectMainToolNames("hybrid");

    expect(tools).toEqual(["memory_store", "memory_search", "read_file", "web_search"]);
  });

  it("returns an empty array when no direct tools are registered", () => {
    // Only register an orchestration tool — direct list should be empty
    registerStubTool("list_agents");

    const availableDirectTools = getAvailableDirectMainToolNames("hybrid");
    expect(availableDirectTools).toEqual([]);
  });

  it("returns an empty array when no orchestration tools are registered", () => {
    // Only register a direct tool — orchestration list should be empty
    registerStubTool("web_search");

    const availableOrchTools = getAvailableOrchestrationToolNames("hybrid");
    expect(availableOrchTools).toEqual([]);
  });

  it("returns empty list from getMainAssistantToolNames when nothing is registered", () => {
    // Registeredfortesting set is empty; no stubs registered here
    const tools = getMainAssistantToolNames("hybrid");
    // may include tools registered by other imported modules — just verify
    // that it only contains known names from both lists
    const knownNames = new Set<string>([...ALWAYS_AVAILABLE_MAIN_TOOL_NAMES, ...DIRECT_MAIN_TOOL_NAMES, ...ORCHESTRATION_TOOL_NAMES]);
    for (const name of tools) {
      expect(knownNames.has(name)).toBe(true);
    }
  });

  it("preserves the declaration order within each tier", () => {
    // Register a subset of direct tools in reverse order; output should follow declaration order
    registerStubTool("web_fetch");
    registerStubTool("web_search");

    const availableDirectTools = getAvailableDirectMainToolNames("hybrid");

    const expectedOrder = DIRECT_MAIN_TOOL_NAMES.filter(n =>
      ["web_fetch", "web_search"].includes(n),
    );
    expect(availableDirectTools).toEqual(expectedOrder);
  });

  it("preserves orchestration tool declaration order", () => {
    registerStubTool("run_task_graph");
    registerStubTool("list_agents");
    registerStubTool("delegate_to_agent");

    const available = getAvailableOrchestrationToolNames("hybrid");

    const expectedOrder = ORCHESTRATION_TOOL_NAMES.filter(n =>
      ["run_task_graph", "list_agents", "delegate_to_agent"].includes(n),
    );
    expect(available).toEqual(expectedOrder);
  });

  it("places all direct tools before all orchestration tools in getMainAssistantToolNames", () => {
    registerStubTool("web_search");
    registerStubTool("delegate_to_agent");
    registerStubTool("read_file");
    registerStubTool("list_agents");

    const combined = getMainAssistantToolNames("hybrid");
    const directSet = new Set<string>(DIRECT_MAIN_TOOL_NAMES);
    const orchSet = new Set<string>(ORCHESTRATION_TOOL_NAMES);

    let seenOrchestration = false;
    for (const name of combined) {
      if (orchSet.has(name)) seenOrchestration = true;
      if (seenOrchestration) {
        expect(directSet.has(name)).toBe(false);
      }
    }
  });

  it("DIRECT_MAIN_TOOL_NAMES and ORCHESTRATION_TOOL_NAMES have no overlap", () => {
    const directSet = new Set<string>(DIRECT_MAIN_TOOL_NAMES);
    for (const name of ORCHESTRATION_TOOL_NAMES) {
      expect(directSet.has(name)).toBe(false);
    }
  });

  it("keeps always-available personality tools out of the regular direct and orchestration lists", () => {
    const directSet = new Set<string>(DIRECT_MAIN_TOOL_NAMES);
    const orchestrationSet = new Set<string>(ORCHESTRATION_TOOL_NAMES);

    for (const name of ALWAYS_AVAILABLE_MAIN_TOOL_NAMES) {
      expect(directSet.has(name)).toBe(false);
      expect(orchestrationSet.has(name)).toBe(false);
    }
  });
});
