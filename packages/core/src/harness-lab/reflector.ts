/**
 * The experience reflector: after a task, at most one durable lesson about improving the harness,
 * and only if the run's contrasts support it; otherwise no entry. The cue describes the shape of
 * situation the lesson applies to, never the task's facts (the same screen the edits pass). A
 * lesson whose evidence is only confounded changes is narrowed or declined, and "high" confidence
 * is kept only for a task the candidate won on the record.
 */
import { extractJsonObject, taskFactScreen } from "./edit-format.js";
import { formatRow, summarizeRun } from "./composer.js";
import { taskText } from "./editors.js";
import type { TaskWork } from "./cycle.js";
import type { LabComplete } from "./lab-config.js";
import type { ExperienceEntry } from "./library.js";
import { compareScores, scoreRun } from "./scoring.js";
import type { HarnessTask } from "./task-schema.js";

export type Reflection = Pick<ExperienceEntry, "cue" | "component" | "lesson" | "evidence" | "confidence">;

const SYSTEM = `You keep the experience library of a lab that improves an AI agent swarm's prompts. A task was just run on the current prompts and on candidate edits; you see each edit, what its probe runs did, and the composer's decisions.

Write AT MOST ONE durable lesson, and only if the runs support it: a transferable way to improve the harness, naming the component it concerns. If there is no concrete, reusable contrast, answer {"noEntry": "<why>"} instead.
- "cue": the SHAPE of situation the lesson applies to, never this task's names, figures or wording. Too generic is useless ("be thorough"); too specific never applies again.
- "evidence": the edit decisions or probe results it rests on, copied from what you see.
- Several components changed at once with no run separating them is confounded: narrow the lesson to what the runs do show, or decline.
- Adoption alone never shows that an edit helped.

Answer with JSON only:
{"cue": "...", "component": "main_assistant" | "<sub-agent>" | "skills", "lesson": "...", "evidence": ["...", "..."], "confidence": "high" | "medium" | "low"}
or {"noEntry": "<why>"}`;

export function buildReflectorMessage(task: HarnessTask, work: TaskWork): string {
  const sections = [`## Task (domain ${task.domain})\n${task.turns.map((t, i) => `Turn ${i + 1}: ${t.message}`).join("\n")}`];
  for (const probe of work.probes) {
    sections.push(`## Candidate ${probe.label}\n${probe.edits.map((e) => `- ${e.id} [${e.op} → ${e.target}]: ${e.text}`).join("\n")}\n${probe.runs.map((r, i) => `Probe ${i + 1}: ${summarizeRun(r, scoreRun(r))}`).join("\n")}`);
  }
  if (work.composed) sections.push(`## Composer\n${work.composed.rows.map(formatRow).join("\n")}`);
  if (work.pairs.length > 0) {
    sections.push(`## Composed harness against the reference\n${work.pairs.map((p, i) => `Pair ${i + 1}: ${["candidate worse", "tied", "candidate better"][compareScores(p.candidate, p.base) + 1]}${p.selector ? `, selector: ${p.selector}` : ""}`).join("\n")}`);
  }
  sections.push(`## Outcome\n${work.outcome}: ${work.reason}`);
  return sections.join("\n\n");
}

/** Validate a reflector answer: a reflection, or why there is none. */
export function parseReflection(content: string, task: HarnessTask, work: TaskWork): Reflection | { noEntry: string } {
  const raw = extractJsonObject(content);
  if (!raw) return { noEntry: "no JSON in the answer" };
  if (typeof raw["noEntry"] === "string") return { noEntry: raw["noEntry"].slice(0, 300) };
  const cue = typeof raw["cue"] === "string" ? raw["cue"].trim().slice(0, 300) : "";
  const lesson = typeof raw["lesson"] === "string" ? raw["lesson"].trim().slice(0, 400) : "";
  const component = typeof raw["component"] === "string" ? raw["component"].trim().slice(0, 80) : "";
  const evidence = Array.isArray(raw["evidence"])
    ? (raw["evidence"] as unknown[]).filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.trim().slice(0, 200)).slice(0, 5)
    : [];
  if (!cue || !lesson || !component) return { noEntry: "the answer lacks a cue, a lesson or a component" };
  if (evidence.length === 0) return { noEntry: "the lesson cites no evidence" };
  const fact = taskFactScreen(`${cue}\n${lesson}`, taskText(task), "");
  if (fact) return { noEntry: `the lesson ${fact}` };
  const asked = raw["confidence"];
  let confidence: Reflection["confidence"] = asked === "high" || asked === "medium" ? asked : "low";
  // "high" only where the record shows it: the composed harness won its task on deterministic pairs.
  const recordWin = work.outcome === "win" && work.pairs.some((p) => compareScores(p.candidate, p.base) > 0);
  if (confidence === "high" && !recordWin) confidence = "medium";
  return { cue, lesson, component, evidence, confidence };
}

export async function reflect(task: HarnessTask, work: TaskWork, complete: LabComplete): Promise<Reflection | { noEntry: string }> {
  if (work.probes.length === 0) return { noEntry: "no candidate was probed" };
  return parseReflection(await complete("reflector", SYSTEM, buildReflectorMessage(task, work)), task, work);
}
