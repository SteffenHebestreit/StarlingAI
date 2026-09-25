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
  detect(text: string): { language: string; isReliable(): boolean };
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
  if (!text) return null;
  if (!detector) {
    void warmTextLanguageDetector();
    return null;
  }
  const prose = proseForLanguageDetection(text).slice(0, MAX_CHARS);
  if (prose.replace(/[^\p{L}]/gu, "").length < MIN_LETTERS) return null;
  try {
    const result = detector.detect(prose);
    if (!result.language || !result.isReliable()) return null;
    return { code: result.language, name: languageNameForCode(result.language) };
  } catch {
    return null;
  }
}

/** True when `text` is reliably German. False covers both "another language" and "cannot tell". */
export function textIsGerman(text: string | null | undefined): boolean {
  return detectTextLanguage(text)?.code === "de";
}
