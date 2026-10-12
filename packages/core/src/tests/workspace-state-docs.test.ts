/**
 * THE DOCS SAY WHERE AN ACCOUNT'S WORKSPACE STATE IS KEPT (review 2026-10-12).
 *
 * An account's own root keeps no gateway state: its durable memory, skills and the rest are under
 * the shared root's `.starlingai/users/<seg>/`, outside the directory its sandboxes are handed
 * (tools/workspace-state.ts workspaceStateDir). The contributor guide, the architecture, memory and
 * tuning overviews, and the skill store's own header still placed skills and memory in
 * `<account root>/.starlingai/`, which for an account names a place that holds none of it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

/** Every Markdown file of the docs a reader is pointed at: docs/, the repo root, config/, workspace/. */
function docFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string, deep: boolean) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (deep) walk(path, true);
      } else if (name.toLowerCase().endsWith(".md")) {
        files.push(path);
      }
    }
  };
  walk(join(REPO, "docs"), true);
  for (const dir of [REPO, join(REPO, "config"), join(REPO, "workspace")]) walk(dir, false);
  return files;
}

const STORE = join(REPO, "packages", "core", "src", "skills", "store.ts");

describe("where the docs place a workspace's state", () => {
  it("no doc places skills or durable memory directly in a root's `.starlingai/`", () => {
    const stale = /\.starlingai\/(skills|memory)\b/;
    const offenders = [...docFiles(), STORE].flatMap((file) =>
      readFileSync(file, "utf8").split(/\r?\n/).flatMap((line, i) => (stale.test(line) ? [`${relative(REPO, file)}:${i + 1}`] : [])));
    expect(offenders).toEqual([]);
  });

  it.each([
    "CONTRIBUTING.md",
    "docs/architecture.md",
    "docs/memory-context-overview.md",
    "docs/swarm-tuning-overview.md",
    "packages/core/src/skills/store.ts",
  ])("%s names the account's place, under the shared root's state directory", (file) => {
    expect(readFileSync(join(REPO, file), "utf8")).toContain("<shared>/.starlingai/users/<seg>");
  });
});
