/**
 * The decision ledger: one JSON line per case Laya was asked about — the case as Laya read it,
 * both answers, and who decided. The adaptive gate's statistics are rebuilt from it at start, the
 * report reads it, and it is the data Laya is fine-tuned on (scripts/decisions-export.ts).
 *
 * It lives next to the audit log, in `decisions/ledger.jsonl`, unless configured elsewhere. A
 * `sai stop --volumes` removes named state files and leaves it in place: it is what the model
 * learns from, not session state.
 */
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveAuditLogPath } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import type { LanguageBucket } from "./gate.js";

const log = childLogger("decisions:ledger");

export interface LedgerRow {
  ts: string;
  point: string;
  language: LanguageBucket;
  /** What Laya read about the case. */
  state: Record<string, unknown>;
  mode: string;
  /**
   * `model`: the version that answered (the checkpoint, and a point's own window: laya-client.ts layaModelVersion);
   * the gate's statistics are kept per version. `truncatedTokens`: how many tokens of the state Laya's window cut
   * off, as the sidecar counted them — a case it answered without reading all of.
   */
  laya?: { choice: string; top: number; probabilities: Record<string, number>; ms: number; model?: string; truncatedTokens?: number };
  incumbent?: { choice: string; ms: number };
  decidedBy: "laya" | "incumbent";
  sessionId?: string;
}

/** Only the tail of a long ledger is read at start: recent cases are what the gate keeps anyway. */
const MAX_BYTES_READ = 32 * 1024 * 1024;

export function resolveLedgerPath(): string {
  const configured = getConfig().decisions?.ledger?.path?.trim();
  if (configured) return resolve(configured);
  const fromEnv = process.env["SAI_DECISIONS_LEDGER"]?.trim();
  if (fromEnv) return resolve(fromEnv);
  return join(dirname(resolveAuditLogPath()), "decisions", "ledger.jsonl");
}

let writeChain: Promise<void> = Promise.resolve();

/** Append one row. Writes are serialised so rows never interleave; a failed write is logged, never thrown. */
export function appendLedgerRow(row: LedgerRow): Promise<void> {
  if (getConfig().decisions?.ledger?.enabled === false) return Promise.resolve();
  const path = resolveLedgerPath();
  writeChain = writeChain
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(row)}\n`, "utf8");
    })
    .catch((err: unknown) => {
      log.warn({ err, path }, "Could not write the decision ledger");
    });
  return writeChain;
}

/**
 * laya-browser's ledger, beside the decision ledger: one row per browser step laya-browser was asked about — the
 * page as it read it, the goal, the history, the model's action and its own. Kept apart because a step is not a
 * choice among fixed options; it is the data a laya-browser fine-tune on the swarm's own sites would learn from.
 */
export function resolveBrowserLedgerPath(): string {
  return join(dirname(resolveLedgerPath()), "browser-ledger.jsonl");
}

export function appendBrowserLedgerRow(row: Record<string, unknown>): Promise<void> {
  if (getConfig().decisions?.ledger?.enabled === false) return Promise.resolve();
  const path = resolveBrowserLedgerPath();
  writeChain = writeChain
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(row)}\n`, "utf8");
    })
    .catch((err: unknown) => {
      log.warn({ err, path }, "Could not write the browser ledger");
    });
  return writeChain;
}

/**
 * The incumbent readout's ledger (decisions/incumbent-readout.ts), beside the decision ledger: one row per decision
 * whose incumbent was also, or only, read by its logits — the case, the readout's probabilities and log-scores, the
 * parsed answer when the parsed call ran, and which of the two decided. Kept apart because its rows are a different
 * incumbent's: the decision ledger's agreement counts must not mix them (`incumbentVersion` names which one decided).
 * The log-scores are what a temperature is fitted on, and the probabilities are soft labels for a Laya fine-tune.
 */
export interface ReadoutLedgerRow {
  ts: string;
  point: string;
  language: LanguageBucket;
  state: Record<string, unknown>;
  mode: "shadow" | "on";
  /** The incumbent whose answer was used: "parsed" (today's call and parser) or the readout's version. */
  incumbentVersion: string;
  /**
   * The version of the readout that was asked, whoever decided: a shadow row's `incumbentVersion` is "parsed", and
   * without this its readout answers could not be told apart from a later readout's when a temperature is fitted.
   */
  readoutVersion: string;
  decidedBy: "readout" | "parsed";
  readout:
    | { choice: string; top: number; probabilities: Record<string, number>; logScores: Record<string, number>; mass: number; temperature: number; ms: number }
    | { miss: string; ms: number; topToken?: string };
  /** When the parsed call ran: its answer (null when it gave none) and time. */
  parsed?: { choice: string | null; ms: number };
  /** Both answered: did they agree? */
  agree?: boolean;
  sessionId?: string;
}

export function resolveReadoutLedgerPath(): string {
  return join(dirname(resolveLedgerPath()), "readout-ledger.jsonl");
}

export function appendReadoutLedgerRow(row: ReadoutLedgerRow): Promise<void> {
  if (getConfig().decisions?.ledger?.enabled === false) return Promise.resolve();
  const path = resolveReadoutLedgerPath();
  writeChain = writeChain
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(row)}\n`, "utf8");
    })
    .catch((err: unknown) => {
      log.warn({ err, path }, "Could not write the readout ledger");
    });
  return writeChain;
}

/** Every well-formed row in the ledger's tail, oldest first. A missing ledger is an empty one. */
export async function readLedgerRows(path = resolveLedgerPath()): Promise<LedgerRow[]> {
  let text: string;
  try {
    const size = (await stat(path)).size;
    const buffer = await readFile(path);
    text = buffer.subarray(Math.max(0, size - MAX_BYTES_READ)).toString("utf8");
  } catch {
    return [];
  }
  const rows: LedgerRow[] = [];
  const lines = text.split("\n");
  // A tail cut mid-line starts with a fragment: skip it rather than misread it.
  const first = text.length >= MAX_BYTES_READ ? 1 : 0;
  for (let i = first; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const row = JSON.parse(line) as LedgerRow;
      if (typeof row.point === "string" && typeof row.language === "string") rows.push(row);
    } catch {
      // A torn last line from a crash mid-write; the rest of the ledger is still good.
    }
  }
  return rows;
}

/** Test-only: wait for queued writes. */
export function flushLedgerForTests(): Promise<void> {
  return writeChain;
}
