/**
 * search_tools says what the caller can do with each tool it finds.
 *
 * In orchestration_only the orchestrator holds no file tool, and search_tools ranked the whole
 * registry and returned bare names (E2E guards-list-files-on-a-file). It found list_files, nothing
 * said the orchestrator could neither call nor load it, and the model called it anyway: the tool
 * grammar turned the call into list_capability_gaps({}), again and again, until the loop brake
 * fired. Each result now carries its reach, read from the caller's tool context: callable (no
 * mark), loadable with load_tool, or held by named agents to delegate to.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tools/registry.js";

const AGENTS = {
  code_analyst: {
    description: "Analyzes and retrieves information from the workspace codebase.",
    capabilities: ["code analysis"], tags: ["code"],
    tools: ["workspace_search", "list_files", "read_file", "read_shared_facts", "share_finding"], maxIterations: 4,
  },
  report_writer_agent: {
    description: "Writes reports from findings.",
    capabilities: ["reports"], tags: ["reports"],
    tools: ["read_shared_facts", "read_file", "write_file"], maxIterations: 4,
  },
};

const QUERY = "list the files in a workspace folder";

let tempDir: string | undefined;

afterEach(async () => {
  delete process.env["SAI_CONFIG_PATH"];
  if (tempDir) { rmSync(tempDir, { recursive: true, force: true }); tempDir = undefined; }
  vi.resetModules();
  (await import("../config/loader.js")).resetConfigForTests();
});

async function searchTools(context: Partial<ToolContext>): Promise<{ output: string; line: string }> {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-search-tools-reach-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    workspacePath: tempDir,
    agents: { defaults: { model: { primary: "lmstudio/qwen" } } },
    subAgents: AGENTS,
    retrieval: { reranker: { enabled: false } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  const [{ getTool, registerTool }] = await Promise.all([
    import("../tools/registry.js"),
    import("../tools/sub-agent.js"),
  ]);
  for (const name of ["list_files", "read_file"]) {
    registerTool({
      name,
      description: name === "list_files" ? "List the files in a workspace folder." : "Read a file from the workspace.",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: true, output: "" }),
    });
  }
  const result = await getTool("search_tools")!.execute({ query: QUERY, topN: 20 }, { sessionId: "search-tools-reach", workspacePath: tempDir, ...context });
  const line = result.output.split("\n").find((text) => text.startsWith("- **list_files**")) ?? "";
  return { output: result.output, line };
}

/** The orchestrator's grant in orchestration_only: no file tool. */
const ORCHESTRATION_TOOLS = ["delegate_to_agent", "search_agents", "search_tools", "record_plan", "ask_user"];

describe("search_tools reports each tool's reach", () => {
  it("marks a tool the caller neither holds nor can load, naming the agents that hold it", async () => {
    const { line } = await searchTools({ allowedTools: ORCHESTRATION_TOOLS, loadableTools: [] });

    expect(line).toContain("not in your tools");
    expect(line).toContain("code_analyst");
    expect(line).toContain("delegate");
    // report_writer_agent holds read_file, not list_files.
    expect(line).not.toContain("report_writer_agent");
  });

  it("names only agents the caller may delegate to, and never the caller itself", async () => {
    const scoped = await searchTools({ allowedTools: ORCHESTRATION_TOOLS, loadableTools: [], allowedAgents: ["report_writer_agent"] });
    expect(scoped.line).toContain("not in your tools");
    expect(scoped.line).not.toContain("code_analyst");

    const self = await searchTools({ allowedTools: ORCHESTRATION_TOOLS, loadableTools: [], currentAgentName: "code_analyst" });
    expect(self.line).not.toContain("code_analyst");
  });

  it("tells a caller that can load the tool to load it", async () => {
    const { line } = await searchTools({ allowedTools: [...ORCHESTRATION_TOOLS, "load_tool"], loadableTools: ["list_files", "read_file"] });

    expect(line).toContain("load_tool");
    expect(line).not.toContain("not in your tools");
  });

  it("leaves a tool the caller holds unmarked, as before", async () => {
    const held = await searchTools({ allowedTools: [...ORCHESTRATION_TOOLS, "list_files"], loadableTools: [] });
    expect(held.line).toMatch(/^- \*\*list_files\*\*: /);

    // An unscoped caller: every tool counts as its own.
    const unscoped = await searchTools({});
    expect(unscoped.line).toMatch(/^- \*\*list_files\*\*: /);
  });
});
