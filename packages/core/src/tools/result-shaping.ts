/**
 * Tool result shaping utilities.
 *
 * Enforces a hard upper limit on the raw character count of individual tool results
 * fed into sub-agent context windows.  Without this cap, a single large browser
 * navigation (e.g. 900 KB Wikipedia page) can exhaust the context budget and cause
 * subsequent tool calls to be dropped or truncated by the LLM provider.
 *
 * The truncation strategy keeps the first 70 % and last 20 % of the content so that
 * both the introductory context and any trailing summary / footer are preserved.
 */

/** Maximum characters allowed per single tool result before truncation kicks in. */
export const MAX_TOOL_RESULT_CHARS = 32_768;

/**
 * Truncates a tool result to at most MAX_TOOL_RESULT_CHARS characters.
 *
 * If no truncation is needed the original string is returned unchanged.
 * Otherwise a head (70 %) + tail (20 %) slice is returned with a clear
 * truncation notice in between that includes the original size.
 */
export function truncateToolResult(content: string, toolName: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;

  const headSize = Math.floor(MAX_TOOL_RESULT_CHARS * 0.7);
  const tailSize = Math.floor(MAX_TOOL_RESULT_CHARS * 0.2);
  const head = content.slice(0, headSize);
  const tail = content.slice(content.length - tailSize);

  return (
    `${head}\n\n` +
    `[${toolName} output truncated: original ${content.length} chars, ` +
    `showing first ${head.length} + last ${tail.length} chars. ` +
    `Use more targeted queries or page-specific anchors to access omitted sections.]\n\n` +
    `${tail}`
  );
}
