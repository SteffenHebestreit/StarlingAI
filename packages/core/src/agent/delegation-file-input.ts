/**
 * Whether a delegation has a file of the user's to read.
 *
 * The routed-candidate gates (tools/sub-agent.ts) drop an agent whose only source is an upload
 * (agentCfgReadsOnlyUploads) when the delegation has none: in the E2E run of 2026-10-12 (f08cee40)
 * the router handed a workflow step about a website, with nothing attached, to document_intake. The
 * gate is only right if "none" is: a file the delegation could mean that this check misses sends a
 * step about it to an agent that cannot open it. So every place such a file can be is asked, and
 * what cannot be asked counts as a file:
 *
 *   - the conversation is decided by its ROOT (through sub-agent and workflow runs). A root this
 *     process does not hold (the scene worker holds a workflow run but not the chat; an archived
 *     chat) cannot be asked, so the answer is yes;
 *   - an attachment on a user message anywhere in that chain;
 *   - the conversation's own upload folder, `uploads/<root session>/`, where the gateway stores a
 *     chat attachment and a session-scoped document upload. It outlives the message: a compacted
 *     history keeps only the first user message. On S3 the store is listed, as no disk holds it.
 *     Only this conversation's folder: an account keeps the uploads of every other conversation;
 *   - a file the task or its context names: a path in the workspace, relative or absolute, that is a
 *     file or a folder holding one, or a bare name that one of the files under uploads/ or
 *     generated/ carries (the upload routes store `<timestamp>-<name>`, with every character but
 *     ASCII letters, digits, `.`, `_` and `-` replaced by `_`). Names are read in any script and
 *     with spaces when quoted: "Lieferschein Müller.pdf".
 */
import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { getSession } from "./session.js";
import { parentSessionOf, rootSessionOf } from "./session-ids.js";
import { GENERATED_SUBDIR, UPLOADS_SUBDIR } from "../tools/workspace-zones.js";

/** The nested runs a delegation can sit in: sub-agent runs and workflow runs. */
const NESTED_RUN_PREFIXES = ["sub:", "workflow:"];

/** The session ids the upload routes accept as a folder name (gateway/index.ts persist-attachment). */
const UPLOAD_FOLDER_SESSION_RE = /^[\w-]{1,64}$/;

/** A URL, which names no workspace file however much of it looks like one. */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>()]+/giu;
/** Text between a pair of quotes on one line: a name that may carry spaces. */
const QUOTED_RE = /["'`„“”«»‚‘’]([^"'`„“”«»‚‘’\r\n]{1,200})["'`„“”«»‚‘’]/gu;
/** What surrounds a name in a sentence and is not part of it. */
const LEADING_PUNCTUATION_RE = /^[\s"'`„“”«»‚‘’([{<]+/u;
const TRAILING_PUNCTUATION_RE = /[\s"'`„“”«»‚‘’)\]}>.,;:!?]+$/u;
/** A name ending in an extension, in any script. */
const HAS_EXTENSION_RE = /[^\s/\\]\.[\p{L}\p{N}]{1,8}$/u;
/** The timestamp the upload routes put in front of a stored name. */
const UPLOAD_STAMP_RE = /^\d{10,}-/;

const MAX_CANDIDATES = 64;
const WALK_MAX_DEPTH = 4;
const WALK_MAX_ENTRIES = 2_000;

/** What the delegation is about and where it runs. */
export interface DelegationFileProbe {
  sessionId: string;
  workspacePath: string;
  /** The delegation's task and context: the text that may name a file. */
  texts: ReadonlyArray<string | undefined>;
}

/** The test that tells whether the conversation's upload folder holds a file; the store's, unless a test hands its own. */
export type UploadFolderProbe = (relativeDir: string) => Promise<boolean | null>;

async function storeUploadFolderProbe(relativeDir: string): Promise<boolean | null> {
  const { uploadFolderHoldsFile } = await import("../storage/object-store.js");
  return uploadFolderHoldsFile(relativeDir);
}

/** True unless it is established that the delegation has no file of the user's to read. */
export async function delegationHasUserFile(
  probe: DelegationFileProbe,
  uploadFolderProbe: UploadFolderProbe = storeUploadFolderProbe,
): Promise<boolean> {
  const rootId = rootSessionOf(probe.sessionId, NESTED_RUN_PREFIXES);
  if (!getSession(rootId)) return true;
  if (chainHasAttachment(probe.sessionId)) return true;
  if (UPLOAD_FOLDER_SESSION_RE.test(rootId)) {
    const held = await uploadFolderProbe(`${UPLOADS_SUBDIR}/${rootId}`).catch(() => null);
    if (held !== false) return true;
  }
  return textsNameWorkspaceFile(probe.texts, probe.workspacePath);
}

/** An attachment on a user message of any session from `sessionId` up to its root that this process holds. */
function chainHasAttachment(sessionId: string): boolean {
  let id: string | null = sessionId;
  for (let depth = 0; id && depth < 16; depth += 1) {
    const session = getSession(id);
    const attached = session?.getHistory().some((message) => {
      const attachments = message.role === "user" ? message.metadata?.["attachments"] : undefined;
      return Array.isArray(attachments) && attachments.length > 0;
    });
    if (attached) return true;
    const parent = parentSessionOf(id, NESTED_RUN_PREFIXES);
    id = parent === id ? null : parent;
  }
  return false;
}

/**
 * The strings in `text` that may name a file or a folder: quoted text, and the words that carry a
 * path separator or end in an extension, without the punctuation of the sentence around them.
 * URLs are left out.
 */
export function namedFileCandidates(text: string): string[] {
  const candidates = new Set<string>();
  const add = (raw: string): void => {
    const name = raw.replace(LEADING_PUNCTUATION_RE, "").replace(TRAILING_PUNCTUATION_RE, "");
    if (name && (/[/\\]/.test(name) || HAS_EXTENSION_RE.test(name))) candidates.add(name);
  };
  const withoutUrls = text.replace(URL_RE, " ");
  for (const match of withoutUrls.matchAll(QUOTED_RE)) add(match[1] ?? "");
  for (const word of withoutUrls.split(/\s+/u)) add(word);
  return [...candidates].slice(0, MAX_CANDIDATES);
}

function textsNameWorkspaceFile(texts: ReadonlyArray<string | undefined>, workspacePath: string): boolean {
  if (!workspacePath) return false;
  const root = resolve(workspacePath);
  let storedNames: Set<string> | undefined;
  for (const candidate of texts.flatMap((text) => (text ? namedFileCandidates(text) : []))) {
    const path = candidate.replace(/\\/g, "/");
    if (path.includes("/") || isAbsolute(candidate)) {
      const target = isAbsolute(candidate) ? resolve(candidate) : resolve(root, path);
      const within = relative(root, target);
      if (!within || within.startsWith("..") || isAbsolute(within)) continue;
      if (pathHoldsFile(target)) return true;
      continue;
    }
    storedNames ??= namesStoredUnder(root, [UPLOADS_SUBDIR, GENERATED_SUBDIR]);
    if (bareNameForms(candidate).some((form) => storedNames!.has(form))) return true;
  }
  return false;
}

/** A file, or a folder with a file in it a few levels down. */
function pathHoldsFile(target: string): boolean {
  try {
    if (!existsSync(target)) return false;
    if (statSync(target).isFile()) return true;
  } catch {
    return false;
  }
  let found = false;
  walk(target, () => { found = true; return false; });
  return found;
}

/** The forms a typed name takes once an upload route has stored it, lower-cased. */
function bareNameForms(name: string): string[] {
  return [...new Set([name, name.replace(/[^\w.-]+/g, "_")].map((form) => form.toLowerCase()))];
}

/** Every file name under the given workspace folders, lower-cased, with and without an upload stamp. */
function namesStoredUnder(root: string, folders: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const folder of folders) {
    walk(resolve(root, folder), (file) => {
      const name = basename(file).toLowerCase();
      names.add(name);
      names.add(name.replace(UPLOAD_STAMP_RE, ""));
      return true;
    });
  }
  return names;
}

/** Visit the files under `dir`, bounded in depth and entries; stop when `visit` returns false. */
function walk(dir: string, visit: (file: string) => boolean): void {
  let budget = WALK_MAX_ENTRIES;
  let level = [dir];
  for (let depth = 0; depth < WALK_MAX_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const current of level) {
      let entries: Dirent[];
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (--budget < 0) return;
        const path = resolve(current, entry.name);
        if (entry.isFile() && !visit(path)) return;
        if (entry.isDirectory()) next.push(path);
      }
    }
    level = next;
  }
}
