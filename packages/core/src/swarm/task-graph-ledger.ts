/**
 * Durable task-graph ledger (orchestration.durableTaskGraph, default-off).
 *
 * run_task_graph keeps node state in local Sets, so a turn that dies mid-graph
 * (budget ceiling, abort) loses every COMPLETED node: the honesty caveat ships and a
 * retry re-runs the whole graph from node 1 — including expensive research/build nodes
 * that already succeeded. This ledger records each completed node's distilled result in
 * a per-session slot (Redis, session TTL, in-process fallback — swarm/memory.ts), keyed
 * by a STRUCTURAL node hash. When a graph is re-issued in the same session, nodes whose
 * hash matches a ledger entry are satisfied from the ledger without re-executing.
 *
 * Correctness properties:
 * - Reuse is strictly conservative: it only ever SKIPS re-execution of work that already
 *   completed — it cannot double-fire a side-effectful node (the hazard runs the other
 *   way: NOT reusing re-runs side-effectful nodes on every retry).
 * - The key hashes the node id + full task text + sorted dependency ids, so any re-plan
 *   that changes what a node must do (or what feeds it) invalidates reuse naturally.
 *   agentName is deliberately excluded: the task defines the work, not the worker.
 * - Staleness is bounded by the session TTL of the underlying slot (same as shared
 *   facts), and the whole mechanism is scoped to one session.
 * - Downstream context survives independently: dependents consume upstream results via
 *   shared session facts / partial results, which the original run already persisted.
 */
import { createHash } from "node:crypto";
import { readTaskGraphLedgerBlob, writeTaskGraphLedgerBlob } from "./memory.js";
import { childLogger } from "../logger.js";

const log = childLogger("swarm:task-graph-ledger");

export interface TaskGraphLedgerEntry {
  /** The node id at completion time (display/debug — the KEY carries identity). */
  nodeId: string;
  /** Distilled node output, capped at LEDGER_OUTPUT_MAX. */
  output: string;
  /** Artifact refs the node produced (capped), re-surfaced on reuse so downloads reappear. */
  artifacts?: Record<string, unknown>[];
  completedAt: string;
}

export type TaskGraphLedger = Record<string, TaskGraphLedgerEntry>;

export const LEDGER_MAX_ENTRIES = 24;
export const LEDGER_OUTPUT_MAX = 4_000;
const LEDGER_MAX_ARTIFACTS = 4;

/** Structural identity of a graph node: id + full task text + sorted dependency ids. */
export function computeTaskGraphNodeKey(node: { id: string; task: string; dependsOn?: string[] }): string {
  const deps = [...(node.dependsOn ?? [])].sort().join(",");
  return createHash("sha256").update(`${node.id}\n${node.task}\n${deps}`).digest("hex").slice(0, 16);
}

/** Tolerant parse of the stored blob — any corruption yields an empty ledger, never a throw. */
export function parseTaskGraphLedger(blob: string | null | undefined): TaskGraphLedger {
  if (!blob) return {};
  try {
    const parsed: unknown = JSON.parse(blob);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const ledger: TaskGraphLedger = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry["nodeId"] !== "string" || typeof entry["output"] !== "string" || typeof entry["completedAt"] !== "string") continue;
      ledger[key] = {
        nodeId: entry["nodeId"],
        output: entry["output"],
        completedAt: entry["completedAt"],
        ...(Array.isArray(entry["artifacts"]) ? { artifacts: entry["artifacts"] as Record<string, unknown>[] } : {}),
      };
    }
    return ledger;
  } catch {
    return {};
  }
}

/**
 * Pure upsert with caps: output truncated, artifacts capped, oldest entries evicted
 * beyond LEDGER_MAX_ENTRIES. Returns a NEW ledger object.
 */
export function upsertTaskGraphLedgerEntry(
  ledger: TaskGraphLedger,
  key: string,
  entry: TaskGraphLedgerEntry,
): TaskGraphLedger {
  const next: TaskGraphLedger = {
    ...ledger,
    [key]: {
      nodeId: entry.nodeId,
      output: entry.output.slice(0, LEDGER_OUTPUT_MAX),
      completedAt: entry.completedAt,
      ...(entry.artifacts && entry.artifacts.length > 0
        ? { artifacts: entry.artifacts.slice(0, LEDGER_MAX_ARTIFACTS) }
        : {}),
    },
  };
  const keys = Object.keys(next);
  if (keys.length > LEDGER_MAX_ENTRIES) {
    const byAge = keys.sort((a, b) => (next[a]!.completedAt < next[b]!.completedAt ? -1 : 1));
    for (const stale of byAge.slice(0, keys.length - LEDGER_MAX_ENTRIES)) {
      delete next[stale];
    }
  }
  return next;
}

export async function readTaskGraphLedger(sessionId: string): Promise<TaskGraphLedger> {
  try {
    return parseTaskGraphLedger(await readTaskGraphLedgerBlob(sessionId));
  } catch (err) {
    log.warn({ err, sessionId }, "task-graph ledger read failed — treating as empty");
    return {};
  }
}

/** Read-modify-write a completed node into the session ledger. Never throws. */
export async function recordCompletedTaskGraphNode(
  sessionId: string,
  key: string,
  entry: TaskGraphLedgerEntry,
): Promise<void> {
  try {
    const ledger = parseTaskGraphLedger(await readTaskGraphLedgerBlob(sessionId));
    const next = upsertTaskGraphLedgerEntry(ledger, key, entry);
    await writeTaskGraphLedgerBlob(sessionId, JSON.stringify(next));
  } catch (err) {
    log.warn({ err, sessionId, nodeId: entry.nodeId }, "task-graph ledger write failed — node will not be reusable");
  }
}
