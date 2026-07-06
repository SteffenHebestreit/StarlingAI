/**
 * Document registry — a small JSON manifest of files ingested into the engram
 * document-RAG store.
 *
 * engram stores chunks + embeddings keyed by a content-hash document id, but NOT
 * the original file's location or MIME type. The management UI needs both (to
 * download/view the original and to delete the persisted file when a document is
 * removed), so we keep a side manifest at `<workspace>/uploads/.registry.json`.
 * It lives alongside the uploaded files, so the same `sai stop --volumes` /
 * uploads cleanup that removes the files (and `down -v` that drops the engram
 * graph) clears it too — one consistent lifecycle.
 *
 * One entry per (documentId, source) — i.e. per scope a document is registered
 * under, mirroring engram's reference-counted sources.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import type { DocumentScope } from "./document-rag.js";

const log = childLogger("retrieval:document-registry");

export interface DocumentRegistryEntry {
  documentId: string;
  scope: DocumentScope;
  /** engram source token (e.g. session:<id>, user:<id>, workspace:<name>). */
  source: string;
  filename: string;
  /** Workspace-relative path of the persisted original file, when known. */
  relativePath?: string;
  contentType?: string;
  size?: number;
  chunkCount?: number;
  ingestedAt: string;
  /** Set when the document was marked outdated via engram invalidation (doc-level —
   *  stamped on every entry of the document). Cleared by re-ingest (which reinstates
   *  the document in engram). engram's GET /documents does not expose the marker, so
   *  this is what the management UI badges from. */
  invalidatedAt?: string;
}

function registryPath(): string {
  return join(getConfig().workspacePath, "uploads", ".registry.json");
}

async function readRegistry(): Promise<DocumentRegistryEntry[]> {
  try {
    const raw = await readFile(registryPath(), "utf8");
    const parsed = JSON.parse(raw) as { entries?: DocumentRegistryEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return []; // missing/corrupt → treat as empty
  }
}

async function writeRegistry(entries: DocumentRegistryEntry[]): Promise<void> {
  const path = registryPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
}

// Serialize read-modify-write so concurrent ingest/forget calls don't clobber
// each other's writes (low-traffic dashboard — a simple promise chain suffices).
let _chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = _chain.then(fn, fn) as Promise<T>;
  _chain = run.then(() => undefined, () => undefined);
  return run;
}

/** Upsert an entry by (documentId, source). */
export async function registerDocument(entry: DocumentRegistryEntry): Promise<void> {
  try {
    await withLock(async () => {
      const entries = await readRegistry();
      const idx = entries.findIndex((e) => e.documentId === entry.documentId && e.source === entry.source);
      if (idx >= 0) {
        const merged = { ...entries[idx], ...entry };
        // Re-ingest reinstates an invalidated document in engram, so a fresh
        // registration clears the stale marker unless the caller re-asserts it.
        if (!entry.invalidatedAt) delete merged.invalidatedAt;
        entries[idx] = merged;
      } else {
        entries.push(entry);
      }
      // A re-ingest reinstates the whole document — clear the doc-level marker
      // from its OTHER scope entries too (the marker is stamped doc-wide).
      if (!entry.invalidatedAt) {
        for (const e of entries) {
          if (e.documentId === entry.documentId && e.invalidatedAt) delete e.invalidatedAt;
        }
      }
      await writeRegistry(entries);
    });
  } catch (err) {
    log.warn({ err, documentId: entry.documentId }, "failed to register document");
  }
}

/** Stamp every entry of a document as invalidated (doc-level marker). */
export async function markDocumentInvalidated(documentId: string, at = new Date().toISOString()): Promise<void> {
  try {
    await withLock(async () => {
      const entries = await readRegistry();
      let changed = false;
      for (const e of entries) {
        if (e.documentId === documentId && e.invalidatedAt !== at) {
          e.invalidatedAt = at;
          changed = true;
        }
      }
      if (changed) await writeRegistry(entries);
    });
  } catch (err) {
    log.warn({ err, documentId }, "failed to mark document invalidated");
  }
}

/**
 * Remove entries for a document. With `source`, only that scope's entry is
 * dropped (the document may still exist under other scopes); without it, all
 * entries for the document are removed. Returns the removed entries so the
 * caller can delete their persisted files.
 */
export async function unregisterDocument(documentId: string, source?: string): Promise<DocumentRegistryEntry[]> {
  try {
    return await withLock(async () => {
      const entries = await readRegistry();
      const matches = (e: DocumentRegistryEntry) => e.documentId === documentId && (!source || e.source === source);
      const removed = entries.filter(matches);
      const kept = entries.filter((e) => !matches(e));
      if (removed.length > 0) await writeRegistry(kept);
      return removed;
    });
  } catch (err) {
    log.warn({ err, documentId }, "failed to unregister document");
    return [];
  }
}

/** All registry entries. */
export async function listRegistry(): Promise<DocumentRegistryEntry[]> {
  return readRegistry();
}

/** First registry entry for a document that has a persisted file (for download). */
export async function getRegistryFileEntry(documentId: string): Promise<DocumentRegistryEntry | undefined> {
  return (await readRegistry()).find((e) => e.documentId === documentId && e.relativePath);
}
