import { describe, expect, it } from "vitest";
import { buildGatewayMessage, statsFromTurnPerformance } from "../agent/gateway-eval-runner.js";

describe("gateway eval runner — pure helpers", () => {
  it("appends the --agent override to force delegation to the target agent", () => {
    expect(buildGatewayMessage({ task: "Write a doc", agentName: "content_writer" }))
      .toBe("Write a doc --agent content_writer");
  });

  it("folds context in before the task and still appends --agent", () => {
    const msg = buildGatewayMessage({ task: "Review it", context: "diff here", agentName: "diff_reviewer" });
    expect(msg).toContain("Context:\ndiff here");
    expect(msg).toContain("Task: Review it");
    expect(msg.endsWith("--agent diff_reviewer")).toBe(true);
  });

  it("maps turn_performance into valid stats (tokens + iterations) on success", () => {
    const stats = statsFromTurnPerformance("researcher", "sess-1", 42,
      { toolIterations: 5, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } }, "ok");
    expect(stats.agentName).toBe("researcher");
    expect(stats.sessionId).toBe("sess-1");
    expect(stats.userContentChars).toBe(42);
    expect(stats.iterations).toBe(5);
    expect(stats.usage.totalTokens).toBe(150);
    expect(stats.terminalState).toBe("completed");
  });

  it("produces zeroed-but-valid stats when no turn_performance arrived, and error terminalState on failure", () => {
    const stats = statsFromTurnPerformance("coder", "sess-2", 10, undefined, "error");
    expect(stats.iterations).toBe(0);
    expect(stats.usage.totalTokens).toBe(0);
    expect(stats.terminalState).toBe("error");
    // Shape stays valid for the regression comparison (no undefined usage).
    expect(typeof stats.usage.promptTokens).toBe("number");
  });
});

describe("gateway eval runner — pinned vs composed arm", () => {
  it("omitting the arm is byte-identical to the pinned behavior", () => {
    const withoutArm = buildGatewayMessage({ task: "Write a doc", agentName: "content_writer" });
    const explicitPinned = buildGatewayMessage({ task: "Write a doc", agentName: "content_writer", _evalArm: "pinned" });
    expect(withoutArm).toBe("Write a doc --agent content_writer");
    expect(explicitPinned).toBe(withoutArm);
  });

  it("the composed arm drops --agent so live routing picks the agents", () => {
    const msg = buildGatewayMessage({ task: "Write a doc", agentName: "content_writer", _evalArm: "composed" });
    expect(msg).toBe("Write a doc");
    expect(msg).not.toContain("--agent");
  });

  it("composed still folds context in, it only drops the override", () => {
    const msg = buildGatewayMessage({
      task: "Review it", context: "diff here", agentName: "diff_reviewer", _evalArm: "composed",
    });
    expect(msg).toContain("Context:\ndiff here");
    expect(msg).toContain("Task: Review it");
    expect(msg).not.toContain("--agent");
  });
});
