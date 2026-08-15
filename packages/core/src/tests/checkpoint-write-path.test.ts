import { describe, it, expect } from "vitest";
import {
  createCheckpoint,
  pauseCheckpoint,
  resumeCheckpoint,
  completeCheckpoint,
  listCheckpoints,
  buildResumeContext,
} from "../swarm/checkpoints.js";

/**
 * The checkpoint system had a complete READ side — resume-context building, gateway
 * routes, a dashboard — and no writer: nothing in the codebase ever called
 * createCheckpoint, so a run that died with partial work simply vanished and none of
 * that machinery could ever fire.
 *
 * sub-agent.ts now opens a checkpoint when a run starts and closes it at the single
 * choke point every terminal outcome flows through: completed runs are completed,
 * everything else is PAUSED with what it produced. These assertions exercise that
 * exact sequence with the exact field shapes the writer uses.
 */
describe("checkpoint write path", () => {
  it("round-trips create → pause → resume → complete", () => {
    const cp = createCheckpoint({
      agentName: "content_writer",
      parentSessionId: "sess-1",
      task: "Draft the Q3 report",
    });
    expect(cp.status).toBe("active");

    const paused = pauseCheckpoint(cp.taskId, {
      progressNote: "Ended as timeout after 4 iteration(s). Tools used: read_file, list_files.",
      conversationSummary: "Gathered the budget rows and drafted two sections.",
      elapsedMs: 350_309,
      iterationsCompleted: 4,
    });
    expect(paused?.status).toBe("paused");
    expect(paused?.iterationsCompleted).toBe(4);

    expect(listCheckpoints({ status: "paused" }).some((c) => c.taskId === cp.taskId)).toBe(true);

    expect(resumeCheckpoint(cp.taskId)?.status).toBe("resumed");
    expect(completeCheckpoint(cp.taskId)).toBe(true);
  });

  it("builds a resume context carrying the work that was done", () => {
    const cp = createCheckpoint({
      agentName: "researcher",
      parentSessionId: "sess-2",
      task: "Compare three storage backends",
    });
    pauseCheckpoint(cp.taskId, {
      progressNote: "Ended as max_iterations after 6 iteration(s).",
      conversationSummary: "Benchmarked two of the three; the third is outstanding.",
      elapsedMs: 120_000,
      iterationsCompleted: 6,
    });

    const ctx = buildResumeContext(listCheckpoints({ status: "paused" }).find((c) => c.taskId === cp.taskId)!);
    // A resume context that omits the original task or the progress made is useless —
    // the resuming agent would restart from nothing.
    expect(ctx).toContain("Compare three storage backends");
    expect(ctx).toContain("outstanding");
    expect(ctx).toContain("6");
    completeCheckpoint(cp.taskId);
  });

  it("refuses to pause an unknown task rather than inventing one", () => {
    expect(pauseCheckpoint("no-such-task", {
      progressNote: "x", conversationSummary: "y", elapsedMs: 1, iterationsCompleted: 1,
    })).toBeNull();
  });

  it("refuses to pause a checkpoint that is already finished", () => {
    const cp = createCheckpoint({ agentName: "coder", parentSessionId: "s3", task: "t" });
    completeCheckpoint(cp.taskId);
    expect(pauseCheckpoint(cp.taskId, {
      progressNote: "x", conversationSummary: "y", elapsedMs: 1, iterationsCompleted: 1,
    })).toBeNull();
  });
});
