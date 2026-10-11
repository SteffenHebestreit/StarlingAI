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
 * After the move the gateway never reads the old place again; a directory a sandbox creates there
 * later is just a file in the account's workspace.
 *
 * NOTHING IS MERGED. Where the new directory exists already (an earlier boot moved the state and a
 * directory turned up at the old place since, or an admin copied one), the old one is left as it
 * is and logged, every boot, until someone looks at it.
 *
 * NO LINK IS ADOPTED. Before this, a sandbox could write the old directory, so it can hold a
 * symbolic link a sandbox planted (memory/ -> ../../../agents would turn memory writes into config
 * shards). A link at the old place itself is not moved; links inside the moved tree are removed,
 * after the move, where no sandbox can reach them. The gateway never makes links in its state.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { childLogger } from "../logger.js";
import { PRODUCT } from "../product/index.js";
import { workspaceStateDir } from "../tools/workspace-state.js";
import { USERS_SUBDIR } from "../tools/workspace-zones.js";

const log = childLogger("runtime:workspace-state-relocation");

export interface WorkspaceStateRelocation {
  /** Segments whose state moved. */
  moved: string[];
  /** Segments whose old directory was left where it is: the new one exists, or it is not a directory. */
  kept: string[];
  /** Segments whose move failed; the old directory is where it was. */
  failed: string[];
}

/** Moves `<sharedRoot>/users/<segment>/<stateDir>` to workspaceStateDir(`<sharedRoot>/users/<segment>`)
 *  for every account root that has one. Idempotent. */
export function relocateAccountWorkspaceState(sharedRoot: string): WorkspaceStateRelocation {
  const result: WorkspaceStateRelocation = { moved: [], kept: [], failed: [] };
  const users = resolve(sharedRoot, USERS_SUBDIR);
  let names: string[];
  try {
    // A link under users/ is no account's root, and is not followed.
    names = readdirSync(users, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return result;
  }
  for (const name of names) {
    const root = join(users, name);
    const from = join(root, PRODUCT.stateDirName);
    const to = workspaceStateDir(root);
    // Not an account's root (users/.retired, a name that is no segment): its state stays where it is.
    if (to === resolve(from)) continue;
    let isDirectory: boolean;
    try {
      isDirectory = lstatSync(from).isDirectory();
    } catch {
      continue; // nothing to move
    }
    if (!isDirectory) {
      log.warn({ segment: name, path: from }, "Workspace state left in an account's root: it is not a directory, and is not adopted");
      result.kept.push(name);
      continue;
    }
    if (existsSync(to)) {
      log.warn({ segment: name, old: from, current: to }, "Workspace state left in an account's root: the account's state directory exists already, and nothing is merged");
      result.kept.push(name);
      continue;
    }
    try {
      mkdirSync(dirname(to), { recursive: true });
      moveDirectory(from, to);
    } catch (err) {
      // A standalone scene worker booting at the same time moved it first.
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && existsSync(to)) continue;
      log.error({ err, segment: name, from, to }, "Moving an account's workspace state out of its root failed; it stays where it was, and the account starts without it");
      result.failed.push(name);
      continue;
    }
    const links = removeLinks(to);
    if (links.length > 0) {
      log.warn({ segment: name, links: links.map((link) => relative(to, link).replace(/\\/g, "/")) }, "Links in an account's moved workspace state were removed, not followed");
    }
    result.moved.push(name);
  }
  if (result.moved.length + result.kept.length + result.failed.length > 0) {
    log.info({ moved: result.moved.length, kept: result.kept.length, failed: result.failed.length }, "Account workspace state moved out of the account roots");
  }
  return result;
}

/** A rename, or a copy and remove where the two places are on different devices. */
function moveDirectory(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    // Links are copied as they are, and removed with the others below.
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/** Removes every entry under `dir` that is not a plain file or directory (a link, a fifo, a socket),
 *  without following any. Returns their paths. */
function removeLinks(dir: string): string[] {
  const removed: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      removed.push(...removeLinks(path));
    } else if (!entry.isFile()) {
      try {
        unlinkSync(path);
      } catch {
        // A junction on Windows is removed as a directory, without touching what it points to.
        rmSync(path, { force: true });
      }
      removed.push(path);
    }
  }
  return removed;
}
