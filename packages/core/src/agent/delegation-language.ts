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
 * deliverable still comes back in the user's language. The `context` block is left
 * VERBATIM on purpose — it carries gathered evidence / source quotes whose exact wording
 * matters for citation, and a sub-agent reasoning in English can read non-English evidence
 * fine.
 *
 * Fail-open throughout: any translation parse/provider error returns the ORIGINAL task
 * unchanged, so a delegation is never blocked or corrupted by the normalizer.
 */
import type { ChatProvider, LLMMessage } from "../providers/lmstudio.js";

export interface NormalizedDelegationTask {
  /** The task to run: English translation + output-language directive when non-English,
   *  else the original verbatim. */
  task: string;
  /** English name of the detected source language; "English" when no translation applied. */
  sourceLanguage: string;
}

/** Languages that need no translation and no output-language directive. */
function isEnglish(language: string): boolean {
  const l = language.trim().toLowerCase();
  return l === "english" || l === "en" || l === "en-us" || l === "en-gb" || l === "";
}

/**
 * Bounded translate-only prompt. Asks the model to DETECT the task's language and return
 * it in clear English (verbatim if already English), preserving every concrete identifier
 * so routing/build instructions keep their part numbers, names, URLs, paths and code.
 * Kept here (not inline) so the wording is unit-testable.
 */
export function buildDelegationTranslatePrompt(task: string): LLMMessage[] {
  return [
    {
      role: "system",
      content:
        "You normalize a delegated task for an English-internal agent swarm. Detect the natural "
        + "language of the TASK below, then return that task translated into clear, faithful English. "
        + "If it is ALREADY English, return it unchanged. Reply with STRICT JSON and nothing else: "
        + "{\"language\":\"<English name of the source language, e.g. German>\",\"task\":\"<the task in English>\"}. "
        + "Translate ONLY natural-language prose — preserve every concrete identifier verbatim: names, "
        + "part numbers, numbers, units, URLs, file paths, code, and quoted strings. Do NOT answer, "
        + "perform, summarize, or shorten the task; only translate it. Keep all of the task's instructions "
        + "and structure intact.",
    },
    { role: "user", content: `TASK:\n${task}` },
  ];
}

/**
 * Parse the translate reply, fail-open. Anything that is not a usable JSON object with a
 * non-empty `task` resolves to the ORIGINAL task with sourceLanguage "English" (i.e. no
 * change), so a malformed reply can never drop or corrupt the delegation.
 */
export function parseDelegationTranslation(raw: string | null | undefined, originalTask: string): NormalizedDelegationTask {
  const unchanged: NormalizedDelegationTask = { task: originalTask, sourceLanguage: "English" };
  if (!raw || !raw.trim()) return unchanged;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return unchanged;
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const language = typeof obj["language"] === "string" ? obj["language"].trim() : "";
    const task = typeof obj["task"] === "string" ? obj["task"].trim() : "";
    if (!task) return unchanged;
    if (isEnglish(language)) return { task: originalTask, sourceLanguage: "English" }; // keep original verbatim
    return { task, sourceLanguage: language };
  } catch {
    return unchanged;
  }
}

/**
 * Append the output-language directive so a sub-agent that just received an English task
 * still produces its user-facing deliverable in the user's language. No-op for English.
 */
export function withOutputLanguageDirective(task: string, sourceLanguage: string): string {
  if (isEnglish(sourceLanguage)) return task;
  return (
    task
    + `\n\n[LANGUAGE] Reason and work internally in English. Write every user-facing part of your result — `
    + `the deliverable's content, its UI text, and your final answer — in ${sourceLanguage} (the user's language). `
    + `Do NOT deliver the result in English.`
  );
}

/**
 * Normalize a delegated task to English for internal routing/work, carrying an
 * output-language directive so the deliverable stays in the user's language. One bounded
 * routing-tier call; fail-open (returns the original task on empty input or any error).
 * The `context` block is intentionally NOT translated by the caller (verbatim evidence).
 */
export async function normalizeDelegationTaskLanguage(opts: {
  task: string;
  provider: ChatProvider;
  signal?: AbortSignal;
}): Promise<NormalizedDelegationTask> {
  const task = opts.task ?? "";
  if (!task.trim()) return { task, sourceLanguage: "English" };
  try {
    const resp = await opts.provider.complete(buildDelegationTranslatePrompt(task), [], opts.signal);
    const parsed = parseDelegationTranslation(resp.content, task);
    return { task: withOutputLanguageDirective(parsed.task, parsed.sourceLanguage), sourceLanguage: parsed.sourceLanguage };
  } catch {
    return { task, sourceLanguage: "English" }; // never block a delegation on translation
  }
}
