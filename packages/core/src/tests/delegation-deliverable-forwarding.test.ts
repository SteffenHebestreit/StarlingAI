import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwarmState, ToolContext } from "../tools/registry.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";
import { STAGED_BUILD_TASK_CHAR_THRESHOLD, isStagedArtifactBuildRun } from "../agent/sub-agent-prompt-guidance.js";
import { loadWorkspaceAgents } from "./support/workspace-shards.js";

/**
 * THE DECLARED DELIVERABLE REACHES THE RUN.
 *
 * A delegation declares what it hands back ("file" or "answer"), and the delegation gates read that
 * declaration. The runner did not receive it, so a run declared "answer" was still classified as a
 * staged build by its task size and tools alone (agent/sub-agent.ts stagedBuildCandidate). In the E2E
 * fan-out new-delegation-routing-bounded-fanout (session 62b04e8b) that sent two browser_agent lookups
 * into the skeleton directive for 329 s and 612 s. These call each entry tool with a declaration and
 * read what the runner received; staged-artifact-build.test.ts proves what the runner does with it.
 */
const statsFor = (args: SubAgentRunOptions): SubAgentRunResult["stats"] => ({
  agentName: args.agentName,
  sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
  promptChars: 0,
  userContentChars: String(args.task ?? "").length,
  toolCount: 1,
  toolNames: ["browser_navigate"],
  iterations: 1,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  maxIterations: 5,
  model: "mock",
  capabilities: [],
  terminalState: "completed",
  outcome: "success",
});
const runSubAgentWithStatsMock = vi.fn(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
  output: `${args.agentName}: the page lists NW-1203 at 0 units in all three warehouses.`,
  stats: statsFor(args),
}));

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: vi.fn(async (args: SubAgentRunOptions) => (await runSubAgentWithStatsMock(args)).output),
  runSubAgentWithStats: runSubAgentWithStatsMock,
}));

/** browser_agent as the workspace ships it: it holds write_file and edit_file beside its browser tools. */
const BROWSER_AGENT_TOOLS = loadWorkspaceAgents<{ tools?: string[] }>()["browser_agent"]?.tools ?? [];

const freshSwarmState = (): SwarmState => ({
  objective: "test",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  tasks: {},
});

describe("the declared deliverable reaches the sub-agent run", () => {
  let tempDir = "";
  const ctx = (sessionId: string): ToolContext => ({
    sessionId,
    workspacePath: "/workspace",
    swarmState: freshSwarmState(),
  });
  /** What each runner call received, in call order. */
  const received = () => runSubAgentWithStatsMock.mock.calls.map((call) => call[0]);

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-deliverable-forwarding-"));
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      subAgents: {
        browser_agent: { description: "Navigates web pages and reads what they show.", systemPrompt: "Browse.", tools: BROWSER_AGENT_TOOLS, maxIterations: 4 },
        summarizer: { description: "Summarizes findings into a short brief.", systemPrompt: "Summarize.", tools: ["read_file"], maxIterations: 4 },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    runSubAgentWithStatsMock.mockClear();
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

  it("delegate_to_agent: a declaration reaches the run, and an undeclared delegation passes none", async () => {
    const getTool = await tools();
    const task = "Read /lager.html on http://www.nordlicht-werkzeuge.test/ and list every article below its minimum stock.";
    await getTool("delegate_to_agent")!.execute({ agentName: "browser_agent", task, deliverable: "answer" }, ctx("s-delegate-answer"));
    await getTool("delegate_to_agent")!.execute({ agentName: "browser_agent", task: `${task} Include the warehouse totals.` }, ctx("s-delegate-undeclared"));

    expect(received()).toHaveLength(2);
    expect(received()[0]!.deliverable).toBe("answer");
    expect("deliverable" in received()[1]!).toBe(false);
  }, 30_000);

  it("parallel_delegate: each slice's own declaration reaches its run", async () => {
    const getTool = await tools();
    const tasks = [
      { agentName: "browser_agent", task: "Read the price of NW-3102 on /preise.html.", deliverable: "answer" },
      { agentName: "summarizer", task: "Write the stock overview to reports/lager.md.", deliverable: "file" },
    ];
    await getTool("parallel_delegate")!.execute({ tasks }, ctx("s-parallel"));

    expect(received()).toHaveLength(2);
    const byAgent = new Map(received().map((args) => [args.agentName, args.deliverable]));
    expect(byAgent.get("browser_agent")).toBe("answer");
    expect(byAgent.get("summarizer")).toBe("file");
  }, 30_000);

  it("execute_plan: three parallel lookup steps declared \"answer\" each reach browser_agent with it, all at once", async () => {
    // Session 62b04e8b's plan: three short lookups in one parallelGroup. buildStepTask adds the turn's
    // objective and criteria to every step, which carries each task past the staged-build threshold,
    // so only the declaration keeps browser_agent off the skeleton directive.
    const STEPS = 3;
    let started = 0;
    let releaseAll: () => void = () => undefined;
    const allStarted = new Promise<void>((resolve) => { releaseAll = resolve; });
    /** How many runs had started when each run resolved: three each time, or they ran in sequence. */
    const startedAtResolve: number[] = [];
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      started += 1;
      if (started === STEPS) releaseAll();
      // Bounded, so a serial dispatch fails the assertion below instead of hanging the test.
      await Promise.race([allStarted, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      startedAtResolve.push(started);
      return { output: `${args.agentName}: found it on the page.`, stats: statsFor(args) };
    });
    const getTool = await tools();
    await import("../tools/plan-executor.js");
    const { persistTurnPlan } = await import("../agent/turn-plan.js");
    await persistTurnPlan("s-plan", {
      objective: "Für einen Lagerbericht der Nordlicht Werkzeuge GmbH (http://www.nordlicht-werkzeuge.test/) drei unabhängige Teilergebnisse ermitteln und danach in einer kurzen Übersicht zusammenfassen.",
      steps: [
        { id: "s1", description: "Auf /lager.html alle Artikel unter Mindestbestand ermitteln und ihren Gesamtbestand über alle Lager nennen", kind: "delegate", agent: "browser_agent", parallelGroup: 1, deliverable: "answer" },
        { id: "s2", description: "Preis für 30 Stück NW-3102 inklusive Mengenrabatt und Versand aus /preise.html und dem Produktkatalog ermitteln", kind: "delegate", agent: "browser_agent", parallelGroup: 1, deliverable: "answer" },
        { id: "s3", description: "Bedeutung von Fehlercode E22 laut /dokumentation.html ermitteln und wörtlich wiedergeben", kind: "delegate", agent: "browser_agent", parallelGroup: 1, deliverable: "answer" },
      ],
      acceptanceCriteria: [
        "Alle Artikel unter Mindestbestand mit ihrem Gesamtbestand genannt",
        "Preis für 30 Stück NW-3102 mit Mengenrabatt und Versand berechnet",
        "Bedeutung von Fehlercode E22 aus der Dokumentation wiedergegeben",
        "die drei Ergebnisse in einer kurzen Übersicht zusammengefasst",
      ],
      stopConditions: [],
      riskTier: "low",
      wide: false,
      createdAt: new Date(0).toISOString(),
    });
    const result = await getTool("execute_plan")!.execute({}, ctx("s-plan"));

    expect(result.success).toBe(true);
    expect(received()).toHaveLength(STEPS);
    for (const args of received()) {
      expect(args.agentName).toBe("browser_agent");
      expect(args.deliverable).toBe("answer");
      // Without the declaration, size and tools alone stage this run.
      expect(args.task.length).toBeGreaterThan(STAGED_BUILD_TASK_CHAR_THRESHOLD);
      expect(isStagedArtifactBuildRun(BROWSER_AGENT_TOOLS, args.task)).toBe(true);
    }
    expect(startedAtResolve).toEqual([STEPS, STEPS, STEPS]);
  }, 30_000);
});
