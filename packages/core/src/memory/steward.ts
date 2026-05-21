/**
 * Memory steward — reasoned, agent-facing memory curation: surfaceable,
 * agent-driven consolidation rather than purely mechanical compaction.
 *
 * The existing auto-compaction (memory/service) handles mechanical dedup on a
 * write counter. The steward adds an explicit, surfaceable curation report:
 * how much duplication and staleness has accumulated, and a one-line nudge the
 * agent can act on by calling curate_memory(apply=true).
 *
 * It never deletes silently — consolidation only happens when explicitly
 * applied, keeping it inside the Bounded Self-Improvement envelope.
 */

import {
  compactWorkspaceMemoryRecords,
  listWorkspaceMemoryRecords,
  listUserMemoryRecords,
  type MemoryKind,
  type MemoryRecord,
} from "./service.js";

/** Volatile kinds whose value decays fast; stale ones are curation candidates. */
const VOLATILE_KINDS = new Set<MemoryKind>(["note", "fact"]);
const STALE_AFTER_DAYS = 21;

export interface MemoryCurationReport {
  totalRecords: number;
  duplicateClusters: number;
  removableDuplicates: number;
  staleVolatile: number;
  /** One-line, human/agent-readable nudge. Empty when nothing to curate. */
  nudge: string;
}

export function computeMemoryCurationReport(workspacePath: string): MemoryCurationReport {
  const records = [
    ...listWorkspaceMemoryRecords(workspacePath),
    ...listUserMemoryRecords(workspacePath),
  ];

  // Mechanical dedup detection without mutating anything.
  const dryRun = compactWorkspaceMemoryRecords(workspacePath, { dryRun: true });

  const staleVolatile = countStaleVolatile(records);

  const report: MemoryCurationReport = {
    totalRecords: records.length,
    duplicateClusters: dryRun.merged,
    removableDuplicates: dryRun.removed,
    staleVolatile,
    nudge: "",
  };

  report.nudge = buildNudge(report);
  return report;
}

function countStaleVolatile(records: MemoryRecord[]): number {
  const now = Date.now();
  let count = 0;
  for (const record of records) {
    if (!VOLATILE_KINDS.has(record.kind)) continue;
    const updated = Date.parse(record.updatedAt);
    if (!Number.isFinite(updated)) continue;
    const ageDays = (now - updated) / 86_400_000;
    if (ageDays >= STALE_AFTER_DAYS) count++;
  }
  return count;
}

function buildNudge(report: MemoryCurationReport): string {
  const parts: string[] = [];
  if (report.removableDuplicates > 0) {
    parts.push(`${report.removableDuplicates} duplicate memories across ${report.duplicateClusters} clusters`);
  }
  if (report.staleVolatile > 0) {
    parts.push(`${report.staleVolatile} stale low-value notes/facts (>${STALE_AFTER_DAYS}d old)`);
  }
  if (parts.length === 0) return "";
  return `Memory has accumulated ${parts.join(" and ")}. Call curate_memory(apply=true) to consolidate duplicates.`;
}
