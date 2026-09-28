/**
 * Does the intent readout agree with what real turns did? — offline, from the
 * `intent_readout_shadow` rows orchestration.intentReadout: "shadow" writes after each turn. No
 * model, no network, no config.
 *
 *   pnpm --filter @starlingai/core intent:report [--audit <file> ...] [--json] [--out <dir>]
 *
 * --audit may be given more than once (the live log, a session export's rows); rows are merged and
 * deduplicated by id. Without it the repo's .starlingai/audit.jsonl is read — the gateway's live log
 * through the docker mount. A relative path is taken from the repo root, an absolute one as it is.
 * The report (report.json + report.md) goes to <out>/<timestamp>/, --out defaulting to
 * .starlingai/live-check/intent-report; the Markdown is printed, or the JSON with --json.
 *
 * The tables, what "actual" means in each, and why they are agreement rather than accuracy:
 * agent/intent-report.ts. The rows hold no user text; the report copies identifiers, option keys
 * and numbers only.
 *
 * Exit codes: 0 a report over at least one shadow row of the current readout version; 2 a usage
 * mistake, or INCONCLUSIVE — no such row; 3 an input file is missing or unreadable. pnpm reports
 * every non-zero code as 1, so the verdict is also printed.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIntentReport, renderIntentReportMarkdown } from "../agent/intent-report.js";
import { dedupeRows, parseAuditJsonl, type AuditRow } from "../agent/latency-attribution.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export interface IntentReportArgs {
  audits: string[];
  json: boolean;
  out: string;
}

/** Parse the command line; throws a usage message on anything it does not understand. */
export function parseIntentReportArgs(argv: readonly string[], root: string = repoRoot): IntentReportArgs {
  const fromRoot = (path: string): string => (isAbsolute(path) ? path : resolve(root, path));
  const audits: string[] = [];
  let json = false;
  let out = join(root, ".starlingai", "live-check", "intent-report");
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    // pnpm passes a separating "--" through to the script (`pnpm intent:report -- --audit x`), as
    // decisions-bench.ts notes; refused, it turned the documented command into a usage error.
    if (flag === "--") continue;
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (flag === "--audit" || flag === "--out") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a path`);
      if (flag === "--audit") audits.push(fromRoot(value));
      else out = fromRoot(value);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${flag}`);
  }
  if (audits.length === 0) audits.push(join(root, ".starlingai", "audit.jsonl"));
  return { audits, json, out };
}

async function main(): Promise<number> {
  let args: IntentReportArgs;
  try {
    args = parseIntentReportArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Usage error: ${(err as Error).message}`);
    console.error("intent:report [--audit <file> ...] [--json] [--out <dir>]");
    return 2;
  }

  const inputs: { files: Array<{ path: string; rows: number; malformedLines: number }>; duplicates: number } = { files: [], duplicates: 0 };
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

  const report = buildIntentReport(deduped.rows);
  const markdown = renderIntentReportMarkdown(report, inputs);
  const dir = join(args.out, new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), inputs, ...report }, null, 2)}\n`, "utf8");
  await writeFile(join(dir, "report.md"), markdown, "utf8");

  console.log(args.json ? JSON.stringify({ inputs, ...report }, null, 2) : markdown);
  if (report.scope.rows === 0) {
    const other = Object.values(report.scope.otherVersions).reduce((sum, count) => sum + count, 0);
    console.error(`INCONCLUSIVE: no intent_readout_shadow row of ${report.version} in ${deduped.rows.length} row(s)${other ? ` (${other} of other versions)` : ""} — is orchestration.intentReadout "shadow"? Report: ${dir}`);
    return 2;
  }
  console.error(`REPORT: ${report.scope.rows} shadow row(s), ${report.scope.turnsWithReadout} with a reading, ${report.scope.sessions} session(s)${report.scope.thin ? " — THIN DATA" : ""}. Report: ${dir}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err: unknown) => {
    // Parsing and the tables do not throw on bad rows, so what is left is the file system.
    console.error(err);
    process.exitCode = 3;
  });
}
