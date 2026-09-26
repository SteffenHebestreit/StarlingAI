/**
 * Where turns spend their time, and what each latency lever could take off them — offline, from
 * audit logs. Layer 1 of the latency suite (eval/latency/README.md): no model, no network, no config.
 *
 *   pnpm --filter @starlingai/core latency:report [--audit <file> ...] [--json] [--out <dir>]
 *     [--coverage 1.0] [--laya-ms 20] [--decode-tps 56] [--cold-tps 900]
 *     [--subagent-warm-ms 1500] [--search-warm-ms 3700]
 *
 * --audit may be given more than once (the live log, a bench's own log, a session export's rows);
 * rows are merged and deduplicated by id. Without it the repo's .starlingai/audit.jsonl is read —
 * the gateway's live log through the docker mount. Relative paths are taken from the repo root.
 * The report (report.json + report.md) goes to <out>/<timestamp>/, --out defaulting to
 * .starlingai/live-check/latency-report; the Markdown is printed, or the JSON with --json.
 *
 * The rows can hold the user's words; the report never carries a string from a row other than
 * identifiers (agent, tool and call-site names, statuses) and message lengths.
 *
 * Exit codes: 0 a report over at least one turn; 2 a usage mistake, or INCONCLUSIVE — the input held
 * no turn, so nothing was attributed; 3 an input file is missing or unreadable. pnpm reports every
 * non-zero code as 1, so the verdict is also printed.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attributeLatency,
  dedupeRows,
  parseAuditJsonl,
  renderLatencyMarkdown,
  type AuditRow,
  type LatencyParams,
  type ReportInputs,
} from "../agent/latency-attribution.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export interface LatencyReportArgs {
  audits: string[];
  json: boolean;
  out: string;
  params: Partial<LatencyParams>;
}

const NUMERIC_FLAGS: Readonly<Record<string, { key: keyof LatencyParams; min: number; max?: number }>> = Object.freeze({
  "--coverage": { key: "coverage", min: 0, max: 1 },
  "--laya-ms": { key: "layaMs", min: 0 },
  "--decode-tps": { key: "decodeTokensPerSec", min: Number.MIN_VALUE },
  "--cold-tps": { key: "coldPrefillTokensPerSec", min: Number.MIN_VALUE },
  "--subagent-warm-ms": { key: "subagentWarmTtftMs", min: 0 },
  "--search-warm-ms": { key: "agentSearchWarmMs", min: 0 },
});

/** Parse the command line; throws a usage message on anything it does not understand. */
export function parseLatencyReportArgs(argv: readonly string[], root: string = repoRoot): LatencyReportArgs {
  const fromRoot = (path: string): string => (isAbsolute(path) ? path : resolve(root, path));
  const audits: string[] = [];
  const params: Partial<LatencyParams> = {};
  let json = false;
  let out = join(root, ".starlingai", "live-check", "latency-report");
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === "--json") {
      json = true;
      continue;
    }
    const value = argv[i + 1];
    if (flag === "--audit" || flag === "--out") {
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a path`);
      if (flag === "--audit") audits.push(fromRoot(value));
      else out = fromRoot(value);
      i += 1;
      continue;
    }
    const numeric = NUMERIC_FLAGS[flag];
    if (numeric) {
      const parsed = Number(value);
      if (value === undefined || !Number.isFinite(parsed) || parsed < numeric.min || (numeric.max !== undefined && parsed > numeric.max)) {
        throw new Error(`${flag} needs a number${numeric.max !== undefined ? ` between ${numeric.min} and ${numeric.max}` : ` of at least ${numeric.min}`}`);
      }
      (params as Record<string, number>)[numeric.key] = parsed;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${flag}`);
  }
  if (audits.length === 0) audits.push(join(root, ".starlingai", "audit.jsonl"));
  return { audits, json, out, params };
}

async function main(): Promise<number> {
  let args: LatencyReportArgs;
  try {
    args = parseLatencyReportArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Usage error: ${(err as Error).message}`);
    console.error("latency:report [--audit <file> ...] [--json] [--out <dir>] [--coverage 0..1] [--laya-ms n] [--decode-tps n] [--cold-tps n] [--subagent-warm-ms n] [--search-warm-ms n]");
    return 2;
  }

  const inputs: ReportInputs = { files: [], duplicates: 0 };
  const rows: AuditRow[] = [];
  for (const path of args.audits) {
    if (!existsSync(path)) {
      console.error(`ENVIRONMENT: no audit log at ${path}`);
      return 3;
    }
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      console.error(`ENVIRONMENT: cannot read ${path}: ${(err as Error).message}`);
      return 3;
    }
    const parsed = parseAuditJsonl(text);
    inputs.files.push({ path, rows: parsed.rows.length, malformedLines: parsed.malformedLines });
    rows.push(...parsed.rows);
  }
  const deduped = dedupeRows(rows);
  inputs.duplicates = deduped.duplicates;

  const report = attributeLatency(deduped.rows, args.params);
  const markdown = renderLatencyMarkdown(report, inputs);
  const dir = join(args.out, new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), inputs, ...report }, null, 2)}\n`, "utf8");
  await writeFile(join(dir, "report.md"), markdown, "utf8");

  console.log(args.json ? JSON.stringify({ inputs, ...report }, null, 2) : markdown);
  if (report.scope.turns === 0) {
    console.error(`INCONCLUSIVE: no turn in ${deduped.rows.length} row(s) — nothing was attributed. Report: ${dir}`);
    return 2;
  }
  console.error(`REPORT: ${report.scope.turns} turn(s) in ${report.scope.sessions} session(s)${report.scope.thin ? " — THIN DATA" : ""}. Report: ${dir}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err: unknown) => {
    // Parsing and attribution do not throw on bad rows, so what is left is the file system
    // (an out dir that cannot be written): the run says nothing about the turns.
    console.error(err);
    process.exitCode = 3;
  });
}
