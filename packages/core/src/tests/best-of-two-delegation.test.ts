import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwarmState, ToolContext } from "../tools/registry.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

/**
 * Where best of two applies: the orchestrator's delegation that asks for a file, at the "max" effort
 * tier, with orchestration.bestOfTwoDeliverables on. Everything else runs once.
 */
const runSubAgentWithStatsMock = vi.fn(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
  output: `${args.agentName}: wrote the brief.`,
  stats: {
    agentName: args.agentName, sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`, promptChars: 0, userContentChars: 0,
    toolCount: 1, toolNames: ["write_file"], iterations: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    maxIterations: 5, model: "mock", capabilities: [], terminalState: "completed", outcome: "success",
  },
}));
vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: vi.fn(async (args: SubAgentRunOptions) => (await runSubAgentWithStatsMock(args)).output),
  runSubAgentWithStats: runSubAgentWithStatsMock,
}));
// The selector's model: it prefers the first result shown, so it never agrees with itself here.
vi.mock("../agent/routing-tier-provider.js", () => ({
  resolveRoutingTierProvider: () => ({ complete: async () => ({ content: "1", tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" }) }),
  routingTierModelId: () => "mock",
}));

const freshSwarmState = (): SwarmState => ({ objective: "test", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: {} });

describe("best of two on a delegation", () => {
  let tempDir = "";
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ sessionId: "s-bo2", workspacePath: tempDir, swarmState: freshSwarmState(), ...over });

  const setup = async (bestOfTwoDeliverables: boolean) => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-bo2-delegation-"));
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      orchestration: { bestOfTwoDeliverables },
      subAgents: { content_writer: { description: "Writes documents and reports.", systemPrompt: "Write.", tools: ["write_file"], maxIterations: 4 } },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    runSubAgentWithStatsMock.mockClear();
    const [{ getTool }, { runWithEffortContext }] = await Promise.all([import("../tools/registry.js"), import("../runtime/effort-context.js"), import("../tools/sub-agent.js")]);
    const delegate = (tier: "max" | "high", args: Record<string, unknown>, context = ctx()) =>
      runWithEffortContext(tier, () => getTool("delegate_to_agent")!.execute({ agentName: "content_writer", ...args }, context));
    return delegate;
  };

  beforeEach(() => { tempDir = ""; });
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("runs twice for a file at max effort, and once otherwise", async () => {
    const delegate = await setup(true);
    // The first run takes a moment, as a real one does.
    const instant = runSubAgentWithStatsMock.getMockImplementation()!;
    runSubAgentWithStatsMock.mockImplementationOnce(async (args) => { await new Promise((r) => setTimeout(r, 30)); return instant(args); });
    await delegate("max", { task: "Write the quarterly brief for the Talgrund mill as a PDF.", deliverable: "file" });
    expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(2);
    // The second run's wrap-up nudge is its own, never the first run's passed moment.
    const [first, second] = runSubAgentWithStatsMock.mock.calls.map((call) => call[0] as SubAgentRunOptions & { softDeadlineMs?: number });
    expect(second!.softDeadlineMs!).toBeGreaterThan(first!.softDeadlineMs!);

    runSubAgentWithStatsMock.mockClear();
    await delegate("high", { task: "Write the quarterly brief for the Talgrund mill as a PDF.", deliverable: "file" });
    await delegate("max", { task: "How many sites does the Talgrund mill run?", deliverable: "answer" });
    // A coordinator's own delegation inside a run is never doubled.
    await delegate("max", { task: "Write the brief as a PDF.", deliverable: "file" }, ctx({ currentAgentName: "project_manager" }));
    expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(3);
  }, 30_000);

  it("runs once while the switch is off", async () => {
    const delegate = await setup(false);
    await delegate("max", { task: "Write the quarterly brief for the Talgrund mill as a PDF.", deliverable: "file" });
    expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);
  }, 30_000);
});
