/**
 * Dead-letter queue for channel delivery failures.
 *
 * Append-only NDJSON file at <workspacePath>/.starlingai/dead-letters.ndjson
 * Each line is one failed delivery entry.
 */
import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";

import { PRODUCT } from "../product/index.js";

const log = childLogger("channels:dead-letter");

export interface DeadLetterEntry {
  channel: string;
  messagePreview: string;
  error: string;
  attempts: number;
  ts?: string;
}

function getDeadLetterPath(): string {
  const config = getConfig();
  const workspacePath = config.workspacePath ?? "/workspace";
  return resolve(workspacePath, PRODUCT.stateDirName, "dead-letters.ndjson");
}

export function appendDeadLetter(entry: DeadLetterEntry): void {
  try {
    const filePath = getDeadLetterPath();
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

    const record: DeadLetterEntry = { ...entry, ts: new Date().toISOString() };
    appendFileSync(filePath, JSON.stringify(record) + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    log.error({ err }, "Failed to write dead-letter entry");
  }
}

export function readDeadLetters(opts?: { limit?: number; channel?: string }): DeadLetterEntry[] {
  try {
    const filePath = getDeadLetterPath();
    if (!existsSync(filePath)) return [];

    const lines = readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
    const parsed = lines
      .map((line) => {
        try {
          return JSON.parse(line) as DeadLetterEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is DeadLetterEntry => entry !== null);
    const filtered = opts?.channel ? parsed.filter((entry) => entry.channel === opts.channel) : parsed;
    const limit = opts?.limit ?? filtered.length;
    return filtered.slice(-limit).reverse();
  } catch (err) {
    log.error({ err }, "Failed to read dead-letter entries");
    return [];
  }
}

export function getDeadLetterCount(channel?: string): number {
  return readDeadLetters(channel ? { channel } : undefined).length;
}
