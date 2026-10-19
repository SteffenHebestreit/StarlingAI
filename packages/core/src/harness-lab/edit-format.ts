/**
 * The edits a lab editor may propose, and the rules every one must pass before it runs.
 *
 * Two operations only, both small: append one rule to a prompt, or replace one exact span of it.
 * Every edit names the moment of the run it answers (digest.ts); an edit that cannot is
 * speculation. An editor owns one dimension: INV how the agent works, DOM what a practitioner
 * knows. And an edit goes into a prompt every turn reads, so it must not carry the task's own
 * facts: those are wrong anchors for the next task (taskFactScreen).
 */
import type { Digest } from "./digest.js";

export type EditorKind = "INV" | "DOM";

export const EDITOR_SCOPES: Record<EditorKind, readonly string[]> = {
  INV: ["procedure", "tool_use", "delegation", "completion"],
  DOM: ["deliverable_shape", "sources", "structure"],
};

export const MAX_EDITS_PER_EDITOR = 2;
export const MAX_EDIT_CHARS = 400;
export const MAX_REPLACE_GROWTH = 300;
/** add_skill: a procedure, loaded only on a turn its trigger matches, so it may run longer than a rule. */
export const MAX_SKILL_CHARS = 1_500;
/** The pseudo-target of add_skill edits: the skill library, not a prompt. */
export const SKILLS_TARGET = "skills";

export interface LabEdit {
  /** Stable within a run: "<editor>-<candidate>-<n>", e.g. "INV-t3-1". */
  id: string;
  editor: EditorKind;
  op: "append_rule" | "replace_span" | "add_skill";
  /** "main_assistant", a sub-agent's name, or SKILLS_TARGET for add_skill. */
  target: string;
  scope: string;
  text: string;
  /** replace_span only: the exact text it replaces, occurring once in the target's prompt. */
  find?: string;
  /** add_skill only: the skill's name and the one-line situation it applies to. */
  skillName?: string;
  whenToUse?: string;
  /** The moment of the reference run it answers, e.g. "M7". */
  moment: string;
  /** The experience entry it reuses, if any ("L12"): an example, re-verified by its own moment. */
  fromEntry?: string;
  why: string;
}

export interface EditContext {
  editor: EditorKind;
  idPrefix: string;
  digest: Digest;
  /** The prompts the editor may change, by target, as they are now. */
  prompts: Record<string, string>;
  /** Every word of the task the run was given: its messages and its deliverable. */
  taskText: string;
  /** Ids of the experience entries the editor was shown; an edit may name one of them. */
  libraryIds?: ReadonlySet<string>;
}

export type EditorOutcome =
  | { kind: "keep_base"; reason: string }
  | { kind: "edits"; edits: LabEdit[]; rejected: string[] }
  | { kind: "malformed"; reason: string };

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Why `text` would carry the task's own facts into a global prompt, or null. Language-independent:
 * a run of three words the task contains and the prompt does not, a number from the task, or an
 * address (mail, URL) from the task.
 */
export function taskFactScreen(text: string, taskText: string, prompt: string): string | null {
  const triples = (tokens: string[]) => {
    const out = new Set<string>();
    for (let i = 0; i + 2 < tokens.length; i += 1) out.add(tokens.slice(i, i + 3).join(" "));
    return out;
  };
  const taskWords = words(taskText);
  const taskTriples = triples(taskWords);
  // Compared as tokens on both sides: "user's" is "user s" in either.
  const promptTriples = triples(words(prompt));
  const own = words(text);
  for (let i = 0; i + 2 < own.length; i += 1) {
    const triple = own.slice(i, i + 3).join(" ");
    if (taskTriples.has(triple) && !promptTriples.has(triple)) return `repeats the task's words "${triple}"`;
  }
  const taskNumbers = new Set(taskWords.filter((w) => /\d/.test(w)));
  const number = own.find((w) => /\d/.test(w) && taskNumbers.has(w));
  if (number) return `carries the task's figure "${number}"`;
  const addresses = taskText.match(/[\w.+-]+@[\w-]+\.[\w.-]+|https?:\/\/\S+/g) ?? [];
  const address = addresses.find((a) => text.includes(a));
  if (address) return `carries the task's address "${address}"`;
  return null;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The JSON object in a model's answer: a fenced block, else the outermost braces. */
export function extractJsonObject(content: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
  const candidate = fenced?.[1] ?? (() => {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    return start >= 0 && end > start ? content.slice(start, end + 1) : undefined;
  })();
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The moment an edit cites, as an id the digest has ("M7", or the first of "M7–M9"), or null. */
function citedMoment(raw: unknown, digest: Digest): string | null {
  if (typeof raw !== "string") return null;
  const match = /M\s*(\d+)/i.exec(raw);
  if (!match) return null;
  const id = `M${match[1]}`;
  return digest.moments.has(id) ? id : null;
}

/** The entry an edit names, checked against the ones the editor was shown; undefined when none is named. */
function citedEntry(raw: Record<string, unknown>, index: number, ctx: EditContext): { fromEntry?: string } | string {
  const named = typeof raw["fromEntry"] === "string" ? raw["fromEntry"].trim() : "";
  if (!named) return {};
  if (!ctx.libraryIds?.has(named)) return `edit ${index + 1}: fromEntry "${named}" is not an entry you were shown`;
  return { fromEntry: named };
}

/** Validate one proposed edit; returns it, or why it was rejected. */
export function validateEdit(raw: Record<string, unknown>, index: number, ctx: EditContext): LabEdit | string {
  const op = raw["op"];
  if (op === "add_skill") return validateSkillEdit(raw, index, ctx);
  if (op !== "append_rule" && op !== "replace_span") return `edit ${index + 1}: op must be append_rule, replace_span or add_skill`;
  const target = typeof raw["target"] === "string" ? raw["target"].trim() : "";
  const prompt = ctx.prompts[target];
  if (prompt === undefined) return `edit ${index + 1}: target "${target}" is not one of ${Object.keys(ctx.prompts).join(", ")}`;
  const scope = typeof raw["scope"] === "string" ? raw["scope"].trim() : "";
  if (!EDITOR_SCOPES[ctx.editor].includes(scope)) return `edit ${index + 1}: scope must be one of ${EDITOR_SCOPES[ctx.editor].join(", ")}`;
  const moment = citedMoment(raw["moment"], ctx.digest);
  if (!moment) return `edit ${index + 1}: moment must name a moment of the run (M1…); an edit that cannot is speculation`;
  const text = typeof raw["text"] === "string" ? raw["text"].trim() : "";
  if (!text) return `edit ${index + 1}: text is empty`;
  if (text.length > MAX_EDIT_CHARS) return `edit ${index + 1}: text is ${text.length} characters, at most ${MAX_EDIT_CHARS}`;
  let find: string | undefined;
  if (op === "replace_span") {
    find = typeof raw["find"] === "string" ? raw["find"] : "";
    if (!find) return `edit ${index + 1}: replace_span needs the exact text to replace in "find"`;
    const occurrences = prompt.split(find).length - 1;
    if (occurrences !== 1) return `edit ${index + 1}: "find" occurs ${occurrences} times in ${target}'s prompt, it must occur exactly once`;
    if (text.length - find.length > MAX_REPLACE_GROWTH) return `edit ${index + 1}: the replacement grows the prompt by more than ${MAX_REPLACE_GROWTH} characters`;
  } else if (normalize(prompt).includes(normalize(text))) {
    return `edit ${index + 1}: the prompt already says this`;
  }
  const fact = taskFactScreen(text, ctx.taskText, prompt);
  if (fact) return `edit ${index + 1}: ${fact}; a rule every turn reads must hold for other tasks too`;
  const entry = citedEntry(raw, index, ctx);
  if (typeof entry === "string") return entry;
  const why = typeof raw["why"] === "string" ? raw["why"].trim().slice(0, 200) : "";
  return { id: `${ctx.idPrefix}-${index + 1}`, editor: ctx.editor, op, target, scope, text, ...(find !== undefined ? { find } : {}), moment, ...entry, why };
}

/** An add_skill edit: a new procedure for the skill library, loaded only where its trigger matches. */
function validateSkillEdit(raw: Record<string, unknown>, index: number, ctx: EditContext): LabEdit | string {
  const scope = typeof raw["scope"] === "string" ? raw["scope"].trim() : "";
  if (!EDITOR_SCOPES[ctx.editor].includes(scope)) return `edit ${index + 1}: scope must be one of ${EDITOR_SCOPES[ctx.editor].join(", ")}`;
  const moment = citedMoment(raw["moment"], ctx.digest);
  if (!moment) return `edit ${index + 1}: moment must name a moment of the run (M1…); an edit that cannot is speculation`;
  const skillName = typeof raw["name"] === "string" ? raw["name"].trim().slice(0, 80) : "";
  const whenToUse = typeof raw["whenToUse"] === "string" ? raw["whenToUse"].trim() : "";
  const text = typeof raw["text"] === "string" ? raw["text"].trim() : "";
  if (!skillName || !whenToUse || !text) return `edit ${index + 1}: add_skill needs a name, a whenToUse and the procedure in "text"`;
  if (whenToUse.length > 300) return `edit ${index + 1}: whenToUse is ${whenToUse.length} characters, at most 300`;
  if (text.length > MAX_SKILL_CHARS) return `edit ${index + 1}: the procedure is ${text.length} characters, at most ${MAX_SKILL_CHARS}`;
  const fact = taskFactScreen(`${whenToUse}
${text}`, ctx.taskText, "");
  if (fact) return `edit ${index + 1}: ${fact}; a skill is reused on other tasks of the same shape`;
  const entry = citedEntry(raw, index, ctx);
  if (typeof entry === "string") return entry;
  const why = typeof raw["why"] === "string" ? raw["why"].trim().slice(0, 200) : "";
  return { id: `${ctx.idPrefix}-${index + 1}`, editor: ctx.editor, op: "add_skill", target: SKILLS_TARGET, scope, text, skillName, whenToUse, moment, ...entry, why };
}

/** An editor's answer: keep the base, or its valid edits (at most MAX_EDITS_PER_EDITOR) and why the others failed. */
export function parseEditorOutput(content: string, ctx: EditContext): EditorOutcome {
  const raw = extractJsonObject(content);
  if (!raw) return { kind: "malformed", reason: "no JSON object in the answer" };
  if (raw["keepBase"] === true) {
    return { kind: "keep_base", reason: typeof raw["reason"] === "string" ? raw["reason"].slice(0, 300) : "" };
  }
  if (!Array.isArray(raw["edits"])) return { kind: "malformed", reason: "the answer has neither keepBase nor an edits array" };
  const edits: LabEdit[] = [];
  const rejected: string[] = [];
  for (const [index, entry] of (raw["edits"] as unknown[]).entries()) {
    if (index >= MAX_EDITS_PER_EDITOR) {
      rejected.push(`edit ${index + 1}: over the limit of ${MAX_EDITS_PER_EDITOR} edits`);
      continue;
    }
    if (!entry || typeof entry !== "object") {
      rejected.push(`edit ${index + 1}: not an object`);
      continue;
    }
    const result = validateEdit(entry as Record<string, unknown>, index, ctx);
    if (typeof result === "string") rejected.push(result);
    else edits.push(result);
  }
  return { kind: "edits", edits, rejected };
}

/** The prompts after `edits`, for the targets they change; a target no edit touches is left out. Skills are not prompts. */
export function applyEdits(prompts: Record<string, string>, edits: readonly LabEdit[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const edit of edits) {
    if (edit.op === "add_skill") continue;
    const current = out[edit.target] ?? prompts[edit.target] ?? "";
    if (edit.op === "append_rule") {
      out[edit.target] = current.trim() ? `${current.trimEnd()}\n${edit.text}` : edit.text;
    } else if (edit.find !== undefined && current.includes(edit.find)) {
      // A function, so "$&" or "$1" in the new text stays literal.
      out[edit.target] = current.replace(edit.find, () => edit.text);
    }
  }
  return out;
}
