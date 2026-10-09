/**
 * Workflow-catalog + approved-run routing cluster (god-file seam).
 *
 * Extracted verbatim from runtime.ts. Two cohesive concerns:
 *   1. WORKFLOW CATALOG signal detection / guidance / execution-enforcement —
 *      decides when a reusable scene/job should be surfaced or forced, and
 *      formats the compliance-correction prompts that nudge the model toward
 *      run_workflow after search_workflows already returned matches.
 *   2. APPROVED-RUN candidate follow-up — recognises a short affirmative
 *      ("yes", "ja bitte", …) that approves running the RUN_CANDIDATE the
 *      previous n8n_project_list result proposed, and the guards/guidance for it.
 *
 * PURE / config-bound only: these functions depend on leaf helpers
 * (runtime-utils), the credentials scene/job lists, config, the audit logger,
 * and the WORKFLOW_* keyword tables in intent-classifier. None of them touch a
 * runtime main-loop singleton, so the whole cluster moves cleanly out of
 * runtime.ts with no import cycle.
 */
import { childLogger } from "../logger.js";
import { listAllJobs } from "../credentials/jobs.js";
import { listAllScenes } from "../credentials/scenes.js";

const log = childLogger("agent:workflow-catalog-routing");

export interface WorkflowCatalogMatch {
  name: string;
  workflowType: "scene" | "job";
  score: number;
  matchedTerms: string[];
}

export interface WorkflowCatalogSignal {
  required: boolean;
  // explicit_request + hint_terms were removed with the always-on keyword tables
  // (de-lexicalization); only opt-in author-declared triggers produce a signal now.
  reason: "catalog_match" | "uncertain_match" | "none";
  strongestMatch?: WorkflowCatalogMatch;
  /** Plausible but unconfirmed candidates — used to ASK the user instead of forcing routing. */
  uncertainCandidates?: WorkflowCatalogMatch[];
}

export interface ApprovedWorkflowFollowUp {
  workflowName: string;
  workflowType: "scene";
  params: Record<string, string>;
  candidateName: string;
}

const RUN_CANDIDATE_RE = /(?:^|\n)\s*RUN_CANDIDATE:\s*(.+?)\s*$/im;
// English-internal (de-lexicalized). NOTE: the planned boundary-translation layer that would
// render a non-English affirmative to English first is NOT YET IMPLEMENTED — until it lands a
// non-English "ja" is not recognized here (the n8n follow-up simply won't auto-run; harmless).
const AFFIRMATIVE_WORKFLOW_APPROVAL_RE = /^\s*(?:yes|yeah|yep|sure|ok(?:ay)?|please do(?: that)?|do it|go ahead|run (?:it|that)|start (?:it|that))\s*[.!?]*\s*$/i;

function extractRunCandidateName(content: string | null | undefined): string | null {
  if (typeof content !== "string" || content.length === 0) return null;
  const match = content.match(RUN_CANDIDATE_RE);
  if (!match) return null;

  const candidateName = match[1]?.trim().replace(/^["'`]+|["'`]+$/g, "") ?? "";
  return candidateName.length > 0 ? candidateName : null;
}

function parseToolCallArguments(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function detectApprovedRunCandidateFollowUp(
  history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown>; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }[],
  userMessage: string,
): ApprovedWorkflowFollowUp | null {
  const normalizedMessage = userMessage.trim();
  if (!normalizedMessage || normalizedMessage.length > 80 || !AFFIRMATIVE_WORKFLOW_APPROVAL_RE.test(normalizedMessage)) {
    return null;
  }

  let foundCurrentUser = false;
  let candidateName: string | null = null;
  let sawProjectListWorkflow = false;

  for (let index = history.length - 1; index >= Math.max(0, history.length - 30); index -= 1) {
    const message = history[index];
    if (!message) continue;

    if (message.role === "user") {
      if (!foundCurrentUser) {
        foundCurrentUser = true;
        continue;
      }
      break;
    }

    if (!foundCurrentUser) continue;

    if (!candidateName) {
      candidateName = extractRunCandidateName(message.content) ?? candidateName;
    }

    if (message.role === "tool") {
      const workflowName = typeof message.metadata?.["workflowName"] === "string"
        ? String(message.metadata["workflowName"])
        : "";
      const workflowType = typeof message.metadata?.["workflowType"] === "string"
        ? String(message.metadata["workflowType"])
        : "";
      if (workflowName === "n8n_project_list" && workflowType === "scene") {
        sawProjectListWorkflow = true;
      }
    }

    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;

    for (const toolCall of message.tool_calls) {
      if (toolCall?.function?.name !== "run_workflow") continue;
      const args = parseToolCallArguments(toolCall.function.arguments);
      const workflowName = typeof args?.["name"] === "string" ? String(args["name"]) : "";
      const workflowType = typeof args?.["workflowType"] === "string" ? String(args["workflowType"]) : "auto";
      if (workflowName === "n8n_project_list" && (workflowType === "scene" || workflowType === "auto")) {
        sawProjectListWorkflow = true;
      }
    }
  }

  if (!candidateName || !sawProjectListWorkflow) return null;

  return {
    workflowName: "n8n_run_workflow",
    workflowType: "scene",
    params: {
      workflowName: candidateName,
    },
    candidateName,
  };
}

export function buildApprovedRunCandidateGuidance(followUp: ApprovedWorkflowFollowUp): string {
  return [
    "Approved workflow follow-up detected for this turn.",
    `The previous n8n_project_list result ended with RUN_CANDIDATE: ${followUp.candidateName}.`,
    "The user just approved running that exact workflow.",
    `Call run_workflow now with name "${followUp.workflowName}", workflowType "${followUp.workflowType}", and params.workflowName "${followUp.candidateName}".`,
    "Do NOT call search_agents, search_workflows, delegate_to_agent, parallel_delegate, or run_task_graph first.",
    "Do NOT answer in natural language before issuing that run_workflow call.",
  ].join(" ");
}

export function isApprovedRunCandidateToolCall(
  toolCall: { name: string; arguments?: Record<string, unknown> },
  followUp: ApprovedWorkflowFollowUp,
): boolean {
  if (toolCall.name !== "run_workflow") return false;

  const workflowName = typeof toolCall.arguments?.["name"] === "string"
    ? String(toolCall.arguments["name"])
    : "";
  const workflowType = typeof toolCall.arguments?.["workflowType"] === "string"
    ? String(toolCall.arguments["workflowType"])
    : "auto";
  const params = toolCall.arguments?.["params"];
  const workflowParamName = params && typeof params === "object" && !Array.isArray(params) && typeof (params as Record<string, unknown>)["workflowName"] === "string"
    ? String((params as Record<string, unknown>)["workflowName"])
    : "";

  return workflowName === followUp.workflowName
    && (workflowType === followUp.workflowType || workflowType === "auto")
    && workflowParamName.trim() === followUp.candidateName;
}

export function extractWorkflowCatalogMatchesFromMetadata(metadata: Record<string, unknown> | undefined): WorkflowCatalogMatch[] {
  const rawMatches = metadata?.["workflowMatches"];
  if (!Array.isArray(rawMatches)) return [];

  return rawMatches
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const name = typeof record["name"] === "string" ? record["name"] : "";
      const workflowType = record["workflowType"] === "job" ? "job" : (record["workflowType"] === "scene" ? "scene" : null);
      const score = typeof record["score"] === "number" ? record["score"] : 0;
      const matchedTerms = Array.isArray(record["matchedTerms"])
        ? record["matchedTerms"].map(String).filter(Boolean)
        : [];
      if (!name || !workflowType) return null;
      return { name, workflowType, score, matchedTerms } satisfies WorkflowCatalogMatch;
    })
    .filter((match): match is WorkflowCatalogMatch => Boolean(match))
    .sort((left, right) => right.score - left.score);
}

export function mergeWorkflowCatalogMatches(...groups: WorkflowCatalogMatch[][]): WorkflowCatalogMatch[] {
  const merged = new Map<string, WorkflowCatalogMatch>();

  for (const group of groups) {
    for (const match of group) {
      const key = `${match.workflowType}:${match.name}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          ...match,
          matchedTerms: [...match.matchedTerms],
        });
        continue;
      }

      merged.set(key, {
        ...existing,
        score: Math.max(existing.score, match.score),
        matchedTerms: [...new Set([...existing.matchedTerms, ...match.matchedTerms])],
      });
    }
  }

  return [...merged.values()].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.matchedTerms.length !== left.matchedTerms.length) return right.matchedTerms.length - left.matchedTerms.length;
    return left.name.localeCompare(right.name);
  });
}

export function shouldRequireWorkflowExecutionAfterSearch(matches: WorkflowCatalogMatch[]): boolean {
  const topMatch = matches[0];
  if (!topMatch) return false;
  // Only FORCE a workflow run when the match is genuinely strong. The
  // search_workflows tool surfaces candidates at a low floor (>=0.18) as a
  // discovery aid, but hard-forcing run_workflow on a weak/incidental match
  // (e.g. an unrelated DB-analysis job scoring 0.24 on two generic terms like
  // "inspection"/"analysis") deadlocks the turn: the model rightly refuses the
  // irrelevant workflow, produces nothing, and the user gets an empty answer.
  //
  // With keyword overlap the user's own words land in the workflow signature,
  // so a moderate score is a real signal.
  const hasKeywordOverlap = topMatch.matchedTerms.length > 0;
  if (hasKeywordOverlap) {
    return topMatch.score >= 0.5 || (topMatch.matchedTerms.length >= 3 && topMatch.score >= 0.3);
  }
  // Pure-semantic matches with NO keyword overlap need a much higher bar.
  // Embedding similarity routinely produces 0.5–0.7 for unrelated topics
  // (session b15e2099 forced apply_jobs at 0.65 against an unrelated
  // CPSA-F learning-website request and burned 12 minutes of browser
  // automation). Only force on a strong semantic-only match.
  return topMatch.score >= 0.78;
}

export function formatWorkflowExecutionPromptFromSearch(matches: WorkflowCatalogMatch[]): string {
  const topMatches = matches.slice(0, 3)
    .map((match) => `${match.name} [${match.workflowType}] (score ${match.score.toFixed(2)})`)
    .join(", ");

  return [
    "COMPLIANCE CORRECTION: search_workflows already returned reusable matches for this request.",
    topMatches ? `Returned matches: ${topMatches}.` : "",
    "Do NOT call search_workflows again, and do NOT switch to delegate_to_agent, parallel_delegate, run_task_graph, or direct answering yet.",
    "Call run_workflow now using the best returned workflow, or another returned match if it fits better.",
    "Only fall back to ad hoc delegation after a run_workflow attempt proves unsuitable or fails for a concrete reason.",
  ].filter(Boolean).join(" ");
}

export function isWorkflowNameResolutionFailureMessage(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes("workflow not found:")
    || (normalized.includes("workflow name '") && normalized.includes("is ambiguous"));
}

export function formatWorkflowExecutionCorrectionPromptFromSearch(matches: WorkflowCatalogMatch[], lastError: string): string {
  const topMatches = matches.slice(0, 3)
    .map((match) => `${match.name} [${match.workflowType}]`)
    .join(", ");

  return [
    "COMPLIANCE CORRECTION: run_workflow used an invalid or ambiguous workflow name after search_workflows already returned reusable matches.",
    lastError ? `Last run_workflow error: ${lastError}` : "",
    topMatches ? `Use one of these exact returned workflow names: ${topMatches}.` : "",
    "Call run_workflow again now with the exact workflow name and workflowType from the returned catalog results.",
    "Do NOT call search_workflows again, do NOT call search_agents, and do NOT invent a new workflow name.",
  ].filter(Boolean).join(" ");
}

export function isWorkflowCatalogToolName(toolName: string): boolean {
  return toolName === "search_workflows" || toolName === "run_workflow";
}

// ─── Workflow catalog detector (opt-in trigger model, de-lexicalized) ──────
//
// Routing here is OPT-IN + STRUCTURAL only. Scenes/jobs declare narrow triggers
// in their own config; nothing else trips the guardrail. The earlier always-on
// English keyword tables — an explicit-request regex (`WORKFLOW_REQUEST_PATTERNS`)
// and a hint-term heuristic (`WORKFLOW_HINT_TERMS`/`_ACTION_TERMS`/`_DELIVERABLE_HINT_TERMS`)
// — were REMOVED in the de-lexicalization: they matched raw user text on every turn and
// mis-routed (e.g. "review the pentest *workflow* file" tripped the hint-term path).
//
// Two layered signals remain:
//   B. Author-declared triggers (`scene.triggers.patterns: [{ all: [regex, ...] }, ...]`).
//      An entry matches when ALL of its `all` regexes match the message; ANY entry → match.
//      Trigger regexes live in WORKSPACE config, so an author may write them in any language —
//      that is their choice, not a core keyword table.
//   C. Action-verb gate. Scenes marked `requiresActionVerb: true` only fire as a CONFIRMED
//      intent when the message also contains an (English) imperative/action verb. Without one,
//      the match becomes an UNCERTAIN candidate — we ask the user instead of forcing routing.
//
// A message that matches no author-declared trigger does NOT trip the guardrail — it stays
// discoverable via the always-available search_workflows/run_workflow tools, which the
// orchestrator invokes on its own judgment. An explicit "run the X workflow" request is now
// handled by the LLM through those tools, not by a core keyword regex.

/**
 * English action verbs that signal the user wants something *done*, not just
 * explained. Used by `requiresActionVerb` triggers to distinguish an
 * explanation ("what happens if I apply X" → uncertain unless the verb itself
 * appears) from an imperative ("apply X now" → confirmed).
 *
 * English-internal (de-lexicalized): the verb list carries no per-language entries.
 * NOTE: the boundary-translation layer that would render a non-English message to English
 * before this gate is NOT YET IMPLEMENTED — until it lands, a non-English imperative fails
 * the verb gate and an opt-in trigger match degrades to `uncertain` (ask the user), never a
 * fabrication. Imperative/infinitive forms only.
 */
const WORKFLOW_ACTION_VERB_PATTERN = new RegExp(
  "\\b(?:" + [
    "apply", "deploy", "rollout", "roll\\s*out", "run", "execute", "provision",
    "scale", "migrate", "install", "uninstall", "update", "upgrade", "configure",
    "setup", "set\\s*up", "spin\\s*up", "tear\\s*down", "restart", "reboot",
    "create", "build", "publish", "release", "ship",
  ].join("|") + ")\\b",
  "i",
);

interface WorkflowCatalogTriggerCandidate {
  name: string;
  workflowType: "scene" | "job";
  patternsCompiled: Array<RegExp[]>;
  requiresActionVerb: boolean;
}

function compileWorkflowTriggerEntries(): WorkflowCatalogTriggerCandidate[] {
  const out: WorkflowCatalogTriggerCandidate[] = [];

  const compileEntry = (
    name: string,
    workflowType: "scene" | "job",
    triggers: { patterns: { all: string[] }[]; requiresActionVerb?: boolean } | undefined,
  ): void => {
    if (!triggers || !Array.isArray(triggers.patterns) || triggers.patterns.length === 0) return;
    const patternsCompiled: RegExp[][] = [];
    for (const entry of triggers.patterns) {
      const compiled: RegExp[] = [];
      for (const raw of entry.all) {
        try {
          compiled.push(new RegExp(raw, "iu"));
        } catch (err) {
          log.warn({ err, name, workflowType, raw }, "Skipping invalid workflow trigger regex");
          compiled.length = 0;
          break;
        }
      }
      if (compiled.length > 0) patternsCompiled.push(compiled);
    }
    if (patternsCompiled.length === 0) return;
    out.push({
      name,
      workflowType,
      patternsCompiled,
      requiresActionVerb: triggers.requiresActionVerb === true,
    });
  };

  for (const scene of listAllScenes()) {
    compileEntry(scene.name, "scene", scene.triggers);
  }
  for (const job of listAllJobs()) {
    compileEntry(job.name, "job", job.catalogTriggers);
  }
  return out;
}

function detectWorkflowCatalogSignal(userMessage: string): WorkflowCatalogSignal {
  const trimmed = userMessage.trim();
  if (!trimmed) return { required: false, reason: "none" };

  // Opt-in only: a scene/job must declare its own `triggers` / `catalogTriggers`.
  // No always-on keyword tables here anymore (see the de-lexicalization note above);
  // an unmatched message stays discoverable via search_workflows/run_workflow.
  const candidates = compileWorkflowTriggerEntries();
  if (candidates.length === 0) return { required: false, reason: "none" };

  const hasActionVerb = WORKFLOW_ACTION_VERB_PATTERN.test(userMessage);

  const confirmedMatches: WorkflowCatalogMatch[] = [];
  const uncertainMatches: WorkflowCatalogMatch[] = [];

  for (const candidate of candidates) {
    const matchedEntry = candidate.patternsCompiled.find((entryRegexes) =>
      entryRegexes.every((rx) => rx.test(userMessage)),
    );
    if (!matchedEntry) continue;
    const match: WorkflowCatalogMatch = {
      name: candidate.name,
      workflowType: candidate.workflowType,
      score: 1,
      matchedTerms: matchedEntry.map((rx) => rx.source.replace(/\\b/g, "").slice(0, 60)),
    };
    if (candidate.requiresActionVerb && !hasActionVerb) {
      uncertainMatches.push(match);
    } else {
      confirmedMatches.push(match);
    }
  }

  if (confirmedMatches.length > 0) {
    // Prefer scenes over jobs at equal precision (jobs orchestrate scenes).
    const strongestMatch = confirmedMatches.sort((left, right) => {
      if (left.workflowType !== right.workflowType) return left.workflowType === "scene" ? -1 : 1;
      return left.name.localeCompare(right.name);
    })[0];
    return { required: true, reason: "catalog_match", strongestMatch };
  }

  if (uncertainMatches.length > 0) {
    // Don't FORCE routing — just suggest, and ask the user.
    return {
      required: true,
      reason: "uncertain_match",
      strongestMatch: uncertainMatches[0],
      uncertainCandidates: uncertainMatches,
    };
  }

  return { required: false, reason: "none" };
}

function buildWorkflowCatalogGuidance(signal: WorkflowCatalogSignal): string {
  if (!signal.required) return "";

  if (signal.reason === "uncertain_match" && signal.strongestMatch) {
    const candidates = (signal.uncertainCandidates ?? [signal.strongestMatch])
      .slice(0, 3)
      .map((match) => `${match.name} [${match.workflowType}]`)
      .join(", ");
    return [
      "POSSIBLE WORKFLOW MATCH (UNCERTAIN):",
      `One or more reusable workflows might fit this request: ${candidates}.`,
      "However, the message lacks a clear action verb (apply / deploy / run / provision / execute ...) — the user may just be asking for an explanation.",
      "Do NOT call run_workflow yet. Ask the user in ONE concise sentence (in their language) whether they want one of these workflows executed, or whether they just want an answer to their question.",
      "After they confirm, on the next turn either call run_workflow with the chosen workflow or answer normally.",
    ].join(" ");
  }

  const strongestMatchText = signal.strongestMatch
    ? ` Strongest current reusable match: ${signal.strongestMatch.name} [${signal.strongestMatch.workflowType}].`
    : "";
  return [
    "Reusable workflow guidance for this turn: check the workflow catalog before inventing an ad hoc coordinator plan when a reusable scene or job may already fit.",
    strongestMatchText.trim(),
    "If the match is exact, call run_workflow directly. Otherwise call search_workflows first and then either run_workflow or explain honestly why no reusable workflow fits.",
  ].filter(Boolean).join(" ");
}

export { detectWorkflowCatalogSignal, buildWorkflowCatalogGuidance };

// Internal exports for unit tests.
export const __workflowCatalog = {
  detectWorkflowCatalogSignal,
  buildWorkflowCatalogGuidance,
  WORKFLOW_ACTION_VERB_PATTERN,
};
