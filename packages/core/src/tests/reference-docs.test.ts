/**
 * DOC-504: generated policy reference — renderers are deterministic and carry
 * the enforcement facts they claim to document.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  renderConfigFlagsMarkdown,
  renderDeploymentModesMarkdown,
  renderToolTiersMarkdown,
} from "../runtime/reference-docs.js";
import { listToolTierDefs } from "../guardrails/tool-tiers.js";

// vitest runs from packages/core; the docs live at the repo root.
const REPO_ROOT = resolve(process.cwd(), "..", "..");

describe("reference-docs renderers", () => {
  it("tool-tiers reference lists known tools under their enforced tiers, deterministically", () => {
    const md = renderToolTiersMarkdown();
    expect(md).toBe(renderToolTiersMarkdown()); // no timestamps, stable order
    expect(md).toContain("GENERATED FILE");
    expect(md).toContain("| `read_file` |");
    // shell_exec is tier 2: per-call approval + sandbox — the doc must say so.
    const shellRow = md.split("\n").find((l) => l.startsWith("| `shell_exec` |"));
    expect(shellRow).toContain("per-call");
    expect(shellRow).toContain("required");
  });

  it("every mapped tool appears exactly once", () => {
    const md = renderToolTiersMarkdown();
    for (const def of listToolTierDefs()) {
      const occurrences = md.split(`| \`${def.name}\` |`).length - 1;
      expect(occurrences, def.name).toBe(1);
    }
  });

  it("deployment-modes reference states the fail-closed requirements per mode", () => {
    const md = renderDeploymentModesMarkdown();
    expect(md).toContain("## `single_process`");
    expect(md).toContain("## `trusted_cluster`");
    expect(md).toContain("## `untrusted_multi_tenant`");
    // Clustered modes REQUIRE redis/postgres; the reference must show that.
    const clustered = md.slice(md.indexOf("## `trusted_cluster`"));
    expect(clustered).toContain("| redis | **yes** |");
    expect(clustered).toContain("| postgres | **yes** |");
  });

  it("config-flags reference renders sorted registry rows", () => {
    const md = renderConfigFlagsMarkdown({
      fields: [
        { name: "zeta.flag", declarations: [{ schemaFile: "packages/core/src/config/schema.ts", line: 10 }], readSites: ["a.ts"] },
        { name: "alpha.flag", declarations: [{ schemaFile: "packages/core/src/config/schema.ts", line: 5 }], readSites: ["a.ts", "b.ts"] },
      ],
    });
    expect(md.indexOf("alpha.flag")).toBeLessThan(md.indexOf("zeta.flag"));
    expect(md).toContain("| `alpha.flag` | packages/core/src/config/schema.ts:5 | 2 |");
  });
});

/**
 * The generated files carry the line "CI fails when this file drifts from the
 * code." Nothing enforced that: the tests above only exercise the renderers in
 * memory, so a tool added to TOOL_TIER_MAP could (and did — `load_tool`) go
 * missing from the committed reference for as long as nobody ran
 * `pnpm docs:reference`. These tests compare the renderer output to what is
 * actually on disk, which is what the header claims.
 *
 * config-flags.md is deliberately not covered here: its registry comes from
 * shelling out to scripts/audit-config-flags.mjs (a full schema walk + read-site
 * scan over the repo), which is far too slow for a unit test. Regenerate it with
 * `pnpm docs:reference` when the schema changes.
 */
describe("generated reference docs are in sync with the code", () => {
  const committed = (relPath: string): string =>
    readFileSync(resolve(REPO_ROOT, relPath), "utf8").replace(/\r\n/g, "\n");

  it("docs/reference/tool-tiers.md matches renderToolTiersMarkdown()", () => {
    expect(committed("docs/reference/tool-tiers.md")).toBe(
      renderToolTiersMarkdown().replace(/\r\n/g, "\n"),
    );
  });

  it("docs/reference/deployment-modes.md matches renderDeploymentModesMarkdown()", () => {
    expect(committed("docs/reference/deployment-modes.md")).toBe(
      renderDeploymentModesMarkdown().replace(/\r\n/g, "\n"),
    );
  });
});
