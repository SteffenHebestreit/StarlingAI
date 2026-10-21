/**
 * Best of two for a deliverable at max effort (orchestration.bestOfTwoDeliverables).
 *
 * At the "max" effort tier, a delegation that asks for a file (a deck, a website, a report, a job's
 * output) runs twice, one run after the other, and the better result is kept. Only the
 * orchestrator's own delegations: a coordinator's delegations inside a run that is itself one of two
 * would square the cost. Chat turns, and every other tier, run once: on the local models a second run
 * doubles the time.
 *
 * The runs write to the same paths, so they cannot run at once. After each run its files are copied
 * aside; the comparison reads the copies, and the winner's files are put back where its run wrote them,
 * the loser's own files removed. First the record decides (did the run complete and deliver, do its
 * files hold up: a page that runs, JSON that parses), and only when the record cannot tell the two
 * apart a selector compares them, asked twice with the order swapped; only an answer that survives the
 * swap counts, and without one the first run stays. The second run is skipped when the time left
 * before the turn's deadline would not cover another run as long as the first.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { logAudit } from "../audit/logger.js";
import { currentEffortTier, effectiveOrchestration } from "../runtime/effort-context.js";
import { writeProblem } from "../tools/enforcement-hooks.js";
import { containedWorkspaceRealPath } from "../tools/workspace-containment.js";
import type { SubAgentRunResult } from "./sub-agent.js";

/** Above this, the files are not copied aside and the delegation runs once. */
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const REPORT_CHARS = 1_500;
const EXCERPT_CHARS = 2_500;

export type Winner = "a" | "b";

export interface Candidate {
  label: Winner;
  result: SubAgentRunResult;
  /** Workspace-relative paths of the run's files and folders. */
  paths: string[];
  /** Where its files were copied, mirroring their workspace-relative layout. */
  snapshotRoot: string;
}

export interface CandidateRecord {
  delivered: boolean;
  /** Each file that does not hold up, with why. */
  problems: string[];
}

export interface PairChoice {
  winner: Winner;
  decidedBy: "record" | "selector" | "first";
  reasons: string[];
}

/** One question to the selector: which of the two (shown as "1" and "2") fulfils the task better. */
export type AskSelector = (task: string, first: string, second: string) => Promise<"1" | "2" | null>;

export interface BestOfTwoDeps {
  /** Checks a built page as the artifact gate does (tools/page-check.ts checkBuiltPage). */
  checkPage: (absPath: string, rel: string) => Promise<{ ok: boolean; detail: string; timedOut?: true }>;
  askSelector: AskSelector;
  now?: () => number;
}

export function bestOfTwoApplies(opts: { asksForFile: boolean; nested: boolean }): boolean {
  return effectiveOrchestration().bestOfTwoDeliverables === true
    && currentEffortTier() === "max"
    && opts.asksForFile
    && !opts.nested;
}

/** The workspace-relative paths a run reports as its files and folders. */
export function runPaths(result: SubAgentRunResult): string[] {
  const paths = new Set<string>();
  for (const artifact of result.artifacts ?? []) {
    const path = artifact["outputPath"] ?? artifact["relativePath"] ?? artifact["path"];
    if (typeof path === "string" && path.trim() && !path.startsWith("/") && !path.includes("..")) paths.add(path.replace(/\\/g, "/"));
  }
  return [...paths].sort();
}

function sizeOf(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, entry) => sum + sizeOf(join(path, entry)), 0);
}

/** Copy the run's files aside, mirroring their layout; false when they are too large or outside the workspace. */
export function snapshotRun(workspacePath: string, paths: readonly string[], root: string): boolean {
  let total = 0;
  const sources: Array<[string, string]> = [];
  for (const rel of paths) {
    const contained = containedWorkspaceRealPath(resolve(workspacePath, rel), workspacePath);
    if (!contained || !existsSync(contained.real)) continue;
    total += sizeOf(contained.real);
    if (total > MAX_SNAPSHOT_BYTES) return false;
    sources.push([contained.real, join(root, rel)]);
  }
  for (const [from, to] of sources) cpSync(from, to, { recursive: true });
  return true;
}

function filesUnder(root: string, rel: string): string[] {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [rel];
  return readdirSync(abs).flatMap((entry) => filesUnder(root, `${rel}/${entry}`));
}

/** What the record says about a candidate, read from its copied files. */
export async function recordOf(candidate: Candidate, deps: Pick<BestOfTwoDeps, "checkPage">): Promise<CandidateRecord> {
  const files = candidate.paths.flatMap((rel) => filesUnder(candidate.snapshotRoot, rel));
  const problems: string[] = [];
  for (const rel of files) {
    const abs = join(candidate.snapshotRoot, rel);
    if (/\.html?$/i.test(rel)) {
      const page = await deps.checkPage(abs, rel);
      // A timeout is the machine's load as much as the page: no verdict either way.
      if (!page.ok && !page.timedOut) problems.push(`${rel}: ${page.detail}`);
      continue;
    }
    const problem = writeProblem("", {}, abs);
    if (problem) problems.push(`${rel}: ${problem}`);
  }
  return { delivered: candidate.result.stats.outcome === "success" && files.length > 0, problems };
}

/** The record's verdict between the two, or null when it cannot tell them apart. */
export function compareRecords(a: CandidateRecord, b: CandidateRecord): { winner: Winner; reason: string } | null {
  if (a.delivered !== b.delivered) return { winner: a.delivered ? "a" : "b", reason: `only run ${a.delivered ? "A" : "B"} completed and delivered files` };
  if (a.problems.length !== b.problems.length) {
    const winner: Winner = a.problems.length < b.problems.length ? "a" : "b";
    const loser = winner === "a" ? b : a;
    return { winner, reason: `run ${winner === "a" ? "B" : "A"}'s files have ${loser.problems.length} problem(s): ${loser.problems.slice(0, 3).join("; ")}` };
  }
  return null;
}

/** A candidate as the selector reads it: its report, its files, the start of its largest text file. */
export function describeCandidate(candidate: Candidate): string {
  const files = candidate.paths.flatMap((rel) => filesUnder(candidate.snapshotRoot, rel));
  const sized = files.map((rel) => ({ rel, size: statSync(join(candidate.snapshotRoot, rel)).size }));
  const text = sized
    .filter(({ rel }) => /\.(?:html?|md|mmd|txt|json|csv|svg|css|js|ts|py)$/i.test(rel))
    .sort((x, y) => y.size - x.size)[0];
  const excerpt = text ? readFileSync(join(candidate.snapshotRoot, text.rel), "utf8").slice(0, EXCERPT_CHARS) : "";
  return [
    `Report: ${candidate.result.output.slice(0, REPORT_CHARS)}`,
    `Files: ${sized.map(({ rel, size }) => `${rel} (${size} bytes)`).join(", ") || "none"}`,
    ...(text ? [`Start of ${text.rel}:\n${excerpt}`] : []),
  ].join("\n");
}

/** The selector's verdict, asked in both orders; null when the two answers do not agree. */
export async function selectWithSwap(task: string, a: Candidate, b: Candidate, ask: AskSelector): Promise<Winner | null> {
  const textA = describeCandidate(a);
  const textB = describeCandidate(b);
  const forward = await ask(task, textA, textB);
  const backward = await ask(task, textB, textA);
  if (forward === "1" && backward === "2") return "a";
  if (forward === "2" && backward === "1") return "b";
  return null;
}

/** Put the winner's files where its run wrote them, and remove what only the loser wrote. */
export function applyWinner(workspacePath: string, winner: Candidate, loser: Candidate): void {
  const keep = new Set(winner.paths);
  for (const rel of loser.paths) {
    if (keep.has(rel)) continue;
    const contained = containedWorkspaceRealPath(resolve(workspacePath, rel), workspacePath);
    if (contained) rmSync(contained.real, { recursive: true, force: true });
  }
  for (const rel of winner.paths) {
    const from = join(winner.snapshotRoot, rel);
    if (!existsSync(from)) continue;
    const contained = containedWorkspaceRealPath(resolve(workspacePath, rel), workspacePath);
    if (!contained) continue;
    rmSync(contained.real, { recursive: true, force: true });
    cpSync(from, contained.real, { recursive: true });
  }
}

function addUsage(a: SubAgentRunResult["stats"]["usage"], b: SubAgentRunResult["stats"]["usage"]): SubAgentRunResult["stats"]["usage"] {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

export interface BestOfTwoInput {
  task: string;
  agentName: string;
  workspacePath: string;
  sessionId?: string;
  /** The absolute time the delegation must end by, when the turn has one. */
  deadlineMs?: number;
  signal?: AbortSignal;
  /** One run of the delegation; called twice at most, never at once. */
  run: (attempt: 1 | 2) => Promise<SubAgentRunResult>;
}

/** Run the delegation twice and keep the better result; once, when the second cannot fit or help. */
export async function runBestOfTwo(input: BestOfTwoInput, deps: BestOfTwoDeps): Promise<SubAgentRunResult> {
  const now = deps.now ?? Date.now;
  const startedA = now();
  const a = await input.run(1);
  const durationA = now() - startedA;
  const audit = (data: Record<string, unknown>) => logAudit("best_of_two_decided", { agent: input.agentName, ...data }, {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    severity: "info",
  });
  if (input.signal?.aborted) return a;
  if (input.deadlineMs !== undefined && input.deadlineMs - now() < durationA * 1.1) {
    audit({ ran: 1, reason: "the time left would not cover a second run", firstRunMs: durationA });
    return a;
  }
  const holding = mkdtempSync(join(tmpdir(), "sai-best-of-two-"));
  try {
    const candA: Candidate = { label: "a", result: a, paths: runPaths(a), snapshotRoot: join(holding, "a") };
    if (!snapshotRun(input.workspacePath, candA.paths, candA.snapshotRoot)) {
      audit({ ran: 1, reason: "the first run's files are too large to keep aside" });
      return a;
    }
    let b: SubAgentRunResult;
    try {
      b = await input.run(2);
    } catch {
      // The first run's files may have been overwritten by a second run that then threw.
      applyWinner(input.workspacePath, candA, { ...candA, paths: [] });
      audit({ ran: 2, winner: "a", decidedBy: "record", reasons: ["the second run failed to run"] });
      return a;
    }
    const candB: Candidate = { label: "b", result: b, paths: runPaths(b), snapshotRoot: join(holding, "b") };
    if (!snapshotRun(input.workspacePath, candB.paths, candB.snapshotRoot)) {
      applyWinner(input.workspacePath, candA, candB);
      audit({ ran: 2, winner: "a", decidedBy: "record", reasons: ["the second run's files are too large to compare"] });
      return { ...a, stats: { ...a.stats, usage: addUsage(a.stats.usage, b.stats.usage) } };
    }
    const choice = await choose(input.task, candA, candB, deps);
    const winner = choice.winner === "a" ? candA : candB;
    applyWinner(input.workspacePath, winner, choice.winner === "a" ? candB : candA);
    audit({ ran: 2, winner: choice.winner, decidedBy: choice.decidedBy, reasons: choice.reasons, firstRunMs: durationA });
    return { ...winner.result, stats: { ...winner.result.stats, usage: addUsage(a.stats.usage, b.stats.usage) } };
  } finally {
    rmSync(holding, { recursive: true, force: true });
  }
}

export async function choose(task: string, a: Candidate, b: Candidate, deps: Pick<BestOfTwoDeps, "checkPage" | "askSelector">): Promise<PairChoice> {
  const [recordA, recordB] = [await recordOf(a, deps), await recordOf(b, deps)];
  const byRecord = compareRecords(recordA, recordB);
  if (byRecord) return { winner: byRecord.winner, decidedBy: "record", reasons: [byRecord.reason] };
  let verdict: Winner | null;
  try {
    verdict = await selectWithSwap(task, a, b, deps.askSelector);
  } catch {
    verdict = null;
  }
  if (verdict) return { winner: verdict, decidedBy: "selector", reasons: [`the selector preferred run ${verdict.toUpperCase()} in both orders`] };
  return { winner: "a", decidedBy: "first", reasons: ["the record could not tell the runs apart and the selector did not agree with itself"] };
}

export const SELECTOR_SYSTEM = `You compare two results of the same task, made by an AI agent. Judge which one fulfils the task better: completeness against what was asked, correctness, and whether the files are usable as delivered. Ignore length for its own sake and the order in which the results are shown.
Answer with one character: 1 or 2.`;

export function selectorUser(task: string, first: string, second: string): string {
  return `Task:\n${task.slice(0, 2_000)}\n\nResult 1:\n${first}\n\nResult 2:\n${second}`;
}

export function parseSelectorAnswer(content: string | null | undefined): "1" | "2" | null {
  const match = /\b([12])\b/.exec((content ?? "").trim());
  return match ? (match[1] as "1" | "2") : null;
}
