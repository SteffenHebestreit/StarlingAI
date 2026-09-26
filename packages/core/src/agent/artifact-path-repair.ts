/**
 * Repairs file paths the model mis-copied into its final answer.
 *
 * Long generated names (image-1790107355849_realistic.png) are copied by the model, not by the
 * runtime, and a local model drops or doubles a digit often enough to matter: session f4ebf47b
 * embedded image-179010735849_realistic.png in the answer while the tool had written
 * image-1790107355849_realistic.png. The runtime already knows every path a tool wrote, so a
 * reference that is a near copy of exactly one of them is put back to the real name.
 *
 * The rules are deliberately narrow, because a repair silently rewrites what the model said:
 * - a token is left alone when its path or filename is already known, or the file exists;
 * - the two filenames may differ only by dropped or duplicated characters, never a changed one,
 *   so report-2024.pdf is never "repaired" to report-2025.pdf;
 * - at most min(2, length / 12) such characters, so names under 12 characters are never touched;
 * - the extension must be the same and the folders must be compatible;
 * - exactly one known filename may match, otherwise the reference is ambiguous and kept.
 * Only the filename is replaced; the token's own folder prefix stays. A second pass changes nothing.
 *
 * INVARIANT: a leaf module. It imports nothing from runtime.ts, so any stage can call it.
 */

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { collectArtifactRecords } from "./artifact-metadata.js";

export interface ArtifactPathRepair {
  readonly from: string;
  readonly to: string;
}

/**
 * A path-shaped token: slash-separated segments ending in an extension. It cannot start inside a
 * word, a URL or an absolute path, and cannot end inside a longer name, so a URL's path is never a
 * candidate. Also read by sibling-write-ownership.ts for the files a task names (global: use it
 * with matchAll, which does not share its lastIndex).
 */
export const PATH_TOKEN = /(?<![\w./:-])([\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]{1,5})(?![\w/-])/g;

/** At most this many dropped or duplicated characters, and one per 12 characters of name. */
const MAX_EDITS = 2;
const CHARS_PER_EDIT = 12;

type HistoryEntry = { readonly role: string; readonly metadata?: Record<string, unknown> };

/**
 * Every file path this session's tools recorded, across all turns, so a path mis-copied from an
 * earlier turn is also recognised. Tool results carry the paths in their metadata (top level and
 * nested `artifacts`); final answers carry the same paths as `attachments`, which outlive the tool
 * messages when history is trimmed.
 */
export function collectSessionArtifactPaths(history: ReadonlyArray<HistoryEntry>): string[] {
  const paths = new Set<string>();
  for (const message of history) {
    const metadata = message.metadata;
    if (!metadata || typeof metadata !== "object") continue;
    if (message.role === "tool") {
      // Wrapping the result as a one-entry list lets the shared walker read its top-level
      // outputPath as well as the nested lists that delegations pass up.
      for (const record of collectArtifactRecords({ artifacts: [metadata] })) paths.add(record.ref);
    } else if (message.role === "assistant" && Array.isArray(metadata["attachments"])) {
      for (const attachment of metadata["attachments"] as unknown[]) {
        if (!attachment || typeof attachment !== "object") continue;
        const entry = attachment as Record<string, unknown>;
        const ref = [entry["relativePath"], entry["filename"]].find((value) => typeof value === "string" && value.trim());
        if (typeof ref === "string") paths.add(ref.trim());
      }
    }
  }
  return [...paths];
}

/** True when `token`, read as a workspace-relative path, names an existing file inside the workspace. */
export function workspaceFileExists(workspacePath: string | undefined): (token: string) => boolean {
  return (token) => {
    if (!workspacePath) return false;
    try {
      const target = resolve(workspacePath, token);
      const rel = relative(workspacePath, target);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
      return existsSync(target);
    } catch {
      return false;
    }
  };
}

function splitPath(path: string): { folder: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { folder: "", name: path } : { folder: path.slice(0, slash), name: path.slice(slash + 1) };
}

function extensionOf(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1).toLowerCase();
}

/** No folder on either side, the same folder, or one folder is a trailing part of the other. */
function foldersCompatible(a: string, b: string): boolean {
  return !a || !b || a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function isSubsequence(shorter: string, longer: string): boolean {
  let i = 0;
  for (let j = 0; j < longer.length && i < shorter.length; j += 1) {
    if (shorter[i] === longer[j]) i += 1;
  }
  return i === shorter.length;
}

/** Whether removing `count` characters that each repeat their neighbour turns `longer` into `target`. */
function isDuplicationOf(longer: string, target: string, count: number): boolean {
  if (count === 0) return longer === target;
  for (let i = 1; i < longer.length; i += 1) {
    if (longer[i] !== longer[i - 1]) continue;
    if (isDuplicationOf(longer.slice(0, i) + longer.slice(i + 1), target, count - 1)) return true;
  }
  return false;
}

/** Digit runs shorter than this are numbers a name means (a year, a version, a page); longer ones are ids. */
const MIN_ID_DIGITS = 6;

/**
 * The numbers in the two names agree, except inside long digit runs. A dropped digit in a 13-digit
 * timestamp is a copying slip; report-2024-1 against report-2024-11 is a different report, and a
 * dropped or doubled character there changes the number just as much as a changed one would.
 */
function numbersAgree(written: string, real: string): boolean {
  const a = written.match(/\d+/g) ?? [];
  const b = real.match(/\d+/g) ?? [];
  if (a.length !== b.length) return false;
  return a.every((run, i) => run === b[i] || (run.length >= MIN_ID_DIGITS && b[i]!.length >= MIN_ID_DIGITS));
}

/** The written name differs from the real one only by dropped or duplicated characters, within the limit. */
function isDropOrDuplicationCopy(written: string, real: string): boolean {
  const edits = Math.abs(written.length - real.length);
  const limit = Math.min(MAX_EDITS, Math.floor(Math.min(written.length, real.length) / CHARS_PER_EDIT));
  if (edits < 1 || edits > limit) return false;
  if (!numbersAgree(written, real)) return false;
  return written.length < real.length
    ? isSubsequence(written, real)
    : isDuplicationOf(written, real, edits);
}

/**
 * Puts mis-copied artifact references in `text` back to the real path. `knownPaths` are the paths
 * the runtime recorded; `exists` is consulted only when a repair is about to happen. Returns the
 * text unchanged, and no repairs, when nothing qualifies.
 */
export function repairArtifactPathReferences(
  text: string,
  knownPaths: readonly string[],
  exists?: (token: string) => boolean,
): { text: string; repairs: ArtifactPathRepair[] } {
  if (!text || knownPaths.length === 0) return { text, repairs: [] };
  const known = knownPaths.map((path) => ({ path, ...splitPath(path) }));
  const knownPathSet = new Set(knownPaths);
  const knownNames = new Set(known.map((entry) => entry.name));
  const repairs = new Map<string, ArtifactPathRepair>();

  const repaired = text.replace(PATH_TOKEN, (token: string) => {
    const { folder, name } = splitPath(token);
    if (knownPathSet.has(token) || knownNames.has(name)) return token;
    const extension = extensionOf(name);
    const matches = new Set(
      known
        .filter((entry) => extensionOf(entry.name) === extension
          && foldersCompatible(folder, entry.folder)
          && isDropOrDuplicationCopy(name, entry.name))
        .map((entry) => entry.name),
    );
    if (matches.size !== 1) return token;
    if (exists?.(token)) return token;
    const [realName] = [...matches];
    const fixed = folder ? `${folder}/${realName}` : realName!;
    repairs.set(`${token}\n${fixed}`, { from: token, to: fixed });
    return fixed;
  });

  return { text: repaired, repairs: [...repairs.values()] };
}
