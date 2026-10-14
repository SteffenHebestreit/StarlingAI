/**
 * What the assistant says while a turn runs, in German and English: an acknowledgement when a spoken
 * request goes out, one line per kind of work as the turn reaches it, a reminder that it is still
 * working, and a call when it needs the user. Any other language hears the English lines.
 *
 * Each kind has a few wordings, taken in turn, so a reminder does not repeat itself word for word.
 */

import type { LanguageCode } from "./speechText";

/** A kind of work a turn reaches, as it is announced. */
export type Milestone =
  | "searching" | "reading" | "browsing" | "running" | "writing"
  | "creating" | "delegating" | "planning" | "checking" | "composing";

export type PhraseKind =
  | Milestone
  | "ack" | "stillWorking" | "stillWorkingLong" | "needsInput" | "approval" | "failed" | "fullAnswerInChat";

type PhraseLanguage = "de" | "en";

const PHRASES: Record<PhraseKind, Record<PhraseLanguage, readonly string[]>> = {
  ack: {
    de: ["Alles klar, ich bin dran.", "Einen Moment, ich kümmere mich darum.", "Verstanden, ich lege los."],
    en: ["Got it, I'm on it.", "One moment, I'll take care of that.", "Alright, working on it."],
  },
  searching: {
    de: ["Ich suche gerade nach Informationen.", "Ich recherchiere das kurz."],
    en: ["I'm looking that up.", "Searching for information now."],
  },
  reading: {
    de: ["Ich lese mir die Quellen durch.", "Ich sehe mir die Inhalte genauer an."],
    en: ["I'm reading through the sources.", "Taking a closer look at the content."],
  },
  browsing: {
    de: ["Ich arbeite gerade im Browser.", "Ich gehe die Seite im Browser durch."],
    en: ["I'm working in the browser.", "Going through the page in the browser."],
  },
  running: {
    de: ["Ich führe gerade ein paar Befehle aus.", "Ich lasse das kurz laufen."],
    en: ["I'm running a few commands.", "Running that now."],
  },
  writing: {
    de: ["Ich schreibe gerade die Dateien.", "Ich stelle das Dokument zusammen."],
    en: ["I'm writing the files.", "Putting the document together."],
  },
  creating: {
    de: ["Ich erstelle gerade das Bild.", "Ich arbeite an der Grafik."],
    en: ["I'm creating the image.", "Working on the visual now."],
  },
  delegating: {
    de: ["Ich ziehe einen Spezialisten hinzu.", "Ich gebe einen Teil an einen Spezialisten weiter."],
    en: ["I'm bringing in a specialist.", "Handing part of this to a specialist."],
  },
  planning: {
    de: ["Ich plane die nächsten Schritte.", "Ich lege mir einen Plan zurecht."],
    en: ["I'm planning the next steps.", "Working out a plan."],
  },
  checking: {
    de: ["Ich prüfe das Ergebnis noch einmal.", "Ich kontrolliere gerade das Ergebnis."],
    en: ["I'm double-checking the result.", "Verifying the result now."],
  },
  composing: {
    de: ["Ich formuliere gerade die Antwort.", "Gleich habe ich die Antwort."],
    en: ["I'm writing up the answer.", "Almost there, putting the answer together."],
  },
  stillWorking: {
    de: ["Ich bin noch dran.", "Das dauert noch einen Moment."],
    en: ["Still on it.", "This is taking a moment longer."],
  },
  stillWorkingLong: {
    de: ["Das dauert etwas länger, ich arbeite weiter daran.", "Ich bin immer noch dabei, danke für die Geduld."],
    en: ["This is taking longer, I'm still working on it.", "Still working on it, thanks for your patience."],
  },
  needsInput: {
    de: ["Ich brauche hier eine Rückmeldung.", "Ich habe eine Frage, bevor es weitergeht."],
    en: ["I need your input here.", "I have a question before I go on."],
  },
  approval: {
    de: ["Ich brauche eine Freigabe, bevor ich weitermache."],
    en: ["I need your approval before I continue."],
  },
  failed: {
    de: ["Das hat leider nicht geklappt."],
    en: ["Sorry, that didn't work."],
  },
  fullAnswerInChat: {
    de: ["Die ganze Antwort steht im Chat."],
    en: ["The full answer is in the chat."],
  },
};

function phraseLanguage(language: LanguageCode | undefined): PhraseLanguage {
  return language === "de" ? "de" : "en";
}

/** The language a phrase is actually spoken in: German for German, English for every other one. */
export function spokenPhraseLanguage(language: LanguageCode | undefined): LanguageCode {
  return phraseLanguage(language);
}

/** Every wording of a kind — what is synthesised ahead, so the first use is instant. */
export function phrasesFor(kind: PhraseKind, language: LanguageCode | undefined): readonly string[] {
  return PHRASES[kind][phraseLanguage(language)];
}

/** Hands out a kind's wordings in turn. */
export class PhraseBook {
  private readonly next = new Map<string, number>();

  pick(kind: PhraseKind, language: LanguageCode | undefined): { text: string; language: LanguageCode } {
    const lang = phraseLanguage(language);
    const variants = PHRASES[kind][lang];
    const key = `${kind}:${lang}`;
    const index = (this.next.get(key) ?? 0) % variants.length;
    this.next.set(key, index + 1);
    return { text: variants[index]!, language: lang };
  }
}
