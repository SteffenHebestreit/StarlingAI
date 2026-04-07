import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const allowedFiles = new Set([
  ".dockerignore",
  ".env",
  ".env.example",
  ".gitignore",
  ".mcp.json",
  "docker-compose.computer.yml",
  "docker-compose.model-servers.yml",
  "docker-compose.strix-halo.yml",
  "docker-compose.yml",
  "LICENSE",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "QUICKSTART.md",
  "README.md",
  "ROADMAP.md",
  "sai",
  "sai.cmd",
  "starlingai.example.json",
  "starlingai.json",
  "start-computer-node.bat",
  "start.bat",
  "start.sh",
  "stop-computer-node.bat",
]);

const allowedDirectories = new Set([
  ".claude",
  ".git",
  ".starlingai",
  ".vscode",
  "artifacts",
  "assets",
  "config",
  "docker",
  "docs",
  "node_modules",
  "packages",
  "scripts",
  "tutorials",
  "workspace",
]);

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