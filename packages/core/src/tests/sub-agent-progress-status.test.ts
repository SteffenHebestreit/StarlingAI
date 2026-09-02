import { describe, expect, it } from "vitest";
import { subAgentProgressStatus } from "../gateway/sub-agent-progress-status.js";

describe("sub-agent lifecycle → dashboard status", () => {
  it("turns started and completed into a delegating status line", () => {
    expect(subAgentProgressStatus({ kind: "started", agentName: "researcher", iteration: 0, summary: "Researcher started on the task." }))
      .toEqual({ phase: "delegating", message: "Researcher started on the task.", iteration: 0 });
    expect(subAgentProgressStatus({ kind: "completed", agentName: "researcher", iteration: 3 })?.message).toBe("researcher finished");
  });

  it("stays quiet for the per-iteration and per-tool events, which have their own lanes", () => {
    for (const kind of ["thinking", "tool_start", "tool_done", "reasoning"] as const) {
      expect(subAgentProgressStatus({ kind, agentName: "researcher", iteration: 1 })).toBeNull();
    }
  });
});
