/**
 * Raw-evidence / shared-facts dump detectors and formatters (god-file seam).
 *
 * These are pure, self-contained string→bool/string helpers extracted verbatim
 * from runtime.ts to shrink the hot file. They detect when a sub-agent's
 * "evidence" or final answer is actually a raw tool dump (PDF bytes, web-fetch
 * page chrome, shared-facts bullet lists, workspace/config reads) that must never
 * be shown to the user verbatim, and trim/strip such scaffolding. No dependency
 * on runtime.ts, so the import is strictly one-directional (no cycle). The
 * interwoven async/formatter functions that need runtime internals
 * (getSharedFactsEvidenceForFinalSynthesis, compactSourceSensitiveEvidenceForDisplay,
 * formatSourceSensitiveEvidenceBackstop, …) stay in runtime.ts.
 */

// A shared-fact value that is a raw tool dump, not user-facing evidence: PDF
// bytes / internals, or a bare url_inspect HTTP-probe line (status + headers,
// no prose). These must never crowd out or stand in for curated findings — they
// are exactly what produced the "answer = %PDF-1.7 … 200 OK application/pdf"
// garbage when a coordinator's synthesis timed out and the backstop fired.
export function isJunkEvidenceValue(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (/%PDF-\d/i.test(v)) return true;
  if (/\bendobj\b|\bendstream\b|\/FlateDecode\b|\/MediaBox\b/i.test(v)) return true;
  if (/(?:\b0{6,}\b[^\n]*){3,}/.test(v)) return true; // PDF xref offset tables
  // url_inspect probe: "200 OK final: <url> content-type: …" with no sentence.
  if (/\b\d{3}\s+(?:OK|Not Found|Found|Moved|Forbidden)\b/i.test(v)
    && /\bcontent-type:/i.test(v)
    && !/[.!?]\s/.test(v)) return true;
  return false;
}

/**
 * Returns true when the evidence looks like a raw shared-facts dump that
 * should not go to the user verbatim. Two shapes show up in practice:
 *
 *   1. `getSharedFactsEvidenceForFinalSynthesis` output — bullet list whose
 *      lines start with `- auto_<agent>_<tool>_<hash>:` keys.
 *   2. `read_shared_facts` tool output collapsed into a sub-agent's
 *      partial-progress evidence snippet — prefixed by `- read_shared_facts:`
 *      and containing `## Shared Session Facts (N)` plus space-separated
 *      `**auto_xxx**: <value>` pairs (whitespace flattened by the snippet
 *      truncator). This shape arrives when a coordinator's final synthesis
 *      times out at the LLM provider after collecting shared findings.
 *
 * Either shape is debug-shaped output unsuitable for the user.
 */
export function looksLikeRawSharedFactsDump(evidence: string): boolean {
  const trimmed = evidence.trim();
  if (!trimmed) return false;
  if (/^[ \t]*-\s+auto_[a-z0-9_]+:\s*/im.test(trimmed)) return true;
  if (/##\s+Shared\s+Session\s+Facts\s+\(\d+\)/i.test(trimmed)
    && /(?:\*\*)?auto_[a-z0-9_]+(?:\*\*)?:\s*/i.test(trimmed)) {
    return true;
  }
  if (/^[ \t]*-\s+read_shared_facts:\s*/im.test(trimmed)
    && /(?:\*\*)?auto_[a-z0-9_]+(?:\*\*)?:\s*/i.test(trimmed)) {
    return true;
  }
  return false;
}

export function looksLikeRawWorkspaceToolDump(evidence: string): boolean {
  const trimmed = evidence.trim();
  if (!trimmed) return false;
  const compact = trimmed.replace(/\s+/g, " ").slice(0, 12_000);
  if (/\.starlingai\/\s+agent_outcomes\.ndjson\s+README\.md\s+agents\/\s+10-core-agents\.jsonc\s+2\d-[a-z-]+\.jsonc/i.test(compact)) {
    return true;
  }
  if (/[{]\s*"(?:agents|subAgents)"\s*:\s*[{]/i.test(compact)
    && /"systemPrompt"\s*:/i.test(compact)
    && /"primary"\s*:\s*"lmstudio\//i.test(compact)) {
    return true;
  }
  return /####\s+Tool Calls/i.test(trimmed)
    && /\b(?:read_file|list_files|search_agents|agent_catalog)\b/i.test(trimmed)
    && /\b(?:agents\/|10-core-agents\.jsonc|2\d-[a-z-]+\.jsonc|"subAgents"|"agents")\b/i.test(trimmed);
}

export function formatRawWorkspaceToolDumpFailure(): string {
  return "The delegated maintenance attempt only returned raw workspace/config read output and did not provide evidence of a completed write, validation, or config rebuild.";
}

export function trimSharedFactDisplayTail(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact.endsWith("...") && !compact.endsWith("…")) return compact;
  const stripped = compact.replace(/[\s.…]+$/g, "").trim();
  const lastPeriod = stripped.lastIndexOf(".");
  if (lastPeriod >= 120 && lastPeriod < stripped.length - 1) {
    return stripped.slice(0, lastPeriod + 1);
  }
  const lastSpace = stripped.lastIndexOf(" ");
  if (lastSpace >= 120) return `${stripped.slice(0, lastSpace).trim()} […]`;
  return `${stripped} […]`;
}

/**
 * True when a string is a RAW TOOL-RESULT DUMP rather than a written answer: web_fetch
 * page text ("Content from: <url> …"), search-result blocks ("Web Search Results for:
 * …"), recovered-evidence scaffolding, or scraped page chrome ("Jump to content",
 * "move to sidebar", "Create account Log in"). Such a dump must never be the
 * user-facing final answer (audit 003f5aeb: every Dresden presentation run, when the
 * artifact build failed, shipped the raw Dresden_Castle Wikipedia nav menu verbatim).
 * Requires >= 2 distinct structural markers so a genuine synthesized answer that merely
 * cites a URL is not flagged. Topic- and site-agnostic — structural framing only.
 */
export function looksLikeRawToolEvidenceDump(value: string): boolean {
  const v = value.trim();
  if (v.length < 200) return false;
  // A user-facing answer that LEADS with a raw tool-result header is always a dump —
  // a synthesized answer never begins with "Web Search Results for:", "Content from:
  // <url>", or recovered-evidence scaffolding. One leading marker is enough (audit
  // 33df2aec: a search-results partial led with "Web Search Results for: … MENU Home
  // Travel …" and shipped verbatim — only one structural marker, so the >=2 rule below
  // missed it). Tolerates a little leading markdown/punctuation.
  if (/^[\s>*#`_-]{0,8}(?:Web Search Results for:|Content from:\s*https?:\/\/|Recovered evidence snippets|Partial progress before interruption)/i.test(v)) {
    return true;
  }
  // A user-facing answer that LEADS with an agent-label echo ("[researcher]:",
  // "**[mission_coordinator]**:", often doubled "[researcher]:\n[researcher]:") is a
  // verbatim regurgitation of a delegate / parallel_delegate evidence block, never a
  // synthesized answer (audit 49372c7a: a hardware-BOM turn shipped "[researcher]:\n
  // [researcher]: Based on the curated findings …" truncated mid-source). The bracketed
  // token is a lowercase agent identifier; a real synthesis never opens this way, and a
  // markdown link is "[text](url)" / a reference def starts with a non-letter or never
  // leads a final answer. Structural + agent-agnostic.
  if (/^[\s>*#`_-]{0,8}\[[a-z][a-z0-9_]{2,}\]\*{0,2}:/i.test(v)) {
    return true;
  }
  let hits = 0;
  if (/(?:^|\n|\s)Content from:\s*https?:\/\//i.test(v)) hits += 1;
  if (/Web Search Results for:/i.test(v)) hits += 1;
  if (/Recovered evidence snippets|Partial progress before interruption/i.test(v)) hits += 1;
  if (/Jump to content|Skip to (?:main )?content|move to sidebar|Create account\s+Log\s*in/i.test(v)) hits += 1;
  return hits >= 2;
}

/**
 * Strip a leading delegate label echo ("[researcher]:", often doubled as
 * "[researcher]:\n[researcher]:") that parallel_delegate / the relay prepends to a sub-agent's
 * answer. The label is relay scaffolding, not content — but it makes the otherwise-clean
 * synthesis underneath trip {@link looksLikeRawToolEvidenceDump} (audit 49372c7a), so the good
 * delegate guide gets discarded and the backstop ships raw shared facts instead (audit
 * da8fc547: the IM73A135V01-vs-INMP441 build guide was dropped for raw datasheet reflow temps).
 * Removes up to a few leading "[agent]:" labels so the real synthesis can serve as a backstop.
 */
export function stripLeadingDelegateLabelEcho(text: string): string {
  let t = (text ?? "").trimStart();
  for (let i = 0; i < 4; i++) {
    const m = /^\[[a-z][a-z0-9_]{2,}\]\*{0,2}:[ \t]*\n?/i.exec(t);
    if (!m) break;
    t = t.slice(m[0].length).trimStart();
  }
  return t;
}
