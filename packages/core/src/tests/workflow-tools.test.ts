import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function writeTempConfig(config: unknown): { tempDir: string; configPath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-workflow-tools-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  return { tempDir, configPath };
}

afterEach(() => {
  delete process.env["SAI_CONFIG_PATH"];
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("workflow catalog tools", () => {
  it("search_workflows surfaces reusable paper workflows before ad hoc planning", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-9b" },
        },
      },
      scenes: {
        protocol_comparison_paper: {
          description: "Compare protocols through parallel evidence gathering and a grounded paper draft.",
          task: "Use mission_coordinator to compare {{topic}} and draft a paper.",
          allowedAgents: ["mission_coordinator", "paper_author", "quality_supervisor"],
        },
      },
      jobs: {
        source_grounded_paper_packet: {
          description: "Reusable evidence-gathering and paper workflow.",
          params: {
            topic: { description: "Topic to cover", default: "the requested topic" },
          },
          steps: [
            { scene: "protocol_comparison_paper", label: "Draft comparison paper", params: { topic: "{{topic}}" } },
          ],
        },
      },
      subAgents: {
        mission_coordinator: { description: "Coordinates multi-step work.", tools: ["parallel_delegate", "run_task_graph"], maxIterations: 6 },
        paper_author: { description: "Drafts papers.", tools: ["write_file"], maxIterations: 4 },
        quality_supervisor: { description: "Runs one quality gate.", tools: ["read_file"], maxIterations: 4 },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    vi.doMock("../providers/index.js", () => ({
      getEmbeddingProvider: () => ({
        embed: async () => {
          throw new Error("embedding offline in unit test");
        },
      }),
    }));

    const [{ getTool }, _workflowTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/workflow-catalog.js"),
    ]);

    try {
      const tool = getTool("search_workflows");
      expect(tool).toBeDefined();

      const result = await tool!.execute(
        { query: "source grounded protocol comparison paper" },
        { sessionId: "workflow-search", workspacePath: "/workspace" },
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("source_grounded_paper_packet");
      expect(result.output).toContain("protocol_comparison_paper");
      expect(result.output).toContain("NEXT ACTION");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow executes scenes inline with scoped agents", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-9b" },
        },
      },
      scenes: {
        protocol_comparison_paper: {
          description: "Compare protocols with one paper draft and one QA pass.",
          task: "Compare {{topic}} as a source-grounded paper.",
          allowedAgents: ["mission_coordinator", "paper_author", "quality_supervisor"],
        },
      },
      subAgents: {
        mission_coordinator: { description: "Coordinates multi-step work.", tools: ["parallel_delegate", "run_task_graph"], maxIterations: 6 },
        paper_author: { description: "Drafts papers.", tools: ["write_file"], maxIterations: 4 },
        quality_supervisor: { description: "Runs one quality gate.", tools: ["read_file"], maxIterations: 4 },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const onSwarmState = vi.fn();

    const runTurnMock = vi.fn(async (opts: { userMessage: string; allowedAgents?: string[] }) => ({
      response: `handled: ${opts.userMessage}`,
      toolCallsExecuted: 1,
      guardrailEvents: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      blocked: false,
    }));

    vi.doMock("../agent/runtime.js", () => ({
      runTurn: runTurnMock,
    }));

    const [{ getTool }, _workflowTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/workflow-catalog.js"),
    ]);

    try {
      const tool = getTool("run_workflow");
      expect(tool).toBeDefined();

      const result = await tool!.execute(
        {
          name: "protocol_comparison_paper",
          workflowType: "scene",
          params: { topic: "MCP vs A2A", audience: "staff engineers" },
          context: "Focus on authoritative sources and one final QA pass.",
        },
        {
          sessionId: "workflow-scene",
          workspacePath: "/workspace",
          allowedAgents: ["mission_coordinator", "paper_author", "quality_supervisor"],
          onSwarmState,
        },
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("Workflow protocol_comparison_paper [scene] completed");
      expect(runTurnMock).toHaveBeenCalledTimes(1);
      expect(runTurnMock).toHaveBeenCalledWith(expect.objectContaining({
        userMessage: expect.stringContaining("MCP vs A2A"),
        allowedAgents: ["mission_coordinator", "paper_author", "quality_supervisor"],
        _workflowExecutionStack: ["scene:protocol_comparison_paper"],
      }));
      expect(runTurnMock.mock.calls[0]?.[0]?.userMessage).toContain("Workflow parameters:\n- audience: staff engineers");
      expect(onSwarmState).toHaveBeenCalled();
      const finalSwarmState = onSwarmState.mock.calls.at(-1)?.[0];
      expect(finalSwarmState?.tasks?.["workflow:scene:protocol_comparison_paper"]?.status).toBe("completed");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow resolves a unique partial workflow name", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-9b" },
        },
      },
      scenes: {
        protocol_comparison_paper: {
          description: "Compare protocols with one paper draft and one QA pass.",
          task: "Compare {{topic}} as a source-grounded paper.",
          allowedAgents: ["mission_coordinator", "paper_author", "quality_supervisor"],
        },
      },
      subAgents: {
        mission_coordinator: { description: "Coordinates multi-step work.", tools: ["parallel_delegate", "run_task_graph"], maxIterations: 6 },
        paper_author: { description: "Drafts papers.", tools: ["write_file"], maxIterations: 4 },
        quality_supervisor: { description: "Runs one quality gate.", tools: ["read_file"], maxIterations: 4 },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const runTurnMock = vi.fn(async () => ({
      response: "handled partial workflow alias",
      toolCallsExecuted: 1,
      guardrailEvents: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      blocked: false,
    }));

    vi.doMock("../agent/runtime.js", () => ({
      runTurn: runTurnMock,
    }));

    const [{ getTool }, _workflowTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/workflow-catalog.js"),
    ]);

    try {
      const tool = getTool("run_workflow");
      expect(tool).toBeDefined();

      const result = await tool!.execute(
        {
          name: "protocol",
          workflowType: "auto",
          params: { topic: "MCP vs A2A" },
        },
        {
          sessionId: "workflow-scene",
          workspacePath: "/workspace",
        },
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("Workflow protocol_comparison_paper [scene] completed");
      expect(runTurnMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow returns closest workflow matches for unknown aliases", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-9b" },
        },
      },
      scenes: {
        protocol_comparison_paper: {
          description: "Compare protocols with one paper draft and one QA pass.",
          task: "Compare {{topic}} as a source-grounded paper.",
        },
        source_backed_paper: {
          description: "Draft a source-backed paper for the requested topic.",
          task: "Draft a source-backed paper about {{topic}}.",
        },
      },
      jobs: {
        source_grounded_paper_packet: {
          description: "Collect evidence, then write a paper packet.",
          params: {
            topic: { description: "Topic to cover", default: "the requested topic" },
          },
          steps: [
            { scene: "protocol_comparison_paper", label: "Draft comparison paper", params: { topic: "{{topic}}" } },
          ],
        },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const [{ getTool }, _workflowTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/workflow-catalog.js"),
    ]);

    try {
      const tool = getTool("run_workflow");
      expect(tool).toBeDefined();

      const result = await tool!.execute(
        {
          name: "paper_writer",
          workflowType: "auto",
          params: { topic: "MCP vs A2A" },
        },
        {
          sessionId: "workflow-alias",
          workspacePath: "/workspace",
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Workflow not found: paper_writer");
      expect(result.error).toContain("Closest workflows:");
      expect(result.metadata?.["workflowMatches"]).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "protocol_comparison_paper", workflowType: "scene" }),
        expect.objectContaining({ name: "source_backed_paper", workflowType: "scene" }),
        expect.objectContaining({ name: "source_grounded_paper_packet", workflowType: "job" }),
      ]));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow preserves the original user request when coordinator-first scenes are invoked without params", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-9b" },
        },
      },
      scenes: {
        protocol_comparison_paper: {
          description: "Compare multiple protocols or standards through parallel evidence gathering, one grounded comparison paper draft, and one final quality gate.",
          task: "Use mission_coordinator first. Partition the work into one evidence-gathering track per protocol, standard, or framework under comparison. Use researcher for each track, require reusable findings via share_finding, consolidate overlap and conflicts with research_librarian or evidence_analyst, then delegate drafting to paper_author and exactly one final acceptance pass to quality_supervisor.",
          allowedAgents: ["mission_coordinator", "researcher", "paper_author", "quality_supervisor"],
        },
      },
      subAgents: {
        mission_coordinator: { description: "Coordinates multi-step work.", tools: ["search_agents", "delegate_to_agent", "parallel_delegate", "run_task_graph"], maxIterations: 6 },
        researcher: { description: "Finds official sources.", tools: ["web_search", "web_fetch"], maxIterations: 6 },
        paper_author: { description: "Drafts papers.", tools: ["write_file"], maxIterations: 4 },
        quality_supervisor: { description: "Runs one quality gate.", tools: ["read_file"], maxIterations: 4 },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const runSubAgentWithStatsMock = vi.fn(async () => ({
      output: "mission_coordinator gathered current sources before drafting",
      stats: {
        agentName: "mission_coordinator",
        sessionId: "sub:workflow-scene:mission_coordinator:test",
        promptChars: 0,
        userContentChars: 0,
        toolCount: 2,
        toolNames: ["delegate_to_agent", "share_finding"],
        iterations: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 6,
        model: "lmstudio/qwen3.5-9b",
        capabilities: ["coordination"],
        outcome: "success",
        terminalState: "completed",
      },
    }));

    vi.doMock("../agent/sub-agent.js", () => ({
      runSubAgentWithStats: runSubAgentWithStatsMock,
    }));

    const [{ getTool }, _workflowTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/workflow-catalog.js"),
    ]);

    try {
      const tool = getTool("run_workflow");
      expect(tool).toBeDefined();

      const result = await tool!.execute(
        {
          name: "protocol_comparison_paper",
          workflowType: "scene",
        },
        {
          sessionId: "workflow-scene",
          workspacePath: "/workspace",
          allowedAgents: ["mission_coordinator", "researcher", "paper_author", "quality_supervisor"],
          swarmState: {
            objective: "Schreibe mir ein kurzes Paper zu KI-Protokollen mit Fokus auf MCP, A2A und AG-UI.",
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            tasks: {},
          },
        },
      );

      expect(result.success).toBe(true);
      expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);
      const bootstrapCall = runSubAgentWithStatsMock.mock.calls[0]?.[0];
      expect(bootstrapCall?.task).toContain("Original user request:");
      expect(bootstrapCall?.task).toContain("MCP, A2A und AG-UI");
      expect(bootstrapCall?.context).toContain("Original user request:");
      expect(bootstrapCall?.context).toContain("MCP, A2A und AG-UI");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow bootstraps coordinator-first scenes through a stripped inline coordinator", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-9b" },
        },
      },
      scenes: {
        deep_research_dossier: {
          description: "Run a deep-research mission with evidence gathering and final synthesis.",
          task: "Use mission_coordinator first. It should decide whether the request needs independent source gathering, structured evidence indexing, data analysis, chart rendering, diagram generation, and final writing.",
          allowedAgents: ["mission_coordinator", "researcher", "paper_author", "quality_supervisor"],
        },
      },
      subAgents: {
        mission_coordinator: { description: "Coordinates multi-step work.", tools: ["search_agents", "search_workflows", "run_workflow", "delegate_to_agent", "parallel_delegate", "run_task_graph"], maxIterations: 6 },
        researcher: { description: "Finds official sources.", tools: ["web_search", "web_fetch"], maxIterations: 6 },
        paper_author: { description: "Drafts papers.", tools: ["write_file"], maxIterations: 4 },
        quality_supervisor: { description: "Runs one quality gate.", tools: ["read_file"], maxIterations: 4 },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const runTurnMock = vi.fn();
    const runSubAgentWithStatsMock = vi.fn(async () => ({
      output: "mission_coordinator gathered current sources before drafting",
      stats: {
        agentName: "mission_coordinator",
        sessionId: "sub:workflow-scene:mission_coordinator:test",
        promptChars: 0,
        userContentChars: 0,
        toolCount: 2,
        toolNames: ["delegate_to_agent", "share_finding"],
        iterations: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 6,
        model: "lmstudio/qwen3.5-9b",
        capabilities: ["coordination"],
        outcome: "success",
        terminalState: "completed",
      },
    }));

    vi.doMock("../agent/runtime.js", () => ({
      runTurn: runTurnMock,
    }));
    vi.doMock("../agent/sub-agent.js", () => ({
      runSubAgentWithStats: runSubAgentWithStatsMock,
    }));

    const [{ getTool }, _workflowTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/workflow-catalog.js"),
    ]);

    try {
      const tool = getTool("run_workflow");
      expect(tool).toBeDefined();

      const result = await tool!.execute(
        {
          name: "deep_research_dossier",
          workflowType: "scene",
          params: {
            topic: "MCP vs A2A",
            focus_areas: "Official specs and interoperability",
          },
          context: "Prefer current official specifications.",
        },
        {
          sessionId: "workflow-scene",
          workspacePath: "/workspace",
          allowedAgents: ["mission_coordinator", "researcher", "paper_author", "quality_supervisor"],
        },
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("completed via mission_coordinator bootstrap");
      expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);
      const bootstrapCall = runSubAgentWithStatsMock.mock.calls[0]?.[0];
      expect(bootstrapCall).toBeDefined();
      expect(bootstrapCall?.agentName).toBe("mission_coordinator");
      expect(bootstrapCall?.parentSessionId).toBe("workflow-scene");
      expect(bootstrapCall?.task).toContain("Decide whether the request needs independent source gathering, structured evidence indexing, data analysis, chart rendering, diagram generation, and final writing.");
      expect(bootstrapCall?.task).toContain("Additional workflow context:");
      expect(bootstrapCall?.task).toContain("Workflow parameters:\n- topic: MCP vs A2A\n- focus_areas: Official specs and interoperability");
      expect(bootstrapCall?.allowedAgents).toEqual(["mission_coordinator", "researcher", "paper_author", "quality_supervisor"]);
      expect(bootstrapCall?._workflowExecutionStack).toEqual(["scene:deep_research_dossier"]);
      expect(bootstrapCall?.inlineConfig?.tools).toEqual([
        "search_agents",
        "delegate_to_agent",
        "parallel_delegate",
        "run_task_graph",
      ]);
      expect(bootstrapCall?.context).toContain("Do NOT call search_workflows or run_workflow");
      expect(bootstrapCall?.context).toContain("gather evidence with researcher");
      expect(bootstrapCall?.context).toContain("If read_shared_facts is empty or insufficient");
      expect(runTurnMock).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow accepts partial-progress bootstrap output after substantive coordinator work", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-9b" },
        },
      },
      scenes: {
        deep_research_dossier: {
          description: "Run a deep-research mission with evidence gathering and final synthesis.",
          task: "Use mission_coordinator first. It should decide whether the request needs independent source gathering, structured evidence indexing, data analysis, chart rendering, diagram generation, and final writing.",
          allowedAgents: ["mission_coordinator", "researcher", "paper_author", "quality_supervisor"],
        },
      },
      subAgents: {
        mission_coordinator: { description: "Coordinates multi-step work.", tools: ["search_agents", "delegate_to_agent", "parallel_delegate", "run_task_graph", "read_shared_facts", "share_finding"], maxIterations: 6 },
        researcher: { description: "Finds official sources.", tools: ["web_search", "web_fetch"], maxIterations: 6 },
        paper_author: { description: "Drafts papers.", tools: ["write_file"], maxIterations: 4 },
        quality_supervisor: { description: "Runs one quality gate.", tools: ["read_file"], maxIterations: 4 },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const runTurnMock = vi.fn();
    const runSubAgentWithStatsMock = vi.fn(async () => ({
      output: "Sub-agent 'mission_coordinator' produced no final response after substantive work.\nPartial progress before interruption:\n- Tool calls executed: 7 (run_task_graph, search_agents, delegate_to_agent, share_finding)\n- Iterations completed: 7",
      stats: {
        agentName: "mission_coordinator",
        sessionId: "sub:workflow-scene:mission_coordinator:test",
        promptChars: 0,
        userContentChars: 0,
        toolCount: 7,
        toolNames: ["run_task_graph", "search_agents", "delegate_to_agent", "share_finding"],
        iterations: 7,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 6,
        model: "lmstudio/qwen3.5-9b",
        capabilities: ["coordination"],
        outcome: "partial",
        terminalState: "completed",
      },
    }));

    vi.doMock("../agent/runtime.js", () => ({
      runTurn: runTurnMock,
    }));
    vi.doMock("../agent/sub-agent.js", () => ({
      runSubAgentWithStats: runSubAgentWithStatsMock,
    }));

    const [{ getTool }, _workflowTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/workflow-catalog.js"),
    ]);

    try {
      const tool = getTool("run_workflow");
      expect(tool).toBeDefined();

      const result = await tool!.execute(
        {
          name: "deep_research_dossier",
          workflowType: "scene",
        },
        {
          sessionId: "workflow-scene",
          workspacePath: "/workspace",
          allowedAgents: ["mission_coordinator", "researcher", "paper_author", "quality_supervisor"],
        },
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("Workflow deep_research_dossier [scene] completed via mission_coordinator bootstrap");
      expect(result.output).toContain("Partial progress before interruption:");
      expect(result.output).toContain("delegate_to_agent");
      expect(result.metadata?.["bootstrapAgent"]).toBe("mission_coordinator");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow strips non-orchestration tools from inline coordinator bootstrap configs", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-9b" },
        },
      },
      scenes: {
        deep_research_dossier: {
          description: "Run a deep-research mission with evidence gathering and final synthesis.",
          task: "Use mission_coordinator first. It should decide whether the request needs independent source gathering.",
          allowedAgents: ["mission_coordinator", "researcher", "paper_author", "quality_supervisor"],
        },
      },
      subAgents: {
        mission_coordinator: {
          description: "Coordinates multi-step work.",
          tools: [
            "read_file",
            "write_file",
            "list_files",
            "workspace_search",
            "generate_document",
            "list_agents",
            "search_agents",
            "search_workflows",
            "run_workflow",
            "delegate_to_agent",
            "parallel_delegate",
            "run_task_graph",
            "read_shared_facts",
            "share_finding",
          ],
          maxIterations: 6,
        },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const runSubAgentWithStatsMock = vi.fn(async () => ({
      output: "Delegated evidence collection and published the execution plan.",
      stats: {
        agentName: "mission_coordinator",
        sessionId: "sub:workflow-scene:mission_coordinator:test",
        promptChars: 0,
        userContentChars: 0,
        toolCount: 2,
        toolNames: ["delegate_to_agent", "share_finding"],
        iterations: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 6,
        model: "lmstudio/qwen3.5-9b",
        capabilities: ["coordination"],
        outcome: "success",
        terminalState: "completed",
      },
    }));

    vi.doMock("../agent/sub-agent.js", () => ({
      runSubAgentWithStats: runSubAgentWithStatsMock,
    }));

    const [{ getTool }, _workflowTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/workflow-catalog.js"),
    ]);

    try {
      const tool = getTool("run_workflow");
      expect(tool).toBeDefined();

      const result = await tool!.execute(
        {
          name: "deep_research_dossier",
          workflowType: "scene",
        },
        {
          sessionId: "workflow-scene",
          workspacePath: "/workspace",
          allowedAgents: ["mission_coordinator", "researcher", "paper_author", "quality_supervisor"],
        },
      );

      expect(result.success).toBe(true);

      const bootstrapCall = runSubAgentWithStatsMock.mock.calls[0]?.[0];
      expect(bootstrapCall?.inlineConfig?.tools).toEqual([
        "search_agents",
        "delegate_to_agent",
        "parallel_delegate",
        "run_task_graph",
        "read_shared_facts",
        "share_finding",
      ]);
      expect(bootstrapCall?.inlineConfig?.tools).not.toContain("read_file");
      expect(bootstrapCall?.inlineConfig?.tools).not.toContain("list_files");
      expect(bootstrapCall?.inlineConfig?.tools).not.toContain("workspace_search");
      expect(bootstrapCall?.inlineConfig?.tools).not.toContain("generate_document");
      expect(bootstrapCall?.inlineConfig?.tools).not.toContain("list_agents");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow bootstrap preserves failure output from the inline coordinator", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-9b" },
        },
      },
      scenes: {
        deep_research_dossier: {
          description: "Run a deep-research mission with evidence gathering and final synthesis.",
          task: "Use mission_coordinator first. It should decide whether the request needs independent source gathering.",
          allowedAgents: ["mission_coordinator", "researcher", "paper_author", "quality_supervisor"],
        },
      },
      subAgents: {
        mission_coordinator: { description: "Coordinates multi-step work.", tools: ["search_agents", "search_workflows", "run_workflow", "delegate_to_agent"], maxIterations: 6 },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const runSubAgentWithStatsMock = vi.fn(async () => ({
      output: "Sub-agent produced no final response.",
      stats: {
        agentName: "mission_coordinator",
        sessionId: "sub:workflow-scene:mission_coordinator:test",
        promptChars: 0,
        userContentChars: 0,
        toolCount: 0,
        toolNames: [],
        iterations: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 6,
        model: "lmstudio/qwen3.5-9b",
        capabilities: ["coordination"],
        outcome: "failure",
        terminalState: "completed",
      },
    }));

    vi.doMock("../agent/sub-agent.js", () => ({
      runSubAgentWithStats: runSubAgentWithStatsMock,
    }));

    const [{ getTool }, _workflowTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/workflow-catalog.js"),
    ]);

    try {
      const tool = getTool("run_workflow");
      expect(tool).toBeDefined();

      const result = await tool!.execute(
        {
          name: "deep_research_dossier",
          workflowType: "scene",
        },
        {
          sessionId: "workflow-scene",
          workspacePath: "/workspace",
          allowedAgents: ["mission_coordinator", "researcher", "paper_author", "quality_supervisor"],
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Workflow deep_research_dossier [scene] blocked via mission_coordinator bootstrap");
      expect(result.error).toContain("Sub-agent produced no final response");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow blocks coordinator bootstrap that only inspects shared facts", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-9b" },
        },
      },
      scenes: {
        protocol_comparison_paper: {
          description: "Compare multiple protocols or standards through parallel evidence gathering, one grounded draft, and one final quality gate.",
          task: "Use mission_coordinator first. Partition the work into one evidence-gathering track per protocol, standard, or framework under comparison. Use researcher for each track, require reusable findings via share_finding, then delegate drafting to paper_author.",
          allowedAgents: ["mission_coordinator", "researcher", "paper_author", "quality_supervisor"],
        },
      },
      subAgents: {
        mission_coordinator: { description: "Coordinates multi-step work.", tools: ["search_agents", "delegate_to_agent", "parallel_delegate", "run_task_graph", "read_shared_facts", "share_finding"], maxIterations: 6 },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const runSubAgentWithStatsMock = vi.fn(async () => ({
      output: "No shared facts are available yet. I would next research sources and then draft the paper.",
      stats: {
        agentName: "mission_coordinator",
        sessionId: "sub:workflow-scene:mission_coordinator:test",
        promptChars: 0,
        userContentChars: 0,
        toolCount: 1,
        toolNames: ["read_shared_facts"],
        iterations: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 6,
        model: "lmstudio/qwen3.5-9b",
        capabilities: ["coordination"],
        outcome: "success",
        terminalState: "completed",
      },
    }));

    vi.doMock("../agent/sub-agent.js", () => ({
      runSubAgentWithStats: runSubAgentWithStatsMock,
    }));

    const [{ getTool }, _workflowTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/workflow-catalog.js"),
    ]);

    try {
      const tool = getTool("run_workflow");
      expect(tool).toBeDefined();

      const result = await tool!.execute(
        {
          name: "protocol_comparison_paper",
          workflowType: "scene",
        },
        {
          sessionId: "workflow-scene",
          workspacePath: "/workspace",
          allowedAgents: ["mission_coordinator", "researcher", "paper_author", "quality_supervisor"],
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Workflow protocol_comparison_paper [scene] blocked via mission_coordinator bootstrap");
      expect(result.error).toContain("stopped without evidence-gathering or delegation progress");
      expect(result.error).toContain("read_shared_facts");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow rejects recursive self reentry", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-9b" },
        },
      },
      scenes: {
        protocol_comparison_paper: {
          description: "Compare protocols with one paper draft and one QA pass.",
          task: "Compare {{topic}} as a source-grounded paper.",
          allowedAgents: ["mission_coordinator", "paper_author", "quality_supervisor"],
        },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const runTurnMock = vi.fn();

    vi.doMock("../agent/runtime.js", () => ({
      runTurn: runTurnMock,
    }));

    const [{ getTool }, _workflowTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/workflow-catalog.js"),
    ]);

    try {
      const tool = getTool("run_workflow");
      expect(tool).toBeDefined();

      const result = await tool!.execute(
        {
          name: "protocol_comparison_paper",
          workflowType: "scene",
          params: { topic: "MCP vs A2A" },
        },
        {
          sessionId: "workflow-scene",
          workspacePath: "/workspace",
          _workflowExecutionStack: ["scene:protocol_comparison_paper"],
        },
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("already running in this execution stack");
      expect(runTurnMock).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow executes job steps sequentially", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen3.5-9b" },
        },
      },
      scenes: {
        collect_evidence: {
          description: "Collect evidence.",
          task: "Collect sources for {{topic}}.",
          allowedAgents: ["researcher"],
        },
        draft_paper: {
          description: "Draft the paper.",
          task: "Draft the comparison for {{topic}}.",
          allowedAgents: ["paper_author"],
        },
      },
      jobs: {
        source_grounded_paper_packet: {
          description: "Collect evidence, then draft a paper.",
          params: {
            topic: { description: "Topic to cover", default: "the requested topic" },
          },
          steps: [
            { scene: "collect_evidence", label: "Collect evidence", params: { topic: "{{topic}}" } },
            { scene: "draft_paper", label: "Draft paper", params: { topic: "{{topic}}" } },
          ],
        },
      },
      subAgents: {
        researcher: { description: "Collects sources.", tools: ["web_search"], maxIterations: 4 },
        paper_author: { description: "Drafts papers.", tools: ["write_file"], maxIterations: 4 },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const runTurnMock = vi.fn(async (opts: { userMessage: string; allowedAgents?: string[] }) => ({
      response: `handled: ${opts.userMessage}`,
      toolCallsExecuted: 1,
      guardrailEvents: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      blocked: false,
    }));

    vi.doMock("../agent/runtime.js", () => ({
      runTurn: runTurnMock,
    }));

    const [{ getTool }, _workflowTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/workflow-catalog.js"),
    ]);

    try {
      const tool = getTool("run_workflow");
      expect(tool).toBeDefined();

      const result = await tool!.execute(
        {
          name: "source_grounded_paper_packet",
          workflowType: "job",
          params: { topic: "MCP vs A2A" },
          context: "Keep the comparison source-grounded.",
        },
        {
          sessionId: "workflow-job",
          workspacePath: "/workspace",
        },
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("Workflow source_grounded_paper_packet [job] completed");
      expect(result.output).toContain("## Collect evidence");
      expect(result.output).toContain("## Draft paper");
      expect(runTurnMock).toHaveBeenCalledTimes(2);
      expect(runTurnMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
        userMessage: expect.stringContaining("Keep the comparison source-grounded."),
        allowedAgents: ["researcher"],
        _workflowExecutionStack: ["job:source_grounded_paper_packet"],
      }));
      expect(runTurnMock.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        userMessage: expect.stringContaining("Draft the comparison for MCP vs A2A"),
        allowedAgents: ["paper_author"],
        _workflowExecutionStack: ["job:source_grounded_paper_packet"],
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});