import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const completeMock = vi.fn();

vi.mock("../providers/lmstudio.js", () => ({
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

function writeTempConfig(config: unknown): { tempDir: string; configPath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-sub-agent-tool-caps-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  return { tempDir, configPath };
}

function buildToolCallResponse(id: string, name: string, args: Record<string, unknown>) {
  return {
    content: "",
    tool_calls: [{ id, name, arguments: args }],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "tool_calls",
  };
}

describe("sub-agent research tool caps", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("allows research runs to exceed five web searches and fetches", async () => {
    const { tempDir, configPath } = writeTempConfig({
      subAgents: {
        research_agent: {
          description: "Research cap test agent",
          systemPrompt: "Gather sources and stop when enough evidence is collected.",
          tools: ["web_search", "web_fetch"],
          maxIterations: 20,
        },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const searchQueries: string[] = [];
    const fetchUrls: string[] = [];
    const responses = [
      ...Array.from({ length: 6 }, (_value, index) => buildToolCallResponse(
        `search-${index + 1}`,
        "web_search",
        { query: `query ${index + 1}` },
      )),
      ...Array.from({ length: 6 }, (_value, index) => buildToolCallResponse(
        `fetch-${index + 1}`,
        "web_fetch",
        { url: `https://example.com/${index + 1}` },
      )),
      {
        content: "Research complete.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      },
    ];

    completeMock.mockImplementation(async () => responses.shift() ?? {
      content: "Research complete.",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "web_search",
      description: "Search the web.",
      parameters: { type: "object", properties: {} },
      async execute(args) {
        searchQueries.push(String(args.query ?? ""));
        return { success: true, output: `search result for ${args.query as string}` };
      },
    });
    registerTool({
      name: "web_fetch",
      description: "Fetch a web page.",
      parameters: { type: "object", properties: {} },
      async execute(args) {
        fetchUrls.push(String(args.url ?? ""));
        return { success: true, output: `fetch result for ${args.url as string}` };
      },
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "research_agent",
        task: "Research the topic thoroughly.",
        parentSessionId: "parent-research-cap",
        workspacePath: "/workspace",
      });

      expect(result.output).toContain("Research complete.");
      expect(searchQueries).toHaveLength(6);
      expect(fetchUrls).toHaveLength(6);
      expect(result.stats.toolCount).toBe(12);
      expect(result.stats.terminalState).toBe("completed");
    } finally {
      unregisterTool("web_search");
      unregisterTool("web_fetch");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});