/**
 * Shared utilities for sanitizing LLM assistant responses.
 *
 * Both the main runtime and the session transcript builder need to strip
 * narrated tool-call tags and execution chatter from assistant output.
 * This module centralises that logic so it stays in sync.
 */

/** Matches literal tool-call markup that some models emit in plain text. */
export const NARRATED_TOOL_TEXT_RE = /<tool_call>|<function=|<parameter=|\[Tool(?:\s+Call)?\s*(?::|\])/i;

const NARRATED_TOOL_LINE_RE = /^\s*\[Tool(?:\s+Call)?\s*(?::|\])/i;

/** Matches opening phrases that narrate tool execution steps. */
export const EXECUTION_CHATTER_START_RE = /^\s*(let me|now let me|first let me|now i can|now i (?:have|understand)\b[\s\S]{0,160}\blet me|i (?:now )?(?:have|understand)\b[\s\S]{0,160}\blet me|i(?:'m| am) going to|i(?:'ll| will)|i found some useful information|let me fetch|let me search|now let me create)\b/i;

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
 * @param hadToolCalls  Whether THIS message carried tool calls — its text then
 *                      accompanied them and is step narration. A turn's final
 *                      answer goes through sanitizeFinalAnswerContent instead.
 */
export function sanitizeAssistantContent(value: string, hadToolCalls: boolean): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";

  let cleaned = stripNarratedToolMarkup(raw);

  if (!cleaned) return "";

  if (hadToolCalls || NARRATED_TOOL_TEXT_RE.test(raw)) {
    cleaned = stripExecutionChatterParagraphs(cleaned);
  }

  return cleaned;
}

function stripNarratedToolMarkup(raw: string): string {
  return stripNarratedToolTags(raw)
    .split(/\r?\n/)
    .filter((line) => !NARRATED_TOOL_LINE_RE.test(line))
    .join("\n")
    .trim();
}

function stripExecutionChatterParagraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .filter((paragraph) => !EXECUTION_CHATTER_START_RE.test(paragraph))
    .join("\n\n")
    .trim();
}

/**
 * A paragraph that opens like step narration ("Let me …", "I'll …") and carries nothing after a
 * colon — "I'll be direct: option B is cheaper" and "I'm going to need more details: which
 * region?" deliver content on the colon's own line, so they are not narration ("9:00" is not such
 * a colon, and neither is one that ends its line before a tool call printed as text).
 */
function announcesStep(paragraph: string): boolean {
  return EXECUTION_CHATTER_START_RE.test(paragraph) && !/:[ \t]+\S/.test(paragraph.split(/\r?\n/)[0]!);
}

/** True when every paragraph of `text` is step narration (see announcesStep). */
export function isExecutionChatterOnly(text: string): boolean {
  const paragraphs = (text ?? "").split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  return paragraphs.length > 0 && paragraphs.every(announcesStep);
}

/**
 * Clean a turn's FINAL answer. Narrated tool markup is always removed, but the paragraph-level
 * execution-chatter filter runs only when the text itself narrates tool calls (literal tool
 * markup, NARRATED_TOOL_TEXT_RE) — then the "Let me search…" paragraphs around that markup are
 * the narration. The final answer's own paragraphs are never filtered just because the turn ran
 * tools: verified 2026-10-05, a tool-using turn's synthesized answer lost its paragraph "I'll be
 * direct: option B is cheaper and faster." (and every "Let me know if …" closing) to the opener
 * regex. And the filter never empties an answer: when every paragraph reads as narration the
 * markup-free text is returned, and the caller decides whether to resynthesize
 * (shouldResynthesizeUserFacingResponse reads isExecutionChatterOnly).
 *
 * `stripLeadingNarration` (a turn that ran tools): the answer may still OPEN with leftover step
 * narration ("Let me check the pricing page.\n\nThe price is $5/month."). A leading run of such
 * paragraphs is dropped when substantive content follows — only one-sentence paragraphs that
 * announce a step: "Let me know …" (addressed to the user) and "I'll be direct: …" (content after
 * a colon) are not narration and stay.
 */
export function sanitizeFinalAnswerContent(value: string, opts?: { stripLeadingNarration?: boolean }): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  const markupFree = stripNarratedToolMarkup(raw);
  if (!markupFree) return markupFree;
  if (NARRATED_TOOL_TEXT_RE.test(raw)) return stripExecutionChatterParagraphs(markupFree) || markupFree;
  return opts?.stripLeadingNarration ? stripLeadingNarrationParagraphs(markupFree) : markupFree;
}

/** One sentence that announces a step and carries nothing else ("Let me know …" is for the user). */
function isLeadingNarrationParagraph(paragraph: string): boolean {
  return announcesStep(paragraph)
    && !/^\s*let me know\b/i.test(paragraph)
    && !/[.!?]\s+\S/.test(paragraph.trim());
}

function stripLeadingNarrationParagraphs(text: string): string {
  const paragraphs = text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  let first = 0;
  while (first < paragraphs.length && isLeadingNarrationParagraph(paragraphs[first]!)) first += 1;
  return first === 0 || first >= paragraphs.length ? text : paragraphs.slice(first).join("\n\n");
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
      .some((line) => NARRATED_TOOL_LINE_RE.test(line));

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
    .filter((line) => !NARRATED_TOOL_LINE_RE.test(line))
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
