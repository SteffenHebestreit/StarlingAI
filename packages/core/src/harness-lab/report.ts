/**
 * The run report: report.json (everything but the runs' audit rows, which stay in runs/*.json) and
 * report.md for a person deciding whether to apply the proposal.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatRow } from "./composer.js";
import type { CycleResult } from "./cycle.js";
import type { LabEdit } from "./edit-format.js";
import { cueText, type ExperienceEntry } from "./library.js";
import type { EmitResult } from "./proposal.js";
import { scoreRun, type RunScore } from "./scoring.js";
import type { LabRunRecord } from "./turn-runner.js";

export interface RunProvenance {
  runId: string;
  startedAt: string;
  finishedAt: string;
  gitRevision: string;
  gitDirty: boolean;
  models: Record<string, string>;
  isolatedStores: string[];
  deniedTools: string[];
  stubbedTools: string[];
  corpus: { tasks: number; skipped: Array<{ file: string; reason: string }> };
  warnings: string[];
}

export interface LabReport {
  provenance: RunProvenance;
  cycle: CycleResult;
  proposal?: EmitResult;
  dryRun: boolean;
  library?: { dir: string; written: ExperienceEntry[]; drawn: number };
}

/** A candidate skill as the Skills page takes it. */
export function skillMarkdown(edit: LabEdit): string {
  return [`---`, `name: ${edit.skillName ?? edit.id}`, `description: ${edit.whenToUse ?? ""}`, `whenToUse: ${edit.whenToUse ?? ""}`, `---`, ``, edit.text].join("\n");
}

function scoreText(score: RunScore): string {
  if (score.unscored) return "unscored";
  return `${score.delivered ? "delivered" : "NOT delivered"}, ${score.checksFailed} check(s) failed, ${score.recordedDefects} recorded defect(s)`;
}

function editText(edit: LabEdit): string {
  return `${edit.id} [${edit.op} → ${edit.target}, ${edit.scope}, answers ${edit.moment}]: ${edit.text}${edit.find ? `\n    replaces: ${edit.find}` : ""}${edit.why ? `\n    why: ${edit.why}` : ""}`;
}

/** The records without their audit rows, which can run to thousands per attempt. */
function slim(record: LabRunRecord): unknown {
  return { ...record, turns: record.turns.map(({ events, ...turn }) => ({ ...turn, events: events.length })) };
}

export function renderMarkdown(report: LabReport): string {
  const { provenance: p, cycle } = report;
  const lines: string[] = [
    `# Harness lab run ${p.runId}`,
    "",
    `${p.startedAt} → ${p.finishedAt} · git ${p.gitRevision}${p.gitDirty ? " (dirty)" : ""}${report.dryRun ? " · DRY RUN" : ""}`,
    `Models: ${Object.entries(p.models).map(([role, model]) => `${role} ${model}`).join(", ")}`,
    `Isolated from: ${p.isolatedStores.join(", ") || "nothing configured"} · tools left out: ${p.deniedTools.length} · stubbed: ${p.stubbedTools.length}`,
    ...p.warnings.map((w) => `> ⚠ ${w}`),
    "",
    "## Screen",
    ...cycle.screen.map((s) => `- ${s.taskId}: ${scoreText(s.score)}`),
    "",
    `Targets: ${cycle.targets.join(", ") || "none"} · guards: ${cycle.guards.join(", ") || "none"}`,
  ];
  for (const work of cycle.tasks) {
    lines.push("", `## Task ${work.taskId}: ${work.outcome.toUpperCase()}`, work.reason);
    lines.push(...work.references.map((r, i) => `- reference ${i + 1}: ${scoreText(scoreRun(r))}`));
    for (const editor of work.editors) {
      const o = editor.outcome;
      lines.push(`- ${editor.kind}: ${o.kind === "keep_base" ? `keep base — ${o.reason}` : o.kind === "malformed" ? `malformed — ${o.reason}` : `${o.edits.length} edit(s)${o.rejected.length ? `, ${o.rejected.length} rejected: ${o.rejected.join("; ")}` : ""}`}${editor.repaired ? ` (after a repair round: ${editor.repaired.join("; ")})` : ""}`);
      if (o.kind === "edits") for (const edit of o.edits) lines.push(`  - ${editText(edit)}`);
    }
    for (const row of work.composed?.rows ?? []) lines.push(`- composer: ${formatRow(row)}`);
    for (const [i, pair] of work.pairs.entries()) lines.push(`- pair ${i + 1}: base ${scoreText(pair.base)} | candidate ${scoreText(pair.candidate)}${pair.selector ? ` | selector: ${pair.selector}` : ""}`);
  }
  lines.push("", "## Merged edits", ...(cycle.merged.length ? cycle.merged.map((e) => `- ${editText(e)}`) : ["none"]));
  if (cycle.mergeDropped.length) lines.push(...cycle.mergeDropped.map((d) => `- dropped in the merge: ${d}`));
  if (cycle.gate) {
    lines.push("", `## Gate: ${cycle.gate.verdict.toUpperCase()} (${cycle.gate.evidence} evidence)`, ...cycle.gate.reasons.map((r) => `- ${r}`));
    lines.push("", "| task | role | won | lost | tied | unscored | selector |", "|---|---|---|---|---|---|---|");
    for (const t of cycle.gate.tallies) lines.push(`| ${t.taskId} | ${t.role} | ${t.wins} | ${t.losses} | ${t.ties} | ${t.unscored} | ${t.selectorWins}:${t.selectorLosses} |`);
    lines.push("", `Unscored ${Math.round(cycle.gate.unscoredRate * 100)}% · sign test p ${cycle.gate.signTestP === null ? "n/a" : cycle.gate.signTestP.toFixed(3)} (reported, not deciding)`);
  }
  const skills = cycle.merged.filter((e) => e.op === "add_skill");
  if (skills.length > 0) {
    lines.push("", "## Skill candidates", "Not part of the proposal: if the gate accepted, add them on the Skills page.");
    for (const edit of skills) lines.push("", `### ${edit.skillName ?? edit.id}`, "```markdown", skillMarkdown(edit), "```");
  }
  const hooks = cycle.merged.filter((e) => e.op === "add_hook" && e.hook);
  if (hooks.length > 0) {
    lines.push("", "## Enforcement hooks", "Part of the proposal as config changes under enforcementHooks (tools/enforcement-hooks.ts).");
    for (const edit of hooks) lines.push("", `### ${edit.hookId ?? edit.id}`, "```json", JSON.stringify(edit.hook, null, 2), "```");
  }
  if (cycle.reflections.length > 0) {
    lines.push("", "## Experience");
    for (const r of cycle.reflections) {
      lines.push("noEntry" in r.reflection
        ? `- ${r.taskId}: no entry (${r.reflection.noEntry})`
        : `- ${r.taskId}: [${r.reflection.confidence}] (${r.reflection.component}) when ${cueText(r.reflection.cue)} → ${r.reflection.lesson}`);
    }
    if (report.library) lines.push(`Written to the library: ${report.library.written.map((e) => `${e.id} (${e.verdict})`).join(", ") || "nothing"}${report.dryRun ? " (dry run)" : ""}`);
  }
  lines.push("", "## Outcome");
  if (report.proposal && "proposal" in report.proposal) {
    lines.push(`Pending proposal **${report.proposal.proposal.id}**: apply it in Settings → Config Assistant after reading the edits above.`);
  } else if (report.proposal) {
    lines.push(`No proposal: ${report.proposal.refused}.`);
  } else {
    lines.push(report.dryRun ? "Dry run: no proposal written." : "No proposal: nothing passed.");
  }
  const h = cycle.health;
  const validity = h.editorValidEdits + h.editorRejectedEdits > 0 ? h.editorValidEdits / (h.editorValidEdits + h.editorRejectedEdits) : null;
  const firstShare = h.nonTiePicks > 0 ? h.firstPositionPicks / h.nonTiePicks : null;
  lines.push(
    "",
    "## Health",
    `- editor edits valid: ${validity === null ? "n/a" : `${Math.round(validity * 100)}%`}${validity !== null && validity < 0.5 ? " ⚠ below 50%: consider a stronger model for the editor role" : ""}`,
    `- selector consistent: ${h.selectorCalls ? `${h.selectorConsistent}/${h.selectorCalls}` : "n/a"}; first position picked ${firstShare === null ? "n/a" : `${Math.round(firstShare * 100)}%`}${firstShare !== null && firstShare > 0.7 ? " ⚠ position bias" : ""}`,
  );
  return `${lines.join("\n")}\n`;
}

export function writeReport(outDir: string, report: LabReport): void {
  const json = {
    ...report,
    cycle: {
      ...report.cycle,
      tasks: report.cycle.tasks.map((work) => ({
        ...work,
        references: work.references.map(slim),
        probes: work.probes.map((probe) => ({ ...probe, runs: probe.runs.map(slim) })),
        composedRuns: work.composedRuns.map(slim),
      })),
    },
  };
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(json, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "report.md"), renderMarkdown(report), "utf8");
}
