/**
 * The composer: reads what each candidate's edits did when its probes ran the same task, and keeps,
 * trims or drops each edit, one decision per edit with the evidence it rests on. Keeping none is a
 * valid outcome. Rules a model is not trusted with are applied around it: an edit whose probes
 * delivered nothing is UNSAFE and dropped before the composer sees it; a "revised" edit may only get
 * shorter and must still pass every edit rule; at most MAX_COMPOSED edits survive.
 */
import { extractJsonObject, type LabEdit } from "./edit-format.js";
import type { LabComplete } from "./lab-config.js";
import type { RunScore } from "./scoring.js";
import type { LabRunRecord } from "./turn-runner.js";

export const MAX_COMPOSED = 3;

export interface ComposerCandidate {
  label: string;
  edits: LabEdit[];
  probes: Array<{ record: LabRunRecord; score: RunScore }>;
}

export interface ComposerRow {
  decision: "kept" | "revised" | "dropped";
  edit: string;
  evidence: string;
  unsafe?: boolean;
}

export interface ComposeResult {
  rows: ComposerRow[];
  edits: LabEdit[];
}

/** A probe in a few lines: delivered or not, the checks it failed, its reply. */
export function summarizeRun(record: LabRunRecord, score: RunScore): string {
  const lines = [`delivered: ${score.delivered ? "yes" : "NO"}; checks failed: ${score.checksFailed}; recorded defects: ${score.recordedDefects}${score.unscored ? "; UNSCORED" : ""}`];
  for (const turn of record.turns) {
    for (const failure of turn.checkFailures) lines.push(`  check failed: ${failure.slice(0, 200)}`);
    lines.push(`  reply: ${turn.reply.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  return lines.join("\n");
}

const SYSTEM = `You compose candidate edits to an AI agent swarm's prompts from the evidence of their probe runs. Each candidate's edits were run on the same task as the reference; you see what each probe delivered.

Rules:
- One decision per edit: "kept", "revised" (only to make it shorter or more general, never to add) or "dropped".
- Every decision names its evidence: the probe result or the reference moment it rests on.
- Each candidate ran only a few times: one good or bad run is weak evidence. A defect in one run of several is noise; an edit aimed at it is overfitting.
- Agreement between candidates is support, not proof. Weigh the downside of an edit as heavily as its upside.
- Keeping no edit at all is a valid and common answer.

Answer with JSON only:
{"rows": [{"decision": "kept" | "revised" | "dropped", "edit": "<edit id>", "evidence": "<one sentence>", "text": "<revised text, only for revised>"}]}`;

export interface ComposeInput {
  referenceSummary: string;
  referenceDigest: string;
  candidates: ComposerCandidate[];
  /** Re-checks a revised edit against the edit rules; returns it, or why it fails. */
  revalidate: (edit: LabEdit, text: string) => LabEdit | string;
}

export async function compose(input: ComposeInput, complete: LabComplete): Promise<ComposeResult> {
  const rows: ComposerRow[] = [];
  const open: LabEdit[] = [];
  for (const candidate of input.candidates) {
    const scored = candidate.probes.filter((probe) => !probe.score.unscored);
    const deliveredNothing = scored.length > 0 && scored.every((probe) => !probe.score.delivered);
    for (const edit of candidate.edits) {
      if (deliveredNothing) rows.push({ decision: "dropped", edit: edit.id, evidence: "every probe of its candidate delivered nothing", unsafe: true });
      else open.push(edit);
    }
  }
  if (open.length === 0) return { rows, edits: [] };

  const user = [
    `## Reference run\n${input.referenceSummary}\n\n${input.referenceDigest}`,
    ...input.candidates.map((candidate) => {
      const edits = candidate.edits.filter((edit) => open.includes(edit))
        .map((edit) => `- ${edit.id} [${edit.op} → ${edit.target}, ${edit.scope}, answers ${edit.moment}]: ${edit.text}${edit.find ? ` (replaces: "${edit.find.slice(0, 200)}")` : ""}`);
      if (edits.length === 0) return "";
      const probes = candidate.probes.map((probe, i) => `Probe ${i + 1}:\n${summarizeRun(probe.record, probe.score)}`);
      return `## Candidate ${candidate.label}\nEdits:\n${edits.join("\n")}\n${probes.join("\n")}`;
    }).filter(Boolean),
  ].join("\n\n");

  const raw = extractJsonObject(await complete("composer", SYSTEM, user));
  const answered = new Map<string, Record<string, unknown>>();
  for (const row of Array.isArray(raw?.["rows"]) ? raw["rows"] as unknown[] : []) {
    if (row && typeof row === "object" && typeof (row as Record<string, unknown>)["edit"] === "string") {
      answered.set((row as Record<string, unknown>)["edit"] as string, row as Record<string, unknown>);
    }
  }

  const kept: LabEdit[] = [];
  for (const edit of open) {
    const row = answered.get(edit.id);
    const evidence = typeof row?.["evidence"] === "string" ? (row["evidence"] as string).slice(0, 300) : "";
    const decision = row?.["decision"];
    if (decision === "kept") {
      kept.push(edit);
      rows.push({ decision: "kept", edit: edit.id, evidence });
    } else if (decision === "revised") {
      const text = typeof row?.["text"] === "string" ? (row["text"] as string).trim() : "";
      const revised = text && text.length <= edit.text.length ? input.revalidate(edit, text) : "a revision may only shorten the edit";
      if (typeof revised === "string") rows.push({ decision: "dropped", edit: edit.id, evidence: `revision refused: ${revised}` });
      else {
        kept.push(revised);
        rows.push({ decision: "revised", edit: edit.id, evidence });
      }
    } else {
      rows.push({ decision: "dropped", edit: edit.id, evidence: evidence || "the composer gave no decision" });
    }
  }
  for (const edit of kept.slice(MAX_COMPOSED)) {
    const row = rows.find((r) => r.edit === edit.id);
    if (row) Object.assign(row, { decision: "dropped", evidence: `over the limit of ${MAX_COMPOSED} edits` });
  }
  return { rows, edits: kept.slice(0, MAX_COMPOSED) };
}

/** A row as the report and the proposal print it. */
export function formatRow(row: ComposerRow): string {
  return `${row.decision} -> ${row.edit} -> ${row.unsafe ? "UNSAFE " : ""}${row.evidence}`;
}
