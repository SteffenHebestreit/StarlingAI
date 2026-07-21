import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT } from "./product.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const allowedFiles = new Set([
  ".dockerignore",
  ".env",
  ".env.example",
  ".gitattributes",
  ".gitignore",
  ".gitleaks.toml",
  ".mcp.json",
  "CONTRIBUTING.md",
  "docker-compose.computer.yml",
  "docker-compose.gpu.yml",
  "docker-compose.model-servers.yml",
  "docker-compose.ollama.yml",
  "docker-compose.yml",
  "eslint.config.mjs",
  "LICENSE",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "QUICKSTART.md",
  "README.md",
  "sai",
  "sai.cmd",
  // Live eval PLANS live at the root next to their CLIs' default lookup paths
  // (evaluation-cli.ts defaults to ./agent-eval.jsonc, scene harness to ./scene-eval.jsonc).
  "agent-eval.jsonc",
  "scene-eval.jsonc",
  PRODUCT.exampleConfigFileName,
  PRODUCT.configFileName,
  // Upstream default names stay allowed in forks (the upstream example config
  // ships in the tree even when product.json renames the active one).
  "starlingai.example.json",
  "starlingai.json",
  "product.json",
  // Fork-owned compose overlay (docs/forking.md §6) — upstream ships none.
  "docker-compose.override.yml",
  "start.bat",
  "start.command",
  "start.ps1",
  "start.sh",
]);

const allowedDirectories = new Set([
  ".claude",
  ".git",
  ".github",
  PRODUCT.stateDirName,
  ...PRODUCT.legacyStateDirNames,
  ".starlingai",
  ".vscode",
  "artifacts",
  "assets",
  "config",
  "docker",
  "docs",
  // Trap fixtures + ground truth for the root agent-eval.jsonc plan (QPR-001).
  "eval",
  "examples",
  "node_modules",
  "packages",
  "scripts",
  "specs",
  "tutorials",
  "workspace",
]);

// Fork-owned root entries — product.json may declare
// `rootAllowlist: { files: [], directories: [] }` so a fork can extend the
// allowlist without editing this upstream script (docs/forking.md).
const forkAllowlist = PRODUCT.rootAllowlist ?? {};
for (const file of forkAllowlist.files ?? []) allowedFiles.add(file);
for (const dir of forkAllowlist.directories ?? []) allowedDirectories.add(dir);

async function main() {
  const entries = await readdir(repoRoot, { withFileTypes: true });
  const unexpected = entries
    .filter((entry) => {
      if (entry.isDirectory()) {
        return !allowedDirectories.has(entry.name);
      }
      return !allowedFiles.has(entry.name);
    })
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (unexpected.length === 0) {
    console.log("Repository root layout check passed.");
    return;
  }

  console.error("Unexpected repository-root entries found:");
  for (const entry of unexpected) {
    console.error(` - ${entry}`);
  }
  console.error("Move generated artifacts under artifacts/, helper scripts under scripts/devtools/, or update the allowlist intentionally.");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});