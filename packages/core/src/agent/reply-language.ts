/**
 * Which language a reply is written in — the one definition every prompt uses.
 *
 * The swarm's definitions are English: agent descriptions, tool schemas and system prompts.
 * What the USER reads is written in the reply language, decided in this order:
 *
 *   1. a language the user asked for — in the latest message ("answer in English"), or as a
 *      standing instruction earlier in the conversation or among their durable facts
 *      ("from now on, reply in English");
 *   2. otherwise the language of the user's latest message;
 *   3. if that message has no language of its own (a greeting, "ok", an emoji, a bare link or
 *      code), the language the conversation has been using;
 *   4. with no conversation yet, `agents.mainAssistant.defaultLanguage`.
 *
 * A language named for a DELIVERABLE ("write the letter in English", "translate this into
 * French") governs that deliverable; the reply around it stays in the reply language.
 *
 * The model applies this rule by reading the conversation. Nothing here matches words: the
 * ways of asking for a language are open-ended in every language, so no table tries to list
 * them.
 *
 * Every prompt that used to say "in the user's language" or "in the SAME language as the
 * user's request" meant rule 2 alone, and the most specific copy is the one a model obeys. On
 * a German message asking for an English answer, the QA rewrite and the synthesis passes put
 * the answer back into German. They now quote IN_REPLY_LANGUAGE.
 */
import { getConfig } from "../config/loader.js";
import { currentRequestContext } from "../runtime/request-context.js";
import { detectTextLanguage } from "./text-language.js";

/** Used when config cannot be read (unit tests without a config, a broken shard). */
const FALLBACK_DEFAULT_LANGUAGE = "German";

/** The configured language for a conversation that has not established one yet. */
export function defaultReplyLanguage(): string {
  try {
    const configured = getConfig().agents?.mainAssistant?.defaultLanguage?.trim();
    return configured || FALLBACK_DEFAULT_LANGUAGE;
  } catch {
    return FALLBACK_DEFAULT_LANGUAGE;
  }
}

/**
 * The phrase single-purpose prompts (synthesis, repair, QA rewrite, corrective passes) use
 * where they used to say "in the user's language". Those prompts run with the conversation in
 * view, so the model can see whether the user asked for a language.
 */
export const IN_REPLY_LANGUAGE =
  "in the reply language (the language the user asked for, if they asked for one; otherwise the language of their latest message)";

/** The full rule, written for the orchestrator's system prompt. */
export function buildReplyLanguageRule(defaultLanguage: string = defaultReplyLanguage()): string {
  return "Reply language: answer in the language the user asked for — in their latest message, as a standing "
    + "instruction earlier in the conversation, or in the durable facts you were given. Without such a request, "
    + "answer in the language of the user's latest message; when that message has no language of its own (a "
    + "greeting, \"ok\", an emoji, a bare link or code), keep the language the conversation has been using, or "
    + `${defaultLanguage} if there is none yet. A language the user names for a deliverable ("write the letter in `
    + "English\", \"translate this into French\") applies to that deliverable; your own words around it stay in the "
    + "reply language.";
}

/**
 * The per-turn copy, which quotes the message it applies to. It is the most specific language
 * instruction the orchestrator sees on the turn, so it has to carry the whole precedence and not
 * just "same language as this message" — that version overrode an explicit request.
 */
export function buildTurnReplyLanguageInstruction(
  userMessage: string,
  defaultLanguage: string = defaultReplyLanguage(),
): string {
  const compact = userMessage.trim().replace(/\s+/g, " ").slice(0, 280);
  const subject = compact ? `that message (${JSON.stringify(compact)})` : "the user's latest message";
  return "Reply in the language the user asked for, if they asked for one — in their latest message or as a standing "
    + `instruction earlier; otherwise in the language of ${subject}. If it has no language of its own, keep the `
    + `language the conversation has been using (${defaultLanguage} if there is none).`;
}

/**
 * The text of the assistant's most recent reply, skipping tool-call turns that carry no prose.
 * It is written in the conversation's language, so it is what a message with no language of its
 * own ("ok", "hi") is read against.
 */
export function lastAssistantReplyText(history: readonly { role: string; content: string | null }[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]!;
    if (message.role !== "assistant") continue;
    const text = typeof message.content === "string" ? message.content.trim() : "";
    if (text) return text;
  }
  return undefined;
}

/**
 * English name of the language the person is writing in this turn: their message, or — when it
 * has no language of its own — the previous reply. Undefined when neither can be told. For FIXED
 * text only; see RequestContext.userMessageLanguage.
 *
 * Synchronous on purpose: it runs at the start of every turn, and a turn must not wait for a
 * module to load. The gateway loads the detector at boot; before that has happened (a CLI's first
 * turn) this is undefined and fixed text uses the configured default.
 */
export function detectTurnUserLanguage(
  userMessage: string,
  history: readonly { role: string; content: string | null }[],
): string | undefined {
  return detectTextLanguage(userMessage)?.name ?? detectTextLanguage(lastAssistantReplyText(history))?.name;
}

/**
 * The German or the English form of a fixed user-facing line (a status update, a backstop
 * message no model writes), by the language the person wrote this turn in; the configured default
 * when that is unknown. Anything other than German gets English: these lines have no other forms.
 */
export function localizedFixedText(forms: { de: string; en: string }): string {
  const language = currentRequestContext()?.userMessageLanguage ?? defaultReplyLanguage();
  return language.trim().toLowerCase() === "german" ? forms.de : forms.en;
}

/**
 * The instruction a delegated specialist gets beside the user's own words. The task it receives
 * is the orchestrator's paraphrase and may be in English; what the user will read still has to
 * be in the language they wrote in or asked for.
 */
export const SPECIALIST_REPLY_LANGUAGE_INSTRUCTION =
  "Write everything the user will read — your answer, and the text of any document, page or interface you "
  + "produce — in the language the user asked for, or otherwise in the language of the user's own words, even "
  + "when the task is written in English.";
