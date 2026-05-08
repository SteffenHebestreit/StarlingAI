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

/**
 * Extracts key factual content from a raw tool result for shared-facts storage.
 *
 * Unlike a simple head-truncation, this strips boilerplate headers, bare URL
 * lines, and navigation metadata, then extracts title + snippet per result block
 * for structured tools (web_search). This preserves breadth across all results
 * rather than discarding everything past the first N characters.
 *
 * The output is suitable for storing as a shared finding — compact, information-
 * dense, and free of redundant wrapper text that inflates the evidence byte count
 * without adding knowledge.
 */
export function extractKeyFacts(text: string, toolName: string, maxChars = 600): string {
  // Strip known boilerplate common across tool result types.
  let cleaned = text
    // Web search header line
    .replace(/\*\*Web Search Results for:\*\*[^\n]*\n?/g, "")
    // Web fetch / browser content header
    .replace(/\*\*Content from:\*\*[^\n]*\n?/g, "")
    // Full "### Page state" section including the YAML accessibility tree.
    // The snapshot is a DOM ref tree ([ref=eN], [cursor=pointer], etc.) —
    // pure navigation scaffolding with no synthesis value. Strip everything
    // from the section header through the closing backtick of the yaml block.
    .replace(/#{1,4}\s*Page state[\s\S]*?(?=\n#{1,4}\s|\n\n[A-Z#]|$)/m, "")
    // Also catch inline Page Snapshot yaml blocks not preceded by the header
    .replace(/-\s+Page Snapshot:\s*`yaml[\s\S]*?`/g, "")
    // Individual page-state metadata lines
    .replace(/^-\s+Page (?:URL|Title|Status|State|Snapshot):[^\n]*\n?/gm, "")
    // YAML accessibility tree lines (the DOM ref noise from browser_snapshot fallback)
    // Pattern: lines with [ref=eN] or [cursor=...] markers
    .replace(/^[^\n]*\[ref=e\d+\][^\n]*\n?/gm, "")
    .replace(/^[^\n]*\[cursor=[^\]]+\][^\n]*\n?/gm, "")
    // "/url:" entries in the accessibility tree
    .replace(/^\s*-\s*\/url:\s*\S+\s*\n?/gm, "")
    // Bare URL lines that carry no surrounding text
    .replace(/^\s*https?:\/\/\S+\s*$/gm, "")
    // Backend annotation like "(via searxng)"
    .replace(/\(via [\w-]+\)/g, "")
    // Markdown horizontal rules
    .replace(/^---+\s*$/gm, "")
    // Collapse excess blank lines
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (cleaned.length <= maxChars) return cleaned;

  // For web_search: extract one title + first snippet line per result block.
  // Splitting on bold title markers preserves per-result breadth instead of
  // front-truncating and losing everything after the first result.
  if (toolName === "web_search") {
    const segments: string[] = [];
    let total = 0;
    const parts = cleaned.split(/(?=^\*\*[^*\n]+\*\*)/m);
    for (const part of parts) {
      if (total >= maxChars) break;
      const trimmedPart = part.trim();
      if (!trimmedPart) continue;
      const lines = trimmedPart.split("\n").filter(l => l.trim());
      const titleLine = lines[0] ?? "";
      // First non-URL line after the title is the snippet
      const snippetLine = lines.slice(1).find(l => l.trim() && !/^\s*https?:\/\//.test(l)) ?? "";
      const excerpt = snippetLine
        ? `${titleLine}\n${snippetLine.slice(0, 220)}`
        : titleLine.slice(0, 220);
      const remaining = maxChars - total;
      segments.push(excerpt.slice(0, remaining));
      total += Math.min(excerpt.length, remaining) + 1;
    }
    if (segments.length > 0) return segments.join("\n\n").trim();
  }

  // Generic fallback: trim at a word boundary to avoid cutting mid-sentence.
  const cutoff = cleaned.lastIndexOf(" ", maxChars);
  return cleaned.slice(0, cutoff > maxChars * 0.8 ? cutoff : maxChars).trim();
}
