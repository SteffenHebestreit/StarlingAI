import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwarmState } from "../tools/registry.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

// Mock the sub-agent runtime so we control each delegated attempt's output and
// stats without spinning real agents.
const runSubAgentMock = vi.fn(async ({ agentName, task }: SubAgentRunOptions) => `${agentName}:${task}`);
const runSubAgentWithStatsMock = vi.fn(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
  output: await runSubAgentMock(args),
  stats: {
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
    terminalState: "completed" as const,
  },
}));

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: runSubAgentMock,
  runSubAgentWithStats: runSubAgentWithStatsMock,
}));

const freshSwarmState = (): SwarmState => ({
  objective: "test",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  tasks: {},
});

// A substantial, source-grounded research body that the classifier treats as a
// real (non-stub) failure when terminalState=timeout/outcome=failure — exactly
// the shape a researcher leaves behind when an operator Stop cuts off its
// synthesis. It must be preserved, not discarded.
const RESEARCH_BODY =
  "Verified findings: the IM73A135V01 is an Infineon ANALOG MEMS microphone (LGA package), " +
  "NOT a digital I2S part. Datasheet SNR is 73 dB(A). For an ESP32 I2S capture chain it requires " +
  "an external ADC or a PDM/I2S codec. Sources: infineon.com product brief, alldatasheet.com listing. " +
  "An array of analog mics also needs matched bias and an analog front end before the ADC.";

describe("operator-stop halts delegation escalation and preserves evidence", () => {
  beforeEach(() => {
    runSubAgentMock.mockClear();
    runSubAgentWithStatsMock.mockClear();
    vi.resetModules();
  });

  afterEach(async () => {
    const { resetConfigForTests } = await import("../config/loader.js");
    resetConfigForTests();
    const memory = await import("../swarm/memory.js");
    await memory.resetSharedMemoryForTests();
  });

  it("short-circuits a NEW delegation when the operator already stopped the turn", async () => {
    const [{ getTool }, { longRunningGenerationManager }] = await Promise.all([
      import("../tools/registry.js"),
      import("../agent/long-running-generation.js"),
    ]);
    await import("../tools/sub-agent.js");
    longRunningGenerationManager.resetForTests();

    // Latch a stop for the turn (root session) the way the operator dock does.
    const wait = longRunningGenerationManager.requestContinuation({
      agentName: "researcher",
      runSessionId: "session-stop-new",
      reason: "running long",
      elapsedMs: 1,
      completionTokens: 1,
      iterations: 1,
      waitTimeoutMs: 60_000,
    });
    const pending = longRunningGenerationManager.listPending();
    longRunningGenerationManager.resolveRequest(pending[0]!.id, "stop", "admin");
    await wait;
    expect(longRunningGenerationManager.isStopRequested("session-stop-new")).toBe(true);

    const delegate = getTool("delegate_to_agent");
    const result = await delegate!.execute(
      { agentName: "researcher", fallbackAgents: ["mission_coordinator"], task: "Research the IM73A135V01 mic" },
      { sessionId: "session-stop-new", workspacePath: "/workspace", swarmState: freshSwarmState() },
    );

    // No sub-agent should be spawned at all — the orchestrator is told to synthesize.
    expect(runSubAgentWithStatsMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.metadata?.["operatorStopped"]).toBe(true);
    expect(result.error ?? "").toMatch(/Operator stopped this turn/i);
    expect(result.error ?? "").toMatch(/do NOT delegate again/i);

    longRunningGenerationManager.resetForTests();
  }, 30_000);

  it("does not escalate to the fallback agent when the operator stops mid-run, and returns the partial evidence", async () => {
    const [{ getTool }, { longRunningGenerationManager }] = await Promise.all([
      import("../tools/registry.js"),
      import("../agent/long-running-generation.js"),
    ]);
    await import("../tools/sub-agent.js");
    longRunningGenerationManager.resetForTests();

    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      if (args.agentName === "researcher") {
        // Simulate the operator clicking Stop while this researcher is running:
        // its synthesis is cut off, so it returns a timeout/failure result that
        // still carries the real findings it gathered.
        const w = longRunningGenerationManager.requestContinuation({
          agentName: "researcher",
          runSessionId: "session-stop-mid",
          reason: "running long",
          elapsedMs: 1,
          completionTokens: 1,
          iterations: 1,
          waitTimeoutMs: 60_000,
        });
        const p = longRunningGenerationManager.listPending().find((r) => r.runSessionId === "session-stop-mid");
        longRunningGenerationManager.resolveRequest(p!.id, "stop", "admin");
        await w;
        return {
          output: RESEARCH_BODY,
          stats: {
            agentName: args.agentName,
            sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
            promptChars: 0,
            userContentChars: String(args.task ?? "").length,
            toolCount: 5,
            toolNames: ["web_search", "web_fetch"],
            iterations: 3,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            maxIterations: 5,
            model: "mock",
            capabilities: [],
            terminalState: "timeout",
            outcome: "failure",
          },
        };
      }
      // The fallback coordinator must NEVER run after a stop.
      return {
        output: "mission_coordinator: re-decomposed and re-delegated (should not happen)",
        stats: {
          agentName: args.agentName,
          sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
          promptChars: 0,
          userContentChars: String(args.task ?? "").length,
          toolCount: 1,
          toolNames: ["parallel_delegate"],
          iterations: 1,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          maxIterations: 5,
          model: "mock",
          capabilities: [],
          terminalState: "completed",
          outcome: "success",
        },
      };
    });

    const delegate = getTool("delegate_to_agent");
    const result = await delegate!.execute(
      { agentName: "researcher", fallbackAgents: ["mission_coordinator"], task: "Research the IM73A135V01 mic" },
      { sessionId: "session-stop-mid", workspacePath: "/workspace", swarmState: freshSwarmState() },
    );

    // Only the researcher ran; the coordinator fallback was never escalated to.
    const calledAgents = runSubAgentWithStatsMock.mock.calls.map((call) => call[0].agentName);
    expect(calledAgents).toEqual(["researcher"]);
    expect(calledAgents).not.toContain("mission_coordinator");

    // The researcher's real evidence is surfaced (not discarded as "no agent completed").
    expect(result.success).toBe(true);
    expect(result.output).toContain("IM73A135V01");
    expect(result.output).toContain("ANALOG MEMS");
    expect(result.metadata?.["delegationOutcome"]).toBe("partial");

    longRunningGenerationManager.resetForTests();
  }, 30_000);
});
