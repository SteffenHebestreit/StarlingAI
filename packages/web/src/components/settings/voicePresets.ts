/**
 * What the Voices settings work with, free of Vue: the languages a voice can be set for, and how a
 * catalog of voices is grouped and matched to a language.
 */

import type { HubVoiceInfo } from "@/stores/gateway";

/** The languages a voice can be chosen for; "*" speaks every other one. */
export const VOICE_LANGUAGES: ReadonlyArray<{ code: string; label: string; sample: string }> = [
  { code: "de", label: "German", sample: "Hallo, so klinge ich, wenn ich dir antworte." },
  { code: "en", label: "English", sample: "Hello, this is how I sound when I answer you." },
  { code: "*", label: "Any other language", sample: "Hello, this is how I sound when I answer you." },
];

const LANGUAGE_PREFIXES: Record<string, string[]> = {
  de: ["de", "german", "deutsch"],
  en: ["en", "english"],
};

/** Whether a voice is meant for `code` — by its locale ("de_DE") or language name ("German"). */
export function voiceSpeaks(voice: Pick<HubVoiceInfo, "language">, code: string): boolean {
  const language = voice.language?.trim().toLowerCase();
  if (!language || code === "*" || language === "multilingual") return true;
  return (LANGUAGE_PREFIXES[code] ?? [code]).some((prefix) => language.startsWith(prefix));
}

/** The voices to offer for `code`: those meant for it first, then the rest, each group by name. */
export function voicesFor(voices: readonly HubVoiceInfo[], code: string): HubVoiceInfo[] {
  const byName = (a: HubVoiceInfo, b: HubVoiceInfo) => a.name.localeCompare(b.name);
  const matching = voices.filter((voice) => voiceSpeaks(voice, code)).sort(byName);
  const others = voices.filter((voice) => !voiceSpeaks(voice, code)).sort(byName);
  return [...matching, ...others];
}

/** How a voice is shown in a list: "Luna · saved", "de_DE-thorsten-medium · piper". */
export function voiceCaption(voice: HubVoiceInfo): string {
  const source = voice.kind === "saved" ? "your voice" : voice.engine;
  return voice.language ? `${source} · ${voice.language}` : source;
}

/** A name for a voice the service accepts: letters, digits, spaces, dashes and underscores. */
export function cleanVoiceName(name: string): string {
  return name.replace(/[^\p{L}\p{N} _-]+/gu, "").replace(/\s+/g, " ").trim().slice(0, 48);
}
