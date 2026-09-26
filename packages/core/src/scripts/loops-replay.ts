/**
 * Where the loop brake (agents.performance.loopBrake) would have acted on runs that already
 * happened — offline, from audit logs. No model, no network, no config; the rules themselves are
 * the shipped ones (agent/loop-replay.ts calls classifyCallReplay and classifyRunProgress).
 *
 *   pnpm --filter @starlingai/core loops:replay [--audit <file> ...] [--session <id-prefix>] [--json] [--out <dir>]
 *
 * --audit may be given more than once; rows are merged and deduplicated by id. Without it the repo's
 * .starlingai/audit.jsonl is read. --session keeps only sub-agent runs whose top-level session starts
 * with the given prefix (a turn's session id, or its first 8 characters). Relative paths are taken
 * from the repo root. The report (report.json + report.md) goes to <out>/<timestamp>/, --out
 * defaulting to .starlingai/live-check/loops-replay; the Markdown is printed, or the JSON with --json.
 *
 * The rows hold the user's words (tool arguments, result previews); the report carries only ids,
 * agent and tool names, counts and seconds.
 *
 * Exit codes: 0 a report over at least one run and no stop or wind-down on a run that ended in
 * success; 1 a stop or wind-down on a run that ended in success (the replay's gate); 2 a usage
 * mistake, or INCONCLUSIVE — no sub-agent run with tool calls in the input; 3 an input file is
 * missing or unreadable. pnpm reports every non-zero code as 1, so the verdict is also printed.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dedupeRows, parseAuditJsonl, rootSessionId, type AuditRow } from "../agent/latency-attribution.js";
import { renderLoopReplayMarkdown, replayLoopBrake } from "../agent/loop-replay.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export interface LoopsReplayArgs {
  audits: string[];
  session: string | null;
  json: boolean;
  out: string;
}

/** Parse the command line; throws a usage message on anything it does not understand. */
export function parseLoopsReplayArgs(argv: readonly string[], root: string = repoRoot): LoopsReplayArgs {
  const fromRoot = (path: string): string => (isAbsolute(path) ? path : resolve(root, path));
  const audits: string[] = [];
  let session: string | null = null;
  let json = false;
  let out = join(root, ".starlingai", "live-check", "loops-replay");
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === "--json") {
      json = true;
      continue;
    }
    const value = argv[i + 1];
    if (flag === "--audit" || flag === "--out" || flag === "--session") {
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      if (flag === "--audit") audits.push(fromRoot(value));
      else if (flag === "--out") out = fromRoot(value);
      else session = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${flag}`);
  }
  if (audits.length === 0) audits.push(join(root, ".starlingai", "audit.jsonl"));
  return { audits, session, json, out };
}

async function main(): Promise<number> {
  let args: LoopsReplayArgs;
  try {
    args = parseLoopsReplayArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Usage error: ${(err as Error).message}`);
    console.error("loops:replay [--audit <file> ...] [--session <id-prefix>] [--json] [--out <dir>]");
    return 2;
  }

  const rows: AuditRow[] = [];
  for (const path of args.audits) {
    if (!existsSync(path)) {
      console.error(`ENVIRONMENT: no audit log at ${path}`);
      return 3;
    }
    try {
      rows.push(...parseAuditJsonl(readFileSync(path, "utf8")).rows);
    } catch (err) {
      console.error(`ENVIRONMENT: cannot read ${path}: ${(err as Error).message}`);
      return 3;
    }
  }
  const deduped = dedupeRows(rows).rows;
  const scoped = args.session
    ? deduped.filter((row) => row.sessionId !== undefined && rootSessionId(row.sessionId).startsWith(args.session!))
    : deduped;

  const report = replayLoopBrake(scoped);
  const markdown = renderLoopReplayMarkdown(report, { files: args.audits, rows: scoped.length });
  const dir = join(args.out, new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), session: args.session, ...report }, null, 2)}\n`, "utf8");
  await writeFile(join(dir, "report.md"), markdown, "utf8");

  console.log(args.json ? JSON.stringify(report, null, 2) : markdown);
  const s = report.summary;
  if (s.runs === 0) {
    console.error(`INCONCLUSIVE: no sub-agent run with tool calls in ${scoped.length} row(s). Report: ${dir}`);
    return 2;
  }
  if (s.stopsOnSuccess > 0 || s.windDownsAfterOnSuccess > 0) {
    console.error(`FAIL: the brake would have stopped ${s.stopsOnSuccess} and wound down ${s.windDownsAfterOnSuccess} run(s) that ended in success. Report: ${dir}`);
    return 1;
  }
  console.error(`PASS: ${s.runsWithStop} stop(s) and ${s.windDownsAfter} wind-down(s) over ${s.runs} run(s), none on a run that ended in success. Report: ${dir}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 3;
  });
}
