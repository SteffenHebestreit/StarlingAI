/**
 * Where a lab run's attempt workspaces live while it runs.
 *
 * Not under --out: a run's out directory sits in the deployment's state directory (.starlingai), and
 * the docker socket proxy refuses to bind any path there into a sandbox, by design, since state and
 * secrets live there (docker/docker-socket-proxy/bind-policy.mjs). Every task that ran code then
 * failed in the lab whatever its prompts said: the first nightly run's only failing task was the
 * sandbox one, every run_script and shell_exec refused with "Binds source not allowed". So attempts
 * run under the deployment's generated/ zone, which sandboxes may bind, in a dot directory of their
 * own, and once the run stops (finished, paused or failed) they are moved under --out, where the
 * report points, leaving generated/ as it was.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export const LAB_SCRATCH_DIR = ".harness-lab";

export function labScratchRoot(liveWorkspacePath: string, runId: string): string {
  return join(liveWorkspacePath, "generated", LAB_SCRATCH_DIR, runId.replace(/[^A-Za-z0-9._-]+/g, "_"));
}

/** Move a run's attempt workspaces to <outDir>/scratch, merging with what an earlier stop of the run moved there. */
export function archiveLabScratch(scratchRoot: string, outDir: string): void {
  if (!existsSync(scratchRoot)) return;
  const kept = join(outDir, "scratch");
  mkdirSync(kept, { recursive: true });
  for (const entry of readdirSync(scratchRoot)) {
    const from = join(scratchRoot, entry);
    const to = join(kept, entry);
    rmSync(to, { recursive: true, force: true });
    try {
      renameSync(from, to);
    } catch {
      // Another filesystem (a host run whose --out is elsewhere): copy, then remove.
      cpSync(from, to, { recursive: true });
      rmSync(from, { recursive: true, force: true });
    }
  }
  rmSync(scratchRoot, { recursive: true, force: true });
  // generated/.harness-lab goes too once no other run is using it.
  const parent = dirname(scratchRoot);
  try {
    if (readdirSync(parent).length === 0) rmdirSync(parent);
  } catch {
    // Gone already, or another run is in it.
  }
}
