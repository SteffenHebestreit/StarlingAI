/**
 * The block a delegation frame carries about what its run RECORDED — the files it produced, the
 * code it executed and the tool calls that failed on the way — and how every other reader of that
 * frame steps past it.
 *
 * The block is written into the head of a frame (tool-result-format.ts), but several older checks
 * read the WHOLE frame for their verdict words: "TASK FAILED", "PARTIAL PROGRESS", "timed out", a
 * continuation or ask-the-user cue. A failed-call line holds a tool's own error text, and a run
 * that recovered from "Tool 'web_fetch' timed out after 30000ms" still completed; read as the
 * frame's verdict, that line turns a finished delegation into an exhausted one. So those checks
 * read the frame without this block, and the block and its reader live here together, where the
 * headers cannot drift apart from the code that recognises them.
 *
 * A leaf module on purpose: the checks that need it sit below the frame builder in the imports.
 */
import { UNOBSERVED_FIGURE_MARKER } from "./figure-provenance.js";

export const PRODUCED_FILES_HEADER =
  "Files produced, as recorded by the tool that wrote each (for you, not for the reply; name an engine, tier or model only as given here):";
export const TOOL_FAILURES_HEADER =
  "Tool calls that failed along the way (for you, not for the reply; the run went on after them, so they are not its outcome):";
export const TOOL_DECLINES_HEADER =
  "Tool calls the user declined (their choice, not a failure; nothing was done in them, so do not retry them):";
/**
 * How a partial run was stopped: the loop it was stuck in, the warden, or its iteration limit
 * (orchestration.loopAwareDelegation). Its line carries the looped call's arguments, which are the
 * model's own text: a grep for "next step" read as the frame's continuation cue would steer the
 * turn, so it lives in this block, where no verdict check reads.
 */
export const RUN_STOP_HEADER =
  "How the run was stopped (for you, not for the reply; its evidence below is partial):";
/** The run's code executions, listed when none of them completed with output or when the run masked
 *  figures (see DelegatedExecutionRecord). */
export const EXECUTIONS_HEADER = "Code the run executed (for you, not for the reply):";
/**
 * The failed calls of a run none of whose code executions completed with output. TOOL_FAILURES_HEADER
 * says the run went on after its failures, so they are not its outcome; in this state they are.
 */
export const TOOL_FAILURES_UNRECOVERED_HEADER = "Tool calls that failed (for you, not for the reply):";

const HEADERS = new Set([
  PRODUCED_FILES_HEADER,
  TOOL_FAILURES_HEADER,
  TOOL_DECLINES_HEADER,
  RUN_STOP_HEADER,
  EXECUTIONS_HEADER,
  TOOL_FAILURES_UNRECOVERED_HEADER,
]);

/** The frame as it read before the block was added: each header and the "- " lines under it go. */
export function stripDelegatedRunRecord(text: string): string {
  if (![...HEADERS].some((header) => text.includes(header))) return text;
  const kept: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (HEADERS.has(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line.startsWith("- ")) continue;
    inBlock = false;
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * What a delegated run executed, counted by the run itself (agent/sub-agent.ts) and carried up as
 * `executions` on its result and `specialistExecutions` in a delegation's metadata.
 *
 * An execution is a call to a tool that runs a program in the sandbox (`requiresSandbox`) whose
 * result reports `programOutputChars`, which those tools set only once the program actually ran.
 * E2E 2026-10-07: seven of them failed or printed nothing, the coder stated two figures no tool
 * had returned, and the run reported success. `unobservedFigures` counts the figures it then
 * masked (agent/figure-provenance.ts): its answer stated them, and nothing it ran produced them.
 */
export interface DelegatedExecutionRecord {
  attempted: number;
  failed: number;
  succeededWithOutput: number;
  unobservedFigures?: number;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A well-formed record, or null: metadata from another level, or written before records existed. */
export function readExecutionRecord(value: unknown): DelegatedExecutionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { attempted, failed, succeededWithOutput, unobservedFigures } = value as Record<string, unknown>;
  if (!isCount(attempted) || !isCount(failed) || !isCount(succeededWithOutput)) return null;
  if (unobservedFigures !== undefined && !isCount(unobservedFigures)) return null;
  if (failed + succeededWithOutput > attempted) return null;
  return { attempted, failed, succeededWithOutput, ...(unobservedFigures !== undefined ? { unobservedFigures } : {}) };
}

/** Adds a nested run's record to the delegating run's own. */
export function addExecutionRecord(into: DelegatedExecutionRecord, add: DelegatedExecutionRecord | null | undefined): void {
  if (!add) return;
  into.attempted += add.attempted;
  into.failed += add.failed;
  into.succeededWithOutput += add.succeededWithOutput;
  if (add.unobservedFigures) into.unobservedFigures = (into.unobservedFigures ?? 0) + add.unobservedFigures;
}

/**
 * One run of a fan-out whose account had figures masked: who ran it, its record and the files it
 * recorded. A fan-out's summed record cannot say which of its runs that was, and the turn names that
 * run and its files, and only those, as written but not run successfully (agent/runtime.ts).
 */
export interface MaskedDelegatedRun {
  agentName: string;
  executions: DelegatedExecutionRecord;
  artifacts: Record<string, unknown>[];
}

function recordsIn(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

/** The well-formed entries of a fan-out's `maskedRuns`, each one a run that did mask figures. */
export function readMaskedRuns(value: unknown): MaskedDelegatedRun[] {
  return recordsIn(value).flatMap((entry) => {
    const executions = readExecutionRecord(entry["executions"]);
    const agentName = entry["agentName"];
    if (typeof agentName !== "string" || !agentName || !unbackedFiguresMasked(executions)) return [];
    return [{ agentName, executions: executions!, artifacts: recordsIn(entry["artifacts"]) }];
  });
}

/**
 * What a fan-out (parallel_delegate, run_task_graph, execute_plan, run_workflow) hands back about
 * the code its runs executed: the sum of their records as `specialistExecutions`, and each run that
 * masked figures as an entry of `maskedRuns`. In review all four dropped the record: a coordinator
 * whose coder's only execution failed restated the coder's masked figures through parallel_delegate
 * and went out as a success, and a plan built its next step on the masked text while the turn
 * scored itself complete. Each run is added as its delegation's metadata (agentName, artifacts,
 * specialistExecutions, maskedRuns); a run's own masked runs are passed on as they are. Nothing is
 * handed back when no run carried a record, so a fan-out that ran no code stays as it was.
 */
export function createFanOutExecutionRecords(): {
  add(metadata: Record<string, unknown> | undefined, agentName?: string): DelegatedExecutionRecord | null;
  metadata(): { specialistExecutions?: DelegatedExecutionRecord; maskedRuns?: MaskedDelegatedRun[] };
} {
  let total: DelegatedExecutionRecord | null = null;
  const maskedRuns: MaskedDelegatedRun[] = [];
  return {
    add(metadata, agentName) {
      const record = readExecutionRecord(metadata?.["specialistExecutions"]);
      if (!record) return null;
      total ??= { attempted: 0, failed: 0, succeededWithOutput: 0 };
      addExecutionRecord(total, record);
      const nested = readMaskedRuns(metadata?.["maskedRuns"]);
      if (nested.length > 0) {
        maskedRuns.push(...nested);
      } else if (unbackedFiguresMasked(record)) {
        const named = metadata?.["agentName"];
        maskedRuns.push({
          agentName: typeof named === "string" && named ? named : agentName || "delegated agent",
          executions: record,
          artifacts: recordsIn(metadata?.["artifacts"]),
        });
      }
      return record;
    },
    metadata() {
      return {
        ...(total ? { specialistExecutions: { ...total } } : {}),
        ...(maskedRuns.length > 0 ? { maskedRuns: [...maskedRuns] } : {}),
      };
    },
  };
}

/** The run executed code and none of it completed with output: every figure it states came from elsewhere. */
export function noExecutionCompleted(record: DelegatedExecutionRecord | null | undefined): boolean {
  return Boolean(record) && record!.attempted > 0 && record!.succeededWithOutput === 0;
}

/** The run's account stated figures that nothing it received or ran contained, and they were masked. */
export function unbackedFiguresMasked(record: DelegatedExecutionRecord | null | undefined): boolean {
  return (record?.unobservedFigures ?? 0) > 0;
}

/**
 * A run that had to mask figures did not succeed, whatever else it did: the numbers it was asked
 * for came from the model, not from the code. Every other outcome passes through.
 */
export function capOutcomeForUnbackedFigures<T extends string | undefined>(
  outcome: T,
  record: DelegatedExecutionRecord | null | undefined,
): T | "partial" {
  return outcome === "success" && unbackedFiguresMasked(record) ? "partial" : outcome;
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "7 code executions" */
export function executionCountPhrase(record: DelegatedExecutionRecord): string {
  return counted(record.attempted, "code execution", "code executions");
}

/** How the executions that did not complete with output ended: "4 failed, 3 printed nothing". */
export function executionShortfallPhrase(record: DelegatedExecutionRecord): string {
  const silent = Math.max(0, record.attempted - record.failed - record.succeededWithOutput);
  const parts = [
    record.failed > 0 ? `${record.failed} failed` : "",
    silent > 0 ? `${silent} printed nothing` : "",
  ].filter(Boolean);
  return parts.join(", ") || "none failed";
}

/** The record as one line, for the frame (above the run's account) and the synthesis directive (after it). */
export function executionRecordLine(record: DelegatedExecutionRecord): string {
  const masked = record.unobservedFigures ?? 0;
  const maskedClause = masked > 0
    ? `; ${counted(masked, "figure", "figures")} in the run's account ${masked === 1 ? "appears" : "appear"} in no tool result and ${masked === 1 ? "is" : "are"} masked as ${UNOBSERVED_FIGURE_MARKER}`
    : "";
  if (noExecutionCompleted(record)) {
    return `${executionCountPhrase(record)}, none completed with output (${executionShortfallPhrase(record)})${maskedClause}`;
  }
  const silent = Math.max(0, record.attempted - record.failed - record.succeededWithOutput);
  return `${executionCountPhrase(record)}: ${record.succeededWithOutput} completed with output, ${record.failed} failed, ${silent} printed nothing${maskedClause}`;
}
