/**
 * Document source aliases: the user corpora from before account ids that an account reads besides
 * its own.
 *
 * Under multi-user auth an account's own user-scope documents are stored under `user:<account id>`.
 * Before account ids they were stored under `user:<username>`, and engram cannot rename a source:
 * moving them would mean ingesting every document again. When the account migration lets an
 * account adopt the data its username held, it writes the old source here instead, as an alias
 * that this account, and only this account, reads. A new account never gets one, so nothing can be
 * inherited through a reused name.
 *
 * The file is `<workspace>/.starlingai/document-aliases.json` (the deployment's own state
 * directory, which no file tool can read and which a stack wipe keeps):
 *
 *   { "version": 1, "aliases": { "<account id>": ["user:<username>", ...] } }
 *
 * Read on demand, cached on the file's size and modification time. An alias only widens what an
 * account may read, so a file that cannot be read grants nothing; only `user:` sources count.
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { PRODUCT } from "../product/index.js";
import { sameAccountId } from "../runtime/accounts.js";

const log = childLogger("retrieval:document-aliases");

/** Where the aliases of the deployment at `workspacePath` live. */
export function documentAliasesPath(workspacePath: string): string {
  return resolve(workspacePath, PRODUCT.stateDirName, "document-aliases.json");
}

interface Loaded {
  path: string;
  size: number;
  mtimeMs: number;
  aliases: ReadonlyMap<string, readonly string[]>;
}

let _loaded: Loaded | null = null;
const EMPTY: ReadonlyMap<string, readonly string[]> = new Map();

function load(path: string): ReadonlyMap<string, readonly string[]> {
  let size: number;
  let mtimeMs: number;
  try {
    const stats = statSync(path);
    size = stats.size;
    mtimeMs = stats.mtimeMs;
  } catch {
    return EMPTY; // no file: no account has adopted anything
  }
  if (_loaded && _loaded.path === path && _loaded.size === size && _loaded.mtimeMs === mtimeMs) return _loaded.aliases;
  const aliases = new Map<string, readonly string[]>();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { aliases?: unknown };
    const raw = parsed?.aliases;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [account, sources] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(sources)) continue;
        const kept = sources.filter((source): source is string => typeof source === "string" && source.startsWith("user:") && source.length > "user:".length);
        if (kept.length > 0) aliases.set(account.toLowerCase(), kept);
      }
    }
  } catch (err) {
    log.warn({ err, path }, "Document aliases cannot be read; no account reads a corpus from before account ids until they can");
    return EMPTY;
  }
  _loaded = { path, size, mtimeMs, aliases };
  return aliases;
}

/** The pre-account-id user sources `account` reads besides its own; none for any other account. */
export function documentSourceAliases(account: string): readonly string[] {
  let path: string;
  try {
    path = documentAliasesPath(getConfig().workspacePath);
  } catch {
    return [];
  }
  const aliases = load(path);
  for (const [holder, sources] of aliases) {
    if (sameAccountId(holder, account)) return sources;
  }
  return [];
}

/** Test-only: forget the cached file. */
export function resetDocumentAliasesForTests(): void {
  _loaded = null;
}
