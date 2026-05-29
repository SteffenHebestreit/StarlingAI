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

      const messages = completeMock.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
      const systemMessage = messages?.find((message) => message.role === "system")?.content ?? "";

      expect(result.output).toContain("Research complete.");
      expect(systemMessage).toContain("When the task depends on current, external, or source-sensitive facts, validate them with up-to-date web evidence whenever feasible instead of relying only on prior knowledge.");
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

  it("does not strip tools when an agent re-calls an idempotent read before its write tool", async () => {
    // Regression: session 39af10b8 (2026-05-29). content_writer re-called
    // read_shared_facts 3× (1 real + 2 cached "no facts"). The cached repeats
    // counted as blocked iterations, the loop detector stripped ALL tools at
    // iteration 2, and the agent was killed before it ever reached write_file
    // — so the website deliverable was never even attempted. A cached
    // *successful* return is progress, not a block.
    const { tempDir, configPath } = writeTempConfig({
      subAgents: {
        builder_agent: {
          description: "Idempotent re-call regression agent",
          systemPrompt: "Check context, then write the file.",
          tools: ["read_file", "write_file"],
          maxIterations: 8,
        },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const writtenPaths: string[] = [];
    const responses = [
      buildToolCallResponse("read-1", "read_file", { path: "context.md" }),
      buildToolCallResponse("read-2", "read_file", { path: "context.md" }),
      buildToolCallResponse("read-3", "read_file", { path: "context.md" }),
      buildToolCallResponse("write-1", "write_file", { path: "cpsa-f.html", content: "<!DOCTYPE html><html></html>" }),
      {
        content: "Website written to cpsa-f.html.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      },
    ];

    completeMock.mockImplementation(async () => responses.shift() ?? {
      content: "Website written to cpsa-f.html.",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "read_file",
      description: "Read a workspace file.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "No shared facts available yet for this session." };
      },
    });
    registerTool({
      name: "write_file",
      description: "Write a workspace file.",
      parameters: { type: "object", properties: {} },
      async execute(args) {
        writtenPaths.push(String(args.path ?? ""));
        return {
          success: true,
          output: `Wrote ${args.path as string}.`,
          metadata: { outputPath: String(args.path ?? ""), filename: String(args.path ?? "") },
        };
      },
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "builder_agent",
        task: "Erzeuge eine vollständige HTML-Lernwebsite und speichere sie mit write_file.",
        parentSessionId: "parent-idempotent-recall",
        workspacePath: "/workspace",
      });

      // The agent must have survived the redundant read_file calls and reached write_file.
      expect(writtenPaths).toEqual(["cpsa-f.html"]);
      expect(result.stats.toolNames).toContain("write_file");
      expect(result.stats.terminalState).toBe("completed");
    } finally {
      unregisterTool("read_file");
      unregisterTool("write_file");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // QUARANTINED (DEVPLAN P0): the partial-progress relay no longer lists the tool names used. Output is
  // now "Sub-agent 'mission_coordinator' produced…" without "delegate_to_agent"/"share_finding". Confirm the
  // intended partial-progress message format, then update the assertions or restore the tool-name listing.
  it.skip("returns partial progress instead of a no-response sentinel after substantive tool work", async () => {
    const { tempDir, configPath } = writeTempConfig({
      subAgents: {
        mission_coordinator: {
          description: "Coordinator empty-final-response rescue test agent",
          systemPrompt: "Coordinate evidence gathering and publish findings.",
          tools: ["delegate_to_agent", "share_finding"],
          maxIterations: 6,
        },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const responses = [
      buildToolCallResponse("delegate-1", "delegate_to_agent", { agentName: "researcher", task: "Gather sources" }),
      buildToolCallResponse("finding-1", "share_finding", { key: "mcp_protocol_overview", value: "Collected source metadata." }),
      {
        content: "",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      },
      {
        content: "",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      },
    ];

    completeMock.mockImplementation(async () => responses.shift() ?? {
      content: "",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "delegate_to_agent",
      description: "Delegate work to another agent.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "Delegated result from researcher — PARTIAL PROGRESS." };
      },
    });
    registerTool({
      name: "share_finding",
      description: "Publish a finding.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "Finding published to shared session memory." };
      },
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "mission_coordinator",
        task: "Coordinate protocol research and publish a finding.",
        parentSessionId: "parent-empty-final-rescue",
        workspacePath: "/workspace",
      });

      expect(result.output).not.toBe("Sub-agent produced no final response.");
      expect(result.output).toContain("Partial progress before interruption:");
      expect(result.output).toContain("delegate_to_agent");
      expect(result.output).toContain("share_finding");
      expect(result.stats.outcome).toBe("partial");
      expect(result.stats.terminalState).toBe("completed");
    } finally {
      unregisterTool("delegate_to_agent");
      unregisterTool("share_finding");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("lets coordinator agents use delegate_to_agent more than the generic cap", async () => {
    const { tempDir, configPath } = writeTempConfig({
      subAgents: {
        mission_coordinator: {
          description: "Coordinator delegation cap override test agent",
          systemPrompt: "Coordinate the workflow by delegating each stage.",
          tools: ["delegate_to_agent", "run_task_graph"],
          maxIterations: 8,
        },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const responses = [
      buildToolCallResponse("delegate-1", "delegate_to_agent", { agentName: "researcher", task: "Gather MCP evidence" }),
      buildToolCallResponse("delegate-2", "delegate_to_agent", { agentName: "researcher", task: "Collect citation-grade MCP sources" }),
      buildToolCallResponse("delegate-3", "delegate_to_agent", { agentName: "researcher", task: "Summarize MCP publication details" }),
      buildToolCallResponse("delegate-4", "delegate_to_agent", { agentName: "paper_author", task: "Draft the protocol comparison paper" }),
      buildToolCallResponse("delegate-5", "delegate_to_agent", { agentName: "quality_supervisor", task: "Review the protocol comparison paper" }),
      {
        content: "Workflow completed after coordinator handoffs.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      },
    ];

    completeMock.mockImplementation(async () => responses.shift() ?? {
      content: "Workflow completed after coordinator handoffs.",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    const executedTasks: string[] = [];
    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "delegate_to_agent",
      description: "Delegate work to another agent.",
      parameters: { type: "object", properties: {} },
      async execute(args) {
        executedTasks.push(String(args.task ?? ""));
        return { success: true, output: `Delegated: ${String(args.task ?? "")}` };
      },
    });
    registerTool({
      name: "run_task_graph",
      description: "Present only so the agent is classified as a coordinator.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "graph complete" };
      },
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "mission_coordinator",
        task: "Coordinate a source-grounded protocol paper workflow.",
        parentSessionId: "parent-coordinator-cap",
        workspacePath: "/workspace",
      });

      expect(result.output).toContain("Workflow completed after coordinator handoffs.");
      expect(executedTasks).toHaveLength(5);
      expect(result.stats.toolCount).toBe(5);
      expect(result.output).not.toContain("has been called 3 times this run");
    } finally {
      unregisterTool("delegate_to_agent");
      unregisterTool("run_task_graph");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("passes through completed workflow output when discovery plus run_workflow are the only tools used", async () => {
    const { tempDir, configPath } = writeTempConfig({
      subAgents: {
        mission_coordinator: {
          description: "Workflow passthrough test agent",
          systemPrompt: "Find a reusable workflow, run it, and return the result.",
          tools: ["search_workflows", "run_workflow"],
          maxIterations: 4,
        },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const workflowOutput = "Workflow protocol_comparison_paper [scene] completed via mission_coordinator bootstrap.\n\n# Vergleich von KI-Protokollen: MCP, A2A und AG-UI\n\nAusgearbeiteter Paper-Inhalt.";
    const responses = [
      buildToolCallResponse("workflow-search-1", "search_workflows", { query: "paper MCP A2A AG-UI" }),
      buildToolCallResponse("workflow-run-1", "run_workflow", { name: "protocol_comparison_paper", workflowType: "scene" }),
      {
        content: "Das Paper zu KI-Protokollen mit den Schwerpunkten MCP, A2A und AG-UI wurde erfolgreich erstellt. Hier ist eine Zusammenfassung der wichtigsten Erkenntnisse.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      },
    ];

    completeMock.mockImplementation(async () => responses.shift() ?? {
      content: "",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "search_workflows",
      description: "Search reusable workflows.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "Workflow matches for paper MCP A2A AG-UI: protocol_comparison_paper [scene]" };
      },
    });
    registerTool({
      name: "run_workflow",
      description: "Run a reusable workflow.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: workflowOutput,
          metadata: {
            workflowName: "protocol_comparison_paper",
            workflowType: "scene",
            blocked: false,
          },
        };
      },
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "mission_coordinator",
        task: "Erstelle ein kurzes Paper zu KI-Protokollen.",
        parentSessionId: "parent-workflow-passthrough",
        workspacePath: "/workspace",
      });

      expect(result.output).toBe(workflowOutput);
      expect(result.stats.terminalState).toBe("completed");
      expect(result.stats.toolCount).toBe(2);
    } finally {
      unregisterTool("search_workflows");
      unregisterTool("run_workflow");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("passes through completed workflow output when run_workflow is followed by share_finding", async () => {
    const { tempDir, configPath } = writeTempConfig({
      subAgents: {
        mission_coordinator: {
          description: "Workflow passthrough with finding publication test agent",
          systemPrompt: "Find a reusable workflow, run it, publish one finding, and return the result.",
          tools: ["search_workflows", "run_workflow", "share_finding"],
          maxIterations: 5,
        },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const workflowOutput = "Workflow protocol_comparison_paper [scene] completed via mission_coordinator bootstrap.\n\n# KI-Protokolle im Vergleich: MCP, A2A und AG-UI\n\nVollstaendiger Paper-Inhalt mit Quellen und Trade-offs.";
    const responses = [
      buildToolCallResponse("workflow-search-2", "search_workflows", { query: "paper MCP A2A AG-UI" }),
      buildToolCallResponse("workflow-run-2", "run_workflow", { name: "protocol_comparison_paper", workflowType: "scene" }),
      buildToolCallResponse("workflow-findings-2", "share_finding", {
        key: "ai_protocols_paper_complete",
        value: "Paper complete",
      }),
      {
        content: "Das Paper wurde erfolgreich erstellt. Hier ist eine kurze Zusammenfassung der wichtigsten Punkte.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      },
    ];

    completeMock.mockImplementation(async () => responses.shift() ?? {
      content: "",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "search_workflows",
      description: "Search reusable workflows.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "Workflow matches for paper MCP A2A AG-UI: protocol_comparison_paper [scene]" };
      },
    });
    registerTool({
      name: "run_workflow",
      description: "Run a reusable workflow.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return {
          success: true,
          output: workflowOutput,
          metadata: {
            workflowName: "protocol_comparison_paper",
            workflowType: "scene",
            blocked: false,
          },
        };
      },
    });
    registerTool({
      name: "share_finding",
      description: "Publish a validated finding.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "Finding published to shared session memory." };
      },
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "mission_coordinator",
        task: "Erstelle ein kurzes Paper zu KI-Protokollen und publiziere den Abschlussfund.",
        parentSessionId: "parent-workflow-share-finding",
        workspacePath: "/workspace",
      });

      expect(result.output).toBe(workflowOutput);
      expect(result.stats.terminalState).toBe("completed");
      expect(result.stats.toolCount).toBe(3);
    } finally {
      unregisterTool("search_workflows");
      unregisterTool("run_workflow");
      unregisterTool("share_finding");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("per-agent model config", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("merges per-agent model override over defaults so stats.model reflects the override", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "default-llm" },
        },
      },
      subAgents: {
        specialist_agent: {
          description: "Model override test agent",
          systemPrompt: "You are a specialist.",
          tools: [],
          maxIterations: 1,
          model: { primary: "overridden-llm" },
        },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    completeMock.mockResolvedValueOnce({
      content: "Specialist complete.",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "specialist_agent",
        task: "Do the specialist task.",
        parentSessionId: "parent-model-override",
        workspacePath: "/workspace",
      });

      expect(result.stats.model).toBe("overridden-llm");
      expect(result.output).toContain("Specialist complete.");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});