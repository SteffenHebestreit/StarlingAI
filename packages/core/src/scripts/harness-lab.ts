/// <reference types="node" />
/**
 * The harness lab: improve the swarm's prompts from execution evidence, offline, with a person
 * approving every change (Harness², arXiv 2610.14224, rebuilt for a global harness).
 *
 *   pnpm harness-lab validate [--tasks <dir>]
 *   pnpm harness-lab import [--write] [--tasks <dir>]
 *   pnpm harness-lab probe --task <id> [--edits <file.json>] [--out <dir>]
 *   pnpm harness-lab run [--targets <id,id>|<N>] [--guards <id,id>] [--k-probe 4] [--k-gate 3]
 *                        [--max-guards 12] [--with e2e-site] [--out <dir>] [--dry-run]
 *   pnpm harness-lab harvest [--since 14d|<iso>] [--limit 5] [--include-errors] [--inbox <dir>] [--dry-run]
 *   pnpm harness-lab review [--accept <id> [--by <name>] | --reject <id>] [--inbox <dir>] [--tasks <dir>]
 *   pnpm harness-lab nightly [--budget 4h] [--quiet 10m] [run flags] [--out <nightly root>]
 *
 * `run` screens the corpus on the current prompts, improves up to N failing tasks (Propose → Probe
 * → Compose, harness-lab/cycle.ts), puts the merged edits through the gate on those targets and a
 * guard set, and files ONE pending config-assistant proposal when the gate accepts (never with
 * --dry-run). Apply it, or not, in Settings → Config Assistant.
 *
 * `harvest` reads the turns the live swarm recorded as failures (the Postgres audit and the Redis
 * session store, read-only, so it runs where those are reachable: inside the gateway container) and
 * has the local anonymizer rewrite each as a synthetic task, screened for anything left of the
 * original, into the inbox (harness-lab/harvest.ts). `review` lists the inbox, and moves a task into
 * the corpus (--accept, stamped as reviewed) or drops it (--reject). The lab runs no task from the
 * inbox, and no failure-derived task without a review.
 *
 * `nightly` is `run` for a timer on the host (never the gateway's cron): it gives way to live use
 * (--quiet: no new attempt while a message came in within that window), stops before its next new
 * attempt once its --budget is spent, and the next nightly run goes on with the run it paused. Any
 * `run` goes on with what an earlier run on the same --out recorded (harness-lab/replay.ts), and no
 * run takes a task as a target that a pending lab proposal already answers.
 *
 * It runs in a process of its own (harness-lab/bootstrap.ts), on the host or inside the gateway
 * container (`node packages/core/dist/scripts/harness-lab.js run …`), never in the gateway itself:
 * the candidates' prompts are laid over its loaded config. It needs
 * selfImprovement.harnessLab.enabled. Runs and the report land under --out
 * (default .starlingai/harness-lab/<timestamp>).
 *
 * Exit codes: 0 a verdict was reached (a proposal, or a reasoned keep-base), 2 a usage mistake,
 * 3 not a verdict (too many runs could not be scored), 4 paused (the budget is spent: run again with
 * the same --out, or the next nightly run, to go on).
 */
// MUST be first: the lab's process setup, before anything loads the config or a store.
import { REPO_ROOT, resolveOutDir, startLabProcess } from "../harness-lab/bootstrap.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

class UsageError extends Error {}

const COMMANDS = ["validate", "import", "probe", "run", "harvest", "review", "nightly"] as const;
type Command = typeof COMMANDS[number];
const VALUE_FLAGS = new Set([
  "tasks", "task", "edits", "out", "targets", "guards", "k-probe", "k-gate", "max-guards", "with",
  "inbox", "since", "limit", "accept", "reject", "by", "budget", "quiet",
]);
/** Services a task may need that are not part of a normal stack; their tasks run only with --with. */
const OPTIONAL_SERVICES = new Set(["e2e-site"]);
const BOOL_FLAGS = new Set(["write", "dry-run", "include-errors"]);

function parseArgs(argv: string[]): { command: Command; flags: Map<string, string | true> } {
  const [command, ...rest] = argv;
  if (!command || !(COMMANDS as readonly string[]).includes(command)) throw new UsageError(`command must be one of ${COMMANDS.join(", ")}`);
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) throw new UsageError(`unexpected argument "${arg}"`);
    const name = arg.slice(2);
    if (BOOL_FLAGS.has(name)) { flags.set(name, true); continue; }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`unknown flag --${name}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
    flags.set(name, value);
    i += 1;
  }
  return { command: command as Command, flags };
}

function value(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function positiveInt(flags: Map<string, string | true>, name: string, fallback: number): number {
  const raw = value(flags, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} takes a whole number, 1 or more (got "${raw}")`);
  return n;
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const log = (line: string) => process.stdout.write(`${line}\n`);

/** The core package's version: part of the replay fingerprint, so a new build records afresh. */
function coreVersion(): string {
  try {
    return String((JSON.parse(readFileSync(join(REPO_ROOT, "packages", "core", "package.json"), "utf8")) as { version?: unknown }).version ?? "unknown");
  } catch {
    return "unknown";
  }
}

/** `--since`: an ISO time, or a number of days back ("14d"). */
function sinceIso(flags: Map<string, string | true>): string {
  const raw = value(flags, "since") ?? "14d";
  const days = /^(\d+)d$/.exec(raw);
  if (days) return new Date(Date.now() - Number(days[1]) * 86_400_000).toISOString();
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) throw new UsageError(`--since takes an ISO time or a number of days like 14d (got "${raw}")`);
  return new Date(at).toISOString();
}

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const tasksDir = resolve(REPO_ROOT, value(flags, "tasks") ?? "eval/harness-lab/tasks");
  const inboxDir = resolve(REPO_ROOT, value(flags, "inbox") ?? "eval/harness-lab/inbox");
  // Read before the lab process unsets them (bootstrap.ts): only the harvest's read-only stores get them.
  const liveStores = { databaseUrl: process.env["DATABASE_URL"]?.trim() ?? "", redisUrl: process.env["REDIS_URL"]?.trim() ?? "" };

  if (command === "review") {
    const { acceptInboxTask, listInbox, rejectInboxTask } = await import("../harness-lab/harvest.js");
    const accept = value(flags, "accept");
    const reject = value(flags, "reject");
    if (accept && reject) throw new UsageError("--accept and --reject exclude each other");
    try {
      if (accept) {
        const { userInfo } = await import("node:os");
        log(`accepted ${accept}: ${acceptInboxTask(inboxDir, tasksDir, accept, value(flags, "by") ?? userInfo().username)}`);
        return 0;
      }
      if (reject) {
        rejectInboxTask(inboxDir, reject);
        log(`rejected ${reject}`);
        return 0;
      }
    } catch (err) {
      throw new UsageError(err instanceof Error ? err.message : String(err));
    }
    const entries = listInbox(inboxDir);
    if (entries.length === 0) log(`the inbox ${inboxDir} is empty`);
    for (const entry of entries) {
      log(`${entry.id}  ${entry.title}`);
      for (const note of entry.notes) log(`    ${note}`);
    }
    return 0;
  }

  if (command === "import") {
    const { importSeeds } = await import("../harness-lab/import-seeds.js");
    const { tasks, skipped } = importSeeds(resolve(REPO_ROOT, "eval/e2e/scenarios"), resolve(REPO_ROOT, "eval/e2e/fixtures"));
    for (const task of tasks) log(`+ ${task.id} (${task.turns.length} turn(s))`);
    for (const skip of skipped) log(`- ${skip.id}: ${skip.reason}`);
    if (flags.has("write")) {
      mkdirSync(tasksDir, { recursive: true });
      const file = join(tasksDir, "e2e-seeds.jsonc");
      writeFileSync(file, `// Generated by \`pnpm harness-lab import --write\` from eval/e2e/scenarios: the scenarios a lab\n// attempt can run as they are. Regenerate rather than edit.\n${JSON.stringify(tasks, null, 2)}\n`, "utf8");
      log(`wrote ${tasks.length} task(s) to ${file}`);
    }
    return 0;
  }

  if (command === "validate") {
    const { loadCorpus } = await import("../harness-lab/task-schema.js");
    const corpus = loadCorpus(tasksDir);
    for (const task of corpus.tasks) log(`ok ${task.id} [${task.role}] ${task.title}`);
    for (const skip of corpus.skipped) log(`skipped ${skip.file}: ${skip.reason}`);
    return corpus.skipped.some((s) => s.reason.startsWith("invalid") || s.reason.startsWith("unreadable")) ? 2 : 0;
  }

  // Read before the lab process points SAI_AUDIT_LOG at its own log: the live one is what --quiet watches.
  const liveAuditLog = process.env["SAI_AUDIT_LOG"]?.trim() || resolve(REPO_ROOT, ".starlingai", "audit.jsonl");
  const { readNightlyState, readRunId, writeNightlyState, writeRunId } = await import("../harness-lab/replay.js");
  const nightly = command === "nightly";
  const nightlyRoot = nightly ? resolveOutDir(value(flags, "out") ?? join(".starlingai", "harness-lab", "nightly")) : "";
  const nightlyState = nightly ? readNightlyState(nightlyRoot) : {};
  const freshRunId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`;
  const outDir = nightly
    ? (nightlyState.unfinished && existsSync(nightlyState.unfinished) ? nightlyState.unfinished : join(nightlyRoot, freshRunId))
    : resolveOutDir(value(flags, "out") ?? join(".starlingai", "harness-lab", freshRunId));
  // An --out that holds an earlier run is that run going on: its id, its recorded attempts and calls.
  const runId = readRunId(outDir) ?? freshRunId;
  const lab = await startLabProcess(outDir);
  writeRunId(outDir, runId);
  if (nightly) log(`${runId === freshRunId ? "nightly run" : "nightly run going on with"} ${runId} in ${outDir}`);
  const { getConfig } = await import("../config/loader.js");
  const config = getConfig();
  if (!config.selfImprovement.harnessLab.enabled) throw new UsageError("selfImprovement.harnessLab.enabled is off");
  const { applyLabToolPolicy } = await import("../harness-lab/tool-policy.js");
  const policy = applyLabToolPolicy(config.selfImprovement.harnessLab.toolPolicy);
  const { loadCorpus } = await import("../harness-lab/task-schema.js");
  const corpus = loadCorpus(tasksDir);
  // A task that needs an optional service (the E2E fixture site) runs only when the run says it is up.
  const available = new Set((value(flags, "with") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  corpus.tasks = corpus.tasks.filter((task) => {
    const missing = task.requires.filter((service) => OPTIONAL_SERVICES.has(service) && !available.has(service));
    if (missing.length > 0) corpus.skipped.push({ file: task.id, reason: `needs ${missing.join(", ")} (pass --with ${missing.join(",")} when it is up)` });
    return missing.length === 0;
  });
  if (corpus.tasks.length === 0) throw new UsageError(`no runnable task under ${tasksDir} (try \`pnpm harness-lab import --write\`)`);
  const { runLabAttempt } = await import("../harness-lab/turn-runner.js");
  // Attempt workspaces must be bindable into the code sandbox, which nothing under .starlingai is:
  // under generated/ while the run lasts, moved under --out when it stops (harness-lab/scratch.ts).
  const { archiveLabScratch, labScratchRoot } = await import("../harness-lab/scratch.js");
  const scratchRoot = labScratchRoot(lab.liveWorkspacePath, runId);
  // What an earlier run of the same parent left there when it was killed outright goes to its own --out.
  const scratchParent = dirname(scratchRoot);
  if (existsSync(scratchParent)) {
    for (const stale of readdirSync(scratchParent)) {
      const staleOut = join(dirname(outDir), stale);
      if (stale !== basename(scratchRoot) && existsSync(staleOut)) archiveLabScratch(join(scratchParent, stale), staleOut);
    }
  }
  pendingScratch = { root: scratchRoot, outDir, archive: archiveLabScratch };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { archivePendingScratch(); process.exit(130); });
  }
  const runsDir = join(outDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const runAttempt = async (task: (typeof corpus.tasks)[number], arm: import("../harness-lab/arm.js").LabArm, attempt: number) => {
    const record = await runLabAttempt(task, arm, { runId, attempt, scratchRoot });
    writeFileSync(join(runsDir, `${task.id}--${arm.name}--${attempt}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return record;
  };

  if (command === "harvest") {
    if (!liveStores.databaseUrl) throw new UsageError("harvest reads the audit from Postgres and DATABASE_URL is not set: run it in the gateway container");
    if (!liveStores.redisUrl) log("REDIS_URL is not set: no session can be read, so no task can be derived");
    const limit = positiveInt(flags, "limit", 5);
    const since = sinceIso(flags);
    const dryRun = flags.has("dry-run");
    const { commonVocabulary, harvestFailures, knownDigests, writeInboxTask } = await import("../harness-lab/harvest.js");
    const { openHarvestStores } = await import("../harness-lab/harvest-stores.js");
    const { createLabComplete, labModelConfig } = await import("../harness-lab/lab-config.js");
    const vocabularySources = [
      ...corpus.tasks.flatMap((task) => [task.title, ...task.turns.map((turn) => turn.message)]),
      config.agents.mainAssistant.customInstructions ?? "",
      ...Object.values(config.subAgents).map((agent) => `${agent.description ?? ""}\n${agent.systemPrompt ?? ""}`),
    ];
    const opened = await openHarvestStores({ databaseUrl: liveStores.databaseUrl, ...(liveStores.redisUrl ? { redisUrl: liveStores.redisUrl } : {}) });
    let result: Awaited<ReturnType<typeof harvestFailures>>;
    try {
      result = await harvestFailures(opened.stores, {
        sinceIso: since,
        limit,
        includeErrors: flags.has("include-errors"),
        known: knownDigests([inboxDir, tasksDir]),
        commonWords: commonVocabulary(vocabularySources),
        complete: createLabComplete(),
        log,
      });
    } finally {
      await opened.close();
    }
    const derivedAt = new Date().toISOString();
    const written = dryRun ? [] : result.derived.map((entry) => writeInboxTask(inboxDir, entry, derivedAt));
    const reasons = new Map<string, number>();
    for (const skip of result.skipped) reasons.set(skip.reason, (reasons.get(skip.reason) ?? 0) + 1);
    // Counts and reasons only: nothing of an original turn goes into the report.
    writeFileSync(join(outDir, "harvest.json"), `${JSON.stringify({
      derivedAt,
      since,
      scanned: result.scanned,
      derived: result.derived.map((entry) => ({ id: entry.task.id, basis: entry.basis, sharedWords: entry.shared.length })),
      written,
      skipped: Object.fromEntries(reasons),
      anonymizer: labModelConfig("anonymizer").primary,
      dryRun,
    }, null, 2)}\n`, "utf8");
    for (const [reason, count] of reasons) log(`skipped ${count}: ${reason}`);
    log(`${result.derived.length} task(s) derived from ${result.scanned} failed turn(s)${dryRun ? " (dry run: nothing written)" : `, in ${inboxDir}`}; review them with \`pnpm harness-lab review\``);
    await finish();
    return 0;
  }

  if (command === "probe") {
    const id = value(flags, "task");
    const task = corpus.tasks.find((t) => t.id === id);
    if (!task) throw new UsageError(`--task must name a task of the corpus (got "${id ?? ""}")`);
    const { scoreRun } = await import("../harness-lab/scoring.js");
    const { buildDigest } = await import("../harness-lab/digest.js");
    const { armFor, MAIN_TARGET } = await import("../harness-lab/cycle.js");
    const editsFile = value(flags, "edits");
    const base: Record<string, string> = { [MAIN_TARGET]: config.agents.mainAssistant.customInstructions ?? "" };
    for (const [name, agent] of Object.entries(config.subAgents)) base[name] = agent.systemPrompt ?? "";
    const arm = editsFile ? armFor("probe", base, JSON.parse(readFileSync(resolve(REPO_ROOT, editsFile), "utf8"))) : { name: "base" };
    const record = await runAttempt(task, arm, 1);
    log(JSON.stringify(scoreRun(record)));
    log(buildDigest(record).text);
    await finish();
    return record.unscored ? 3 : 0;
  }

  const { runCycle, composerRowsOf, DEFAULT_CYCLE, MAIN_TARGET } = await import("../harness-lab/cycle.js");
  const { createPacer, LabBudgetSpent, parseDuration } = await import("../harness-lab/yield.js");
  const duration = (name: string, fallback?: number) => {
    const raw = value(flags, name);
    if (raw === undefined) return fallback;
    const ms = parseDuration(raw);
    if (ms === null || ms <= 0) throw new UsageError(`--${name} takes a duration like 45m or 4h (got "${raw}")`);
    return ms;
  };
  const budgetMs = duration("budget", nightly ? 4 * 3_600_000 : undefined);
  const quietMs = duration("quiet", nightly ? 10 * 60_000 : undefined);
  const kProbe = positiveInt(flags, "k-probe", DEFAULT_CYCLE.kProbe);
  const kGate = positiveInt(flags, "k-gate", DEFAULT_CYCLE.kGateMax);
  const maxGuards = positiveInt(flags, "max-guards", DEFAULT_CYCLE.maxGuards);
  const targetsArg = value(flags, "targets");
  const targets = targetsArg === undefined ? DEFAULT_CYCLE.targets : /^\d+$/.test(targetsArg) ? Number(targetsArg) : targetsArg.split(",").map((s) => s.trim()).filter(Boolean);
  const guardsArg = value(flags, "guards");
  const dryRun = flags.has("dry-run");

  const { createLabComplete, labModelConfig } = await import("../harness-lab/lab-config.js");
  const basePrompts = () => {
    const current = getConfig();
    const prompts: Record<string, string> = { [MAIN_TARGET]: current.agents.mainAssistant.customInstructions ?? "" };
    for (const [name, agent] of Object.entries(current.subAgents)) prompts[name] = agent.systemPrompt ?? "";
    return prompts;
  };
  const { harnessFingerprint, ReplayCache } = await import("../harness-lab/replay.js");
  const replay = new ReplayCache(outDir, harnessFingerprint({ ...basePrompts(), "@core": coreVersion() }));
  const pacer = createPacer({ ...(quietMs !== undefined ? { auditFile: liveAuditLog } : {}), quietWindowMs: quietMs ?? 0, ...(budgetMs !== undefined ? { budgetMs } : {}), log });
  // Recorded first, paced second: a step the run already took is served without waiting.
  const cycleAttempt: typeof runAttempt = (task, arm, attempt) => replay.through("attempt", { task, arm, attempt }, async () => {
    await pacer.beforeAttempt();
    return runAttempt(task, arm, attempt);
  });
  const liveComplete = createLabComplete();
  const complete: import("../harness-lab/lab-config.js").LabComplete = (role, system, user) =>
    replay.through("call", { role, model: labModelConfig(role).primary, system, user }, () => liveComplete(role, system, user));
  const { pendingLabTargets } = await import("../harness-lab/proposal.js");
  const skipTargets = Array.isArray(targets) ? undefined : pendingLabTargets(lab.liveWorkspacePath);
  const { appendEntries, finalVerdict, libraryDir, readEntries, renderIndex } = await import("../harness-lab/library.js");
  const library = libraryDir(lab.liveWorkspacePath);
  const known = readEntries(library);
  const startedAt = new Date().toISOString();
  let cycle: Awaited<ReturnType<typeof runCycle>>;
  try {
    cycle = await runCycle(corpus.tasks, {
      ...DEFAULT_CYCLE,
      targets,
      ...(guardsArg ? { guards: guardsArg.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
      maxGuards,
      kProbe,
      kGateMax: kGate,
      ...(skipTargets && skipTargets.size > 0 ? { skipTargets } : {}),
    }, {
      runAttempt: cycleAttempt,
      complete,
    basePrompts,
      log,
      reflect: true,
      ...(known.length > 0 ? { libraryIndex: (task: (typeof corpus.tasks)[number]) => renderIndex(known, { domain: task.domain }) } : {}),
    });
  } catch (err) {
    if (!(err instanceof LabBudgetSpent)) throw err;
    log(`paused: ${err.message}. ${replay.stats.recorded} new and ${replay.stats.served} replayed steps are kept in ${outDir}; run again with the same --out${nightly ? " (or wait for the next nightly run)" : ""} to go on.`);
    if (nightly) writeNightlyState(nightlyRoot, { ...nightlyState, unfinished: outDir, pausedAt: new Date().toISOString(), pauseReason: err.message });
    await finish();
    return 4;
  }

  // What each task taught, with the verdict the run showed once the gate decided. A dry run writes
  // nothing outside --out.
  const lessons = cycle.reflections.flatMap(({ taskId, domain, reflection }) => {
    if ("noEntry" in reflection) return [];
    const work = cycle.tasks.find((t) => t.taskId === taskId)!;
    return [{ ...reflection, runId, taskId, domain, verdict: finalVerdict(work, cycle.gate) }];
  });
  const libraryWritten = dryRun ? [] : appendEntries(library, lessons);

  const { emitProposal } = await import("../harness-lab/proposal.js");
  const proposal = !dryRun && cycle.gate?.verdict === "accept"
    ? emitProposal({ liveWorkspacePath: lab.liveWorkspacePath, runId, basePrompts: basePrompts(), edits: cycle.merged, composerRows: composerRowsOf(cycle), gate: cycle.gate })
    : undefined;

  const warnings: string[] = [];
  if (!config.auth?.enabled) warnings.push("multi-user auth is off: the lab's principal shares the operator's memory and context");
  const { writeReport } = await import("../harness-lab/report.js");
  writeReport(outDir, {
    dryRun,
    cycle,
    library: { dir: library, written: libraryWritten, drawn: lessons.length },
    ...(proposal ? { proposal } : {}),
    provenance: {
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      gitRevision: git(["rev-parse", "--short", "HEAD"]) || "unknown",
      gitDirty: git(["status", "--porcelain"]).length > 0,
      models: Object.fromEntries((["editor", "composer", "selector", "reflector"] as const).map((role) => [role, labModelConfig(role).primary])),
      isolatedStores: lab.isolatedStores,
      deniedTools: [...policy.denied].sort(),
      stubbedTools: [...policy.stubbed].sort(),
      corpus: { tasks: corpus.tasks.length, skipped: corpus.skipped },
      warnings,
    },
  });
  const { logAudit } = await import("../audit/logger.js");
  logAudit("harness_lab_run_completed", {
    runId,
    targets: cycle.targets,
    wins: cycle.tasks.filter((t) => t.outcome === "win").length,
    merged: cycle.merged.length,
    verdict: cycle.gate?.verdict ?? "keep_base",
    ...(proposal && "proposal" in proposal ? { proposalId: proposal.proposal.id } : {}),
    ...(proposal && "superseded" in proposal && proposal.superseded.length > 0 ? { superseded: proposal.superseded } : {}),
    replayedSteps: replay.stats.served,
    yieldedToLiveUse: pacer.stats.waits,
    ...(nightly ? { nightly: true } : {}),
  }, { severity: "info" });
  if (nightly) writeNightlyState(nightlyRoot, { lastFinished: outDir, finishedAt: new Date().toISOString(), verdict: cycle.gate?.verdict ?? "keep_base" });
  log(`report: ${join(outDir, "report.md")}`);
  if (proposal && "proposal" in proposal) log(`pending proposal ${proposal.proposal.id}: review it in Settings → Config Assistant`);
  if (proposal && "superseded" in proposal && proposal.superseded.length > 0) log(`it supersedes the pending lab proposal(s) ${proposal.superseded.join(", ")}`);
  if (replay.stats.served > 0) log(`went on with an earlier run: ${replay.stats.served} step(s) replayed, ${replay.stats.recorded} new`);
  await finish();
  return cycle.gate?.verdict === "no_verdict" ? 3 : 0;
}

/** The run's attempt workspaces, to move under its --out whichever way it stops. */
let pendingScratch: { root: string; outDir: string; archive: (root: string, outDir: string) => void } | null = null;

function archivePendingScratch(): void {
  if (!pendingScratch) return;
  const { root, outDir, archive } = pendingScratch;
  pendingScratch = null;
  try {
    archive(root, outDir);
  } catch (err) {
    process.stderr.write(`harness-lab: could not move the attempt workspaces from ${root}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function finish(): Promise<void> {
  archivePendingScratch();
  const { flushAuditLog } = await import("../audit/logger.js");
  const { flushSessionStore } = await import("../agent/session.js");
  await flushAuditLog();
  await flushSessionStore();
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    archivePendingScratch();
    if (err instanceof UsageError) {
      process.stderr.write(`harness-lab: ${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`harness-lab failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(3);
  },
);
