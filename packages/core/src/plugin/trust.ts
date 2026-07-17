/**
 * SEC-105 (ADR-007): plugin trust — content digests and receipts.
 *
 * Trust is recorded against the sha256 digest of the plugin's CONTENT TREE
 * (sorted relative paths + per-file content hashes), so any byte change —
 * source, vendored dependency, added file, rename — produces a different
 * digest and silently returns the plugin to untrusted. The digest is computed
 * WITHOUT importing any plugin code: refusal happens before module-level code
 * could run.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";

const MAX_DIGEST_FILES = 5000;

/**
 * sha256 tree digest of a plugin source (single file or directory).
 * Deterministic: sorted relative paths, path + content bound into one hash.
 * Throws when the tree exceeds the file cap (refuse to trust what we cannot
 * fully fingerprint) — callers treat any throw as untrusted.
 */
export function computePluginDigest(sourcePath: string): string {
  const hash = createHash("sha256");
  const stats = statSync(sourcePath);
  if (stats.isFile()) {
    hash.update("file\0");
    hash.update(readFileSync(sourcePath));
    return hash.digest("hex");
  }

  const files: string[] = [];
  const walk = (dir: string, rel: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const abs = `${dir}/${entry.name}`;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, relPath);
      else if (entry.isFile()) {
        files.push(relPath);
        if (files.length > MAX_DIGEST_FILES) {
          throw new Error(`plugin tree exceeds ${MAX_DIGEST_FILES} files — refusing to fingerprint`);
        }
      }
    }
  };
  walk(sourcePath, "");

  for (const relPath of files.sort()) {
    hash.update(`${relPath}\0`);
    hash.update(readFileSync(`${sourcePath}/${relPath}`));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export interface PluginTrustReceipt {
  name: string;
  digest: string;
}

/** True when a receipt matches this plugin id AND its current digest exactly. */
export function isPluginTrusted(id: string, digest: string, receipts: readonly PluginTrustReceipt[]): boolean {
  return receipts.some((receipt) => receipt.name === id && receipt.digest === digest);
}
