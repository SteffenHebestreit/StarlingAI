/**
 * Discriminance harness for the routing decision suite.
 *
 *   pnpm routing:eval:discriminance
 *
 * A passing eval proves nothing on its own. This reverts each fix the suite is supposed to
 * guard — one at a time, in a byte-exact copy of the source — and checks that the case named
 * for it FAILS, while its control still passes. A probe that breaks nothing means the case it
 * points at is decorative; a probe that breaks its own control means the case is too broad.
 *
 * This repo has shipped four vacuous tests that a check like this would have caught: a bad
 * anchor string, a fixture that shared the task's vocabulary, an eval that measured ranking
 * while the production gate is absolute, and a bonus whose test passed on an alphabetical
 * tie-break. Re-run this whenever a case is added or a fusion rule changes.
 *
 * It EDITS a source file and restores it, so it refuses to start on a dirty working tree and
 * restores in a `finally`. It is deliberately NOT part of CI.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Probe {
  /** What is being broken, in the words of the defect it reintroduces. */
  name: string;
  /** Exact source text to replace. A missing anchor is a hard failure, never a skip. */
  find: string;
  replace: string;
  /** Case ids that MUST fail once the fix is reverted. */
  mustFail: string[];
  /** Case ids that must KEEP passing — the proof the probe is narrow. */
  mustPass?: string[];
}

export const PROBES: Probe[] = [
  {
    name: "maxBonus back to 0.30 — the cap that absorbed the input-modality term",
    find: "  maxBonus: 0.35,",
    replace: "  maxBonus: 0.30,",
    mustFail: ["input-modality-breaks-the-tie"],
  },
  {
    name: "rank on the CLAMPED fusedFit instead of rankScore",
    find: ".sort((a, b) => (b.rankScore - a.rankScore) || a.name.localeCompare(b.name));",
    replace: ".sort((a, b) => (b.fusedFit - a.fusedFit) || a.name.localeCompare(b.name));",
    mustFail: ["saturated-pair-stays-decisive"],
  },
  {
    name: "margin computed on the CLAMPED value",
    find: "const margin = scored.length >= 2 ? Number((scored[0]!.rankScore - scored[1]!.rankScore).toFixed(4))",
    replace: "const margin = scored.length >= 2 ? Number((scored[0]!.fusedFit - scored[1]!.fusedFit).toFixed(4))",
    mustFail: ["saturated-pair-stays-decisive"],
  },
  {
    name: "rule 7 gates on the FUSED score, so labels alone buy a dispatch",
    find: "    && top.fit >= tuning.dispatchFit",
    replace: "    && top.fusedFit >= tuning.dispatchFit",
    mustFail: ["floor-only-no-dispatch"],
    mustPass: ["embedding-strength-dispatches"],
  },
  {
    name: "rule 5 stops at the first shortlisted workflow",
    find: "    if (candidate.family !== \"workflow\") continue;",
    replace: "    if (candidate.family !== \"workflow\") continue;\n    if (!workflowDispatchable(candidate, verdict).ok) break;",
    mustFail: ["workflow-second-choice-dispatched"],
    mustPass: ["workflow-params-satisfied-dispatches"],
  },
  {
    name: "rule 3 keeps the source-sensitivity flag on a document-grounded turn",
    find: "    return { ...decide(\"answer_direct\", reason), sourceSensitive: false };",
    replace: "    return decide(\"answer_direct\", reason);",
    mustFail: ["document-grounded-answers-directly"],
  },
  {
    name: "rule 4 ignores an attached link",
    find: "    && !flags.hasUrl\n    && !flags.hasAttachments",
    replace: "    && true\n    && true",
    mustFail: ["url-blocks-the-direct-answer"],
    mustPass: ["conceptual-question-not-captured-by-topic-agent"],
  },
  {
    name: "clarify ignores whether a candidate already covers the request",
    find: "    && (!top || top.fit < tuning.clarifyBlockingFit)",
    replace: "    && true",
    mustFail: ["clarify-suppressed-when-covered"],
    mustPass: ["clarify-when-nothing-covers-it"],
  },
  {
    name: "clarify ignores --auto, so it asks a question nobody is there to answer",
    find: "    && !flags.autonomous\n    && !flags.afterClarify",
    replace: "    && !flags.afterClarify",
    mustFail: ["autonomous-never-asks"],
  },
  {
    name: "a multi-part request always coordinates, even when one specialist covers every part",
    find: "    if (leaders.size > 1) return { coordinate: true, reason: `${verdict.parts.length} parts needing different specialists` };",
    replace: "    return { coordinate: true, reason: `${verdict.parts.length} parts needing different specialists` };",
    mustFail: ["multi-part-single-specialist-does-not-coordinate"],
    mustPass: ["two-domains-coordinate"],
  },
  {
    name: "workflow dispatch accepts the classifier's vote in place of deliverable agreement",
    find: "  if (verdict.deliverable === \"none\" || !taxonomy.deliverable.includes(verdict.deliverable)) {",
    replace: "  if (verdict.decision !== \"workflow\" && (verdict.deliverable === \"none\" || !taxonomy.deliverable.includes(verdict.deliverable))) {",
    mustFail: ["deck-hijack-refused"],
  },
  {
    name: "external-send workflows become dispatchable",
    find: "  if (taxonomy.riskTier === \"external_send\" || taxonomy.riskTier === \"mutating_external\") {",
    replace: "  if (false) {",
    mustFail: ["workflow-external-send-refused"],
    mustPass: ["workflow-user-channel-refused"],
  },
  {
    name: "user-channel workflows become dispatchable",
    find: "  if (taxonomy.surface.includes(\"user_channel\")) {",
    replace: "  if (false) {",
    mustFail: ["workflow-user-channel-refused"],
    mustPass: ["workflow-external-send-refused"],
  },
  {
    name: "required workflow parameters are not checked",
    find: "  if (candidate.paramsSatisfied === false) return { ok: false, reason: \"required parameters are not derivable\" };",
    replace: "",
    mustFail: ["workflow-params-unsatisfied-refused"],
    mustPass: ["workflow-params-satisfied-dispatches"],
  },
];

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(HERE, "..", "..");
const FUSION_PATH = join(CORE_ROOT, "src", "agent", "routing-fusion.ts");
const REPORT_PATH = join(CORE_ROOT, ".routing-discriminance-report.json");

function runEval(): Set<string> {
  try {
    execFileSync(process.execPath, [
      join(CORE_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
      join(CORE_ROOT, "src", "agent", "routing-eval-cli.ts"),
      "--json", REPORT_PATH,
    ], { cwd: CORE_ROOT, stdio: ["ignore", "ignore", "pipe"] });
  } catch {
    // A non-zero exit is the EXPECTED outcome of a probe. The report is what is read.
  }
  if (!existsSync(REPORT_PATH)) throw new Error("the eval produced no report — it could not run at all");
  const report = JSON.parse(readFileSync(REPORT_PATH, "utf8")) as {
    results: Array<{ id: string; scored: boolean; passed: boolean }>;
  };
  return new Set(report.results.filter((result) => result.scored && !result.passed).map((result) => result.id));
}

function workingTreeIsClean(): boolean {
  try {
    const status = execFileSync("git", ["status", "--porcelain", "--", FUSION_PATH], {
      cwd: CORE_ROOT, encoding: "utf8",
    });
    return status.trim().length === 0;
  } catch {
    // No git, or not a repo. The restore in `finally` is still the real safety net.
    return true;
  }
}

export function runDiscriminance(): number {
  if (!workingTreeIsClean()) {
    process.stderr.write(
      "Refusing to run: routing-fusion.ts has uncommitted changes.\n"
      + "This harness rewrites that file and restores it; starting from a modified copy would\n"
      + "bake your edits into the restore. Commit or stash first.\n",
    );
    return 1;
  }

  const original = readFileSync(FUSION_PATH, "utf8");
  const problems: string[] = [];
  try {
    const baseline = runEval();
    if (baseline.size > 0) {
      process.stderr.write(`Baseline is not green (${[...baseline].join(", ")}). Fix that first.\n`);
      return 1;
    }
    for (const probe of PROBES) {
      if (!original.includes(probe.find)) {
        // A stale anchor is the failure mode this repo has already shipped: the probe patches
        // nothing, every case keeps passing, and the harness reports confidence it never earned.
        problems.push(`ANCHOR MISSING — "${probe.name}" matched no source text, so it proved nothing`);
        process.stdout.write(`STALE ${probe.name}\n`);
        continue;
      }
      writeFileSync(FUSION_PATH, original.replace(probe.find, probe.replace), "utf8");
      let failed: Set<string>;
      try {
        failed = runEval();
      } finally {
        writeFileSync(FUSION_PATH, original, "utf8");
      }
      const missed = probe.mustFail.filter((id) => !failed.has(id));
      const broke = (probe.mustPass ?? []).filter((id) => failed.has(id));
      if (missed.length > 0) problems.push(`"${probe.name}": did NOT break ${missed.join(", ")}`);
      if (broke.length > 0) problems.push(`"${probe.name}": also broke its control ${broke.join(", ")}`);
      const verdict = missed.length === 0 && broke.length === 0 ? "OK   " : "WEAK ";
      process.stdout.write(`${verdict}${probe.name}\n       broke: ${[...failed].join(", ") || "nothing"}\n`);
    }
  } finally {
    writeFileSync(FUSION_PATH, original, "utf8");
    if (existsSync(REPORT_PATH)) unlinkSync(REPORT_PATH);
  }

  process.stdout.write(`\n${PROBES.length} probes.\n`);
  if (problems.length > 0) {
    process.stdout.write(`PROBLEMS:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n`);
    return 1;
  }
  process.stdout.write("Every probe broke exactly the case it was aimed at, and no control with it.\n");
  return 0;
}

const invokedDirectly = process.argv[1]
  && (process.argv[1].endsWith("routing-eval-discriminance.ts") || process.argv[1].endsWith("routing-eval-discriminance.js"));
if (invokedDirectly) {
  process.exitCode = runDiscriminance();
}
