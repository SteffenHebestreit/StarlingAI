/**
 * The loop brake replayed over an audit log: where would the two rules of agents.performance.loopBrake
 * have acted on runs that already happened, and on which runs would they have acted wrongly?
 *
 * Offline and pure — rows in, a report out; no model, no network, no config. The CLI is
 * scripts/loops-replay.ts (`pnpm --filter @starlingai/core loops:replay`).
 *
 * The rules are the shipped ones, called, not copied: classifyCallReplay for the refusal and
 * classifyRunProgress for the supervisor. What the audit cannot give them is reconstructed, and each
 * reconstruction is named where it happens:
 *
 *  - IDENTICAL CALLS are keyed on tool + arguments + success + the result preview, never on
 *    outputChars (a cached row has none, so the replay of a call would never match its original).
 *    The preview is re-normalised the way the audit writes an executed row (truncateToolAuditText),
 *    because a cached row carries the whole cached text. Keying on the result as well as the
 *    arguments means only calls that came back the same count — which is what a cache would have
 *    answered them with. The count restarts at every successful write, like the caches.
 *  - WHICH CACHE WOULD ANSWER is the shipped one's: any earlier identical call for an idempotent tool
 *    (the A→B→A cache), otherwise only when that tool's last executed call had the same arguments
 *    (the consecutive cache). A call no cache would answer executes, and its count starts over.
 *    Without this, a non-idempotent tool alternating between two targets read as a loop the
 *    shipped brake never sees.
 *  - ITERATIONS are the tool rows between two of the run's own model calls (rows with a tool list).
 *    An iteration whose calls were all refused, skipped in the log or answered with a cached failure
 *    is blocked; two in a row are the stop.
 *  - "STILL VERBATIM" is approximated: an overflow trim after the answer, or a digest after an answer
 *    over 2,000 characters (the size a stale result is cut to), takes the answer away. Which messages
 *    a digest actually rewrote is not logged, so this errs toward replaying.
 *  - The SUPERVISOR is sampled at fixed 180 s windows from the run's start (the real one samples at
 *    the top of the first iteration past each window). A new result is an executed, successful call
 *    whose tool + preview the run had not seen; assistant output and reasoning are not in the tool
 *    rows and count as zero, which can only make a quiet window look quieter, never a busy one busier.
 *
 * Every figure is an upper bound on a cause the log shows; a run the rules would have stopped earlier
 * might have gone differently afterwards. Only ids, tool names, counts and seconds leave this module:
 * the rows hold the user's words (arguments, previews), and none of those are printed.
 */
import type { AuditRow } from "./latency-attribution.js";
import {
  classifyCallReplay,
  classifyRunProgress,
  EMPTY_PROGRESS_SAMPLE,
  PROGRESS_CHECK_INTERVAL_MS,
  type ProgressSample,
} from "./progress-verifier.js";
import { truncateToolAuditText } from "./sub-agent-interruption.js";

/** Tools the brake never answers from a cache, as in agent/sub-agent.ts (isLiveStateTool, NEVER_REPLAYED_TOOLS). */
function neverReplayed(tool: string): boolean {
  return tool.startsWith("browser_") || tool.startsWith("computer_") || tool === "generate_image";
}

/** agent/sub-agent.ts IDEMPOTENT_TOOLS: the tools the A→B→A cache answers. A copy, because this module
 *  must not load the sub-agent runner; sub-agent-loop-brake.test.ts holds the two equal. */
export const REPLAY_IDEMPOTENT_TOOLS: ReadonlySet<string> = new Set([
  "read_file", "list_files", "list_agents", "search_agents", "search_tools", "search_workflows",
  "extract_file_content", "spreadsheet_read", "list_pdf_form_fields", "list_tts_voices",
  "web_search", "web_fetch", "workspace_search", "grep_files", "glob_files",
]);

/** A result the digest shrinks: MAX_STALE_TOOL_RESULT_CHARS in agent/sub-agent-history.ts. */
const DIGESTED_ABOVE_CHARS = 2_000;

/** The run's own model calls carry its tool list; side calls (distillation, facts-first answers) do not. */
function isLoopModelCall(row: AuditRow): boolean {
  const toolCount = row.data["toolCount"];
  return typeof toolCount === "number" && toolCount > 0;
}

function isSuccessfulWrite(row: AuditRow): boolean {
  if (row.data["success"] !== true || row.data["cachedResult"] === true || typeof row.data["skippedReason"] === "string") return false;
  const tool = String(row.data["tool"] ?? "");
  const metadata = row.data["metadata"];
  const outputPath = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>)["outputPath"] : undefined;
  return tool === "write_file" || tool === "edit_file" || (typeof outputPath === "string" && outputPath.length > 0);
}

function writtenPath(row: AuditRow): string {
  const metadata = row.data["metadata"];
  const fromMeta = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>)["outputPath"] : undefined;
  if (typeof fromMeta === "string" && fromMeta) return fromMeta;
  const args = row.data["args"];
  const fromArgs = args && typeof args === "object" ? (args as Record<string, unknown>)["path"] : undefined;
  return typeof fromArgs === "string" ? fromArgs : "";
}

const preview = (row: AuditRow): string => truncateToolAuditText(typeof row.data["resultPreview"] === "string" ? row.data["resultPreview"] : "") ?? "";

export interface ReplayedRun {
  /** The sub-agent session id. */
  sessionId: string;
  agentName: string;
  /** sub_agent_completed's outcome, or null when the run's end is not in the rows. */
  outcome: string | null;
  durationS: number;
  calls: number;
  executed: number;
  /** The refusal rule: first refusal and the stop, by call number (1-based) and seconds from the run's start.
   *  A stop is the brake's only when a refusal is in the two blocked iterations that make it: two
   *  iterations blocked in the log alone were stopped by the run itself. */
  refusal: { firstAt: { call: number; s: number; tool: string } | null; stopAt: { call: number; s: number; tool: string } | null; refusals: number };
  /** The supervisor's first non-continue decision: as it was (successful calls, no busy arm) and with the brake. */
  supervisor: {
    before: { verdict: string; action: string; s: number } | null;
    after: { verdict: string; action: string; s: number } | null;
    /** The brake's wind-down: `after` winds down where `before` did not, or earlier. */
    brakeWindDownS: number | null;
  };
  /** When the run itself stopped working: its own blocked-iteration stop or supervisor wind-down in the log,
   *  else its end. Seconds from its start. */
  realStopS: number;
  /** realStopS minus the earlier brake stop: the working time the brake takes off this run. Both end in a
   *  synthesis, so that is not counted; an upper bound all the same (see the module comment). */
  savedS: number;
}

export interface LoopReplayReport {
  runs: ReplayedRun[];
  summary: {
    runs: number;
    runsWithRefusal: number;
    runsWithStop: number;
    stopsOnSuccess: number;
    windDownsAfter: number;
    windDownsAfterOnSuccess: number;
    savedS: number;
    /** Runs that ended in success with at least 20 calls: the only ones a false alarm could show on. */
    healthyLongRuns: number;
  };
}

interface RunRows {
  sessionId: string;
  agentName: string;
  startMs: number | null;
  endMs: number | null;
  outcome: string | null;
  tools: AuditRow[];
  modelCalls: number[];
  digests: number[];
  trims: number[];
  /** The run's own stops in the log: a blocked-iteration or dead-end stop, a supervisor wind-down. */
  ownStops: number[];
}

const at = (row: AuditRow): number => Date.parse(row.timestamp);

function groupRuns(rows: readonly AuditRow[]): RunRows[] {
  const runs = new Map<string, RunRows>();
  const runOf = (sessionId: string): RunRows => {
    let run = runs.get(sessionId);
    if (!run) {
      run = { sessionId, agentName: "-", startMs: null, endMs: null, outcome: null, tools: [], modelCalls: [], digests: [], trims: [], ownStops: [] };
      runs.set(sessionId, run);
    }
    return run;
  };
  const sorted = [...rows].sort((a, b) => at(a) - at(b));
  for (const row of sorted) {
    // The supervisor writes its verdict under the PARENT's session and names the run in the row.
    if (row.type === "progress_verifier_intervened") {
      const runSessionId = row.data["runSessionId"];
      if (typeof runSessionId === "string" && runSessionId.startsWith("sub:") && row.data["action"] !== "corrected") {
        runOf(runSessionId).ownStops.push(at(row));
      }
      continue;
    }
    if (!row.sessionId?.startsWith("sub:")) continue;
    const run = runOf(row.sessionId);
    switch (row.type) {
      case "sub_agent_started":
        run.startMs ??= at(row);
        if (typeof row.data["agentName"] === "string") run.agentName = row.data["agentName"];
        break;
      case "sub_agent_completed":
        run.endMs = at(row);
        run.outcome = typeof row.data["outcome"] === "string" ? row.data["outcome"] : null;
        break;
      case "sub_agent_tool_call":
        if (row.data["phase"] !== "done") break;
        run.tools.push(row);
        if (run.agentName === "-" && typeof row.data["agentName"] === "string") run.agentName = row.data["agentName"];
        break;
      case "provider_model_call":
        if (isLoopModelCall(row)) run.modelCalls.push(at(row));
        break;
      case "sub_agent_history_digested":
        run.digests.push(at(row));
        break;
      case "sub_agent_history_trimmed":
        run.trims.push(at(row));
        break;
      case "sub_agent_tool_loop_detected":
        if (row.data["reason"] === "all_tool_calls_blocked" || row.data["reason"] === "all_delegations_failed") run.ownStops.push(at(row));
        break;
      default:
        break;
    }
  }
  return [...runs.values()].filter((run) => run.tools.length > 0);
}

/** The run's tool rows in iterations: the rows after one of its own model calls and before the next. */
function iterationsOf(run: RunRows): AuditRow[][] {
  const iterations = new Map<number, AuditRow[]>();
  let boundary = 0;
  for (const row of run.tools) {
    while (boundary < run.modelCalls.length && run.modelCalls[boundary]! <= at(row)) boundary += 1;
    const group = iterations.get(boundary) ?? [];
    group.push(row);
    iterations.set(boundary, group);
  }
  return [...iterations.values()];
}

/** The refusal rule over one run's tool rows, and the blocked-iteration stop it feeds. */
function replayRefusals(run: RunRows, startMs: number): ReplayedRun["refusal"] {
  // (tool, arguments, outcome) -> identical calls since the last write, and when and how big the answer was
  const counts = new Map<string, { calls: number; answeredAt: number; answerChars: number }>();
  // Each tool's last EXECUTED arguments since the last write (lastToolCallSig in agent/sub-agent.ts):
  // what the consecutive cache compares a non-idempotent call with. Replays and refusals leave it.
  const lastExecutedArgs = new Map<string, string>();
  let refusals = 0;
  let firstAt: ReplayedRun["refusal"]["firstAt"] = null;
  let blockedInARow = 0;
  let refusedInStreak = false;
  let callNumber = 0;
  for (const iteration of iterationsOf(run)) {
    let blocked = 0;
    let refusedHere = false;
    for (const row of iteration) {
      callNumber += 1;
      const t = at(row);
      const tool = String(row.data["tool"] ?? "-");
      if (isSuccessfulWrite(row)) {
        counts.clear();
        lastExecutedArgs.clear();
        continue;
      }
      // Capped, malformed or otherwise refused in the log itself: blocked there already.
      if (typeof row.data["skippedReason"] === "string") {
        blocked += 1;
        continue;
      }
      if (neverReplayed(tool)) continue;
      const argsJson = JSON.stringify(row.data["args"] ?? {});
      const key = `${tool}\u0000${argsJson}\u0000${String(row.data["success"])}\u0000${preview(row)}`;
      const entry = counts.get(key);
      // Would a cache answer it at all? The A→B→A cache for an idempotent tool, otherwise only the
      // consecutive one. A call no cache answers executes, and its count starts over.
      const cacheAnswers = entry !== undefined && (REPLAY_IDEMPOTENT_TOOLS.has(tool) || lastExecutedArgs.get(tool) === argsJson);
      if (!entry || !cacheAnswers) {
        counts.set(key, { calls: 1, answeredAt: t, answerChars: typeof row.data["outputChars"] === "number" ? row.data["outputChars"] : 0 });
        lastExecutedArgs.set(tool, argsJson);
        continue;
      }
      const takenAway = run.trims.some((trim) => trim > entry.answeredAt && trim <= t)
        || (entry.answerChars > DIGESTED_ABOVE_CHARS && run.digests.some((digest) => digest > entry.answeredAt && digest <= t));
      const decision = classifyCallReplay({ priorIdenticalSinceWrite: entry.calls, priorAnswerVerbatim: !takenAway });
      entry.calls = decision.identicalAfter;
      if (decision.action === "refuse") {
        refusals += 1;
        blocked += 1;
        refusedHere = true;
        firstAt ??= { call: callNumber, s: (t - startMs) / 1000, tool };
      } else {
        entry.answeredAt = t;
        // A replayed FAILURE is not a returned result: the shipped loop counts only a cached success
        // as executed, so an iteration of cached failures is blocked there too.
        if (row.data["success"] !== true) blocked += 1;
      }
    }
    if (blocked === iteration.length) {
      blockedInARow += 1;
      refusedInStreak ||= refusedHere;
    } else {
      blockedInARow = 0;
      refusedInStreak = false;
    }
    // BLOCKED_TOOL_ITERATION_THRESHOLD in agent/sub-agent.ts: the second blocked iteration in a row ends
    // the run. Without a refusal in the streak the run stopped itself there, as the log shows.
    if (blockedInARow >= 2) {
      const last = iteration.at(-1)!;
      const stopAt = refusedInStreak ? { call: callNumber, s: (at(last) - startMs) / 1000, tool: String(last.data["tool"] ?? "-") } : null;
      return { firstAt, stopAt, refusals };
    }
  }
  return { firstAt, stopAt: null, refusals };
}

/** The supervisor over one run, sampled at fixed windows; `brake` selects the rule set. Its first
 *  wind-down, else its first 'ask' (advisory: the run goes on after one, and so does the replay). */
function replaySupervisor(run: RunRows, startMs: number, endMs: number, brake: boolean): { verdict: string; action: string; s: number } | null {
  let firstAsk: { verdict: string; action: string; s: number } | null = null;
  const seen = new Set<string>();
  const paths = new Set<string>();
  const writeHashes = new Set<string>();
  let novel = 0;
  let successful = 0;
  let attempted = 0;
  let next = 0;
  let prev: ProgressSample = EMPTY_PROGRESS_SAMPLE;
  let stalls = 0;
  let busyStalls = 0;
  for (let w = startMs + PROGRESS_CHECK_INTERVAL_MS; w <= endMs; w += PROGRESS_CHECK_INTERVAL_MS) {
    for (; next < run.tools.length && at(run.tools[next]!) <= w; next += 1) {
      const row = run.tools[next]!;
      attempted += 1;
      const executed = row.data["cachedResult"] !== true && typeof row.data["skippedReason"] !== "string";
      if (!executed || row.data["success"] !== true) continue;
      successful += 1;
      const key = `${String(row.data["tool"])}\u0000${preview(row)}`;
      if (!seen.has(key)) {
        seen.add(key);
        novel += 1;
      }
      if (isSuccessfulWrite(row)) {
        paths.add(writtenPath(row));
        writeHashes.add(`${writtenPath(row)}\u0000${JSON.stringify(row.data["args"] ?? {})}`);
      }
    }
    const cur: ProgressSample = {
      ...EMPTY_PROGRESS_SAMPLE,
      productiveToolCalls: brake ? novel : successful,
      attemptedToolCalls: attempted,
      mutatedPaths: paths.size,
      distinctWriteHashes: writeHashes.size,
    };
    const decision = classifyRunProgress(prev, cur, stalls, busyStalls, brake);
    stalls = decision.consecutiveStalls;
    busyStalls = decision.consecutiveBusyStalls;
    prev = cur;
    if (decision.action === "wind_down") return { verdict: decision.verdict, action: decision.action, s: (w - startMs) / 1000 };
    if (decision.action === "ask") firstAsk ??= { verdict: decision.verdict, action: decision.action, s: (w - startMs) / 1000 };
  }
  return firstAsk;
}

export function replayLoopBrake(rows: readonly AuditRow[]): LoopReplayReport {
  const runs: ReplayedRun[] = groupRuns(rows).map((run) => {
    const startMs = run.startMs ?? at(run.tools[0]!);
    const endMs = run.endMs ?? at(run.tools.at(-1)!);
    const refusal = replayRefusals(run, startMs);
    const before = replaySupervisor(run, startMs, endMs, false);
    const after = replaySupervisor(run, startMs, endMs, true);
    const durationS = (endMs - startMs) / 1000;
    // The brake's wind-down is one the old rule did not make, or made later: a stall both rules wind
    // down at the same window is not the brake's doing.
    const brakeWindDownS = after?.action === "wind_down" && !(before?.action === "wind_down" && before.s <= after.s) ? after.s : null;
    const ownStop = run.ownStops.find((stop) => stop >= startMs);
    const realStopS = ownStop !== undefined ? Math.min(durationS, (ownStop - startMs) / 1000) : durationS;
    const stops = [refusal.stopAt?.s, brakeWindDownS ?? undefined].filter((s): s is number => s !== undefined);
    const savedS = stops.length > 0 ? Math.max(0, realStopS - Math.min(...stops)) : 0;
    return {
      sessionId: run.sessionId,
      agentName: run.agentName,
      outcome: run.outcome,
      durationS: round1(durationS),
      calls: run.tools.length,
      executed: run.tools.filter((row) => row.data["cachedResult"] !== true && typeof row.data["skippedReason"] !== "string").length,
      refusal: {
        firstAt: refusal.firstAt ? { ...refusal.firstAt, s: round1(refusal.firstAt.s) } : null,
        stopAt: refusal.stopAt ? { ...refusal.stopAt, s: round1(refusal.stopAt.s) } : null,
        refusals: refusal.refusals,
      },
      supervisor: { before, after, brakeWindDownS },
      realStopS: round1(realStopS),
      savedS: round1(savedS),
    };
  });
  const success = (run: ReplayedRun) => run.outcome === "success";
  return {
    runs,
    summary: {
      runs: runs.length,
      runsWithRefusal: runs.filter((run) => run.refusal.firstAt).length,
      runsWithStop: runs.filter((run) => run.refusal.stopAt).length,
      stopsOnSuccess: runs.filter((run) => run.refusal.stopAt && success(run)).length,
      windDownsAfter: runs.filter((run) => run.supervisor.brakeWindDownS !== null).length,
      windDownsAfterOnSuccess: runs.filter((run) => run.supervisor.brakeWindDownS !== null && success(run)).length,
      savedS: round1(runs.reduce((sum, run) => sum + run.savedS, 0)),
      healthyLongRuns: runs.filter((run) => success(run) && run.calls >= 20).length,
    },
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

const fmt = (point: { s: number } | null | undefined, extra = ""): string => (point ? `${point.s} s${extra}` : "—");

/** The report as Markdown: ids, agent and tool names, counts and seconds only. */
export function renderLoopReplayMarkdown(report: LoopReplayReport, inputs: { files: string[]; rows: number }): string {
  const s = report.summary;
  const lines = [
    "# Loop brake replay",
    "",
    `Input: ${inputs.files.length} file(s), ${inputs.rows} row(s), ${s.runs} sub-agent run(s) with tool calls.`,
    "",
    "Upper bounds on causes the log shows: a run stopped earlier might have gone differently afterwards. The refusal is keyed on "
      + "tool + arguments + success + result preview and restarts at every successful write; the supervisor is sampled at fixed "
      + `${PROGRESS_CHECK_INTERVAL_MS / 1000} s windows from each run's start (see agent/loop-replay.ts for every reconstruction).`,
    "",
    `- Runs with a refusal: ${s.runsWithRefusal}; stopped by the brake: ${s.runsWithStop}; of those, runs that ended in success: **${s.stopsOnSuccess}**.`,
    `- Busy-stall (or earlier) wind-downs the brake adds: ${s.windDownsAfter}; on runs that ended in success: **${s.windDownsAfterOnSuccess}**.`,
    `- Working time after the brake's first stop, up to the run's own stop, summed over runs (parallel runs add up past the wall clock): ${s.savedS} s.`,
    `- Runs that ended in success with 20 or more calls: ${s.healthyLongRuns}${s.healthyLongRuns < 5 ? " — too few to estimate a false-alarm rate from this log." : "."}`,
    "",
    "A stop with no refusal in its blocked iterations is the run's own (it is in the log) and is not listed. \"Own stop\" is the run's "
      + "blocked-iteration stop or supervisor wind-down in the log, else its end.",
    "",
    "| run | agent | outcome | s | calls | executed | 1st refusal | brake stop | refusals | supervisor before | supervisor after | own stop s | saved s |",
    "|---|---|---|---:|---:|---:|---|---|---:|---|---|---:|---:|",
  ];
  for (const run of report.runs) {
    const id = run.sessionId.split(":").at(-1) ?? run.sessionId;
    const sup = (d: { verdict: string; action: string; s: number } | null) => (d ? `${d.action} (${d.verdict}) at ${d.s} s` : "—");
    lines.push(`| ${id} | ${run.agentName} | ${run.outcome ?? "?"} | ${run.durationS} | ${run.calls} | ${run.executed} | `
      + `${fmt(run.refusal.firstAt, run.refusal.firstAt ? `, call ${run.refusal.firstAt.call} ${run.refusal.firstAt.tool}` : "")} | `
      + `${fmt(run.refusal.stopAt, run.refusal.stopAt ? `, call ${run.refusal.stopAt.call}` : "")} | ${run.refusal.refusals} | `
      + `${sup(run.supervisor.before)} | ${sup(run.supervisor.after)} | ${run.realStopS} | ${run.savedS} |`);
  }
  return `${lines.join("\n")}\n`;
}
