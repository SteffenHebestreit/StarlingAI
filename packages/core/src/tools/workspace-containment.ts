/**
 * Where a workspace path really leads through the links in the workspace.
 *
 * A leaf module (it imports only the zones): the page-check worker, which must not import the
 * config, holds the scripts a page names to the page's directory with it. tools/workspace-path.ts
 * re-exports it, and its resolvers apply it to every path they resolve.
 */
import { lstatSync, realpathSync } from "node:fs";
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
 * The nearest part of the path that exists is resolved, the last component too unless `final` is
 * "link"; what does not exist yet cannot be a link. A link that leads nowhere is refused: a write
 * through it creates its target, wherever that is. A workspace root that does not exist has nothing
 * on disk to follow.
 *
 * Checked when the path is resolved, not when it is opened: a sandbox running at the same moment can
 * still swap a directory for a link in between.
 */
export function containedWorkspaceRealPath(
  resolvedPath: string,
  workspacePath: string,
  options: WorkspaceContainmentOptions = {},
): WorkspaceRealPath | null {
  const root = resolve(workspacePath);
  const target = resolve(resolvedPath);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { real: target, root };
  }
  // An account's directory under the shared root is a zone of its own: a link one account's sandbox
  // made must not lead a path through the shared root into another account's.
  const segments = rel === "" ? [] : rel.split(sep);
  const zone = join(realRoot, ...segments.slice(0, segments[0] === USERS_SUBDIR ? 2 : 1));

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

function isWithin(path: string, dir: string): boolean {
  const [p, d] = process.platform === "win32" ? [path.toLowerCase(), dir.toLowerCase()] : [path, dir];
  return p === d || p.startsWith(d.endsWith(sep) ? d : `${d}${sep}`);
}
