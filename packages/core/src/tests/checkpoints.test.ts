import { describe, expect, it } from "vitest";
import {
  createCheckpoint,
  pauseCheckpoint,
  resumeCheckpoint,
  completeCheckpoint,
  listCheckpoints,
  buildResumeContext,
  loadCheckpointsFromDisk,
} from "../swarm/checkpoints.js";

// In-memory task-checkpoint lifecycle (disk persistence fails gracefully, so this is safe to drive).
describe("swarm task checkpoints", () => {
  it("drives a checkpoint create → pause → resume → complete", () => {
    const cp = createCheckpoint({ agentName: "researcher", parentSessionId: "sess-cp", task: "deep research" });
    expect(cp.status).toBe("active");
    expect(listCheckpoints({ status: "active" }).some((c) => c.taskId === cp.taskId)).toBe(true);
    expect(listCheckpoints({ agentName: "researcher" }).some((c) => c.taskId === cp.taskId)).toBe(true);
    expect(listCheckpoints({ agentName: "nobody" }).some((c) => c.taskId === cp.taskId)).toBe(false);

    const paused = pauseCheckpoint(cp.taskId, {
      progressNote: "found 3 sources",
      conversationSummary: "gathered evidence on the topic",
      elapsedMs: 42_000,
      iterationsCompleted: 2,
      agentState: { step: "verify" },
    });
    expect(paused?.status).toBe("paused");

    const ctx = buildResumeContext(paused!);
    expect(ctx).toContain(cp.taskId);
    expect(ctx).toContain("found 3 sources");
    expect(ctx).toContain("Continue from where you left off");

    const resumed = resumeCheckpoint(cp.taskId);
    expect(resumed?.status).toBe("resumed");

    expect(completeCheckpoint(cp.taskId)).toBe(true);
    expect(listCheckpoints({ status: "completed" }).some((c) => c.taskId === cp.taskId)).toBe(true);
  });

  it("guards invalid transitions and unknown ids", () => {
    expect(pauseCheckpoint("unknown-id", { progressNote: "", conversationSummary: "", elapsedMs: 0, iterationsCompleted: 0 })).toBeNull();
    expect(resumeCheckpoint("unknown-id")).toBeNull();
    expect(completeCheckpoint("unknown-id")).toBe(false);

    // Resuming an active (not paused) checkpoint returns null.
    const cp = createCheckpoint({ agentName: "coder", parentSessionId: "sess-cp2", task: "build" });
    expect(resumeCheckpoint(cp.taskId)).toBeNull();
    expect(Array.isArray(listCheckpoints())).toBe(true);
  });

  it("loadCheckpointsFromDisk is a safe no-op when the directory is absent", () => {
    expect(() => loadCheckpointsFromDisk("/nonexistent-workspace-xyz-123")).not.toThrow();
  });
});
