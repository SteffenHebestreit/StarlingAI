/**
 * The edits a lab editor may propose, and the rules every one must pass before it runs.
 *
 * Small operations only: append one rule to a prompt, replace one exact span of it, add a skill, or
 * (the INV editor) add an enforcement hook, one of three fixed actions on a tool's calls.
 * Every edit names the moment of the run it answers (digest.ts); an edit that cannot is
 * speculation. An editor owns one dimension: INV how the agent works, DOM what a practitioner
 * knows. And an edit goes into a prompt every turn reads, so it must not carry the task's own
 * facts: those are wrong anchors for the next task (taskFactScreen).
 */
import { EnforcementHookSchema, type EnforcementHook } from "../config/schema.js";
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
/** The pseudo-target of add_hook edits: the enforcement hooks (tools/enforcement-hooks.ts). */
export const HOOKS_TARGET = "hooks";

export interface LabEdit {
  /** Stable within a run: "<editor>-<candidate>-<n>", e.g. "INV-t3-1". */
  id: string;
  editor: EditorKind;
  op: "append_rule" | "replace_span" | "add_skill" | "add_hook";
  /** "main_assistant", a sub-agent's name, SKILLS_TARGET for add_skill, HOOKS_TARGET for add_hook. */
  target: string;
  scope: string;
  text: string;
  /** replace_span only: the exact text it replaces, occurring once in the target's prompt. */
  find?: string;
  /** add_skill only: the skill's name and the one-line situation it applies to. */
  skillName?: string;
  whenToUse?: string;
  /** add_hook only: the hook and the id it is proposed under. */
  hook?: EnforcementHook;
  hookId?: string;
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
  /** The tools the run called: an add_hook edit watches at least one of them. */
  toolNames?: ReadonlySet<string>;
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

/** Share of the shorter rule's content words the other one has too, above which two rules are one. */
export const RULE_OVERLAP = 0.6;
const RULE_OVERLAP_MIN_WORDS = 4;

/** A rule's content words, with a trailing plural "s" dropped: "diagrams" and "diagram" are one. */
function ruleWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (word.length < 4) continue;
    words.add(word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);
  }
  return words;
}

/**
 * Two appended rules that say the same thing in other words (the first accepted proposal, 2026-10-19,
 * appended two lines that both sent diagram requests to diagram_designer: 8 of the shorter one's 11
 * content words were in the other). Null below RULE_OVERLAP.
 */
export function ruleOverlap(a: string, b: string): number | null {
  const wa = ruleWords(a);
  const wb = ruleWords(b);
  const smaller = Math.min(wa.size, wb.size);
  if (smaller < RULE_OVERLAP_MIN_WORDS) return null;
  let shared = 0;
  for (const word of wa) if (wb.has(word)) shared += 1;
  const overlap = shared / smaller;
  return overlap >= RULE_OVERLAP ? overlap : null;
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
  if (op === "add_hook") return validateHookEdit(raw, index, ctx);
  if (op !== "append_rule" && op !== "replace_span") return `edit ${index + 1}: op must be append_rule, replace_span, add_skill or add_hook`;
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

/**
 * An add_hook edit (the INV editor's): one enforcement hook, watching a tool the run called. A hint
 * must hold for other tasks (the task's own facts are refused, as in a rule), a pattern must compile,
 * and a cap leaves the tool at least one call: taking a tool away is a person's decision.
 */
function validateHookEdit(raw: Record<string, unknown>, index: number, ctx: EditContext): LabEdit | string {
  if (ctx.editor !== "INV") return `edit ${index + 1}: add_hook is an INV edit (how the agent works with its tools)`;
  const scope = typeof raw["scope"] === "string" ? raw["scope"].trim() : "";
  if (!EDITOR_SCOPES[ctx.editor].includes(scope)) return `edit ${index + 1}: scope must be one of ${EDITOR_SCOPES[ctx.editor].join(", ")}`;
  const moment = citedMoment(raw["moment"], ctx.digest);
  if (!moment) return `edit ${index + 1}: moment must name a moment of the run (M1…); an edit that cannot is speculation`;
  const parsed = EnforcementHookSchema.safeParse(raw["hook"]);
  if (!parsed.success) return `edit ${index + 1}: hook is not a valid enforcement hook (${parsed.error.issues[0]?.message ?? "invalid"})`;
  const hook = parsed.data;
  if (ctx.toolNames && !hook.tools.some((tool) => ctx.toolNames!.has(tool))) {
    return `edit ${index + 1}: the hook watches no tool the run called (${hook.tools.join(", ")})`;
  }
  const unknownAgent = (hook.agents ?? []).find((agent) => ctx.prompts[agent] === undefined);
  if (unknownAgent) return `edit ${index + 1}: agent "${unknownAgent}" is not one of ${Object.keys(ctx.prompts).join(", ")}`;
  if (hook.action === "cap_tool" && hook.maxCalls < 1) return `edit ${index + 1}: a cap leaves the tool at least one call`;
  if (hook.action === "append_hint" && hook.errorMatches) {
    try { new RegExp(hook.errorMatches, "i"); } catch { return `edit ${index + 1}: errorMatches is not a regular expression`; }
  }
  const words = [hook.action === "append_hint" ? hook.hint : "", hook.action === "cap_tool" ? hook.message ?? "" : ""].join("\n").trim();
  const fact = words ? taskFactScreen(words, ctx.taskText, "") : null;
  if (fact) return `edit ${index + 1}: ${fact}; a hook acts on other tasks too`;
  const text = typeof raw["text"] === "string" && raw["text"].trim() ? raw["text"].trim().slice(0, MAX_EDIT_CHARS) : `${hook.action} on ${hook.tools.join(", ")}`;
  const entry = citedEntry(raw, index, ctx);
  if (typeof entry === "string") return entry;
  const why = typeof raw["why"] === "string" ? raw["why"].trim().slice(0, 200) : "";
  const hookId = `lab-${ctx.idPrefix}-${index + 1}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return {
    id: `${ctx.idPrefix}-${index + 1}`, editor: ctx.editor, op: "add_hook", target: HOOKS_TARGET, scope, text,
    hook: { ...hook, description: hook.description ?? text }, hookId, moment, ...entry, why,
  };
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
    if (edit.op === "add_skill" || edit.op === "add_hook") continue;
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
