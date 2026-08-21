import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { currentWorkspaceScope } from "../runtime/request-context.js";
import { activeUserScopeSegment, USERS_SUBDIR } from "../runtime/user-scope.js";

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
 * Dedicated subfolder for agent-generated files/projects, kept one layer below
 * the workspace root so generated output never lands next to the hand-/config-
 * authored zone (agents/, jobs/, scenes/, tools/, runtime/).
 */
export const GENERATED_SUBDIR = "generated";

/** User-uploaded files (chat attachments) — readable by every agent. */
export const UPLOADS_SUBDIR = "uploads";

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
  const segment = activeUserScopeSegment();
  return segment ? `${GENERATED_SUBDIR}/${USERS_SUBDIR}/${segment}` : GENERATED_SUBDIR;
}

/** The absolute artifact zone for the ambient user. */
export function generatedZoneDir(workspacePath: string): string {
  return resolve(workspacePath, generatedZoneRel());
}

/**
 * Put a path that addresses the artifact zone into the AMBIENT USER'S partition of it.
 *
 * Three cases, and the middle one is the reason this exists rather than a `join` at each call
 * site. Already in this user's partition: left alone. In ANOTHER user's partition: refused —
 * the same shape of refusal as escaping the workspace, because it is the same kind of mistake.
 * Addressing the zone without naming a partition (`generated/app/index.html` — the form every
 * tool description in this repo teaches the model to type): re-rooted into this user's
 * partition, so that `write_file("generated/x")` followed by `read_file("generated/x")` is the
 * same file, which is the property the whole zone-rooting design rests on.
 */
function partitionGeneratedPath(relativePath: string, workspacePath: string): { resolved: string; relativePath: string } | null {
  const zoneRel = generatedZoneRel();
  if (zoneRel === GENERATED_SUBDIR) return null;                       // nothing to partition by
  const top = relativePath.split("/")[0] ?? "";
  if (top !== GENERATED_SUBDIR) return null;                           // not the artifact zone
  if (relativePath === zoneRel || relativePath.startsWith(`${zoneRel}/`)) return null;  // already mine
  if (relativePath.startsWith(`${GENERATED_SUBDIR}/${USERS_SUBDIR}/`)) {
    throw new Error("Path belongs to another user's artifact zone");
  }
  const rest = relativePath === GENERATED_SUBDIR ? "" : relativePath.slice(GENERATED_SUBDIR.length + 1);
  const scoped = rest ? `${zoneRel}/${rest}` : zoneRel;
  return { resolved: resolve(workspacePath, scoped), relativePath: scoped };
}

/**
 * Swarm-invented dynamic tools (JSON bundles managed by tools/dynamic-tools.ts).
 * Lives in the workspace next to the other self-authored zones (agents/, jobs/,
 * scenes/) so the swarm's own creations are inspectable and versionable in one
 * place. Written only by the tool-development pipeline (sandbox-tested +
 * approved) — write_file roots everything into generated/, so agents cannot
 * plant tool bundles directly.
 */
export const SWARM_TOOLS_SUBDIR = "tools";

/**
 * Workspace zones that hold working data, not configuration. The config-shard
 * loaders must skip these when sweeping the workspace for .json/.jsonc shards —
 * otherwise an agent-generated data.json (or an uploaded file, or a dynamic-tool
 * bundle) would merge into the live config on the next reload.
 */
export const NON_CONFIG_WORKSPACE_ZONES: ReadonlySet<string> = new Set([
  GENERATED_SUBDIR,
  UPLOADS_SUBDIR,
  SWARM_TOOLS_SUBDIR,
]);

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

export function resolvePathWithinWorkspace(inputPath: string, workspacePath: string): { resolved: string; relativePath: string } {
  const candidatePath = stripVirtualWorkspacePrefix(inputPath);
  const resolvedPath = isAbsolute(candidatePath)
    ? resolve(candidatePath)
    : resolve(workspacePath, candidatePath.replace(/^\//, ""));
  const rel = relative(workspacePath, resolvedPath);
  if (rel.startsWith("..") || rel === "..") {
    throw new Error("Path escapes workspace boundary");
  }
  const relativePath = rel === "" ? "." : rel.replace(/\\/g, "/");

  // Zone enforcement for scope-confined executions (set per-agent via
  // ToolContext.workspaceScope → AsyncLocalStorage). Re-rooting (instead of
  // denying) keeps read-after-write consistent: write_file("index.html") lands
  // in generated/index.html, and a later read_file("index.html") under the same
  // scope resolves to that same file.
  if (currentWorkspaceScope() === "generated") {
    const topSegment = relativePath === "." ? "" : (relativePath.split("/")[0] ?? "");
    if (!SCOPED_VISIBLE_ZONES.has(topSegment)) {
      const scopedRel = relativePath === "." ? GENERATED_SUBDIR : `${GENERATED_SUBDIR}/${relativePath}`;
      return partitionGeneratedPath(scopedRel, workspacePath)
        ?? { resolved: resolve(workspacePath, scopedRel), relativePath: scopedRel };
    }
  }

  // Last, so it applies to a path that arrived naming the zone AND to one the scope re-rooting
  // just put there. This is also what makes the gateway's workspace routes user-scoped: they
  // resolve through here under the ambient caller, so a request for another account's artifact
  // is refused and a request for `generated/...` reads the caller's own.
  return partitionGeneratedPath(relativePath, workspacePath) ?? { resolved: resolvedPath, relativePath };
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
