import { afterEach, describe, expect, it, vi } from "vitest";

// The lean catalog is read from config at call time, so the flag is forced on
// for this file. Everything else keeps the real config.
vi.mock("../config/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/loader.js")>();
  return {
    ...original,
    getConfig: vi.fn(() => ({
      ...original.getConfig(),
      agents: {
        ...original.getConfig().agents,
        performance: { ...original.getConfig().agents.performance, leanToolCatalog: true },
      },
    })),
  };
});

const {
  getAvailableDirectMainToolNames,
  getAvailableOrchestrationToolNames,
  getLoadableDirectMainToolNames,
} = await import("../agent/default-tools.js");
const { getTool, registerTool, unregisterTool } = await import("../tools/registry.js");

const registeredForTest = new Set<string>();

function registerStubTool(name: string): void {
  if (getTool(name)) return;
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
  for (const name of registeredForTest) unregisterTool(name);
  registeredForTest.clear();
});

describe("lean tool catalog (B37)", () => {
  it("withholds direct capability tools from the opening catalog but keeps the core", () => {
    registerStubTool("read_file");
    registerStubTool("web_search");
    registerStubTool("memory_store");
    registerStubTool("load_tool");

    const direct = getAvailableDirectMainToolNames("hybrid");

    // Withheld — these are what the model must now pull in on demand.
    expect(direct).not.toContain("read_file");
    expect(direct).not.toContain("web_search");
    // Kept: the always-available core, plus the tool that reverses the withholding.
    expect(direct).toContain("memory_store");
    expect(direct).toContain("load_tool");
  });

  it("does not offer load_tool when no direct tool was actually withheld", () => {
    // load_tool itself is not registered here, so offering it would be a dead schema.
    registerStubTool("memory_store");

    expect(getAvailableDirectMainToolNames("hybrid")).not.toContain("load_tool");
  });

  it("leaves orchestration tools untouched — routing behaviour must not move", () => {
    registerStubTool("delegate_to_agent");
    registerStubTool("search_agents");

    const orchestration = getAvailableOrchestrationToolNames("hybrid");

    expect(orchestration).toContain("delegate_to_agent");
    expect(orchestration).toContain("search_agents");
  });

  it("only allows loading tools this tool mode would already have offered", () => {
    registerStubTool("read_file");
    registerStubTool("delegate_to_agent");

    // hybrid: the withheld direct tool is loadable...
    expect(getLoadableDirectMainToolNames("hybrid")).toContain("read_file");
    // ...but an orchestration tool is not a "direct" tool and is never loaded this way.
    expect(getLoadableDirectMainToolNames("hybrid")).not.toContain("delegate_to_agent");

    // Non-hybrid modes never offered the direct tools, so load_tool cannot be
    // used to escalate past the tool-mode boundary.
    expect(getLoadableDirectMainToolNames("orchestration_only")).toEqual([]);
    expect(getLoadableDirectMainToolNames("delegate_only")).toEqual([]);
  });
});
