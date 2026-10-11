/**
 * The one-time move of each account's workspace state out of the account's own root.
 *
 * The gateway kept an account's workspace state (durable memory, skills, the trajectory cache and
 * the rest) in `<shared>/users/<segment>/<stateDir>`, inside the directory that account's sandboxes
 * are handed read-write. It now keeps it under the deployment's state directory
 * (tools/workspace-state.ts workspaceStateDir), and this moves what an account already has there.
 *
 * EAGER, AT BOOT, BEFORE ANY SANDBOX RUNS. Nothing moves the old directory on access: a sandbox
 * could create it first, and whatever it planted there would be adopted as the account's state.
 *
 * ONCE. The first pass that completes for every account writes a marker
 * (workspaceStateRelocatedMarker, `<shared>/<stateDir>/users/.relocated-v1`), and once it exists
 * nothing is moved again: what turns up at an old place afterwards is a file of the account's own
 * workspace, logged at debug level and never read. The pass makes the new directory of every account
 * root, of those with nothing to move too, and puts ACCOUNT_DONE in it, so an old directory found
 * later beside a new one is that, not data. The first version ran on every boot and adopted an old
 * directory a sandbox planted later, for any account whose new directory did not exist yet (review
 * 2026-10-11).
 *
 * STAGED, ALL OR NOTHING PER ACCOUNT. The old directory is renamed (renameRetrying, which waits out
 * a Windows sharing error as the account migration does) into a staging directory beside the new
 * one, inside the deployment's state directory, where no sandbox reaches it. There everything that
 * is not a plain file or directory is removed (a link, a fifo, a socket; a sandbox could plant
 * memory/ -> ../../../agents to turn memory writes into config shards), and a file with more than
 * one name is replaced by a copy of its own, so no name a sandbox kept elsewhere reaches what the
 * gateway writes there later. Only then is the staging directory renamed into place. Where the
 * rename keeps failing (a handle held open on Windows, another device), the old directory is copied
 * instead, following no link, under a second name that becomes the staging directory only once the
 * copy is whole; a copy a crash cut short is thrown away and made again.
 *
 * A FAILURE CHANGES NOTHING. The old directory stays where it was, or its whole staged copy stays
 * where the next boot picks it up; no new directory is made for that account by this pass; an error
 * names the account and how to recover; and the marker is not written, so the next boot tries again.
 * That boot's stores do make the new directory when the account writes, so the next pass can find
 * both without the account's ACCOUNT_DONE: it then stages the old state as above and merges it in,
 * entry by entry, overwriting nothing; what both have stays in a conflicts directory beside it, and
 * is logged.
 *
 * ONE PASS AT A TIME. A standalone scene worker can boot beside the gateway; a lock file beside the
 * marker makes the second wait for the first, which it then finds done.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { childLogger } from "../logger.js";
import { PRODUCT } from "../product/index.js";
import { workspaceStateDir, workspaceStateRelocatedMarker } from "../tools/workspace-state.js";
import { USERS_SUBDIR } from "../tools/workspace-zones.js";
import { renameRetrying } from "./rename-retrying.js";

const log = childLogger("runtime:workspace-state-relocation");

/** In an account's new state directory: a pass handled this account. */
const ACCOUNT_DONE = ".relocated";
/** Beside the marker: a pass is running. */
const LOCK = ".relocating.lock";
/** A lock nobody has touched for this long belongs to a pass that died. */
const LOCK_STALE_MS = 10 * 60_000;

export interface WorkspaceStateRelocation {
  /** Segments whose old state moved, or was merged, into the new place. */
  moved: string[];
  /** Segments whose old place held something that is not a directory, which was not adopted. */
  kept: string[];
  /** Segments whose move failed; their old state is where it was, or staged. */
  failed: string[];
  /** Whether the move is complete for every account and the marker is written, now or before. */
  complete: boolean;
}

/** Moves `<sharedRoot>/users/<segment>/<stateDir>` to workspaceStateDir(`<sharedRoot>/users/<segment>`)
 *  for every account root, once (see above). Never throws: a failure is logged and retried next boot. */
export async function relocateAccountWorkspaceState(sharedRoot: string): Promise<WorkspaceStateRelocation> {
  const result: WorkspaceStateRelocation = { moved: [], kept: [], failed: [], complete: false };
  const marker = workspaceStateRelocatedMarker(sharedRoot);
  try {
    if (existsSync(marker)) return finished(sharedRoot, result);
    mkdirSync(dirname(marker), { recursive: true });
    const lock = join(dirname(marker), LOCK);
    await acquireLock(lock);
    try {
      // Another process completed the pass while this one waited for it.
      if (existsSync(marker)) return finished(sharedRoot, result);
      for (const { segment, root } of accountRoots(sharedRoot)) {
        try {
          const outcome = await relocateAccount(segment, root);
          if (outcome !== "nothing") result[outcome].push(segment);
        } catch (err) {
          result.failed.push(segment);
          const from = join(root, PRODUCT.stateDirName);
          const to = workspaceStateDir(root);
          log.error(
            { err, segment, from, to, staged: stagingPaths(to, segment).staging },
            "Moving an account's workspace state out of its root failed. Nothing of it was adopted or lost: it is still at "
              + "`from`, or whole at `staged`, and the next boot tries again; until then the account starts without it. "
              + "To recover, close whatever holds those directories open (an editor, an indexer, a virus scanner) and restart "
              + "the gateway, or, with the gateway stopped, move `from` (or `staged`) to `to` yourself.",
          );
        }
        touch(lock);
      }
      if (result.failed.length === 0) {
        writeFileSync(marker, `${new Date().toISOString()}\n`, "utf8");
        result.complete = true;
      }
    } finally {
      rmSync(lock, { force: true });
    }
  } catch (err) {
    log.error({ err, marker }, "The move of each account's workspace state out of its root could not run; the next boot tries again");
  }
  if (result.moved.length + result.kept.length + result.failed.length > 0) {
    log.info(
      { moved: result.moved.length, kept: result.kept.length, failed: result.failed.length, complete: result.complete },
      "Account workspace state moved out of the account roots",
    );
  }
  return result;
}

/** The move is complete: an old state directory still in an account's root is the account's own file. */
function finished(sharedRoot: string, result: WorkspaceStateRelocation): WorkspaceStateRelocation {
  for (const { segment, root } of accountRoots(sharedRoot)) {
    const old = join(root, PRODUCT.stateDirName);
    if (entryKind(old) !== "missing") {
      log.debug({ segment, path: old }, "A state directory in an account's root, after the move: a file of the account's workspace, not read");
    }
  }
  return { ...result, complete: true };
}

/** Each account's root under `<sharedRoot>/users`: a directory, not a link, that workspaceStateDir
 *  keeps no state in (users/.retired and a name that is no segment are not). */
function accountRoots(sharedRoot: string): Array<{ segment: string; root: string }> {
  const users = resolve(sharedRoot, USERS_SUBDIR);
  let entries;
  try {
    entries = readdirSync(users, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ segment: entry.name, root: join(users, entry.name) }))
    .filter(({ root }) => workspaceStateDir(root) !== resolve(root, PRODUCT.stateDirName));
}

function stagingPaths(to: string, segment: string): { staging: string; copying: string } {
  return { staging: join(dirname(to), `.${segment}.relocating`), copying: join(dirname(to), `.${segment}.copying`) };
}

/** One account, all or nothing: its old state staged, cleaned and moved into place, then marked. */
async function relocateAccount(segment: string, root: string): Promise<"moved" | "kept" | "nothing"> {
  const from = join(root, PRODUCT.stateDirName);
  const to = workspaceStateDir(root);
  const { staging, copying } = stagingPaths(to, segment);
  if (existsSync(join(to, ACCOUNT_DONE))) {
    // An earlier pass that did not complete for every account handled this one.
    if (entryKind(from) !== "missing") log.debug({ segment, path: from }, "A state directory in an account's root, after its move: not read");
    return "nothing";
  }
  mkdirSync(dirname(to), { recursive: true });
  // A copy a crash cut short. The old directory it came from is still whole.
  rmSync(copying, { recursive: true, force: true });

  let outcome: "moved" | "kept" | "nothing" = "nothing";
  if (entryKind(staging) === "missing") {
    const kind = entryKind(from);
    if (kind === "other") {
      // A link (a sandbox's; the gateway never made one there), a file, a fifo: not followed.
      log.warn({ segment, path: from }, "Workspace state left in an account's root: it is not a directory, and is not adopted");
      outcome = "kept";
    } else if (kind === "directory") {
      await stage(from, staging, copying);
    }
  } else if (entryKind(from) !== "missing") {
    log.debug({ segment, path: from }, "An earlier boot staged this account's state whole; what is at the old place now is not adopted");
  }

  if (entryKind(staging) === "directory") {
    const { removed, copied } = clean(staging);
    if (removed.length > 0) {
      log.warn({ segment, entries: removed.map((path) => relative(staging, path).replace(/\\/g, "/")) }, "Links, fifos and sockets in an account's moved workspace state were removed, not followed");
    }
    if (copied.length > 0) {
      log.warn({ segment, files: copied.map((path) => relative(staging, path).replace(/\\/g, "/")) }, "Files in an account's moved workspace state that had another name were replaced by copies of their own");
    }
    if (entryKind(to) === "missing") {
      await renameRetrying(staging, to);
    } else {
      await mergeStaged(segment, staging, to);
    }
    outcome = "moved";
  }
  mkdirSync(to, { recursive: true });
  writeFileSync(join(to, ACCOUNT_DONE), "", "utf8");
  return outcome;
}

/** The old directory, renamed to `staging`, or copied there where the rename keeps failing. */
async function stage(from: string, staging: string, copying: string): Promise<void> {
  try {
    await renameRetrying(from, staging);
    return;
  } catch (err) {
    log.warn({ err, path: from }, "Renaming an account's workspace state failed; it is copied instead");
  }
  try {
    copyFollowingNoLink(from, copying);
    await renameRetrying(copying, staging);
  } catch (err) {
    rmSync(copying, { recursive: true, force: true });
    throw err;
  }
  try {
    rmSync(from, { recursive: true, force: true });
  } catch (err) {
    log.warn({ err, path: from }, "The old copy of an account's workspace state could not be removed; it is not read again");
  }
}

/** Merges the staged old state into a new directory a failed boot's stores made: every entry the new
 *  one lacks moves in; what both have stays, in a conflicts directory beside them. */
async function mergeStaged(segment: string, staging: string, to: string): Promise<void> {
  const conflicts: string[] = [];
  const merge = async (src: string, dst: string): Promise<void> => {
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const from = join(src, entry.name);
      const into = join(dst, entry.name);
      const kind = entryKind(into);
      if (kind === "missing") await renameRetrying(from, into);
      else if (entry.isDirectory() && kind === "directory") await merge(from, into);
      else conflicts.push(relative(staging, from).replace(/\\/g, "/"));
    }
  };
  await merge(staging, to);
  if (conflicts.length === 0) {
    rmSync(staging, { recursive: true, force: true });
    log.warn({ segment, path: to }, "An account's old workspace state was merged into the state its account wrote while the move had failed");
    return;
  }
  const kept = join(dirname(to), `.${segment}.conflicts-${new Date().toISOString().replace(/[-:.]/g, "")}`);
  await renameRetrying(staging, kept);
  log.warn(
    { segment, path: to, conflicts: conflicts.slice(0, 20), conflictCount: conflicts.length, oldCopies: kept },
    "An account's old workspace state was merged into the state its account wrote while the move had failed; where both had "
      + "a file the newer one was kept, and the older one is in `oldCopies`",
  );
}

/** Removes everything under `dir` that is not a plain file or directory, following none, and gives a
 *  file with more than one name a copy of its own. */
function clean(dir: string, found: { removed: string[]; copied: string[] } = { removed: [], copied: [] }): { removed: string[]; copied: string[] } {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      clean(path, found);
    } else if (!stat.isFile()) {
      try {
        unlinkSync(path);
      } catch {
        // A junction on Windows is removed as a directory, without touching what it points to.
        rmSync(path, { force: true });
      }
      found.removed.push(path);
    } else if (stat.nlink > 1) {
      const copy = join(dir, `.${randomUUID()}.copy`);
      copyFileFollowingNoLink(path, copy);
      unlinkSync(path);
      renameSync(copy, path);
      found.copied.push(path);
    }
  }
  return found;
}

/** A copy of a directory tree that follows no link and copies only plain files and directories. */
function copyFollowingNoLink(from: string, to: string): void {
  mkdirSync(to);
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const stat = lstatSync(source);
    if (stat.isDirectory()) copyFollowingNoLink(source, join(to, entry.name));
    else if (stat.isFile()) copyFileFollowingNoLink(source, join(to, entry.name));
  }
}

/** A file's bytes into a new file, opened without following a link. */
function copyFileFollowingNoLink(from: string, to: string): void {
  const source = openSync(from, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(source).isFile()) return;
    const target = openSync(to, "wx");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      for (let position = 0; ; ) {
        const read = readSync(source, buffer, 0, buffer.length, position);
        if (read === 0) break;
        for (let written = 0; written < read; ) written += writeSync(target, buffer, written, read - written);
        position += read;
      }
    } finally {
      closeSync(target);
    }
  } finally {
    closeSync(source);
  }
}

function entryKind(path: string): "missing" | "directory" | "other" {
  try {
    return lstatSync(path).isDirectory() ? "directory" : "other";
  } catch {
    return "missing";
  }
}

/** Waits until this process holds the lock: a file made exclusively, which names its holder. One
 *  whose holder is gone (this host's process no longer runs, or nobody touched it for a while) is
 *  taken over. */
async function acquireLock(lock: string): Promise<void> {
  for (;;) {
    try {
      writeFileSync(lock, `${hostname()} ${process.pid}\n`, { encoding: "utf8", flag: "wx" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (lockIsStale(lock)) {
      log.warn({ lock }, "Taking over the lock of a move of account workspace state that is no longer running");
      rmSync(lock, { force: true });
      continue;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

function lockIsStale(lock: string): boolean {
  try {
    const [host, pid] = readFileSync(lock, "utf8").trim().split(" ");
    if (host === hostname()) {
      // This process's own pid: a run before a restart that kept it (pid 1 in a container).
      if (Number(pid) === process.pid) return true;
      try {
        process.kill(Number(pid), 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
      }
    }
    return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false; // gone between the two reads: the next attempt takes it
  }
}

function touch(path: string): void {
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // The lock is only a courtesy to a second process; the pass goes on.
  }
}
