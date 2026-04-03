import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

const runSubAgentMock = vi.fn(async (_args: SubAgentRunOptions) => "delegated");

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: runSubAgentMock,
  runSubAgentWithStats: vi.fn(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
    output: await runSubAgentMock(args),
    stats: {
      agentName: args.agentName,
      sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
      promptChars: 0,
      userContentChars: String(args.task ?? "").length,
      toolCount: 0,
      toolNames: [],
      iterations: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      maxIterations: 5,
      model: "mock",
      capabilities: [],
    },
  })),
}));

describe("delegate_to_agent approval propagation", () => {
  afterEach(async () => {
    runSubAgentMock.mockClear();
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("passes approval settings from the parent tool context to sub-agents", async () => {
    const [{ getTool }, _subAgentTools] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const delegate = getTool("delegate_to_agent");
    expect(delegate).toBeDefined();

    const approvalCallback = vi.fn(async () => true);
    const result = await delegate!.execute(
      {
        agentName: "browser_agent",
        task: "Pruefe n8n auf neue Projekte.",
      },
      {
        sessionId: "session-1",
        workspacePath: "/workspace",
        approvalCallback,
        humanInLoopSteps: ["site_fill_credentials", "mcp__playwright__browser_navigate"],
      },
    );

    expect(result.success).toBe(true);
    expect(runSubAgentMock).toHaveBeenCalledTimes(1);
    expect(runSubAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "browser_agent",
      parentSessionId: "session-1",
      workspacePath: "/workspace",
      signal: undefined,
      approvalCallback,
      humanInLoopSteps: ["site_fill_credentials", "mcp__playwright__browser_navigate"],
    }));
  });
});