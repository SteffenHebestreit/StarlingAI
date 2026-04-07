const GERMAN_MARKERS = [
  " und ", " der ", " die ", " das ", " nicht ", " ich ", " ihnen ", " dir ", " bitte ", " kann ", " wie ", " heute ",
  " ist ", " wir ", " für ", " mit ", " hallo", "ü", "ö", "ä", "ß",
];
const ENGLISH_MARKERS = [
  " and ", " the ", " this ", " that ", " you ", " your ", " can ", " how ", " today ", "hello", "please", "with ",
];

export function detectSpeechSummaryLanguage(text: string): "German" | "English" | null {
  const normalized = ` ${text.trim().toLowerCase()} `;
  if (!normalized.trim()) return null;

  const germanScore = GERMAN_MARKERS.reduce((score, marker) => score + (normalized.includes(marker) ? 1 : 0), 0);
  const englishScore = ENGLISH_MARKERS.reduce((score, marker) => score + (normalized.includes(marker) ? 1 : 0), 0);

  if (germanScore === englishScore) return null;
  return germanScore > englishScore ? "German" : "English";
}

export function buildSpeechSummarySystemPrompt(maxSentences: number, sourceText: string): string {
  const detectedLanguage = detectSpeechSummaryLanguage(sourceText);
  const languageInstruction = detectedLanguage === "German"
    ? "The source reply is in German. The spoken summary MUST remain in German. Do not translate any part of it into English."
    : detectedLanguage === "English"
      ? "The source reply is in English. The spoken summary MUST remain in English. Do not translate it into another language."
      : "Keep the spoken summary in the same language as the source reply. Do not translate it unless the source reply is already mixed or unclear.";

  return `You are rewriting an assistant reply into a concise spoken version for text-to-speech. Produce at most ${maxSentences} natural, spoken sentence(s). ${languageInstruction} Keep the assistant-to-user perspective exactly: the assistant speaks as "I" or implied assistant voice, and addresses the listener as "you" when needed. Never switch into the user's voice. Do not write lines where the speaker asks the assistant for help, such as "I need help", "tell me how you can assist me", or similar user-to-assistant phrasing, unless the source text literally says that as quoted content. Do not add a self-introduction, name reminder, or greeting flourish unless that information is already necessary in the source reply. Do not describe what "the assistant" said or what "the user" should do. Rewrite the reply into direct spoken guidance that the assistant can say aloud. Use plain language with no markdown, bullet points, or code blocks. Respond with only the summary.`;
}

export function buildSpeechSummaryUserPrompt(sourceText: string): string {
  return `Source assistant reply:\n<<<SOURCE\n${sourceText}\nSOURCE>>>\n\nRewrite only this assistant reply for speech. Preserve its language and perspective.`;
}
