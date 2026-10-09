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
  options: DockerWorkspaceBindOptions = {},
): string {
  const source = resolveDockerWorkspaceMountSource(workspacePath, options);
  const at = options.at;
  if (!mountSourceMapsToWorkspaceRoot(workspacePath)) return `${source}:${at ?? workspacePath}`;
  const host = resolveHostPathUnderWorkspace(workspacePath, source);
  if (!host) return `${source}:${at ?? "/workspace"}`;
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
 */
export const PROTECTED_WORKSPACE_ZONES: readonly string[] = ["agents", "jobs", "scenes", "tools"] as const;

/* NOTE: a read-only overlay of these config zones INTO the shell/test sandbox was
 * considered as extra defense-in-depth, but it is deployment-layout fragile — the
 * sandbox mount source is the host workspace/repo path and its /workspace mapping
 * varies (e.g. the repo root can be the mount source, putting the zones at
 * /workspace/workspace/<zone>), so a naive overlay produces a wrong/empty mount.
 * The write-allowlist is therefore enforced where it is robust and layout-
 * independent: write_file re-roots scope-confined agents into generated/
 * (workspace-path.ts, so they cannot address the config zones at all), live-config
 * authoring goes ONLY through the dedicated validated/approval-gated tools
 * (swarm_define_agent / _save_scene / _save_job), and assertSafeDockerRunArgs
 * bounds every gateway-issued docker run. */