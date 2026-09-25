/**
 * How the Laya decision layer is doing, from the decision ledger: per decision point and language, how often Laya was
 * asked, how often it decided, how well it agrees with the incumbent at each confidence level, and from which level
 * the adaptive gate would let it decide.
 *
 *   pnpm --filter @starlingai/core decisions:report [--ledger <path>] [--target 0.9] [--min 30] [--json]
 *
 * Agreement is with the incumbent — the LLM call or rule that decides the point today — not with the truth.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_LEVELS, wilsonLowerBound } from "../decisions/gate.js";
import { readLedgerRows, type LedgerRow } from "../decisions/ledger.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export interface LevelRow {
  level: number;
  cases: number;
  agreement: number;
  lowerBound: number;
}

export interface AnswerReport {
  answer: string;
  levels: LevelRow[];
  qualifiedLevel: number | null;
}

export interface PointReport {
  point: string;
  language: string;
  rows: number;
  decidedByLaya: number;
  bothAnswered: number;
  agreement: number | null;
  layaMedianMs: number | null;
  incumbentMedianMs: number | null;
  answers: AnswerReport[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** The report for these rows; `target` and `min` as the adaptive gate would use them. */
export function buildDecisionReport(rows: LedgerRow[], target: number, min: number): PointReport[] {
  const groups = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const key = `${row.point}|${row.language}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, group]) => {
    const [point, language] = key.split("|") as [string, string];
    const both = group.filter((row) => row.laya && row.incumbent);
    const agreeing = both.filter((row) => row.laya!.choice === row.incumbent!.choice).length;
    const answers = [...new Set(both.map((row) => row.laya!.choice))].sort().map((answer): AnswerReport => {
      const cases = both.filter((row) => row.laya!.choice === answer);
      const levels = GATE_LEVELS.map((level) => {
        const above = cases.filter((row) => row.laya!.top >= level);
        const agree = above.filter((row) => row.laya!.choice === row.incumbent!.choice).length;
        return { level, cases: above.length, agreement: above.length ? agree / above.length : 0, lowerBound: wilsonLowerBound(agree, above.length) };
      });
      const qualified = levels.find((row) => row.cases >= min && row.lowerBound >= target);
      return { answer, levels, qualifiedLevel: qualified?.level ?? null };
    });
    return {
      point,
      language,
      rows: group.length,
      decidedByLaya: group.filter((row) => row.decidedBy === "laya").length,
      bothAnswered: both.length,
      agreement: both.length ? agreeing / both.length : null,
      layaMedianMs: median(group.flatMap((row) => (row.laya ? [row.laya.ms] : []))),
      incumbentMedianMs: median(group.flatMap((row) => (row.incumbent ? [row.incumbent.ms] : []))),
      answers,
    };
  }).sort((a, b) => a.point.localeCompare(b.point) || a.language.localeCompare(b.language));
}

function pct(value: number | null): string {
  return value === null ? "–" : `${(value * 100).toFixed(1)}%`;
}

function render(report: PointReport[], target: number, min: number): string {
  const lines = [`Decision ledger — agreement with the incumbent; the gate needs ≥${min} cases with a lower bound ≥${pct(target)}.`, ""];
  for (const point of report) {
    lines.push(`## ${point.point} (${point.language}) — ${point.rows} cases, Laya decided ${point.decidedByLaya}, both answered ${point.bothAnswered}, agreement ${pct(point.agreement)}`);
    lines.push(`   median: Laya ${point.layaMedianMs ?? "–"} ms, incumbent ${point.incumbentMedianMs ?? "–"} ms`);
    for (const answer of point.answers) {
      const levels = answer.levels.filter((row) => row.cases > 0)
        .map((row) => `≥${row.level}: ${row.cases} cases ${pct(row.agreement)} (lb ${pct(row.lowerBound)})`).join(" | ");
      lines.push(`   Laya says "${answer.answer}" → ${answer.qualifiedLevel === null ? "not qualified" : `qualified from ${answer.qualifiedLevel}`}`);
      if (levels) lines.push(`      ${levels}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const ledger = arg("ledger") ?? join(repoRoot, ".starlingai", "decisions", "ledger.jsonl");
  const target = Number(arg("target") ?? 0.9);
  const min = Number(arg("min") ?? 30);
  if (!existsSync(ledger)) {
    console.log(`No decision ledger at ${ledger} yet — it is written once the laya sidecar runs (sai start --laya).`);
    return;
  }
  const report = buildDecisionReport(await readLedgerRows(ledger), target, min);
  console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : render(report, target, min));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
