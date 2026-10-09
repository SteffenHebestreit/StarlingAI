import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMMessage } from "../providers/lmstudio.js";

// A scene or job step runs as an orchestrator turn of its own (tools/workflow-catalog.ts,
// agent/scene-worker.ts). That turn ended at its first delegation that returned: the runtime required
// synthesis ("Do NOT delegate again") because the turn had recorded no plan, so the agents the scene's
// task names after researcher never ran (E2E 2026-10-08, verified_research_brief and
// source_grounded_paper_packet). These run the real run_workflow and the real step turn, with the model
// scripted to follow whatever the runtime tells it.

const streamMock = vi.hoisted(() => vi.fn());

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

const PIPELINE = ["researcher", "evidence_analyst", "summarizer"];
const SYNTHESIS = "[SYNTHESIS REQUIRED]";
const CONTINUE = "[CONTINUE PLAN]";

function writeTempConfig(): { tempDir: string; configPath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-workflow-step-pipeline-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    agents: { defaults: { model: { primary: "lmstudio/qwen/qwen3.5-9b" } } },
    orchestration: { planDrivenContinuation: true },
    scenes: {
      // The task's order is not the allowedAgents order, and its placeholder is filled with a word
      // that is also an agent's name.
      sourced_brief: {
        description: "Write a sourced brief.",
        task: "On {{topic}}: use researcher for the sources, evidence_analyst to weigh them, and summarizer to write the brief.",
        allowedAgents: ["summarizer", "evidence_analyst", "researcher"],
        params: { topic: { description: "Topic", default: "the requested topic" } },
      },
      open_brief: {
        description: "Write a sourced brief.",
        task: "Write a short sourced brief on the requested topic.",
        allowedAgents: ["summarizer", "evidence_analyst", "researcher"],
      },
      intake_brief: {
        description: "Write a sourced brief, from attachments when there are any.",
        task: "Use document_intake first when the request starts from attached material, researcher for the sources, and summarizer to write the brief.",
        allowedAgents: ["document_intake", "researcher", "summarizer"],
      },
    },
    jobs: {
      sourced_brief_packet: {
        description: "Write a sourced brief.",
        steps: [{ scene: "sourced_brief", label: "Brief" }],
      },
    },
    subAgents: {
      researcher: { description: "Finds sources.", tools: ["web_search"], maxIterations: 4 },
      evidence_analyst: { description: "Reconciles evidence.", tools: ["read_shared_facts"], maxIterations: 4 },
      summarizer: { description: "Summarizes outputs.", tools: ["write_file", "delegate_to_agent"], maxIterations: 4 },
      document_intake: { description: "Reads attachments.", tools: ["read_file"], maxIterations: 4 },
      mission_coordinator: { description: "Coordinates a mission.", tools: ["delegate_to_agent", "parallel_delegate"], maxIterations: 4 },
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

let tempDir: string | undefined;

afterEach(() => {
  delete process.env["SAI_CONFIG_PATH"];
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  streamMock.mockReset();
  vi.resetModules();
});

async function loadModules() {
  const written = writeTempConfig();
  tempDir = written.tempDir;
  process.env["SAI_CONFIG_PATH"] = written.configPath;
  vi.resetModules();
  // One at a time: runtime and workflow-catalog import each other, and importing both at once
  // never settles.
  const registry = await import("../tools/registry.js");
  const session = await import("../agent/session.js");
  const runtime = await import("../agent/runtime.js");
  await import("../tools/workflow-catalog.js");
  const pipeline = await import("../agent/workflow-step-pipeline.js");
  // The step's delegations, recorded rather than run.
  const delegated: string[] = [];
  registry.registerTool({
    name: "delegate_to_agent",
    description: "delegate",
    parameters: { type: "object", properties: {} },
    execute: async (args: Record<string, unknown>) => {
      const agentName = String(args["agentName"]);
      delegated.push(agentName);
      return {
        success: true,
        output: `${agentName} returned the sourced findings: founded 1987, 146 employees, warehouses Nordhafen, Südtal and Westmark.`,
        metadata: { delegationOutcome: "success", delegationSucceeded: true, agentName },
      };
    },
  });
  return { registry, runtime, session, pipeline, delegated };
}

function directiveKind(directive: string): "continue" | "synthesis" {
  return directive.startsWith(CONTINUE) ? "continue" : "synthesis";
}

/** The directive the runtime last put after a delegation, if any. */
function lastDirective(messages: LLMMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = typeof messages[index]!.content === "string" ? messages[index]!.content as string : "";
    if (content.startsWith(CONTINUE) || content.startsWith(SYNTHESIS)) return content;
  }
  return undefined;
}

/**
 * The step's model. It delegates to `first`, then does what the runtime's directive says: on a
 * [CONTINUE PLAN] it delegates to the first agent the directive names, otherwise it answers.
 */
function scriptDirectiveFollowingModel(first: string, agents: readonly string[] = PIPELINE) {
  const directives: string[] = [];
  let call = 0;
  streamMock.mockImplementation((messages: LLMMessage[]) => {
    call += 1;
    if (call === 1) return toolCallStream("d1", "delegate_to_agent", { agentName: first, task: "Do your part of the brief." });
    const directive = lastDirective(messages);
    if (directive) directives.push(directive);
    if (directive?.startsWith(CONTINUE)) {
      const next = agents
        .map((agent) => ({ agent, at: directive.indexOf(agent) }))
        .filter((mention) => mention.at !== -1)
        .sort((a, b) => a.at - b.at)[0]?.agent;
      if (next) return toolCallStream(`d${call}`, "delegate_to_agent", { agentName: next, task: "Do your part of the brief." });
    }
    return textStream("Brief: founded 1987, 146 employees, warehouses Nordhafen, Südtal and Westmark.");
  });
  return directives;
}

describe("workflowStepPipeline", () => {
  it("names the in-scope agents in the task's order, from the task as its author wrote it", async () => {
    const { pipeline } = await loadModules();
    const allowed = ["summarizer", "evidence_analyst", "researcher", "document_intake"];

    expect(pipeline.workflowStepPipeline(
      "On {{summarizer}}: use researcher for the sources, evidence_analyst to weigh them, and summarizer to write the brief.",
      allowed,
    )).toEqual(PIPELINE);
    // Whole identifiers only, and only agents in scope that exist.
    expect(pipeline.workflowStepPipeline("researchers and a pre_summarizer feed qa_guard, then evidence_analyst.", [...allowed, "qa_guard"]))
      .toEqual(["evidence_analyst"]);
    expect(pipeline.workflowStepPipeline("Write a short sourced brief.", allowed)).toEqual([]);
    expect(pipeline.workflowStepPipeline("use researcher, then summarizer", undefined)).toEqual([]);
  });

  it("ends at the first agent that coordinates: the agents named after it run inside its run", async () => {
    const { pipeline } = await loadModules();

    expect(pipeline.workflowStepPipeline(
      "Run mission_coordinator. Phase 1 - researcher gathers sources. Phase 2 - evidence_analyst reconciles them. Phase 3 - summarizer writes.",
      ["mission_coordinator", "researcher", "evidence_analyst", "summarizer"],
    )).toEqual(["mission_coordinator"]);
    // summarizer can delegate once for missing evidence; that does not make it a coordinator.
    expect(pipeline.workflowStepPipeline("researcher, then summarizer, then evidence_analyst.", PIPELINE))
      .toEqual(["researcher", "summarizer", "evidence_analyst"]);
  });

  it("offers the agents after the furthest one that returned, and none at the cap or after masked figures", async () => {
    const { pipeline } = await loadModules();
    const base = { pipeline: ["document_intake", ...PIPELINE], executedDelegations: 1, delegationCap: 5, lastDelegationSucceeded: true };

    expect(pipeline.remainingWorkflowStepAgents({ ...base, returned: new Set(["researcher"]) })).toEqual(["evidence_analyst", "summarizer"]);
    expect(pipeline.remainingWorkflowStepAgents({ ...base, returned: new Set(["researcher", "summarizer"]) })).toEqual([]);
    expect(pipeline.remainingWorkflowStepAgents({ ...base, returned: new Set() })).toEqual(["document_intake", ...PIPELINE]);
    expect(pipeline.remainingWorkflowStepAgents({ ...base, returned: new Set(["researcher"]), executedDelegations: 5 })).toEqual([]);
    expect(pipeline.remainingWorkflowStepAgents({ ...base, returned: new Set(["researcher"]), lastDelegationSucceeded: false })).toEqual([]);
  });
});

describe("a scene or job step's turn runs the agents its task names, in the task's order", () => {
  it("scene: researcher, evidence_analyst and summarizer, each after the one before it returned", async () => {
    const { registry, delegated } = await loadModules();
    const directives = scriptDirectiveFollowingModel("researcher");

    const result = await registry.getTool("run_workflow")!.execute(
      // The filled-in topic names an agent: the order still comes from the author's task.
      { name: "sourced_brief", workflowType: "scene", params: { topic: "summarizer benchmarks" } },
      { sessionId: "chat-pipeline-scene", workspacePath: "/workspace" },
    );

    expect(result.success).toBe(true);
    expect(delegated).toEqual(PIPELINE);
    // Kept going twice, then told to write the brief once every named agent had returned.
    expect(directives.map(directiveKind)).toEqual(["continue", "continue", "synthesis"]);
    expect(directives[0]).toContain("evidence_analyst, summarizer");
    expect(result.output).toContain("Brief: founded 1987");
  });

  it("job: the step's turn does the same", async () => {
    const { registry, delegated } = await loadModules();
    scriptDirectiveFollowingModel("researcher");

    const result = await registry.getTool("run_workflow")!.execute(
      { name: "sourced_brief_packet", workflowType: "job" },
      { sessionId: "chat-pipeline-job", workspacePath: "/workspace" },
    );

    expect(result.success).toBe(true);
    expect(delegated).toEqual(PIPELINE);
  });

  it("an agent the turn passed over is not offered again: document_intake with nothing attached", async () => {
    const { registry, delegated } = await loadModules();
    const directives = scriptDirectiveFollowingModel("researcher", ["document_intake", "researcher", "summarizer"]);

    await registry.getTool("run_workflow")!.execute(
      { name: "intake_brief", workflowType: "scene" },
      { sessionId: "chat-pipeline-intake", workspacePath: "/workspace" },
    );

    expect(delegated).toEqual(["researcher", "summarizer"]);
    expect(directives[0]).toContain("summarizer");
    expect(directives[0]).not.toContain("document_intake");
  });

  it("control: a step whose task names no agent ends at its first delegation, as before", async () => {
    const { registry, delegated } = await loadModules();
    const directives = scriptDirectiveFollowingModel("researcher");

    const result = await registry.getTool("run_workflow")!.execute(
      { name: "open_brief", workflowType: "scene" },
      { sessionId: "chat-pipeline-open", workspacePath: "/workspace" },
    );

    expect(result.success).toBe(true);
    expect(delegated).toEqual(["researcher"]);
    expect(directives).toHaveLength(1);
    expect(directives[0]!.startsWith(SYNTHESIS)).toBe(true);
  });

  it("control: a chat turn that names the same agents ends at its first delegation, as before", async () => {
    const { runtime, session, delegated } = await loadModules();
    const directives = scriptDirectiveFollowingModel("researcher");

    await runtime.runTurn({
      session: new session.AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "test" }),
      userMessage: "Use researcher for the sources, evidence_analyst to weigh them, and summarizer to write the brief.",
    });

    expect(delegated).toEqual(["researcher"]);
    expect(directives).toHaveLength(1);
    expect(directives[0]!.startsWith(SYNTHESIS)).toBe(true);
  });
});

// The dashboard and webhook triggers, `/job` over RPC and channel triggers queue a scene or job, and the
// scene worker runs it as a turn on channel "scene" (agent/scene-worker.ts).
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

  it("scene: its turn runs the scene's agents in the task's order", async () => {
    const { delegated } = await loadModules();
    scriptDirectiveFollowingModel("researcher");

    const job = await runQueued({
      sceneName: "sourced_brief",
      definitionType: "scene",
      task: "On summarizer benchmarks: use researcher for the sources, evidence_analyst to weigh them, and summarizer to write the brief.",
      allowedAgents: ["summarizer", "evidence_analyst", "researcher"],
    });

    expect(job.status).toBe("completed");
    expect(delegated).toEqual(PIPELINE);
  });

  it("job: each step's turn does the same", async () => {
    const { delegated } = await loadModules();
    scriptDirectiveFollowingModel("researcher");
    const { getJobDefinition, resolveJobSteps } = await import("../credentials/jobs.js");

    const job = await runQueued({
      sceneName: "sourced_brief_packet",
      definitionType: "job",
      steps: resolveJobSteps(getJobDefinition("sourced_brief_packet")!),
    });

    expect(job.status).toBe("completed");
    expect(delegated).toEqual(PIPELINE);
  });
});
