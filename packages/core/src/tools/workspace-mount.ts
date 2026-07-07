import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

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

/**
 * Build `-v …:ro` overlay args that re-mount the protected config zones READ-ONLY
 * on top of the writable /workspace mount, so a scope-confined agent's shell/test
 * command can read but never mutate live config (generated/ + uploads/ stay
 * writable). Returns [] when:
 *   - scope is "full" (core/maintenance agents legitimately edit config), or
 *   - the mount source is a named volume, not an absolute host path (can't overlay
 *     a volume subpath — a no-op rather than a broken `docker run`), or
 *   - the zone directory doesn't exist under the source.
 * Docker applies the more-specific nested mount, so the overlay wins over the RW
 * parent. Pure/deterministic given the filesystem — exported for testing.
 */
export function buildProtectedZoneReadonlyArgs(
  mountSource: string,
  scope: "full" | "generated" | undefined,
  opts: { existenceRoot?: string; mountRoot?: string } = {},
): string[] {
  if (scope === "full") return [];
  // Overlaying a subpath requires a real host path; named volumes are skipped.
  if (!isAbsolute(mountSource)) return [];
  const mountRoot = opts.mountRoot ?? "/workspace";
  // Zone existence is checked against a GATEWAY-VISIBLE path (the workspacePath),
  // NOT the mount source: the mount source is the HOST path the docker daemon
  // resolves for `-v`, which the containerized gateway process cannot stat — so
  // checking it would make this a silent no-op in the real deployment. The zones
  // sit at the same relative position under both, so we stat via existenceRoot
  // and bind via mountSource.
  const checkRoot = (opts.existenceRoot ?? mountSource).replace(/[/\\]+$/, "");
  const src = mountSource.replace(/[/\\]+$/, "");
  const args: string[] = [];
  for (const zone of PROTECTED_WORKSPACE_ZONES) {
    if (existsSync(`${checkRoot}/${zone}`)) {
      args.push("-v", `${src}/${zone}:${mountRoot}/${zone}:ro`);
    }
  }
  return args;
}