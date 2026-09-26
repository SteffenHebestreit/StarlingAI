/**
 * How the Laya decision layer is doing, from the decision ledger: per decision point and language, how often Laya was
 * asked, how often it decided, how well it agrees with the incumbent at each confidence level, and from which level
 * the adaptive gate would let it decide. laya-browser's steps (browser-ledger.jsonl beside it) are reported as the
 * point `browser_step`, with the browser agent's model as the incumbent.
 *
 *   pnpm --filter @starlingai/core decisions:report [--ledger <path>] [--target 0.9] [--min 30] [--json]
 *
 * Agreement is with the incumbent — the LLM call or rule that decides the point today — not with the truth.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_LEVELS, wilsonLowerBound } from "../decisions/gate.js";
import { DECISION_POINTS, type DecisionPointId } from "../decisions/points.js";
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
  /**
   * For an answer other than the point's protected one (decisions/points.ts `protect`): the lower bound
   * of the protected answer's recall at this level, which the gate also requires (decisions/gate.ts).
   */
  protectedRecallLowerBound?: number;
}

export interface AnswerReport {
  answer: string;
  levels: LevelRow[];
  qualifiedLevel: number | null;
}

export interface PointReport {
  point: string;
  language: string;
  /** The checkpoint version that answered: statistics are the gate's, per version. */
  model: string;
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

/**
 * Browser ledger rows as the report reads decision rows: laya-browser's operation, at the confidence the gate used,
 * against the model's step — "agree" as the gate counted it (the same operation, and on an element the same element).
 * A step laya-browser took itself has no model step to agree with. The model's time per step is not measured.
 */
export function browserRowsForReport(rows: ReadonlyArray<Record<string, unknown>>): LedgerRow[] {
  return rows.flatMap((row): LedgerRow[] => {
    if (row["point"] !== "browser_step") return [];
    const laya = row["laya"] as { operation?: string; operationProbability?: number; target?: { probability?: number } | null; ms?: number; model?: string } | null;
    const gate = row["gate"] as { answer?: unknown; top?: unknown; agree?: unknown; model?: unknown } | undefined;
    const model = typeof gate?.model === "string" ? gate.model : laya?.model;
    const base = {
      ts: String(row["ts"] ?? ""),
      point: "browser_step",
      language: (row["language"] as LedgerRow["language"] | undefined) ?? "other",
      state: {},
      mode: String(row["mode"] ?? ""),
      decidedBy: row["decidedBy"] === "laya" ? "laya" as const : "incumbent" as const,
    };
    if (gate && typeof gate.answer === "string" && typeof gate.top === "number" && typeof gate.agree === "boolean") {
      return [{
        ...base,
        laya: { choice: gate.answer, top: gate.top, probabilities: {}, ms: laya?.ms ?? 0, ...(model ? { model } : {}) },
        incumbent: { choice: gate.agree ? gate.answer : `not ${gate.answer}`, ms: -1 },
      }];
    }
    if (!laya?.operation) return [base];
    const top = Math.min(laya.operationProbability ?? 0, laya.target?.probability ?? 1);
    return [{ ...base, laya: { choice: laya.operation, top, probabilities: {}, ms: laya.ms ?? 0, ...(model ? { model } : {}) } }];
  });
}

/** The report for these rows; `target` and `min` as the adaptive gate would use them. */
export function buildDecisionReport(rows: LedgerRow[], target: number, min: number): PointReport[] {
  const groups = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const key = `${row.point}|${row.language}|${row.laya?.model ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, group]) => {
    const [point, language, ...rest] = key.split("|") as [string, string, ...string[]];
    const model = rest.join("|");
    const both = group.filter((row) => row.laya && row.incumbent);
    const agreeing = both.filter((row) => row.laya!.choice === row.incumbent!.choice).length;
    // The gate's recall guard: the cases the incumbent answered the point's protected answer.
    const protect = DECISION_POINTS[point as DecisionPointId]?.protect;
    const protectedRows = protect ? both.filter((row) => row.incumbent!.choice === protect) : [];
    const answers = [...new Set(both.map((row) => row.laya!.choice))].sort().map((answer): AnswerReport => {
      const cases = both.filter((row) => row.laya!.choice === answer);
      const guarded = protect !== undefined && answer !== protect;
      const levels = GATE_LEVELS.map((level): LevelRow => {
        const above = cases.filter((row) => row.laya!.top >= level);
        const agree = above.filter((row) => row.laya!.choice === row.incumbent!.choice).length;
        const missed = protectedRows.filter((row) => row.laya!.choice === answer && row.laya!.top >= level).length;
        return {
          level,
          cases: above.length,
          agreement: above.length ? agree / above.length : 0,
          lowerBound: wilsonLowerBound(agree, above.length),
          ...(guarded ? { protectedRecallLowerBound: wilsonLowerBound(protectedRows.length - missed, protectedRows.length) } : {}),
        };
      });
      const qualified = levels.find((row) => row.cases >= min && row.lowerBound >= target
        && (!guarded || (protectedRows.length >= min && (row.protectedRecallLowerBound ?? 0) >= target)));
      return { answer, levels, qualifiedLevel: qualified?.level ?? null };
    });
    return {
      point,
      language,
      model,
      rows: group.length,
      decidedByLaya: group.filter((row) => row.decidedBy === "laya").length,
      bothAnswered: both.length,
      agreement: both.length ? agreeing / both.length : null,
      layaMedianMs: median(group.flatMap((row) => (row.laya ? [row.laya.ms] : []))),
      // A negative time is one that was not measured (the browser agent's model step).
      incumbentMedianMs: median(group.flatMap((row) => (row.incumbent && row.incumbent.ms >= 0 ? [row.incumbent.ms] : []))),
      answers,
    };
  }).sort((a, b) => a.point.localeCompare(b.point) || a.language.localeCompare(b.language) || a.model.localeCompare(b.model));
}

function pct(value: number | null): string {
  return value === null ? "–" : `${(value * 100).toFixed(1)}%`;
}

function render(report: PointReport[], target: number, min: number): string {
  const lines = [`Decision ledger — agreement with the incumbent; the gate needs ≥${min} cases with a lower bound ≥${pct(target)}.`, ""];
  for (const point of report) {
    lines.push(`## ${point.point} (${point.language}${point.model ? `, ${point.model}` : ""}) — ${point.rows} cases, Laya decided ${point.decidedByLaya}, both answered ${point.bothAnswered}, agreement ${pct(point.agreement)}`);
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
  const browserLedger = join(dirname(ledger), "browser-ledger.jsonl");
  const target = Number(arg("target") ?? 0.9);
  const min = Number(arg("min") ?? 30);
  if (!existsSync(ledger) && !existsSync(browserLedger)) {
    console.log(`No decision ledger at ${ledger} yet — it is written once the laya sidecar runs (sai start --laya).`);
    return;
  }
  const rows = [
    ...await readLedgerRows(ledger),
    ...browserRowsForReport(await readLedgerRows(browserLedger) as unknown as Array<Record<string, unknown>>),
  ];
  const report = buildDecisionReport(rows, target, min);
  console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : render(report, target, min));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
