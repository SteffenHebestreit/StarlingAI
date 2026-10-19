/**
 * The two scoped editors. Each reads the reference run of a task and proposes at most two small
 * edits to the prompts that ran, in its own dimension only, or keeps the base:
 * - INV, how the agent works: procedure, tool use, delegation, completion. No domain rules.
 * - DOM, what a practitioner knows: the deliverable's shape, its sources, its structure. Nothing
 *   about commands, retries or tool errors.
 * Keeping the two apart is what makes their edits worth comparing (Harness²'s ablation: the scoped
 * editors carried up to 3.7 points). An answer that breaks the edit rules gets one repair round
 * with the rule it broke, then counts as keeping the base.
 */
import type { Digest } from "./digest.js";
import { EDITOR_SCOPES, MAX_EDITS_PER_EDITOR, MAX_EDIT_CHARS, MAX_SKILL_CHARS, parseEditorOutput, type EditorKind, type EditorOutcome } from "./edit-format.js";
import type { LabComplete } from "./lab-config.js";
import type { HarnessTask } from "./task-schema.js";

/** A prompt is shown in full up to this length; past it, only appending to it is possible. */
const PROMPT_SHOWN_CHARS = 6_000;

export interface EditorInput {
  task: HarnessTask;
  /** The reference run the edits answer, as moments. */
  digest: Digest;
  /** Checks the other reference run failed, if it failed differently. */
  otherRunFailures: string[];
  /** The prompts the editor may change, by target ("main_assistant" or a sub-agent that ran). */
  prompts: Record<string, string>;
  /** The experience library's index, when there is one: one line per entry, starting with its id. */
  libraryIndex?: string;
}

const DIMENSION: Record<EditorKind, string> = {
  INV: `You own HOW the agent works: its procedure, its tool use, its delegation, how it completes. You do NOT add domain rules, required sections or subject-matter facts.
Map each failure to the cheapest fix: one procedural rule where the run went wrong.`,
  DOM: `You own WHAT a practitioner knows: the shape of the deliverable the user needs, the sources it must rest on, its structure. You do NOT diagnose commands, retries, tool errors, reading order or delegation.
Never invent an authority, a standard, an identifier or a citation.`,
};

export function buildEditorSystemPrompt(kind: EditorKind): string {
  return `You improve the prompts of an AI agent swarm from evidence. One task was run on the current prompts; you see that run as numbered moments (M1, M2, …).
${DIMENSION[kind]}

Rules:
- Every edit names the moment (M#) where the prompts caused or allowed the defect. If you cannot name the moment, the edit is speculation: leave it out.
- Prefer, in this order: a divergence from what the task asked, a repeated concrete failure, a visible risk.
- The prompts are read on EVERY future turn: a rule must hold for other tasks of the same kind. Never copy the task's names, figures, addresses or wording into a rule.
- Keeping the base is the right answer when the run failed for reasons no prompt controls (the model's noise, a broken tool, an ambiguous task) or when it did not fail at all.
- At most ${MAX_EDITS_PER_EDITOR} edits. "append_rule" adds one rule (at most ${MAX_EDIT_CHARS} characters) at the end of a prompt; "replace_span" replaces text that occurs exactly once in it (copy it exactly into "find"); "add_skill" adds a multi-step procedure (at most ${MAX_SKILL_CHARS} characters, target "skills") that is loaded only on turns matching its whenToUse: use it for a procedure, a rule for a one-line habit.
- scope is one of: ${EDITOR_SCOPES[kind].join(", ")}.

Answer with JSON only, one of:
{"keepBase": true, "reason": "<one sentence>"}
{"edits": [{"op": "append_rule" | "replace_span" | "add_skill", "target": "<prompt name, or skills>", "scope": "<scope>", "text": "<the rule, the new text, or the procedure>", "find": "<replace_span only>", "name": "<add_skill only>", "whenToUse": "<add_skill only: the shape of situation, not this task>", "moment": "M7", "fromEntry": "<only if it reuses an experience entry: its id>", "why": "<one sentence>"}]}`;
}

export function buildEditorUserMessage(input: EditorInput): string {
  const { task } = input;
  const prompts = Object.entries(input.prompts).map(([name, text]) => {
    const shown = text.length > PROMPT_SHOWN_CHARS
      ? `${text.slice(0, PROMPT_SHOWN_CHARS)}\n… (cut: ${text.length - PROMPT_SHOWN_CHARS} more characters; use append_rule for this prompt)`
      : text || "(empty)";
    return `### ${name}\n${shown}`;
  }).join("\n\n");
  const sections = [
    `## Task\n${task.turns.map((turn, i) => `Turn ${i + 1}: ${turn.message}`).join("\n")}`,
    ...(task.deliverable ? [`## What a good result is\n${task.deliverable.kind}: ${task.deliverable.shape}`] : []),
    `## The run (reference)\n${input.digest.text}`,
    ...(input.otherRunFailures.length > 0 ? [`## A second run of the same task failed these checks\n${input.otherRunFailures.map((f) => `- ${f}`).join("\n")}`] : []),
    ...(input.libraryIndex ? [`## Experience from earlier tasks (examples, not facts about this one: re-verify against this run before you use one, and name its id)\n${input.libraryIndex}`] : []),
    `## Prompts you may change\n${prompts}`,
  ];
  return sections.join("\n\n");
}

export interface EditorResult {
  kind: EditorKind;
  outcome: EditorOutcome;
  /** Rejection reasons from the first answer, when it needed a repair round. */
  repaired?: string[];
}

/** Ask one editor. A malformed answer, or one whose every edit broke a rule, gets one repair round. */
export async function proposeEdits(kind: EditorKind, input: EditorInput, idPrefix: string, complete: LabComplete): Promise<EditorResult> {
  const libraryIds = new Set((input.libraryIndex ?? "").split("\n").map((line) => /^(L\d+)\b/.exec(line)?.[1]).filter((id): id is string => Boolean(id)));
  const ctx = { editor: kind, idPrefix, digest: input.digest, prompts: input.prompts, taskText: taskText(input.task), libraryIds };
  const system = buildEditorSystemPrompt(kind);
  const user = buildEditorUserMessage(input);
  const first = parseEditorOutput(await complete("editor", system, user), ctx);
  const problems = first.kind === "malformed" ? [first.reason] : first.kind === "edits" && first.edits.length === 0 ? first.rejected : [];
  if (problems.length === 0) return { kind, outcome: first };
  const retry = `${user}\n\n## Your previous answer could not be used\n${problems.map((p) => `- ${p}`).join("\n")}\nAnswer again, following the rules, or keep the base.`;
  const second = parseEditorOutput(await complete("editor", system, retry), ctx);
  if (second.kind === "malformed" || (second.kind === "edits" && second.edits.length === 0)) {
    return { kind, outcome: { kind: "keep_base", reason: "no usable edit after one repair round" }, repaired: problems };
  }
  return { kind, outcome: second, repaired: problems };
}

/** Every word of a task: its messages and what a good result is. */
export function taskText(task: HarnessTask): string {
  return [...task.turns.map((turn) => turn.message), task.deliverable?.shape ?? "", ...(task.deliverable?.sources ?? [])].join("\n");
}
