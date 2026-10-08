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
import { detectTextLanguage, detectUniformTextLanguage, type DetectedLanguage } from "./text-language.js";
import { midTurnUserMessages, startsTurn, type TurnBoundaryMessage } from "./turn-boundary.js";

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

/**
 * The full rule, written for the orchestrator's system prompt.
 *
 * It names no default language. Named here and in the per-turn line, the default pulled replies
 * into it: on the live model an English question got a German answer 7 times in 20, the model's
 * own reasoning saying "the question is in English, so I'll reply in English" before it wrote
 * German; named only where it can apply, 2 times in 20 in the same runs (2026-10-07), with a
 * standing "from now on, English" kept as often as before (14 and 15 of 18). The per-turn line
 * names the default when the message has no language of its own
 * (buildTurnReplyLanguageInstruction), the only case it decides. Naming the message's detected
 * language instead fixed the English question and broke the standing request (6 of 14).
 */
export function buildReplyLanguageRule(): string {
  return "Reply language: answer in the language the user asked for — in their latest message, as a standing "
    + "instruction earlier in the conversation, or in the durable facts you were given. Without such a request, "
    + "answer in the language of the user's latest message; when that message has no language of its own (a "
    + "greeting, \"ok\", an emoji, a bare link or code), keep the language the conversation has been using. "
    + "A language the user names for a deliverable (\"write the letter in English\", \"translate this into "
    + "French\") applies to that deliverable; your own words around it stay in the reply language.";
}

/**
 * Does the user's message carry NO reliable language signal? A bare social token — "hi", "hey",
 * "ok", "danke", an emoji — is used verbatim in German chat too, so it does NOT establish English.
 *
 * Decided in CODE, deliberately, rather than in the prompt. The prompt-only attempt ("reply in the
 * same language; if too short/ambiguous default to German") did NOT work on the tiny fast-lane
 * model: it competes with the stronger "ALWAYS reply in the SAME language (English → English)"
 * rule, so the model reads the English word "hi", matches that rule, and answers in English —
 * the observed bug (session 5d9136bd: a German user's "hi" got "Hello! How can I help you
 * today?"), which survived the first prompt-only fix. When the signal is undetermined the fast
 * lane's builder emits ONE unconditional language directive instead, leaving the model nothing to
 * weigh (receptionist.ts).
 *
 * Structural, no keyword table: an umlaut/ß is a positive German marker; otherwise a message of at
 * most two short word-tokens (or pure emoji/punctuation) is treated as carrying no language.
 */
export function languageIsUndetermined(userMessage: string): boolean {
  const raw = (userMessage ?? "").trim();
  if (!raw) return true;
  if (/[äöüß]/i.test(raw)) return false; // unambiguous German marker
  const words = raw.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true; // emoji / punctuation only
  return words.length <= 2 && raw.length <= 15; // a bare greeting or acknowledgement
}

/**
 * The language a message is written in, or null when it has none of its own: a bare greeting or
 * acknowledgement, or text the detector cannot call. One definition for the fast lane and the full
 * path. The detector calls "Good morning" English and "Merci beaucoup" French, and read that way a
 * first greeting the fast lane answered in the default language got the detected one on the full
 * path, against the rule's own "a greeting" (buildReplyLanguageRule).
 */
function ownLanguage(text: string | undefined): DetectedLanguage | null {
  return text === undefined || languageIsUndetermined(text) ? null : detectTextLanguage(text);
}

/** Whether a message has a language of its own (see ownLanguage). */
export function messageHasOwnLanguage(userMessage: string): boolean {
  return ownLanguage(userMessage) !== null;
}

/**
 * Whether this is the conversation's first turn: the person has written no other message in it. A
 * standing language instruction can only be such a message, so on a first turn the only requests
 * left are the message itself and the durable facts.
 *
 * What the person sends while the turn runs counts: it can carry a request ("auf Deutsch, bitte"),
 * and the first-turn line lists none but those two. The progress monitor's redirect does not. It is
 * user-role for the model, but nobody wrote it, and counted it took the first-turn line away from
 * the forced synthesis that follows it.
 */
export function isFirstUserTurn(history: readonly (TurnBoundaryMessage & { content?: unknown })[]): boolean {
  return history.filter((message) => startsTurn(message) || (midTurnUserMessages(message)?.length ?? 0) > 0).length <= 1;
}

export interface TurnReplyLanguageOptions {
  /** The conversation's first turn (isFirstUserTurn). */
  firstTurn?: boolean;
  /**
   * What the person typed to open the turn (RunTurnOptions.userWords, which runTurn keeps in
   * RequestContext.userWords). Unset when no person wrote the message: a /run scene's template, a
   * scene worker's or a workflow step's task.
   */
  userWords?: string | undefined;
}

/** "that message (…)", quoting the text the line is about. */
function quotedSubject(text: string): string {
  const compact = text.trim().replace(/\s+/g, " ").slice(0, 280);
  return compact ? `that message (${JSON.stringify(compact)})` : "the user's latest message";
}

/**
 * The per-turn copy, which quotes the message it applies to. It is the most specific language
 * instruction the orchestrator sees on the turn, so it has to carry the whole precedence and not
 * just "same language as this message" — that version overrode an explicit request.
 *
 * The default language is named only for a message with no language of its own (a bare greeting,
 * "ok", a bare link, code; or any message before the detector has loaded): elsewhere it cannot
 * apply, and named it pulled the reply into it (see buildReplyLanguageRule).
 */
export function buildTurnReplyLanguageInstruction(
  userMessage: string,
  defaultLanguage: string = defaultReplyLanguage(),
  opts: TurnReplyLanguageOptions = {},
): string {
  const own = ownLanguage(userMessage);
  const defaultClause = own ? "" : ` (${defaultLanguage} if there is none)`;
  const tail = `If it has no language of its own, keep the language the conversation has been using${defaultClause}.`;
  // On a first turn the line names the language of what the person typed. Unnamed, an English
  // first question still came back German 5 times in 12; named, 0 times in 12 (2026-10-07), with a
  // request in the message, or one stored among the durable facts, kept every time (6/6, 10/10).
  // Later in a conversation it names none: a standing "from now on, English" written earlier lost
  // to a named message language (6 of 14 kept) — see buildReplyLanguageRule.
  // Named, the language decides the reply, so it is named only where it is beyond doubt: from the
  // person's own words, never from a template the swarm wrote or the analysis inlined ahead of a
  // picture's question, and only when every sentence of them is in it. Read as a whole, a German
  // question about an English quote or an error message is English.
  const named = own && opts.firstTurn && ownLanguage(opts.userWords) ? detectUniformTextLanguage(opts.userWords) : null;
  if (named) {
    return "Reply in the language the user asked for, if they asked for one — in that message or in the durable facts "
      + `you were given; otherwise in ${named.name}, the language of ${quotedSubject(opts.userWords ?? userMessage)}. ${tail}`;
  }
  return "Reply in the language the user asked for, if they asked for one — in their latest message or as a standing "
    + `instruction earlier; otherwise in the language of ${quotedSubject(userMessage)}. ${tail}`;
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
