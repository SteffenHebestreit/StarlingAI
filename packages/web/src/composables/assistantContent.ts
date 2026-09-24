/**
 * What an assistant bubble says, derived from what the model wrote plus the tools it called.
 *
 * Moved out of the store so the rules can be exercised on their own — in particular the one
 * difference between a finished answer and a segment the turn moved on from, which is easy to
 * lose: only the finished answer may fall back to a stand-in sentence when the model said nothing.
 */

interface ContentToolCall {
  name: string;
  args?: Record<string, unknown>;
}

const THINKING_BLOCK_RE = /<(thinking|think)>[\s\S]*?<\/(thinking|think)>/gi;
const NARRATED_TOOL_TEXT_RE = /<tool_call>|<function=|<parameter=|\[Tool:/i;
const EXECUTION_CHATTER_START_RE = /^\s*(let me|now let me|first let me|i(?:'m| am) going to|i(?:'ll| will)|i found some useful information|let me fetch|let me search|now let me create|now i can)\b/i;

function stripNarratedToolTags(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<function=[^>]*>[\s\S]*?<\/function>/gi, "")
    .replace(/<parameter=[^>]*>[\s\S]*?<\/parameter>/gi, "")
    .replace(/<\/?tool_call>/gi, "")
    .trim();
}

export function sanitizeAssistantMessageContent(
  content: string | null | undefined,
  toolCalls?: Array<unknown>,
): string {
  const raw = typeof content === "string" ? content.trim() : "";
  if (!raw) return "";

  let cleaned = stripNarratedToolTags(raw)
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("[Tool:"))
    .join("\n")
    .trim();

  if (!cleaned) return "";

  if (NARRATED_TOOL_TEXT_RE.test(raw) || (toolCalls?.length ?? 0) > 0) {
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

function summarizeToolOnlyAssistantTurn(toolCalls?: ContentToolCall[]): string {
  if (!toolCalls?.length) return "";

  const toolNames = [...new Set(toolCalls.map((toolCall) => toolCall.name).filter(Boolean))];
  if (toolNames.length === 0) return "";

  if (toolNames.length === 1) {
    const toolName = toolNames[0];
    if (toolName === "delegate_to_agent") {
      const rawTask = toolCalls.find((toolCall) => toolCall.name === toolName)?.args?.["task"];
      const task = typeof rawTask === "string" ? rawTask.replace(/\s+/g, " ").trim() : "";
      if (task) {
        const summary = task.length > 160 ? `${task.slice(0, 157)}...` : task;
        return `Delegated work completed without a text summary: ${summary}`;
      }
      return "Delegated work completed without a text summary. See execution details below.";
    }

    if (toolName === "parallel_delegate") {
      const rawTasks = toolCalls.find((toolCall) => toolCall.name === toolName)?.args?.["tasks"];
      const taskCount = Array.isArray(rawTasks) ? rawTasks.length : 0;
      const suffix = taskCount > 0 ? ` (${taskCount} task${taskCount === 1 ? "" : "s"})` : "";
      return `Parallel delegation completed without a text summary${suffix}. See execution details below.`;
    }

    if (toolName === "run_task_graph") {
      return "Task graph execution completed without a text summary. See execution details below.";
    }
  }

  return `This turn completed via ${toolNames.join(", ")} without a text summary. See execution details below.`;
}

function extractVisibleAssistantContent(
  content: string | null | undefined,
  toolCalls?: ContentToolCall[],
): string {
  const raw = typeof content === "string" ? content.trim() : "";
  if (!raw) return "";
  const withoutThinking = raw.replace(THINKING_BLOCK_RE, "").trim();
  if (!withoutThinking) return "";
  return sanitizeAssistantMessageContent(withoutThinking, toolCalls) || withoutThinking;
}

function mergeCompletedThinkingBlocks(...values: Array<string | null | undefined>): string {
  const blocks = values
    .flatMap((value) => (typeof value === "string" ? (value.match(THINKING_BLOCK_RE) ?? []) : []))
    .map((block) => block.trim())
    .filter(Boolean);
  return [...new Set(blocks)].join("\n\n").trim();
}

export function mergeFinalAssistantContent(response: unknown, streamedText: string, toolCalls?: ContentToolCall[]): string {
  const finalResponse = String(response ?? "").trim();
  const completedThinking = mergeCompletedThinkingBlocks(streamedText, finalResponse);
  const visibleFinal = extractVisibleAssistantContent(finalResponse, toolCalls);
  const visibleStreamed = extractVisibleAssistantContent(streamedText, toolCalls);
  const visibleContent = visibleFinal || visibleStreamed || summarizeToolOnlyAssistantTurn(toolCalls);
  const merged = [completedThinking, visibleContent].filter(Boolean).join("\n\n").trim();

  return merged
    || visibleContent
    || finalResponse
    || streamedText.trim()
    || summarizeToolOnlyAssistantTurn(toolCalls);
}

/**
 * The text of a segment the turn moved on from — what the model said before a message the user
 * sent mid-turn was read. It never gets the tool-only stand-in: "Delegated work completed
 * without a text summary" reads as the turn's answer, and the answer is still further down.
 * A segment with nothing to say shows only its steps.
 */
export function mergeSegmentAssistantContent(text: string, toolCalls?: ContentToolCall[]): string {
  return [mergeCompletedThinkingBlocks(text), extractVisibleAssistantContent(text, toolCalls)]
    .filter(Boolean).join("\n\n").trim();
}

/** A reloaded assistant entry's text: a segment the turn continued past, or the turn's answer. */
export function transcriptAssistantContent(entry: { content: string; toolCalls?: ContentToolCall[]; continued?: boolean }): string {
  return entry.continued
    ? mergeSegmentAssistantContent(entry.content, entry.toolCalls)
    : mergeFinalAssistantContent(entry.content, "", entry.toolCalls);
}
