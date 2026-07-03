/**
 * Interrupted-run salvage & final-output shaping for sub-agent executions.
 *
 * Extracted from agent/sub-agent.ts (the runner god-file) as a self-contained,
 * side-effect-free cluster: everything that decides WHAT a cut-off run ships —
 * formatting partial swarm progress, recovering usable evidence snippets from
 * tool history, classifying the interrupted outcome, preferring a completed
 * workflow/delegation body over a thin synthesis, and stripping hallucinated
 * tool-call XML. Pure string/state shaping only: no I/O, no registry access,
 * no audit calls — the runner owns those.
 */
import type { LLMMessage } from "../providers/lmstudio.js";
import type { SwarmState, SwarmTaskState } from "../tools/registry.js";
import { looksLikeProviderErrorEcho, looksLikeHallucinatedTruncationClaim } from "./container-failure.js";

// Single-delegation passthrough — when a coordinator's only substantive tool
// output is one delegation result of this size or larger, return it verbatim
// rather than running a redundant synthesis pass over content that already is
// the final answer. This dodges the "coordinator times out trying to wrap a
// completed sub-agent answer" failure mode that destroys 10+ minutes of work.
export const PASSTHROUGH_DELEGATION_MIN_BYTES = 3_000;

// Tools whose presence does NOT disqualify workflow-output passthrough:
// discovery + shared-fact bookkeeping around a single run_workflow call.
export const WORKFLOW_OUTPUT_PASSTHROUGH_AUXILIARY_TOOL_NAMES = new Set<string>([
  "search_workflows",
  "share_finding",
]);

export function truncateToolAuditText(value: string | null | undefined, maxLength = 280): string | undefined {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!normalized) return undefined;
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
    : normalized;
}

export function formatSwarmProgressForInterruption(state: SwarmState | undefined): string {
  if (!state) return "";
  const tasks = Object.values(state.tasks);
  if (tasks.length === 0) return "";

  const prioritized = [...tasks].sort((left: SwarmTaskState, right: SwarmTaskState) => {
    const statusRank = (status: string): number => {
      switch (status) {
        case "completed": return 0;
        case "partial": return 1;
        case "running": return 2;
        case "failed": return 3;
        case "blocked": return 4;
        default: return 5;
      }
    };
    return statusRank(left.status) - statusRank(right.status);
  });

  const lines = prioritized.slice(0, 6).map((task: SwarmTaskState) => {
    const latestAttempt = task.attempts[task.attempts.length - 1];
    const attemptSummary = latestAttempt?.summary?.trim();
    const summary = attemptSummary || task.error || task.output;
    if (task.status !== "completed" && task.status !== "partial") return "";
    if (!summary || looksLikeInterruptedEvidenceBoilerplate(summary)) return "";
    const via = task.selectedAgent ? ` via ${task.selectedAgent}` : "";
    return `- ${task.id} [${task.status}] ${task.title}${via}${summary ? ` | ${summary.replace(/\s+/g, " ").slice(0, 220)}` : ""}`;
  }).filter(Boolean);

  return lines.join("\n");
}

export function stripToolResultLabel(value: string): string {
  return value.replace(/^(?:[a-z][a-z0-9_]*|artifact):\s+/, "").trim();
}

export function stripInterruptedProgressPrefix(value: string): string {
  return value
    .replace(/^\*\*\[[^\]]+\]\*\*\s*(?:\((?:failed|partial)\))?:\s*/i, "")
    .replace(/^(?:parallel|task)_\d+\s+\[[^\]]+\]\s*/i, "")
    .replace(/^[a-z_]+\s+\[[^\]]+\]\s*/i, "")
    .trim();
}

export function looksLikeInterruptedEvidenceBoilerplate(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  const withoutToolLabel = stripToolResultLabel(trimmed);
  if (withoutToolLabel && withoutToolLabel !== trimmed && looksLikeInterruptedEvidenceBoilerplate(withoutToolLabel)) return true;
  if (looksLikeHallucinatedTruncationClaim(trimmed)) return true;
  if (/Partial progress before interruption:/i.test(trimmed)) return true;
  if (/^Recovered evidence snippets from completed tools:/i.test(trimmed)) return true;
  if (/^Sub-agent '[^']+'/i.test(trimmed)) return true;
  if (/^(?:Tool calls executed:|Iterations completed:|Artifacts collected:)/i.test(trimmed)) return true;
  if (/^(?:All candidate agents failed|No (?:agents|workflows) matched)\b/i.test(trimmed)) return true;
  // Orchestration-scaffold returns that carry no real evidence — these
  // happen during a coordinator's setup phase (e.g. it routed to itself
  // via the discovery rewriter, or it polled shared facts before any
  // child published one). Without classifying them as boilerplate the
  // source-sensitive pre-evidence guard's `cumulativeUsefulEvidenceBytes
  // < 120` threshold trips after a handful of these no-op returns and a
  // subsequent parallel_delegate's task text (which may inline an
  // unverified user-supplied assumption) escapes the canonical-task
  // rewrite. Keep this list tight so genuine short tool returns still
  // count as evidence.
  if (/^Task '[^']+' is already running\b/i.test(trimmed)) return true;
  if (/^Task '[^']+' has been called\b/i.test(trimmed)) return true;
  if (/^Tool '[^']+' (?:has been called|is)\b/i.test(trimmed)) return true;
  if (/^No shared facts available yet\b/i.test(trimmed)) return true;
  if (/^All shared facts cleared\b/i.test(trimmed)) return true;
  return false;
}

export function collectInterruptedEvidenceSnippets(text: string): string[] {
  const snippets: string[] = [];
  const seen = new Set<string>();

  const pushSnippet = (candidate: string) => {
    const normalized = stripToolResultLabel(stripInterruptedProgressPrefix(candidate))
      .replace(/^IMPORTANT:\s.*$/gim, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized || normalized.length < 80) return;
    if (looksLikeInterruptedEvidenceBoilerplate(normalized)) return;
    if (looksLikeProviderErrorEcho(normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    snippets.push(normalized);
  };

  const partialSections = text.split(/Partial progress before interruption:/i).slice(1);
  for (const section of partialSections) {
    const block = section.split(/Recovered evidence snippets from completed tools:|\n\n---/i)[0]?.trim();
    if (!block) continue;
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (!line.startsWith("- ")) continue;
      const body = line.slice(2).trim();
      if (!body || /^(?:Tool calls executed:|Iterations completed:|Artifacts collected:)/i.test(body)) continue;
      const candidate = body.includes(" | ")
        ? body.split(/\s+\|\s+/).slice(1).join(" | ")
        : body;
      pushSnippet(candidate);
    }
  }

  const recoveredSections = text.split(/Recovered evidence snippets from completed tools:/i).slice(1);
  for (const section of recoveredSections) {
    const block = section.split(/\n\n---/i)[0]?.trim();
    if (!block) continue;
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (!line.startsWith("- ")) continue;
      const body = line.slice(2).trim();
      const candidate = body.includes(":") ? body.split(/:\s+/, 2)[1] ?? body : body;
      pushSnippet(candidate);
    }
  }

  return snippets;
}

export function extractUsefulInterruptedToolEvidence(text: string): string | null {
  if (!/Partial progress before interruption:|Recovered evidence snippets from completed tools:/i.test(text)) {
    return null;
  }

  const snippets = collectInterruptedEvidenceSnippets(text);
  if (snippets.length > 0) return snippets.join("\n\n");

  const fallback = text
    .replace(
      /Sub-agent '[^']+' timed out after \d+ms\s+Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
      "",
    )
    .replace(
      /Sub-agent '[^']+' produced no final response after substantive work\.\s+Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
      "",
    )
    .replace(
      /Sub-agent '[^']+' was cancelled\s+Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
      "",
    )
    .replace(/Sub-agent '[^']+' timed out after \d+ms\n?/g, "")
    .replace(/Sub-agent '[^']+' produced no final response after substantive work\.\n?/g, "")
    .replace(/Sub-agent '[^']+' was cancelled\n?/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !looksLikeInterruptedEvidenceBoilerplate(line))
    .join("\n")
    .trim();

  if (fallback.length < 120) return null;
  if (looksLikeProviderErrorEcho(fallback)) return null;
  return fallback;
}

export function buildInterruptedSubAgentOutput(params: {
  agentName: string;
  reason: string;
  swarmState?: SwarmState;
  toolNames: string[];
  toolCount: number;
  iterations: number;
  artifacts: Record<string, unknown>[];
  evidenceSnippets?: string[];
  /** Most-recent substantial delegation body from history, surfaced verbatim
   * (capped at 16 KB) instead of via 900-char snippets. Used when the agent
   * collected a substantial delegated answer but timed out before emitting
   * its own synthesis. Without this, the parent only saw the 900-char head
   * and the rest of the delegated specialist's work was discarded. */
  primaryDelegationBody?: { content: string; bytes: number } | null;
}): string {
  const swarmSummary = formatSwarmProgressForInterruption(params.swarmState);
  const progressLines: string[] = [];

  if (swarmSummary) {
    progressLines.push(swarmSummary);
  }

  if (params.artifacts.length > 0) {
    const artifactHints = params.artifacts
      .map((artifact) => {
        const outputPath = typeof artifact["outputPath"] === "string" ? artifact["outputPath"] : "";
        const filename = typeof artifact["filename"] === "string" ? artifact["filename"] : "";
        const externalUrl = typeof artifact["externalUrl"] === "string" ? artifact["externalUrl"] : "";
        return outputPath || filename || externalUrl;
      })
      .filter(Boolean)
      .slice(0, 4);
    progressLines.push(`- Artifacts collected: ${params.artifacts.length}${artifactHints.length > 0 ? ` (${artifactHints.join(", ")})` : ""}`);
  }

  // Primary delegation body: when a substantial delegated specialist answer
  // exists in history, surface it BEFORE the snippet section so the parent
  // sees the actual content instead of only a 900-char head.
  if (params.primaryDelegationBody && params.primaryDelegationBody.content.length >= PASSTHROUGH_DELEGATION_MIN_BYTES) {
    const body = params.primaryDelegationBody.content.length > 16_000
      ? params.primaryDelegationBody.content.slice(0, 16_000) + "\n\n[... truncated for evidence relay; full content available via the delegation tool result ...]"
      : params.primaryDelegationBody.content;
    progressLines.push("Recovered delegated specialist body (full):");
    progressLines.push(body);
  }

  const snippetCap = params.primaryDelegationBody ? 2 : 4;
  const evidenceSnippets = [
    ...(params.evidenceSnippets ?? []),
    ...formatArtifactEvidenceSnippets(params.artifacts),
  ]
    .map((snippet) => stripToolResultLabel(snippet).replace(/\s+/g, " ").trim())
    .filter((snippet) => snippet.length > 0)
    .filter((snippet) => !looksLikeInterruptedEvidenceBoilerplate(snippet) && !looksLikeProviderErrorEcho(snippet))
    // Drop snippets that are merely a head of the primary delegation body —
    // they would be duplicate information.
    .filter((snippet) => {
      if (!params.primaryDelegationBody) return true;
      const head = params.primaryDelegationBody.content.slice(0, 200).replace(/\s+/g, " ").trim();
      return !snippet.includes(head.slice(0, 80));
    })
    .slice(-snippetCap);
  if (evidenceSnippets.length > 0) {
    progressLines.push("Recovered evidence snippets from completed tools:");
    for (const snippet of evidenceSnippets) {
      progressLines.push(`- ${snippet}`);
    }
  }

  if (progressLines.length === 0) {
    return `Sub-agent '${params.agentName}' ${params.reason} before producing usable topic-related output.`;
  }

  return `Sub-agent '${params.agentName}' ${params.reason}\nPartial progress before interruption:\n${progressLines.join("\n")}`;
}

export type SubAgentOutcome = "success" | "partial" | "failure";

export function resolveInterruptedEvidenceSnippets(params: {
  recentEvidenceSnippets?: readonly string[];
  history?: readonly LLMMessage[];
  maxSnippets?: number;
}): string[] {
  const maxSnippets = Math.max(1, params.maxSnippets ?? 4);
  const bufferedSnippets = (params.recentEvidenceSnippets ?? [])
    .map((snippet) => stripToolResultLabel(snippet).replace(/\s+/g, " ").trim())
    .filter((snippet) => snippet.length > 0)
    .filter((snippet) => !looksLikeInterruptedEvidenceBoilerplate(snippet) && !looksLikeProviderErrorEcho(snippet))
    .slice(-maxSnippets);
  if (bufferedSnippets.length > 0) {
    return [...bufferedSnippets];
  }

  const recoveredSnippets: string[] = [];
  const seen = new Set<string>();
  const toolMessages = [...(params.history ?? [])]
    .filter((message) => message.role === "tool" && typeof message.content === "string")
    .reverse();

  for (const message of toolMessages) {
    const rawContent = typeof message.content === "string" ? message.content.trim() : "";
    if (!rawContent) continue;
    const extracted = extractUsefulInterruptedToolEvidence(rawContent) ?? rawContent;
    const normalized = stripToolResultLabel(extracted)
      .replace(/\n\n\[Note: This is a cached[\s\S]*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized || /^Error:/i.test(normalized)) continue;
    if (looksLikeInterruptedEvidenceBoilerplate(normalized) || looksLikeProviderErrorEcho(normalized)) continue;
    const snippet = truncateToolAuditText(normalized, 900);
    if (!snippet || seen.has(snippet)) continue;
    seen.add(snippet);
    recoveredSnippets.push(snippet);
    if (recoveredSnippets.length >= maxSnippets) break;
  }

  return recoveredSnippets.reverse();
}

export function looksLikeTimeoutLikeError(error: unknown): boolean {
  const text = String(error ?? "").trim();
  if (!text) return false;
  return /\b(timed out|timeout|abort(?:ed|error)?)\b/i.test(text);
}

export function maybePreferWorkflowOutput(result: string, workflowOutput: string | null, toolNames: string[]): string {
  const normalizedWorkflowOutput = workflowOutput?.trim();
  if (!normalizedWorkflowOutput) {
    return result;
  }

  if (!toolNames.includes("run_workflow")) {
    return result;
  }

  if (!toolNames.every((toolName) => (
    toolName === "run_workflow"
    || WORKFLOW_OUTPUT_PASSTHROUGH_AUXILIARY_TOOL_NAMES.has(toolName)
  ))) {
    return result;
  }

  const normalizedResult = result.trim();
  if (!normalizedResult) {
    return normalizedWorkflowOutput;
  }

  if (normalizedResult === normalizedWorkflowOutput) {
    return result;
  }

  if (looksLikeHallucinatedTruncationClaim(normalizedWorkflowOutput) && !looksLikeHallucinatedTruncationClaim(normalizedResult)) {
    return result;
  }

  const workflowHeader = normalizedWorkflowOutput.split(/\r?\n/, 1)[0]?.trim();
  if (workflowHeader && normalizedResult.includes(workflowHeader)) {
    return result;
  }

  return normalizedWorkflowOutput;
}

export function hasDeliverableArtifact(artifacts: Record<string, unknown>[]): boolean {
  return artifacts.some((artifact) => {
    const sourceTool = typeof artifact["sourceTool"] === "string" ? artifact["sourceTool"] : "";
    const previewMode = typeof artifact["previewMode"] === "string" ? artifact["previewMode"] : "";
    const contentType = typeof artifact["contentType"] === "string" ? artifact["contentType"] : "";

    if (["generate_document", "generate_pdf", "generate_chart_html", "generate_mermaid_diagram", "export_workspace_artifact", "write_file"].includes(sourceTool)) {
      return true;
    }

    return ["html", "pdf", "markdown", "json", "text", "mermaid"].includes(previewMode)
      || contentType.startsWith("text/markdown")
      || contentType.startsWith("text/html")
      || contentType.startsWith("application/pdf")
      || contentType.startsWith("application/json");
  });
}

export function formatArtifactEvidenceSnippets(artifacts: Record<string, unknown>[]): string[] {
  return artifacts
    .map((artifact) => {
      const outputPath = typeof artifact["outputPath"] === "string" ? artifact["outputPath"] : "";
      const filename = typeof artifact["filename"] === "string" ? artifact["filename"] : "";
      const externalUrl = typeof artifact["externalUrl"] === "string" ? artifact["externalUrl"] : "";
      const sourceTool = typeof artifact["sourceTool"] === "string" ? artifact["sourceTool"] : "artifact tool";
      const size = typeof artifact["size"] === "number" ? ` (${artifact["size"]} chars)` : "";
      const textPreview = typeof artifact["textPreview"] === "string"
        ? artifact["textPreview"].replace(/\s+/g, " ").trim()
        : "";
      const location = outputPath || filename || externalUrl;
      if (!location) return "";
      const preview = textPreview ? ` Preview: ${textPreview.slice(0, 900)}` : "";
      return `Saved artifact ${location}${size} via ${sourceTool}.${preview}`;
    })
    .filter(Boolean)
    .slice(-4);
}

export function classifyInterruptedOutcome(params: {
  successfulToolCount: number;
  artifacts: Record<string, unknown>[];
  swarmState?: SwarmState;
}): SubAgentOutcome {
  if (params.successfulToolCount > 0 || params.artifacts.length > 0) {
    return "partial";
  }

  const sawSwarmProgress = Object.values(params.swarmState?.tasks ?? {}).some((task) => (
    task.status === "completed"
    || task.status === "partial"
    || task.attempts.some((attempt) => attempt.status === "completed" || attempt.status === "partial")
  ));

  return sawSwarmProgress ? "partial" : "failure";
}

export function buildArtifactCompletionOutput(params: {
  agentName: string;
  maxIterations: number;
  artifacts: Record<string, unknown>[];
}): string {
  const artifactHints = params.artifacts
    .map((artifact) => {
      const outputPath = typeof artifact["outputPath"] === "string" ? artifact["outputPath"] : "";
      const filename = typeof artifact["filename"] === "string" ? artifact["filename"] : "";
      const externalUrl = typeof artifact["externalUrl"] === "string" ? artifact["externalUrl"] : "";
      return outputPath || filename || externalUrl;
    })
    .filter(Boolean)
    .slice(0, 4);

  return [
    `Sub-agent '${params.agentName}' produced a deliverable artifact before reaching the maximum number of tool-call iterations (${params.maxIterations}).`,
    artifactHints.length > 0 ? `Saved artifacts: ${artifactHints.join(", ")}.` : "",
    "Use the saved artifact as the completed delegated output.",
  ].filter(Boolean).join("\n");
}

/** Strip hallucinated tool-call XML that some models emit in text output. */
export function stripHallucinatedToolTags(text: string): string {
  let stripped = text
    .replace(/<\|channel\>\w+\s*/g, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<function=[^>]*>[\s\S]*?<\/function>/g, "")
    .replace(/<\/tool_call>/g, "");
  // Unclosed `<tool_call>` blocks happen when the model burns its max-tokens
  // budget emitting a Qwen-format tool call as TEXT (session 31612733 had a
  // 14 KB write_file payload truncate mid-content). The closed-form regex
  // above leaves the entire block intact, so the orchestrator presents it as
  // if the file existed. If an opener has no matching closer, strip from the
  // first opener onward — the content past it is hallucinated, not a real
  // result.
  const orphanOpener = stripped.search(/<tool_call>|<function=[^>]*>|<parameter=[^>]*>/);
  if (orphanOpener >= 0) {
    stripped = stripped.slice(0, orphanOpener);
  }
  return stripped.trim();
}
