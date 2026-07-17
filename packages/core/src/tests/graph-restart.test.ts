/**
 * GRF-206: durable graph definitions + boot-time interrupted-graph detection
 * (local fallback backend; the Redis path shares the same call shape).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  writeTaskGraphDefinition,
  deleteTaskGraphDefinition,
  listInterruptedTaskGraphs,
  resetSharedMemoryForTests,
} from "../swarm/memory.js";
import { recordCompletedTaskGraphNode, computeTaskGraphNodeKey } from "../swarm/task-graph-ledger.js";
import { scanForInterruptedTaskGraphs } from "../swarm/graph-restart.js";

vi.mock("../config/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/loader.js")>();
  return {
    ...original,
    getConfig: () => {
      const config = original.getConfig();
      return { ...config, mission: { ...config.mission, durableTaskGraph: "shadow" } };
    },
  };
});

const DEF = {
  graphId: "graph_1",
  sessionId: "gr-1",
  startedAt: "2026-07-17T18:00:00.000Z",
  objective: "build and verify",
  nodes: [
    { id: "research", task: "research the topic" },
    { id: "build", task: "build the artifact", dependsOn: ["research"] },
    { id: "verify", task: "verify the artifact", dependsOn: ["build"] },
  ],
};

describe("interrupted task-graph detection (GRF-206)", () => {
  afterEach(async () => {
    await resetSharedMemoryForTests();
  });

  it("a surviving definition is detected with completed-vs-pending analysis against the ledger", async () => {
    await writeTaskGraphDefinition("gr-1", DEF);
    // One node completed durably before the "crash".
    await recordCompletedTaskGraphNode("gr-1", computeTaskGraphNodeKey({ id: "research", task: "research the topic" }), {
      nodeId: "research",
      output: "findings",
      completedAt: "2026-07-17T18:01:00.000Z",
    });

    const candidates = await scanForInterruptedTaskGraphs();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      graphId: "graph_1",
      sessionId: "gr-1",
      totalNodes: 3,
      completedNodeIds: ["research"],
      pendingNodeIds: ["build", "verify"],
    });
  });

  it("clean completion deletes the definition — nothing to resume", async () => {
    await writeTaskGraphDefinition("gr-2", { ...DEF, graphId: "graph_2", sessionId: "gr-2" });
    await deleteTaskGraphDefinition("gr-2", "graph_2");
    expect(await scanForInterruptedTaskGraphs()).toHaveLength(0);
  });

  it("multiple interrupted graphs across sessions are all reported", async () => {
    await writeTaskGraphDefinition("gr-3", { ...DEF, graphId: "graph_3", sessionId: "gr-3" });
    await writeTaskGraphDefinition("gr-4", { ...DEF, graphId: "graph_4", sessionId: "gr-4" });
    const candidates = await scanForInterruptedTaskGraphs();
    expect(candidates.map((c) => c.graphId).sort()).toEqual(["graph_3", "graph_4"]);
  });

  it("definitions bound their payload (node task text capped)", async () => {
    await writeTaskGraphDefinition("gr-5", {
      ...DEF,
      graphId: "graph_5",
      sessionId: "gr-5",
      nodes: [{ id: "big", task: "x".repeat(50_000) }],
    });
    const [def] = await listInterruptedTaskGraphs();
    expect(def!.nodes[0]!.task.length).toBeLessThanOrEqual(2_000);
  });
});
