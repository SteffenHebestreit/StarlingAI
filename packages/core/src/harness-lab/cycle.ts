/**
 * One lab cycle: screen the corpus on the current harness, pick the tasks it fails, and for each
 * run Propose → Probe → Compose (Harness²'s task-level step): two reference runs, the scoped
 * editors' candidates probed on the same task, the composer's selection probed again, and the
 * paired comparison against the reference. The edits that won on their task are merged and must
 * then pass the global gate on those targets and a guard set before anything is proposed.
 *
 * Model calls and turn runs are injected (CycleDeps), so the whole flow runs in tests on stubs.
 */
import { buildDigest } from "./digest.js";
import { applyEdits, ruleOverlap, validateEdit, type EditorKind, type LabEdit } from "./edit-format.js";
import { proposeEdits, taskText, type EditorResult } from "./editors.js";
import { compose, formatRow, summarizeRun, type ComposeResult, type ComposerCandidate } from "./composer.js";
import { gateDecision, DEFAULT_GATE, type GateDecision, type GateOptions, type GateTaskResult, type PairedAttempt } from "./gate.js";
import type { LabComplete } from "./lab-config.js";
import { compareScores, scoreRun, scoreValue, type RunScore } from "./scoring.js";
import { selectPair, type SelectorVerdict } from "./selector.js";
import type { HarnessTask } from "./task-schema.js";
import type { LabArm } from "./arm.js";
import type { LabRunRecord } from "./turn-runner.js";
import { reflect, type Reflection } from "./reflector.js";

export const MAIN_TARGET = "main_assistant";
/** Merged edits per prompt, and how much a prompt may grow in one cycle. */
export const MAX_EDITS_PER_TARGET = 3;
export const MAX_GROWTH_PER_TARGET = 1_200;
export const MAX_CUSTOM_INSTRUCTIONS = 16_000;

export interface CycleDeps {
  runAttempt: (task: HarnessTask, arm: LabArm, attempt: number) => Promise<LabRunRecord>;
  complete: LabComplete;
  /** The deployment's prompts as loaded: "main_assistant" and every sub-agent by name. */
  basePrompts: () => Record<string, string>;
  log: (line: string) => void;
  /** The experience library's index for a task (its domain first); unset = no library. */
  libraryIndex?: (task: HarnessTask) => string;
  /** Ask the reflector after each task (writes nothing: the caller stores what it returns). */
  reflect?: boolean;
}

export interface CycleOptions {
  /** Explicit target ids, or how many of the failing tasks to take. */
  targets: string[] | number;
  /** Explicit guard ids; unset = every corpus task that can guard and is not a target, up to maxGuards. */
  guards?: string[];
  maxGuards: number;
  /**
   * Runs per candidate, per reference and of the composed set. Two were too few on the local models
   * (2026-10-19): both candidates fixed the Mermaid task in one of two probes, which the composer read,
   * rightly, as weak evidence and dropped; with four, the composed set won all four pairs.
   */
  kProbe: number;
  kGateMax: number;
  gate: GateOptions;
  /**
   * Failing tasks the screen must not pick as targets, with why: a pending lab proposal already
   * answers them. Unapplied, it is not in the prompts this run starts from, so the task fails again,
   * and a nightly run would propose the same fix every night.
   */
  skipTargets?: ReadonlyMap<string, string>;
}

export const DEFAULT_CYCLE: CycleOptions = { targets: 4, maxGuards: 12, kProbe: 4, kGateMax: 3, gate: DEFAULT_GATE };

export interface TaskWork {
  taskId: string;
  references: LabRunRecord[];
  editors: EditorResult[];
  probes: Array<{ label: EditorKind; edits: LabEdit[]; runs: LabRunRecord[] }>;
  composed?: ComposeResult;
  composedRuns: LabRunRecord[];
  pairs: PairedAttempt[];
  outcome: "win" | "keep_base";
  reason: string;
}

export interface CycleHealth {
  editorAnswers: number;
  editorValidEdits: number;
  editorRejectedEdits: number;
  selectorCalls: number;
  selectorConsistent: number;
  /** Picks of position A among the selector's non-tie picks: a local model's position bias. */
  firstPositionPicks: number;
  nonTiePicks: number;
}

export interface CycleResult {
  /** One per task the editors worked on: the lesson the reflector drew, or why it drew none. */
  reflections: Array<{ taskId: string; domain: string; reflection: Reflection | { noEntry: string } }>;
  screen: Array<{ taskId: string; score: RunScore }>;
  targets: string[];
  guards: string[];
  tasks: TaskWork[];
  merged: LabEdit[];
  mergeDropped: string[];
  gateResults: GateTaskResult[];
  gate?: GateDecision;
  health: CycleHealth;
}

const isFailing = (score: RunScore) => !score.unscored && (!score.delivered || score.checksFailed > 0 || score.recordedDefects > 0);

/** The sub-agents a run delegated to, most delegations first. */
function agentsThatRan(records: readonly LabRunRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const turn of record.turns) {
      for (const event of turn.events) {
        if (event.type !== "sub_agent_started") continue;
        const name = typeof event.data["agentName"] === "string" ? event.data["agentName"] as string : "";
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

/** The tools the runs called, the orchestrator's and every sub-agent's. */
export function toolsThatRan(records: readonly LabRunRecord[]): string[] {
  const names = new Set<string>();
  for (const record of records) {
    for (const turn of record.turns) {
      for (const call of turn.toolCalls) if (call.name) names.add(call.name);
      for (const event of turn.events) {
        const tool = event.type === "sub_agent_tool_call" ? event.data?.["tool"] : undefined;
        if (typeof tool === "string" && tool) names.add(tool);
      }
    }
  }
  return [...names].sort();
}

/** A candidate harness: the base prompts with `edits` applied, as the overlay of one arm. */
export function armFor(name: string, base: Record<string, string>, edits: readonly LabEdit[]): LabArm {
  const changed = applyEdits(base, edits);
  const subAgentPrompts: Record<string, string> = {};
  for (const [target, text] of Object.entries(changed)) if (target !== MAIN_TARGET) subAgentPrompts[target] = text;
  const skills = edits.filter((edit) => edit.op === "add_skill")
    .map((edit) => ({ name: edit.skillName ?? edit.id, whenToUse: edit.whenToUse ?? "", procedure: edit.text }));
  const hooks = Object.fromEntries(edits.filter((edit) => edit.op === "add_hook" && edit.hook && edit.hookId).map((edit) => [edit.hookId!, edit.hook!]));
  return {
    name,
    ...(changed[MAIN_TARGET] !== undefined ? { mainAssistantInstructions: changed[MAIN_TARGET] } : {}),
    ...(Object.keys(subAgentPrompts).length > 0 ? { subAgentPrompts } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
  };
}

/**
 * The edits of every winning task, per prompt: identical texts once, of two appended rules that say
 * the same thing the shorter one, a second replace of the same span dropped, at most
 * MAX_EDITS_PER_TARGET per prompt and MAX_GROWTH_PER_TARGET characters of growth, and the main
 * assistant's instructions within their limit. The gate then runs what is merged.
 */
export function mergeEdits(base: Record<string, string>, wins: readonly LabEdit[][]): { merged: LabEdit[]; dropped: string[] } {
  const merged: LabEdit[] = [];
  const dropped: string[] = [];
  for (const edit of wins.flat()) {
    const same = merged.filter((m) => m.target === edit.target);
    if (same.some((m) => m.text.trim() === edit.text.trim())) { dropped.push(`${edit.id}: same text as an edit already kept`); continue; }
    if (edit.op === "append_rule") {
      const twin = same.find((m) => m.op === "append_rule" && ruleOverlap(m.text, edit.text) !== null);
      if (twin) {
        const share = Math.round(ruleOverlap(twin.text, edit.text)! * 100);
        if (edit.text.trim().length < twin.text.trim().length) {
          merged.splice(merged.indexOf(twin), 1, edit);
          dropped.push(`${twin.id}: says what ${edit.id} says (${share}% of its words), and is longer`);
        } else {
          dropped.push(`${edit.id}: says what ${twin.id} says (${share}% of its words), and is not shorter`);
        }
        continue;
      }
    }
    if (edit.op === "replace_span" && same.some((m) => m.op === "replace_span" && m.find === edit.find)) { dropped.push(`${edit.id}: replaces a span another kept edit replaces`); continue; }
    if (same.length >= MAX_EDITS_PER_TARGET) { dropped.push(`${edit.id}: ${edit.target} already has ${MAX_EDITS_PER_TARGET} edits`); continue; }
    const after = applyEdits(base, [...same, edit])[edit.target] ?? "";
    const growth = after.length - (base[edit.target] ?? "").length;
    if (growth > MAX_GROWTH_PER_TARGET) { dropped.push(`${edit.id}: ${edit.target} would grow by ${growth} characters`); continue; }
    if (edit.target === MAIN_TARGET && after.length > MAX_CUSTOM_INSTRUCTIONS) { dropped.push(`${edit.id}: the main assistant's instructions would exceed ${MAX_CUSTOM_INSTRUCTIONS} characters`); continue; }
    merged.push(edit);
  }
  return { merged, dropped };
}

function noteSelector(health: CycleHealth, verdict: SelectorVerdict): void {
  health.selectorCalls += 1;
  if (verdict.winner !== "inconsistent") health.selectorConsistent += 1;
  for (const pick of verdict.picks) {
    if (pick === "A" || pick === "B") {
      health.nonTiePicks += 1;
      if (pick === "A") health.firstPositionPicks += 1;
    }
  }
}

async function pairUp(task: HarnessTask, base: LabRunRecord, cand: LabRunRecord, deps: CycleDeps, health: CycleHealth, useSelector: boolean): Promise<PairedAttempt> {
  const pair: PairedAttempt = { base: scoreRun(base), candidate: scoreRun(cand) };
  if (useSelector && !pair.base.unscored && !pair.candidate.unscored && compareScores(pair.candidate, pair.base) === 0) {
    const verdict = await selectPair(task, base, cand, deps.complete);
    noteSelector(health, verdict);
    pair.selector = verdict.winner;
  }
  return pair;
}

async function improveTask(task: HarnessTask, screenRun: LabRunRecord, deps: CycleDeps, opts: CycleOptions, health: CycleHealth): Promise<TaskWork> {
  const base = deps.basePrompts();
  const references = [screenRun];
  for (let attempt = 2; attempt <= opts.kProbe; attempt += 1) references.push(await deps.runAttempt(task, { name: "base" }, attempt));
  const work: TaskWork = { taskId: task.id, references, editors: [], probes: [], composedRuns: [], pairs: [], outcome: "keep_base", reason: "" };
  const scored = references.map((record) => ({ record, score: scoreRun(record) })).filter((r) => !r.score.unscored);
  if (scored.length === 0) { work.reason = "no reference run could be scored"; return work; }
  const worst = scored.reduce((a, b) => (scoreValue(b.score) < scoreValue(a.score) ? b : a));
  const digest = buildDigest(worst.record);
  const worstFailures = new Set(worst.record.turns.flatMap((t) => t.checkFailures));
  const otherRunFailures = [...new Set(scored.filter((r) => r !== worst).flatMap((r) => r.record.turns.flatMap((t) => t.checkFailures)))].filter((f) => !worstFailures.has(f));

  const prompts: Record<string, string> = { [MAIN_TARGET]: base[MAIN_TARGET] ?? "" };
  for (const name of agentsThatRan(references).slice(0, 2)) if (base[name] !== undefined) prompts[name] = base[name]!;

  const candidates: ComposerCandidate[] = [];
  for (const kind of ["INV", "DOM"] as const) {
    const libraryIndex = deps.libraryIndex?.(task);
    const result = await proposeEdits(kind, { task, digest, otherRunFailures, prompts, toolNames: toolsThatRan(references), ...(libraryIndex ? { libraryIndex } : {}) }, `${kind}-${task.id}`, deps.complete);
    work.editors.push(result);
    health.editorAnswers += 1;
    if (result.outcome.kind !== "edits" || result.outcome.edits.length === 0) {
      deps.log(`  ${kind}: keep base${result.outcome.kind === "keep_base" ? ` (${result.outcome.reason})` : ""}`);
      continue;
    }
    health.editorValidEdits += result.outcome.edits.length;
    health.editorRejectedEdits += result.outcome.rejected.length;
    const edits = result.outcome.edits;
    const runs: LabRunRecord[] = [];
    for (let attempt = 1; attempt <= opts.kProbe; attempt += 1) runs.push(await deps.runAttempt(task, armFor(`${kind}-${task.id}`, base, edits), attempt));
    work.probes.push({ label: kind, edits, runs });
    candidates.push({ label: kind, edits, probes: runs.map((record) => ({ record, score: scoreRun(record) })) });
    deps.log(`  ${kind}: ${edits.length} edit(s) probed`);
  }
  if (candidates.length === 0) { work.reason = "both editors kept the base"; return work; }

  work.composed = await compose({
    referenceSummary: summarizeRun(worst.record, worst.score),
    referenceDigest: digest.text,
    candidates,
    revalidate: (edit, text) => {
      const result = validateEdit({ ...edit, ...(edit.skillName ? { name: edit.skillName } : {}), text }, 0, {
        editor: edit.editor, idPrefix: edit.id, digest, prompts, taskText: taskText(task),
      });
      return typeof result === "string" ? result : { ...result, id: edit.id };
    },
  }, deps.complete);
  const kept = work.composed.edits;
  if (kept.length === 0) { work.reason = "the composer kept no edit"; return work; }

  // The composer kept exactly one candidate's edits, unrevised: its probes already ran that harness.
  const reused = candidates.find((c) => c.edits.length === kept.length && c.edits.every((edit) => kept.some((k) => k.id === edit.id && k.text === edit.text)));
  if (reused) work.composedRuns = reused.probes.map((p) => p.record);
  else for (let attempt = 1; attempt <= opts.kProbe; attempt += 1) work.composedRuns.push(await deps.runAttempt(task, armFor(`composed-${task.id}`, base, kept), attempt));

  for (let i = 0; i < Math.min(references.length, work.composedRuns.length); i += 1) {
    work.pairs.push(await pairUp(task, references[i]!, work.composedRuns[i]!, deps, health, true));
  }
  const decided = work.pairs.map((p) => compareScores(p.candidate, p.base));
  const wins = decided.filter((d) => d > 0).length;
  const losses = decided.filter((d) => d < 0).length;
  const selectorWins = work.pairs.filter((p) => p.selector === "candidate").length;
  const selectorLosses = work.pairs.filter((p) => p.selector === "base").length;
  if (losses === 0 && (wins > 0 || (selectorWins > 0 && selectorLosses === 0))) {
    work.outcome = "win";
    work.reason = wins > 0 ? `won ${wins} of ${work.pairs.length} pairs on the record` : `tied on the record; the selector preferred it ${selectorWins}× consistently`;
  } else {
    work.reason = `no win (${wins} won, ${losses} lost, selector ${selectorWins}:${selectorLosses})`;
  }
  return work;
}

async function runGate(merged: LabEdit[], targets: HarnessTask[], guards: HarnessTask[], deps: CycleDeps, opts: CycleOptions, health: CycleHealth): Promise<GateTaskResult[]> {
  const base = deps.basePrompts();
  const candidateArm = armFor("gate-candidate", base, merged);
  const results: GateTaskResult[] = [
    ...targets.map((task) => ({ taskId: task.id, role: "target" as const, attempts: [] as PairedAttempt[] })),
    ...guards.map((task) => ({ taskId: task.id, role: "guard" as const, attempts: [] as PairedAttempt[] })),
  ];
  const tasks = [...targets, ...guards];
  for (let k = 1; k <= opts.kGateMax; k += 1) {
    let ran = 0;
    for (const [index, task] of tasks.entries()) {
      const result = results[index]!;
      // Past the first round only where the arms disagreed or the selector could not decide.
      if (k > 1 && !result.attempts.some((p) => compareScores(p.candidate, p.base) !== 0 || p.selector === "inconsistent")) continue;
      // Interleaved: base first on odd rounds, the candidate first on even ones.
      const [b, c] = k % 2 === 1
        ? [await deps.runAttempt(task, { name: "base" }, 100 + k), await deps.runAttempt(task, candidateArm, 100 + k)]
        : await (async () => { const cand = await deps.runAttempt(task, candidateArm, 100 + k); return [await deps.runAttempt(task, { name: "base" }, 100 + k), cand]; })();
      result.attempts.push(await pairUp(task, b, c, deps, health, result.role === "target"));
      ran += 1;
    }
    const guardNet = results.filter((r) => r.role === "guard").reduce((sum, r) => sum + r.attempts.reduce((s, p) => s - compareScores(p.candidate, p.base), 0), 0);
    if (guardNet > opts.gate.guardTotalLossMargin + 1) {
      deps.log(`  gate: guard set clearly worse after round ${k}, stopping`);
      break;
    }
    if (ran === 0) break;
  }
  return results;
}

export async function runCycle(corpus: readonly HarnessTask[], opts: CycleOptions, deps: CycleDeps): Promise<CycleResult> {
  const health: CycleHealth = { editorAnswers: 0, editorValidEdits: 0, editorRejectedEdits: 0, selectorCalls: 0, selectorConsistent: 0, firstPositionPicks: 0, nonTiePicks: 0 };
  const byId = new Map(corpus.map((task) => [task.id, task]));
  const explicitTargets = Array.isArray(opts.targets) ? opts.targets : null;
  for (const id of [...(explicitTargets ?? []), ...(opts.guards ?? [])]) if (!byId.has(id)) throw new Error(`No task with id ${id} in the corpus`);

  const screenTasks = explicitTargets
    ? explicitTargets.map((id) => byId.get(id)!)
    : corpus.filter((task) => task.role !== "guard");
  const screen: CycleResult["screen"] = [];
  const screenRuns = new Map<string, LabRunRecord>();
  for (const task of screenTasks) {
    const record = await deps.runAttempt(task, { name: "base" }, 1);
    screenRuns.set(task.id, record);
    const score = scoreRun(record);
    screen.push({ taskId: task.id, score });
    deps.log(`screen ${task.id}: ${score.unscored ? "unscored" : `${score.delivered ? "delivered" : "NOT delivered"}, ${score.checksFailed} check(s) failed`}`);
  }
  const targets = explicitTargets ?? screen.filter((s) => isFailing(s.score))
    .filter((s) => {
      const why = opts.skipTargets?.get(s.taskId);
      if (why) deps.log(`not a target: ${s.taskId} ${why}`);
      return !why;
    })
    .sort((a, b) => scoreValue(a.score) - scoreValue(b.score))
    .slice(0, typeof opts.targets === "number" ? opts.targets : 4)
    .map((s) => s.taskId);
  const guards = opts.guards ?? corpus.filter((task) => task.role !== "target" && !targets.includes(task.id)).slice(0, opts.maxGuards).map((task) => task.id);

  const tasks: TaskWork[] = [];
  const reflections: CycleResult["reflections"] = [];
  for (const id of targets) {
    deps.log(`task ${id}`);
    const task = byId.get(id)!;
    const work = await improveTask(task, screenRuns.get(id)!, deps, opts, health);
    deps.log(`  → ${work.outcome}: ${work.reason}`);
    tasks.push(work);
    if (deps.reflect && work.probes.length > 0) {
      reflections.push({ taskId: id, domain: task.domain, reflection: await reflect(task, work, deps.complete) });
    }
  }

  const base = deps.basePrompts();
  const wins = tasks.filter((work) => work.outcome === "win");
  const { merged, dropped } = mergeEdits(base, wins.map((work) => work.composed?.edits ?? []));
  const result: CycleResult = { reflections, screen, targets, guards, tasks, merged, mergeDropped: dropped, gateResults: [], health };
  if (merged.length === 0) return result;

  deps.log(`gate: ${merged.length} merged edit(s) on ${wins.length} target(s) and ${guards.length} guard(s)`);
  const winTargets = wins.map((work) => byId.get(work.taskId)!);
  result.gateResults = await runGate(merged, winTargets, guards.map((id) => byId.get(id)!), deps, opts, health);
  result.gate = gateDecision(result.gateResults, opts.gate);
  deps.log(`gate: ${result.gate.verdict} (${result.gate.evidence}) — ${result.gate.reasons.join("; ")}`);
  return result;
}

/** The composer's rows of every winning task, printed. */
export function composerRowsOf(result: CycleResult): string[] {
  return result.tasks.filter((work) => work.outcome === "win").flatMap((work) => (work.composed?.rows ?? []).map((row) => `${work.taskId}: ${formatRow(row)}`));
}
