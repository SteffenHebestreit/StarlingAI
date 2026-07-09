/**
 * Upload policy: scan THEN store. Every upload is virus-scanned before it lands in
 * the object store (or on disk) or gets ingested — an infected file is refused, and
 * a scanner that is DOWN also refuses (fail-closed) rather than storing bytes
 * unscanned. This is the single choke point both upload handlers call.
 */
import { scanBytes } from "./scanner.js";
import { putUpload } from "./object-store.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";

const log = childLogger("storage:uploads");

export type ScanStoreResult =
  | { ok: true; scanned: boolean }
  | { ok: false; status: 422 | 503; error: string };

/**
 * Scan `bytes`, and on a clean verdict store them at `key`. Returns an error
 * result (with an HTTP status) when the file is infected (422) or the scanner is
 * unavailable (503). `meta` is attached to the audit trail.
 */
export async function scanAndStoreUpload(
  key: string,
  bytes: Uint8Array,
  contentType: string,
  meta: Record<string, unknown> = {},
): Promise<ScanStoreResult> {
  let scanned = false;
  try {
    const verdict = await scanBytes(bytes);
    scanned = verdict.skipped !== true;
    if (verdict.oversize) {
      logAudit("upload_oversize_rejected", { key, size: bytes.length, ...meta }, { severity: "warn" });
      return { ok: false, status: 422, error: "Upload rejected — the file is too large to virus-scan. Reduce its size, or (accepting the risk) raise storage.scan.maxScanBytes / disable storage.scan.rejectOverMaxBytes." };
    }
    if (!verdict.clean) {
      logAudit("upload_infected", { key, signature: verdict.signature ?? "unknown", ...meta }, { severity: "warn" });
      return { ok: false, status: 422, error: `Upload rejected — malware detected (${verdict.signature ?? "unknown"}).` };
    }
  } catch (err) {
    // Fail CLOSED: a scanner error must not let an unscanned file through.
    log.error({ err: err instanceof Error ? err.message : String(err), key }, "Upload scan failed — rejecting (fail-closed)");
    logAudit("upload_scan_failed", { key, error: err instanceof Error ? err.message : String(err), ...meta }, { severity: "error" });
    return { ok: false, status: 503, error: "Upload scanning is temporarily unavailable — please try again." };
  }
  await putUpload(key, bytes, contentType);
  return { ok: true, scanned };
}
