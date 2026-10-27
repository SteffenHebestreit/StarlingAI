/// <reference types="node" />
/**
 * The harness lab's nightly timer, run by the stack's `harness-lab` service (docker-compose.yml):
 *
 *   node packages/core/dist/scripts/harness-lab-timer.js [--at 02:30] [--tz Europe/Berlin] [--once]
 *        [--budget 4h] [--quiet 10m] [--no-harvest] [--workspace /workspace] [--log <file>]
 *
 * It stays running and every day at --at (a clock in --tz, default UTC) runs one night: it harvests
 * the turns that failed live in the last two days into the review inbox (`harness-lab harvest`),
 * then runs `harness-lab nightly`, which gives way to live use, stops once its budget is spent and
 * goes on with that run the next night. Each step is a process of its own, so a night that fails
 * leaves the timer running; nothing in it applies a change (the lab files pending proposals only).
 * A night missed while the stack was down is not made up.
 *
 * --once runs one night now and exits with the nightly run's code: 0 a verdict, 3 no verdict,
 * 4 paused on the budget, 5 another night still runs (the lock <nightly root>/timer.lock).
 * Paths are the deployment's workspace as the container sees it (--workspace, default /workspace).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTimeZone, nextRunAt, parseTimeOfDay, processAlive, releaseNightLock, takeNightLock, type TimeOfDay } from "../harness-lab/timer.js";
import { parseDuration } from "../harness-lab/yield.js";

class UsageError extends Error {}

const VALUE_FLAGS = new Set(["at", "tz", "budget", "quiet", "workspace", "log"]);
const BOOL_FLAGS = new Set(["once", "no-harvest"]);

function parseFlags(argv: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new UsageError(`unexpected argument "${arg}"`);
    const name = arg.slice(2);
    if (BOOL_FLAGS.has(name)) { flags.set(name, true); continue; }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`unknown flag --${name}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
    flags.set(name, value);
    i += 1;
  }
  return flags;
}

interface Settings {
  time: TimeOfDay;
  at: string;
  timeZone: string;
  budget: string;
  budgetMs: number;
  quiet: string;
  once: boolean;
  harvest: boolean;
  tasks: string;
  inbox: string;
  root: string;
  logFile?: string;
}

function readSettings(argv: string[]): Settings {
  const flags = parseFlags(argv);
  const option = (name: string, fallback: string) => {
    const value = flags.get(name);
    return typeof value === "string" ? value : fallback;
  };
  const at = option("at", "02:30");
  const time = parseTimeOfDay(at);
  if (!time) throw new UsageError(`--at takes a time of day like 02:30 (got "${at}")`);
  const timeZone = option("tz", "UTC");
  if (!isTimeZone(timeZone)) throw new UsageError(`--tz takes a time zone like Europe/Berlin (got "${timeZone}")`);
  const budget = option("budget", "4h");
  const budgetMs = parseDuration(budget);
  if (budgetMs === null || budgetMs <= 0) throw new UsageError(`--budget takes a duration like 45m or 4h (got "${budget}")`);
  const quiet = option("quiet", "10m");
  if (parseDuration(quiet) === null) throw new UsageError(`--quiet takes a duration like 10m (got "${quiet}")`);
  const workspace = option("workspace", "/workspace");
  const logFile = flags.get("log");
  return {
    time, at, timeZone, budget, budgetMs, quiet,
    once: flags.has("once"),
    harvest: !flags.has("no-harvest"),
    tasks: join(workspace, "eval", "harness-lab", "tasks"),
    inbox: join(workspace, "eval", "harness-lab", "inbox"),
    root: join(workspace, ".starlingai", "harness-lab", "nightly"),
    ...(typeof logFile === "string" ? { logFile } : {}),
  };
}

// The lab CLI next to this file: harness-lab.js in the build, harness-lab.ts under tsx.
const self = fileURLToPath(import.meta.url);
const LAB = join(dirname(self), basename(self).replace("harness-lab-timer", "harness-lab"));
const owner = { pid: process.pid, host: hostname() };

let logFile: string | undefined;
function write(text: string): void {
  process.stdout.write(text);
  if (logFile) {
    try {
      appendFileSync(logFile, text);
    } catch {
      // The log file is a convenience; the container's own log has every line.
    }
  }
}
const log = (line: string) => write(`[${new Date().toISOString()}] ${line}\n`);

let child: ChildProcess | null = null;
let stopping = false;
let lockFile: string | undefined;

/** One lab command as a process of its own, its output into this log; its exit code. */
function lab(command: string, args: string[]): Promise<number> {
  log(`harness-lab ${command}`);
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [...process.execArgv, LAB, command, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    child = proc;
    proc.stdout.on("data", (chunk: Buffer) => write(chunk.toString("utf8")));
    proc.stderr.on("data", (chunk: Buffer) => write(chunk.toString("utf8")));
    proc.on("error", (err) => { log(`harness-lab ${command} did not start: ${err.message}`); });
    proc.on("close", (code) => { child = null; resolve(code ?? 1); });
  });
}

/** One night: the harvest, then the nightly run, under the lock. */
async function night(settings: Settings): Promise<number> {
  mkdirSync(settings.root, { recursive: true });
  lockFile = join(settings.root, "timer.lock");
  // A night holds the lock for its budget and the harvest before it; one older was never released.
  const lock = takeNightLock(lockFile, { ...owner, now: Date.now(), staleMs: settings.budgetMs + 3_600_000, alive: processAlive });
  if (!lock.taken) {
    const holder = lock.holder;
    log(`another night still runs (${holder ? `pid ${holder.pid} on ${holder.host} since ${holder.startedAt}` : "lock unreadable"}): this one is skipped`);
    return 5;
  }
  try {
    if (settings.harvest) {
      const day = new Date().toISOString().slice(0, 10);
      // A failed harvest costs the night's new tasks, not the run.
      await lab("harvest", ["--since", "2d", "--tasks", settings.tasks, "--inbox", settings.inbox, "--out", join(settings.root, `harvest-${day}`)]);
    }
    if (stopping) return 143;
    return await lab("nightly", ["--tasks", settings.tasks, "--out", settings.root, "--budget", settings.budget, "--quiet", settings.quiet]);
  } finally {
    releaseNightLock(lockFile, owner);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// `docker stop`: a running lab command is told to stop (it keeps what it recorded) and the night
// ends with it; a timer between commands or waiting exits at once. As PID 1 node has no default handler.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopping = true;
    if (child) {
      child.kill(signal);
      return;
    }
    if (lockFile) releaseNightLock(lockFile, owner);
    process.exit(0);
  });
}

async function main(): Promise<number> {
  const settings = readSettings(process.argv.slice(2));
  logFile = settings.logFile;
  if (settings.once) return night(settings);
  log(`harness lab timer: one night every day at ${settings.at} (${settings.timeZone})`);
  while (!stopping) {
    const next = nextRunAt(Date.now(), settings.time, settings.timeZone);
    log(`next night at ${new Date(next).toISOString()}`);
    // Short sleeps against the wall clock: a host that slept, or a clock that jumped, is caught up.
    while (Date.now() < next) await sleep(Math.min(next - Date.now(), 60_000));
    log(`night over: exit ${await night(settings)}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof UsageError) {
      process.stderr.write(`harness-lab-timer: ${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`harness-lab-timer failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(3);
  },
);
