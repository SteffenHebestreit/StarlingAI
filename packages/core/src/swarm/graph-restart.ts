/**
 * GRF-206 slice: boot-time detection + SAFE resume planning for interrupted
 * task graphs.
 *
 * A graph definition that still exists at boot belongs to a graph that never
 * completed cleanly — the process died (or was killed) mid-execution. The
 * scanner cross-references each surviving definition against two durable
 * records to classify every node:
 *   - the per-node COMPLETION ledger (first-writer-wins) → completed, reuse;
 *   - the per-node START markers → distinguish, among the not-completed nodes,
 *     those that were IN-FLIGHT at the crash (a start marker with no completion)
 *     from those that NEVER STARTED (no marker).
 *
 * The classification is the safety core of a resume. A never-started node
 * PROVABLY fired no effect, so re-dispatching it cannot double-mutate. An
 * in-flight node's effect class is UNKNOWN — it may already have fired an
 * irreversible external effect and crashed before recording completion — so it
 * is NEVER auto-re-dispatched; it is surfaced for operator resolution, exactly
 * the ADR-005 unknown-outcome rule. `planGraphResume` emits the safe
 * re-dispatch set (never-started nodes whose deps are all completed).
 *
 * This slice DETECTS, PLANS, and AUDITS; it does not itself re-run agent turns
 * at boot (that headless executor is deliberately deferred — see the ledger).
 */
import { getConfig } from "../config/loader.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { listInterruptedTaskGraphs, readStartedTaskGraphNodes, type TaskGraphDefinitionRecord } from "./memory.js";
import { readTaskGraphLedger } from "./task-graph-ledger.js";

const log = childLogger("swarm:graph-restart");

export interface GraphResumeCandidate {
  graphId: string;
  sessionId: string;
  startedAt: string;
  totalNodes: number;
  /** Node ids whose completed output survives in the ledger — a resume reuses these. */
  completedNodeIds: string[];
  /** Node ids a resume would need to run (everything not completed). */
  pendingNodeIds: string[];
  /** Pending nodes that were IN-FLIGHT at the crash (started, no completion):
   *  UNKNOWN effect — never auto-re-dispatched, operator resolution required. */
  inFlightNodeIds: string[];
  /** Pending nodes that never started — provably fired no effect, safe to run. */
  neverStartedNodeIds: string[];
  /** Never-started nodes whose dependencies are ALL completed: the resume's
   *  immediately-dispatchable frontier. Downstream never-started nodes become
   *  ready as these complete. */
  resumableNodeIds: string[];
}

/** Compute the safe resume classification for one interrupted graph. */
export async function planGraphResume(def: TaskGraphDefinitionRecord): Promise<GraphResumeCandidate> {
  let completedIds = new Set<string>();
  try {
    const ledger = await readTaskGraphLedger(def.sessionId);
    completedIds = new Set(
      Object.values(ledger)
        .map((entry) => entry.nodeId)
        .filter((id): id is string => typeof id === "string"),
    );
  } catch { /* no ledger = nothing completed durably */ }

  let startedIds = new Set<string>();
  try {
    startedIds = new Set(await readStartedTaskGraphNodes(def.sessionId, def.graphId));
  } catch { /* no markers = treat all not-completed as never-started (conservative: they become resumable) */ }

  const pending = def.nodes.filter((n) => !completedIds.has(n.id));
  const inFlight = pending.filter((n) => startedIds.has(n.id));
  const neverStarted = pending.filter((n) => !startedIds.has(n.id));
  // A never-started node is dispatchable now only if EVERY dependency already
  // completed. (An in-flight dependency blocks it — the frontier grows as the
  // resume completes safe nodes, never by ignoring an unknown-effect ancestor.)
  const resumable = neverStarted.filter((n) => (n.dependsOn ?? []).every((dep) => completedIds.has(dep)));

  return {
    graphId: def.graphId,
    sessionId: def.sessionId,
    startedAt: def.startedAt,
    totalNodes: def.nodes.length,
    completedNodeIds: def.nodes.filter((n) => completedIds.has(n.id)).map((n) => n.id),
    pendingNodeIds: pending.map((n) => n.id),
    inFlightNodeIds: inFlight.map((n) => n.id),
    neverStartedNodeIds: neverStarted.map((n) => n.id),
    resumableNodeIds: resumable.map((n) => n.id),
  };
}

/** Scan surviving graph definitions, plan a safe resume for each, and audit it. */
export async function scanForInterruptedTaskGraphs(): Promise<GraphResumeCandidate[]> {
  const interrupted = await listInterruptedTaskGraphs();
  const candidates: GraphResumeCandidate[] = [];
  for (const def of interrupted) {
    const candidate = await planGraphResume(def);
    candidates.push(candidate);
    logAudit("task_graph_interrupted_detected", {
      graphId: candidate.graphId,
      startedAt: candidate.startedAt,
      totalNodes: candidate.totalNodes,
      completedNodeIds: candidate.completedNodeIds,
      pendingNodeIds: candidate.pendingNodeIds,
      inFlightNodeIds: candidate.inFlightNodeIds,
      neverStartedNodeIds: candidate.neverStartedNodeIds,
      resumableNodeIds: candidate.resumableNodeIds,
      // Never-started nodes are safe to re-dispatch; in-flight nodes have an
      // unknown effect and MUST go to an operator (never blind-replayed).
      resumeAction: candidate.inFlightNodeIds.length > 0 ? "operator_review_required" : "safe_to_resume",
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
  log.info("Task-graph restart scanner armed (shadow: detect + plan + audit)");
}
