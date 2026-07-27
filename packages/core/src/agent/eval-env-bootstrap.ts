/**
 * Load the repo's .env into process.env BEFORE anything else is imported.
 *
 * Import this FIRST from an eval CLI entrypoint:
 *
 *     import "./eval-env-bootstrap.js";   // must precede every other import
 *     import { … } from "./evaluation.js";
 *
 * WHY THE ORDERING MATTERS. config/loader.ts freezes CONFIG_SOURCE at module-import
 * time, and the provider layer resolves its base URL from config just as eagerly. ES
 * module imports are hoisted and evaluated in listed order, so doing this inside
 * main() is far too late — the loader has already run with an empty environment. That
 * is exactly how the eval CLI came to report "backend unreachable" against a backend
 * that was answering fine: SAI_PRIMARY_MODEL_URL was never in scope, so the built
 * config's host.docker.internal address (correct inside the container, meaningless on
 * the host) was used instead.
 *
 * Only the gateway gets .env automatically, via docker-compose env_file. A bare
 * `tsx`/`pnpm` run gets nothing. Existing environment always wins, so CI and explicit
 * per-command overrides are untouched.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const REPO_ROOT = findRepoRoot();

const envPath = resolve(REPO_ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    const key = m?.[1];
    if (!key) continue;
    let value = (m?.[2] ?? "").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// The built starlingai.json is generated FOR THE CONTAINER, so its provider baseUrl is
// host.docker.internal. A host-side eval cannot reach that. SAI_PRIMARY_MODEL_URL from
// .env is the host-reachable address, and the loader already prefers it — this only
// makes sure it is present in time to be read.
