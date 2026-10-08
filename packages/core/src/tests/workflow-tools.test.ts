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
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
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
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
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
      collectTurnArtifactAttachments: () => [],
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
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
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
      collectTurnArtifactAttachments: () => [],
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

  it("run_workflow degrades gracefully (success + routing guidance, NOT an error) for unknown aliases", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
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

      // Not an error — a missing workflow is a routing miss, so it returns success
      // with guidance to delegate (user directive: "not finding a workflow should not
      // lead to an error"). The closest matches still ride in the output + metadata.
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.metadata?.["workflowNotFound"]).toBe(true);
      expect(result.output).toContain("paper_writer");
      expect(result.output).toContain("Closest saved workflows:");
      expect(result.output.toLowerCase()).toContain("delegate to mission_coordinator");
      expect(result.metadata?.["workflowMatches"]).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "protocol_comparison_paper", workflowType: "scene" }),
        expect.objectContaining({ name: "source_backed_paper", workflowType: "scene" }),
        expect.objectContaining({ name: "source_grounded_paper_packet", workflowType: "job" }),
      ]));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Regression: audit session 5b7a67ba (May 2026).  The deep_research_packet
  // job referenced a `deep_research` scene that wasn't defined in the user's
  // starlingai.json.  resolveJobSteps threw "Job step references unknown
  // scene: deep_research"; executeTool didn't catch it; the turn died
  // silently.  Now run_workflow validates referenced scenes BEFORE calling
  // resolveJobSteps and returns a clear error naming the missing scenes.
  it("run_workflow returns a clear error when a job references a scene that is not defined", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
        },
      },
      // NOTE: no `scenes` section at all — the job below references a scene
      // that simply isn't defined anywhere.
      jobs: {
        deep_research_packet: {
          description: "Run a deep-research dossier workflow.",
          params: {
            topic: { description: "Research topic", default: "the requested topic" },
          },
          steps: [
            { scene: "deep_research", label: "Build dossier" },
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
          name: "deep_research_packet",
          workflowType: "job",
          params: { topic: "portable MEMS microphone array" },
        },
        {
          sessionId: "workflow-missing-scene",
          workspacePath: "/workspace",
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("deep_research_packet");
      expect(result.error).toContain("'deep_research'");
      expect(result.error).toContain("not defined");
      expect(result.metadata?.["missingScenes"]).toEqual(["deep_research"]);
      expect(result.metadata?.["blocked"]).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow preserves the original user request when coordinator-first scenes are invoked without params", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
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
        model: "lmstudio/qwen/qwen3.5-9b",
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
      const bootstrapCall = (runSubAgentWithStatsMock.mock.calls as any[])[0]?.[0] as Record<string, any> | undefined;
      expect(bootstrapCall?.task).toContain("Original user request:");
      expect(bootstrapCall?.task).toContain("MCP, A2A und AG-UI");
      expect(bootstrapCall?.context).toContain("Original user request:");
      expect(bootstrapCall?.context).toContain("MCP, A2A und AG-UI");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow hands the person's own words to the workflow's agents", async () => {
    // The scene's task is its author's English; the words are the only place its agents can see
    // the language the deliverable is for ("auf Englisch", or simply that the person wrote German).
    const { tempDir, configPath } = writeTempConfig({
      agents: { defaults: { model: { primary: "lmstudio/qwen/qwen3.5-9b" } } },
      scenes: {
        protocol_comparison_paper: {
          description: "Compare protocols in one grounded paper.",
          task: "Use mission_coordinator first. Research each protocol, then draft one paper.",
          allowedAgents: ["mission_coordinator", "researcher", "paper_author"],
        },
      },
      subAgents: {
        mission_coordinator: { description: "Coordinates multi-step work.", tools: ["search_agents", "delegate_to_agent", "parallel_delegate", "run_task_graph"], maxIterations: 6 },
        researcher: { description: "Finds official sources.", tools: ["web_search", "web_fetch"], maxIterations: 6 },
        paper_author: { description: "Drafts papers.", tools: ["write_file"], maxIterations: 4 },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const runSubAgentWithStatsMock = vi.fn(async () => ({
      output: "done",
      stats: {
        agentName: "mission_coordinator",
        sessionId: "sub:workflow-scene:mission_coordinator:test",
        promptChars: 0,
        userContentChars: 0,
        toolCount: 1,
        toolNames: ["delegate_to_agent"],
        iterations: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 6,
        model: "lmstudio/qwen/qwen3.5-9b",
        capabilities: ["coordination"],
        outcome: "success",
        terminalState: "completed",
      },
    }));
    vi.doMock("../agent/sub-agent.js", () => ({ runSubAgentWithStats: runSubAgentWithStatsMock }));

    const [{ getTool }] = await Promise.all([import("../tools/registry.js"), import("../tools/workflow-catalog.js")]);
    const turnUserWords = { opening: "Schreib mir das Paper bitte auf Englisch.", midTurn: [] };
    try {
      const result = await getTool("run_workflow")!.execute(
        { name: "protocol_comparison_paper", workflowType: "scene" },
        { sessionId: "workflow-scene", workspacePath: "/workspace", allowedAgents: ["mission_coordinator", "researcher", "paper_author"], turnUserWords },
      );
      expect(result.success).toBe(true);
      const bootstrapCall = (runSubAgentWithStatsMock.mock.calls as any[])[0]?.[0] as Record<string, any> | undefined;
      expect(bootstrapCall?.turnUserWords).toBe(turnUserWords);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow bootstraps coordinator-first scenes through a stripped inline coordinator", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
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
        model: "lmstudio/qwen/qwen3.5-9b",
        capabilities: ["coordination"],
        outcome: "success",
        terminalState: "completed",
      },
    }));

    vi.doMock("../agent/runtime.js", () => ({
      collectTurnArtifactAttachments: () => [],
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
      const bootstrapCall = (runSubAgentWithStatsMock.mock.calls as any[])[0]?.[0] as Record<string, any> | undefined;
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

  it("run_workflow bootstraps coordinator scenes that start with 'Use <agent> to ...'", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
        },
      },
      scenes: {
        n8n_project_list: {
          description: "Authenticated internal browser workflow.",
          task: "Use web_task_coordinator to orchestrate the multi-step browser workflow. Delegate browser_agent to navigate to the target website and capture the resulting page state.",
          allowedAgents: ["web_task_coordinator", "browser_agent", "summarizer"],
        },
      },
      subAgents: {
        web_task_coordinator: {
          description: "Coordinates multi-step web work.",
          tools: ["search_agents", "search_workflows", "run_workflow", "delegate_to_agent", "parallel_delegate", "run_task_graph"],
          maxIterations: 6,
        },
        browser_agent: { description: "Operates the browser.", tools: ["browser_navigate"], maxIterations: 4 },
        summarizer: { description: "Summarizes outputs.", tools: ["write_file"], maxIterations: 4 },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const runTurnMock = vi.fn();
    const runSubAgentWithStatsMock = vi.fn(async () => ({
      output: "Delegated browser work and collected the resulting state.",
      stats: {
        agentName: "web_task_coordinator",
        sessionId: "sub:workflow-scene:web_task_coordinator:test",
        promptChars: 0,
        userContentChars: 0,
        toolCount: 1,
        toolNames: ["delegate_to_agent"],
        iterations: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 6,
        model: "lmstudio/qwen/qwen3.5-9b",
        capabilities: ["coordination"],
        outcome: "success",
        terminalState: "completed",
      },
    }));

    vi.doMock("../agent/runtime.js", () => ({
      collectTurnArtifactAttachments: () => [],
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
          name: "n8n_project_list",
          workflowType: "scene",
        },
        {
          sessionId: "workflow-scene",
          workspacePath: "/workspace",
          allowedAgents: ["web_task_coordinator", "browser_agent", "summarizer"],
        },
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("completed via web_task_coordinator bootstrap");
      expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);
      expect(runTurnMock).not.toHaveBeenCalled();

      const bootstrapCall = (runSubAgentWithStatsMock.mock.calls as any[])[0]?.[0] as Record<string, any> | undefined;
      expect(bootstrapCall?.agentName).toBe("web_task_coordinator");
      expect(bootstrapCall?.task).toContain("Orchestrate the multi-step browser workflow.");
      expect(bootstrapCall?.task).not.toContain("Use web_task_coordinator");
      expect(bootstrapCall?._workflowExecutionStack).toEqual(["scene:n8n_project_list"]);
      expect(bootstrapCall?.inlineConfig?.tools).toEqual([
        "search_agents",
        "delegate_to_agent",
        "parallel_delegate",
        "run_task_graph",
      ]);
      expect(bootstrapCall?.context).toContain("Do NOT call search_workflows or run_workflow");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // A scene whose task gives the work to several agents is a multi-agent plan. Its "Use X first …"
  // or "Use X to …" lead named only the first, and a leaf agent cannot delegate, so the scene ran
  // that agent alone: every verified_research_brief went to document_intake (no web tools), and
  // code_review / security_audit / release_notes_draft dropped all but their first agent.
  it("run_workflow orchestrates a scene whose task names several leaf agents instead of running the first alone", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: { defaults: { model: { primary: "lmstudio/qwen/qwen3.5-9b" } } },
      scenes: {
        research_brief: {
          description: "Fact-checked brief.",
          task: "Use document_intake first when the request starts from attached material, researcher for broad source discovery, and summarizer for the final brief.",
          allowedAgents: ["document_intake", "researcher", "summarizer"],
        },
        advisory_digest: {
          description: "Advisory digest.",
          task: "Use researcher to gather current advisories, and summarizer to write the digest.",
          allowedAgents: ["researcher", "summarizer"],
        },
      },
      subAgents: {
        document_intake: { description: "Extracts attachments.", tools: ["extract_file_content"], maxIterations: 4 },
        researcher: { description: "Finds sources.", tools: ["web_search", "web_fetch"], maxIterations: 4 },
        summarizer: { description: "Summarizes outputs.", tools: ["write_file"], maxIterations: 4 },
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
    // A leaf running the scene alone answers like any run; the assertions below say it must not.
    const runSubAgentWithStatsMock = vi.fn(async (opts: { agentName: string }) => ({
      output: `${opts.agentName} handled the whole scene.`,
      stats: {
        agentName: opts.agentName, sessionId: `sub:workflow:${opts.agentName}:test`, promptChars: 0, userContentChars: 0,
        toolCount: 1, toolNames: ["write_file"], iterations: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 4, model: "lmstudio/qwen/qwen3.5-9b", capabilities: [], outcome: "success", terminalState: "completed",
      },
    }));
    vi.doMock("../agent/runtime.js", () => ({
      collectTurnArtifactAttachments: () => [],
      runTurn: runTurnMock,
    }));
    vi.doMock("../agent/sub-agent.js", () => ({
      runSubAgentWithStats: runSubAgentWithStatsMock,
    }));

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/workflow-catalog.js"),
    ]);

    try {
      const tool = getTool("run_workflow");
      expect(tool).toBeDefined();
      for (const name of ["research_brief", "advisory_digest"]) {
        runTurnMock.mockClear();
        const result = await tool!.execute(
          { name, workflowType: "scene" },
          { sessionId: `workflow-${name}`, workspacePath: "/workspace" },
        );
        expect(result.success, name).toBe(true);
        expect(runTurnMock, name).toHaveBeenCalledTimes(1);
      }
      // No leaf agent ran a scene on its own.
      expect(runSubAgentWithStatsMock).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow bootstraps direct browser scenes and strips web_search when the URL is explicit", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
        },
      },
      scenes: {
        credentialed_browser_table_read: {
          description: "Open a known site, log in with stored credentials, then read a protected table.",
          task: "Use browser_agent to open http://app.example.com. Call get_site_credentials first to retrieve the login URL and named URLs. Do NOT use web_search. Then use site_fill_credentials to log in and open the named project-list URL.",
          allowedAgents: ["browser_agent"],
          params: {
            navigationTimeout: {
              description: "Navigation timeout in seconds for the protected page read.",
              default: "120",
            },
          },
        },
      },
      subAgents: {
        browser_agent: {
          description: "Operates the browser.",
          tools: ["web_search", "get_site_credentials", "site_fill_credentials", "browser_navigate", "browser_snapshot", "browser_click", "browser_wait_for"],
          maxIterations: 8,
        },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const runTurnMock = vi.fn();
    const runSubAgentWithStatsMock = vi.fn(async () => ({
      output: "Opened the site, logged in, and read the visible table.",
      stats: {
        agentName: "browser_agent",
        sessionId: "sub:workflow-scene:browser_agent:test",
        promptChars: 0,
        userContentChars: 0,
        toolCount: 3,
        toolNames: ["get_site_credentials", "site_fill_credentials", "browser_snapshot"],
        iterations: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 8,
        model: "lmstudio/qwen/qwen3.5-9b",
        capabilities: ["browser"],
        outcome: "success",
        terminalState: "completed",
      },
    }));

    vi.doMock("../agent/runtime.js", () => ({
      collectTurnArtifactAttachments: () => [],
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
          name: "credentialed_browser_table_read",
          workflowType: "scene",
        },
        {
          sessionId: "workflow-scene",
          workspacePath: "/workspace",
          allowedAgents: ["browser_agent"],
        },
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("completed via browser_agent bootstrap");
      expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);
      expect(runTurnMock).not.toHaveBeenCalled();

      const bootstrapCall = (runSubAgentWithStatsMock.mock.calls as any[])[0]?.[0] as Record<string, any> | undefined;
      expect(bootstrapCall?.agentName).toBe("browser_agent");
      expect(bootstrapCall?.task).toContain("Open http://app.example.com.");
      expect(bootstrapCall?.task).not.toContain("Use browser_agent");
      expect(bootstrapCall?.context).toContain("Do NOT use web_search");
      expect(bootstrapCall?.context).toContain("Call get_site_credentials first");
      expect(bootstrapCall?.context).toContain("prefer the named destination URL from get_site_credentials immediately");
      expect(bootstrapCall?.context).toContain("do not wait for or re-check login-form text such as Sign in");
      expect(bootstrapCall?.context).toContain("do not guess alternate hosts such as localhost");
      expect(bootstrapCall?.context).toContain("prefer browser_snapshot over browser_screenshot");
      expect(bootstrapCall?.turnTimeoutOverrideMs).toBe(150000);
      expect(bootstrapCall?.inlineConfig?.tools).toEqual([
        "get_site_credentials",
        "site_fill_credentials",
        "browser_navigate",
        "browser_snapshot",
        "browser_click",
        "browser_wait_for",
      ]);
      expect(bootstrapCall?._workflowExecutionStack).toEqual(["scene:credentialed_browser_table_read"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow marks browser-scene credential blockers as blocked", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
        },
      },
      scenes: {
        apply_jobs: {
          description: "Run one browser-assisted freelance application from the n8n application table.",
          task: "Use browser_agent to apply for one job from app.example.com and freelancermap.de.",
          allowedAgents: ["browser_agent"],
        },
      },
      subAgents: {
        browser_agent: {
          description: "Operates the browser.",
          tools: ["get_site_credentials", "browser_navigate", "browser_snapshot"],
          maxIterations: 8,
        },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const runSubAgentWithStatsMock = vi.fn(async () => ({
      output: [
        "Zusammenfassung",
        "",
        "Projekt: Frontend Engineer",
        "Status: ⚠️ Blocker - Keine gespeicherten Anmeldedaten für freelancermap.de",
        "",
        "Der Bewerbungsprozess kann nicht fortgesetzt werden.",
      ].join("\n"),
      stats: {
        agentName: "browser_agent",
        sessionId: "sub:workflow-scene:browser_agent:test",
        promptChars: 0,
        userContentChars: 0,
        toolCount: 3,
        toolNames: ["get_site_credentials", "browser_navigate", "browser_snapshot"],
        iterations: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 8,
        model: "lmstudio/qwen/qwen3.5-9b",
        capabilities: ["browser"],
        outcome: "success",
        terminalState: "completed",
      },
    }));

    vi.doMock("../agent/runtime.js", () => ({
      collectTurnArtifactAttachments: () => [],
      runTurn: vi.fn(),
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
      const result = await tool!.execute(
        { name: "apply_jobs", workflowType: "scene" },
        { sessionId: "workflow-scene", workspacePath: "/workspace", allowedAgents: ["browser_agent"] },
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("Workflow apply_jobs [scene] blocked via browser_agent bootstrap");
      expect(result.metadata?.["blocked"]).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow uses the scene approval channel for bootstrap scenes when no interactive callback exists", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
        },
      },
      approvalChannels: {
        "slack-approvals": {
          type: "slack",
          webhookUrl: "https://hooks.slack.com/services/test/test/test",
          timeoutMs: 60_000,
        },
      },
      scenes: {
        credentialed_browser_approval: {
          description: "Open a known site and require approval before stored credentials are submitted.",
          task: "Use browser_agent to open http://app.example.com and then call site_fill_credentials.",
          allowedAgents: ["browser_agent"],
          humanInLoopSteps: ["site_fill_credentials"],
          approvalChannel: "slack-approvals",
          approvalTimeoutMs: 60_000,
        },
      },
      subAgents: {
        browser_agent: {
          description: "Operates the browser.",
          tools: ["site_fill_credentials", "browser_navigate", "browser_snapshot"],
          maxIterations: 8,
        },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const runTurnMock = vi.fn();
    const requestApprovalViaChannelMock = vi.fn(async () => true);
    const runSubAgentWithStatsMock = vi.fn(async (opts: { approvalCallback?: (toolName: string, args: Record<string, unknown>) => Promise<boolean> }) => {
      const approved = await opts.approvalCallback?.("site_fill_credentials", { hostname: "app.example.com" });
      return {
        output: `approval: ${String(approved)}`,
        stats: {
          agentName: "browser_agent",
          sessionId: "sub:workflow-scene:browser_agent:test",
          promptChars: 0,
          userContentChars: 0,
          toolCount: 1,
          toolNames: ["site_fill_credentials"],
          iterations: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          maxIterations: 8,
          model: "lmstudio/qwen/qwen3.5-9b",
          capabilities: ["browser"],
          outcome: "success",
          terminalState: "completed",
        },
      };
    });

    vi.doMock("../agent/runtime.js", () => ({
      collectTurnArtifactAttachments: () => [],
      runTurn: runTurnMock,
    }));
    vi.doMock("../agent/sub-agent.js", () => ({
      runSubAgentWithStats: runSubAgentWithStatsMock,
    }));
    vi.doMock("../approval/index.js", () => ({
      requestApprovalViaChannel: requestApprovalViaChannelMock,
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
          name: "credentialed_browser_approval",
          workflowType: "scene",
        },
        {
          sessionId: "workflow-scene",
          workspacePath: "/workspace",
          allowedAgents: ["browser_agent"],
        },
      );

      expect(result.success).toBe(true);
      expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);
      expect(runTurnMock).not.toHaveBeenCalled();
      expect(requestApprovalViaChannelMock).toHaveBeenCalledTimes(1);
      expect(requestApprovalViaChannelMock).toHaveBeenCalledWith(
        "slack-approvals",
        "site_fill_credentials",
        { hostname: "app.example.com" },
        "credentialed_browser_approval",
        60_000,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow marks bootstrap scenes blocked when approval expires", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
        },
      },
      scenes: {
        credentialed_browser_approval: {
          description: "Open a known site and require approval before stored credentials are submitted.",
          task: "Use browser_agent to open http://app.example.com and then call site_fill_credentials.",
          allowedAgents: ["browser_agent"],
          humanInLoopSteps: ["site_fill_credentials"],
        },
      },
      subAgents: {
        browser_agent: {
          description: "Operates the browser.",
          tools: ["site_fill_credentials", "browser_navigate", "browser_snapshot"],
          maxIterations: 8,
        },
      },
    });

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const runTurnMock = vi.fn();
    const runSubAgentWithStatsMock = vi.fn(async () => ({
      output: "Login blocked: Tool 'site_fill_credentials' approval timed out (no response within 5 min).",
      stats: {
        agentName: "browser_agent",
        sessionId: "sub:workflow-scene:browser_agent:test",
        promptChars: 0,
        userContentChars: 0,
        toolCount: 1,
        toolNames: ["site_fill_credentials"],
        iterations: 1,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 8,
        model: "lmstudio/qwen/qwen3.5-9b",
        capabilities: ["browser"],
        outcome: "success",
        terminalState: "completed",
      },
    }));

    vi.doMock("../agent/runtime.js", () => ({
      collectTurnArtifactAttachments: () => [],
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
          name: "credentialed_browser_approval",
          workflowType: "scene",
        },
        {
          sessionId: "workflow-scene-approval-blocked",
          workspacePath: "/workspace",
          allowedAgents: ["browser_agent"],
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Workflow credentialed_browser_approval [scene] blocked");
      expect(result.error).toContain("approval timed out");
      expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);
      expect(runTurnMock).not.toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("run_workflow accepts partial-progress bootstrap output after substantive coordinator work", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: {
        defaults: {
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
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
        model: "lmstudio/qwen/qwen3.5-9b",
        capabilities: ["coordination"],
        outcome: "partial",
        terminalState: "completed",
      },
    }));

    vi.doMock("../agent/runtime.js", () => ({
      collectTurnArtifactAttachments: () => [],
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
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
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
        model: "lmstudio/qwen/qwen3.5-9b",
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

      const bootstrapCall = (runSubAgentWithStatsMock.mock.calls as any[])[0]?.[0] as Record<string, any> | undefined;
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
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
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
        model: "lmstudio/qwen/qwen3.5-9b",
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
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
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
        model: "lmstudio/qwen/qwen3.5-9b",
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
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
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
      collectTurnArtifactAttachments: () => [],
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
          model: { primary: "lmstudio/qwen/qwen3.5-9b" },
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
      response: `orchestrated: ${opts.userMessage}`,
      toolCallsExecuted: 1,
      guardrailEvents: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      blocked: false,
    }));

    // Both steps are scoped to a single LEAF agent, so they now run that agent DIRECTLY
    // via runSubAgentWithStats (not the orchestrator runTurn) — the fix for a single-agent
    // build step whose orchestrator answered tool-free and never delegated.
    const runSubAgentMock = vi.fn(async (opts: { agentName: string; task: string }) => ({
      output: `handled: ${opts.task}`,
      stats: { outcome: "success", toolCount: 1, iterations: 1, toolNames: [] },
      artifacts: [],
    }));

    vi.doMock("../agent/runtime.js", () => ({
      collectTurnArtifactAttachments: () => [],
      runTurn: runTurnMock,
    }));
    vi.doMock("../agent/sub-agent.js", () => ({
      runSubAgentWithStats: runSubAgentMock,
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
      // Single-leaf steps run the agent directly; the orchestrator path is not used here.
      expect(runTurnMock).not.toHaveBeenCalled();
      expect(runSubAgentMock).toHaveBeenCalledTimes(2);
      expect(runSubAgentMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
        agentName: "researcher",
        task: expect.stringContaining("Keep the comparison source-grounded."),
        allowedAgents: ["researcher"],
        _workflowExecutionStack: ["job:source_grounded_paper_packet"],
      }));
      expect(runSubAgentMock.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        agentName: "paper_author",
        task: expect.stringContaining("Draft the comparison for MCP vs A2A"),
        allowedAgents: ["paper_author"],
        _workflowExecutionStack: ["job:source_grounded_paper_packet"],
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

/**
 * A workflow's runs hand their records up (E2E 2026-10-07 class). In review run_workflow dropped
 * them: a coder whose sandbox failed and whose figures came back masked inside a workflow reached
 * the turn as "Workflow … completed" with no record, so neither the coordinator's own figure check
 * nor the turn's honest directive fired, and a job's next step built on the masked text.
 */
describe("run_workflow and the code its runs executed", () => {
  const MASKED = { attempted: 1, failed: 1, succeededWithOutput: 0, unobservedFigures: 2 };
  const PRIMES = { filename: "primes.js", outputPath: "generated/primes.js", sourceTool: "write_file" };
  const config = () => writeTempConfig({
    agents: { defaults: { model: { primary: "lmstudio/qwen/qwen3.5-9b" } } },
    scenes: {
      prime_report: {
        description: "Count the primes and write them up.",
        task: "Count the primes between 100000 and 200000 and write a short report.",
        allowedAgents: ["coder", "content_writer"],
      },
      count_primes: { description: "Count the primes.", task: "Count the primes between 100000 and 200000.", allowedAgents: ["coder"] },
      explain_count: { description: "Explain the count.", task: "Explain the count of primes.", allowedAgents: ["content_writer"] },
    },
    jobs: {
      prime_packet: {
        description: "Count the primes, then explain the count.",
        steps: [
          { scene: "count_primes", label: "Count" },
          { scene: "explain_count", label: "Explain" },
        ],
      },
    },
    subAgents: {
      coder: { description: "Writes and runs code.", tools: ["write_file", "shell_exec"], maxIterations: 4 },
      content_writer: { description: "Writes reports.", tools: ["write_file"], maxIterations: 4 },
    },
  });
  const subAgentRun = (agentName: string, executions?: Record<string, unknown>) => ({
    output: agentName === "coder" ? "Es gibt [not observed] Primzahlen." : "Der Bericht erklärt die Zählung.",
    stats: { outcome: executions?.["unobservedFigures"] ? "partial" : "success", toolCount: 1, iterations: 1, toolNames: [] },
    artifacts: agentName === "coder" ? [PRIMES] : [],
    ...(executions ? { executions } : {}),
  });
  const runWorkflow = async (name: string, workflowType: string) => {
    const [{ getTool }] = await Promise.all([import("../tools/registry.js"), import("../tools/workflow-catalog.js")]);
    return getTool("run_workflow")!.execute({ name, workflowType }, { sessionId: "workflow-records", workspacePath: "/workspace" });
  };

  it("a scene's orchestrator turn: the records its delegations left in the workflow's session", async () => {
    const { tempDir, configPath } = config();
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    vi.doMock("../agent/runtime.js", () => ({
      collectTurnArtifactAttachments: () => [],
      runTurn: vi.fn(async (opts: { session: { addMessages(messages: unknown[]): void } }) => {
        opts.session.addMessages([{
          role: "tool",
          tool_call_id: "d1",
          content: "Delegated result from coder — PARTIAL PROGRESS.",
          metadata: { agentName: "coder", specialistExecutions: MASKED, artifacts: [PRIMES] },
        }]);
        return { response: "Die Zahlen konnten nicht berechnet werden.", toolCallsExecuted: 1, guardrailEvents: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, blocked: false };
      }),
    }));

    try {
      const result = await runWorkflow("prime_report", "scene");

      expect(result.metadata?.["specialistExecutions"]).toEqual(MASKED);
      expect(result.metadata?.["maskedRuns"]).toEqual([{ agentName: "coder", executions: MASKED, artifacts: [PRIMES] }]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("a scene's bootstrap coordinator: the record its run added up", async () => {
    const { tempDir, configPath } = writeTempConfig({
      agents: { defaults: { model: { primary: "lmstudio/qwen/qwen3.5-9b" } } },
      scenes: {
        prime_mission: {
          description: "Count the primes as a mission.",
          task: "Use mission_coordinator first. It should have the primes between 100000 and 200000 counted and summed.",
          allowedAgents: ["mission_coordinator", "coder"],
        },
      },
      subAgents: {
        mission_coordinator: { description: "Coordinates multi-step work.", tools: ["delegate_to_agent", "parallel_delegate"], maxIterations: 6 },
        coder: { description: "Writes and runs code.", tools: ["write_file", "shell_exec"], maxIterations: 4 },
      },
    });
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    vi.doMock("../agent/runtime.js", () => ({ collectTurnArtifactAttachments: () => [], runTurn: vi.fn() }));
    vi.doMock("../agent/sub-agent.js", () => ({
      runSubAgentWithStats: vi.fn(async () => ({
        output: "Der Coder hat primes.js geschrieben; es gibt [not observed] Primzahlen.",
        stats: { outcome: "partial", toolCount: 2, iterations: 2, toolNames: ["delegate_to_agent", "parallel_delegate"] },
        artifacts: [PRIMES],
        executions: MASKED,
      })),
    }));

    try {
      const result = await runWorkflow("prime_mission", "scene");

      expect(result.metadata?.["bootstrapAgent"]).toBe("mission_coordinator");
      expect(result.metadata?.["specialistExecutions"]).toEqual(MASKED);
      expect(result.metadata?.["maskedRuns"]).toEqual([{ agentName: "mission_coordinator", executions: MASKED, artifacts: [PRIMES] }]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("a job's step whose run masked figures stops the job, and its record goes up", async () => {
    const { tempDir, configPath } = config();
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    const runSubAgentMock = vi.fn(async (opts: { agentName: string }) => subAgentRun(opts.agentName, opts.agentName === "coder" ? MASKED : undefined));
    vi.doMock("../agent/runtime.js", () => ({ collectTurnArtifactAttachments: () => [], runTurn: vi.fn() }));
    vi.doMock("../agent/sub-agent.js", () => ({ runSubAgentWithStats: runSubAgentMock }));

    try {
      const result = await runWorkflow("prime_packet", "job");

      // The explaining step never ran on the masked count.
      expect(runSubAgentMock.mock.calls.map((c) => (c[0] as { agentName: string }).agentName)).toEqual(["coder"]);
      expect(result.success).toBe(false);
      expect(result.metadata?.["blocked"]).toBe(true);
      expect(result.output).toContain("they are masked as [not observed] and were not computed");
      expect(result.metadata?.["specialistExecutions"]).toEqual(MASKED);
      expect(result.metadata?.["maskedRuns"]).toEqual([{ agentName: "coder", executions: MASKED, artifacts: [PRIMES] }]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("a step's QA re-attempt", () => {
    // A step that must save a file and saved none runs once more; one of the two attempts is the
    // step's run. In review the discarded first attempt, which had masked its figures, was handed
    // back as a run that masked figures while the adopted re-attempt had computed them.
    const PRINTED = { attempted: 1, failed: 0, succeededWithOutput: 1 };
    const attempts = {
      masked: { output: "Es gibt [not observed] Primzahlen.", stats: { outcome: "partial", toolCount: 1, iterations: 1, toolNames: [] }, artifacts: [], executions: MASKED },
      printed: { output: "primes.js gab aus: Es gibt 8392 Primzahlen.", stats: { outcome: "success", toolCount: 2, iterations: 2, toolNames: [] }, artifacts: [PRIMES], executions: PRINTED },
      maskedWithFile: { output: "Es gibt [not observed] Primzahlen.", stats: { outcome: "partial", toolCount: 2, iterations: 2, toolNames: [] }, artifacts: [PRIMES], executions: MASKED },
    };
    const runQaJob = async (first: object, second: object) => {
      const { tempDir, configPath } = writeTempConfig({
        agents: { defaults: { model: { primary: "lmstudio/qwen/qwen3.5-9b" } } },
        scenes: {
          count_primes: { description: "Count the primes.", task: "Count the primes between 100000 and 200000.", allowedAgents: ["coder"], expectArtifact: true },
        },
        jobs: { prime_file: { description: "Count the primes into a file.", steps: [{ scene: "count_primes", label: "Count" }] } },
        subAgents: { coder: { description: "Writes and runs code.", tools: ["write_file", "shell_exec"], maxIterations: 4 } },
      });
      process.env["SAI_CONFIG_PATH"] = configPath;
      vi.resetModules();
      const runSubAgentMock = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      vi.doMock("../agent/runtime.js", () => ({ collectTurnArtifactAttachments: () => [], runTurn: vi.fn() }));
      vi.doMock("../agent/sub-agent.js", () => ({ runSubAgentWithStats: runSubAgentMock }));
      try {
        const result = await runWorkflow("prime_file", "job");
        expect(runSubAgentMock).toHaveBeenCalledTimes(2);
        return result;
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    };

    it("adopted with computed figures: the discarded attempt's code counts, its masked figures are not reported", async () => {
      const result = await runQaJob(attempts.masked, attempts.printed);

      expect(result.success).toBe(true);
      expect(result.output).toContain("Es gibt 8392 Primzahlen.");
      expect(result.metadata?.["specialistExecutions"]).toEqual({ attempted: 2, failed: 1, succeededWithOutput: 1 });
      expect(result.metadata).not.toHaveProperty("maskedRuns");
    });

    it("adopted with masked figures: the job stops, and the adopted attempt is the run reported", async () => {
      const result = await runQaJob(attempts.masked, attempts.maskedWithFile);

      expect(result.metadata?.["blocked"]).toBe(true);
      expect(result.metadata?.["specialistExecutions"]).toEqual({ attempted: 2, failed: 2, succeededWithOutput: 0, unobservedFigures: 2 });
      expect(result.metadata?.["maskedRuns"]).toEqual([{ agentName: "coder", executions: MASKED, artifacts: [PRIMES] }]);
    });
  });

  it("control: a job whose coder's script printed runs on, with its record summed", async () => {
    const { tempDir, configPath } = config();
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    const printed = { attempted: 1, failed: 0, succeededWithOutput: 1 };
    const runSubAgentMock = vi.fn(async (opts: { agentName: string }) => subAgentRun(opts.agentName, opts.agentName === "coder" ? printed : undefined));
    vi.doMock("../agent/runtime.js", () => ({ collectTurnArtifactAttachments: () => [], runTurn: vi.fn() }));
    vi.doMock("../agent/sub-agent.js", () => ({ runSubAgentWithStats: runSubAgentMock }));

    try {
      const result = await runWorkflow("prime_packet", "job");

      expect(runSubAgentMock).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
      expect(result.metadata?.["specialistExecutions"]).toEqual(printed);
      expect(result.metadata).not.toHaveProperty("maskedRuns");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
