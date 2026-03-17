import { afterEach, describe, expect, it, vi } from "vitest";

const runSubAgentMock = vi.fn(async () => "delegated");

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: runSubAgentMock,
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
        humanInLoopSteps: ["get_site_credentials", "mcp__playwright__browser_navigate"],
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
      humanInLoopSteps: ["get_site_credentials", "mcp__playwright__browser_navigate"],
    }));
  });
});