/**
 * DOC-504: generated policy reference — renderers are deterministic and carry
 * the enforcement facts they claim to document.
 */
import { describe, expect, it } from "vitest";
import {
  renderConfigFlagsMarkdown,
  renderDeploymentModesMarkdown,
  renderToolTiersMarkdown,
} from "../runtime/reference-docs.js";
import { listToolTierDefs } from "../guardrails/tool-tiers.js";

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
