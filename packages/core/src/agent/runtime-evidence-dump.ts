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
 * formatSourceSensitiveEvidenceBackstop, …) stay in runtime.ts. The one import is the fixed-text
 * language helper (reply-language.ts), for the note under a plan's results.
 */
import { localizedFixedText } from "./reply-language.js";

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
  // A browser tool's page result (Playwright MCP) leads with the code it ran or the page's state, and
  // carries the page tree's element handles ("[ref=e12]"), which no written answer does (E2E
  // 2026-10-12: with the model server unreachable, three page results shipped as the reply).
  if (/^[\s>*#`_-]{0,8}(?:Ran Playwright code|Page state\b)/i.test(v)) return true;
  if ((v.match(/\[ref=e\d+\]/g) ?? []).length >= 3) return true;
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

/**
 * How the routing note delegate_to_agent appends to an answer it routed itself (no agent named)
 * begins: "\n↳ Auto-routed to <agent> (<confidence> confidence…)". One definition for the tool that
 * writes the note (formatDelegatedOutput) and for stripDelegateRelayFrame, which takes it off.
 */
export const AUTO_ROUTED_NOTE_LEAD = "\n↳ Auto-routed to ";

/**
 * A delegated result as the orchestrator reads it: "[<agent>]: <answer>", followed by the routing
 * note when routing picked the agent. The label and the note tell the orchestrator who answered;
 * they are not part of the answer (stripDelegateRelayFrame).
 */
export function formatDelegatedOutput(
  agentName: string,
  output: string,
  routing?: { confidence: string; matchedTerms: readonly string[] },
): string {
  const note = routing
    ? `${AUTO_ROUTED_NOTE_LEAD}${agentName} (${routing.confidence} confidence${routing.matchedTerms.length > 0 ? `, matched: ${routing.matchedTerms.join(", ")}` : ""})`
    : "";
  return `[${agentName}]: ${output}${note}`;
}

/**
 * The specialist's answer inside a delegated result (formatDelegatedOutput): without the trailing
 * routing note and the leading "[<agent>]:" label, an "ephemeral:<name>" label included. For a
 * runtime path that ships a delegate_to_agent result to the user: with the label in front, the
 * last-resort raw-dump guard (looksLikeRawToolEvidenceDump) replaced the whole answer (E2E
 * guards-list-files-on-a-file: a 541-character listing shipped as a fact-free heading).
 */
export function stripDelegateRelayFrame(output: string): string {
  let text = output ?? "";
  const noteAt = text.lastIndexOf(AUTO_ROUTED_NOTE_LEAD);
  if (noteAt >= 0 && !text.slice(noteAt + AUTO_ROUTED_NOTE_LEAD.length).trimEnd().includes("\n")) {
    text = text.slice(0, noteAt);
  }
  return text.replace(/^\s*\[[^\]\n]+\]:\s*/, "").trim();
}

/**
 * The plan report (tools/plan-executor.ts), which record_plan carries too once it has folded the plan
 * round: a roll-call, the steps still owed, "COMPLETED:", then the step results under
 * PLAN_RESULTS_HEADING, each "[<step id>] <description>\n<result>" (formatPlanStepResult), and after
 * them only sections that open with one of the leads below. The executor writes these strings from
 * here, so planReportResultsForDisplay reads what it writes.
 */
export const PLAN_RESULTS_HEADING = "RESULTS — write the final answer from these:";
export const PLAN_FINAL_STEP_HEADING = "FINAL STEP — yours, in the reply (nothing dispatches it):";
export const PLAN_MARKED_DONE_LEAD = "Marked done: ";
export const PLAN_RETRIED_LEAD = "Retried: ";
export const PLAN_IGNORED_IDS_LEAD = "Ignored — no such step id: ";
export const PLAN_CLOSING_ALL_RAN = "Every step has run. Synthesize the final answer from the results above, against the acceptance criteria.";
export const PLAN_CLOSING_OUTSTANDING = "Do NOT write the final answer while steps above are outstanding.";
const PLAN_RESULTS_OMITTED_TAIL = " further result(s) omitted for length.)";

/** The note under the results when the report's budget left some out. */
export function planResultsOmittedNote(omitted: number): string {
  return `(${omitted}${PLAN_RESULTS_OMITTED_TAIL}`;
}

/** One step's block in the report's results. */
export function formatPlanStepResult(id: string, description: string, result: string): string {
  return `[${id}] ${description}\n${result}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A plan step that did not complete: an entry of execute_plan's outstandingSteps. */
export interface PlanStepNotCompleted {
  id: string;
  /** "failed", "manual" (the orchestrator's own, not done) or "pending" (did not run). */
  status: string;
  description?: string;
}

/** What execute_plan's metadata says about its report (see planReportResultsForDisplay). */
export interface PlanReportFacts {
  /** The steps whose results the report carries, in its order (reportedResultIds). */
  reportedResultIds?: readonly string[];
  /** The steps that failed, are still the orchestrator's to do, or did not run (outstandingSteps). */
  outstandingSteps?: readonly PlanStepNotCompleted[];
}

const NOT_COMPLETED_LABEL: Record<string, { de: string; en: string }> = {
  failed: { de: "fehlgeschlagen", en: "failed" },
  manual: { de: "nicht erledigt", en: "not done" },
  pending: { de: "nicht ausgeführt", en: "did not run" },
};

/**
 * The line under a plan's results that says what they leave out: the steps that did not complete,
 * and the results the report's budget omitted. Without it a plan that half ran reads as finished.
 * Null when nothing is left out. Fixed text, in the language the person wrote in.
 */
function planIncompletenessNote(notCompleted: readonly PlanStepNotCompleted[], someOutstanding: boolean, omitted: number): string | null {
  const lines: string[] = [];
  if (notCompleted.length > 0) {
    const items = (language: "de" | "en") => notCompleted
      .map((step) => {
        const name = (step.description ?? "").replace(/\s+/g, " ").trim() || step.id;
        const label = NOT_COMPLETED_LABEL[step.status]?.[language] ?? step.status;
        return `${name} (${label})`;
      })
      .join("; ");
    lines.push(localizedFixedText({
      de: `In diesem Lauf nicht abgeschlossen: ${items("de")}.`,
      en: `Not completed in this run: ${items("en")}.`,
    }));
  } else if (someOutstanding) {
    lines.push(localizedFixedText({
      de: "Nicht jeder Schritt des Plans wurde in diesem Lauf abgeschlossen.",
      en: "Not every step of the plan was completed in this run.",
    }));
  }
  if (omitted > 0) {
    lines.push(localizedFixedText({
      de: `Weitere Schrittergebnisse wurden aus Platzgründen weggelassen (${omitted}).`,
      en: `Further step results were left out for length (${omitted}).`,
    }));
  }
  return lines.length > 0 ? lines.join(" ") : null;
}

/**
 * The step results of a plan report, for a reply the user reads: without the report's roll-call and
 * its instructions to the orchestrator, and without the relay frame of a delegated step's result. A
 * coverage backstop (hallucinated_truncation_bypass) shipped a folded record_plan report as the
 * reply, "Plan recorded … do NOT call execute_plan again" and the "[browser_agent]:" labels included
 * (E2E new-plan-round-fold-site-facts).
 *
 * What the results leave out is said under them: the steps that failed or did not run, and results
 * the report omitted for length (planIncompletenessNote); the report's own sections that said so are
 * instructions to the orchestrator and do not ship. With the steps named (`facts.reportedResultIds`)
 * each "[<id>] <description>" header becomes the description as a heading when there are several
 * results, and goes when there is one; without them the headers stay. Null when the report carries
 * no result.
 */
export function planReportResultsForDisplay(report: string, facts: PlanReportFacts = {}): string | null {
  const text = (report ?? "").replace(/\r\n/g, "\n");
  const at = text.indexOf(PLAN_RESULTS_HEADING);
  if (at < 0) return null;
  let results = text.slice(at + PLAN_RESULTS_HEADING.length);
  const ends = [PLAN_FINAL_STEP_HEADING, PLAN_MARKED_DONE_LEAD, PLAN_RETRIED_LEAD, PLAN_IGNORED_IDS_LEAD, PLAN_CLOSING_ALL_RAN, PLAN_CLOSING_OUTSTANDING]
    .map((lead) => results.indexOf(`\n\n${lead}`))
    .filter((index) => index >= 0);
  const omitted = new RegExp(`\\n\\n\\((\\d+)${escapeRegExp(PLAN_RESULTS_OMITTED_TAIL)}`).exec(results);
  if (omitted) ends.push(omitted.index);
  if (ends.length > 0) results = results.slice(0, Math.min(...ends));
  let blocks = `\n\n${results.trim()}`;
  // A delegated step's result opens with its relay label, on the line under the step's header.
  blocks = blocks.replace(/(\n\n\[[^\]\n]+\] [^\n]*\n)[ \t]*\[[^\]\n]+\]:[ \t]*/g, "$1");
  const stepIds = facts.reportedResultIds ?? [];
  for (const id of stepIds) {
    blocks = blocks.replace(new RegExp(`\\n\\n\\[${escapeRegExp(id)}\\] ([^\\n]*)\\n`), (_match, description: string) => {
      const heading = description.trim();
      return stepIds.length > 1 && heading ? `\n\n**${heading}**\n` : "\n\n";
    });
  }
  blocks = blocks.replace(new RegExp(`${escapeRegExp(AUTO_ROUTED_NOTE_LEAD)}[^\\n]*`, "g"), "");
  const shown = blocks.trim();
  if (!shown) return null;
  const note = planIncompletenessNote(
    facts.outstandingSteps ?? [],
    text.includes(`\n\n${PLAN_CLOSING_OUTSTANDING}`),
    omitted ? Number(omitted[1]) : 0,
  );
  return note ? `${shown}\n\n${note}` : shown;
}
