/**
 * Single-deliverable relay shortcut (god-file seam, extracted from runtime.ts).
 *
 * When a turn's ONE delegation already produced a complete, presentable deliverable,
 * these helpers decide whether it can be surfaced AS-IS — so the main assistant does
 * not run a second full synthesis pass over it (the biggest avoidable per-turn cost on
 * the slow local model, and the source of coordinator↔assistant divergence; audit
 * 5d51862f). Plus the meta-reasoning-preamble stripper and the truncated-code detector
 * that gate what is safe to relay verbatim.
 *
 * Pure text helpers — no runtime singletons. Re-exported from runtime.js so existing
 * importers (tests, tools) keep working unchanged.
 */
import { DELEGATE_TOOL_RESULT_RE, looksLikeOrchestrationOnlyEvidence } from "./runtime-utils.js";
import { EVIDENCE_SECTION_RE } from "./interrupted-delegation-evidence.js";
import { looksLikeDegenerateRepetition } from "./text-dedup.js";
import { looksLikeProviderErrorEcho } from "./container-failure.js";
import {
  looksLikeRawToolEvidenceDump,
  looksLikeRawSharedFactsDump,
  looksLikeRawWorkspaceToolDump,
} from "./runtime-evidence-dump.js";

/**
 * Cost-center 2 (audit 5d51862f): a meta-reasoning preamble the specialist sometimes
 * prepends to its deliverable ("Now I have comprehensive evidence. Let me synthesize…")
 * before the real content. When relaying the deliverable verbatim we strip that short
 * lead-in so the user sees the answer, not the agent's thinking. Conservative: only
 * removes a short (<400 char) meta lead-in that sits before an early `---` rule or `#`
 * heading; otherwise the text is returned unchanged.
 */
const REASONING_PREAMBLE_STARTERS = /^(now\b|let me\b|here(?:'s| is| are)\b|based on\b|i['’]?(?:ll| ve| have)\b|i will\b|i now\b|okay\b|alright\b|sure\b|with (?:the|these|all)\b|to (?:answer|address|fulfil|fulfill|summari[sz]e)\b)/i;

export function stripLeadingReasoningPreamble(text: string): string {
  const t = text.trimStart();
  if (/^(#{1,6}\s|\||[-*+]\s|\d+[.)]\s|>\s)/.test(t)) return t; // already real content
  if (!REASONING_PREAMBLE_STARTERS.test(t)) return t;
  const window = t.slice(0, 800);
  const hr = /\n\s*-{3,}\s*\n/.exec(window);
  const heading = /\n#{1,6}\s/.exec(window);
  let cut = -1;
  if (hr) cut = hr.index + hr[0].length;
  if (heading && (cut === -1 || heading.index + 1 < cut)) cut = heading.index + 1;
  if (cut <= 0 || cut > 400) return t;
  return t.slice(cut).trimStart();
}

/**
 * True when a deliverable contains an UNTERMINATED fenced code block — an odd number
 * of ``` fences means one was opened and never closed, i.e. the text was cut off
 * mid-code (the slow local model hit its token/time budget while emitting a large
 * code blob). Such a deliverable is broken (truncated HTML/JS/etc.) and must never be
 * relayed as finished. Purely structural — counts fence lines, no language/lexicon.
 */
export function looksLikeTruncatedCodeDeliverable(text: string): boolean {
  const fences = (text.match(/^[ \t]*```/gm) ?? []).length;
  return fences % 2 === 1;
}

/**
 * Decide whether a turn's single delegation already produced a complete, presentable
 * deliverable that can be surfaced AS-IS — so the main assistant does not run a second
 * full synthesis pass over it (the biggest avoidable per-turn cost on the slow local
 * model, and the source of coordinator↔assistant divergence; audit 5d51862f). Returns
 * the clean deliverable text, or null when the normal synthesis path should run.
 *
 * Deliberately strict: exactly ONE successful delegation this turn, its tool result was
 * tagged a long deliverable ("present … VERBATIM"), and the evidence is a real structured
 * answer (headings/table/bullets) that is not a raw dump / provider error / scaffold.
 */
export function extractSingleRelayableDeliverable(
  toolResultMessages: readonly { role: string; content?: string | null }[],
  turnDelegationCount: number,
): string | null {
  if (turnDelegationCount !== 1) return null;
  const delegateResults = toolResultMessages.filter(
    (m) => m.role === "tool" && typeof m.content === "string" && DELEGATE_TOOL_RESULT_RE.test(String(m.content)),
  );
  if (delegateResults.length !== 1) return null;
  const content = String(delegateResults[0]!.content ?? "");
  if (!/TASK COMPLETED\b/i.test(content)) return null;
  if (/TASK FAILED|PARTIAL PROGRESS|TASK COMPLETED \(PARTIAL/i.test(content)) return null;
  // Only the long-deliverable formatting carries this marker; short relays still synthesize.
  if (!/Present the full content below VERBATIM/i.test(content)) return null;
  const m = EVIDENCE_SECTION_RE.exec(content);
  if (!m) return null;
  const evidence = stripLeadingReasoningPreamble(content.slice(m.index + m[0].length).trim());
  if (evidence.length < 800) return null;
  // A degenerate, repetition-looped deliverable must NOT be relayed verbatim. Return
  // null so the normal synthesis pass runs and cleans it into a usable answer — the
  // behaviour that worked before this relay shortcut existed (audit 9fd16384: the slow
  // model looped "Microphone Selection: …" 17× and the relay shipped it as-is).
  if (looksLikeDegenerateRepetition(evidence)) return null;
  // A truncated/unterminated code-blob deliverable must NOT be relayed verbatim. A
  // research agent that improvises a build (audit 61683c52: a single "research THEN
  // build a WebApp" task sent to researcher, which authored a 14 KB single-file HTML
  // blob and ran out of budget at the soft deadline) emits an OPENED ``` fence that
  // never closes — the answer literally ends mid-string. Shipping that as a "finished
  // deliverable" both gives the user broken code AND suppresses the auto-build net
  // that would route the build to a real builder. Unbalanced fences = cut off =
  // not shippable; structural + language-independent (no lexicon).
  if (looksLikeTruncatedCodeDeliverable(evidence)) return null;
  if (REASONING_PREAMBLE_STARTERS.test(evidence)) return null; // couldn't clean the lead-in
  if (
    looksLikeRawToolEvidenceDump(evidence)
    || looksLikeRawSharedFactsDump(evidence)
    || looksLikeProviderErrorEcho(evidence)
    || looksLikeRawWorkspaceToolDump(evidence)
    || looksLikeOrchestrationOnlyEvidence(evidence)
  ) return null;
  const tableRows = (evidence.match(/^\s*\|.+\|\s*$/gm) ?? []).length;
  const headings = (evidence.match(/^#{1,6}\s/gm) ?? []).length;
  const bullets = (evidence.match(/^\s*[-*+]\s+\S/gm) ?? []).length;
  if (tableRows < 4 && headings < 2 && bullets < 6) return null;
  return evidence;
}
