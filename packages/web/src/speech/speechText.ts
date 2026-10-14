/**
 * Text as it is spoken. A reply is markdown, and read as it stands a voice says "asterisk", spells
 * out every URL and reads code character by character. This turns it into sentences a voice can
 * say, cuts them into the pieces a speech service is asked for one at a time, and names the
 * language they are in.
 *
 * Free of Vue and of the store, so it can be exercised on its own.
 */

/** A language as the speech service is asked for it: a two-letter code. */
export type LanguageCode = string;

const LANGUAGE_NAMES: Record<string, LanguageCode> = {
  german: "de", deutsch: "de", english: "en", englisch: "en", polish: "pl", polski: "pl",
  french: "fr", spanish: "es", italian: "it", dutch: "nl", portuguese: "pt",
};

/** "de" for "de-DE", "de_de", "German" or "de"; undefined for anything else (and for "auto"). */
export function languageCode(value: string | null | undefined): LanguageCode | undefined {
  const text = value?.trim().toLowerCase().replace(/_/g, "-");
  if (!text || text === "auto") return undefined;
  if (LANGUAGE_NAMES[text]) return LANGUAGE_NAMES[text];
  return /^([a-z]{2})(?:-[a-z0-9]{2,8})*$/.exec(text)?.[1];
}

const LOCALES: Record<string, string> = { de: "de-DE", en: "en-US", pl: "pl-PL" };

/** The locale a browser voice is chosen by: "de-DE" for "de". */
export function localeFor(code: LanguageCode): string {
  return LOCALES[code] ?? code;
}

// Short, frequent words that occur in one of the three languages and hardly in the others.
// Ambiguous ones ("to", "i", "die" as an English verb is rare enough to keep) stay out.
const WORDS: Record<"de" | "en" | "pl", ReadonlySet<string>> = {
  de: new Set([
    "und", "der", "die", "das", "nicht", "ich", "ist", "ein", "eine", "einen", "zu", "mit", "für", "auf",
    "sie", "es", "wir", "du", "sich", "den", "dem", "des", "auch", "oder", "aber", "wenn", "dass", "wie",
    "noch", "nur", "kann", "sind", "bitte", "hier", "jetzt", "schon", "habe", "hast", "wird", "werden",
  ]),
  en: new Set([
    "the", "and", "is", "are", "of", "you", "your", "it", "this", "that", "with", "for", "on", "not",
    "can", "be", "have", "has", "will", "what", "how", "please", "here", "now", "there", "which", "would",
  ]),
  pl: new Set([
    "nie", "jest", "się", "że", "oraz", "może", "jak", "dla", "czy", "są", "tak", "już", "przez", "jestem",
  ]),
};
const LETTERS: Record<"de" | "pl", RegExp> = { de: /[äöüß]/g, pl: /[łąęśćźżń]/g };

/** The language a text is written in, among German, English and Polish — or undefined when it does not say. */
export function detectLanguage(text: string): LanguageCode | undefined {
  const lowered = text.toLowerCase();
  const words = lowered.match(/\p{L}+/gu) ?? [];
  const score = { de: 0, en: 0, pl: 0 };
  for (const word of words) {
    if (WORDS.de.has(word)) score.de += 1;
    if (WORDS.en.has(word)) score.en += 1;
    if (WORDS.pl.has(word)) score.pl += 1;
  }
  score.de += Math.min(3, lowered.match(LETTERS.de)?.length ?? 0);
  score.pl += Math.min(3, lowered.match(LETTERS.pl)?.length ?? 0) * 2;
  const ranked = (Object.entries(score) as Array<[LanguageCode, number]>).sort((a, b) => b[1] - a[1]);
  const [first, second] = ranked;
  if (!first || first[1] === 0 || first[1] === second?.[1]) return undefined;
  return first[0];
}

const END_PUNCTUATION = /[.!?…:;,]$/;

function asSentence(line: string): string {
  const text = line.trim();
  if (!text) return "";
  return END_PUNCTUATION.test(text) ? text : `${text}.`;
}

/**
 * A reply's markdown as a voice says it: no code, no links' targets, no URLs, no emphasis marks or
 * emoji; headings, list items and table rows each end as a sentence, so the voice pauses after them.
 */
export function toSpeakableText(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, "\n");
  text = text.replace(/```[\s\S]*?(?:```|$)/g, "\n");
  text = text.replace(/<\/?[a-z][^>]*>/gi, " ");
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[\^[^\]]+\]/g, "");
  text = text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ");
  // Short inline code is a name and is read; long inline code is code.
  text = text.replace(/`([^`\n]*)`/g, (_match, code: string) => (code.length <= 40 ? code : " "));
  text = text.replace(/~~(.+?)~~/g, "$1");
  text = text.replace(/(\*{1,3})(?=\S)([\s\S]*?\S)\1/g, "$2");
  text = text.replace(/(^|[^\p{L}\p{N}])(_{1,3})(?=\S)([^\n]*?\S)\2(?=[^\p{L}\p{N}]|$)/gu, "$1$3");
  text = text.replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu, "");
  text = text.replace(/\s*(?:→|⇒|->)\s*/g, ", ");

  const sentences: string[] = [];
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (!line) continue;
    if (/^(?:[-*_]\s*){3,}$/.test(line)) continue;
    if (/^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/.test(line)) continue;
    if (line.startsWith("|")) {
      line = line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()).filter(Boolean).join(", ");
    }
    line = line.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, "").replace(/^(?:[-*+•]|\d{1,3}[.)])\s+/, "");
    const sentence = asSentence(line);
    if (sentence && /[\p{L}\p{N}]/u.test(sentence)) sentences.push(sentence);
  }
  return sentences.join(" ").replace(/\s{2,}/g, " ").replace(/\s+([.,!?;:])/g, "$1").trim();
}

/** The sentences of a speakable text, each with its closing punctuation. */
export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}

/** A sentence longer than `max`, cut at a clause, or else at a word, so no piece is over `max`. */
function cutSentence(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence];
  const pieces: string[] = [];
  let rest = sentence;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    const clause = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
    const space = window.lastIndexOf(" ");
    const at = clause > max / 3 ? clause + 1 : space > 0 ? space : max;
    pieces.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * The pieces a text is synthesised in, in order. The first is short — the voice starts as soon as
 * it is spoken, while the next is synthesised — and the rest are a few sentences each, so a long
 * text is not a request per sentence. Every character of the text is in exactly one piece.
 */
export function speechChunks(text: string, options: { firstMax?: number; max?: number } = {}): string[] {
  const firstMax = options.firstMax ?? 160;
  const max = options.max ?? 300;
  const sentences = sentencesOf(text);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const limit = chunks.length === 0 ? firstMax : max;
    const joined = current ? `${current} ${sentence}` : sentence;
    // The first piece takes a second sentence only when the first is a mere greeting.
    const fits = joined.length <= limit && (chunks.length > 0 || !current || current.length < 24);
    if (fits) {
      current = joined;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    let pieces = cutSentence(sentence, chunks.length === 0 ? firstMax : max);
    if (chunks.length === 0 && pieces.length > 1) pieces = [pieces[0]!, ...cutSentence(pieces.slice(1).join(" "), max)];
    current = pieces.pop() ?? "";
    chunks.push(...pieces);
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Whether a reply is short enough to be read in full rather than summarised. */
export function isShortForSpeech(speakable: string, limits: { maxChars?: number; maxSentences?: number } = {}): boolean {
  return speakable.length <= (limits.maxChars ?? 420) && sentencesOf(speakable).length <= (limits.maxSentences ?? 4);
}

/** The opening sentences of a text, up to `maxSentences` and about `maxChars`: a summary when none could be made. */
export function leadSentences(speakable: string, maxSentences = 2, maxChars = 320): string {
  const lead: string[] = [];
  for (const sentence of sentencesOf(speakable)) {
    if (lead.length >= maxSentences) break;
    if (lead.length > 0 && [...lead, sentence].join(" ").length > maxChars) break;
    lead.push(sentence);
  }
  return lead.join(" ");
}
