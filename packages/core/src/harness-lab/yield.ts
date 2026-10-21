/**
 * The lab gives way to the people using the swarm (harness lab P4): it shares the model server with
 * them, and one lab turn takes the GPU for a minute or more. Before every new attempt it reads the end
 * of the live audit log; while someone has sent a message within the quiet window, it waits. A run
 * also has a time budget: once it is spent, the run stops before its next new attempt, and a later run
 * on the same --out goes on from there (replay.ts).
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

/** How much of the live audit log's end is read: hours of a busy log, a few milliseconds to read. */
const TAIL_BYTES = 512 * 1024;

/** The newest time a message_received was logged in the last part of `auditFile`, or null. */
export function lastLiveMessageAt(auditFile: string): number | null {
  if (!existsSync(auditFile)) return null;
  const size = statSync(auditFile).size;
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(auditFile, "r");
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  let newest: number | null = null;
  for (const line of buffer.toString("utf8").split("\n")) {
    if (!line.includes('"message_received"')) continue;
    try {
      const row = JSON.parse(line) as { type?: string; timestamp?: string };
      if (row.type !== "message_received" || !row.timestamp) continue;
      const at = Date.parse(row.timestamp);
      if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
    } catch {
      // The first line of the tail is usually cut; a torn line is no message.
    }
  }
  return newest;
}

export class LabBudgetSpent extends Error {
  constructor(readonly spentMs: number) {
    super(`the run's time budget is spent (${Math.round(spentMs / 60_000)} min)`);
  }
}

export interface PacerOptions {
  /** The live audit log to watch; unset = no yielding. */
  auditFile?: string;
  quietWindowMs: number;
  /** Total wall time for the run; unset = no budget. */
  budgetMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface PacerStats {
  waits: number;
  waitedMs: number;
}

/** Call `beforeAttempt()` before each new attempt: it waits out live use, and throws once the budget is spent. */
export function createPacer(opts: PacerOptions): { beforeAttempt(): Promise<void>; stats: PacerStats } {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = opts.pollMs ?? 60_000;
  const startedAt = now();
  const stats: PacerStats = { waits: 0, waitedMs: 0 };
  const checkBudget = () => {
    if (opts.budgetMs !== undefined && now() - startedAt >= opts.budgetMs) throw new LabBudgetSpent(now() - startedAt);
  };
  return {
    stats,
    async beforeAttempt() {
      checkBudget();
      if (!opts.auditFile) return;
      let announced = false;
      for (;;) {
        const last = lastLiveMessageAt(opts.auditFile);
        if (last === null || now() - last >= opts.quietWindowMs) return;
        if (!announced) {
          opts.log?.(`live use ${Math.round((now() - last) / 1000)} s ago: waiting for ${Math.round(opts.quietWindowMs / 60_000)} quiet minutes`);
          stats.waits += 1;
          announced = true;
        }
        const before = now();
        await sleep(pollMs);
        stats.waitedMs += now() - before;
        checkBudget();
      }
    },
  };
}

/** "90m", "4h", "45s", or a plain number of minutes. */
export function parseDuration(raw: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/.exec(raw.trim());
  if (!match) return null;
  const unit = match[2] ?? "m";
  return Math.round(Number(match[1]) * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000));
}
