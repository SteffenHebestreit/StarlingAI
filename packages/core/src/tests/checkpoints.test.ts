import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Checkpoints persist to `config.workspacePath` and there is no env override for
// it, so under vitest (which runs from packages/core) these tests were writing
// real checkpoint JSON into packages/core/workspace/.starlingai/checkpoints/.
// workspacePath is the ONLY config field checkpoints.ts reads, so overriding
// just that keeps every other consumer of the real config intact.
const TEST_WORKSPACE = mkdtempSync(join(tmpdir(), "sai-checkpoints-ws-"));
vi.mock("../config/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/loader.js")>();
  return {
    ...actual,
    getConfig: () => ({ ...actual.getConfig(), workspacePath: TEST_WORKSPACE }),
  };
});

import {
  createCheckpoint,
  pauseCheckpoint,
  resumeCheckpoint,
  completeCheckpoint,
  listCheckpoints,
  buildResumeContext,
  loadCheckpointsFromDisk,
  sweepExpiredCheckpoints,
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
    // COMPLETING IT RELEASES IT. A completed run has nothing to resume and the dashboard
    // filters to `paused` before rendering, so a retained record was read by nothing and freed
    // by nothing — one Map entry and one ~2 KB file per delegation, reclaimed only by a
    // restart. The audit record is the history; this was the resume handle.
    expect(listCheckpoints().some((c) => c.taskId === cp.taskId)).toBe(false);
    expect(completeCheckpoint(cp.taskId)).toBe(false);   // and it is gone from disk too
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

/**
 * A GATEWAY THAT NEVER RESTARTS USED TO NEVER RECLAIM.
 *
 * Every delegated run opens a checkpoint — a Map entry plus a ~2 KB JSON file — and the only
 * reclamation was the startup scan, which touches disk and never the Map. Measured before this
 * changed: 200 runs, ALL completed, left 200 files (442 KB) and 200 live entries.
 */
describe("checkpoint reclamation", () => {
  it("holds nothing for a run that completed", () => {
    const before = listCheckpoints().length;
    const ids = Array.from({ length: 25 }, (_, i) =>
      createCheckpoint({ agentName: "web_coder", parentSessionId: `sweep-${i}`, task: "build a game" }).taskId);
    expect(listCheckpoints().length).toBe(before + 25);

    for (const id of ids) expect(completeCheckpoint(id)).toBe(true);
    expect(listCheckpoints().length).toBe(before);

    const dir = join(TEST_WORKSPACE, ".starlingai", "checkpoints");
    const remaining = existsSync(dir) ? readdirSync(dir).filter((f) => ids.some((id) => f.startsWith(id))) : [];
    expect(remaining).toEqual([]);
  });

  it("sweeps a paused checkpoint nobody came back for, without a restart", () => {
    const cp = createCheckpoint({ agentName: "researcher", parentSessionId: "stale", task: "long task" });
    pauseCheckpoint(cp.taskId, {
      progressNote: "half done", conversationSummary: "some findings", elapsedMs: 1_000, iterationsCompleted: 2,
    });
    expect(listCheckpoints().some((c) => c.taskId === cp.taskId)).toBe(true);

    // Age it past the 24h TTL the startup scan already applies to disk.
    const held = listCheckpoints().find((c) => c.taskId === cp.taskId)!;
    held.updatedAt = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString();

    expect(sweepExpiredCheckpoints(TEST_WORKSPACE, { force: true })).toBeGreaterThan(0);
    expect(listCheckpoints().some((c) => c.taskId === cp.taskId)).toBe(false);
  });

  it("leaves a paused checkpoint that is still within the window alone — the discriminator", () => {
    const cp = createCheckpoint({ agentName: "researcher", parentSessionId: "fresh", task: "recent task" });
    pauseCheckpoint(cp.taskId, {
      progressNote: "half done", conversationSummary: "findings", elapsedMs: 1_000, iterationsCompleted: 2,
    });
    sweepExpiredCheckpoints(TEST_WORKSPACE, { force: true });
    expect(listCheckpoints({ status: "paused" }).some((c) => c.taskId === cp.taskId)).toBe(true);
  });
});
