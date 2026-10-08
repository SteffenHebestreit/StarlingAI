import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwarmState, ToolContext } from "../tools/registry.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";
import type { TurnUserWords } from "../agent/delegation-user-words.js";

/**
 * EVERY DELEGATION CARRIES THE USER'S WORDS, AND NONE OF THEM CHANGES THE TASK.
 *
 * All the tool-level ways of handing work to a specialist meet in one function, and the user's
 * words are forwarded there, beside the task and never merged into it: `task` drives routing, the
 * reuse signature and translation, so it must reach the runner exactly as the orchestrator wrote
 * it. These call each entry tool with the words on the context and read what the runner received.
 */
const statsFor = (args: SubAgentRunOptions): SubAgentRunResult["stats"] => ({
  agentName: args.agentName,
  sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
  promptChars: 0,
  userContentChars: String(args.task ?? "").length,
  toolCount: 1,
  toolNames: ["web_search"],
  iterations: 1,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  maxIterations: 5,
  model: "mock",
  capabilities: [],
  terminalState: "completed",
  outcome: "success",
});
const runSubAgentWithStatsMock = vi.fn(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
  output: `${args.agentName}: three sources on the harbour at dusk, with their URLs.`,
  stats: statsFor(args),
}));

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: vi.fn(async (args: SubAgentRunOptions) => (await runSubAgentWithStatsMock(args)).output),
  runSubAgentWithStats: runSubAgentWithStatsMock,
}));

const GERMAN = "nicht den fast-tier … das result ist schlimmer als das original";

const freshSwarmState = (): SwarmState => ({
  objective: "test",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  tasks: {},
});

describe("the user's own words reach every delegated specialist", () => {
  let tempDir = "";
  let words: TurnUserWords;
  const ctx = (sessionId: string): ToolContext => ({
    sessionId,
    workspacePath: "/workspace",
    swarmState: freshSwarmState(),
    turnUserWords: words,
  });
  /** What each runner call received, in call order. */
  const received = () => runSubAgentWithStatsMock.mock.calls.map((call) => call[0]);

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-user-words-"));
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      subAgents: {
        researcher: { description: "Finds sources on the web.", systemPrompt: "Research.", tools: ["web_search", "web_fetch"], maxIterations: 4 },
        summarizer: { description: "Summarizes findings into a short brief.", systemPrompt: "Summarize.", tools: ["read_file"], maxIterations: 4 },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    runSubAgentWithStatsMock.mockClear();
    words = { opening: GERMAN, midTurn: [] };
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  const tools = async () => {
    const [{ getTool }] = await Promise.all([import("../tools/registry.js"), import("../tools/sub-agent.js")]);
    return getTool;
  };

  it("delegate_to_agent: forwards the words and leaves the task as the orchestrator wrote it", async () => {
    const getTool = await tools();
    const task = "Find three sources on the harbour at dusk.";
    const result = await getTool("delegate_to_agent")!.execute({ agentName: "researcher", task }, ctx("s-delegate"));

    expect(result.success).toBe(true);
    expect(received()).toHaveLength(1);
    expect(received()[0]!.turnUserWords).toBe(words);
    expect(received()[0]!.task).toBe(task);
  }, 30_000);

  it("swarm_delegate: forwards the words on the routed delegation", async () => {
    const getTool = await tools();
    const task = "Find three sources on the harbour at dusk.";
    // Threshold 0: take the best-matching configured agent rather than synthesising one, so the
    // routed path itself is what is observed.
    await getTool("swarm_delegate")!.execute({ task, skillMatchThreshold: 0 }, ctx("s-swarm"));

    expect(received()).toHaveLength(1);
    expect(["researcher", "summarizer"]).toContain(received()[0]!.agentName);
    expect(received()[0]!.turnUserWords).toBe(words);
    expect(received()[0]!.task).toBe(task);
  }, 30_000);

  it("parallel_delegate: every slice gets the words", async () => {
    const getTool = await tools();
    const tasks = [
      { agentName: "researcher", task: "Find sources on the harbour at dusk." },
      { agentName: "summarizer", task: "Summarize the lighting conditions at dusk." },
    ];
    await getTool("parallel_delegate")!.execute({ tasks }, ctx("s-parallel"));

    expect(received()).toHaveLength(2);
    for (const args of received()) expect(args.turnUserWords).toBe(words);
    expect(received().map((args) => args.task).sort()).toEqual(tasks.map((t) => t.task).sort());
  }, 30_000);

  it("run_task_graph: every node gets the words", async () => {
    const getTool = await tools();
    await getTool("run_task_graph")!.execute({
      objective: "Research then summarize",
      nodes: [
        { id: "research", agentName: "researcher", task: "Collect facts about the harbour at dusk" },
        { id: "summary", agentName: "summarizer", task: "Summarize the facts", dependsOn: ["research"] },
      ],
    }, ctx("s-graph"));

    expect(received()).toHaveLength(2);
    for (const args of received()) expect(args.turnUserWords).toBe(words);
  }, 30_000);

  it("execute_plan: a delegate step reaches the specialist with the words", async () => {
    // A plan step's task is built from the step description and plan.objective, both the
    // orchestrator's own paraphrase. That is exactly where "Qwen-Modell als Override" arrived
    // without the tier the user had asked for.
    const getTool = await tools();
    await import("../tools/plan-executor.js");
    const { persistTurnPlan } = await import("../agent/turn-plan.js");
    await persistTurnPlan("s-plan", {
      objective: "Render the harbour at dusk",
      steps: [{ id: "s1", description: "Generate the image", kind: "delegate", agent: "researcher" }],
      acceptanceCriteria: [],
      stopConditions: [],
      riskTier: "low",
      wide: false,
      createdAt: new Date(0).toISOString(),
    });
    const result = await getTool("execute_plan")!.execute({}, ctx("s-plan"));

    expect(result.success).toBe(true);
    expect(received()).toHaveLength(1);
    expect(received()[0]!.turnUserWords).toBe(words);
  }, 30_000);

  it("architect fallback: the synthesised specialist gets the words, the architect's spec call does not", async () => {
    // The architect only designs an agent from the task; the words are for whoever does the work.
    runSubAgentWithStatsMock.mockImplementationOnce(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
      output: JSON.stringify({
        agentName: "harbour_researcher",
        description: "Researches harbour lighting.",
        systemPrompt: "You are a researcher. Find sources and cite them.",
        tools: ["web_search", "web_fetch"],
        maxIterations: 4,
      }),
      stats: statsFor(args),
    }));
    const getTool = await tools();
    // Threshold 1: no configured agent can match, so the swarm falls back to the architect.
    await getTool("swarm_delegate")!.execute({ task: "Find sources on the harbour at dusk.", skillMatchThreshold: 1 }, ctx("s-architect"));

    const architect = received().filter((args) => args.agentName === "agent_architect");
    const ephemeral = received().filter((args) => args.agentName.startsWith("ephemeral:"));
    expect(architect).toHaveLength(1);
    expect(architect[0]!.turnUserWords).toBeUndefined();
    expect(ephemeral).toHaveLength(1);
    expect(ephemeral[0]!.turnUserWords).toBe(words);
  }, 30_000);

  it("create_ephemeral_agent: the stand-in specialist gets the words too", async () => {
    const getTool = await tools();
    await getTool("create_ephemeral_agent")!.execute({
      agentName: "harbour_researcher",
      description: "Researches harbour lighting.",
      systemPrompt: "You are a researcher. Find sources and cite them.",
      tools: ["web_search", "web_fetch"],
      task: "Find sources on the harbour at dusk.",
    }, ctx("s-ephemeral"));

    const ephemeral = received().filter((args) => args.agentName.startsWith("ephemeral:"));
    expect(ephemeral).toHaveLength(1);
    expect(ephemeral[0]!.turnUserWords).toBe(words);
  }, 30_000);

  // The ephemeral stand-ins also carry what their run RECORDED, as any specialist's delegation
  // does: without it their frame shows only the agent's own account (f4ebf47b's false engine claim).
  const RECORDED = {
    artifacts: [{ sourceTool: "generate_image", outputPath: "generated/harbour.png", tier: "fast", model: "image" }],
    toolFailures: [{ agent: "ephemeral:harbour_researcher", tool: "generate_image", error: "HTTP 404: no router" }],
    // And what it executed (E2E 2026-10-07: figures no tool returned, masked by the run).
    executions: { attempted: 2, failed: 1, succeededWithOutput: 0, unobservedFigures: 1 },
  };

  it("architect fallback: the delegation carries the run's files and failed calls", async () => {
    runSubAgentWithStatsMock
      .mockImplementationOnce(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
        output: JSON.stringify({
          agentName: "harbour_researcher",
          description: "Researches harbour lighting.",
          systemPrompt: "You are a researcher. Find sources and cite them.",
          tools: ["web_search", "web_fetch"],
          maxIterations: 4,
        }),
        stats: statsFor(args),
      }))
      .mockImplementationOnce(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
        output: "The harbour at dusk: generated/harbour.png",
        stats: statsFor(args),
        ...RECORDED,
      }));
    const getTool = await tools();
    const result = await getTool("swarm_delegate")!.execute({ task: "Draw the harbour at dusk.", skillMatchThreshold: 1 }, ctx("s-architect-record"));

    expect(result.metadata?.["specialistToolFailures"]).toEqual(RECORDED.toolFailures);
    expect(result.metadata?.["artifacts"]).toEqual(expect.arrayContaining([expect.objectContaining({ outputPath: "generated/harbour.png" })]));
    expect(result.metadata?.["specialistExecutions"]).toEqual(RECORDED.executions);
  }, 30_000);

  it("create_ephemeral_agent: the result carries the run's files and failed calls", async () => {
    runSubAgentWithStatsMock.mockImplementationOnce(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
      output: "The harbour at dusk: generated/harbour.png",
      stats: statsFor(args),
      ...RECORDED,
    }));
    const getTool = await tools();
    const result = await getTool("create_ephemeral_agent")!.execute({
      agentName: "harbour_researcher",
      description: "Researches harbour lighting.",
      systemPrompt: "You are a researcher. Find sources and cite them.",
      tools: ["web_search", "web_fetch"],
      task: "Find sources on the harbour at dusk.",
    }, ctx("s-ephemeral-record"));

    expect(result.metadata).toMatchObject({
      specialistToolFailures: RECORDED.toolFailures,
      artifacts: RECORDED.artifacts,
      specialistExecutions: RECORDED.executions,
    });
  }, 30_000);

  it("ask_user: the user's answer is recorded as their words; an unattended stand-in is not", async () => {
    const getTool = await tools();
    await import("../tools/ask-user.js");
    const { UNATTENDED_ANSWER } = await import("../tools/ask-user.js");
    const askUser = getTool("ask_user")!;

    await askUser.execute({ question: "Which tier should I use?" }, { ...ctx("s-ask"), inputCallback: async () => "quality, nimm das qwen model" });
    await askUser.execute({ question: "Anything else?" }, { ...ctx("s-ask"), inputCallback: async () => UNATTENDED_ANSWER });

    expect(words.midTurn).toHaveLength(1);
    expect(words.midTurn[0]).toContain("quality, nimm das qwen model");
    expect(words.midTurn[0]).toContain("Which tier should I use?");
  }, 30_000);

  it("ask_user: a long question keeps its END, where the options a short answer refers to are", async () => {
    const getTool = await tools();
    await import("../tools/ask-user.js");
    const question = "Der schnelle Tier hat die Komposition beim letzten Mal ignoriert, und der Qualitäts-Tier "
      + "braucht auf diesem Cluster etwa zwei bis drei Minuten pro Bild, während andere Modelle langsamer werden. "
      + "Soll ich (1) warten oder (2) den schnellen Tier nehmen?";
    expect(question.length).toBeGreaterThan(160);

    await getTool("ask_user")!.execute({ question }, { ...ctx("s-ask-long"), inputCallback: async () => "1" });

    expect(words.midTurn.at(-1)).toContain("(1) warten oder (2) den schnellen Tier nehmen?");
    expect(words.midTurn.at(-1)).toMatch(/\) 1$/);
  }, 30_000);
});
