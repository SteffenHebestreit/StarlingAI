/**
 * GRF-206 slice: boot-time detection of interrupted task graphs.
 *
 * A graph definition that still exists at boot belongs to a graph that never
 * completed cleanly — the process died (or was killed) mid-execution. This
 * scanner cross-references each surviving definition against the durable
 * per-node ledger to compute exactly what a resume would owe: nodes whose
 * completed output already exists (NEVER re-run — first-writer-wins reuse),
 * and pending nodes, which stay operator-review-gated because a node's effect
 * class is unknown until it runs (re-dispatching a node that already fired an
 * irreversible external effect is the double-mutation ADR-005 forbids).
 *
 * Shadow slice: detect + audit resume candidates (`task_graph_interrupted_detected`).
 * The automatic re-dispatch executor is the follow-up slice and stays gated on
 * the chaos pack per the plan's own sequencing.
 */
import { getConfig } from "../config/loader.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { listInterruptedTaskGraphs } from "./memory.js";
import { readTaskGraphLedger } from "./task-graph-ledger.js";

const log = childLogger("swarm:graph-restart");

export interface GraphResumeCandidate {
  graphId: string;
  sessionId: string;
  startedAt: string;
  totalNodes: number;
  /** Node ids whose completed output survives in the ledger — a resume reuses these. */
  completedNodeIds: string[];
  /** Node ids a resume would need to run — operator-review-gated in this slice. */
  pendingNodeIds: string[];
}

/** Scan surviving graph definitions and classify each node against the ledger. */
export async function scanForInterruptedTaskGraphs(): Promise<GraphResumeCandidate[]> {
  const interrupted = await listInterruptedTaskGraphs();
  const candidates: GraphResumeCandidate[] = [];
  for (const def of interrupted) {
    let completedIds = new Set<string>();
    try {
      const ledger = await readTaskGraphLedger(def.sessionId);
      completedIds = new Set(
        Object.values(ledger)
          .map((entry) => entry.nodeId)
          .filter((id): id is string => typeof id === "string"),
      );
    } catch { /* no ledger = nothing completed durably */ }

    const candidate: GraphResumeCandidate = {
      graphId: def.graphId,
      sessionId: def.sessionId,
      startedAt: def.startedAt,
      totalNodes: def.nodes.length,
      completedNodeIds: def.nodes.filter((n) => completedIds.has(n.id)).map((n) => n.id),
      pendingNodeIds: def.nodes.filter((n) => !completedIds.has(n.id)).map((n) => n.id),
    };
    candidates.push(candidate);
    logAudit("task_graph_interrupted_detected", {
      graphId: candidate.graphId,
      startedAt: candidate.startedAt,
      totalNodes: candidate.totalNodes,
      completedNodeIds: candidate.completedNodeIds,
      pendingNodeIds: candidate.pendingNodeIds,
      resumeAction: "operator_review", // auto re-dispatch is the chaos-gated follow-up slice
    }, { sessionId: candidate.sessionId, severity: "warn" });
  }
  return candidates;
}

/** Boot hook: run the scan shortly after startup when the flag is on. */
export function maybeStartGraphRestartScan(): void {
  if (getConfig().mission.durableTaskGraph === "off") return;
  const timer = setTimeout(() => {
    void scanForInterruptedTaskGraphs()
      .then((candidates) => {
        if (candidates.length > 0) {
          log.warn({ count: candidates.length, graphIds: candidates.map((c) => c.graphId) },
            "Interrupted task graphs detected from a previous process — resume candidates audited (task_graph_interrupted_detected)");
        } else {
          log.info("No interrupted task graphs from previous processes");
        }
      })
      .catch((err) => log.warn({ err }, "Interrupted-graph scan failed"));
  }, 5_000);
  timer.unref?.();
  log.info("Task-graph restart scanner armed (shadow: detect + audit)");
}
