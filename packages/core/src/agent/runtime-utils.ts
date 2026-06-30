/**
 * Foundational LEAF utilities for the agent runtime cluster.
 *
 * Small, PURE, low-level helpers that runtime.ts AND its already-extracted
 * sibling modules (evidence-recovery.ts, citation-honesty.ts,
 * delegation-response-collapse.ts) all depend on. Extracting them here breaks
 * the runtime.ts ↔ evidence-recovery.ts circular import and lets future
 * extractions stay cycle-free.
 *
 * INVARIANT: this module imports ONLY from leaf/external modules (types,
 * container-failure). It must NEVER import from runtime.js or any of the
 * runtime cluster modules — keep it a true leaf.
 */
import { looksLikeHallucinatedTruncationClaim } from "./container-failure.js";
import type { SessionHistoryMessage } from "./session.js";

export function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Builder roles whose delegated task is a BUILD SPEC worth preserving (role-based, no message keywords). */
export const BUILDER_AGENT_ROLE_RE = /^(?:content_writer|web_coder|backend_coder)$/i;

/**
 * True when a final answer is substantially a verbatim copy of an EARLIER
 * assistant turn. On a turn where every tool call was blocked (no successful work
 * happened), this means the model gave up and parroted a previous deliverable
 * summary — shipping a stale FALSE SUCCESS that implies the user's new request was
 * carried out when it was not (audit 43b3ec65 turn 3: "update the presentation and
 * add the sources" shipped a verbatim copy of the turn-1 "presentation created"
 * summary — no edit, no sources). Scans EVERY prior assistant answer, not just the
 * most recent, because the parroted turn may be several turns back. A shared
 * 180-char normalized leading slice is a near-certain duplication signal; genuinely
 * distinct answers do not coincidentally share that much text. Topic-agnostic.
 */
function leadingContentTokenSet(normalized: string): Set<string> {
  // First ~80 word tokens of the leading slice, Unicode-aware so German umlaut
  // words ("präsentation", "zerstörung") stay intact (\w would shred them).
  return new Set(
    normalized.slice(0, 600).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2).slice(0, 80),
  );
}

export function looksLikeRegurgitatedPriorAnswer(
  candidate: string,
  history: readonly SessionHistoryMessage[],
): boolean {
  const norm = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  const cand = norm(candidate);
  if (cand.length < 180) return false;
  const candHead = cand.slice(0, 180);
  const candTokens = leadingContentTokenSet(cand);
  for (const message of history) {
    if (message.role !== "assistant") continue;
    const hasToolCalls = Array.isArray((message as { tool_calls?: unknown[] }).tool_calls)
      && (((message as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0);
    if (hasToolCalls) continue;
    const prior = typeof message.content === "string" ? norm(message.content) : "";
    if (prior.length < 180) continue;
    // (a) Byte-exact leading slice — the original strict signal.
    if (prior.slice(0, 180) === candHead) return true;
    // (b) One leading slice fully contained in the other — catches a verbatim copy
    //     that merely gained or lost a short prefix (e.g. a "[content_writer]:"
    //     delegate tag, or a "## Zusammenfassung" header). Byte-exact prefix alone
    //     was too brittle: audit f6e10341 turn 3 re-pasted the turn-1 deck summary
    //     yet slipped past the exact check because the stored copy had drifted.
    if (prior.includes(candHead) || cand.includes(prior.slice(0, 180))) return true;
    // (c) High leading-token overlap — near-verbatim with small reordering/word drift
    //     (also survives history compaction, which can lightly reword the stored copy).
    if (candTokens.size >= 20) {
      const priorTokens = leadingContentTokenSet(prior);
      let inter = 0;
      for (const t of candTokens) if (priorTokens.has(t)) inter++;
      const union = new Set([...candTokens, ...priorTokens]).size;
      if (union > 0 && inter / union >= 0.9) return true;
    }
  }
  return false;
}

export const DELEGATE_TOOL_RESULT_RE = /^(Delegated result from|Parallel delegation completed|Task graph (completed|finished))/i;

export function looksLikeDelegateMetadata(meta: Record<string, unknown> | undefined): boolean {
  if (!meta) return false;
  if (typeof meta["delegationOutcome"] === "string") return true;
  if (typeof meta["agentName"] === "string") return true;
  if (meta["delegationSucceeded"] === true) return true;
  if (typeof meta["taskCount"] === "number" || typeof meta["succeeded"] === "number") return true;
  return false;
}

export function countStructuredItems(text: string): number {
  if (!text) return 0;
  const tableRows = (text.match(/^\s*\|.+\|\s*$/gm) ?? []).length;
  // Plain numbered list: "1. foo" / "1) foo".
  const numbered = (text.match(/^\s*\d{1,3}[.)]\s+\S/gm) ?? []).length;
  // Bold-prefixed numbered headlines/sections, common in coordinator
  // markdown output: "**1. Title**" or "**1) Title**". The plain regex
  // above misses these because the line starts with "*".
  const boldNumbered = (text.match(/^\s*\*\*\d{1,3}[.)]\s+\S/gm) ?? []).length;
  const bullets = (text.match(/^\s*[-*+]\s+\S/gm) ?? []).length;
  // Headings (markdown ###/####) used as item separators in long
  // structured deliverables.
  const headings = (text.match(/^\s*#{1,6}\s+\S/gm) ?? []).length;
  return Math.max(tableRows, numbered, boldNumbered, bullets, headings);
}

export function stripToolEvidencePrefix(text: string): string {
  return text.replace(/^(?:[-*]\s*)?(?:[a-z][a-z0-9_]*|artifact)\s*(?:\[[^\]]+\])?:\s+/, "").trim();
}

// Matches an interrupted sub-agent's terminal-reason line — including the
// extended forms ("after finishing the current operation", "before starting
// another tool run") that are tacked onto the duration. This is the first
// line of `buildInterruptedSubAgentOutput` (sub-agent.ts) before the
// `Sub-agent '...' ` prefix is stripped by upstream sanitizers.
const INTERRUPTED_REASON_LINE_RE = /^(?:after finishing the current operation|before starting another tool run|timed out after \d+ms|produced no final response after substantive work|was cancelled)\b/i;

// A bullet-prefixed scaffold line that `buildInterruptedSubAgentOutput`
// produces ("- Tool calls executed: N (...)", "- Iterations completed: N",
// "- Artifacts collected: N (...)"). The pre-existing check matched these
// only at start-of-string without a leading dash; orchestration scaffolds
// always have the dash, so the match consistently failed and the scaffold
// got surfaced as if it were real evidence.
const SCAFFOLD_LIST_LINE_RE = /^(?:[-*]\s+)?(?:Tool calls executed:|Iterations completed:|Artifacts collected:)/i;

export function looksLikeOrchestrationOnlyEvidence(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const withoutToolPrefix = stripToolEvidencePrefix(trimmed);
  if (withoutToolPrefix && withoutToolPrefix !== trimmed && looksLikeOrchestrationOnlyEvidence(withoutToolPrefix)) return true;
  if (looksLikeHallucinatedTruncationClaim(trimmed)) return true;
  if (looksLikeDelegationTaskEcho(trimmed)) return true;
  if (/Partial progress before interruption:/i.test(trimmed)) {
    return true;
  }
  if (/^Recovered evidence snippets from completed tools:/i.test(trimmed)) {
    return true;
  }
  // Whole-string check: every non-empty line is a scaffold line. This
  // catches the residue left after `stripInterruptedSubAgentBoilerplate`
  // failed (or only partially matched) the extended-reason prefix and
  // we're left with a few lines like:
  //   "after finishing the current operation"
  //   "- Tool calls executed: 5 (...)"
  //   "- Iterations completed: 4"
  // None of which carry actual evidence for the user.
  const lines = trimmed.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length > 0 && lines.every((line) =>
    INTERRUPTED_REASON_LINE_RE.test(line)
    || SCAFFOLD_LIST_LINE_RE.test(line)
    || /^Partial progress before interruption:?$/i.test(line)
    || /^Recovered evidence snippets from completed tools:?$/i.test(line),
  )) {
    return true;
  }
  if (/^(?:No agents matched|No workflows matched|Tool calls executed:|Iterations completed:)/i.test(trimmed)) {
    return true;
  }
  if (/\bis already running via\s+(?:[a-z0-9_:-]*(?:_agent|_coordinator)|researcher|another agent)\b/i.test(trimmed)) {
    return true;
  }
  if (/^(?:task_\d+\s+\[running\]|parallel_\d+\s+\[(?:running|pending)\])/i.test(trimmed)) {
    return true;
  }
  if (/^Sub-agent '[^']+'/i.test(trimmed)) {
    return true;
  }
  if (/^Delegated result from/i.test(trimmed) && trimmed.length < 220) {
    return true;
  }
  // Workflow discovery results — coordinator planning steps, not research findings.
  if (/^Workflow matches for\s+["']?/i.test(trimmed)) {
    return true;
  }
  // Workflow config/reference errors — not usable research evidence.
  if (/^Workflow\s+["']?[^"']+["']?\s+\[[^\]]+\]\s+references\s+a\s+scene/i.test(trimmed)) {
    return true;
  }
  if (/^(?:Without the underlying scene|Add the missing scene|or remove the job)/i.test(trimmed)) {
    return true;
  }
  return false;
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function stripPresentationFormatting(value: string): string {
  return value
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

export function looksLikeDelegationTaskEcho(text: string): boolean {
  const normalized = collapseWhitespace(stripPresentationFormatting(text));
  if (!normalized) return false;
  return /\bSOURCE-SENSITIVE DELEGATION(?:\s+(?:SLICE|GRAPH NODE))?\b/i.test(normalized)
    || /\b(?:Original user request|Parent task):\b/i.test(normalized)
    || /\bvia\s+[a-z0-9_:-]+\s+SOURCE-SENSITIVE DELEGATION\b/i.test(normalized);
}
