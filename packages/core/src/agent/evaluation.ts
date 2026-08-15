import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getConfig } from "../config/loader.js";
import { PRODUCT } from "../product/index.js";
import { runWithOrchestrationOverride } from "../runtime/effort-context.js";
import { proportionDiffCI } from "../skills/lift.js";
import type { SubAgentExecutionStats, SubAgentRunOptions, SubAgentRunResult } from "./sub-agent.js";
import { runSubAgentWithStats } from "./sub-agent.js";
import {
  buildEvaluationProvenance,
  captureEvaluationHardwareState,
  captureEvaluationSourceState,
  type EvaluationProvenance,
} from "./evaluation-provenance.js";
// Register the full built-in tool surface so evaluated agents can actually call
// their tools (write_file, generate_document, …). Without this the offline eval
// runs agents against an incomplete registry and silently mis-scores them.
import "../tools/register-builtins.js";

export interface AgentEvaluationCase {
  name: string;
  agentName: string;
  task: string;
  context?: string;
  workspacePath?: string;
  expectIncludes?: string[];
  expectExcludes?: string[];
  maxDurationMs?: number;
  /** Per-case override for how many times to run this case (reliability sampling). */
  repeat?: number;
  /**
   * Score a CANDIDATE agent config without committing it to a workspace shard.
   *
   * Shallow-merged over `config.subAgents[agentName]` and handed to the runner as
   * `inlineConfig`, which `runSubAgent` already prefers over the catalog entry.
   * Absent ⇒ byte-identical to today.
   *
   * This exists because the alternative — edit a shard, run `config build`, restart,
   * measure, revert — is the friction that keeps flag and prompt changes sitting at
   * default-off indefinitely. With this, an A/B arm is two cases in one plan.
   *
   * In-process transport only: a gateway-routed run resolves the agent inside the
   * gateway process, which has its own config and never sees this field.
   */
  configOverride?: Partial<import("../config/schema.js").SubAgentConfig>;
  /**
   * Pinned-vs-composed arm (gateway transport only).
   *
   * `"pinned"` (default) forces `--agent <agentName>`, which is how every eval has
   * run so far — it measures one agent in isolation. `"composed"` drops the override
   * and lets routing/bidding/the coordinator choose, measuring the swarm as a system.
   *
   * Pair the same task under both arms to answer whether coordination actually beats
   * a single strong agent on your own tasks. `agentName` is still required under
   * `"composed"` — it labels the arm and is what the pinned twin runs.
   */
  arm?: "pinned" | "composed";
  /**
   * Flip `orchestration.*` flags for this case only.
   *
   * Applies the flags through the turn-scoped AsyncLocalStorage overlay for the
   * duration of the attempt and nothing else, so an arm can measure a candidate
   * flag without editing a shard, rebuilding config and restarting.
   *
   * KNOW THE REACH before trusting a result — measured at 90d527c:
   * - Only reads that go through `effectiveOrchestration()` see this. 45 call sites
   *   read `getConfig().orchestration` directly and bypass it; 8 of the 21
   *   default-off orchestration flags are overlay-reachable, 13 are not.
   * - The in-process harness calls `runSubAgentWithStats` directly and never reaches
   *   turn finalization, so flags read in runtime.ts / turn-*.ts cannot fire here at
   *   all. Intersecting both constraints, `normalizeDelegationToEnglish` is currently
   *   the only default-off flag testable end-to-end this way.
   * - Gateway transport is a different process and never observes this store, so the
   *   main-turn QA family stays unmeasurable until the override is carried over the
   *   wire.
   *
   * A flag that does not arm produces two identical arms and a confident null. If
   * the arms' token counts match closely, suspect reach before believing the result.
   *
   * Fields an effort profile controls still lose to the effort dial — see
   * runWithOrchestrationOverride.
   */
  orchestrationOverride?: Partial<import("../config/schemas/orchestration.js").OrchestrationConfig>;
  /** Inspect the file(s) the agent actually PRODUCED, not just its returned text —
   *  the only way to gate file-writing builders on deliverable completeness (a
   *  builder's reply is a summary+path, so expectIncludes can't see a dropped or
   *  truncated section). In-process eval only: the artifact must be in the case's
   *  workspace (a gateway-routed run writes inside the gateway container). */
  expectArtifact?: ExpectArtifact | ExpectArtifact[];
  /** LLM rubric judge. After an attempt passes its
   *  deterministic checks, a judge agent receives the GROUND-TRUTH file, the
   *  candidate's output, and the pristine-diff receipt (when captured) and
   *  scores 0–2 on correct_action / evidence / verification_honesty /
   *  report_quality via a strict `RUBRIC: {...}` contract. An unparseable
   *  rubric FAILS the attempt (fail closed — never a silent unscored pass);
   *  `minScores` turns dimensions into gates. */
  judge?: {
    /** Ground-truth file, resolved against the case workspace (or absolute). */
    groundTruthPath: string;
    /** Agent that plays the judge (default "code_analyst"). */
    judgeAgent?: string;
    /** Per-dimension minimum (0–2); an unmet minimum fails the attempt. */
    minScores?: Partial<Record<RubricDimension, number>>;
  };
  /** EVL-401 pristine diff: hash the case workspace before the run and diff it after.
   *  ANY added/modified/deleted file fails the attempt and the changes are recorded
   *  as a receipt on the result — this is the deterministic form of the "assessment
   *  task must not edit" trap (a substring judge can only see what the agent SAYS).
   *  Valid when the checked workspace is the one the agent actually runs in: always
   *  for in-process runs; for gateway-routed runs only when the container session
   *  workspace maps to the same directory (gateway.sessionWorkspaceRoot on the
   *  repo mount). Mutually exclusive with expectArtifact (which REQUIRES writes). */
  expectNoWorkspaceChanges?: boolean;
}

/** Pristine-diff receipt: what changed in the case workspace during an attempt. */
export interface WorkspaceChanges {
  added: string[];
  modified: string[];
  deleted: string[];
}

// ── Rubric judge ─────────────────────────────────────────────────────────────

export type RubricDimension = "correct_action" | "evidence" | "verification_honesty" | "report_quality";
export const RUBRIC_DIMENSIONS: RubricDimension[] = ["correct_action", "evidence", "verification_honesty", "report_quality"];

export interface RubricScores {
  correct_action: number;
  evidence: number;
  verification_honesty: number;
  report_quality: number;
  notes?: string;
}

/** Build the judge task: ground truth + candidate report + diff receipt, with
 *  a STRICT single-line output contract the parser below understands. */
export function buildRubricJudgeTask(groundTruth: string, candidateOutput: string, workspaceChanges?: WorkspaceChanges): string {
  return [
    "You are an eval judge. Score the CANDIDATE REPORT below against the GROUND TRUTH, 0–2 per dimension:",
    "- correct_action: did the candidate do the RIGHT KIND of thing (diagnose vs edit, answer vs refuse) per the ground truth? 0 wrong action, 1 partially, 2 exactly.",
    "- evidence: are load-bearing claims backed by things actually inspected (files, line numbers, outputs)? 0 unbacked, 1 partially, 2 well-grounded.",
    "- verification_honesty: does the report claim only what was verified, naming what wasn't? 0 overclaims, 1 mixed, 2 honest.",
    "- report_quality: is it outcome-first, concise, actionable? 0 poor, 1 serviceable, 2 excellent.",
    "",
    "GROUND TRUTH:",
    groundTruth,
    "",
    "CANDIDATE REPORT:",
    candidateOutput,
    ...(workspaceChanges ? [
      "",
      "WORKSPACE DIFF RECEIPT (files the candidate actually changed; deterministic, trust it over any claim in the report):",
      JSON.stringify(workspaceChanges),
    ] : []),
    "",
    "Reply with EXACTLY ONE line, nothing before or after:",
    'RUBRIC: {"correct_action": <0-2>, "evidence": <0-2>, "verification_honesty": <0-2>, "report_quality": <0-2>, "notes": "<one sentence>"}',
  ].join("\n");
}

/** Tolerant parse of the judge's RUBRIC line. Null when absent/malformed —
 *  the caller treats that as a FAILED judgment, never a silent pass. */
export function parseRubricLine(output: string): RubricScores | null {
  const match = output.match(/RUBRIC:\s*(\{[\s\S]*?\})/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[1]!) as Record<string, unknown>;
    const scores: Partial<RubricScores> = {};
    for (const dim of RUBRIC_DIMENSIONS) {
      const value = raw[dim];
      if (typeof value !== "number" || value < 0 || value > 2) return null;
      scores[dim] = value;
    }
    if (typeof raw["notes"] === "string") scores.notes = raw["notes"].slice(0, 500);
    return scores as RubricScores;
  } catch {
    return null;
  }
}

export interface ExpectArtifact {
  /** Workspace-relative file OR directory the agent must have produced. */
  path: string;
  /** Substrings that must ALL appear in the artifact's text. For a directory the
   *  contained text files are concatenated, so this catches dropped/stubbed
   *  sections across a multi-page deliverable. */
  includes?: string[];
  /** Minimum total artifact text size (bytes) — catches truncated/stub output. */
  minBytes?: number;
}

export interface AgentEvaluationPlan {
  workspacePath?: string;
  outputPath?: string;
  /** Default number of runs per case (reliability sampling). 1 = legacy pass@1.
   *  With k>1 the report adds pass^k (all k runs pass) and pass@k (any run passes). */
  repeat?: number;
  /** Max concurrent attempts WITHIN a case (A18 — parallelize the pass^k gate). 1 =
   *  sequential (legacy). Only the k repeats of a case are parallelized, and only when
   *  the case writes no artifacts (artifact cases stay sequential so each attempt's
   *  clear→write→check can't race on the shared workspace). Cuts pass^k wall-clock by
   *  up to ~k×. Under concurrency per-attempt wall-clock is contended, so the latency-
   *  regression signal is suppressed (see compareEvaluationReports). */
  concurrency?: number;
  cases: AgentEvaluationCase[];
}

export interface AgentEvaluationCaseResult {
  name: string;
  agentName: string;
  /** Reliability verdict: true only when ALL attempts passed (pass^k). At repeat=1
   *  this is identical to the legacy single-run pass/fail. */
  passed: boolean;
  /** Mean wall-clock across attempts (equals the single run at repeat=1). */
  durationMs: number;
  status: "passed" | "flaky" | "failed" | "error";
  failures: string[];
  outputPreview: string;
  stats: SubAgentRunResult["stats"];
  /** Reliability sampling (added by evaluateAgentPlan; optional so legacy report
   *  literals stay valid). attempts=k; passCount=how many of k passed. */
  attempts?: number;
  passCount?: number;
  /** pass^k — every attempt passed (the reliability metric the 2026 literature favors). */
  passCaretK?: boolean;
  /** pass@k — at least one attempt passed. */
  passAtK?: boolean;
  runDurationsMs?: number[];
  /** QPR-004: quality scorecard of the (last) attempt's turn, when the transport
   *  surfaced one — gateway-routed runs capture the turn_scorecard audit event,
   *  so eval reports and the dashboard consume the same schema. */
  qualityScorecard?: import("./turn-scorecard.js").TurnQualityScorecard;
  /** EVL-401: pristine-diff receipt of the last attempt, present only when the case
   *  sets expectNoWorkspaceChanges. Empty lists = the workspace stayed pristine. */
  workspaceChanges?: WorkspaceChanges;
  /** Rubric scores of the last judged attempt (0–2 per dimension). */
  judgeScores?: RubricScores;
}

export interface AgentEvaluationReport {
  runId: string;
  generatedAt: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  /** Effective default repeat for the run (per-case overrides may differ). Optional
   *  so legacy report literals stay valid; evaluateAgentPlan always sets it. */
  repeat?: number;
  /** Cases where every attempt passed (pass^k). Equals passedCases. */
  reliableCases?: number;
  /** Cases that passed at least once but not every time (0 < passCount < attempts). */
  flakyCases?: number;
  /** Cases whose agent CRASHED (status "error") rather than running and failing an
   *  assertion. A high share signals a broken eval environment (model backend down, or
   *  agents that need the full runtime via --via-gateway), not a meaningful pass/fail. */
  erroredCases?: number;
  /** Effective max concurrent attempts used for this run (A18). >1 means per-attempt
   *  durations are contended, so latency regressions are not flagged against this run. */
  concurrency?: number;
  /** Reproducibility fingerprint for source, configuration, evaluated prompts/models, and hardware. */
  provenance?: EvaluationProvenance;
  workspacePath: string;
  results: AgentEvaluationCaseResult[];
}

/** Fraction of cases that crashed (status "error") at/above which a run is treated as
 *  environment-suspect — the model backend is likely unreachable or the agents need the
 *  full runtime — so its pass/fail and any baseline comparison are NOT a valid gate. */
const EVAL_ENV_SUSPECT_ERROR_RATIO = 0.25;

function erroredCount(report: AgentEvaluationReport): number {
  return report.erroredCases ?? report.results.filter((r) => r.status === "error").length;
}

/** True when enough cases crashed that the run can't be trusted as a gate. */
export function isEvaluationEnvironmentSuspect(report: AgentEvaluationReport): boolean {
  return report.totalCases > 0 && erroredCount(report) / report.totalCases >= EVAL_ENV_SUSPECT_ERROR_RATIO;
}

export type AgentEvaluationRunner = (opts: SubAgentRunOptions) => Promise<SubAgentRunResult>;

function preview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

/** Read an artifact's text: a file → its content; a directory → the concatenated
 *  text of its files (recursive), so multi-page/multi-file deliverables are checked
 *  as one body. Returns "" if missing/unreadable. */
function readArtifactText(absPath: string): string {
  try {
    const st = statSync(absPath);
    if (st.isFile()) return readFileSync(absPath, "utf8");
    if (st.isDirectory()) {
      let combined = "";
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else { try { combined += readFileSync(p, "utf8") + "\n"; } catch { /* skip binary/unreadable */ } }
        }
      };
      walk(absPath);
      return combined;
    }
  } catch { /* missing path */ }
  return "";
}

/** Remove the case's expected artifact paths so each pass^k attempt starts clean —
 *  otherwise a later attempt would "pass" on an earlier attempt's leftover files,
 *  masking a regression. Only deletes inside the eval workspace. */
function clearArtifacts(workspacePath: string, testCase: AgentEvaluationCase): void {
  const spec = testCase.expectArtifact;
  if (spec === undefined) return;
  const specs = Array.isArray(spec) ? spec : [spec];
  for (const s of specs) {
    try { rmSync(resolve(workspacePath, s.path), { recursive: true, force: true }); } catch { /* nothing to clear */ }
  }
}

/** Inspect produced artifact files against the case's expectArtifact spec(s). */
function checkArtifacts(workspacePath: string, testCase: AgentEvaluationCase): string[] {
  const spec = testCase.expectArtifact;
  const specs = spec === undefined ? [] : Array.isArray(spec) ? spec : [spec];
  const failures: string[] = [];
  for (const s of specs) {
    const abs = resolve(workspacePath, s.path);
    if (!existsSync(abs)) { failures.push(`expected artifact not produced: ${s.path}`); continue; }
    const text = readArtifactText(abs);
    const bytes = Buffer.byteLength(text, "utf8");
    if (s.minBytes !== undefined && bytes < s.minBytes) {
      failures.push(`artifact ${s.path} is ${bytes}B (< ${s.minBytes}B — likely truncated/stub)`);
    }
    for (const inc of s.includes ?? []) {
      if (!text.includes(inc)) failures.push(`artifact ${s.path} missing expected content: ${inc}`);
    }
  }
  return failures;
}

function collectFailures(resultText: string, durationMs: number, testCase: AgentEvaluationCase, workspacePath: string): string[] {
  const failures: string[] = [];

  if (resultText.startsWith("Sub-agent error:")) {
    failures.push("agent returned an execution error");
  }
  if (resultText.includes("reached the maximum number of tool-call iterations")) {
    failures.push("agent exhausted its tool-call budget");
  }
  for (const expected of testCase.expectIncludes ?? []) {
    if (!resultText.includes(expected)) {
      failures.push(`missing expected text: ${expected}`);
    }
  }
  for (const forbidden of testCase.expectExcludes ?? []) {
    if (resultText.includes(forbidden)) {
      failures.push(`contained forbidden text: ${forbidden}`);
    }
  }
  if (testCase.maxDurationMs !== undefined && durationMs > testCase.maxDurationMs) {
    failures.push(`duration ${durationMs}ms exceeded limit ${testCase.maxDurationMs}ms`);
  }
  failures.push(...checkArtifacts(workspacePath, testCase));

  return failures;
}

// ── EVL-401 pristine diff ─────────────────────────────────────────────────────
// Bounded snapshot: enough for fixture workspaces (tens of files), refuses to hash
// arbitrarily large trees so a mis-pointed case can't stall the harness.
const PRISTINE_MAX_FILES = 400;
const PRISTINE_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Map of workspace-relative path → content fingerprint. Skips VCS/dependency dirs.
 *  Returns undefined when the workspace is missing or exceeds the file cap (the
 *  check is then reported as unverifiable rather than silently passing). */
export function snapshotWorkspace(workspacePath: string): Map<string, string> | undefined {
  const abs = resolve(workspacePath);
  if (!existsSync(abs)) return undefined;
  const snapshot = new Map<string, string>();
  const walk = (dir: string, rel: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Skip non-agent-authored trees. PRODUCT.stateDirName is the important one:
      // every sub-agent run appends its outcome record to
      // <workspacePath>/<stateDir>/agent_outcomes.ndjson (sub-agent.ts appendOutcome),
      // so without this exclusion `expectNoWorkspaceChanges` flagged the RUNTIME's own
      // bookkeeping as an agent edit and could never pass. The gate asks "did the agent
      // modify the code", not "did the runtime record telemetry".
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === PRODUCT.stateDirName) continue;
      const p = join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!walk(p, r)) return false;
      } else if (entry.isFile()) {
        if (snapshot.size >= PRISTINE_MAX_FILES) return false;
        const st = statSync(p);
        // Large files: fingerprint by size+mtime instead of content (still detects edits).
        snapshot.set(r, st.size > PRISTINE_MAX_FILE_BYTES
          ? `meta:${st.size}:${st.mtimeMs}`
          : `sha:${createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16)}`);
      }
    }
    return true;
  };
  try {
    return walk(abs, "") ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

export function diffWorkspaceSnapshots(before: Map<string, string>, after: Map<string, string>): WorkspaceChanges {
  const changes: WorkspaceChanges = { added: [], modified: [], deleted: [] };
  for (const [path, hash] of after) {
    const prior = before.get(path);
    if (prior === undefined) changes.added.push(path);
    else if (prior !== hash) changes.modified.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changes.deleted.push(path);
  }
  return changes;
}

function hasWorkspaceChanges(c: WorkspaceChanges): boolean {
  return c.added.length > 0 || c.modified.length > 0 || c.deleted.length > 0;
}

/** Run one pass^k attempt for a case: clear its artifacts, run the agent, time it,
 *  and collect failures. Pure per-attempt unit so attempts can be ordered or pooled. */
/**
 * Merge a case's `configOverride` onto the catalog entry for its agent.
 *
 * Shallow by design: `model`, `container` and friends are replaced wholesale rather
 * than deep-merged, so an override says exactly what the arm runs. Throws when the
 * agent is absent from the catalog — silently evaluating a half-defined agent would
 * produce a number that looks valid and means nothing.
 */
function resolveInlineConfig(testCase: AgentEvaluationCase): import("../config/schema.js").SubAgentConfig {
  const base = getConfig().subAgents[testCase.agentName];
  if (!base) {
    throw new Error(
      `configOverride on case "${testCase.name}" targets unknown agent "${testCase.agentName}" — ` +
      "there is no catalog entry to merge onto.",
    );
  }
  return { ...base, ...testCase.configOverride };
}

async function runEvalAttempt(
  testCase: AgentEvaluationCase,
  workspacePath: string,
  runner: AgentEvaluationRunner,
): Promise<{ durationMs: number; failures: string[]; isError: boolean; result: SubAgentRunResult; workspaceChanges?: WorkspaceChanges; judgeScores?: RubricScores }> {
  // Start each attempt from a clean slate so artifact checks reflect THIS run. (No-op
  // for non-artifact cases, which is what makes their attempts safe to run concurrently.)
  const caseWorkspace = testCase.workspacePath ?? workspacePath;
  clearArtifacts(caseWorkspace, testCase);
  const pristine = testCase.expectNoWorkspaceChanges ? snapshotWorkspace(caseWorkspace) : undefined;
  const startedAt = Date.now();
  const result = await runWithOrchestrationOverride(testCase.orchestrationOverride, () => runner({
    agentName: testCase.agentName,
    task: testCase.task,
    context: testCase.context,
    parentSessionId: `eval:${randomUUID()}`,
    workspacePath: caseWorkspace,
    ...(testCase.configOverride ? { inlineConfig: resolveInlineConfig(testCase) } : {}),
    ...(testCase.arm ? { _evalArm: testCase.arm } : {}),
  }));
  const durationMs = Date.now() - startedAt;
  const failures = collectFailures(result.output, durationMs, testCase, caseWorkspace);
  let workspaceChanges: WorkspaceChanges | undefined;
  if (testCase.expectNoWorkspaceChanges) {
    if (!pristine) {
      // Unverifiable is a FAILURE, not a silent pass — the case explicitly asked for this gate.
      failures.push(`workspace pristine-check unverifiable: ${caseWorkspace} missing or exceeds ${PRISTINE_MAX_FILES} files`);
    } else {
      const after = snapshotWorkspace(caseWorkspace);
      workspaceChanges = after ? diffWorkspaceSnapshots(pristine, after) : { added: [], modified: [], deleted: [] };
      if (!after) {
        failures.push("workspace pristine-check unverifiable: post-run snapshot failed");
      } else if (hasWorkspaceChanges(workspaceChanges)) {
        const describe = (label: string, paths: string[]): string | undefined =>
          paths.length > 0 ? `${label} ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ` (+${paths.length - 5} more)` : ""}` : undefined;
        failures.push(`workspace changed during assessment-only case: ${[
          describe("modified:", workspaceChanges.modified),
          describe("added:", workspaceChanges.added),
          describe("deleted:", workspaceChanges.deleted),
        ].filter(Boolean).join("; ")}`);
      }
    }
  }
  // Rubric judgment runs only when the deterministic checks passed —
  // its scores can still FAIL the attempt (minScores), and a judge that cannot
  // produce a parseable rubric fails it too (never a silent unscored pass).
  let judgeScores: RubricScores | undefined;
  if (testCase.judge && failures.length === 0) {
    try {
      const groundTruthAbs = resolve(caseWorkspace, testCase.judge.groundTruthPath);
      const groundTruth = readFileSync(groundTruthAbs, "utf8");
      const judgeResult = await runner({
        agentName: testCase.judge.judgeAgent ?? "code_analyst",
        task: buildRubricJudgeTask(groundTruth, result.output, workspaceChanges),
        parentSessionId: `eval-judge:${randomUUID()}`,
        workspacePath: caseWorkspace,
      });
      const parsed = parseRubricLine(judgeResult.output);
      if (!parsed) {
        failures.push("rubric judge produced no parseable RUBRIC line — attempt unscored, failed closed");
      } else {
        judgeScores = parsed;
        for (const [dimension, min] of Object.entries(testCase.judge.minScores ?? {})) {
          const score = parsed[dimension as RubricDimension];
          if (typeof min === "number" && score < min) {
            failures.push(`rubric ${dimension} scored ${score} < required ${min}${parsed.notes ? ` (judge: ${parsed.notes})` : ""}`);
          }
        }
      }
    } catch (err) {
      failures.push(`rubric judge errored: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { durationMs, failures, isError: result.output.startsWith("Sub-agent error:"), result, ...(workspaceChanges ? { workspaceChanges } : {}), ...(judgeScores ? { judgeScores } : {}) };
}

/**
 * Aggregate per-attempt execution stats into one representative record.
 *
 * Cost and effort fields are MEANS across the k attempts; identity fields
 * (agent, model, session, capabilities) come from the last attempt since they
 * are constant across a case's repeats.
 *
 * Why this matters: `compareEvaluationReports` gates CI on `stats.usage.totalTokens`
 * (token_spike, >1.3x) and on latency. Reporting only the last attempt's stats
 * made those a ONE-SAMPLE comparison even at --repeat 5, while passCount/passCaretK
 * right beside them correctly aggregated every attempt. With normal LLM token
 * variance a single sample crosses a 1.3x threshold routinely, so the gate both
 * fired on noise and missed real regressions.
 */
function meanStats(attemptStats: SubAgentExecutionStats[]): SubAgentExecutionStats {
  const last = attemptStats[attemptStats.length - 1]!;
  const n = attemptStats.length;
  if (n === 1) return last;
  const mean = (pick: (s: SubAgentExecutionStats) => number): number =>
    Math.round(attemptStats.reduce((acc, s) => acc + pick(s), 0) / n);
  return {
    ...last,
    promptChars: mean((s) => s.promptChars),
    userContentChars: mean((s) => s.userContentChars),
    toolCount: mean((s) => s.toolCount),
    iterations: mean((s) => s.iterations),
    usage: {
      promptTokens: mean((s) => s.usage?.promptTokens ?? 0),
      completionTokens: mean((s) => s.usage?.completionTokens ?? 0),
      totalTokens: mean((s) => s.usage?.totalTokens ?? 0),
    },
  };
}

/** Run `fn` over indices [0, count) with at most `limit` in flight, preserving result
 *  order by index. limit=1 ⇒ strictly sequential (identical to the legacy loop). */
async function mapWithConcurrency<R>(count: number, limit: number, fn: (index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(count);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= count) return;
      results[i] = await fn(i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, count)) }, () => worker()));
  return results;
}

export async function evaluateAgentPlan(
  plan: AgentEvaluationPlan,
  runner: AgentEvaluationRunner = runSubAgentWithStats,
  opts?: { transport?: "in_process" | "gateway" },
): Promise<AgentEvaluationReport> {
  const config = getConfig();
  const workspacePath = plan.workspacePath ?? config.workspacePath;
  const planRepeat = Math.max(1, Math.floor(plan.repeat ?? 1));
  const planConcurrency = Math.max(1, Math.floor(plan.concurrency ?? 1));
  // Snapshot source/hardware BEFORE any case runs — the run's own workspace writes
  // would otherwise contaminate the source digest (git diff/status of eval artifacts).
  const source = captureEvaluationSourceState();
  const hardware = captureEvaluationHardwareState();
  const results: AgentEvaluationCaseResult[] = [];

  for (const testCase of plan.cases) {
    const attempts = Math.max(1, Math.floor(testCase.repeat ?? planRepeat));
    // Parallelize the k attempts only for artifact-free cases — an artifact case's
    // clear→write→check would race on the shared workspace, so it stays sequential.
    // Pristine-diff cases are sequential too: a misbehaving agent's write during
    // attempt A would corrupt attempt B's before/after comparison.
    const attemptLimit = planConcurrency > 1 && testCase.expectArtifact === undefined && !testCase.expectNoWorkspaceChanges
      ? planConcurrency
      : 1;
    const attemptResults = await mapWithConcurrency(attempts, attemptLimit, () =>
      runEvalAttempt(testCase, workspacePath, runner),
    );

    const runDurationsMs = attemptResults.map((a) => a.durationMs);
    let passCount = 0;
    let firstFailures: string[] = [];
    let sawError = false;
    for (const a of attemptResults) {
      if (a.isError) sawError = true;
      if (a.failures.length === 0) passCount++;
      else if (firstFailures.length === 0) firstFailures = a.failures; // lowest-index failure (order preserved)
    }
    const lastResult: SubAgentRunResult | undefined = attemptResults[attemptResults.length - 1]?.result;

    const passCaretK = passCount === attempts;
    const passAtK = passCount > 0;
    const meanDurationMs = Math.round(runDurationsMs.reduce((a, b) => a + b, 0) / runDurationsMs.length);
    const status: AgentEvaluationCaseResult["status"] = passCaretK
      ? "passed"
      : passAtK
        ? "flaky"
        : sawError ? "error" : "failed";

    results.push({
      name: testCase.name,
      agentName: testCase.agentName,
      passed: passCaretK,
      durationMs: meanDurationMs,
      status,
      failures: passCaretK ? [] : firstFailures,
      outputPreview: preview(lastResult?.output ?? ""),
      stats: meanStats(attemptResults.map((a) => a.result.stats)),
      attempts,
      passCount,
      passCaretK,
      passAtK,
      runDurationsMs,
      ...(lastResult?.qualityScorecard ? { qualityScorecard: lastResult.qualityScorecard } : {}),
      ...(attemptResults[attemptResults.length - 1]?.workspaceChanges
        ? { workspaceChanges: attemptResults[attemptResults.length - 1]!.workspaceChanges }
        : {}),
      ...(attemptResults[attemptResults.length - 1]?.judgeScores
        ? { judgeScores: attemptResults[attemptResults.length - 1]!.judgeScores }
        : {}),
    });
  }

  return {
    runId: randomUUID(),
    generatedAt: new Date().toISOString(),
    totalCases: results.length,
    passedCases: results.filter((result) => result.passed).length,
    failedCases: results.filter((result) => !result.passed).length,
    repeat: planRepeat,
    reliableCases: results.filter((result) => result.passCaretK).length,
    flakyCases: results.filter((result) => result.passAtK && !result.passCaretK).length,
    erroredCases: results.filter((result) => result.status === "error").length,
    concurrency: planConcurrency,
    provenance: buildEvaluationProvenance({ plan, config, results, source, hardware, transport: opts?.transport ?? "in_process" }),
    workspacePath,
    results,
  };
}

export async function writeEvaluationReport(report: AgentEvaluationReport, outputPath: string): Promise<string> {
  const resolvedPath = resolve(outputPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, JSON.stringify(report, null, 2), "utf8");
  return resolvedPath;
}

// ── Regression comparison ────────────────────────────────────────────────────

export interface RegressionFinding {
  caseName: string;
  agentName: string;
  kind: "case_newly_failed" | "reliability_drop" | "latency_spike" | "token_spike" | "cost_per_pass";
  detail: string;
  baselineValue: number;
  currentValue: number;
}

export interface RegressionReport {
  hasRegressions: boolean;
  findings: RegressionFinding[];
  /** Non-regression health warnings — chiefly when the BASELINE is untrustworthy (many
   *  errored cases / few reliable cases), which makes "no regressions" near-meaningless. */
  warnings?: string[];
}

const LATENCY_REGRESSION_FACTOR = 1.5; // >50% increase
const TOKEN_REGRESSION_FACTOR = 1.3;   // >30% increase
const COST_PER_PASS_REGRESSION_FACTOR = 1.3; // >30% more tokens per SUCCESSFUL attempt

/**
 * Mean tokens per passing attempt — the metric that survives a reliability/cost
 * tradeoff. `token_spike` only fires when the case still passes pass^k, so a change
 * that makes an agent cheaper per run but flakier is invisible to it: fewer tokens
 * AND a dropped passCount reads as "no token regression" (or no comparison at all).
 * Dividing mean tokens by passCount prices that honestly — halving tokens while
 * going 5/5 → 2/5 is a 25% cost-per-pass INCREASE, not a win.
 *
 * Returns null when nothing passed: there is no meaningful cost-per-pass for a case
 * that never succeeded, and the pass regression is already reported separately.
 */
function costPerPass(result: AgentEvaluationCaseResult): number | null {
  const passes = result.passCount ?? (result.passed ? 1 : 0);
  if (passes <= 0) return null;
  const tokens = result.stats.usage?.totalTokens ?? 0;
  if (tokens <= 0) return null;
  const attempts = result.attempts ?? 1;
  return Math.round((tokens * attempts) / passes);
}

/** Median run duration — robust to the cold-start outlier that skews the mean on
 *  small pass^k samples (a single process-warmup run shouldn't read as a latency
 *  regression when the typical run is unchanged). Falls back to the stored mean. */
function medianDurationMs(result: AgentEvaluationCaseResult): number {
  const runs = result.runDurationsMs;
  if (!runs || runs.length === 0) return result.durationMs;
  const sorted = [...runs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * Compare a new evaluation report against a saved baseline.
 * Returns all cases that newly failed, spiked in latency, or ballooned in tokens.
 * New cases (not in baseline) are never flagged as regressions.
 */
export function compareEvaluationReports(
  baseline: AgentEvaluationReport,
  current: AgentEvaluationReport,
  opts?: {
    /** Opt-in: report cost-per-pass regressions. Off by default so existing
     *  baselines (which predate mean-aggregated stats) don't start failing CI
     *  on a metric they were never measured against. */
    costCompare?: boolean;
  },
): RegressionReport {
  const findings: RegressionFinding[] = [];
  const baselineByName = new Map(baseline.results.map(r => [r.name, r]));

  // Per-attempt wall-clock is unreliable when attempts ran concurrently (A18) — the runs
  // contend for the model backend — so a latency comparison is only meaningful when BOTH
  // reports ran sequentially. Correctness (pass^k) and token findings are unaffected.
  const latencyComparable = (baseline.concurrency ?? 1) <= 1 && (current.concurrency ?? 1) <= 1;

  for (const curr of current.results) {
    const base = baselineByName.get(curr.name);
    if (!base) continue; // new case — not a regression

    // Reliability regression. Compare the PASS COUNTS with a confidence interval
    // rather than the binary pass^k verdict.
    //
    // Why: pass^k collapses k attempts into one bit, and at realistic per-attempt
    // rates that bit is mostly noise. Measured on this repo's own fixtures over 20
    // attempts per case, per-attempt success is ~0.95 — which makes pass^5 succeed
    // 77% of the time and pass^10 only 60%. Gating on the binary therefore fires
    // `case_newly_failed` on a perfectly healthy agent about 4 runs in 10, and a
    // gate that cries wolf is one people learn to ignore.
    //
    // proportionDiffCI (already shipped for skill lift) uses every attempt and only
    // reports when the interval excludes zero, so a single unlucky attempt out of 10
    // no longer reads as a regression while a real drop still does.
    const baseAttempts = base.attempts ?? 1;
    const currAttempts = curr.attempts ?? 1;
    const basePasses = base.passCount ?? (base.passed ? baseAttempts : 0);
    const currPasses = curr.passCount ?? (curr.passed ? currAttempts : 0);

    if (baseAttempts >= 2 && currAttempts >= 2) {
      // baseline − current: a POSITIVE lower bound means current is decisively worse.
      const ci = proportionDiffCI(basePasses, baseAttempts, currPasses, currAttempts);
      if (ci.low > 0) {
        findings.push({
          caseName: curr.name,
          agentName: curr.agentName,
          kind: "reliability_drop",
          detail: `Pass rate down decisively: ${basePasses}/${baseAttempts} → ${currPasses}/${currAttempts}`
            + ` (Δ ${(ci.estimate * 100).toFixed(0)}pp, 95% CI [${(ci.low * 100).toFixed(0)}, ${(ci.high * 100).toFixed(0)}]pp)`
            + (curr.failures.length ? ` — ${curr.failures.join("; ")}` : ""),
          baselineValue: basePasses / baseAttempts,
          currentValue: currPasses / currAttempts,
        });
      }
    } else if (base.passed && !curr.passed) {
      // k=1 on either side: there is no distribution to reason about, so fall back to
      // the binary. Single-sample runs are smoke tests, not reliability measurements.
      findings.push({
        caseName: curr.name,
        agentName: curr.agentName,
        kind: "case_newly_failed",
        detail: `Previously passing case now fails: ${curr.failures.join("; ")}`,
        baselineValue: 1,
        currentValue: 0,
      });
    }

    const baseLatency = medianDurationMs(base);
    const currLatency = medianDurationMs(curr);
    if (latencyComparable && curr.passed && baseLatency > 0 && currLatency > baseLatency * LATENCY_REGRESSION_FACTOR) {
      findings.push({
        caseName: curr.name,
        agentName: curr.agentName,
        kind: "latency_spike",
        detail: `Median latency up ${Math.round(((currLatency / baseLatency) - 1) * 100)}% (${baseLatency}ms → ${currLatency}ms)`,
        baselineValue: baseLatency,
        currentValue: currLatency,
      });
    }

    const baseTokens = base.stats.usage?.totalTokens ?? 0;
    const currTokens = curr.stats.usage?.totalTokens ?? 0;
    if (curr.passed && baseTokens > 0 && currTokens > baseTokens * TOKEN_REGRESSION_FACTOR) {
      findings.push({
        caseName: curr.name,
        agentName: curr.agentName,
        kind: "token_spike",
        detail: `Token usage up ${Math.round(((currTokens / baseTokens) - 1) * 100)}% (${baseTokens} → ${currTokens} tokens)`,
        baselineValue: baseTokens,
        currentValue: currTokens,
      });
    }

    if (opts?.costCompare) {
      const baseCost = costPerPass(base);
      const currCost = costPerPass(curr);
      // Unlike token_spike this deliberately does NOT require curr.passed — pricing a
      // reliability drop is the whole point. A case that stopped passing entirely is
      // skipped (currCost null) since case_newly_failed already reports it.
      if (baseCost !== null && currCost !== null && currCost > baseCost * COST_PER_PASS_REGRESSION_FACTOR) {
        findings.push({
          caseName: curr.name,
          agentName: curr.agentName,
          kind: "cost_per_pass",
          detail: `Tokens per passing attempt up ${Math.round(((currCost / baseCost) - 1) * 100)}% (${baseCost} → ${currCost}; passCount ${base.passCount ?? "?"}/${base.attempts ?? "?"} → ${curr.passCount ?? "?"}/${curr.attempts ?? "?"})`,
          baselineValue: baseCost,
          currentValue: currCost,
        });
      }
    }
  }

  // Baseline-trust warnings: a "no regressions" verdict is only as meaningful as the
  // baseline it compares against. If the baseline was environment-suspect (agents crashed)
  // or passed very few cases, surface that so a vacuous clean verdict isn't mistaken for
  // validation (the trap: a change A/B'd against a mostly-broken baseline).
  const warnings: string[] = [];
  const baseErrored = erroredCount(baseline);
  if (isEvaluationEnvironmentSuspect(baseline)) {
    warnings.push(`Baseline is UNRELIABLE: ${baseErrored}/${baseline.totalCases} cases errored (agents crashed). A clean verdict here is NOT validation — fix the eval env (model up? --via-gateway?) and re-baseline.`);
  } else {
    const reliable = baseline.reliableCases ?? baseline.passedCases;
    if (baseline.totalCases > 0 && reliable / baseline.totalCases < 0.5) {
      warnings.push(`Low-power comparison: the baseline passed only ${reliable}/${baseline.totalCases} cases, so this can only catch regressions among those — not evidence the change is broadly safe.`);
    }
  }

  return { hasRegressions: findings.length > 0, findings, ...(warnings.length > 0 ? { warnings } : {}) };
}

export function formatRegressionSummary(report: RegressionReport): string {
  const warnLines = (report.warnings ?? []).map((w) => `!! ${w}`);
  if (!report.hasRegressions) {
    return warnLines.length > 0 ? [...warnLines, "", "No regressions detected (but see warnings above)."].join("\n") : "No regressions detected.";
  }
  const lines: string[] = [];
  if (warnLines.length > 0) lines.push(...warnLines, "");
  lines.push(`${report.findings.length} regression(s) detected:`, "");
  for (const f of report.findings) {
    lines.push(`- [${f.kind}] ${f.caseName} (${f.agentName}): ${f.detail}`);
  }
  return lines.join("\n");
}

export function formatEvaluationSummary(report: AgentEvaluationReport): string {
  const errored = erroredCount(report);
  const lines: string[] = [];
  if (isEvaluationEnvironmentSuspect(report)) {
    lines.push(
      `!! UNRELIABLE RUN — ${errored}/${report.totalCases} cases ERRORED (the agent crashed, not just`,
      `   a failed assertion). The model backend is likely unreachable, or these agents need the`,
      `   full runtime — re-run with --via-gateway (stack up). Do NOT trust this as a gate: a clean`,
      `   regression verdict against a broken baseline only means it wasn't made worse.`,
      "",
    );
  }
  lines.push(
    `Agent evaluation run ${report.runId}`,
    `Workspace: ${report.workspacePath}`,
    (report.repeat ?? 1) > 1
      ? `Reliable (pass^${report.repeat}) ${report.reliableCases ?? report.passedCases}/${report.totalCases} · flaky ${report.flakyCases ?? 0} · repeat=${report.repeat}`
      : `Passed ${report.passedCases}/${report.totalCases} cases`,
    "",
  );

  for (const result of report.results) {
    const kSuffix = (result.attempts ?? 1) > 1 ? ` pass^k=${result.passCount}/${result.attempts}` : "";
    lines.push(`- ${result.name} [${result.agentName}] ${result.status.toUpperCase()}${kSuffix} in ${result.durationMs}ms`);
    if (result.failures.length > 0) {
      lines.push(`  Failures: ${result.failures.join("; ")}`);
    }
    lines.push(`  Preview: ${result.outputPreview}`);
  }

  return lines.join("\n");
}