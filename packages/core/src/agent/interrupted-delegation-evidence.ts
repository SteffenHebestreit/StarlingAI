/**
 * Interrupted/partial delegation evidence-recovery cluster (god-file seam): pure
 * helpers that recover usable evidence from an interrupted or partial sub-agent's
 * surfaced output — stripping the scaffold boilerplate, collecting the real
 * snippets, scoring coverage, and finding the richest recent delegate/workflow
 * result in history to use as a synthesis backstop.
 *
 * Extracted verbatim from runtime.ts. These functions are pure (text/history in,
 * recovered evidence or measurement out) and never touch a runtime main-loop
 * singleton.
 *
 * INVARIANT: this module imports ONLY from leaf/sibling modules (runtime-utils,
 * container-failure, runtime-evidence-dump). It must NEVER import from runtime.js —
 * keep it cycle-free.
 */
import { currentTurnStartIndex } from "./turn-boundary.js";
import { looksLikeProviderErrorEcho } from "./container-failure.js";
import {
  DELEGATE_TOOL_RESULT_RE,
  looksLikeDelegateMetadata,
  countStructuredItems,
  stripToolEvidencePrefix,
  looksLikeOrchestrationOnlyEvidence,
  stripPresentationFormatting,
} from "./runtime-utils.js";
import { looksLikeRawWorkspaceToolDump, stripLeadingDelegateLabelEcho } from "./runtime-evidence-dump.js";

export const WORKFLOW_TOOL_RESULT_RE = /^Workflow\s+\S+\s+\[[^\]]+\]\s+(?:completed|blocked)\./i;
export const EVIDENCE_SECTION_RE = /^Observed evidence:\s*/m;

function stripInterruptedSubAgentBoilerplate(text: string): string {
  return text
    // The reason text is sometimes extended with a tail clause such as
    //   "timed out after Nms after finishing the current operation"
    //   "timed out after Nms before starting another tool run"
    // (see sub-agent.ts hard-deadline branches). The original alternation
    // required `\d+ms` to be followed directly by whitespace + "Partial
    // progress before interruption:", which fails for the extended form
    // and leaves the scaffold prefix in the surfaced evidence. Allow any
    // non-newline tail between the duration and the partial-progress
    // header so both shapes get stripped cleanly.
    .replace(
      /Sub-agent '[^']+' timed out after \d+ms[^\n]*\s+Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
      "",
    )
    .replace(
      /Sub-agent '[^']+' produced no final response after substantive work\.[^\n]*\s+Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
      "",
    )
    .replace(
      /Sub-agent '[^']+' was cancelled[^\n]*\s+Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
      "",
    )
    // Also strip a bare "Partial progress before interruption:" stanza
    // that may appear after the extended-reason text was already matched
    // by an earlier regex but the partial-progress block still trails.
    .replace(
      /Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
      "",
    )
    .replace(/Sub-agent '[^']+' timed out after \d+ms[^\n]*\n?/g, "")
    .replace(/Sub-agent '[^']+' produced no final response after substantive work\.[^\n]*\n?/g, "")
    .replace(/Sub-agent '[^']+' was cancelled[^\n]*\n?/g, "")
    .trim();
}

function stripRecoveredSnippetToolLabel(text: string): string {
  const stripped = stripToolEvidencePrefix(text);
  return stripped || text.trim();
}

function stripDelegationProgressPrefix(text: string): string {
  return text
    .replace(/^(?:parallel|task)_\d+\s+\[[^\]]+\]\s*/i, "")
    .replace(/^[a-z_]+\s+\[[^\]]+\]\s*/i, "")
    .trim();
}

function collectInterruptedDelegationSnippets(text: string): string[] {
  const cleaned = stripPresentationFormatting(text);
  const snippets: string[] = [];
  const seen = new Set<string>();

  const pushSnippet = (candidate: string) => {
    const normalized = stripInterruptedSubAgentBoilerplate(candidate)
      .replace(/^IMPORTANT:\s.*$/gim, "")
      .trim();
    if (!normalized || normalized.length < 80 || looksLikeOrchestrationOnlyEvidence(normalized)) return;
    if (looksLikeProviderErrorEcho(normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    snippets.push(normalized);
  };

  // Recovered delegated specialist body — full delegated content surfaced
  // verbatim by the inner agent's interrupt path (Fix 2). Push it FIRST so
  // it ranks ahead of bullet-list snippets and a downstream cap preserves
  // the actual delegated answer rather than a 900-char head.
  const fullBodyMatch = /Recovered delegated specialist body \(full\):\s*\n([\s\S]+?)(?=\nRecovered evidence snippets from completed tools:|$)/i.exec(cleaned);
  if (fullBodyMatch?.[1]) {
    pushSnippet(fullBodyMatch[1].trim());
  }

  const progressMatch = /Partial progress before interruption:\s*([\s\S]*?)(?=\nRecovered (?:delegated specialist body \(full\)|evidence snippets from completed tools):|$)/i.exec(cleaned);
  if (progressMatch?.[1]) {
    for (const rawLine of progressMatch[1].split("\n")) {
      const line = rawLine.trim();
      if (!line.startsWith("- ")) continue;
      const body = line.slice(2).trim();
      if (!body || /^(?:Tool calls executed:|Iterations completed:)/i.test(body)) continue;
      if (/\[(?:running|pending)\]/i.test(body)) continue;
      if (/^(?:parallel|task)_\d+\s+\[[^\]]+\]/i.test(body) && !body.includes(" | ")) continue;
      const normalizedBody = stripDelegationProgressPrefix(body);
      const candidate = normalizedBody.includes(" | ")
        ? normalizedBody.split(/\s+\|\s+/).slice(1).join(" | ")
        : normalizedBody;
      pushSnippet(candidate);
    }
  }

  const recoveredMatch = /Recovered evidence snippets from completed tools:\s*\n([\s\S]+)$/i.exec(cleaned);
  if (recoveredMatch?.[1]) {
    for (const rawLine of recoveredMatch[1].split("\n")) {
      const line = rawLine.trim();
      if (!line.startsWith("- ")) continue;
      const body = line.slice(2).trim();
      const candidate = stripRecoveredSnippetToolLabel(body);
      pushSnippet(candidate);
    }
  }

  return snippets;
}

function extractUsefulInterruptedDelegationEvidence(text: string): string | null {
  if (!/Partial progress before interruption:|Recovered evidence snippets from completed tools:/i.test(text)) {
    return null;
  }
  const snippets = collectInterruptedDelegationSnippets(text);
  if (snippets.length > 0) return snippets.join("\n\n");

  const fallback = stripInterruptedSubAgentBoilerplate(stripPresentationFormatting(text))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^(?:Tool calls executed:|Iterations completed:|Recovered evidence snippets from completed tools:)/i.test(line))
    .filter((line) => !looksLikeOrchestrationOnlyEvidence(line))
    .join("\n");

  if (fallback.length < 120) return null;
  if (looksLikeProviderErrorEcho(fallback)) return null;
  return fallback;
}

function looksLikeInterruptedDelegationWithoutUsableEvidence(text: string): boolean {
  return /Partial progress before interruption:|Recovered evidence snippets from completed tools:/i.test(text)
    && !extractUsefulInterruptedDelegationEvidence(text);
}

function measureEvidenceCoverage(
  text: string,
  evidence: { evidence: string; itemCount: number },
): { textItems: number; itemShortfall: boolean; lengthShortfall: boolean } {
  const textItems = countStructuredItems(text);
  return {
    textItems,
    itemShortfall: evidence.itemCount >= 5
      && textItems < Math.ceil(evidence.itemCount * 0.6),
    lengthShortfall: evidence.evidence.length >= 1500
      && text.length < Math.ceil(evidence.evidence.length * 0.4),
  };
}

/**
 * Index of the user message that opened the current turn, or -1. A mid-turn steering or
 * oversight message is user-role but does not open a turn (agent/turn-boundary.ts) — keyed on the
 * bare role, the scoped backstops dropped this turn's pre-steering evidence.
 */
function lastUserMessageIndex(
  history: readonly { role: string; metadata?: Record<string, unknown> }[],
): number {
  return currentTurnStartIndex(history);
}

function findRecentDelegateEvidence(
  history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[],
  options: { scopeToCurrentTurn?: boolean } = {},
): { evidence: string; itemCount: number } | null {
  // When scoped to the current turn, drop everything up to and including the
  // last user message. Without this, the scan reaches back across turns and a
  // PRIOR turn's richer deliverable wins on `length + items*200`, becoming the
  // coverage target — or the dumped fallback — for THIS turn's answer (audit
  // 2f4f5fe6: a Turn-2 news deliverable was force-relayed verbatim as the
  // answer to an unrelated Turn-4 question).
  const scoped = options.scopeToCurrentTurn
    ? history.slice(lastUserMessageIndex(history) + 1)
    : history;
  const recent = [...scoped].reverse().slice(0, 24);
  let bestCandidate: { evidence: string; itemCount: number; score: number } | null = null;

  for (const message of recent) {
    if (message.role !== "tool") continue;
    const content = String(message.content ?? "");
    const meta = message.metadata ?? {};

    // Workflow execution results (run_workflow) carry the same
    // "Observed evidence:" block as delegated results and are an equally
    // valid synthesis backstop when the model misbehaves at the synthesis
    // step (e.g. emits another tool call after [SYNTHESIS REQUIRED]).
    // Recognize them here so the terminal-evidence backstop can prefer
    // the actual workflow dossier over the model's preamble text.
    const isWorkflowResult = WORKFLOW_TOOL_RESULT_RE.test(content)
      || typeof meta["workflowName"] === "string";
    const isDelegate = DELEGATE_TOOL_RESULT_RE.test(content) || looksLikeDelegateMetadata(meta);
    // A plan's report is delegated evidence too — it carries every step's result — but it is shaped
    // like neither of the above, so this backstop skipped it entirely and a turn that ran its whole
    // plan and then hit an LLM error at synthesis had nothing left to recover from.
    const isPlanResult = meta["planExecution"] === true;
    if (!isDelegate && !isWorkflowResult && !isPlanResult) continue;

    const evidenceMatch = EVIDENCE_SECTION_RE.exec(content);
    const rawEvidence = evidenceMatch
      ? content.slice(evidenceMatch.index + evidenceMatch[0].length).trim()
      : content.trim();
    const evidence = stripLeadingDelegateLabelEcho(extractUsefulInterruptedDelegationEvidence(rawEvidence) ?? rawEvidence);
    const delegationOutcome = typeof meta["delegationOutcome"] === "string"
      ? String(meta["delegationOutcome"]).toLowerCase()
      : "";
    const terminalState = typeof meta["terminalState"] === "string"
      ? String(meta["terminalState"]).toLowerCase()
      : "";
    const partialLike = delegationOutcome === "partial"
      || terminalState === "timeout"
      || /(?:TASK COMPLETED \(PARTIAL|PARTIAL PROGRESS|Partial progress before interruption:)/i.test(content);
    const minimumEvidenceChars = partialLike ? 120 : 400;
    if (!evidence || evidence.length < minimumEvidenceChars) continue;
    // Reject evidence that is just a regurgitated provider/HTTP/HTML error
    // — surfacing an LM Studio 500 page or an "OpenAI-compatible request
    // failed" string as the final answer is worse than the generic
    // "no usable evidence" fallback.
    if (looksLikeProviderErrorEcho(evidence)) continue;
    if (looksLikeRawWorkspaceToolDump(evidence)) continue;
    // Reject evidence whose every non-empty line is interrupted-sub-agent
    // scaffolding ("after finishing the current operation", "- Tool calls
    // executed: N", "- Iterations completed: N"). Without this, the
    // empty-response evidence backstop dumps the scaffold to the user as
    // if it were real findings. A 161-char scaffold is technically above
    // the partial-like 120-char minimum but is zero-information.
    if (looksLikeOrchestrationOnlyEvidence(evidence)) continue;

    const itemCount = countStructuredItems(evidence);
    const score = evidence.length + (itemCount * 200);
    if (!bestCandidate || score > bestCandidate.score) {
      bestCandidate = { evidence, itemCount, score };
    }
  }

  return bestCandidate
    ? { evidence: bestCandidate.evidence, itemCount: bestCandidate.itemCount }
    : null;
}

export {
  extractUsefulInterruptedDelegationEvidence,
  looksLikeInterruptedDelegationWithoutUsableEvidence,
  measureEvidenceCoverage,
  findRecentDelegateEvidence,
};
