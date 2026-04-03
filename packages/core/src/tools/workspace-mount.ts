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