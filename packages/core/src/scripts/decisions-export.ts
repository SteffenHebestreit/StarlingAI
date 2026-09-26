/**
 * The decision ledger as Laya fine-tuning data: every case the incumbent answered, labelled with the incumbent's
 * answer, in the typed-decisions format laya's fine-tuning notebook reads —
 *
 *   {"point", "language", "state": "<json>", "questions": {point: {type, instructions, criteria}},
 *    "gold": {point: {"label": "A", "probabilities": {"A": 1, "B": 0}}}}
 *
 * The question is written exactly as the sidecar serves it (docker/laya/app/generic.py): the point's question as the
 * instructions and its options under neutral letters, in the order the point defines them — the model is trained on
 * what it will be asked. The same case seen more than once is kept once, with its latest answer.
 *
 * Beside it, browser-export.jsonl: every browser step the agent's model took on a page laya-browser read (from
 * browser-ledger.jsonl) — the page, the goal, the history and the model's step, which laya-browser is fine-tuned to
 * take. Both land in .starlingai/laya/data, which the laya sidecar sees as /models/local/data:
 *
 *   pnpm --filter @starlingai/core decisions:export [--ledger <path>] [--out <path>] [--points a,b]
 *   docker compose --profile laya run --rm laya python -m app.train decision     (or: browser)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DECISION_POINTS, type DecisionPointDefinition, type DecisionPointId } from "../decisions/points.js";
import { readLedgerRows, type LedgerRow } from "../decisions/ledger.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Where the gateway's decision ledger lies from the repository root, unless configured elsewhere: the default --ledger. */
export function defaultLedgerPath(): string {
  return join(repoRoot, ".starlingai", "decisions", "ledger.jsonl");
}

export interface TrainingItem {
  point: string;
  language: string;
  state: string;
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>;
  gold: Record<string, { label: string; probabilities: Record<string, number> }>;
}

/** The question as the sidecar serves it: options under letters, in the point's order. */
export function servedQuestion(point: DecisionPointDefinition): { keys: string[]; criteria: Record<string, string> } {
  const keys = Object.keys(point.options);
  return { keys, criteria: Object.fromEntries(keys.map((key, i) => [LETTERS[i]!, point.options[key]!])) };
}

export function buildTrainingItems(rows: LedgerRow[], points?: ReadonlySet<string>): TrainingItem[] {
  const latest = new Map<string, TrainingItem>();
  for (const row of rows) {
    if (!row.incumbent) continue;
    if (points && !points.has(row.point)) continue;
    const point = DECISION_POINTS[row.point as DecisionPointId];
    if (!point) continue;
    const { keys, criteria } = servedQuestion(point);
    const index = keys.indexOf(row.incumbent.choice);
    if (index < 0) continue; // an answer the point no longer has
    const label = LETTERS[index]!;
    const state = JSON.stringify(row.state);
    latest.set(`${row.point}\u0000${state}`, {
      point: row.point,
      language: row.language,
      state,
      questions: { [row.point]: { type: "choice", instructions: point.question, criteria } },
      gold: { [row.point]: { label, probabilities: Object.fromEntries(Object.keys(criteria).map((letter) => [letter, letter === label ? 1 : 0])) } },
    });
  }
  return [...latest.values()];
}

/**
 * Browser-ledger rows laya-browser can learn from: steps the agent's model took (and final answers), with the page,
 * goal and history as laya-browser read them. Its own steps are left out: they teach it nothing it did not know.
 */
export function buildBrowserTrainingRows(rows: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.flatMap((row) => {
    const model = row["model"] as { operation?: unknown } | null | undefined;
    if (row["point"] !== "browser_step" || row["decidedBy"] !== "model" || typeof model?.operation !== "string") return [];
    if (!row["observation"] || typeof row["goal"] !== "string") return [];
    const { ts, sessionId, goal, observation, history, excluded, decidedBy } = row;
    return [{ ts, sessionId, goal, observation, history: history ?? [], excluded: excluded ?? [], model, decidedBy }];
  });
}

async function writeJsonl(path: string, rows: ReadonlyArray<unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
}

async function main(): Promise<void> {
  const ledger = arg("ledger") ?? defaultLedgerPath();
  const out = arg("out") ?? join(repoRoot, ".starlingai", "laya", "data", "ledger-export.jsonl");
  const browserLedger = join(dirname(ledger), "browser-ledger.jsonl");
  const browserOut = join(dirname(out), "browser-export.jsonl");
  // Beside the ledger: the incumbents' labels for synthetic messages (decisions:bootstrap), training data only.
  const bootstrap = join(dirname(ledger), "bootstrap-ledger.jsonl");
  const pointList = arg("points");
  // The bootstrap's labels alone are enough: they exist for the day before real turns have filled the ledger.
  if (!existsSync(ledger) && !existsSync(bootstrap) && !existsSync(browserLedger)) {
    console.log(`No decision ledger at ${ledger} yet, and no bootstrap-ledger.jsonl or browser-ledger.jsonl beside it.`);
    return;
  }
  const rows = [...await readLedgerRows(bootstrap), ...await readLedgerRows(ledger)];
  const items = buildTrainingItems(rows, pointList ? new Set(pointList.split(",")) : undefined);
  await writeJsonl(out, items);
  const counts: Record<string, number> = {};
  for (const item of items) counts[`${item.point}/${item.language}`] = (counts[`${item.point}/${item.language}`] ?? 0) + 1;
  console.log(`Wrote ${items.length} training items to ${out}`);
  for (const [key, count] of Object.entries(counts).sort()) console.log(`  ${key}: ${count}`);
  const steps = buildBrowserTrainingRows(await readLedgerRows(browserLedger) as unknown as Array<Record<string, unknown>>);
  await writeJsonl(browserOut, steps);
  console.log(`Wrote ${steps.length} browser steps to ${browserOut}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
