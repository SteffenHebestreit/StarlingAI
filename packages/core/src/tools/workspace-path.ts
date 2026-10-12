import { lstatSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { currentWorkspaceScope } from "../runtime/request-context.js";
import { segmentFor } from "../runtime/user-scope.js";
import { ACCOUNT_ID_RE, type Identity } from "../runtime/accounts.js";
import { GENERATED_SUBDIR, UPLOADS_SUBDIR, USERS_SUBDIR } from "./workspace-zones.js";
import { containedWorkspaceRealPath, type WorkspaceContainmentOptions } from "./workspace-containment.js";

// The zones and the config-shard rules live in a leaf module the config loader can import without
// a cycle (tools/workspace-zones.ts); they stay importable from here.
export {
  GENERATED_SUBDIR,
  UPLOADS_SUBDIR,
  SWARM_TOOLS_SUBDIR,
  NON_CONFIG_WORKSPACE_ZONES,
  NON_CONFIG_BASE_ZONES,
  isNonConfigShardDirectory,
  compareShardPaths,
} from "./workspace-zones.js";
// Where the gateway keeps its state for a root lives in a leaf module the outcomes ledger can import
// (tools/workspace-state.ts); it stays importable from here.
export { isAccountWorkspaceRoot, stripUserWorkspaceRoots, workspaceStateDir } from "./workspace-state.js";
// Where a path really leads through the links in the workspace: a leaf module the page-check worker
// can import (tools/workspace-containment.ts); it stays importable from here.
export {
  containedWorkspaceRealPath,
  type WorkspaceContainmentOptions,
  type WorkspaceRealPath,
} from "./workspace-containment.js";

/** True when a filesystem path exists (stat succeeds), false otherwise. */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shared overwrite guard for file-emitting tools. Returns a refusal MESSAGE when the
 * target already exists and `overwrite` is false, otherwise null. Replaces ~a dozen
 * copy-pasted `if (!overwrite) { try { await stat(p); return fail(...) } catch {} }`
 * blocks so the existence-check semantics live in one place. Call sites with a bespoke
 * message (e.g. "existing site at …/index.html") use pathExists() directly instead.
 */
export async function overwriteGuard(
  resolvedPath: string,
  relativePath: string,
  overwrite: boolean,
): Promise<string | null> {
  if (overwrite) return null;
  return (await pathExists(resolvedPath)) ? `Refusing to overwrite existing file: ${relativePath}` : null;
}

/**
 * THE WORKING ROOT FOR THE AMBIENT USER: `<shared>/users/<segment>`, or the shared root when
 * there is nobody to partition by (auth off, or an unattended run).
 *
 * This is the boundary the in-process partition could not be. A path resolver can refuse a
 * path; it cannot stop a sandboxed `shell_exec` from reading a sibling directory, because the
 * container is handed a mount, not a resolver. Giving each user their own ROOT makes the mount
 * itself the boundary: bind that directory and there is no sibling to reach, and `..` is
 * already refused by the workspace-escape check.
 *
 * CONFIG AND PLATFORM STATE STAY AT THE SHARED ROOT. The config zones (agents/, jobs/, scenes/,
 * tools/) describe the deployment, are authored through validated tools, and are swept by the
 * config loader — they are not one person's work. Same for the ledgers under the state dir. The
 * two maintenance agents that edit those zones run with workspaceAccess "full" and keep the
 * shared root; everyone else gets their own.
 *
 * IDEMPOTENT: a root that already is this user's comes back unchanged. A session persists the
 * root this returns and hands it back here on every restore (AgentSession.fromRecord), and a
 * workflow run passes the caller's root together with the caller's identity. Each pass nested it one
 * level deeper, <shared>/users/<seg>/users/<seg> after a single gateway restart, and nothing of
 * the user's (their memory, their files) is in there. The user's own segment is stripped first,
 * however often it repeats, so a session persisted with the extra levels comes back right too.
 */
export function userWorkspaceRoot(sharedRoot: string, who?: Identity): string {
  const segment = segmentFor(who);
  if (!segment) return sharedRoot;
  let root = resolve(sharedRoot);
  while (basename(root) === segment && basename(dirname(root)) === USERS_SUBDIR) root = dirname(dirname(root));
  return resolve(root, USERS_SUBDIR, segment);
}

/**
 * The DEPLOYMENT root behind any execution root — the inverse of the above.
 *
 * The ledgers that describe the deployment rather than a person (the agent outcomes ledger, the
 * promoted-agents catalog) live at the shared root, as the note above says. Code that holds only
 * its own execution root would otherwise read one account's slice of them and find nothing, which
 * is silent: an agent's lessons simply stop appearing. Callers that can reach config should just
 * use `getConfig().workspacePath`; this is for the ones that legitimately stay parameterized
 * because their other reads ARE per-user.
 *
 * Anything that is not a per-user root is returned unchanged.
 */
export function deploymentWorkspaceRoot(workspacePath: string): string {
  const parent = dirname(workspacePath);
  return basename(parent) === USERS_SUBDIR ? dirname(parent) : workspacePath;
}

/**
 * THE ARTIFACT ZONE IS ONE DIRECTORY SHARED BY EVERY TURN THE DEPLOYMENT HAS EVER RUN.
 *
 * That is fine for a single operator and wrong the moment two accounts use the same gateway:
 * one user's half-finished build is evidence to another user's resume detection, one user's
 * corrective-build gate fires on another user's broken page, and every artifact is readable by
 * anyone with a token. Durable user memory, the user-model and personality already partition
 * per account (runtime/user-scope.ts); this is the same rule applied to the working zone.
 *
 * Workspace-relative, because that is what every caller here deals in: `generated` when there
 * is no user to partition by — auth off, or an unattended run — and `generated/users/<segment>`
 * when there is. The segment comes from the same single rule as every other user-scoped store,
 * so a store and an artifact can never disagree about which bucket a user has.
 *
 * The TOP segment stays `generated` either way, which is what keeps the zone-membership tests
 * below (and the config loader's non-config-zone sweep) correct without knowing about any of
 * this.
 */
export function generatedZoneRel(): string {
  // Plain, always. The user segment lives in the ROOT now (userWorkspaceRoot above) — applying
  // it here as well would produce <root>/users/<seg>/generated/users/<seg>.
  return GENERATED_SUBDIR;
}

/** The absolute artifact zone for the ambient user. */
export function generatedZoneDir(workspacePath: string): string {
  return resolve(workspacePath, generatedZoneRel());
}


/**
 * Workspace zones a scope-confined ("generated") agent sees verbatim. Everything
 * else — the workspace root and the config zones (agents/, jobs/, scenes/,
 * tools/, runtime/) — is transparently re-rooted under generated/, mirroring the
 * write rooting, so working agents physically cannot wander into the platform's
 * own files (audit 0ac7d3fc: a builder burned 2.5 minutes reading the
 * workspace's README/ARCHITECTURE docs instead of building). Core agents with
 * workspaceAccess:"full" and runtime/gateway code paths are unaffected.
 */
const SCOPED_VISIBLE_ZONES: ReadonlySet<string> = new Set([GENERATED_SUBDIR, UPLOADS_SUBDIR]);

function stripVirtualWorkspacePrefix(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, "/").trim();
  if (normalized === "/workspace") return ".";
  if (normalized.startsWith("/workspace/")) {
    return normalized.slice("/workspace/".length);
  }
  return inputPath.trim();
}

/**
 * An absolute path that lies inside the root, taken as it is, or null. On the gateway that IS the
 * place it names, and toSandboxPath maps it to the same place in a sandbox. Checked before the
 * /workspace prefix is read as a sandbox's view of the root, because in a container the root itself
 * is under /workspace (/workspace/workspace/users/<segment>): the very path every sub-agent is told
 * and writes back was otherwise taken relative to the root, a directory of the same names inside it.
 */
function absolutePathInRoot(inputPath: string, workspacePath: string): string | null {
  const trimmed = inputPath.trim();
  if (!isAbsolute(trimmed)) return null;
  const rel = relative(workspacePath, resolve(trimmed));
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : trimmed;
}

/**
 * A RELATIVE PATH THAT REPEATS THE ROOT IT IS RELATIVE TO, taken relative to the root.
 *
 * Every sub-agent is told "Current workspace: <root>", the gateway's absolute path
 * (/workspace/workspace/users/<segment> in the compose deployment), and a model writing a relative
 * path often starts it with the tail of that root: `workspace/users/<segment>/report.html`, or
 * `users/<segment>/report.html`. As named, that is a directory of the same names INSIDE the root,
 * and the write zone put generated/ in front of it: the file landed at
 * generated/workspace/users/<segment>/report.html, a read of `report.html` found nothing, and the
 * agent wrote the whole file again (E2E, several runs; one turn wrote 9.5 KB twice, ~54 s each).
 *
 * So the leading segments that are a SUFFIX of the root's own path are dropped, as often as they
 * repeat, and so are those right after a leading generated/: that is the doubled form the zone
 * itself produced, and the path an earlier turn reported. A suffix ends at the root's LAST segment,
 * which is what keeps this to the root: `users/alice/x` under the shared root names its real users/
 * zone, and `workspace/x` under an account's root only shares an earlier segment; both stay as
 * named.
 *
 * ONE SEGMENT IS ENOUGH ONLY FOR AN ACCOUNT'S ROOT. Its last segment is an account id
 * (`<slug>-<16 hex>`, ACCOUNT_ID_RE), a name nothing else in the root has. Any other root ends in a
 * plain name, `workspace` for the shared root, and that alone is an ordinary directory or file
 * there: `workspace/index.html` next to `index.html`, a Bazel `WORKSPACE`. Such a root needs two
 * segments of its own path, `workspace/workspace/` or `StarlingAI/workspace/`, before any is dropped.
 *
 * IN ANY CASE. A name the root has in another case is the root on Windows, on macOS and through a
 * Docker Desktop bind, where the gateway itself runs on Linux, so the platform cannot tell; on a
 * case-sensitive filesystem it is a directory nobody makes inside the root on purpose.
 *
 * What remains is the end of the path as named, normalized and without `..`, so it reaches nothing
 * the path did not. A path with nothing to drop comes back unchanged. Absolute paths do not come
 * here: one inside the root is taken as it is (absolutePathInRoot). And the resolvers drop nothing
 * from a name that is on disk as named (resolvedAsOnDisk).
 */
export function withoutRepeatedWorkspaceRoot(relativePath: string, workspacePath: string): string {
  const root = rootSegments(workspacePath);
  const normalized = posix.normalize(relativePath.replace(/\\/g, "/"));
  if (root.segments.length === 0 || normalized === ".." || normalized.startsWith("../")) return relativePath;
  const named = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  let rest = withoutRootSuffixes(named, root);
  // However they nest: generated/users/<segment>/generated/x is generated/x too.
  while (rest[0] === GENERATED_SUBDIR) {
    const inZone = withoutRootSuffixes(rest.slice(1), root);
    if (inZone.length === rest.length - 1) break;
    rest = inZone[0] === GENERATED_SUBDIR ? inZone : [GENERATED_SUBDIR, ...inZone];
  }
  if (rest.length === named.length) return relativePath;
  return rest.length === 0 ? "." : rest.join("/");
}

/** A root's own segments, lowercased and without a drive, and how many of them a match needs. */
interface RootSegments {
  segments: string[];
  shortest: number;
}

/** Split at either separator, so a Windows root splits the same on every platform. */
function rootSegments(workspacePath: string): RootSegments {
  const segments = workspacePath.split(/[\\/]+/).filter((segment) => segment !== "");
  if (/^[a-zA-Z]:$/.test(segments[0] ?? "")) segments.shift();
  const shortest = ACCOUNT_ID_RE.test(segments.at(-1) ?? "") ? 1 : 2;
  return { segments: segments.map((segment) => segment.toLowerCase()), shortest };
}

/** `segments` without the leading ones that are a suffix of the root's, as often as one leads. */
function withoutRootSuffixes(segments: string[], root: RootSegments): string[] {
  let rest = segments;
  for (let length = rootSuffixLength(rest, root); length > 0; length = rootSuffixLength(rest, root)) {
    rest = rest.slice(length);
  }
  return rest;
}

/** How many of the leading `segments` are the root's last as many, longest first; 0 for none. */
function rootSuffixLength(segments: string[], root: RootSegments): number {
  for (let length = Math.min(segments.length, root.segments.length); length >= root.shortest; length--) {
    const suffix = root.segments.slice(root.segments.length - length);
    if (suffix.every((segment, i) => segments[i]?.toLowerCase() === segment)) return length;
  }
  return 0;
}

/**
 * A NAME THAT IS ON DISK IS THAT FILE. A path is resolved as named, and with a repeated root
 * dropped only where nothing is there as named: the zone re-root applied, a link not followed.
 *
 * Dropping it regardless made a file tool act on another file than the one named. Files that turns
 * before the rule left under a repeated root are still there (generated/users/<segment>/old.html),
 * list_files shows them under that name, and read_file, edit_file and delete_file on it reached
 * generated/old.html instead: an approved delete removed a file nobody named and kept the stale one
 * (review 2026-10-12). A name that is not there yet is what the rule is for, so a new file still
 * lands where the plain name goes, and a later read of either name finds it there.
 */
function resolvedAsOnDisk(
  resolveAs: (asNamedOnDisk: boolean) => { resolved: string; relativePath: string },
  asNamedOnDisk: boolean | undefined,
): { resolved: string; relativePath: string } {
  const named = resolveAs(true);
  if (asNamedOnDisk) return named;
  const dropped = resolveAs(false);
  return dropped.resolved === named.resolved || isOnDisk(named.resolved) ? named : dropped;
}

/** lstat: a link at the name is there, wherever it leads; the resolvers' containment check judges that. */
function isOnDisk(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the resolvers below take besides the path: how a link on the way is held
 * (WorkspaceContainmentOptions), and whether the path is a name as it is on disk.
 */
export interface WorkspacePathOptions extends WorkspaceContainmentOptions {
  /**
   * A name the gateway listed or recorded itself and is handed back, taken as it is, with no
   * repeated root dropped (withoutRepeatedWorkspaceRoot) even where nothing is there yet. The
   * workspace routes serve and delete by the names their listing and the artifact records carry.
   */
  asNamedOnDisk?: boolean;
}

function assertContained(resolvedPath: string, workspacePath: string, options: WorkspaceContainmentOptions | undefined): void {
  if (!containedWorkspaceRealPath(resolvedPath, workspacePath, options)) throw new Error("Path escapes workspace boundary");
}

/**
 * A workspace path as named: the boundary check of resolvePathWithinWorkspace without its zone
 * re-root. For the one caller that needs what a sandbox sees: a container is handed the whole
 * working root at /workspace, whatever the agent's zone, so a script a scope-confined agent's shell
 * left at the root is there and nowhere under generated/. A repeated root is dropped here as well,
 * unless `asNamedOnDisk`: the sandbox has the root at /workspace, not inside itself.
 *
 * Each resolver here also holds the path to its zone through any link (containedWorkspaceRealPath).
 */
export function resolveLiteralWorkspacePath(
  inputPath: string,
  workspacePath: string,
  options?: WorkspacePathOptions,
): { resolved: string; relativePath: string } {
  const literal = resolvedAsOnDisk(
    (asNamed) => lexicalLiteralWorkspacePath(inputPath, workspacePath, asNamed),
    options?.asNamedOnDisk,
  );
  assertContained(literal.resolved, workspacePath, options);
  return literal;
}

function lexicalLiteralWorkspacePath(
  inputPath: string,
  workspacePath: string,
  asNamedOnDisk = false,
): { resolved: string; relativePath: string } {
  const candidatePath = absolutePathInRoot(inputPath, workspacePath) ?? stripVirtualWorkspacePrefix(inputPath);
  const named = candidatePath.replace(/^\//, "");
  const resolvedPath = isAbsolute(candidatePath)
    ? resolve(candidatePath)
    : resolve(workspacePath, asNamedOnDisk ? named : withoutRepeatedWorkspaceRoot(named, resolve(workspacePath)));
  const rel = relative(workspacePath, resolvedPath);
  if (rel.startsWith("..") || rel === "..") {
    throw new Error("Path escapes workspace boundary");
  }
  return { resolved: resolvedPath, relativePath: rel === "" ? "." : rel.replace(/\\/g, "/") };
}

export function resolvePathWithinWorkspace(
  inputPath: string,
  workspacePath: string,
  options?: WorkspacePathOptions,
): { resolved: string; relativePath: string } {
  const within = resolvedAsOnDisk(
    (asNamed) => lexicalPathWithinWorkspace(inputPath, workspacePath, asNamed),
    options?.asNamedOnDisk,
  );
  assertContained(within.resolved, workspacePath, options);
  return within;
}

function lexicalPathWithinWorkspace(
  inputPath: string,
  workspacePath: string,
  asNamedOnDisk = false,
): { resolved: string; relativePath: string } {
  const literal = lexicalLiteralWorkspacePath(inputPath, workspacePath, asNamedOnDisk);
  const relativePath = literal.relativePath;

  // Zone enforcement for scope-confined executions (set per-agent via
  // ToolContext.workspaceScope → AsyncLocalStorage). Re-rooting (instead of
  // denying) keeps read-after-write consistent: write_file("index.html") lands
  // in generated/index.html, and a later read_file("index.html") under the same
  // scope resolves to that same file.
  if (currentWorkspaceScope() === "generated") {
    const topSegment = relativePath === "." ? "" : (relativePath.split("/")[0] ?? "");
    if (!SCOPED_VISIBLE_ZONES.has(topSegment)) {
      const scopedRel = relativePath === "." ? GENERATED_SUBDIR : `${GENERATED_SUBDIR}/${relativePath}`;
      return { resolved: resolve(workspacePath, scopedRel), relativePath: scopedRel };
    }
  }

  return literal;
}

/**
 * Resolve a WRITE target, rooting agent-generated files under the workspace's
 * `generated/` subfolder. Reads stay workspace-wide via
 * resolvePathWithinWorkspace; only mutating file/artifact tools use this.
 *
 * Idempotent: a path already inside `generated/` is left where it is, so an
 * agent can write `index.html` (→ generated/index.html) and later edit either
 * `index.html` or `generated/index.html` and hit the same file. The returned
 * relativePath stays rooted at the workspace (e.g. "generated/index.html") so
 * artifact previews and the file-serving endpoint resolve correctly. So is a
 * path that repeats the root, `users/<segment>/index.html`, and the
 * `generated/users/<segment>/index.html` this rooting made of it before,
 * unless a file is there under that name (withoutRepeatedWorkspaceRoot,
 * resolvedAsOnDisk).
 *
 * Core agents running with workspaceScope:"full" write WITHOUT the generated/
 * rooting — they maintain the workspace itself (config shards, docs), so their
 * write target is taken literally. Everything else (scoped agents AND runtime
 * internals with no scope set) keeps the rooting.
 */
export function resolveWorkspaceWritePath(
  inputPath: string,
  workspacePath: string,
  options?: WorkspacePathOptions,
): { resolved: string; relativePath: string } {
  const target = resolvedAsOnDisk(
    (asNamed) => lexicalWorkspaceWritePath(inputPath, workspacePath, asNamed),
    options?.asNamedOnDisk,
  );
  assertContained(target.resolved, workspacePath, options);
  return target;
}

function lexicalWorkspaceWritePath(
  inputPath: string,
  workspacePath: string,
  asNamedOnDisk = false,
): { resolved: string; relativePath: string } {
  const within = lexicalPathWithinWorkspace(inputPath, workspacePath, asNamedOnDisk);
  if (currentWorkspaceScope() === "full") {
    return within;
  }
  // `within` has already been partitioned by the resolver above, so a path under the zone is
  // this user's by construction — a path naming another user's partition threw before reaching
  // here rather than being silently accepted as an already-rooted write.
  if (within.relativePath === GENERATED_SUBDIR || within.relativePath.startsWith(`${GENERATED_SUBDIR}/`)) {
    return within;
  }
  const zoneRel = generatedZoneRel();
  const rel = within.relativePath === "." ? zoneRel : `${zoneRel}/${within.relativePath}`;
  return { resolved: resolve(workspacePath, rel), relativePath: rel };
}
