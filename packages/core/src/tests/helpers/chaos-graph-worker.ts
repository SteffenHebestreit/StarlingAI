/**
 * Chaos worker (EVL-402 crash pack): simulates a gateway process running a
 * task graph, then either DIES mid-flight (never deleting its definition) or
 * completes cleanly. Run in a separate OS process so the parent test proves
 * GRF-206's crash-detection contract across a REAL process boundary + Redis.
 *
 *   tsx chaos-graph-worker.ts <mode: crash|clean> <sessionId>
 */
import {
  writeTaskGraphDefinition,
  deleteTaskGraphDefinition,
} from "../../swarm/memory.js";
import { recordCompletedTaskGraphNode, computeTaskGraphNodeKey } from "../../swarm/task-graph-ledger.js";

const mode = process.argv[2] ?? "crash";
const sessionId = process.argv[3] ?? "chaos-default";
const graphId = `graph_chaos_${sessionId}`;

async function main(): Promise<void> {
  await writeTaskGraphDefinition(sessionId, {
    graphId,
    sessionId,
    startedAt: new Date().toISOString(),
    objective: "chaos: build then verify",
    nodes: [
      { id: "research", task: "research the topic" },
      { id: "build", task: "build the artifact", dependsOn: ["research"] },
      { id: "verify", task: "verify the artifact", dependsOn: ["build"] },
    ],
  });

  // One node completes durably before the crash point.
  await recordCompletedTaskGraphNode(sessionId, computeTaskGraphNodeKey({ id: "research", task: "research the topic" }), {
    nodeId: "research",
    output: "findings from the doomed process",
    completedAt: new Date().toISOString(),
  });

  if (mode === "clean") {
    await deleteTaskGraphDefinition(sessionId, graphId);
    console.log("CHAOS_RESULT:clean_complete");
    process.exit(0);
  }

  // Crash: hard exit with the definition still present — no cleanup handlers,
  // exactly what kill -9 / OOM looks like to the next boot.
  console.log("CHAOS_RESULT:crashed_mid_graph");
  process.exit(137);
}

main().catch((err) => {
  console.error("CHAOS_ERROR:", err);
  process.exit(1);
});
