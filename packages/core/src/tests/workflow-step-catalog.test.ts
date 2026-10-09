import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tools/registry.js";

// A scene or job step runs as an orchestrator turn of its own (tools/workflow-catalog.ts). That turn
// kept search_workflows and run_workflow: it searched for the scene it was running, which its own
// task names, tried to run it again, and then ran another scene in place of the agents the scene's
// author named (E2E 2026-10-08, verified_research_brief and source_grounded_paper_packet). These run
// the real run_workflow and the real step turn, with the model scripted.

const streamMock = vi.hoisted(() => vi.fn());
// The discovery prefetch's options, per turn, for the test that turns the prefetch on.
const prefetchOptions = vi.hoisted(() => [] as Array<{ withoutWorkflows?: boolean }>);

vi.mock("../agent/discovery-prefetch.js", () => ({
  formatDiscoveryCapsule: () => "",
  prefetchCapabilityCandidates: async (_query: string, opts?: { withoutWorkflows?: boolean }) => {
    prefetchOptions.push({ ...(opts?.withoutWorkflows !== undefined ? { withoutWorkflows: opts.withoutWorkflows } : {}) });
    return "";
  },
}));

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: async () => ({
      content: "done",
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }),
    stream: (...args: unknown[]) => streamMock(...args),
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: () => null,
    getEmbeddingProvider: () => provider,
  };
});

vi.mock("../guardrails/rate-limiter.js", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("../guardrails/input.js", () => ({
  checkInput: vi.fn(() => ({ allowed: true, detectedPatterns: [] })),
  checkToolOutput: vi.fn(() => ({ allowed: true })),
}));

vi.mock("../guardrails/moderation.js", () => ({
  moderateInputText: vi.fn(async () => null),
  moderateToolResultText: vi.fn(async () => null),
}));

vi.mock("../guardrails/output.js", () => ({
  scanOutput: vi.fn((text: string) => ({ safe: true, redacted: text })),
}));

vi.mock("../audit/logger.js", () => ({
  logAudit: vi.fn(),
}));

const BRIEF_AGENTS = ["researcher", "evidence_analyst", "source_verifier", "summarizer"];

function writeTempConfig(orchestration: Record<string, unknown> = {}): { tempDir: string; configPath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-workflow-step-catalog-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    agents: { defaults: { model: { primary: "lmstudio/qwen/qwen3.5-9b" } } },
    orchestration,
    scenes: {
      verified_research_brief: {
        description: "Produce a concise fact-checked research brief with named sources.",
        task: "Use researcher for broad source discovery, evidence_analyst to reconcile the evidence ledger, source_verifier to flag unsupported claims, and summarizer to produce the final brief.",
        allowedAgents: BRIEF_AGENTS,
      },
    },
    jobs: {
      brief_packet: {
        description: "Write a verified brief.",
        steps: [{ scene: "verified_research_brief", label: "Brief" }],
      },
    },
    subAgents: {
      researcher: { description: "Finds sources.", tools: ["web_search"], maxIterations: 4 },
      evidence_analyst: { description: "Reconciles evidence.", tools: ["read_shared_facts"], maxIterations: 4 },
      source_verifier: { description: "Verifies sources.", tools: ["web_fetch"], maxIterations: 4 },
      summarizer: { description: "Summarizes outputs.", tools: ["write_file"], maxIterations: 4 },
    },
  }), "utf8");
  return { tempDir, configPath };
}

function toolCallStream(callId: string, toolName: string, args: Record<string, unknown>) {
  return (async function* () {
    yield { type: "tool_call_start", toolCallId: callId, toolName };
    yield { type: "tool_call_delta", toolCallId: callId, argumentsDelta: JSON.stringify(args) };
    yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

function textStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

/** The tool names each model call of the turn was offered. */
function offeredToolNames(): string[][] {
  return streamMock.mock.calls.map((call) => ((call[1] ?? []) as Array<{ function?: { name?: string }; name?: string }>)
    .map((tool) => tool.function?.name ?? tool.name ?? ""));
}

let tempDir: string | undefined;

afterEach(() => {
  delete process.env["SAI_CONFIG_PATH"];
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  streamMock.mockReset();
  prefetchOptions.length = 0;
  vi.resetModules();
});

async function loadModules(orchestration: Record<string, unknown> = {}) {
  const written = writeTempConfig(orchestration);
  tempDir = written.tempDir;
  process.env["SAI_CONFIG_PATH"] = written.configPath;
  vi.resetModules();
  // One at a time: runtime and workflow-catalog import each other, and importing both at once
  // never settles.
  const registry = await import("../tools/registry.js");
  const session = await import("../agent/session.js");
  const runtime = await import("../agent/runtime.js");
  await import("../tools/workflow-catalog.js");
  const audit = await import("../audit/logger.js");
  vi.mocked(audit.logAudit).mockClear();
  // The step's delegation, recorded rather than run: which agent the step's turn sent work to.
  // Its second argument is the tool context the delegated agent's own tools would get.
  const delegateExecute = vi.fn(async (args: Record<string, unknown>, _ctx?: ToolContext) => ({
    success: true,
    output: `${String(args["agentName"])} returned the sourced findings.`,
    metadata: { delegationOutcome: "success", agentName: args["agentName"] },
  }));
  registry.registerTool({
    name: "delegate_to_agent",
    description: "delegate",
    parameters: { type: "object", properties: {} },
    execute: delegateExecute,
  });
  // The real catalog tools, watched: the test's own run_workflow call is the one call either may see.
  const watch = (name: string) => {
    const real = registry.getTool(name)!;
    const execute = vi.fn(real.execute.bind(real));
    registry.registerTool({ ...real, execute });
    return execute;
  };
  const searchExecute = watch("search_workflows");
  const runExecute = watch("run_workflow");
  return { registry, runtime, session, logAudit: vi.mocked(audit.logAudit), delegateExecute, searchExecute, runExecute };
}

/** The step's model: it looks the running workflow up, delegates, then tries to run the workflow. */
function scriptStepModel() {
  let call = 0;
  streamMock.mockImplementation(() => {
    call += 1;
    if (call === 1) return toolCallStream("s1", "search_workflows", { query: "verified_research_brief" });
    if (call === 2) return toolCallStream("d1", "delegate_to_agent", { agentName: "researcher", task: "Find authoritative sources." });
    if (call === 3) return toolCallStream("r1", "run_workflow", { name: "verified_research_brief", workflowType: "scene" });
    return textStream("Brief: the sourced findings, with the open questions.");
  });
}

describe("a scene or job step's turn", () => {
  for (const workflow of [
    { name: "verified_research_brief", workflowType: "scene" },
    { name: "brief_packet", workflowType: "job" },
  ] as const) {
    it(`${workflow.workflowType}: neither searches for nor re-runs its workflow, and runs the scene's agents`, async () => {
      const { registry, delegateExecute, searchExecute, runExecute } = await loadModules();
      scriptStepModel();

      const result = await registry.getTool("run_workflow")!.execute(
        { ...workflow },
        { sessionId: `chat-${workflow.workflowType}`, workspacePath: "/workspace" },
      );

      expect(result.success).toBe(true);
      // The step's turn is offered neither catalog tool on any call ...
      const offered = offeredToolNames();
      expect(offered.length).toBeGreaterThan(0);
      for (const names of offered) {
        expect(names).not.toContain("search_workflows");
        expect(names).not.toContain("run_workflow");
      }
      // ... and called anyway, neither runs: run_workflow ran once, for the test's own call.
      expect(searchExecute).not.toHaveBeenCalled();
      expect(runExecute).toHaveBeenCalledTimes(1);
      // The work goes to the agent the scene's author named.
      expect(delegateExecute).toHaveBeenCalledTimes(1);
      expect(delegateExecute.mock.calls[0]![0]).toEqual(expect.objectContaining({ agentName: "researcher" }));
    });
  }

  // The step's turn has no run_workflow, but a coordinator it delegates to keeps one
  // (mission_coordinator), and a delegated agent's tools get the step turn's execution stack
  // (tools/sub-agent.ts, agent/sub-agent.ts). With only the job on that stack, the step of
  // source_grounded_paper_packet ran its own scene nested inside itself (E2E 2026-10-08).
  it("job: an agent the step delegates to cannot run the step's own scene again", async () => {
    const { registry, runExecute } = await loadModules();
    const nested: Array<{ success: boolean; error?: string }> = [];
    registry.registerTool({
      name: "delegate_to_agent",
      description: "delegate",
      parameters: { type: "object", properties: {} },
      // The coordinator's own run_workflow call, made under the context the step's delegation hands on.
      execute: async (_args, ctx) => {
        nested.push(await registry.getTool("run_workflow")!.execute({ name: "verified_research_brief", workflowType: "scene" }, ctx));
        return { success: true, output: "mission_coordinator returned the brief.", metadata: { delegationOutcome: "success", agentName: "mission_coordinator" } };
      },
    });
    scriptStepModel();

    await registry.getTool("run_workflow")!.execute(
      { name: "brief_packet", workflowType: "job" },
      { sessionId: "chat-nested-scene", workspacePath: "/workspace" },
    );

    expect(nested).toHaveLength(1);
    expect(nested[0]!.success).toBe(false);
    expect(nested[0]!.error).toContain("already running in this execution stack");
    // The test's own call and the coordinator's refused one; the scene never ran a second time.
    expect(runExecute).toHaveBeenCalledTimes(2);
  });

  it("control: a chat turn is still offered both catalog tools", async () => {
    const { runtime, session } = await loadModules();
    streamMock.mockImplementation(() => textStream("Hello."));

    await runtime.runTurn({
      session: new session.AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "test" }),
      userMessage: "Write a verified research brief about the history of the city archive.",
    });

    const offered = offeredToolNames();
    expect(offered.length).toBeGreaterThan(0);
    expect(offered[0]).toEqual(expect.arrayContaining(["search_workflows", "run_workflow", "delegate_to_agent"]));
  });

  // The capsule the prefetch puts before the first call named workflows for the turn to "consider
  // run_workflow" on, and a step's task matches the workflow it is running.
  it("asks the discovery prefetch for no workflow, where a chat turn's asks as before", async () => {
    const { registry, runtime, session } = await loadModules({ discoveryPrefetch: true });
    scriptStepModel();
    await registry.getTool("run_workflow")!.execute(
      { name: "verified_research_brief", workflowType: "scene" },
      { sessionId: "chat-prefetch", workspacePath: "/workspace" },
    );
    expect(prefetchOptions).toEqual([{ withoutWorkflows: true }]);

    prefetchOptions.length = 0;
    streamMock.mockImplementation(() => textStream("Hello."));
    await runtime.runTurn({
      session: new session.AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "test" }),
      userMessage: "Write a verified research brief about the history of the city archive.",
    });
    expect(prefetchOptions).toEqual([{}]);
  });
});

// The dashboard and webhook triggers, `/job` over RPC and channel triggers queue a scene or job, and
// the scene worker runs its task, and each job step's task, as a turn on channel "scene"
// (agent/scene-worker.ts). That turn had neither of what a step run from chat gets: it kept the
// catalog tools, was held to its catalog search like a chat turn, and had nothing on the execution
// stack for the recursion check to read.
describe("a scene or job queued through the scene worker", () => {
  async function runQueued(input: { sceneName: string; definitionType: "scene" | "job"; task?: string; steps?: unknown[]; allowedAgents?: string[] }) {
    const jobs = await import("../agent/jobs.js");
    const worker = await import("../agent/scene-worker.js");
    try {
      const queued = await jobs.createJob({ ...input, userId: "operator", turnTimeoutMs: 60_000 } as Parameters<typeof jobs.createJob>[0]);
      await worker.runSceneJobWorkerTick();
      const deadline = Date.now() + 20_000;
      for (;;) {
        const job = await jobs.getJob(queued.id);
        if (job && ["completed", "failed", "cancelled"].includes(job.status)) return job;
        if (Date.now() > deadline) throw new Error(`Job ${queued.id} did not finish (${job?.status})`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await worker.stopSceneJobWorker();
      await jobs.resetJobsForTests();
    }
  }

  it("scene: its turn neither searches for nor re-runs the scene, runs its agents, and stacks the scene", async () => {
    const { delegateExecute, searchExecute, runExecute } = await loadModules();
    scriptStepModel();

    const job = await runQueued({
      sceneName: "verified_research_brief",
      definitionType: "scene",
      task: "Use researcher for broad source discovery, evidence_analyst to reconcile the evidence ledger, source_verifier to flag unsupported claims, and summarizer to produce the final brief.",
      allowedAgents: BRIEF_AGENTS,
    });

    expect(job.status).toBe("completed");
    const offered = offeredToolNames();
    expect(offered.length).toBeGreaterThan(0);
    for (const names of offered) {
      expect(names).not.toContain("search_workflows");
      expect(names).not.toContain("run_workflow");
    }
    expect(searchExecute).not.toHaveBeenCalled();
    expect(runExecute).not.toHaveBeenCalled();
    expect(delegateExecute).toHaveBeenCalledTimes(1);
    expect(delegateExecute.mock.calls[0]![0]).toEqual(expect.objectContaining({ agentName: "researcher" }));
    // What the step's delegated agents run under: a coordinator among them is refused the scene.
    expect(delegateExecute.mock.calls[0]![1]).toEqual(expect.objectContaining({ _workflowExecutionStack: ["scene:verified_research_brief"] }));
  });

  it("job: each step's turn is the same, with the job and the step's scene stacked", async () => {
    const { delegateExecute, searchExecute, runExecute } = await loadModules();
    scriptStepModel();
    const { getJobDefinition, resolveJobSteps } = await import("../credentials/jobs.js");

    const job = await runQueued({
      sceneName: "brief_packet",
      definitionType: "job",
      steps: resolveJobSteps(getJobDefinition("brief_packet")!),
    });

    expect(job.status).toBe("completed");
    for (const names of offeredToolNames()) {
      expect(names).not.toContain("search_workflows");
      expect(names).not.toContain("run_workflow");
    }
    expect(searchExecute).not.toHaveBeenCalled();
    expect(runExecute).not.toHaveBeenCalled();
    expect(delegateExecute).toHaveBeenCalledTimes(1);
    expect(delegateExecute.mock.calls[0]![1]).toEqual(expect.objectContaining({
      _workflowExecutionStack: ["job:brief_packet", "scene:verified_research_brief"],
    }));
  });
});

// A step's orchestrated turn that gives up (the warden after failed delegations, every tool call
// refused, the iteration cap) ends with a forced synthesis and blocked:false. Its step was reported
// completed though no specialist had returned anything: in the E2E run of
// source_grounded_paper_packet no specialist ran anywhere and run_workflow came back "completed".
describe("a scene or job step whose turn gave up", () => {
  const failedDelegation = (agentName: string) => ({
    success: false,
    output: "",
    error: `Delegation failed: ${agentName} could not reach the site.`,
    metadata: { delegationSucceeded: false, attemptedAgents: [agentName] },
  });
  const deliveredDelegation = (agentName: string) => ({
    success: true,
    output: `${agentName} returned the sourced findings: founded 1987, 146 employees, warehouses Nordhafen, Südtal and Westmark, 18 articles in six categories.`,
    metadata: { delegationOutcome: "success", delegationSucceeded: true, agentName },
  });

  /** Runs the workflow with the step's delegations answered in order (the last answer repeats). */
  async function runWithDelegations(
    workflow: { name: string; workflowType: "scene" | "job" },
    answers: Array<(agentName: string) => object>,
    ctxExtra: Record<string, unknown> = {},
  ) {
    const { registry, logAudit } = await loadModules();
    let delegations = 0;
    registry.registerTool({
      name: "delegate_to_agent",
      description: "delegate",
      parameters: { type: "object", properties: {} },
      execute: async (args) => answers[Math.min(delegations++, answers.length - 1)]!(String(args["agentName"])) as never,
    });
    let call = 0;
    streamMock.mockImplementation(() => {
      call += 1;
      if (call === 1) return toolCallStream("d1", "delegate_to_agent", { agentName: "researcher", task: "Find authoritative sources." });
      if (call === 2) return toolCallStream("d2", "delegate_to_agent", { agentName: "evidence_analyst", task: "Weigh the evidence." });
      return textStream("The brief could not be completed.");
    });
    const result = await registry.getTool("run_workflow")!.execute(workflow, { sessionId: `chat-gave-up-${workflow.workflowType}`, workspacePath: "/workspace", ...ctxExtra });
    const flagged = logAudit.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .filter((data) => data?.["type"] === "workflow_step_ran_no_specialist");
    return { result, flagged };
  }

  for (const workflow of [
    { name: "verified_research_brief", workflowType: "scene" },
    { name: "brief_packet", workflowType: "job" },
  ] as const) {
    it(`${workflow.workflowType}: after its delegations failed back to back, is reported blocked`, async () => {
      const { result, flagged } = await runWithDelegations(workflow, [failedDelegation]);

      expect(result.success).toBe(false);
      expect(result.metadata?.["blocked"]).toBe(true);
      expect(result.output).toContain(`Workflow ${workflow.name} [${workflow.workflowType}] blocked.`);
      expect(flagged).toEqual([expect.objectContaining({ workflow: workflow.name, finishReason: "delegation_failures_terminal" })]);
    });
  }

  it("job: at the iteration cap with no specialist's result, is reported blocked", async () => {
    const { result, flagged } = await runWithDelegations({ name: "brief_packet", workflowType: "job" }, [failedDelegation], { maxIterationsOverride: 1 });

    expect(result.metadata?.["blocked"]).toBe(true);
    expect(flagged).toEqual([expect.objectContaining({ step: "Brief", finishReason: "max_tool_iterations" })]);
  });

  it("job: with every tool call refused, is reported blocked", async () => {
    const { registry, logAudit } = await loadModules();
    let call = 0;
    // run_workflow is not among the step turn's tools, so each call is refused before it runs.
    streamMock.mockImplementation(() => {
      call += 1;
      if (call <= 4) return toolCallStream(`r${call}`, "run_workflow", { name: `other_scene_${call}`, workflowType: "scene" });
      return textStream("The brief could not be completed.");
    });

    const result = await registry.getTool("run_workflow")!.execute({ name: "brief_packet", workflowType: "job" }, { sessionId: "chat-refused", workspacePath: "/workspace" });

    expect(result.metadata?.["blocked"]).toBe(true);
    const flagged = logAudit.mock.calls.map((c) => c[1] as Record<string, unknown>).filter((data) => data?.["type"] === "workflow_step_ran_no_specialist");
    expect(flagged).toEqual([expect.objectContaining({ finishReason: "all_tool_calls_blocked" })]);
  });

  it("control: at the iteration cap after its specialist returned, completes", async () => {
    const { result, flagged } = await runWithDelegations({ name: "brief_packet", workflowType: "job" }, [deliveredDelegation], { maxIterationsOverride: 1 });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Workflow brief_packet [job] completed.");
    expect(flagged).toEqual([]);
  });
});
