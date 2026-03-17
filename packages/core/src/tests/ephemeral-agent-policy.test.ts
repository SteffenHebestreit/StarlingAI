import { afterEach, describe, expect, it, vi } from "vitest";

describe("create_ephemeral_agent policy", () => {
  afterEach(async () => {
    vi.resetModules();
  });

  it("rejects mixed execution families for ephemeral agents", async () => {
    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const createEphemeralAgent = getTool("create_ephemeral_agent");
    expect(createEphemeralAgent).toBeTruthy();

    const result = await createEphemeralAgent!.execute({
      agentName: "mixed_operator",
      systemPrompt: "You are a mixed operator. RULES: use tools carefully and stop when complete.",
      tools: ["shell_exec", "mcp__playwright__browser_navigate"],
      task: "Do multiple privileged things",
    }, {
      sessionId: "test-session",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("cannot mix multiple execution families");
  }, 15000);

  it("rejects overly broad ephemeral coordinators", async () => {
    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    const createEphemeralAgent = getTool("create_ephemeral_agent");
    expect(createEphemeralAgent).toBeTruthy();

    const result = await createEphemeralAgent!.execute({
      agentName: "broad_coordinator",
      systemPrompt: "You are a coordinator. RULES: coordinate and stop.",
      tools: ["parallel_delegate", "shell_exec", "read_file"],
      task: "Coordinate and execute",
    }, {
      sessionId: "test-session",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("parallel_delegate");
  }, 15000);
});