/**
 * DOC-504: generated architecture/policy reference.
 *
 * These renderers turn RUNTIME METADATA — the compile-time tool-tier map, the
 * deployment-mode readiness rules, and the config feature registry — into the
 * markdown reference under docs/reference/. CI regenerates the files and fails
 * on drift (`git diff --exit-code docs/reference/`), so the reference tables
 * can never quietly diverge from what the code enforces: hand-editing them is
 * futile by construction, and changing enforcement without the docs is a CI
 * failure, not a review-time hope.
 *
 * Renderers must stay DETERMINISTIC for a given tree: stable sort orders, no
 * timestamps, LF line endings.
 */
import { listToolTierDefs, ToolTier } from "../guardrails/tool-tiers.js";
import { DEPLOYMENT_MODES, evaluateDeploymentReadiness, type DeploymentMode } from "./deployment-mode.js";

const GENERATED_HEADER = (source: string): string =>
  `<!-- GENERATED FILE — do not edit by hand. Regenerate with \`pnpm docs:reference\`.\n     Source of truth: ${source}. CI fails when this file drifts from the code. -->\n\n`;

const TIER_SEMANTICS: Record<number, { title: string; meaning: string }> = {
  [ToolTier.ZERO_READ_ONLY]: { title: "Tier 0 — read-only", meaning: "Always allowed; no side effects." },
  [ToolTier.ONE_WRITE]: { title: "Tier 1 — workspace writes", meaning: "Write operations inside the workspace; session-level consent once." },
  [ToolTier.TWO_EXECUTE]: { title: "Tier 2 — execution", meaning: "Code/command execution; per-invocation approval; always sandboxed." },
  [ToolTier.THREE_PRIVILEGED]: { title: "Tier 3 — privileged", meaning: "Privileged operations; admin approval plus audit entry." },
  [ToolTier.FOUR_BLOCKED]: { title: "Tier 4 — blocked", meaning: "Never executable under any circumstances; cannot be enabled by config." },
};

export function renderToolTiersMarkdown(): string {
  const defs = listToolTierDefs();
  const lines: string[] = [
    GENERATED_HEADER("packages/core/src/guardrails/tool-tiers.ts (TOOL_TIER_MAP)"),
    "# Tool permission tiers (enforced in code)",
    "",
    "Tiers are hard-coded and cannot be overridden at runtime; a tool absent from the map is blocked (tier 4). `approval` = per-invocation human approval required by the tier itself (scene `humanInLoopSteps` can additionally force approval for any tool).",
    "",
  ];
  for (const tier of [0, 1, 2, 3, 4]) {
    const rows = defs.filter((d) => d.tier === tier);
    if (rows.length === 0) continue;
    const semantics = TIER_SEMANTICS[tier]!;
    lines.push(`## ${semantics.title}`, "", semantics.meaning, "", "| Tool | Approval | Sandbox | Description |", "| --- | --- | --- | --- |");
    for (const d of rows) {
      lines.push(`| \`${d.name}\` | ${d.requiresPerCallApproval ? "per-call" : "—"} | ${d.requiresSandbox ? "required" : "—"} | ${d.description.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderDeploymentModesMarkdown(): string {
  const lines: string[] = [
    GENERATED_HEADER("packages/core/src/runtime/deployment-mode.ts (evaluateDeploymentReadiness)"),
    "# Deployment modes and their readiness guarantees",
    "",
    "`/readyz` fails closed: a REQUIRED dependency that is unavailable makes the gateway not-ready. The reasons below are the exact strings the readiness probe reports.",
    "",
  ];
  for (const mode of DEPLOYMENT_MODES) {
    const readiness = evaluateDeploymentReadiness({
      mode: mode as DeploymentMode,
      redisAvailable: false,
      postgresAvailable: false,
      authEnabled: false,
    });
    lines.push(`## \`${mode}\``, "", "| Dependency | Required | Rationale |", "| --- | --- | --- |");
    for (const dep of readiness.dependencies) {
      lines.push(`| ${dep.name} | ${dep.required ? "**yes**" : "no"} | ${dep.reason.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The subset of the feature-registry JSON (scripts/audit-config-flags.mjs --write) rendered into markdown. */
export interface FeatureRegistryLike {
  fields: Array<{
    name: string;
    declarations: Array<{ schemaFile: string; line: number }>;
    readSites: string[];
  }>;
}

export function renderConfigFlagsMarkdown(registry: FeatureRegistryLike): string {
  const lines: string[] = [
    GENERATED_HEADER("scripts/audit-config-flags.mjs (schema walk + read-site scan)"),
    "# Config feature registry",
    "",
    "Every public schema field, where it is declared, and how many production files read it. A field with zero read sites fails CI (`config:audit-flags --strict`), so nothing listed here is inert.",
    "",
    "| Field | Declared in | Read sites |",
    "| --- | --- | --- |",
  ];
  const fields = [...registry.fields].sort((a, b) => a.name.localeCompare(b.name));
  for (const field of fields) {
    const decl = field.declarations[0];
    const declText = decl ? `${decl.schemaFile.replace(/\\/g, "/")}:${decl.line}` : "—";
    lines.push(`| \`${field.name}\` | ${declText} | ${field.readSites.length} |`);
  }
  lines.push("");
  return `${lines.join("\n").trimEnd()}\n`;
}
