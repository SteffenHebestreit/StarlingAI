import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const delegateExecute = vi.fn(async (args: Record<string, unknown>) => ({
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
