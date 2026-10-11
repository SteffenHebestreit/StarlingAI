import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config/loader.js";
import { PRODUCT } from "../product/index.js";
import { isAccountWorkspaceRoot } from "./workspace-state.js";

const DEFAULT_WORKSPACE_VOLUME = process.env["SAI_SANDBOX_WORKSPACE_VOLUME"] ?? "gc-workspace";

interface DockerWorkspaceMountOptions {
  mountSource?: string;
  fallbackVolume?: string;
}

export function resolveDockerWorkspaceMountSource(
  workspacePath: string,
  options: DockerWorkspaceMountOptions = {},
): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  if (normalized !== "/workspace" && !normalized.startsWith("/workspace/")) {
    return workspacePath;
  }

  const explicitMountSource = options.mountSource?.trim() || process.env["SAI_WORKSPACE_MOUNT_SOURCE"]?.trim();
  if (explicitMountSource) {
    return explicitMountSource;
  }

  return options.fallbackVolume ?? DEFAULT_WORKSPACE_VOLUME;
}


/**
 * Is this a containerized deployment, where the mount SOURCE corresponds to `/workspace`
 * rather than to the workspace directory itself?
 */
function mountSourceMapsToWorkspaceRoot(workspacePath: string): boolean {
  const normalized = workspacePath.replace(/\\/g, "/");
  return normalized === "/workspace" || normalized.startsWith("/workspace/");
}

/**
 * The `-v host:container` spec that gives a sandbox the workspace tree.
 *
 * THE MOUNT SOURCE IS NOT THE WORKSPACE. In the shipped compose deployment the REPO root is
 * bound at /workspace deliberately — the self-improvement agents run git there — and the
 * workspace is the `workspace/` directory inside it, which is why SAI_WORKSPACE_CONFIG_PATH is
 * `/workspace/workspace`. So a bind of `mountSource` belongs at `/workspace`, and the
 * workspace lands underneath at exactly the path `workspacePath` already names.
 *
 * Binding it at `workspacePath` instead puts the repo root where the workspace should be, one
 * segment off: `<workspacePath>/generated` then resolves to `<repo>/generated`, which does not
 * exist. Verified against the running stack — `-v <repo>:/workspace/workspace` exposes the repo
 * at /workspace/workspace and `/workspace/workspace/generated` is "No such file or directory",
 * with the real tree one level deeper.
 *
 * Outside a container the mount source IS the workspace, so it is bound at its own path, which
 * is what the in-container tools resolve against.
 *
 * AND IT BINDS EXACTLY THE DIRECTORY IT WAS HANDED. Once a workspace root is per-user
 * (tools/workspace-path.ts userWorkspaceRoot), binding the deployment-wide source at /workspace
 * would hand every container the whole tree including every other account — the resolver inside
 * would confine it, but a shell inside the container answers to the mount, not the resolver. So
 * the host equivalent of `workspacePath` is bound at `workspacePath`, and a container simply has
 * no sibling directory to reach.
 *
 * Falls back to the whole-tree bind when the source is a named volume, which has no host path to
 * subdivide — that deployment keeps today's behaviour rather than silently getting an empty
 * mount, and the caller is the one that decides whether that is acceptable.
 */
export function resolveDockerWorkspaceBind(
  workspacePath: string,
  options: DockerWorkspaceBindOptions & { requireNarrow: true },
): string | null;
export function resolveDockerWorkspaceBind(
  workspacePath: string,
  options?: DockerWorkspaceBindOptions,
): string;
export function resolveDockerWorkspaceBind(
  workspacePath: string,
  options: DockerWorkspaceBindOptions = {},
): string | null {
  const source = resolveDockerWorkspaceMountSource(workspacePath, options);
  const at = options.at;
  if (!mountSourceMapsToWorkspaceRoot(workspacePath)) return `${source}:${at ?? workspacePath}`;
  const host = resolveHostPathUnderWorkspace(workspacePath, source);
  // A named-volume source has no host path to subdivide, so the only narrow available is the whole
  // volume. A caller that must not expose another account's tree (requireNarrow) gets null here
  // and refuses the run, instead of silently binding the whole tree. A host-path source is always
  // narrowed to the caller's own offset below, so requireNarrow never rejects one.
  if (!host) return options.requireNarrow ? null : `${source}:${at ?? "/workspace"}`;
  return `${host}:${at ?? workspacePath}`;
}

export interface DockerWorkspaceBindOptions extends DockerWorkspaceMountOptions {
  /**
   * Expose the workspace at THIS container path instead of at its own.
   *
   * The shell sandboxes need it: their whole contract with the model is that `/workspace` is
   * the workspace and paths are relative to it — run_script literally executes
   * `/workspace/<path>` for a workspace-relative path the model gives it. They were binding the
   * deployment mount SOURCE there, which in the compose layout is the repo, so `/workspace` was
   * the repo and `/workspace/generated` did not exist: a script an agent had just written could
   * not be executed, and a relative write landed at the repo root. Binding the workspace itself
   * at `/workspace` makes the contract true, and — since that path is now per-user — also makes
   * the mount the boundary, because a sandbox has no sibling account in it to reach.
   */
  at?: string;
  /**
   * Fail closed instead of binding the whole tree. When the mount SOURCE is a named volume there
   * is no host path to subdivide, so the only "narrow" available is the whole volume. A caller
   * that must never expose another account's files (the git sandbox for a non-full agent) passes
   * requireNarrow and gets `null` back in that case, so it can refuse rather than mount the tree.
   * A host-path source is always narrowed to the caller's own offset, so requireNarrow never
   * rejects one.
   */
  requireNarrow?: boolean;
}

/**
 * `--user` for a sandbox: the owner of the directory it is handed (`gatewayPath`, the GATEWAY's
 * own path to it).
 *
 * The sandbox image runs as its own unprivileged user (uid 1000), which owns nothing in the
 * mount. In the compose deployment the gateway runs as root and creates each account's workspace
 * 0755, so every write in the sandbox failed with "Permission denied" (E2E 2026-10-11: shell_agent's
 * `mkdir -p generated/...`, git_developer's `git init`, qa_guard's test writes), and git refuses a
 * repository its user does not own ("dubious ownership") even to read it. Running as the owner gives
 * the sandbox the access the gateway already has to that one directory and nothing more; that owner
 * is root in the compose deployment, which is why every sandbox keeps --cap-drop=ALL and
 * no-new-privileges (no DAC override, no chown, no mounts), as serve_app's root run already does.
 *
 * No flag when the directory cannot be read: the image's own user then applies, as before. None on
 * Windows either, where Node reports uid and gid 0 for every path: a Windows-native gateway would
 * have run every sandbox as root.
 */
export function sandboxUserArgs(gatewayPath: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") return [];
  try {
    const { uid, gid } = statSync(gatewayPath);
    return ["--user", `${uid}:${gid}`];
  } catch {
    return [];
  }
}

/**
 * Which directory a gateway-issued sandbox is handed:
 *   - "caller": the caller's own workspace root, as resolveDockerWorkspaceBind binds it (shell_exec,
 *     run_script, run_test_suite, and the git sandbox of every agent that is not full-scope);
 *   - "repo": the deployment mount the git sandbox keeps for the full-scope maintenance agent.
 */
export type SandboxBind = "caller" | "repo";

export interface SandboxIsolationInput {
  /** The agent's workspace root in the GATEWAY's terms (ToolContext.workspacePath). */
  workspacePath: string;
  /** ToolContext.workspaceScope. */
  workspaceScope?: string;
  bind: SandboxBind;
  /** Where the sandbox has the bound directory. */
  at?: string;
}

/** What the isolation reads from the gateway's host. The tools pass nothing; tests pass these. */
export interface SandboxHostOverrides {
  /** The gateway's platform; process.platform when absent. */
  platform?: NodeJS.Platform;
  /** The deployment's shared workspace root; getConfig().workspacePath when absent. */
  sharedRoot?: string;
}

/**
 * The isolation flags every gateway-issued sandbox adds after its workspace bind (shell_exec,
 * run_script, run_test_suite and the git tools all spread these).
 *
 * `--user`: the owner of the bound directory, see sandboxUserArgs. For the git repo bind that is
 * the deployment mount, /workspace on the gateway side, not the agent's own root.
 *
 * A FULL-SCOPE SANDBOX'S BIND IS READ-ONLY, EXCEPT WHAT THE MAINTAINER MAINTAINS. Its bind holds the
 * gateway's own state: the shared root's state directory for its shell (accounts.json, approvals/,
 * and every account's workspace state, tools/workspace-state.ts), and for the git repo bind the repo
 * root's as well (credentials.enc, audit.jsonl). On Docker Desktop neither the masks below nor file
 * modes hold there: the bind is case-insensitive, so `.STARLINGAI/...` went past the tmpfs at
 * `.starlingai` and wrote the real directory, and every entry the host created shows as root's, mode
 * 0777, writable by any uid (review 2026-10-11). A read-only bind holds against both, since every
 * spelling resolves through the same read-only mount (verified live 2026-10-11). sandboxBindSpec
 * makes it read-only, and the shared root's config zones (PROTECTED_WORKSPACE_ZONES) and generated/
 * are bound again writable from their host paths, at their place in the bind: /workspace/<zone> for
 * the shell, /workspace/workspace/<zone> for the repo bind in the compose layout. A zone that is not
 * there, or has no host path (a named volume), stays read-only. The sandbox runs as the bind's owner,
 * root in the compose deployment, which git needs to read the repository at all; .git stays
 * read-only, as no full-scope agent holds a git tool that writes it (swarm_maintainer has git_status
 * and git_diff).
 *
 * NO GATEWAY STATE IS KEPT IN AN ACCOUNT'S ROOT. An account's sandboxes run as the owner of that
 * root, root in the compose deployment, and can write anything in it, under any spelling; the
 * gateway keeps that account's state outside it (tools/workspace-state.ts workspaceStateDir). Where
 * the shared root lies inside the bind (an auth-off session, the whole-volume fallback, the repo
 * bind), its state directory (accounts.json, approvals/, the ledgers) gets an empty read-only tmpfs
 * over it, which a cap-less root cannot remount or write ("Read-only file system", verified live
 * 2026-10-11), as does the repo root's. That directory is created first, so docker does not create
 * the mount point as root; the bind itself is read-only around it (above and below). An old state
 * directory in an account's root, which the boot moved out (runtime/workspace-state-relocation.ts)
 * or a sandbox made since, is masked too where it exists. A missing one is not: docker would create
 * the mount point on the host, an empty directory at the place the gateway no longer reads.
 *
 * THE SHARED ROOT IS READ-ONLY, EXCEPT generated/, for a sandbox that is not full-scope and has the
 * shared root in its bind (an auth-off session, whose root is the shared root, or the whole-volume
 * fallback). The config loader merges every .json/.jsonc it finds in the shared root outside the
 * working zones, and applies runtime/runtime.overrides.json last, so a root sandbox that could
 * write there could rewrite the live configuration on the next reload; re-binding agents/, jobs/,
 * scenes/ and tools/ read-only did not cover a new file at the root or in a new directory (review
 * 2026-10-11). sandboxBindSpec makes the bind read-only, and generated/, where write_file puts a
 * working agent's output, is bound again writable from its host path. A named-volume source has no
 * host path for it, so that sandbox stays read-only. users/ holds every account's workspace and is
 * masked, unless the caller's own root is in it.
 */
export function sandboxIsolationArgs(input: SandboxIsolationInput, host: SandboxHostOverrides = {}): string[] {
  const at = input.at ?? "/workspace";
  const bound = boundGatewayPath(input.workspacePath, input.bind);
  // A new account's root does not exist before its first run: the stat found nothing, no --user
  // went out, and docker created the bind source itself, as root 0755, which the image's user
  // cannot write. The gateway creates it first, as it creates everything else in the workspace.
  // The repo bind is the deployment mount, which the gateway does not create.
  if (input.bind === "caller") ensureGatewayDir(bound);
  const args = sandboxUserArgs(bound, host.platform);

  const sharedRoot = host.sharedRoot ?? configuredSharedRoot();
  const masked = new Set<string>();
  for (const root of [bound, input.workspacePath, sharedRoot]) {
    if (!root) continue;
    const stateDir = join(root, PRODUCT.stateDirName);
    const sandboxPath = sandboxPathWithin(`${normalizeRoot(root)}/${PRODUCT.stateDirName}`, bound, at);
    if (sandboxPath === null || masked.has(sandboxPath)) continue;
    if (isAccountWorkspaceRoot(root)) {
      // Not where the gateway keeps this account's state: masked only where it exists.
      if (!existsSync(stateDir)) continue;
    } else {
      // Docker creates a missing mount point itself, owned by root, where a gateway that does not
      // run as root could then not write its own state.
      ensureGatewayDir(stateDir);
    }
    masked.add(sandboxPath);
    args.push(`--tmpfs=${sandboxPath}:ro,size=4k`);
  }

  const sharedAt = lockedSharedRootAt(input, bound, sharedRoot, at);
  if (sharedAt !== null && sharedRoot) {
    // Null for a named-volume source, which has no host path to bind generated/ from.
    const hostGenerated = resolveHostWorkspacePath(sharedRoot, "generated");
    if (hostGenerated !== null) {
      ensureGatewayDir(join(sharedRoot, "generated"));
      args.push("-v", `${hostGenerated}:${sharedAt}/generated`);
    }
    const users = join(sharedRoot, "users");
    if (sandboxPathWithin(input.workspacePath, users, at) === null) {
      ensureGatewayDir(users);
      args.push(`--tmpfs=${sharedAt}/users:ro,size=4k`);
    }
  }

  if (input.workspaceScope === "full" && sharedRoot) {
    for (const zone of [...PROTECTED_WORKSPACE_ZONES, "generated"]) {
      const gatewayZone = join(sharedRoot, zone);
      const sandboxZone = sandboxPathWithin(gatewayZone, bound, at);
      // Null for a named-volume source, which has no host path to bind a zone from.
      const hostZone = resolveHostWorkspacePath(sharedRoot, zone);
      if (sandboxZone === null || hostZone === null || !existsSync(gatewayZone)) continue;
      args.push("-v", `${hostZone}:${sandboxZone}`);
    }
  }
  return args;
}

/** The workspace bind, read-only for a full-scope sandbox and where sandboxIsolationArgs re-binds
 *  only generated/ writable; each re-binds its writable zones over it. */
export function sandboxBindSpec(bindSpec: string, input: SandboxIsolationInput, host: SandboxHostOverrides = {}): string {
  if (input.workspaceScope === "full") return `${bindSpec}:ro`;
  const bound = boundGatewayPath(input.workspacePath, input.bind);
  const sharedRoot = host.sharedRoot ?? configuredSharedRoot();
  return lockedSharedRootAt(input, bound, sharedRoot, input.at ?? "/workspace") === null ? bindSpec : `${bindSpec}:ro`;
}

/** Where a sandbox that is not full-scope sees the shared root in its bind, or null when it is
 *  full-scope or the shared root is not in its bind. */
function lockedSharedRootAt(input: SandboxIsolationInput, bound: string, sharedRoot: string | undefined, at: string): string | null {
  if (input.workspaceScope === "full" || !sharedRoot) return null;
  return sandboxPathWithin(sharedRoot, bound, at);
}

/**
 * The GATEWAY's path to the directory a sandbox has at /workspace. The caller's own root, except
 * where resolveDockerWorkspaceBind binds the whole mount source instead (a named volume, which has
 * no host path to narrow): that is /workspace on the gateway side, as it is for the git repo bind.
 * Outside a container the bound directory is the workspace itself either way.
 */
function boundGatewayPath(workspacePath: string, bind: SandboxBind): string {
  if (!mountSourceMapsToWorkspaceRoot(workspacePath)) return workspacePath;
  if (bind === "repo") return "/workspace";
  const source = resolveDockerWorkspaceMountSource(workspacePath);
  return resolveHostPathUnderWorkspace(workspacePath, source) === null ? "/workspace" : workspacePath;
}

/**
 * The root toSandboxPath / toSandboxCommand map for the caller's own bind: the directory the sandbox
 * has at /workspace. Where the whole named volume is bound instead, that is /workspace itself, and the
 * sandbox sees the caller's root at its gateway path, so nothing is mapped; mapping the caller's root
 * there sent `cd <root>` to the volume's top.
 */
export function sandboxMappedRoot(workspacePath: string): string {
  return boundGatewayPath(workspacePath, "caller");
}

/** `mkdir -p` on the gateway side. On a failure docker creates the directory, as it did before. */
function ensureGatewayDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch {
    // Left to docker.
  }
}

/** Where a sandbox sees a gateway path, or null when the path is outside the bound directory. */
function sandboxPathWithin(gatewayPath: string, boundGatewayPath: string, at: string): string | null {
  const path = normalizeRoot(gatewayPath);
  const bound = normalizeRoot(boundGatewayPath);
  if (!bound) return null;
  if (path === bound) return at;
  return path.startsWith(`${bound}/`) ? `${at}${path.slice(bound.length)}` : null;
}

/** The deployment's shared workspace root. getConfig() loads the config on first use, so this is
 *  undefined only when the config cannot load at all; the bound directory's own state directory and
 *  the caller's are masked all the same. */
function configuredSharedRoot(): string | undefined {
  try {
    const root = getConfig().workspacePath;
    return typeof root === "string" && root.trim() ? root : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A path in the GATEWAY's terms, mapped to where a sandbox sees it.
 *
 * Every sub-agent is told "Current workspace: <workspacePath>", the gateway-side path (in the
 * compose deployment /workspace/workspace/users/<account>), and passes it back: as shell_exec's
 * workdir, or in `cd <workspacePath> && ...`. The sandbox has that directory at `at`, and nothing
 * at the gateway path, so each such run failed before the command started (E2E 2026-10-11). A path
 * outside the workspace root is returned unchanged; the callers' own /workspace check still applies.
 */
export function toSandboxPath(path: string, workspacePath: string, at = "/workspace"): string {
  const root = normalizeRoot(workspacePath);
  const normalized = path.replace(/\\/g, "/");
  if (!root || root === at) return path;
  if (normalized === root || normalized === `${root}/`) return at;
  if (normalized.startsWith(`${root}/`)) return `${at}/${normalized.slice(root.length + 1)}`;
  return path;
}

/**
 * The same mapping for every place a command names the workspace root, at a path boundary on both
 * sides. After it: the end, a separator, or what ends a shell word, an assignment, a list item or a
 * `host:path` pair (`<root>-old` is another directory and stays as written). Before it: the start,
 * or what can open such a word (`/mnt<root>/x` is another path and stays as written). A Windows
 * root also matches in its backslash form.
 */
export function toSandboxCommand(command: string, workspacePath: string, at = "/workspace"): string {
  const root = normalizeRoot(workspacePath);
  if (!root || root === at) return command;
  const windows = /^[a-zA-Z]:\//.test(root);
  const forms = windows ? [root, root.replace(/\//g, "\\")] : [root];
  if (!forms.some((form) => command.includes(form))) return command;
  const after = windows ? WINDOWS_ROOT_AFTER : ROOT_AFTER;
  const pattern = forms.map((form) => `${ROOT_BEFORE}${escapeRegExp(form)}${after}`).join("|");
  return command.replace(new RegExp(pattern, "g"), at);
}

const ROOT_BEFORE = /(?<=^|[\s'"`=:;&|<>(){},])/.source;
const ROOT_AFTER = /(?=$|[/\s'"`;&|<>(){},:=])/.source;
const WINDOWS_ROOT_AFTER = /(?=$|[/\\\s'"`;&|<>(){},:=])/.source;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeRoot(workspacePath: string): string {
  return workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** The host path for a container path under /workspace, or null for a named-volume source. */
function resolveHostPathUnderWorkspace(containerPath: string, source: string): string | null {
  const trimmed = source.replace(/[/\\]+$/, "");
  const looksLikeHostPath = trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed);
  if (!looksLikeHostPath) return null;
  const offset = containerPath.replace(/\\/g, "/").slice("/workspace".length);
  return `${trimmed}${offset}`;
}

/**
 * The HOST path for a workspace-relative path — for the one caller that binds a SUBDIRECTORY
 * of the workspace rather than the whole tree.
 *
 * Same off-by-one as above, in the other direction: appending the relative path straight to the
 * mount source skips the workspace's own offset below /workspace, so `generated/my-app` became
 * `<repo>/generated/my-app` instead of `<repo>/workspace/generated/my-app`, and the container
 * got an empty directory that docker created on the spot.
 *
 * `null` when the source is a named volume rather than a host path: a volume has no host path to
 * append to, and inventing one produces a bind on a directory named after the volume.
 */
export function resolveHostWorkspacePath(
  workspacePath: string,
  relativePath: string,
  options: DockerWorkspaceMountOptions = {},
): string | null {
  const source = resolveDockerWorkspaceMountSource(workspacePath, options);
  const base = mountSourceMapsToWorkspaceRoot(workspacePath)
    ? resolveHostPathUnderWorkspace(workspacePath, source)
    : source.replace(/[/\\]+$/, "");
  if (base === null) return null;
  const rel = relativePath.replace(/^[/\\]+/, "");
  return `${base}/${rel}`;
}

/**
 * Workspace subfolders that hold LIVE configuration the swarm authors through
 * dedicated, validated, approval-gated tools (swarm_define_agent / _save_scene /
 * _save_job, the tool-dev pipeline) — NOT through raw shell writes. The config
 * loader merges these into the running config on reload, so a shell command that
 * edits one is a routing/behavior-injection persistence vector. write_file
 * already re-roots scope-confined agents into generated/, but the shell sandbox
 * bind-mounts the whole workspace read-write; these zones are the write-allowlist
 * complement — everything here is off-limits to sandboxed agent commands.
 * The one exception is the full-scope maintenance agent, whose job these zones are:
 * its sandbox gets exactly these, and generated/, writable in an otherwise read-only
 * bind (sandboxIsolationArgs).
 */
export const PROTECTED_WORKSPACE_ZONES: readonly string[] = ["agents", "jobs", "scenes", "tools"] as const;

/* NOTE: a read-only overlay of these config zones INTO the shell/test sandbox was
 * first rejected as deployment-layout fragile: while the sandboxes bound the mount
 * SOURCE, which in the compose layout is the repo root, the zones sat at
 * /workspace/workspace/<zone> in one deployment and /workspace/<zone> in another,
 * and a naive overlay produced a wrong or empty mount. Every sandbox now binds
 * exactly the directory it was handed (resolveDockerWorkspaceBind), so the zones'
 * place in it follows from the gateway paths: a non-full-scope sandbox with the shared
 * root in its bind gets the whole tree read-only except generated/ (sandboxBindSpec,
 * sandboxIsolationArgs), which covers the zones and every other place the loader reads, and a
 * full-scope sandbox gets it read-only except these zones and generated/. The
 * other layers stay: write_file re-roots scope-confined agents into generated/
 * (workspace-path.ts, so they cannot address the config zones at all), live-config
 * authoring goes ONLY through the dedicated validated/approval-gated tools
 * (swarm_define_agent / _save_scene / _save_job), and assertSafeDockerRunArgs
 * bounds every gateway-issued docker run. */