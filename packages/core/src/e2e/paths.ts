/**
 * Where the end-to-end harness finds its inputs and writes its outputs. Everything is resolved
 * from the repository root, found by walking up from this module (or the working directory) to
 * the directory holding pnpm-workspace.yaml, so the CLI behaves the same from the repo root, from
 * packages/core, or through a pnpm --filter pass-through.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findUp(start: string, marker: string): string | null {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, marker))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The repository root: the nearest ancestor with pnpm-workspace.yaml. */
export function findRepoRoot(): string {
  const fromModule = findUp(dirname(fileURLToPath(import.meta.url)), "pnpm-workspace.yaml");
  if (fromModule) return fromModule;
  const fromCwd = findUp(process.cwd(), "pnpm-workspace.yaml");
  if (fromCwd) return fromCwd;
  return process.cwd();
}

export interface E2EPaths {
  repoRoot: string;
  /** eval/e2e */
  e2eDir: string;
  /** eval/e2e/scenarios — every *.jsonc below it is a scenario file. */
  scenariosDir: string;
  /** eval/e2e/fixtures — the only place turn attachments are read from. */
  fixturesDir: string;
  /** eval/e2e/.credentials.local.json (E2E_CREDENTIALS_PATH overrides). */
  credentialsPath: string;
  /** artifacts/evaluations/e2e — reports. */
  reportsDir: string;
}

export function resolveE2EPaths(repoRoot = findRepoRoot(), env: NodeJS.ProcessEnv = process.env): E2EPaths {
  const e2eDir = join(repoRoot, "eval", "e2e");
  const credentialsOverride = env["E2E_CREDENTIALS_PATH"]?.trim();
  return {
    repoRoot,
    e2eDir,
    scenariosDir: join(e2eDir, "scenarios"),
    fixturesDir: join(e2eDir, "fixtures"),
    credentialsPath: credentialsOverride ? resolve(credentialsOverride) : join(e2eDir, ".credentials.local.json"),
    reportsDir: join(repoRoot, "artifacts", "evaluations", "e2e"),
  };
}
