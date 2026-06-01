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

/** Universal web page-furniture words. A finding dominated by these is the
 * navigation / login / cookie chrome a fetch dragged in, not a real fact.
 * Deliberately topic-agnostic — no domain or product terms (those would
 * overfit one site / one example request). */
const NAV_CHROME_WORDS = new Set<string>([
  "login", "log", "register", "signin", "sign", "signup", "logout", "account",
  "menu", "dashboard", "cookie", "cookies", "accept", "consent", "privacy",
  "newsletter", "subscribe", "skip", "breadcrumb", "settings", "notifications",
  "bookmarks", "navigation", "footer", "header", "sitemap", "copyright",
  "search", "home", "language",
]);

/**
 * Quality gate for auto-shared findings: returns true when an extracted value
 * carries no synthesis value and must NOT be written to shared facts.
 *
 * Catches the noise that has polluted shared facts: raw PDF/binary bytes, bare
 * HTTP-probe header dumps with no prose, navigation/login boilerplate, and
 * symbol/number-only blobs. Structural signals only — no topic keywords — so it
 * generalizes across sites and requests instead of fixing one example.
 *
 * Run AFTER extractKeyFacts so the boilerplate stripping has already had its
 * chance; this rejects what survives that and is still not a real finding.
 */
export function extractedFindingIsLowValue(value: string): boolean {
  const v = value.trim();
  if (!v) return true;

  // Raw PDF / binary bytes — never a readable finding.
  if (/%PDF-\d/i.test(v)) return true;
  if (/\bendobj\b|\bendstream\b|\/FlateDecode\b|\/MediaBox\b|\/Linearized\b/i.test(v)) return true;
  if (/(?:\b0{6,}\b[^\n]*){3,}/.test(v)) return true; // PDF xref offset tables

  // Bare HTTP/probe header dump: status line + headers, with no actual sentence.
  if (/\b\d{3}\s+(?:OK|Not Found|Found|Moved|Forbidden|No Content)\b/i.test(v)
    && /\b(?:content-type|last-modified|content-length|final):/i.test(v)
    && !/[.!?]\s/.test(v)) return true;

  // Readable-word density. Match alphabetic tokens (len >= 2) so terse spec
  // findings ("SNR 73 dB AOP 124 analog output") survive, but pure byte/number
  // dumps (< 3 real words) are rejected.
  const realWords = v.match(/[\p{L}][\p{L}'-]+/gu) ?? [];
  if (realWords.length < 3) return true;

  // Navigation / login / cookie chrome. Only meaningful once there are enough
  // words for the ratio to be stable; a high fraction of page-furniture words
  // means the crawler captured the menu/footer, not a finding. Real prose never
  // approaches 45% chrome words, so this won't drop substantive content.
  if (realWords.length >= 10) {
    const navHits = realWords.filter((w) => NAV_CHROME_WORDS.has(w.toLowerCase())).length;
    if (navHits / realWords.length >= 0.45) return true;
  }

  return false;
}
