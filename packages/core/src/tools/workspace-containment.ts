/**
 * Where a workspace path really leads through the links in the workspace, and opening it held there.
 *
 * A leaf module (it imports only the zones): the page-check worker, which must not import the
 * config, holds the scripts a page names to the page's directory with it. tools/workspace-path.ts
 * re-exports containedWorkspaceRealPath, and its resolvers apply it to every path they resolve; the
 * file tools open what they read and write through withContainedWorkspaceFile.
 */
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { USERS_SUBDIR } from "./workspace-zones.js";

/**
 * What a link in the workspace may do to a path the gateway is about to open: `final` "follow"
 * (the default) holds the path to where it really leads, its last component included; "link" holds
 * only the directory it is in, for a caller that acts on the last component itself (removing a
 * link, or refusing one it finds there).
 */
export interface WorkspaceContainmentOptions {
  final?: "follow" | "link";
}

/** A path as it really is on disk, and the workspace root's real path. */
export interface WorkspaceRealPath {
  real: string;
  root: string;
}

/**
 * WHERE A WORKSPACE PATH REALLY LEADS, or null when a link takes it out of its zone.
 *
 * A sandbox can make links in every directory it can write: an account's whole root, which its
 * sandboxes are handed read-write, and generated/ of the shared root for an auth-off session. The
 * workspace resolvers (tools/workspace-path.ts) are lexical, and the gateway's own reads and writes
 * followed whatever link a sandbox left on the way: write_file to `generated/evil.jsonc` linked to
 * `../agents/evil.jsonc` wrote a config shard the loader merges, `generated/up` linked to `..`
 * reached the parent, and an absolute target is resolved on the gateway's filesystem, not the
 * sandbox's (review 2026-10-11).
 *
 * The path's ZONE is its first segment under the workspace root (generated/, uploads/, agents/, a
 * file at the root; users/<segment> for an account's directory): its real path must stay inside the
 * real path of that zone in the real root, so a link can neither leave the workspace nor cross into
 * another zone, the state directory included.
 *
 * A ZONE DIRECTORY THAT IS ITSELF A LINK IS REFUSED, DELIBERATELY, with every path through it. The
 * zone is the segment's place in the real root, not where the segment leads, so even a link that
 * stays in the workspace does not pass: a sandbox could otherwise replace generated/ with a link to
 * agents/, and every write the gateway makes into generated/ would land in a config shard.
 *
 * The nearest part of the path that exists is resolved, the last component too unless `final` is
 * "link"; what does not exist yet cannot be a link. A link that leads nowhere is refused: a write
 * through it creates its target, wherever that is. A workspace root that does not exist has nothing
 * on disk to follow.
 *
 * Checked when the path is resolved, not when it is opened: a sandbox running at the same moment can
 * still swap a directory for a link in between. The file tools therefore open, make and remove
 * through withContainedWorkspaceFile, makeContainedWorkspaceDir and removeContainedWorkspaceFile
 * below, which hold the path to its zone again as it is opened; the routes and generators that
 * write through the resolvers keep this check only.
 */
export function containedWorkspaceRealPath(
  resolvedPath: string,
  workspacePath: string,
  options: WorkspaceContainmentOptions = {},
): WorkspaceRealPath | null {
  const root = resolve(workspacePath);
  const target = resolve(resolvedPath);
  const rel = relativeInside(root, target);
  if (rel === null) return null;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { real: target, root };
  }
  const zone = zoneIn(realRoot, rel);

  const rest: string[] = [];
  let probe = target;
  if (options.final === "link" && target !== root) {
    rest.unshift(basename(target));
    probe = dirname(target);
  }
  for (;;) {
    let exists = true;
    try {
      lstatSync(probe);
    } catch {
      exists = false;
    }
    if (exists || probe === root) break;
    rest.unshift(basename(probe));
    probe = dirname(probe);
  }
  let real: string;
  try {
    real = join(realpathSync(probe), ...rest);
  } catch {
    return null; // a link that leads nowhere
  }
  return isWithin(real, zone) ? { real, root: realRoot } : null;
}

/** `target` relative to `root`, or null where it is not inside it. */
function relativeInside(root: string, target: string): string | null {
  const rel = relative(root, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel;
}

/**
 * The real path of the zone a path `rel` under the real root is in.
 *
 * An account's directory under the shared root is a zone of its own: a link one account's sandbox
 * made must not lead a path through the shared root into another account's.
 *
 * `users` IN ANY CASE. On a case-insensitive filesystem (Windows, macOS, a Docker Desktop bind)
 * `USERS/alice` is `users/alice`, and compared exactly it made all of `USERS/` one zone, where a
 * link in alice's directory reached bob's (review 2026-10-11). Lowercasing is safe the other way
 * too: on a case-sensitive filesystem a directory named `USERS` only gets the narrower zone.
 */
function zoneIn(realRoot: string, rel: string): string {
  const segments = rel === "" ? [] : rel.split(sep);
  return join(realRoot, ...segments.slice(0, segments[0]?.toLowerCase() === USERS_SUBDIR ? 2 : 1));
}

function isWithin(path: string, dir: string): boolean {
  const [p, d] = process.platform === "win32" ? [path.toLowerCase(), dir.toLowerCase()] : [path, dir];
  return p === d || p.startsWith(d.endsWith(sep) ? d : `${d}${sep}`);
}

// ── Opening a workspace path held to its zone when it is opened ─────────────────────────────────

/**
 * Thrown where opening, making or removing a workspace path would leave the path's zone or go
 * through a link the gateway does not follow there, or where what was opened is not a regular file.
 * The message is what the file tools return.
 */
export class WorkspaceContainmentError extends Error {
  constructor(message = "Path escapes workspace boundary") {
    super(message);
    this.name = "WorkspaceContainmentError";
  }
}

export function isWorkspaceContainmentError(err: unknown): err is WorkspaceContainmentError {
  return err instanceof WorkspaceContainmentError;
}

export interface ContainedFileOptions {
  /**
   * "read": an existing file, read-only, through any link that keeps it in its zone, as the
   * resolver allowed. "edit": an existing file, read-write. "write": read-write, created where it
   * is missing. "create": as "write", but EEXIST where the file exists. The last three never open
   * a link at the file's own name.
   */
  mode: "read" | "edit" | "write" | "create";
  /** Make the missing directories on the way ("write" and "create"), and a missing root. */
  createDirs?: boolean;
  /** A real path in the zone, relative to the real root, that the caller refuses all the same
   *  (the file tools' denylist). */
  refuse?: (realRelativePath: string) => boolean;
}

/** A workspace file withContainedWorkspaceFile opened. Every read and write goes through the open
 *  descriptor, never through the path again. */
export interface ContainedFile {
  /** Whether opening it created it. */
  readonly created: boolean;
  stat(): Stats;
  /** The whole file, from its first byte. */
  read(): Buffer;
  /** Truncates the file, then writes `data` from its first byte. */
  replace(data: string | Uint8Array): void;
  /** Writes `data` at the file's end. */
  append(data: string | Uint8Array): void;
}

/**
 * OPENS A WORKSPACE FILE, HOLDS IT TO ITS ZONE AS OPENED, hands it to `use` and closes it.
 *
 * containedWorkspaceRealPath judges a path when it is resolved, and the file tools then read or
 * wrote by path again, following whatever was on the way by then. Every sandbox of an account has
 * its whole root read-write, and serve_app runs long-lived containers as a cap-less root with the
 * app's directory bound read-write, so a sandbox can race the gateway: swap a directory on the way
 * for a link to agents/ between the check and the write (review 2026-10-11). Here missing
 * directories are made one level at a time and none is entered through a link; the file is opened
 * without O_TRUNC and, except for a read, never through a link at its own name; where the open file
 * really is, is checked against the zone; and only then is it truncated and written, or read,
 * through the descriptor.
 *
 * ON LINUX, the gateway's deployment, through /proc/self/fd: the nearest existing directory is
 * opened and each directory after it is made and opened RELATIVE TO the one before
 * (`/proc/self/fd/<fd>/<name>` names the entry in exactly that open directory, as openat does), so
 * nothing is made outside the zone and a swap after the walk does not reach the file. Where an open
 * directory or file really is, is read back from its descriptor. ELSEWHERE (Windows has no /proc,
 * and macOS's F_GETPATH is not reachable from Node) the resolve-time check is kept and repeated
 * right before the open, and each directory made is checked with lstat: that narrows the window a
 * swap has to hit, but does not close it.
 *
 * Throws WorkspaceContainmentError where the path leaves its zone, ENOENT where "read" or "edit"
 * finds no file, EEXIST where "create" finds one.
 */
export function withContainedWorkspaceFile<T>(
  resolvedPath: string,
  workspacePath: string,
  options: ContainedFileOptions,
  use: (file: ContainedFile) => T,
): T {
  const file = openContainedWorkspaceFile(resolvedPath, workspacePath, options);
  try {
    return use(file);
  } finally {
    file.close();
  }
}

/** A ContainedFile its caller closes. */
export interface OpenContainedFile extends ContainedFile {
  close(): void;
}

/** withContainedWorkspaceFile for a caller that keeps the file open across several steps and
 *  closes it itself, once. */
export function openContainedWorkspaceFile(
  resolvedPath: string,
  workspacePath: string,
  options: ContainedFileOptions,
): OpenContainedFile {
  const target = resolve(resolvedPath);
  if (options.mode !== "read" && options.createDirs) makeRoot(workspacePath);
  const zone = zoneOf(target, workspacePath);
  const { fd, created } = descriptorPaths()
    ? openOnLinux(target, zone, options)
    : openElsewhere(target, workspacePath, options);
  return containedFile(fd, created);
}

/**
 * Makes a workspace directory and every missing one on the way, held to its zone as
 * withContainedWorkspaceFile holds a file: one level at a time, none entered through a link, and on
 * Linux each one made relative to the open directory before it. A directory that is there already is
 * fine, as for `mkdir -p`; one reached through a link is checked where it really is.
 */
export function makeContainedWorkspaceDir(
  resolvedPath: string,
  workspacePath: string,
  options: Pick<ContainedFileOptions, "refuse"> = {},
): void {
  const target = resolve(resolvedPath);
  makeRoot(workspacePath);
  const zone = zoneOf(target, workspacePath);
  if (descriptorPaths()) {
    closeSync(openDirectoryOnLinux(target, "", refusedIn(zone, options), true));
    return;
  }
  recheckElsewhere(target, workspacePath, "link", options);
  makeDirectoriesElsewhere(target);
}

/**
 * Removes a workspace file, or a link at its name (never what the link leads to), held to its zone:
 * on Linux it is unlinked in the open directory it was found in. Throws ENOENT where nothing is
 * there, EISDIR where a directory is.
 */
export function removeContainedWorkspaceFile(
  resolvedPath: string,
  workspacePath: string,
  options: Pick<ContainedFileOptions, "refuse"> = {},
): void {
  const target = resolve(resolvedPath);
  const zone = zoneOf(target, workspacePath);
  if (descriptorPaths()) {
    const dirFd = openDirectoryOnLinux(dirname(target), basename(target), refusedIn(zone, options), false);
    try {
      const entry = fdEntry(dirFd, basename(target));
      if (lstatSync(entry).isDirectory()) throw codedError("EISDIR", target);
      unlinkSync(entry);
    } finally {
      closeSync(dirFd);
    }
    return;
  }
  recheckElsewhere(target, workspacePath, "link", options);
  if (lstatSync(target).isDirectory()) throw codedError("EISDIR", target);
  unlinkSync(target);
}

interface Zone {
  realRoot: string;
  zone: string;
}

/** The real root and the real path of the zone `target` is in; throws where it is not in the root. */
function zoneOf(target: string, workspacePath: string): Zone {
  const root = resolve(workspacePath);
  const rel = relativeInside(root, target);
  if (rel === null) throw new WorkspaceContainmentError();
  const realRoot = realpathSync(root);
  return { realRoot, zone: zoneIn(realRoot, rel) };
}

/** A predicate on a real path: refused where it is outside the zone, or one the caller refuses. */
function refusedIn({ realRoot, zone }: Zone, options: Pick<ContainedFileOptions, "refuse">): (real: string) => boolean {
  return (real) => !isWithin(real, zone) || options.refuse?.(relative(realRoot, real)) === true;
}

/** A new account's root does not exist before its first write; the gateway makes it, as it did. */
function makeRoot(workspacePath: string): void {
  mkdirSync(resolve(workspacePath), { recursive: true });
}

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const FD_PATHS = "/proc/self/fd";

let fdPathsWork: boolean | undefined;

/** Whether this process can read back the path of an open descriptor (/proc/self/fd, Linux). */
function descriptorPaths(): boolean {
  if (fdPathsWork === undefined) {
    fdPathsWork = false;
    if (process.platform === "linux") {
      try {
        const fd = openSync("/", constants.O_RDONLY);
        try {
          fdPathsWork = readlinkSync(`${FD_PATHS}/${fd}`) === "/";
        } finally {
          closeSync(fd);
        }
      } catch {
        // No procfs: the path elsewhere.
      }
    }
  }
  return fdPathsWork;
}

/** Where the file or directory `fd` is open on really is. */
function descriptorPath(fd: number): string {
  return readlinkSync(`${FD_PATHS}/${fd}`);
}

/** The entry `name` in exactly the directory `dirFd` is open on. */
function fdEntry(dirFd: number, name: string): string {
  return `${FD_PATHS}/${dirFd}/${name}`;
}

function openOnLinux(target: string, zone: Zone, options: ContainedFileOptions): { fd: number; created: boolean } {
  const refused = refusedIn(zone, options);
  if (options.mode === "read") {
    // A read follows a link that keeps it in its zone, as the resolver allowed; where it led is
    // checked on the open file. O_NONBLOCK: a fifo planted under the name does not hang the open.
    return { fd: regularFileIn(openSync(target, constants.O_RDONLY | O_NONBLOCK), refused), created: false };
  }
  const creates = options.mode === "write" || options.mode === "create";
  const dirFd = openDirectoryOnLinux(dirname(target), basename(target), refused, creates && options.createDirs === true);
  const entry = fdEntry(dirFd, basename(target));
  const exclusive = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW | O_NONBLOCK;
  try {
    let fd: number;
    let created = false;
    if (options.mode === "create") {
      fd = openSync(entry, exclusive, 0o666);
      created = true;
    } else {
      try {
        fd = openSync(entry, constants.O_RDWR | O_NOFOLLOW | O_NONBLOCK);
      } catch (err) {
        if (errorCode(err) !== "ENOENT" || !creates) throw err;
        fd = openSync(entry, exclusive, 0o666);
        created = true;
      }
    }
    try {
      return { fd: regularFileIn(fd, refused), created };
    } catch (err) {
      if (created) unlinkQuietly(entry);
      throw err;
    }
  } catch (err) {
    // ELOOP: O_NOFOLLOW met a link at the file's own name.
    throw errorCode(err) === "ELOOP" ? new WorkspaceContainmentError() : err;
  } finally {
    closeSync(dirFd);
  }
}

/**
 * An open descriptor for the directory `dir`, whose eventual entry `leaf` ("" for the directory
 * itself) `refused` accepts. The nearest directory that exists is opened through any link on the
 * way and judged where it really is, with everything still to make under it; each missing one is
 * then made in the open directory before it and opened there without following a link that took
 * its place.
 */
function openDirectoryOnLinux(dir: string, leaf: string, refused: (real: string) => boolean, create: boolean): number {
  const missing: string[] = [];
  let probe = dir;
  while (!lexists(probe)) {
    const up = dirname(probe);
    if (!create || up === probe) throw codedError("ENOENT", join(dir, leaf));
    missing.unshift(basename(probe));
    probe = up;
  }
  let fd = openSync(probe, constants.O_RDONLY | O_DIRECTORY);
  try {
    if (refused(join(descriptorPath(fd), ...missing, leaf))) throw new WorkspaceContainmentError();
    for (const name of missing) {
      const entry = fdEntry(fd, name);
      try {
        mkdirSync(entry);
      } catch (err) {
        if (errorCode(err) !== "EEXIST") throw err;
      }
      const next = openSync(entry, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (err) {
    closeSync(fd);
    throw errorCode(err) === "ELOOP" ? new WorkspaceContainmentError() : err;
  }
}

/** `fd`, where it is open on a regular file at a real path `refused` accepts; closed and thrown
 *  otherwise. On Linux only: elsewhere the descriptor's path cannot be read back. */
function regularFileIn(fd: number, refused: ((real: string) => boolean) | null): number {
  try {
    if (!fstatSync(fd).isFile()) throw new WorkspaceContainmentError("Not a regular file");
    if (refused && refused(descriptorPath(fd))) throw new WorkspaceContainmentError();
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

function openElsewhere(target: string, workspacePath: string, options: ContainedFileOptions): { fd: number; created: boolean } {
  // No descriptor path to read back here: the resolve-time check, again, right before the open.
  recheckElsewhere(target, workspacePath, options.mode === "read" ? "follow" : "link", options);
  if (options.mode === "read") {
    return { fd: regularFileIn(openSync(target, constants.O_RDONLY | O_NONBLOCK), null), created: false };
  }
  const creates = options.mode === "write" || options.mode === "create";
  if (creates && options.createDirs) makeDirectoriesElsewhere(dirname(target));
  if (isLink(target)) throw new WorkspaceContainmentError();
  const exclusive = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW;
  let fd: number;
  let created = false;
  if (options.mode === "create") {
    fd = openSync(target, exclusive, 0o666);
    created = true;
  } else {
    try {
      fd = openSync(target, constants.O_RDWR | O_NOFOLLOW);
    } catch (err) {
      if (errorCode(err) !== "ENOENT" || !creates) throw err;
      fd = openSync(target, exclusive, 0o666);
      created = true;
    }
  }
  return { fd: regularFileIn(fd, null), created };
}

/** containedWorkspaceRealPath again, with the caller's own refusal, throwing where either refuses. */
function recheckElsewhere(
  target: string,
  workspacePath: string,
  final: "follow" | "link",
  options: Pick<ContainedFileOptions, "refuse">,
): void {
  const real = containedWorkspaceRealPath(target, workspacePath, { final });
  if (!real || options.refuse?.(relative(real.root, real.real)) === true) throw new WorkspaceContainmentError();
}

/** `mkdir -p` one level at a time, each level checked with lstat: a link that took a directory's
 *  place is not entered. */
function makeDirectoriesElsewhere(dir: string): void {
  const missing: string[] = [];
  let probe = dir;
  while (!lexists(probe)) {
    const up = dirname(probe);
    if (up === probe) break;
    missing.unshift(basename(probe));
    probe = up;
  }
  if (missing.length === 0 && !statSync(dir).isDirectory()) throw codedError("EEXIST", dir);
  for (const name of missing) {
    probe = join(probe, name);
    try {
      mkdirSync(probe);
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
    }
    if (!lstatSync(probe).isDirectory()) throw new WorkspaceContainmentError();
  }
}

function containedFile(fd: number, created: boolean): OpenContainedFile {
  let open = true;
  return {
    created,
    stat: () => fstatSync(fd),
    read: () => readWhole(fd),
    replace: (data) => {
      ftruncateSync(fd, 0);
      writeWhole(fd, data, 0);
    },
    append: (data) => writeWhole(fd, data, fstatSync(fd).size),
    close: () => {
      if (open) closeSync(fd);
      open = false;
    },
  };
}

/** Every byte of the file, from the first, whatever the descriptor's position. */
function readWhole(fd: number): Buffer {
  const chunks: Buffer[] = [];
  let position = 0;
  for (;;) {
    const chunk = Buffer.alloc(Math.max(fstatSync(fd).size - position, 64 * 1024));
    const read = readSync(fd, chunk, 0, chunk.length, position);
    if (read === 0) break;
    chunks.push(chunk.subarray(0, read));
    position += read;
  }
  return Buffer.concat(chunks);
}

function writeWhole(fd: number, data: string | Uint8Array, position: number): void {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let written = 0;
  while (written < bytes.length) {
    written += writeSync(fd, bytes, written, bytes.length - written, position + written);
  }
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Left; it is an empty file in the zone.
  }
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function codedError(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${path}`), { code, path });
}
