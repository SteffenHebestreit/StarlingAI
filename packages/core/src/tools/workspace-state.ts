/**
 * Where the gateway keeps its state for a working root.
 *
 * A leaf module (it imports only other leaves: the product identity, the account ids and the
 * zones): the agent outcomes ledger is a leaf the session and the warden import, and importing the
 * per-user scope, and through it the config, from there hung a test that imports both at once.
 * tools/workspace-path.ts re-exports both functions.
 */
import { basename, dirname, posix, resolve } from "node:path";
import { PRODUCT } from "../product/index.js";
import { ACCOUNT_ID_RE } from "../runtime/accounts.js";
import { USERS_SUBDIR } from "./workspace-zones.js";

/**
 * A root with every per-user level taken off its end: `<x>/users/<segment>` becomes `<x>`, however
 * often it repeats and whichever segment it names. A restored account session's root is rebuilt
 * from this and the account's own segment (agent/session.ts), so a root stored under the
 * username's old segment, or nested by an earlier restore, does not nest again.
 */
export function stripUserWorkspaceRoots(root: string): string {
  let stripped = resolve(root);
  while (basename(dirname(stripped)) === USERS_SUBDIR && ACCOUNT_ID_RE.test(basename(stripped))) {
    stripped = dirname(dirname(stripped));
  }
  return stripped;
}

/**
 * WHERE THE GATEWAY KEEPS ITS STATE FOR A WORKING ROOT: `<root>/<stateDir>`, except for an account's
 * own root, whose state is kept under the deployment's state directory instead:
 * `<shared>/<stateDir>/users/<segment>`.
 *
 * An account's root is exactly what that account's sandboxes are handed, read-write, and since they
 * run as the owner of that directory they can write anything in it. The gateway read its state for
 * that account from inside it (workspace-scope durable memory, skills, the trajectory cache and the
 * rest), behind a read-only tmpfs over `<root>/.starlingai`. A mask placed by path does not hold on a
 * case-insensitive bind (Docker Desktop on Windows and macOS): `/workspace/.STARLINGAI/memory/x.json`
 * went past the tmpfs and wrote the real directory, and the owner could also rename the directory
 * and create it again (review 2026-10-11). Kept outside the root, the state is simply not in the
 * mount, which is the boundary.
 *
 * `users/<segment>` under the state directory, the same shape as every other per-user base: the
 * account migration moves, archives and purges it with the account's other directories, and the
 * memory graph reads the tenant of a workspace record from its storage directory's `users/<segment>`.
 *
 * Every other root comes back as `<root>/<stateDir>`, as before: the shared root (auth off, the
 * maintenance agents, the deployment's own ledgers), and any directory that is not an account's root.
 * An account's root is one userWorkspaceRoot produces: a segment directly under `users/`. A nested
 * root is stripped to the deployment root first, so the state never lands inside another root.
 */
export function workspaceStateDir(workspacePath: string): string {
  const root = resolve(workspacePath);
  if (isAccountWorkspaceRoot(root)) {
    return resolve(stripUserWorkspaceRoots(root), PRODUCT.stateDirName, USERS_SUBDIR, basename(root));
  }
  return resolve(root, PRODUCT.stateDirName);
}

/**
 * The marker the boot's one-time move of each account's workspace state out of its root writes once
 * that move is complete for every account (runtime/workspace-state-relocation.ts):
 * `<shared>/<stateDir>/users/.relocated-v1`. Once it exists, an old state directory in an account's
 * root is a file of that account's workspace, never the gateway's.
 */
export function workspaceStateRelocatedMarker(sharedRoot: string): string {
  return resolve(sharedRoot, PRODUCT.stateDirName, USERS_SUBDIR, ".relocated-v1");
}

/** Whether a root is an account's own, which workspaceStateDir keeps no state in: a segment
 *  directly under `users/`, as userWorkspaceRoot makes it. Either separator, resolved or not. */
export function isAccountWorkspaceRoot(workspacePath: string): boolean {
  const root = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  return posix.basename(posix.dirname(root)) === USERS_SUBDIR && ACCOUNT_ID_RE.test(posix.basename(root));
}
