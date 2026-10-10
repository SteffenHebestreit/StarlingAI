/**
 * Writing the deployment's identity state files (the account registry, the account tombstones).
 *
 * Each is written through a temp file and a rename, so a reader never sees half a file and a write
 * that fails leaves the previous one in place. Synchronous from start to end: a caller's read, its
 * change and this write stay in one tick, so two requests can never interleave inside one change.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 5;

/** A short synchronous pause: the write stays in the caller's tick. */
function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Writes `value` as indented JSON to `path` through a temp file and a rename. On Windows a reader
 *  holding the target open fails the rename for a moment; that is retried a few times. Throws when
 *  the write fails, with the previous file untouched. */
export function writeJsonStateFileSync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_ATTEMPTS || !code || !RENAME_RETRY_CODES.has(code)) {
        try { rmSync(tmp, { force: true }); } catch { /* the rename failure is what matters */ }
        throw err;
      }
      pauseSync(20 * attempt);
    }
  }
}
