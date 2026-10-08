/**
 * End-to-end evaluation CLI.
 *
 *   pnpm e2e:evaluate [--group g] [--tag t] [--id x] [--repeat k] [--concurrency n]
 *                     [--baseline report.json] [--out dir] [--scenarios dir] [--keep-memory] [--list]
 *   pnpm e2e:validate [--scenarios dir]
 *   pnpm e2e:setup [--remove]
 *
 * --group/--tag/--id repeat or take comma-separated lists; relative paths are taken from where
 * pnpm was run (INIT_CWD). Environment: E2E_GATEWAY_URL, E2E_CREDENTIALS_PATH, E2E_EVENT_GRACE_MS,
 * E2E_JUDGE_URL/E2E_JUDGE_MODEL/E2E_JUDGE_API_KEY, E2E_MAIL_API, E2E_MAIL_SMTP, E2E_MAIL_INBOX,
 * E2E_SITE_URL, E2E_SEARXNG_URL (see eval/e2e/README.md).
 *
 * Before any scenario runs, evaluate checks that the eval identity sees no shared mail account
 * (the operator's real mail) and refuses to run — fail closed — when it does or cannot tell. It also
 * refuses while another evaluate run uses the same gateway (acquireRunLock).
 *
 * Exit codes: 0 every scenario that ran passed · 1 a scenario failed ·
 * 2 usage, invalid scenarios, missing credentials, a refused login, the mail-isolation
 * preflight or another run against the same gateway · 3 environment-suspect (everything skipped,
 * a fifth of the selected scenarios skipped for one service, or a quarter of the attempts ended on
 * harness errors). Through pnpm a non-zero code may surface as 1.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findRepoRoot, resolveE2EPaths } from "./paths.js";
import { filterScenarios, loadScenarios, type LoadedScenario } from "./loader.js";
import { describeError, E2EInfraError, GatewayClient, gatewayUrlFromEnv, isRecord, readCredentialsFile } from "./gateway-client.js";
import { judgeConfigFromEnv } from "./judge.js";
import { mailAdapterFromEnv } from "./mail.js";
import {
  DEFAULT_E2E_SITE_URL,
  environmentFromSource,
  environmentStatusSource,
  mailIsolationCheck,
  ServiceProber,
  type EnvironmentStatusSource,
  type MailIsolationCheck,
} from "./services.js";
import {
  adoptUnconfirmedTurns,
  RUNNER_DEFAULTS,
  runScenarios,
  unconfirmedTurnsOf,
  watchUnconfirmedTurns,
  type RunnerOptions,
  type UnconfirmedTurn,
} from "./runner.js";
import { buildReport, compareWithBaseline, describeBuildChanges, describeSuite, exitCodeFor, loadReport, writeReport, type BaselineComparison } from "./report.js";
import { captureProvenance, describeProvenance, readGatewayModel, type E2EProvenance, type ModelSource } from "./provenance.js";
import { resolveSetupPaths, runE2ESetup, SetupRefusedError } from "./setup.js";

const VALUE_FLAGS = new Set(["group", "tag", "id", "repeat", "concurrency", "baseline", "out", "scenarios"]);
const BOOLEAN_FLAGS = new Set(["remove", "list", "help", "keep-memory"]);

interface ParsedArgs {
  command: string;
  values: Map<string, string[]>;
  booleans: Set<string>;
}

class UsageError extends Error {}

/** Where Ctrl+C comes from, and how a second one quits. */
export interface InterruptHooks {
  on: (listener: () => void) => void;
  off: (listener: () => void) => void;
  exit: (code: number) => void;
}

const PROCESS_INTERRUPTS: InterruptHooks = {
  on: (listener) => {
    process.on("SIGINT", listener);
  },
  off: (listener) => {
    process.off("SIGINT", listener);
  },
  exit: (code) => process.exit(code),
};

/** Where the CLI reads its environment and writes its output; tests replace parts of it. */
export interface CliIo {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Ctrl+C cancels running turns (the real CLI only). */
  handleSigint?: boolean;
  /** Stands in for the process's Ctrl+C and exit in tests; given, Ctrl+C is handled as with handleSigint. */
  interrupts?: InterruptHooks;
  /** The run lock's directory (runLockPath). Default: the system's temp directory. */
  lockDir?: string;
  /** Runner timings a test shortens. */
  runner?: Pick<RunnerOptions, "cancelGraceMs">;
  /** The e2e environment status (`scripts/e2e-env.mjs status --json`); null: none. Default: the repo's script. */
  environment?: EnvironmentStatusSource | null;
  /** The mail-isolation preflight. Default: read from the environment status. */
  mailIsolation?: MailIsolationCheck;
  /** What the run ran on. Default: git of the repo root, the environment status's gateway image and config, and the gateway's models. */
  provenance?: () => Promise<E2EProvenance>;
  repoRoot?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const raw = rest[index]!;
    if (raw === "--") continue;
    if (!raw.startsWith("--")) throw new UsageError(`unexpected argument "${raw}"`);
    const [name, inline] = raw.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (BOOLEAN_FLAGS.has(name)) {
      booleans.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`unknown option --${name}`);
    const value = inline ?? rest[index + 1];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new UsageError(`--${name} needs a value`);
    if (inline === undefined) index += 1;
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return { command, values, booleans };
}

function list(args: ParsedArgs, name: string): string[] {
  return (args.values.get(name) ?? []).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

function single(args: ParsedArgs, name: string): string | undefined {
  const values = args.values.get(name);
  return values && values.length > 0 ? values[values.length - 1] : undefined;
}

/** A path the user typed: relative to where they ran pnpm (INIT_CWD), not to packages/core. */
function userPath(io: CliIo, path: string): string {
  return resolve(io.env["INIT_CWD"] ?? process.cwd(), path);
}

function positiveInt(args: ParsedArgs, name: string, fallback: number): number {
  const raw = single(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new UsageError(`--${name} must be a positive integer, got "${raw}"`);
  return value;
}

function nonNegativeIntFromEnv(io: CliIo, name: string, fallback: number): number {
  const raw = io.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new UsageError(`${name} must be a whole number of milliseconds, got "${raw}"`);
  return value;
}

const HELP = `Usage:
  pnpm e2e:evaluate [--group g] [--tag t] [--id x] [--repeat k] [--concurrency n] [--baseline report.json] [--out dir] [--scenarios dir] [--keep-memory] [--list]
  pnpm e2e:validate [--scenarios dir]
  pnpm e2e:setup [--remove]
See eval/e2e/README.md.`;

function validate(args: ParsedArgs, io: CliIo, repoRoot: string): number {
  const paths = resolveE2EPaths(repoRoot, io.env);
  const scenariosArg = single(args, "scenarios");
  const dir = scenariosArg ? userPath(io, scenariosArg) : paths.scenariosDir;
  const { scenarios, issues } = loadScenarios(dir, paths.fixturesDir);
  for (const issue of issues) io.err(`INVALID ${issue.file}: ${issue.message}`);
  if (issues.length > 0) {
    io.err(`${issues.length} problem(s) in ${dir}`);
    return 1;
  }
  io.out(`${scenarios.length} scenario(s) valid in ${dir}`);
  return 0;
}

/** Whether a process with this id runs (EPERM: it does, under another user). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The gateway a URL names, for the run lock: scheme, host, port and path, with every loopback
 * spelling (localhost, 127.0.0.0/8, ::1) as one, since from this machine they reach one gateway.
 */
function gatewayKey(gatewayUrl: string): string {
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    return gatewayUrl;
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const loopback = host === "localhost" || host.endsWith(".localhost")
    || (isIP(host) === 4 && host.startsWith("127.")) || (isIP(host) === 6 && host === "::1");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.protocol}//${loopback ? "loopback" : host}:${port}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * The gateway's run lock: one file per gateway in the system's temp directory, whichever checkout,
 * credentials file or spelling of the URL a run uses. The eval accounts are the gateway's.
 */
export function runLockPath(gatewayUrl: string, dir = tmpdir()): string {
  const digest = createHash("sha256").update(gatewayKey(gatewayUrl)).digest("hex").slice(0, 16);
  return join(dir, `starlingai-e2e-run-${digest}.json`);
}

interface RunLock {
  pid: number;
  startedAt?: string;
  /** The run ended, leaving turns it had not seen end: the lock is free, the turns pass on. */
  ended?: string;
  /** Turns not seen to end: while the run holds the lock, those it has in flight; once it ended, those it left. */
  turns: UnconfirmedTurn[];
}

function isUnconfirmedTurn(value: unknown): value is UnconfirmedTurn {
  return isRecord(value)
    && typeof value["identity"] === "string" && value["identity"] !== ""
    && typeof value["requestId"] === "string" && value["requestId"] !== ""
    && typeof value["sessionId"] === "string" && value["sessionId"] !== ""
    && typeof value["sentAt"] === "number" && Number.isFinite(value["sentAt"]);
}

/** The lock, or null when it cannot be read: turns it holds but cannot name included, as they may still run. */
function readRunLock(path: string): RunLock | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || typeof parsed["pid"] !== "number") return null;
    const turns: unknown = parsed["turns"] ?? [];
    if (!Array.isArray(turns) || !turns.every(isUnconfirmedTurn)) return null;
    return {
      pid: parsed["pid"],
      ...(typeof parsed["startedAt"] === "string" ? { startedAt: parsed["startedAt"] } : {}),
      ...(typeof parsed["ended"] === "string" ? { ended: parsed["ended"] } : {}),
      turns: turns.map(({ identity, requestId, sessionId, sentAt }) => ({ identity, requestId, sessionId, sentAt })),
    };
  } catch {
    return null;
  }
}

interface RunLockHandle {
  /** Turns an earlier run left in the lock. */
  inherited: UnconfirmedTurn[];
  /**
   * Writes the turns not seen to end into the lock, replacing it whole (a temporary file renamed
   * over it), so a run killed at any moment leaves them. Like release, leaves a lock alone that
   * another process holds by now (deleted by hand, then taken). Throws when it cannot be written, or
   * is gone or cannot be read: the turns it should list are then nowhere.
   */
  persist: (turns: readonly UnconfirmedTurn[]) => void;
  /** Gives the lock up; turns not seen to end stay in it for the next run. */
  release: (turns: readonly UnconfirmedTurn[]) => void;
}

/**
 * One evaluate run at a time per gateway. Two runs share the gateway's eval accounts, and each
 * resets the attempt identity's memory before every attempt (and a mail scenario purges every
 * mailbox): one run's reset deleted what the other's memory scenario stored between its two turns,
 * and that scenario failed on the harness's own doing. The concurrency gate sees only its own
 * process. The lock used to sit beside the credentials file, so two checkouts against one gateway
 * (or two E2E_CREDENTIALS_PATH values) each took a lock of their own.
 *
 * The lock is created exclusively. One whose process is gone (a crash) is taken over; one that
 * cannot be read counts as held, since a run may be writing it this moment. A run that ends, or
 * quits at once on a second Ctrl+C, leaves the turns it has not seen end in the lock, marked ended:
 * the next run takes them over, and its reset of their account waits for them. A second Ctrl+C used
 * to delete the lock while the turn the first one stopped was still unwinding, and the next run
 * reset the account under a turn that could still store memory.
 *
 * A run that dies leaves them too: the lock lists the turns it inherits from the moment it is taken,
 * and the run's own as they are sent and seen to end (persist). Only an end of the run used to write
 * them, so a run killed mid-turn (TaskStop, Stop-Process, a closed terminal) left a lock with none,
 * and the next run took it over and reset the account under a turn that went on storing memory.
 */
function acquireRunLock(path: string, gatewayUrl: string): RunLockHandle | { refusal: string } {
  const startedAt = new Date().toISOString();
  const held = (turns: readonly UnconfirmedTurn[]): string =>
    JSON.stringify({ pid: process.pid, startedAt, gateway: gatewayUrl, ...(turns.length > 0 ? { turns } : {}) });
  let inherited: UnconfirmedTurn[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, held(inherited), { flag: "wx" });
      return {
        inherited,
        persist: (turns) => {
          const holder = readRunLock(path);
          if (!holder) throw new Error("the lock is gone or cannot be read");
          if (holder.pid !== process.pid) return;
          const temporary = `${path}.${process.pid}.tmp`;
          try {
            writeFileSync(temporary, held(turns));
            renameSync(temporary, path);
          } catch (err) {
            try {
              rmSync(temporary, { force: true });
            } catch {
              // The write's own error is the one to report.
            }
            throw err;
          }
        },
        release: (turns) => {
          if (readRunLock(path)?.pid !== process.pid) return;
          if (turns.length === 0) rmSync(path, { force: true });
          else writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt, gateway: gatewayUrl, ended: new Date().toISOString(), turns }));
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw new E2EInfraError(`cannot take the run lock ${path}: ${describeError(err)}`);
    }
    const holder = readRunLock(path);
    if (!holder || (!holder.ended && processAlive(holder.pid))) {
      const who = holder ? `another e2e run (pid ${holder.pid}${holder.startedAt ? `, since ${holder.startedAt}` : ""})` : "another e2e run";
      return { refusal: `${who} is using the eval accounts, and two runs break each other's scenarios (one's memory reset or mail purge lands in the other's attempts). Wait for it, or delete ${path} if no such run is left.` };
    }
    inherited = holder.turns;
    rmSync(path, { force: true });
  }
  return { refusal: `the run lock ${path} could not be taken` };
}

function baselineLine(baseline: BaselineComparison): string {
  const ids = (deltas: BaselineComparison["regressions"]): string => {
    if (deltas.length === 0) return "";
    const shown = deltas.slice(0, 6).map((delta) => delta.id).join(", ");
    return ` (${shown}${deltas.length > 6 ? ", …" : ""})`;
  };
  return `Baseline: ${baseline.regressions.length} regression(s)${ids(baseline.regressions)}, ${baseline.flaky.length} flaky${ids(baseline.flaky)}, `
    + `${baseline.inconclusive.length} inconclusive${ids(baseline.inconclusive)}, ${baseline.improvements.length} improvement(s)${ids(baseline.improvements)}`
    + `${baseline.noTrial.length > 0 ? `, ${baseline.noTrial.length} with no trial${ids(baseline.noTrial)}` : ""}; `
    + `suite ${describeSuite(baseline.suite)}; builds: ${describeBuildChanges(baseline.buildChanges)}`
    + (baseline.confounded.length > 0 ? `; CONFOUNDED — ${baseline.confounded.join("; ")}` : "");
}

function identitiesOf(selected: readonly LoadedScenario[]): string[] {
  const identities = new Set<string>();
  for (const { scenario } of selected) {
    const identity = scenario.identity ?? "eval";
    if (scenario.steps.some((step) => step.kind === "turn" || step.kind === "http")) identities.add(identity);
    for (const step of scenario.steps) if ((step.kind === "http" || step.kind === "turn") && step.as) identities.add(step.as);
  }
  return [...identities];
}

async function evaluate(args: ParsedArgs, io: CliIo, repoRoot: string): Promise<number> {
  const paths = resolveE2EPaths(repoRoot, io.env);
  const scenariosArg = single(args, "scenarios");
  const scenariosDir = scenariosArg ? userPath(io, scenariosArg) : paths.scenariosDir;
  const { scenarios, issues } = loadScenarios(scenariosDir, paths.fixturesDir);
  if (issues.length > 0) {
    for (const issue of issues) io.err(`INVALID ${issue.file}: ${issue.message}`);
    io.err("Fix the scenario files (pnpm e2e:validate) before a run.");
    return 2;
  }
  const filter = { groups: list(args, "group"), tags: list(args, "tag"), ids: list(args, "id") };
  const { selected, unknownIds } = filterScenarios(scenarios, filter);
  if (unknownIds.length > 0) {
    io.err(`No scenario with id ${unknownIds.join(", ")}`);
    return 2;
  }
  const filtered = filter.groups.length + filter.tags.length + filter.ids.length > 0;
  if (selected.length === 0) {
    io.out(filtered ? "No scenario matches the filters." : `No scenarios in ${scenariosDir} (templates run only with --id).`);
    return filtered ? 2 : 0;
  }
  if (args.booleans.has("list")) {
    for (const { scenario, file } of selected) io.out(`${scenario.id}  [${scenario.group}]  ${scenario.title}  (${file})`);
    return 0;
  }

  const repeat = positiveInt(args, "repeat", 1);
  const concurrency = positiveInt(args, "concurrency", 1);
  const eventGraceMs = nonNegativeIntFromEnv(io, "E2E_EVENT_GRACE_MS", RUNNER_DEFAULTS.eventGraceMs);
  const baselinePath = single(args, "baseline");
  const baseline = baselinePath ? loadReport(userPath(io, baselinePath)) : undefined;
  const outArg = single(args, "out");
  const outDir = outArg ? userPath(io, outArg) : paths.reportsDir;

  // Fail closed, before anything runs: an eval turn must never reach the operator's own mail.
  const environment = io.environment !== undefined ? io.environment : environmentStatusSource(repoRoot);
  const isolation = await (io.mailIsolation ?? mailIsolationCheck(environment))();
  if (!isolation.safe) {
    io.err(`Refusing to run: ${isolation.detail}`);
    return 2;
  }
  io.out(`Mail isolation: ${isolation.detail}`);

  const credentials = readCredentialsFile(paths.credentialsPath);
  const gatewayUrl = gatewayUrlFromEnv(io.env);
  const client = new GatewayClient({ baseUrl: gatewayUrl, credentials });
  const mail = mailAdapterFromEnv(io.env);
  const judge = judgeConfigFromEnv(io.env);
  const prober = new ServiceProber({
    gatewayUrl,
    authedGet: (path) => client.http("eval", "GET", path),
    mail,
    ...(environment ? { environment: environmentFromSource(environment) } : {}),
    siteUrl: io.env["E2E_SITE_URL"]?.trim() || DEFAULT_E2E_SITE_URL,
    ...(io.env["E2E_SEARXNG_URL"]?.trim() ? { searxngUrl: io.env["E2E_SEARXNG_URL"].trim() } : {}),
  });

  const lockPath = runLockPath(gatewayUrl, io.lockDir);
  const lock = acquireRunLock(lockPath, gatewayUrl);
  if ("refusal" in lock) {
    io.err(`Refusing to run: ${lock.refusal}`);
    return 2;
  }
  if (lock.inherited.length > 0) {
    // Named with the file: a turn no reset can confirm (its session deleted, the gateway not
    // restarted since) passes from run to run until someone deletes it.
    adoptUnconfirmedTurns(client, lock.inherited);
    const named = lock.inherited.map((turn) => `${turn.requestId} of ${turn.identity}`).join(", ");
    io.out(`An earlier run left ${lock.inherited.length} turn(s) it had not seen end (${named}) in ${lockPath}: the memory reset of their account waits for them.`);
  }
  // The lock lists the turns as they are sent and seen to end, so a run that is killed leaves them.
  let persistWarned = false;
  watchUnconfirmedTurns(client, (turns) => {
    try {
      lock.persist(turns);
    } catch (err) {
      if (persistWarned) return;
      persistWarned = true;
      io.err(`Warning: cannot write the turns in flight into the run lock ${lockPath} (${describeError(err)}): if this run is killed, the next one may reset an account under a turn still running.`);
    }
  });
  const interrupt = new AbortController();
  const interrupts = io.interrupts ?? (io.handleSigint ? PROCESS_INTERRUPTS : null);
  const onSigint = (): void => {
    if (interrupt.signal.aborted) {
      // Quits at once, while the turns the first Ctrl+C stopped may still run: the lock keeps them.
      lock.release(unconfirmedTurnsOf(client));
      interrupts?.exit(130);
      return;
    }
    io.err("\nInterrupted — cancelling running turns (Ctrl+C again to quit at once)…");
    interrupt.abort();
  };
  interrupts?.on(onSigint);
  try {
    // A refused login would fail every attempt the same way; say so once, up front.
    const [gateway] = await prober.check(["gateway"]);
    const identities = identitiesOf(selected);
    if (gateway?.up) {
      for (const identity of identities) {
        try {
          await client.token(identity);
        } catch (err) {
          io.err(err instanceof Error ? err.message : String(err));
          return 2;
        }
      }
    } else {
      io.err(`Gateway down: ${gateway?.detail ?? "unknown"} — its scenarios are skipped.`);
    }

    // What the run ran on; the gateway's models are read as an identity that just logged in.
    const modelIdentity = identities[0] ?? "eval";
    const model: ModelSource = gateway?.up
      ? () => readGatewayModel((path) => client.http(modelIdentity, "GET", path))
      : async () => ({ missing: `model: the gateway is down (${gateway?.detail ?? "unknown"})` });
    const provenance = await (io.provenance ?? (() => captureProvenance(repoRoot, environment, { model })))();
    io.out(`Build: ${describeProvenance(provenance)}`);
    for (const warning of provenance.warnings) io.out(`PROVENANCE: ${warning}`);

    const startedAt = new Date().toISOString();
    io.out(`Running ${selected.length} scenario(s) against ${gatewayUrl} (repeat ${repeat}, concurrency ${concurrency})`);
    const results = await runScenarios(selected, { client, prober, fixturesDir: paths.fixturesDir, mail, judge, log: io.out }, {
      repeat,
      concurrency,
      eventGraceMs,
      resetDurableMemory: !args.booleans.has("keep-memory"),
      signal: interrupt.signal,
      ...io.runner,
    });
    const report = buildReport(results, {
      startedAt,
      finishedAt: new Date().toISOString(),
      gatewayUrl,
      repeat,
      concurrency,
      filters: { groups: filter.groups, tags: filter.tags, ids: filter.ids },
      judge: judge ? `${judge.model} @ ${judge.url}` : null,
      mail: `${mail.name} (inbox ${mail.inbox})`,
      provenance,
    });
    if (baseline && baselinePath) report.baseline = compareWithBaseline(report, baseline, baselinePath);
    const written = writeReport(report, outDir);

    const { summary } = report;
    io.out("");
    io.out(`Scenarios: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped of ${summary.scenarios}`);
    io.out(`Attempts: ${summary.attemptsPassed}/${summary.attempts} passed (${(summary.passRate * 100).toFixed(1)} %), pass^k ${(summary.passAllRate * 100).toFixed(1)} %`);
    if (report.baseline) io.out(baselineLine(report.baseline));
    if (report.environment.suspect) io.out(`ENVIRONMENT SUSPECT: ${report.environment.reasons.join("; ")}`);
    for (const warning of provenance.warnings) io.out(`PROVENANCE: ${warning}`);
    io.out(`Report: ${written.jsonPath}`);
    io.out(`        ${written.markdownPath}`);
    return exitCodeFor(report);
  } finally {
    interrupts?.off(onSigint);
    const unconfirmed = unconfirmedTurnsOf(client);
    client.close();
    lock.release(unconfirmed);
  }
}

async function setup(args: ParsedArgs, io: CliIo, repoRoot: string): Promise<number> {
  const { credentialsPath } = resolveE2EPaths(repoRoot, io.env);
  const { paths, warnings } = resolveSetupPaths(repoRoot, credentialsPath, io.env);
  for (const warning of warnings) io.err(`Warning: ${warning}`);
  try {
    await runE2ESetup({ paths, remove: args.booleans.has("remove"), log: io.out });
    return 0;
  } catch (err) {
    if (err instanceof SetupRefusedError) {
      io.err(err.message);
      return 1;
    }
    throw err;
  }
}

/** Runs one CLI command and returns its exit code. */
export async function runE2ECli(argv: readonly string[], io: CliIo): Promise<number> {
  const repoRoot = io.repoRoot ?? findRepoRoot();
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}\n${HELP}`);
    return 2;
  }
  if (args.booleans.has("help") || args.command === "help") {
    io.out(HELP);
    return 0;
  }
  try {
    switch (args.command) {
      case "evaluate":
        return await evaluate(args, io, repoRoot);
      case "validate":
        return validate(args, io, repoRoot);
      case "setup":
        return await setup(args, io, repoRoot);
      default:
        io.err(`unknown command "${args.command}"\n${HELP}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError || err instanceof E2EInfraError) {
      io.err(err.message);
      return 2;
    }
    throw err;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = import.meta.url;
  const invoked = pathToFileURL(resolve(entry)).href;
  return process.platform === "win32" ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
}

if (isDirectRun()) {
  runE2ECli(process.argv.slice(2), {
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    handleSigint: true,
  }).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exit(2);
    },
  );
}
