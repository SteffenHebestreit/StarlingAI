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

/**
 * Strips common Markdown constructs from a string before sending it to the
 * speech-summary LLM. This gives the model cleaner input so it can focus on
 * producing natural spoken prose instead of navigating raw markup.
 */
export function stripMarkdownForSpeech(text: string): string {
  return text
    // Remove fenced code blocks entirely
    .replace(/```[\s\S]*?```/g, "(code omitted)")
    // Remove inline code backticks, keeping the inner text
    .replace(/`([^`\n]*)`/g, "$1")
    // Remove ATX headers (##, ###, …), keeping the heading text
    .replace(/^#{1,6}\s+(.*)/gm, "$1")
    // Remove bold and italic markers
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_\n]+)_{1,3}/g, "$1")
    // Remove horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, "")
    // Remove table separator rows first (e.g. |---|---|), before data-row conversion
    .replace(/^\|[-| :]+\|?\s*$/gm, "")
    // Convert remaining table data rows: strip pipes and join cells with " — "
    .replace(/^\|(.+)\|\s*$/gm, (_, cells: string) =>
      cells.split("|").map((c) => c.trim()).filter(Boolean).join(" — "))
    // Remove bullet list markers, keeping the item text
    .replace(/^\s*[-*+]\s+/gm, "")
    // Remove numbered list markers, keeping the item text
    .replace(/^\s*\d+[.)]\s+/gm, "")
    // Remove blockquote markers
    .replace(/^>\s*/gm, "")
    // Collapse three or more blank lines to two
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildSpeechSummarySystemPrompt(maxSentences: number, sourceText: string): string {
  const detectedLanguage = detectSpeechSummaryLanguage(sourceText);
  const languageInstruction = detectedLanguage === "German"
    ? "The source reply is in German. The spoken summary MUST remain in German. Do not translate any part of it into English."
    : detectedLanguage === "English"
      ? "The source reply is in English. The spoken summary MUST remain in English. Do not translate it into another language."
      : "Keep the spoken summary in the same language as the source reply. Do not translate it unless the source reply is already mixed or unclear.";

  return `You are rewriting an assistant reply into a concise spoken version for text-to-speech. Produce at most ${maxSentences} natural, spoken sentence(s). ${languageInstruction} Keep the assistant-to-user perspective exactly: the assistant speaks as "I" or implied assistant voice, and addresses the listener as "you" when needed. Never switch into the user's voice. Do not write lines where the speaker asks the assistant for help, such as "I need help", "tell me how you can assist me", or similar user-to-assistant phrasing, unless the source text literally says that as quoted content. Do not add a self-introduction, name reminder, or greeting flourish unless that information is already necessary in the source reply. Do not describe what "the assistant" said or what "the user" should do. Rewrite the reply into direct spoken guidance that the assistant can say aloud. Use contractions and a conversational, natural-sounding tone — write exactly how a person would speak, not how they would write. If the source has bullet points or numbered lists, weave them into flowing sentences using connective words like "first", "then", "also", and "finally" rather than enumerating them as a list. Omit technical details, code snippets, and raw URLs — replace them with a brief plain-language description of what they do or achieve. Avoid stiff written constructions like "the following items", "as outlined above", "pursuant to", or "in order to". Keep it short, warm, and easy to follow when heard aloud. Respond with only the spoken summary — no markdown of any kind.`;
}

export function buildSpeechSummaryUserPrompt(sourceText: string): string {
  const stripped = stripMarkdownForSpeech(sourceText);
  return `Source assistant reply:\n<<<SOURCE\n${stripped}\nSOURCE>>>\n\nRewrite only this assistant reply for speech. Preserve its language and perspective.`;
}
