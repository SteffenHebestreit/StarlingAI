/**
 * Example plugin: word-stats
 *
 * Computes basic readability metrics for a block of prose without
 * spawning a sub-agent.  Useful as a "should I keep editing?" check
 * for the content_writer agent.
 *
 * Tool registers at:
 *   plugin__word-stats__readability
 *
 * Plugin tools run at Tier 2 (sandboxed, per-call approval).  See
 * packages/core/src/plugin/README.md in the StarlingAI repo for the
 * author guide.
 */

function syllableCount(word) {
  // Crude heuristic — counts vowel groups, drops a trailing silent e,
  // and floors at 1.  Good enough for reading-grade estimates; not
  // suitable as a phonetic source of truth.
  const lower = word.toLowerCase().replace(/[^a-z]/g, "");
  if (lower.length === 0) return 0;
  const groups = lower.match(/[aeiouy]+/g);
  let count = groups ? groups.length : 1;
  if (lower.endsWith("e") && count > 1) count -= 1;
  return Math.max(1, count);
}

export default {
  name: "word-stats",
  version: "1.0.0",
  description: "Readability and length statistics for prose passages.",
  author: "StarlingAI examples",
  tools: [
    {
      name: "readability",
      description: "Compute word count, sentence count, average word length, and a Flesch reading-ease score for a block of text. Higher Flesch scores mean easier reading; <30 = very hard, 60-70 = standard, >80 = easy.",
      embeddingDescription: "readability score; flesch reading ease; word count; sentence stats; prose analysis",
      costHint: "low",
      latencyHint: "low",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Prose to analyze." },
        },
        required: ["text"],
      },
      async execute(args) {
        const text = String(args.text ?? "").trim();
        if (text.length === 0) {
          return { success: false, output: "", error: "text is required" };
        }
        const words = text.split(/\s+/).filter((w) => w.length > 0);
        const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0);
        const wordCount = words.length;
        const sentenceCount = Math.max(1, sentences.length);
        const syllableTotal = words.reduce((acc, w) => acc + syllableCount(w), 0);

        // Flesch reading ease: 206.835 - 1.015 * (words/sentences) - 84.6 * (syllables/words)
        const wordsPerSentence = wordCount / sentenceCount;
        const syllablesPerWord = wordCount > 0 ? syllableTotal / wordCount : 0;
        const flesch = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
        const fleschRounded = Math.round(flesch * 10) / 10;

        const avgWordLen = wordCount > 0
          ? Math.round((words.reduce((acc, w) => acc + w.length, 0) / wordCount) * 10) / 10
          : 0;

        const lines = [
          `Words: ${wordCount}`,
          `Sentences: ${sentenceCount}`,
          `Average words per sentence: ${Math.round(wordsPerSentence * 10) / 10}`,
          `Average word length: ${avgWordLen}`,
          `Flesch reading-ease: ${fleschRounded} (${interpretFlesch(fleschRounded)})`,
        ];
        return {
          success: true,
          output: lines.join("\n"),
          metadata: {
            wordCount,
            sentenceCount,
            avgWordLength: avgWordLen,
            fleschReadingEase: fleschRounded,
          },
        };
      },
    },
  ],
};

function interpretFlesch(score) {
  if (score >= 90) return "very easy";
  if (score >= 80) return "easy";
  if (score >= 70) return "fairly easy";
  if (score >= 60) return "standard";
  if (score >= 50) return "fairly hard";
  if (score >= 30) return "hard";
  return "very hard";
}
