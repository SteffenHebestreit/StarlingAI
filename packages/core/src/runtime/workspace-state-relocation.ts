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
 * entry by entry, overwriting nothing. An append-only ledger both have (`*.ndjson`, `*.jsonl`) is
 * joined, the older lines first; what else both have stays in a conflicts directory beside it, and
 * is logged.
 *
 * ONE PASS AT A TIME. A standalone scene worker can boot beside the gateway; a lock file beside the
 * marker makes the second wait for the first, which it then finds done. The waiting process says so,
 * once and then every LOCK_WAIT_LOG_MS. The holder touches the lock as it works, entry by entry and
 * chunk by chunk of a copy, so a long copy does not look like a pass that died, and removes the lock
 * at the end only while it still names this pass (host, pid and a token of its own): a lock another
 * process took over stays that process's.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
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
/** The holder touches its lock at most this often while it works. */
const LOCK_TOUCH_MS = 1_000;
/** Another host's lock, untouched since before this process started, is dead once untouched this long. */
const LOCK_FOREIGN_GRACE_MS = 30_000;
/** A process waiting for the lock says so again this often. */
const LOCK_WAIT_LOG_MS = 30_000;
/** When this process started. */
const PROCESS_STARTED_MS = Date.now() - process.uptime() * 1000;

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
    const lock = await acquireLock(join(dirname(marker), LOCK));
    try {
      // Another process completed the pass while this one waited for it.
      if (existsSync(marker)) return finished(sharedRoot, result);
      for (const { segment, root } of accountRoots(sharedRoot)) {
        try {
          const outcome = await relocateAccount(segment, root, lock.beat);
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
        lock.beat();
      }
      if (result.failed.length === 0) {
        writeFileSync(marker, `${new Date().toISOString()}\n`, "utf8");
        result.complete = true;
      }
    } finally {
      releaseLock(lock);
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
  let roots: Array<{ segment: string; root: string }> = [];
  try {
    roots = accountRoots(sharedRoot);
  } catch (err) {
    // Only the debug lines below need the list; the marker already says the move is complete.
    log.debug({ err }, "The account roots could not be listed after the move; nothing is read from them");
  }
  for (const { segment, root } of roots) {
    const old = join(root, PRODUCT.stateDirName);
    if (entryKind(old) !== "missing") {
      log.debug({ segment, path: old }, "A state directory in an account's root, after the move: a file of the account's workspace, not read");
    }
  }
  return { ...result, complete: true };
}

/** Each account's root under `<sharedRoot>/users`: a directory, not a link, that workspaceStateDir
 *  keeps no state in (users/.retired and a name that is no segment are not). None when there is no
 *  users/ yet. Any other error listing it throws: an empty list taken from a users/ that could not be
 *  read completed the pass and wrote the marker with every account's old state still in its root,
 *  never to be moved (review 2026-10-12). */
function accountRoots(sharedRoot: string): Array<{ segment: string; root: string }> {
  const users = resolve(sharedRoot, USERS_SUBDIR);
  let entries;
  try {
    entries = readdirSync(users, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ segment: entry.name, root: join(users, entry.name) }))
    .filter(({ root }) => workspaceStateDir(root) !== resolve(root, PRODUCT.stateDirName));
}

function stagingPaths(to: string, segment: string): { staging: string; copying: string } {
  return { staging: join(dirname(to), `.${segment}.relocating`), copying: join(dirname(to), `.${segment}.copying`) };
}

/** One account, all or nothing: its old state staged, cleaned and moved into place, then marked.
 *  `beat` keeps the lock touched while it works. */
async function relocateAccount(segment: string, root: string, beat: () => void): Promise<"moved" | "kept" | "nothing"> {
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
      await stage(from, staging, copying, beat);
    }
  } else if (entryKind(from) !== "missing") {
    log.debug({ segment, path: from }, "An earlier boot staged this account's state whole; what is at the old place now is not adopted");
  }

  if (entryKind(staging) === "directory") {
    const { removed, copied } = clean(staging, beat);
    if (removed.length > 0) {
      log.warn({ segment, entries: removed.map((path) => relative(staging, path).replace(/\\/g, "/")) }, "Links, fifos and sockets in an account's moved workspace state were removed, not followed");
    }
    if (copied.length > 0) {
      log.warn({ segment, files: copied.map((path) => relative(staging, path).replace(/\\/g, "/")) }, "Files in an account's moved workspace state that had another name were replaced by copies of their own");
    }
    if (entryKind(to) === "missing") {
      await renameRetrying(staging, to);
    } else {
      await mergeStaged(segment, staging, to, beat);
    }
    outcome = "moved";
  }
  mkdirSync(to, { recursive: true });
  writeFileSync(join(to, ACCOUNT_DONE), "", "utf8");
  return outcome;
}

/** The old directory, renamed to `staging`, or copied there where the rename keeps failing. */
async function stage(from: string, staging: string, copying: string, beat: () => void): Promise<void> {
  try {
    await renameRetrying(from, staging);
    return;
  } catch (err) {
    log.warn({ err, path: from }, "Renaming an account's workspace state failed; it is copied instead");
  }
  try {
    copyFollowingNoLink(from, copying, beat);
    await renameRetrying(copying, staging);
  } catch (err) {
    rmSync(copying, { recursive: true, force: true });
    throw err;
  }
  try {
    beat();
    rmSync(from, { recursive: true, force: true });
  } catch (err) {
    log.warn({ err, path: from }, "The old copy of an account's workspace state could not be removed; it is not read again");
  }
}

/** Merges the staged old state into a new directory a failed boot's stores made: every entry the new
 *  one lacks moves in; an append-only ledger both have is joined (joinLedger); anything else both
 *  have stays, in a conflicts directory beside them. */
async function mergeStaged(segment: string, staging: string, to: string, beat: () => void): Promise<void> {
  const conflicts: string[] = [];
  const joined: string[] = [];
  const merge = async (src: string, dst: string): Promise<void> => {
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      beat();
      const from = join(src, entry.name);
      const into = join(dst, entry.name);
      const kind = entryKind(into);
      if (kind === "missing") await renameRetrying(from, into);
      else if (entry.isDirectory() && kind === "directory") await merge(from, into);
      else if (entry.isFile() && LEDGER.test(entry.name) && lstatSync(into).isFile()) {
        await joinLedger(from, into);
        joined.push(relative(staging, from).replace(/\\/g, "/"));
      } else conflicts.push(relative(staging, from).replace(/\\/g, "/"));
    }
  };
  await merge(staging, to);
  if (conflicts.length === 0) {
    rmSync(staging, { recursive: true, force: true });
    log.warn({ segment, path: to, joined }, "An account's old workspace state was merged into the state its account wrote while the move had failed");
    return;
  }
  const kept = join(dirname(to), `.${segment}.conflicts-${new Date().toISOString().replace(/[-:.]/g, "")}`);
  await renameRetrying(staging, kept);
  log.warn(
    { segment, path: to, joined, conflicts: conflicts.slice(0, 20), conflictCount: conflicts.length, oldCopies: kept },
    "An account's old workspace state was merged into the state its account wrote while the move had failed; ledgers both had "
      + "were joined, and where both had another file the newer one was kept, and the older one is in `oldCopies`",
  );
}

/** An append-only ledger of one record per line (flow_memory.ndjson, agent_outcomes.ndjson, the
 *  trajectory cache): two of them joined are one ledger in the same format. Moving the older one
 *  aside, as any other file both sides have, dropped its history out of what the stores read. */
const LEDGER = /\.(ndjson|jsonl)$/i;

/** The older ledger's lines, then the live one's, into the live ledger. The two are written whole
 *  to a file of their own beside the older one (an OWN_COPY name, which the next pass removes if
 *  this one stops before the rename), synced, and renamed over the live ledger, so a crash leaves
 *  either ledger whole. Only then is the older one removed. A live ledger that already starts with
 *  the older one is from a pass that stopped after the rename: it is not joined twice. */
async function joinLedger(older: string, live: string): Promise<void> {
  const before = readFileSync(older);
  const after = readFileSync(live);
  if (!(after.length >= before.length && after.subarray(0, before.length).equals(before))) {
    // A last line a crash cut short still ends before the first line of the live ledger.
    const separator = before.length > 0 && before[before.length - 1] !== 0x0a ? Buffer.from("\n") : Buffer.alloc(0);
    const both = join(dirname(older), `.${randomUUID()}.copy`);
    const fd = openSync(both, "wx");
    try {
      for (const part of [before, separator, after]) {
        for (let written = 0; written < part.length; ) written += writeSync(fd, part, written, part.length - written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      await renameRetrying(both, live);
    } catch (err) {
      rmSync(both, { force: true });
      throw err;
    }
  }
  rmSync(older, { force: true });
}

/** The name a file this pass writes in the staging directory has until it is renamed into place: a
 *  file's own copy (clean), or two ledgers joined (joinLedger). */
const OWN_COPY = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.copy$/;

/** Removes everything under `dir` that is not a plain file or directory, following none, and gives a
 *  file with more than one name a copy of its own. */
function clean(dir: string, beat: () => void, found: { removed: string[]; copied: string[] } = { removed: [], copied: [] }): { removed: string[]; copied: string[] } {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    beat();
    const path = join(dir, entry.name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      clean(path, beat, found);
    } else if (!stat.isFile()) {
      try {
        unlinkSync(path);
      } catch {
        // A junction on Windows is removed as a directory, without touching what it points to.
        rmSync(path, { force: true });
      }
      found.removed.push(path);
    } else if (OWN_COPY.test(entry.name)) {
      // A copy an earlier pass made and was cut short before renaming: the file it was made for is
      // still whole beside it, and is copied again below if it still needs it.
      rmSync(path, { force: true });
    } else if (stat.nlink > 1) {
      // The rename replaces the file in one step. Unlinking it first left a moment in which only the
      // copy existed, and a crash there lost the file under its own name.
      const copy = join(dir, `.${randomUUID()}.copy`);
      copyFileFollowingNoLink(path, copy, beat);
      renameSync(copy, path);
      found.copied.push(path);
    }
  }
  return found;
}

/** A copy of a directory tree that follows no link and copies only plain files and directories. */
function copyFollowingNoLink(from: string, to: string, beat: () => void): void {
  mkdirSync(to);
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    beat();
    const source = join(from, entry.name);
    const stat = lstatSync(source);
    if (stat.isDirectory()) copyFollowingNoLink(source, join(to, entry.name), beat);
    else if (stat.isFile()) copyFileFollowingNoLink(source, join(to, entry.name), beat);
  }
}

/** A file's bytes into a new file, opened without following a link. Throws when what is open is not a
 *  plain file (swapped since it was listed): returning without a copy left the caller to go on as
 *  though it had one, so a tree copy finished without the file and the old tree was then removed. */
function copyFileFollowingNoLink(from: string, to: string, beat: () => void): void {
  const source = openSync(from, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(source).isFile()) throw new Error(`Not a plain file, not copied: ${from}`);
    const target = openSync(to, "wx");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      for (let position = 0; ; ) {
        beat();
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

/** The lock this process holds: its file, what this process wrote there, and a touch of it that
 *  does nothing until LOCK_TOUCH_MS have passed since the last. */
interface HeldLock {
  path: string;
  content: string;
  beat: () => void;
}

/** Waits until this process holds the lock: a file made exclusively, which names its holder (host,
 *  pid and a token of this pass's own). One whose holder is gone is taken over (lockIsStale). */
async function acquireLock(path: string): Promise<HeldLock> {
  const content = `${hostname()} ${process.pid} ${randomUUID()}\n`;
  let waitingSince: number | undefined;
  let saidAt = 0;
  for (;;) {
    try {
      writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
      if (waitingSince !== undefined) log.info({ lock: path, waitedMs: Date.now() - waitingSince }, "Took the lock of the move of account workspace state");
      return { path, content, beat: throttledTouch(path) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const stale = lockIsStale(path);
    if (stale !== null) {
      // Removed only while it is still the lock found stale: another waiter may have taken it over first.
      if (readLock(path) === stale) {
        log.warn({ lock: path, holder: holderOf(stale) }, "Taking over the lock of a move of account workspace state that is no longer running");
        rmSync(path, { force: true });
      }
      continue;
    }
    // A boot that waits here says why, then again while it keeps waiting, so a stuck boot is explained.
    const now = Date.now();
    if (waitingSince === undefined) {
      waitingSince = now;
      saidAt = now;
      log.info({ lock: path, holder: holderOf(readLock(path)) }, "Waiting for another process's move of account workspace state to finish");
    } else if (now - saidAt >= LOCK_WAIT_LOG_MS) {
      saidAt = now;
      log.warn(
        { lock: path, holder: holderOf(readLock(path)), waitedMs: now - waitingSince },
        "Still waiting for another process's move of account workspace state to finish. A lock its holder stops touching is "
          + "taken over: after 10 minutes, or after 30 seconds for one another host left before this process started",
      );
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** Removes the lock while it still names this pass. A process that judged this pass dead and took the
 *  lock over holds it now; removing it would let a third process run beside that one. */
function releaseLock(lock: HeldLock): void {
  const current = readLock(lock.path);
  if (current === null) return;
  if (current !== lock.content) {
    log.warn({ lock: lock.path, holder: holderOf(current) }, "Another process took over the lock of this move of account workspace state while it ran; the lock is left to it");
    return;
  }
  rmSync(lock.path, { force: true });
}

/** The lock's content when it is stale, null when not. Stale: this host's process that wrote it no
 *  longer runs; another host's was left before this process started and nobody has touched it since
 *  (a container restart changes the hostname, so neither the host nor the pid says anything then);
 *  or nobody touched it for LOCK_STALE_MS. */
function lockIsStale(lock: string): string | null {
  try {
    const content = readFileSync(lock, "utf8");
    const [host, pid] = content.trim().split(" ");
    const touchedAt = statSync(lock).mtimeMs;
    if (host === hostname()) {
      // This process's own pid: a run before a restart that kept it (pid 1 in a container).
      if (Number(pid) === process.pid) return content;
      try {
        process.kill(Number(pid), 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return content;
      }
    } else if (touchedAt < PROCESS_STARTED_MS && Date.now() - touchedAt > LOCK_FOREIGN_GRACE_MS) {
      // A live holder touches its lock at least every LOCK_TOUCH_MS while it works. One that began
      // before this process did can be between touches when this process looks, busy with a single
      // long step (a rename, removing a large tree); the grace covers that.
      return content;
    }
    return Date.now() - touchedAt > LOCK_STALE_MS ? content : null;
  } catch {
    return null; // gone between the two reads: the next attempt takes it
  }
}

function readLock(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The host and pid a lock names, for a log line; not its token. */
function holderOf(content: string | null): string | undefined {
  return content?.trim().split(" ").slice(0, 2).join(" ");
}

/** A touch of `path` that does nothing until LOCK_TOUCH_MS have passed since the last one. */
function throttledTouch(path: string): () => void {
  let touchedAt = Date.now();
  return () => {
    const now = Date.now();
    if (now - touchedAt < LOCK_TOUCH_MS) return;
    touchedAt = now;
    touch(path);
  };
}

function touch(path: string): void {
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    // The lock is only a courtesy to a second process; the pass goes on.
  }
}
