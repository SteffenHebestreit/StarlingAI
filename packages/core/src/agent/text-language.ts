/**
 * Which natural language a piece of text is written in — a statistical identifier, not a word list.
 *
 * Code that writes fixed text into a reply (an honesty banner, a status line, a spoken summary)
 * has to pick that text's language from the conversation. It used to do so with short lists of
 * German words, which read ordinary English as German ("it was", "the die was cast") and could
 * not name a third language at all. `eld` scores character n-grams against 60 languages and
 * reports when it is not sure; an unsure call is treated as no call.
 *
 * This answers "what language is this text", never "what does the user want". Whether the user
 * asked for a language is a question for the model reading the conversation (reply-language.ts).
 *
 * LAZY. The n-gram tables cost ~30 MB of heap and ~80 ms to load, and most processes that import
 * this module never need them. The gateway warms them at boot; anything else loads them on first
 * use. Until they are loaded, and whenever the text is too short or too ambiguous to call,
 * detectTextLanguage returns null and the caller keeps its default.
 */
import { childLogger } from "../logger.js";

const log = childLogger("agent:text-language");

interface ElDetector {
  /** `isReliable(ratio)`: the top score reaches `ratio` times the language's average score (0.75 by default). */
  detect(text: string): { language: string; isReliable(thresholdRatio?: number): boolean };
}

let detector: ElDetector | null = null;
let loading: Promise<void> | null = null;

/** Load the detector. Safe to call repeatedly; never rejects. */
export function warmTextLanguageDetector(): Promise<void> {
  if (detector) return Promise.resolve();
  loading ??= import("eld/extrasmall")
    .then((mod) => {
      detector = mod.eld as unknown as ElDetector;
    })
    .catch((err: unknown) => {
      // Missing or broken package: every caller already handles null, so degrade quietly and let
      // a later call try again.
      log.warn({ err }, "Language detector failed to load — fixed reply text falls back to its default language");
      loading = null;
    });
  return loading;
}

/**
 * The prose left once code, links and markup are removed. A URL or a code block carries n-grams
 * of its own (a bare URL scores as confident Portuguese), and none of them says anything about
 * the language a person wrote in.
 */
export function proseForLanguageDetection(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, " ")
    .replace(/<[^>\n]{1,200}>/g, " ")
    .replace(/[#>*_|~[\]()=]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Below this many letters a call is a guess ("ok danke" reads as Dutch). */
const MIN_LETTERS = 8;
/** Enough text to call a language; scoring the rest only costs time. */
const MAX_CHARS = 2_000;
/**
 * Below this many letters, a part of a text counts only when the detector is at least as sure of
 * it as of an average text in its language (SURE_RELIABILITY; the usual bar is 0.75 of that). At
 * the usual bar it called 36 of 65 short fragments another language than the text they came from:
 * a list item, a product name, "No emojis." (Portuguese), "Formeller Ton." (Danish). At this one it
 * called 2 of them so, and still named the language of 34 of 35 short questions like "Was heißt
 * das?" (2026-10-08). From 20 letters on it was the other way round: the usual bar misread 1 part
 * in 22, and this one missed 5 of 21 real sentences, "Error: Cannot find module" among them.
 */
const SURE_BELOW_LETTERS = 20;
const SURE_RELIABILITY = 1;

export interface DetectedLanguage {
  /** ISO 639-1 code, e.g. "de". */
  code: string;
  /** English name, e.g. "German" — the form prompts use. */
  name: string;
}

let displayNames: Intl.DisplayNames | null | undefined;

/** English name of an ISO 639-1 code ("de" → "German"); the code itself when unknown. */
export function languageNameForCode(code: string): string {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    } catch {
      displayNames = null;
    }
  }
  try {
    return displayNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * The language `text` is written in, or null when that cannot be told reliably (too short, only
 * code or links, or the detector is not loaded yet). Starts loading the detector on first use.
 */
export function detectTextLanguage(text: string | null | undefined): DetectedLanguage | null {
  return detectLanguage(text, 0);
}

/** detectTextLanguage, with text of fewer than `sureBelowLetters` letters held to SURE_RELIABILITY. */
function detectLanguage(text: string | null | undefined, sureBelowLetters: number): DetectedLanguage | null {
  if (!text) return null;
  if (!detector) {
    void warmTextLanguageDetector();
    return null;
  }
  const prose = proseForLanguageDetection(text).slice(0, MAX_CHARS);
  const letters = prose.replace(/[^\p{L}]/gu, "").length;
  if (letters < MIN_LETTERS) return null;
  try {
    const result = detector.detect(prose);
    if (!result.language || !(letters < sureBelowLetters ? result.isReliable(SURE_RELIABILITY) : result.isReliable())) {
      return null;
    }
    return { code: result.language, name: languageNameForCode(result.language) };
  } catch {
    return null;
  }
}

/**
 * Where a text can change language: a line break, a sentence end, a colon ("Übersetze: <a paste>"
 * was one English part), a quotation mark.
 */
const LANGUAGE_PART_BOUNDARY = /\n+|(?<=[.!?…:])\s+|(?<=[。！？：])|["“”„«»「」『』]+/u;

/**
 * A quoted passage: from a quotation mark at the start of a word to the next one at the end of a
 * word. Single marks count too; the apostrophe inside "don't" or "it’s" neither opens nor closes one.
 */
const QUOTED_PASSAGE =
  /(?<![\p{L}\p{N}])["“”„«»「」『』'‘’‚‹›](?:[^"“”„«»「」『』'‘’‚‹›]|(?<=[\p{L}\p{N}])['’](?=[\p{L}\p{N}]))*?["“”„«»「」『』'‘’‚‹›](?![\p{L}\p{N}])/gu;

/**
 * The language of `text` when every line, sentence and quoted passage of it that can be told is in
 * that one language, and so are the words around its quoted passages; null when one of them reads
 * as another, or when the whole cannot be told. Read as a whole, a text is in whichever language has
 * the most letters: a German question about an English quote, an error message or an image analysis
 * reads as English. A long text is read at its start and its end, where the words around a paste are.
 *
 * A short part has to be told for certain (SURE_BELOW_LETTERS). At the detector's usual bar, "No
 * emojis." after an English request or a list of product names took the language away from a text
 * written in one.
 */
export function detectUniformTextLanguage(text: string | null | undefined): DetectedLanguage | null {
  const whole = detectTextLanguage(text);
  if (!whole || !text) return null;
  const withoutCode = text.replace(/```[\s\S]*?```/g, "\n");
  const read = withoutCode.length > 2 * MAX_CHARS
    ? `${withoutCode.slice(0, MAX_CHARS)}\n${withoutCode.slice(-MAX_CHARS)}`
    : withoutCode;
  // The words around the quoted passages are one more part. Split at the quotation marks, "Was
  // bedeutet" and "für mich?" around an English passage were each too short to tell, and a single
  // mark is no boundary (an apostrophe looks the same): "Was bedeutet 'Refunds are not provided …'
  // für mich?" was one English sentence.
  const unquoted = read.replace(QUOTED_PASSAGE, " ");
  const parts = read.split(LANGUAGE_PART_BOUNDARY);
  for (const part of unquoted === read ? parts : [unquoted, ...parts]) {
    const language = detectLanguage(part, SURE_BELOW_LETTERS);
    if (language && language.code !== whole.code) return null;
  }
  return whole;
}

/** True when `text` is reliably German. False covers both "another language" and "cannot tell". */
export function textIsGerman(text: string | null | undefined): boolean {
  return detectTextLanguage(text)?.code === "de";
}
