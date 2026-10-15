/**
 * The browser's own voice (speechSynthesis): what speaks when the speech service is down or a piece
 * of the answer could not be synthesised.
 */

import type { FallbackVoice } from "./speechPlayer";
import { localeFor, speechChunks } from "./speechText";

function available(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

/** The installed voice for `language`: its exact locale first, then any of the language, the default one breaking ties. */
function voiceFor(language: string): SpeechSynthesisVoice | null {
  const locale = localeFor(language).toLowerCase();
  const prefix = language.toLowerCase().slice(0, 2);
  let best: { voice: SpeechSynthesisVoice; score: number } | null = null;
  for (const voice of window.speechSynthesis.getVoices()) {
    const lang = (voice.lang || "").toLowerCase().replace(/_/g, "-");
    const score = (lang === locale ? 6 : lang.startsWith(prefix) ? 4 : 0) + (voice.default ? 1 : 0);
    if (score > 0 && (!best || score > best.score)) best = { voice, score };
  }
  return best?.voice ?? null;
}

/** Speaks one piece; resolves when it ends, fails, or `signal` aborts. */
function speakPiece(text: string, language: string, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const synth = window.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = localeFor(language);
    const voice = voiceFor(language);
    if (voice) utterance.voice = voice;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(watchdog);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      synth.cancel();
      finish();
    };
    // Some browsers never fire `end` for an utterance; its length bounds the wait.
    const watchdog = window.setTimeout(finish, 4_000 + text.length * 120);
    utterance.onend = finish;
    utterance.onerror = finish;
    signal.addEventListener("abort", onAbort, { once: true });
    synth.speak(utterance);
  });
}

export const browserVoice: FallbackVoice = {
  available,
  async speak(text, language, signal) {
    // Long utterances are cut off after about fifteen seconds in some browsers: one piece at a time.
    for (const piece of speechChunks(text, { firstMax: 200, max: 200 })) {
      if (signal.aborted) return;
      await speakPiece(piece, language, signal);
    }
  },
};
