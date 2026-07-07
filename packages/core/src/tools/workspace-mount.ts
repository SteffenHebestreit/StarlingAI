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