import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { currentWorkspaceScope } from "../runtime/request-context.js";
import { segmentFor } from "../runtime/user-scope.js";
import type { Identity } from "../runtime/accounts.js";
import { GENERATED_SUBDIR, UPLOADS_SUBDIR, USERS_SUBDIR } from "./workspace-zones.js";

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
 * A workspace path exactly as named: the boundary check of resolvePathWithinWorkspace without its
 * zone re-root. For the one caller that needs what a sandbox sees: a container is handed the whole
 * working root at /workspace, whatever the agent's zone, so a script a scope-confined agent's shell
 * left at the root is there and nowhere under generated/.
 */
export function resolveLiteralWorkspacePath(inputPath: string, workspacePath: string): { resolved: string; relativePath: string } {
  const candidatePath = stripVirtualWorkspacePrefix(inputPath);
  const resolvedPath = isAbsolute(candidatePath)
    ? resolve(candidatePath)
    : resolve(workspacePath, candidatePath.replace(/^\//, ""));
  const rel = relative(workspacePath, resolvedPath);
  if (rel.startsWith("..") || rel === "..") {
    throw new Error("Path escapes workspace boundary");
  }
  return { resolved: resolvedPath, relativePath: rel === "" ? "." : rel.replace(/\\/g, "/") };
}

export function resolvePathWithinWorkspace(inputPath: string, workspacePath: string): { resolved: string; relativePath: string } {
  const literal = resolveLiteralWorkspacePath(inputPath, workspacePath);
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
 * artifact previews and the file-serving endpoint resolve correctly.
 *
 * Core agents running with workspaceScope:"full" write WITHOUT the generated/
 * rooting — they maintain the workspace itself (config shards, docs), so their
 * write target is taken literally. Everything else (scoped agents AND runtime
 * internals with no scope set) keeps the rooting.
 */
export function resolveWorkspaceWritePath(inputPath: string, workspacePath: string): { resolved: string; relativePath: string } {
  const within = resolvePathWithinWorkspace(inputPath, workspacePath);
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
