/**
 * Bounded NDJSON store — shared tail-read + rolling-trim helpers used by
 * `agent_outcomes.ndjson` and `trajectory_cache.ndjson`.
 *
 * The hot path (routing, cache lookup) does not need the full history, only
 * the last N entries.  Reading the whole file on every call is O(n) on disk
 * and wastes several MB per turn once the rolling cap kicks in.  This module
 * reads from the end of the file in chunks so cost stays proportional to the
 * requested slice.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { writeTextStateFileSync } from "../runtime/state-file.js";

// Average bytes per line estimate — used to size the initial tail chunk.
const AVG_BYTES_PER_LINE = 512;
const MIN_CHUNK_BYTES = 4_096;
const MAX_CHUNK_BYTES = 4 * 1_024 * 1_024;

export interface AppendOptions {
  /**
   * Rolling cap.  Checked every `trimCheckInterval` writes (default 200) to
   * avoid paying O(n) on every append.
   */
  maxLines: number;
  trimCheckInterval?: number;
}

/**
 * Append a single record as a JSON line.  Creates the parent directory if
 * missing and best-effort trims to `maxLines` at the configured interval.
 */
export function appendJsonLine(
  filePath: string,
  record: unknown,
  opts: AppendOptions,
): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
    _maybeTrim(filePath, opts);
  } catch {
    // Best-effort — callers treat NDJSON writes as non-critical.
  }
}

const _writeCounters = new Map<string, number>();

function _maybeTrim(filePath: string, opts: AppendOptions): void {
  const interval = opts.trimCheckInterval ?? 200;
  const count = (_writeCounters.get(filePath) ?? 0) + 1;
  _writeCounters.set(filePath, count);
  if (count % interval !== 0) return;
  trimToLastLines(filePath, opts.maxLines);
}

/**
 * Re-write the file keeping only the last `maxLines` entries.
 * Best-effort; silently swallows I/O errors.
 */
export function trimToLastLines(filePath: string, maxLines: number): void {
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length > maxLines) {
      writeFileSync(filePath, lines.slice(lines.length - maxLines).join("\n") + "\n", "utf-8");
    }
  } catch { /* best-effort */ }
}

/**
 * Read the last `maxLines` complete lines from an NDJSON file.
 *
 * Reads from EOF in expanding chunks until enough line terminators are seen
 * or the start of the file is reached.  The first (incomplete) line of the
 * earliest chunk is discarded unless we read the whole file, which guarantees
 * we never return a truncated UTF-8 sequence.
 *
 * Returns an empty array if the file does not exist or cannot be read.
 */
export function readLastLines(filePath: string, maxLines: number): string[] {
  if (maxLines <= 0) return [];
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const stat = fstatSync(fd);
    const fileSize = stat.size;
    if (fileSize === 0) return [];

    let chunkSize = Math.min(
      fileSize,
      Math.max(MIN_CHUNK_BYTES, Math.min(MAX_CHUNK_BYTES, maxLines * AVG_BYTES_PER_LINE)),
    );
    let position = fileSize;
    let buffer = Buffer.alloc(0);
    let reachedStart = false;

    while (!reachedStart) {
      const readSize = Math.min(position, chunkSize);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      readSync(fd, chunk, 0, readSize, position);
      buffer = Buffer.concat([chunk, buffer]);
      reachedStart = position === 0;

      // Count complete lines.  If we reached the start we keep everything,
      // otherwise we discard the first (possibly partial) line before
      // counting.
      const text = buffer.toString("utf-8");
      const allParts = text.split("\n");
      const completeLines = reachedStart ? allParts : allParts.slice(1);
      const nonEmpty = completeLines.filter(Boolean);
      if (nonEmpty.length >= maxLines) break;

      chunkSize = Math.min(MAX_CHUNK_BYTES, chunkSize * 2);
    }

    const text = buffer.toString("utf-8");
    const allParts = text.split("\n");
    const completeLines = reachedStart ? allParts : allParts.slice(1);
    const nonEmpty = completeLines.filter(Boolean);
    return nonEmpty.slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Rewrites the records of an NDJSON file in one synchronous read-modify-write. `rewrite` returns the
 * record to write instead, `null` to drop it, or `undefined` to keep the line exactly as it was; a
 * line that does not parse is kept as it is. The file is written through a temp file and a rename,
 * and only when something changed. Returns how many records were changed or dropped (0 when there
 * is no file). Throws when the file cannot be read or written: its caller, the account migration,
 * reports the step and changes nothing else for that account.
 */
export function rewriteJsonLines(filePath: string, rewrite: (record: unknown) => unknown): number {
  if (!existsSync(filePath)) return 0;
  const lines = readFileSync(filePath, "utf-8").split("\n");
  let changed = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      kept.push(line);
      continue;
    }
    const next = rewrite(record);
    if (next === undefined) {
      kept.push(line);
      continue;
    }
    changed += 1;
    if (next !== null) kept.push(JSON.stringify(next));
  }
  if (changed > 0) writeTextStateFileSync(filePath, kept.length > 0 ? `${kept.join("\n")}\n` : "");
  return changed;
}

/** Every record of an NDJSON file that parses; none when there is no file. Throws when the file
 *  exists but cannot be read. */
export function readAllRecords<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  const out: T[] = [];
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* skip malformed */ }
  }
  return out;
}

/**
 * Read-and-parse convenience wrapper.  Malformed lines are silently skipped.
 */
export function readLastRecords<T>(filePath: string, maxLines: number): T[] {
  const lines = readLastLines(filePath, maxLines);
  const out: T[] = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line) as T); } catch { /* skip malformed */ }
  }
  return out;
}
