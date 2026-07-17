/**
 * DOC-504 CLI: regenerate docs/reference/ from runtime metadata.
 * Run via `pnpm docs:reference` (root or packages/core). CI regenerates and
 * fails on drift, so the committed files always match the code's enforcement.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  renderConfigFlagsMarkdown,
  renderDeploymentModesMarkdown,
  renderToolTiersMarkdown,
  type FeatureRegistryLike,
} from "../runtime/reference-docs.js";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
const outDir = join(repoRoot, "docs", "reference");
mkdirSync(outDir, { recursive: true });

function writeDoc(name: string, content: string): void {
  writeFileSync(join(outDir, name), content, "utf8");
  console.log(`generated docs/reference/${name}`);
}

writeDoc("tool-tiers.md", renderToolTiersMarkdown());
writeDoc("deployment-modes.md", renderDeploymentModesMarkdown());

// The feature registry comes from the existing audit script (single source of
// truth for schema fields + read sites); it must run from the repo root.
const registryTmp = join(tmpdir(), `sai-feature-registry-${process.pid}.json`);
try {
  execFileSync(process.execPath, [join(repoRoot, "scripts", "audit-config-flags.mjs"), "--write", registryTmp], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const registry = JSON.parse(readFileSync(registryTmp, "utf8")) as FeatureRegistryLike;
  writeDoc("config-flags.md", renderConfigFlagsMarkdown(registry));
} finally {
  rmSync(registryTmp, { force: true });
}
