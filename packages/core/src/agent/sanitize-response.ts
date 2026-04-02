/**
 * Shared utilities for sanitizing LLM assistant responses.
 *
 * Both the main runtime and the session transcript builder need to strip
 * narrated tool-call tags and execution chatter from assistant output.
 * This module centralises that logic so it stays in sync.
 */

/** Matches literal tool-call markup that some models emit in plain text. */
export const NARRATED_TOOL_TEXT_RE = /<tool_call>|<function=|<parameter=|\[Tool:/i;

/** Matches opening phrases that narrate tool execution steps. */
export const EXECUTION_CHATTER_START_RE = /^\s*(let me|now let me|first let me|i(?:'m| am) going to|i(?:'ll| will)|i found some useful information|let me fetch|let me search|now let me create|now i can)\b/i;

/** Remove XML-style tool-call tags that some models emit in their text output. */
export function stripNarratedToolTags(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<function=[^>]*>[\s\S]*?<\/function>/gi, "")
    .replace(/<parameter=[^>]*>[\s\S]*?<\/parameter>/gi, "")
    .replace(/<\/?tool_call>/gi, "")
    .trim();
}

/**
 * Clean an assistant response that may contain narrated tool-call markup
 * and execution chatter (e.g. "Let me search for…").
 *
 * @param value   Raw assistant text.
 * @param hadToolCalls  Whether the turn included actual tool calls (or the
 *                      raw text contains narrated tags).
 */
export function sanitizeAssistantContent(value: string, hadToolCalls: boolean): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";

  let cleaned = stripNarratedToolTags(raw)
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("[Tool:"))
    .join("\n")
    .trim();

  if (!cleaned) return "";

  if (hadToolCalls || NARRATED_TOOL_TEXT_RE.test(raw)) {
    cleaned = cleaned
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .filter((paragraph) => !EXECUTION_CHATTER_START_RE.test(paragraph))
      .join("\n\n")
      .trim();
  }

  return cleaned;
}

/**
 * Clean a non-assistant message (e.g. system or user) that may have had
 * narrated tool traces injected.
 */
export function sanitizeNonAssistantContent(content: string | null | undefined): string {
  const raw = typeof content === "string" ? content.trim() : "";
  if (!raw || !NARRATED_TOOL_TEXT_RE.test(raw)) return raw;

  const cleanedParagraphs = stripNarratedToolTags(raw)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const keptParagraphs: string[] = [];
  for (const paragraph of cleanedParagraphs) {
    const containsToolTraceLine = paragraph
      .split(/\r?\n/)
      .some((line) => line.trim().startsWith("[Tool:"));

    if (containsToolTraceLine || EXECUTION_CHATTER_START_RE.test(paragraph)) {
      break;
    }

    keptParagraphs.push(paragraph);
  }

  if (keptParagraphs.length > 0) {
    return keptParagraphs.join("\n\n").trim();
  }

  return stripNarratedToolTags(raw)
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("[Tool:"))
    .join("\n")
    .trim();
}

/**
 * Convenience dispatcher — picks the right sanitizer based on message role.
 */
export function sanitizeTranscriptContent(
  role: string,
  content: string | null | undefined,
  hasToolCalls: boolean,
): string {
  if (role === "assistant") {
    return sanitizeAssistantContent(
      typeof content === "string" ? content : "",
      hasToolCalls,
    );
  }
  return sanitizeNonAssistantContent(content);
}
