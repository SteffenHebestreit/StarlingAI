/**
 * Per-delegation language normalization — "work internally in English; deliver in the
 * user's language."
 *
 * The user's directive (2026-06-19): the swarm should do its internal work — routing,
 * tool-argument matching, reasoning — in English, and switch to the user's language only
 * for the final user-facing content. Doing so makes the bilingual keyword regexes
 * obsolete by construction and gives the English-only agent catalog a same-language
 * routing query.
 *
 * This module normalizes the delegated TASK (the instruction that drives routing + the
 * sub-agent's work) to English, and appends an explicit OUTPUT-LANGUAGE directive so the
 * deliverable still comes back in the language the user wants. The `context` block is left
 * VERBATIM on purpose — it carries gathered evidence / source quotes whose exact wording
 * matters for citation, and a sub-agent reasoning in English can read non-English evidence
 * fine.
 *
 * THE OUTPUT LANGUAGE IS NOT THE TASK'S LANGUAGE. The task is the orchestrator's paraphrase:
 * it may already be English for a German speaker, and it may name a language of its own
 * ("write the cover letter in English"). Deriving the directive from the task's language
 * therefore did two wrong things — no directive at all for an English paraphrase of a German
 * request, and "write it in German" on top of a task that said "in English". The same
 * translate call now also returns the output language, judged from the task AND the user's own
 * words: a language either of them asks for, otherwise the language the user wrote in.
 *
 * Fail-open throughout: any translation parse/provider error returns the ORIGINAL task
 * unchanged, so a delegation is never blocked or corrupted by the normalizer.
 */
import type { ChatProvider, LLMMessage } from "../providers/lmstudio.js";
import { userWordsLines, type TurnUserWords } from "./delegation-user-words.js";

export interface NormalizedDelegationTask {
  /** The task to run: English translation + output-language directive when needed, else the
   *  original verbatim. */
  task: string;
  /** English name of the detected source language; "English" when no translation applied. */
  sourceLanguage: string;
  /** English name of the language the user-facing result must be written in. */
  outputLanguage: string;
  /** Whether `task` differs from the input (translated, a directive added, or both). */
  changed: boolean;
}

/** Languages that need no translation and no output-language directive. */
function isEnglish(language: string): boolean {
  const l = language.trim().toLowerCase();
  return l === "english" || l === "en" || l === "en-us" || l === "en-gb" || l === "";
}

/** The user's words as the translate call sees them: bounded, one block. */
function userWordsForPrompt(words: TurnUserWords | undefined): string {
  return userWordsLines(words).join("\n").slice(0, 1_600);
}

/**
 * Bounded translate-only prompt. Asks the model to DETECT the task's language, return the task
 * in clear English (verbatim if already English), and name the language the user-facing result
 * must be in. Preserves every concrete identifier so routing/build instructions keep their part
 * numbers, names, URLs, paths and code. Kept here (not inline) so the wording is unit-testable.
 */
export function buildDelegationTranslatePrompt(task: string, userWords?: TurnUserWords): LLMMessage[] {
  const words = userWordsForPrompt(userWords);
  return [
    {
      role: "system",
      content:
        "You normalize a delegated task for an English-internal agent swarm. Detect the natural "
        + "language of the TASK below, then return that task translated into clear, faithful English. "
        + "If it is ALREADY English, return it unchanged. Also name the OUTPUT language — the language "
        + "the user-facing result (the deliverable's text, its UI text, the final answer) must be written in: "
        + "a language the task or the user's own words ask for (for example 'write the letter in English', "
        + "'answer in French'); otherwise the language of the user's own words; otherwise the task's language. "
        + "Reply with STRICT JSON and nothing else: "
        + "{\"language\":\"<English name of the task's language, e.g. German>\",\"output_language\":\"<English name>\",\"task\":\"<the task in English>\"}. "
        + "Translate ONLY natural-language prose — preserve every concrete identifier verbatim: names, "
        + "part numbers, numbers, units, URLs, file paths, code, and quoted strings. Do NOT answer, "
        + "perform, summarize, or shorten the task; only translate it. Keep all of the task's instructions "
        + "and structure intact. The user's own words, when given, are context for the output language "
        + "only — do not translate them or add them to the task.",
    },
    {
      role: "user",
      content: words ? `TASK:\n${task}\n\nUSER'S OWN WORDS (context only):\n${words}` : `TASK:\n${task}`,
    },
  ];
}

interface ParsedTranslation {
  task: string;
  sourceLanguage: string;
  outputLanguage: string;
}

/**
 * Parse the translate reply, fail-open. Anything that is not a usable JSON object with a
 * non-empty `task` resolves to the ORIGINAL task with sourceLanguage "English" (i.e. no
 * change), so a malformed reply can never drop or corrupt the delegation. A missing
 * `output_language` falls back to the task's language, which is what the directive used before.
 */
export function parseDelegationTranslation(raw: string | null | undefined, originalTask: string): ParsedTranslation {
  const unchanged: ParsedTranslation = { task: originalTask, sourceLanguage: "English", outputLanguage: "English" };
  if (!raw || !raw.trim()) return unchanged;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return unchanged;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const language = typeof obj["language"] === "string" ? obj["language"].trim() : "";
    const outputRaw = typeof obj["output_language"] === "string" ? obj["output_language"].trim() : "";
    const task = typeof obj["task"] === "string" ? obj["task"].trim() : "";
    if (!task) return unchanged;
    const sourceLanguage = isEnglish(language) ? "English" : language;
    const outputLanguage = outputRaw || sourceLanguage;
    // An English task is kept verbatim: the model's copy of it can only lose something.
    return { task: sourceLanguage === "English" ? originalTask : task, sourceLanguage, outputLanguage };
  } catch {
    return unchanged;
  }
}

/**
 * Append the output-language directive so a sub-agent that received an English task still
 * produces its user-facing deliverable in the language the user wants. No-op for English.
 */
export function withOutputLanguageDirective(task: string, outputLanguage: string): string {
  if (isEnglish(outputLanguage)) return task;
  return (
    task
    + `\n\n[LANGUAGE] Reason and work internally in English. Write every user-facing part of your result — `
    + `the deliverable's content, its UI text, and your final answer — in ${outputLanguage}, the language the user `
    + `wants it in. Do NOT deliver it in any other language.`
  );
}

/**
 * Normalize a delegated task to English for internal routing/work, carrying an
 * output-language directive so the deliverable comes back in the language the user wants. One
 * bounded routing-tier call; fail-open (returns the original task on empty input or any error).
 * The `context` block is intentionally NOT translated by the caller (verbatim evidence).
 */
export async function normalizeDelegationTaskLanguage(opts: {
  task: string;
  provider: ChatProvider;
  signal?: AbortSignal;
  /** What the user typed this turn — decides the output language when the task does not. */
  userWords?: TurnUserWords;
}): Promise<NormalizedDelegationTask> {
  const task = opts.task ?? "";
  const unchanged: NormalizedDelegationTask = { task, sourceLanguage: "English", outputLanguage: "English", changed: false };
  if (!task.trim()) return unchanged;
  try {
    const resp = await opts.provider.complete(buildDelegationTranslatePrompt(task, opts.userWords), [], opts.signal);
    const parsed = parseDelegationTranslation(resp.content, task);
    const normalized = withOutputLanguageDirective(parsed.task, parsed.outputLanguage);
    return {
      task: normalized,
      sourceLanguage: parsed.sourceLanguage,
      outputLanguage: parsed.outputLanguage,
      changed: normalized !== task,
    };
  } catch {
    return unchanged; // never block a delegation on translation
  }
}
