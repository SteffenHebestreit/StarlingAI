import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwarmState } from "../tools/registry.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

// Control each delegated attempt's output + stats. The default impl returns a
// generic success for any agent; tests that need a specific shape override via
// mockImplementation, and beforeEach re-installs this default so impls never leak.
const runSubAgentMock = vi.fn(async ({ agentName, task }: SubAgentRunOptions) => `${agentName}:${task}`);
const defaultStatsImpl = async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
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
    outcome: "success" as const,
  },
});
const runSubAgentWithStatsMock = vi.fn(defaultStatsImpl);

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

// A substantive research body: a timed-out/failure-classified attempt that still
// gathered real evidence (the keystone of audit 687a224b: source_verifier
// returned ~3789 chars + 20 shared facts, yet the bidding chain walked on to
// evidence_analyst → mission_coordinator → a 61-min coordinator recursion).
const RESEARCH_BODY =
  "Verified findings on the IM73A135V01: it is an Infineon ANALOG differential XENSIV MEMS microphone, " +
  "NOT a digital I2S part. Datasheet SNR is 73 dB(A) @ 2.75 V, AOP 135 dBSPL, package 4.00 x 3.00 x 1.20 mm, " +
  "IP57 dust/water resistant. For an ESP32 I2S array it requires an external ADC or a digital I2S/TDM mic " +
  "(e.g. ICS-43434 / SPH0645). Sources: infineon.com product brief + datasheet (alldatasheet, datasheet4u).";

describe("delegation halts escalation once a substantive partial exists", () => {
  beforeEach(() => {
    runSubAgentMock.mockClear();
    runSubAgentWithStatsMock.mockReset();
    runSubAgentWithStatsMock.mockImplementation(defaultStatsImpl);
    vi.resetModules();
  });

  afterEach(async () => {
    const { resetConfigForTests } = await import("../config/loader.js");
    resetConfigForTests();
    const memory = await import("../swarm/memory.js");
    await memory.resetSharedMemoryForTests();
  });

  it("returns a research agent's substantive partial instead of escalating to the coordinator fallback", async () => {
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      if (args.agentName === "researcher") {
        // Failure-classified (outcome failure + terminalState timeout) but carries
        // real gathered evidence — exactly what a capped/timed-out research run leaves.
        return {
          output: RESEARCH_BODY,
          stats: {
            agentName: args.agentName,
            sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
            promptChars: 0,
            userContentChars: String(args.task ?? "").length,
            toolCount: 6,
            toolNames: ["web_search", "web_fetch"],
            iterations: 4,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            maxIterations: 5,
            model: "mock",
            capabilities: [],
            terminalState: "timeout",
            outcome: "failure",
          },
        };
      }
      // The coordinator fallback must NEVER run — that's the 687a224b cascade.
      return {
        output: "mission_coordinator: re-decomposed and re-delegated (should not happen)",
        stats: {
          agentName: args.agentName,
          sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
          promptChars: 0,
          userContentChars: 0,
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

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);
    const delegate = getTool("delegate_to_agent");

    const result = await delegate!.execute(
      { agentName: "researcher", fallbackAgents: ["mission_coordinator"], task: "Research the IM73A135V01 mic for an ESP32 build" },
      { sessionId: "session-partial-halt", workspacePath: "/workspace", swarmState: freshSwarmState() },
    );

    const calledAgents = runSubAgentWithStatsMock.mock.calls.map((call) => call[0].agentName);
    expect(calledAgents).toEqual(["researcher"]);
    expect(calledAgents).not.toContain("mission_coordinator");
    expect(result.success).toBe(true);
    expect(result.output).toContain("ANALOG differential");
    expect(result.metadata?.["delegationOutcome"]).toBe("partial");
    expect(result.metadata?.["partialFallback"]).toBe(true);
  }, 30_000);

  it("still escalates past a short failure stub that carries no usable evidence", async () => {
    runSubAgentWithStatsMock.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
      if (args.agentName === "researcher") {
        return {
          output: "Error: failed to complete the lookup.",
          stats: {
            agentName: args.agentName,
            sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
            promptChars: 0,
            userContentChars: 0,
            toolCount: 0,
            toolNames: [],
            iterations: 0,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            maxIterations: 5,
            model: "mock",
            capabilities: [],
            terminalState: "error",
            outcome: "failure",
          },
        };
      }
      return {
        output: `${args.agentName}: real answer with the figures the user asked for, well over two hundred characters so it is clearly a usable result and not a stub — covering the topic thoroughly enough to satisfy the request.`,
        stats: {
          agentName: args.agentName,
          sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
          promptChars: 0,
          userContentChars: 0,
          toolCount: 2,
          toolNames: ["web_search", "web_fetch"],
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

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);
    const delegate = getTool("delegate_to_agent");

    const result = await delegate!.execute(
      { agentName: "researcher", fallbackAgents: ["retrieval_analyst"], task: "Find the figures" },
      { sessionId: "session-stub-escalates", workspacePath: "/workspace", swarmState: freshSwarmState() },
    );

    // A bare error stub (<200 chars) is not a substantive partial, so the chain
    // still falls through to the alternative agent.
    const calledAgents = runSubAgentWithStatsMock.mock.calls.map((call) => call[0].agentName);
    expect(calledAgents).toEqual(["researcher", "retrieval_analyst"]);
    expect(result.success).toBe(true);
    expect(result.output).toContain("retrieval_analyst");
  }, 30_000);

  it("a coordinator caller does not delegate to another coordinator", async () => {
    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);
    const delegate = getTool("delegate_to_agent");

    const result = await delegate!.execute(
      { agentName: "web_task_coordinator", task: "coordinate some sub-work" },
      {
        sessionId: "sub:root:mission_coordinator:1",
        workspacePath: "/workspace",
        swarmState: freshSwarmState(),
        currentAgentName: "mission_coordinator",
      },
    );

    // The coordinator→coordinator hop is blocked, so no coordinator sub-agent runs.
    const calledAgents = runSubAgentWithStatsMock.mock.calls.map((call) => call[0].agentName);
    expect(calledAgents).not.toContain("web_task_coordinator");
    expect(result.success).toBe(false);
  }, 30_000);
});
