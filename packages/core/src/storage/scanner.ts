/**
 * Anti-malware scanning of uploads via ClamAV's `clamd` INSTREAM protocol over TCP.
 *
 * Wire format: send `zINSTREAM\0`, then for each chunk a 4-byte big-endian length
 * followed by the bytes, then a zero-length chunk to terminate; clamd replies
 * `stream: OK` (clean) or `stream: <signature> FOUND` (infected).
 *
 * scanBytes THROWS on a scanner error (unreachable clamd, timeout, malformed
 * reply) so the caller can fail CLOSED (reject the upload) — a scanner that's down
 * must not silently wave malware through.
 */
import { connect } from "node:net";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";

const log = childLogger("storage:scanner");

export interface ScanResult {
  clean: boolean;
  /** The matched signature name when infected. */
  signature?: string;
  /** True when scanning was skipped (disabled, or over maxScanBytes). */
  skipped?: boolean;
}

/**
 * Scan bytes for malware. Returns `{clean:true, skipped:true}` when scanning is
 * disabled or the file exceeds `maxScanBytes`. Throws when the scanner is
 * unreachable / errors (the caller decides how to handle that).
 */
export async function scanBytes(bytes: Uint8Array): Promise<ScanResult> {
  const cfg = getConfig().storage.scan;
  if (!cfg.enabled) return { clean: true, skipped: true };
  if (cfg.maxScanBytes > 0 && bytes.length > cfg.maxScanBytes) {
    log.warn({ size: bytes.length, max: cfg.maxScanBytes }, "Upload exceeds maxScanBytes — skipping virus scan");
    return { clean: true, skipped: true };
  }
  return clamdInstream(bytes, cfg.clamdHost, cfg.clamdPort, cfg.timeoutMs);
}

function clamdInstream(bytes: Uint8Array, host: string, port: number, timeoutMs: number): Promise<ScanResult> {
  return new Promise<ScanResult>((resolve, reject) => {
    const socket = connect({ host, port });
    let response = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`clamd scan timed out after ${timeoutMs}ms`))), timeoutMs);

    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      const CHUNK = 64 * 1024;
      for (let off = 0; off < bytes.length; off += CHUNK) {
        const slice = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
        const len = Buffer.alloc(4);
        len.writeUInt32BE(slice.length, 0);
        socket.write(len);
        socket.write(slice);
      }
      const terminator = Buffer.alloc(4); // zero-length chunk ends the stream
      socket.write(terminator);
    });
    socket.on("data", (d: Buffer) => { response += d.toString("utf8"); });
    socket.on("end", () => finish(() => {
      try { resolve(parseClamdResponse(response)); } catch (err) { reject(err); }
    }));
    socket.on("error", (err: Error) => finish(() => reject(err)));
  });
}

/** Parse a clamd INSTREAM reply. Throws on an ERROR / unexpected reply. */
export function parseClamdResponse(response: string): ScanResult {
  const line = response.replace(/\0/g, "").trim();
  const found = line.match(/stream:\s*(.+?)\s+FOUND$/);
  if (found) return { clean: false, signature: found[1] };
  if (/\bOK$/.test(line)) return { clean: true };
  throw new Error(`clamd returned an unexpected response: ${line || "(empty)"}`);
}
