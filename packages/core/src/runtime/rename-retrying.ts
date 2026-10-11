/**
 * A rename that waits out a Windows sharing error.
 *
 * A leaf module: the account migration and the boot's move of each account's workspace state
 * (runtime/workspace-state-relocation.ts) both rename whole directories that another reader can
 * hold open for a moment (an indexer, a virus scanner, an editor), which on Windows fails the rename
 * with EPERM, EBUSY or EACCES until it lets go.
 */
import { renameSync } from "node:fs";

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** A rename that waits out a Windows sharing error for a moment (a reader holding the directory). */
export async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 6 || !code || !RENAME_RETRY_CODES.has(code)) throw err;
      await new Promise((done) => setTimeout(done, 25 * attempt));
    }
  }
}
