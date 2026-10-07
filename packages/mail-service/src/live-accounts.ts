/**
 * The account set the routes serve: the main accounts file (read once at start) plus the
 * overlay directory (re-read while the service runs).
 *
 * The overlay lets an account be added and removed without touching the operator's accounts
 * file and without a restart — the e2e test environment (`pnpm e2e:env up|down`) drops its
 * synthetic GreenMail account there and takes it away again. The directory is polled lazily:
 * at most once per `minIntervalMs`, on the next request, by comparing file names, sizes and
 * mtimes (polling, not fs.watch: change events do not cross the Docker Desktop bind mount).
 *
 * Merge rules — an overlay can add, never replace or loosen:
 *  - an overlay account whose id is already taken (main file, or an earlier overlay file in
 *    name order) is skipped;
 *  - a file that does not parse or validate is skipped as a whole and logged;
 *  - `isolatedUsers` of every document are united and withhold each SHARED account
 *    (no allowedUsers) from those users.
 */
import { readAccountsOverlay, type AccountsDocument } from "./config.js";
import { log } from "./logger.js";
import type { MailAccountConfig } from "./types.js";

export class LiveAccounts {
  /** The live list. Mutated in place, so every route holding this array sees each refresh. */
  readonly list: MailAccountConfig[] = [];
  private signature: string | null = null;
  private lastScanAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly base: AccountsDocument,
    private readonly overlayDir: string,
    private readonly minIntervalMs = 2_000,
  ) {
    this.apply([]);
  }

  /** Re-read the overlay directory if it may have changed. Never throws. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.signature !== null && Date.now() - this.lastScanAt < this.minIntervalMs) return Promise.resolve();
    this.lastScanAt = Date.now();
    this.inFlight = this.scan().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async scan(): Promise<void> {
    try {
      const overlay = await readAccountsOverlay(this.overlayDir);
      if (overlay.signature === this.signature) return;
      const firstScan = this.signature === null;
      this.signature = overlay.signature;
      for (const { file, error } of overlay.files) {
        if (error) log.error({ overlayDir: this.overlayDir, file, error }, "Skipping invalid mail accounts overlay file");
      }
      const documents = overlay.files.flatMap(({ document }) => (document ? [document] : []));
      const added = this.apply(documents);
      if (!firstScan || added.length > 0) {
        log.info({ overlayDir: this.overlayDir, overlayAccounts: added, accounts: this.list.length }, "Mail accounts overlay loaded");
      }
    } catch (err) {
      log.error({ err, overlayDir: this.overlayDir }, "Could not read the mail accounts overlay — keeping the current accounts");
    }
  }

  /** Rebuild the live list from the main file + `documents`; returns the overlay account ids taken. */
  private apply(documents: AccountsDocument[]): string[] {
    const accounts: MailAccountConfig[] = [...this.base.accounts];
    const taken = new Set(accounts.map((account) => account.id));
    const added: string[] = [];
    const isolated = new Set(this.base.isolatedUsers.map((user) => user.toLowerCase()));
    for (const document of documents) {
      for (const user of document.isolatedUsers) isolated.add(user.toLowerCase());
      for (const account of document.accounts) {
        if (taken.has(account.id)) {
          log.warn({ overlayDir: this.overlayDir, accountId: account.id }, "Overlay account id already in use — skipped (an overlay never replaces an account)");
          continue;
        }
        taken.add(account.id);
        added.push(account.id);
        accounts.push(account);
      }
    }
    const withheldFrom = [...isolated];
    const next = accounts.map((account) => (account.allowedUsers?.length || withheldFrom.length === 0)
      ? { ...account, withheldFrom: undefined }
      : { ...account, withheldFrom });
    this.list.splice(0, this.list.length, ...next);
    return added;
  }
}
