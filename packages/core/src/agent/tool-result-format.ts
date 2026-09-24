/**
 * Model-visible tool-result framing (god-file seam).
 *
 * `buildModelVisibleToolResult` rewrites raw tool/sub-agent output into the
 * canonical "Delegated result from … — TASK …" frame the orchestrator LLM sees,
 * plus the small PURE text helpers it needs. These do not touch any main-loop
 * mutable closure, so they relocate cleanly out of runtime.ts.
 *
 * INVARIANT: this module imports ONLY leaf modules (runtime-utils,
 * runtime-evidence-dump, interrupted-delegation-evidence, container-failure,
 * effort-context, artifact-metadata). It must NEVER import from runtime.js — keep it a true leaf.
 *
 * `looksLikeDelegatedFailureEvidence` is also used by
 * classifyPostOrchestrationDisposition (which stays in runtime.ts), so runtime.ts
 * imports it back from here — a one-directional edge, no cycle.
 */
import { effectiveMaxDelegatedResultChars } from "../runtime/effort-context.js";
import { looksLikeProviderErrorEcho } from "./container-failure.js";
import { collapseWhitespace, stripPresentationFormatting, looksLikeOrchestrationOnlyEvidence } from "./runtime-utils.js";
import {
  looksLikeRawWorkspaceToolDump,
  formatRawWorkspaceToolDumpFailure,
} from "./runtime-evidence-dump.js";
import {
  EVIDENCE_SECTION_RE,
  extractUsefulInterruptedDelegationEvidence,
  looksLikeInterruptedDelegationWithoutUsableEvidence,
} from "./interrupted-delegation-evidence.js";
import { collectArtifactRecords, type ArtifactRecord } from "./artifact-metadata.js";
import { PRODUCED_FILES_HEADER, TOOL_DECLINES_HEADER, TOOL_FAILURES_HEADER } from "./delegated-run-record.js";
import { defangFramingMarkers } from "../guardrails/framing-markers.js";

export function truncateForContext(value: string, maxChars: number): string {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function truncatePlainText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripAgentPrefix(value: string): string {
  return value.replace(/^\[[^\]]+\]:\s*/i, "").trim();
}

export function stripWorkflowPreamble(value: string): string {
  // Remove "Workflow <name> [scene|job] completed/blocked ...\n\n" system prefix
  // so only the actual deliverable content reaches the orchestrator LLM.
  return value.replace(/^Workflow\s+\S+\s+\[(?:scene|job)\]\s+\S[^\n]*\n\n?/, "").trim();
}

/**
 * Failure signatures the sub-agent runtime cannot see from where it stands: an empty placeholder
 * where the answer should be, a provider/HTTP error echoed as the answer, a container that never
 * ran, a leaked channel marker. These override even an explicit success verdict, because that
 * verdict was minted by the same run that produced them.
 */
export function looksLikeStructuralDelegationFailure(value: string): boolean {
  const preview = value.trim().slice(0, 600);
  if (!preview) return false;
  if (/^sub-agent produced no final response\.?$/i.test(preview)) return true;
  if (/<\|channel>\w+/i.test(preview)) return true;
  if (looksLikeProviderErrorEcho(preview)) return true;
  return /\b(container error|containerized delegation failed|sandbox (?:bootstrap|startup|start) failed|bootstrap failed|runtime crash(?:ed)?|terminated unexpectedly)\b/i.test(preview);
}

export function looksLikeDelegatedFailureEvidence(value: string): boolean {
  const preview = value.trim().slice(0, 600);
  if (!preview) return false;
  if (looksLikeStructuralDelegationFailure(preview)) return true;
  return /^error:/i.test(preview)
    || /\b(no results|not found|unable to|failed to|timed out|cancelled|incomplete|max.{0,20}iterations|could not complete|did not complete|cannot complete|cannot proceed|delegation limit|already failed|not permitted|produced no final response|no usable delegated result returned)\b/i.test(preview)
    || /\bis already running via\s+(?:[a-z0-9_:-]*(?:_agent|_coordinator)|researcher|another agent)\b/i.test(preview)
    || /\bNo (?:agents|workflows) matched\b/i.test(preview)
    || /\b(blocker:|missing source data|required .* unavailable|requested .* unavailable|not available in the current workspace|not available in the workspace|could not be fulfilled with exact figures|cannot be generated at this time|please provide the structured json data to proceed|please provide the source data to proceed|please provide .*json data|i need .*structured json.* to proceed|i need .*data to proceed|task cannot be completed|table does not exist|confirmed non-existent|no source provided the specific .* data)\b/i.test(preview);
}

/**
 * Ceiling on execute_plan's model-visible report. Deliberately far above the other tools' evidence
 * caps: this one text stands in for every step of a plan, where the others each describe one call.
 */
const PLAN_REPORT_MAX_CHARS = 24_000;

/**
 * An EXPLICIT success verdict: the sub-agent closed with `<final_answer status="success">`, which
 * tools/sub-agent.ts records as `delegationVerdict: "explicit"`. The runtime's own
 * `delegationOutcome` / `delegationSucceeded` are defaults minted on every normally-ending
 * delegation (a five-phrase heuristic over the first 300 characters) and carry no verdict —
 * a result that says "task cannot be completed, please provide the data" arrives with both set.
 */
export function isExplicitDelegationSuccess(metadata?: Record<string, unknown>): boolean {
  return metadata?.["delegationVerdict"] === "explicit" && metadata["delegationOutcome"] === "success";
}

/** Lines listed per block; the rest are counted, not listed. */
const PRODUCED_FILES_MAX_LINES = 6;
const TOOL_FAILURES_MAX_LINES = 4;

// The headers, and how the checks that read a whole frame step past the block, are in
// delegated-run-record.ts.

/** A recorded tool, agent, engine, tier or model is printed only when it reads as a name: a few tokens, no prose or markup. */
const RECORDED_NAME_RE = /^[\w.:/@+-]+(?: [\w.:/@+-]+){0,5}$/;

function recordedName(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 80 && RECORDED_NAME_RE.test(value) ? value : undefined;
}

/**
 * One line of free text for the block. Defanged, because the block is added AFTER the tool-output
 * guards ran on the result text: a file name or an error line carrying a role or framing marker
 * would otherwise reach the orchestrator intact.
 */
function singleLine(value: string, maxChars: number): string {
  const flat = defangFramingMarkers(value.replace(/[\s\p{Cc}]+/gu, " ")).trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 3).trimEnd()}...`;
}

function producedFileLine(record: ArtifactRecord, frameAgent: string | undefined): string {
  const tool = recordedName(record.sourceTool);
  const agent = recordedName(record.sourceAgent);
  const engine = recordedName(record.engine);
  const tier = recordedName(record.tier);
  const model = recordedName(record.model);
  const origin = [tool, agent && agent !== frameAgent ? `by ${agent}` : ""].filter(Boolean).join(" ");
  const details = [
    engine ? `engine ${engine}` : "",
    tier ? `tier ${tier}` : "",
    model ? `model ${model}` : "",
    record.elapsedMs !== undefined ? `${(record.elapsedMs / 1000).toFixed(1)} s` : "",
  ].filter(Boolean).join(", ");
  const qualifiers = [origin, details].filter(Boolean).join("; ");
  return `- ${singleLine(record.ref, 200)}${qualifiers ? ` (${qualifiers})` : ""}`;
}

/** The recorded calls that failed, or with `declined` those the user declined (a Skip), which are
 *  their choice and read as a broken tool when listed among the failures. */
function toolFailureLines(failures: unknown, frameAgent: string | undefined, declined = false): string[] {
  if (!Array.isArray(failures)) return [];
  // A specialist retrying the same call gets one line with a count, not one line per retry.
  const counts = new Map<string, number>();
  for (const entry of failures) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    if ((value["declinedByUser"] === true) !== declined) continue;
    const tool = recordedName(value["tool"]);
    if (!tool) continue;
    const agent = recordedName(value["agent"]);
    const error = typeof value["error"] === "string" ? singleLine(value["error"], 160) : "";
    const line = `- ${tool}${agent && agent !== frameAgent ? ` by ${agent}` : ""}: ${error || "no error text"}`;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return [...counts].map(([line, count]) => (count > 1 ? `${line} (x${count})` : line));
}

function cappedBlock(header: string, lines: string[], maxLines: number): string {
  if (lines.length === 0) return "";
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown.push(`- (+${lines.length - maxLines} more)`);
  return [header, ...shown].join("\n");
}

/**
 * What a delegated run RECORDED, as opposed to what its specialist said: the files it produced,
 * with the tool, engine, tier and model the producing tool wrote down, and the tool calls that
 * failed on the way. Without this the frames carry only the specialist's own account. In f4ebf47b
 * that account named the engine the user had asked for; that call had returned a 404, the file came
 * from the fast tier instead, and the final answer repeated the claim. "" when nothing was recorded.
 */
export function formatDelegatedRunRecord(metadata?: Record<string, unknown>): string {
  if (!metadata) return "";
  const frameAgent = typeof metadata["agentName"] === "string" ? metadata["agentName"] : undefined;
  return [
    cappedBlock(
      PRODUCED_FILES_HEADER,
      collectArtifactRecords(metadata).map((record) => producedFileLine(record, frameAgent)),
      PRODUCED_FILES_MAX_LINES,
    ),
    cappedBlock(TOOL_FAILURES_HEADER, toolFailureLines(metadata["specialistToolFailures"], frameAgent), TOOL_FAILURES_MAX_LINES),
    cappedBlock(TOOL_DECLINES_HEADER, toolFailureLines(metadata["specialistToolFailures"], frameAgent, true), TOOL_FAILURES_MAX_LINES),
  ].filter(Boolean).join("\n");
}

export function buildModelVisibleToolResult(
  toolName: string,
  resultText: string,
  metadata?: Record<string, unknown>,
): string {
  const frame = frameToolResult(toolName, resultText, metadata);
  // run_workflow names its files in its own instruction; a second list would repeat them.
  if (toolName === "run_workflow") return frame;
  const record = formatDelegatedRunRecord(metadata);
  if (!record) return frame;
  // At the HEAD of the frame, never in the evidence. Every evidence parser (the single-deliverable
  // relay, the failure sniffers, the backstops) reads from the evidence marker on, so it sees the
  // same bytes as before. And the head survives every cap: the 1,600-char evidence cap, the plan
  // report's cap and the head-first cap on collapsed history.
  if (toolName === "execute_plan") {
    // The plan report has no evidence marker; its first paragraph is the "Plan: N/M" roll-call.
    const end = frame.indexOf("\n\n");
    return end < 0 ? `${frame}\n\n${record}` : `${frame.slice(0, end)}\n\n${record}${frame.slice(end)}`;
  }
  const marker = EVIDENCE_SECTION_RE.exec(frame);
  if (!marker) return frame;
  // Above the frame's IMPORTANT instruction when it has one: that line tells the orchestrator to
  // relay or reproduce "the content below", and the block is not content for the user.
  const head = frame.slice(0, marker.index);
  const important = head.search(/^IMPORTANT:/m);
  const at = important >= 0 ? important : marker.index;
  return `${frame.slice(0, at)}${record}\n${frame.slice(at)}`;
}

function frameToolResult(
  toolName: string,
  resultText: string,
  metadata?: Record<string, unknown>,
): string {
  const fallback = truncateForContext(resultText, 600);

  if (toolName === "delegate_to_agent" || toolName === "swarm_delegate") {
    const agentName = typeof metadata?.["agentName"] === "string" ? String(metadata["agentName"]) : "delegated agent";
    const attemptedAgents = Array.isArray(metadata?.["attemptedAgents"])
      ? (metadata?.["attemptedAgents"] as unknown[]).map(String).filter(Boolean)
      : [];
    const routingReason = metadata?.["routingReason"] && typeof metadata["routingReason"] === "object"
      ? metadata["routingReason"] as Record<string, unknown>
      : undefined;
    const cleaned = stripPresentationFormatting(stripAgentPrefix(resultText));
    const delegationOutcome = typeof metadata?.["delegationOutcome"] === "string" ? String(metadata["delegationOutcome"]) : undefined;
    const hasInterruptedShape = /Partial progress before interruption:|Recovered evidence snippets from completed tools:/i.test(cleaned);
    const rawWorkspaceToolDump = looksLikeRawWorkspaceToolDump(cleaned);
    const partialHasNoUsableEvidence = agentName !== "computer_use_agent"
      && delegationOutcome === "partial"
      && (
        rawWorkspaceToolDump
        || looksLikeInterruptedDelegationWithoutUsableEvidence(cleaned)
        || (!hasInterruptedShape && looksLikeOrchestrationOnlyEvidence(cleaned))
      );
    // A "partial" outcome whose surfaced content is just a regurgitated
    // provider/HTTP error (e.g. LM Studio HTTP 500 HTML page that the
    // soft-deadline synthesis quoted back) is not a useful partial — the
    // model has no real evidence to relay.  Treat it as an outright
    // failure so the parent assistant gets a clear failure signal and
    // can ask the user to retry instead of trying to synthesize an
    // answer from an HTML error page.
    const partialIsProviderErrorEcho = delegationOutcome === "partial" && looksLikeProviderErrorEcho(cleaned);
    const delegationPartial = delegationOutcome === "partial"
      && !partialIsProviderErrorEcho
      && !partialHasNoUsableEvidence;
    // Only an EXPLICIT verdict beats the prose sniff: a specialist that closed with
    // `<final_answer status="success">` and mentioned a failed attempt on the way is still a
    // success. The runtime's defaulted "success" is not a verdict (see isExplicitDelegationSuccess);
    // trusting it silenced the needs-data / blocker signatures for every completed delegation.
    const reportedSuccess = isExplicitDelegationSuccess(metadata);
    const delegationFailed = rawWorkspaceToolDump
      || delegationOutcome === "failure"
      || partialIsProviderErrorEcho
      || partialHasNoUsableEvidence
      || (!delegationPartial && (
        looksLikeStructuralDelegationFailure(cleaned)
        || (!reportedSuccess && (
          metadata?.["delegationSucceeded"] === false
          || /^error:/i.test(cleaned)
          || looksLikeDelegatedFailureEvidence(cleaned)
        ))
      ));

    if (agentName === "computer_use_agent") {
      const evidence = truncatePlainText(cleaned, 1600);
      if (delegationFailed) {
        const parts = [
          `Delegated result from ${agentName} — TASK FAILED.`,
          attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
          routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
          "IMPORTANT: This delegated attempt failed. Report the failure honestly using only the explicit evidence below.",
          "Do NOT claim the task was completed.",
          "Do NOT invent root causes like connectivity, firewall, permissions, or configuration unless the evidence explicitly says so.",
          "Do NOT delegate again for the same information in this turn.",
          `Observed evidence:\n${evidence || "No usable delegated result returned."}`,
        ].filter(Boolean);
        return parts.join("\n");
      }
      if (delegationPartial) {
        const parts = [
          `Delegated result from ${agentName} — PARTIAL PROGRESS.`,
          attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
          routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
          "IMPORTANT: Use the evidence below. State clearly that the desktop run made progress but was interrupted before full completion.",
          "Do NOT ignore the collected evidence.",
          "Do NOT invent root causes like connectivity, firewall, permissions, or configuration unless the evidence explicitly says so.",
          "Do NOT delegate again for the same information in this turn unless the user asks for another attempt.",
          `Observed evidence:\n${evidence || "No usable delegated result returned."}`,
        ].filter(Boolean);
        return parts.join("\n");
      }
      const parts = [
        `Delegated result from ${agentName} — TASK COMPLETED SUCCESSFULLY.`,
        attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
        routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
        "IMPORTANT: Relay ALL specific details from the evidence below (names, numbers, sizes, statuses) in your answer. Do NOT omit items, say 'partially visible', or claim information is 'cut off' if the evidence lists it. The evidence is authoritative.",
        "Do NOT delegate again for the same information — it has already been collected.",
        `Observed evidence:\n${evidence || "No usable delegated result returned."}`,
      ].filter(Boolean);
      return parts.join("\n");
    }

    const partialEvidence = rawWorkspaceToolDump ? null : extractUsefulInterruptedDelegationEvidence(cleaned);
    // When the inner agent surfaced its full delegated specialist body via
    // the "Recovered delegated specialist body (full):" marker (Fix 2), the
    // partial evidence IS the actual completed sub-task answer — bump the
    // cap to the long-deliverable budget so it survives wrapping. Otherwise
    // the parent only sees ~1.6 KB of a 13 KB completed answer.
    const partialEvidenceHasFullBody = /Recovered delegated specialist body \(full\):/i.test(cleaned);
    const partialEvidenceCap = partialEvidenceHasFullBody ? 12_000 : 1600;
    const evidence = rawWorkspaceToolDump
      ? formatRawWorkspaceToolDumpFailure()
      : truncatePlainText(partialEvidence ?? cleaned, partialEvidenceCap);
    if (delegationFailed) {
      const parts = [
        `Delegated result from ${agentName} — TASK FAILED.`,
        attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
        routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
        "IMPORTANT: This delegated attempt failed. Report the failure honestly using only the explicit evidence below.",
        "Do NOT claim the task was completed or infer extra causes that are not explicitly present in the evidence.",
        `Observed evidence:\n${evidence || "No usable delegated result returned."}`,
      ].filter(Boolean);
      return parts.join("\n");
    }
    if (delegationPartial) {
      const terminalState = typeof metadata?.["terminalState"] === "string" ? String(metadata["terminalState"]) : undefined;
      const timedOut = terminalState === "timeout";
      const importantNote = timedOut
        ? "IMPORTANT: The specialist timed out. Use only the explicit partial evidence below; state what remains unverified or incomplete instead of filling gaps. Do NOT delegate again for this task in this turn."
        : "IMPORTANT: Use the partial evidence below to continue your workflow. Do NOT treat this as a workflow failure. Proceed with any dependent tools.";
      const parts = [
        `Delegated result from ${agentName} — PARTIAL PROGRESS${timedOut ? " (TIMEOUT)" : ""}.`,
        attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
        routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
        importantNote,
        `Observed evidence:\n${evidence || "No usable delegated result returned."}`,
      ].filter(Boolean);
      return parts.join("\n");
    }
    // For long completed deliverables (papers, reports, analyses) and
    // structured tabular/list content (markdown tables, numbered lists with
    // many rows) keep markdown intact and pass the full content so the
    // orchestrator LLM can relay it verbatim. Smaller models are otherwise
    // prone to summarising a 27-row headline table down to 2 rows and
    // appending an invented "(truncated)" marker.
    const tableRowCount = (cleaned.match(/^\s*\|.+\|\s*$/gm) ?? []).length;
    const numberedListCount = (cleaned.match(/^\s*\d{1,3}[.)]\s+\S/gm) ?? []).length;
    const bulletListCount = (cleaned.match(/^\s*[-*+]\s+\S/gm) ?? []).length;
    const looksStructured =
      tableRowCount >= 4 || numberedListCount >= 5 || bulletListCount >= 8;
    const isLongDeliverable = cleaned.length > 2500 || looksStructured;
    const successEvidence = isLongDeliverable
      ? truncatePlainText(stripWorkflowPreamble(stripAgentPrefix(resultText)), effectiveMaxDelegatedResultChars())
      : evidence;
    // A runtime-authored research slice returns gathered EVIDENCE, never the
    // user-facing deliverable — the orchestrator must synthesize the actual
    // answer from it. The VERBATIM instruction (and with it the
    // single-deliverable relay shortcut, which keys on that exact string)
    // shipped a component-spec research dump as the entire answer to a device
    // DESIGN request, skipping synthesis completely (audit b5107ae4).
    const researchSlice = metadata?.["researchSlice"] === true;
    const importantNote = researchSlice
      ? "IMPORTANT: This is gathered research EVIDENCE, not the final deliverable. Write the answer to the user's ORIGINAL request yourself, in the user's language, covering EVERY part of what they asked. Ground every concrete spec, name, number, and recommendation in this evidence and keep the source URLs for the claims you use. Do NOT paste this report verbatim and do NOT invent values that are not in the evidence."
      : isLongDeliverable
        ? "IMPORTANT: Present the full content below VERBATIM to the user. Reproduce EVERY row, bullet, list item, table entry, heading, name, number, date, URL, and source exactly as shown. Do NOT summarize, shorten, rephrase, omit any section, collapse rows into 'and others', insert ellipses, or add markers like '(truncated)', '(abgeschnitten)', '(cut off)', '(Zusammenfassung)' — the evidence is the FULL deliverable, not a snippet. Output it exactly as-is, preserving all headings, bullet points, tables, and structure."
        : "IMPORTANT: Relay ALL specific details from the evidence below (names, numbers, values) in your answer. Do NOT paraphrase with different numbers or names. Do NOT add markers like '(truncated)' or '(abgeschnitten)'.";
    const parts = [
      `Delegated result from ${agentName} — TASK COMPLETED.`,
      attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
      routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
      importantNote,
      `Observed evidence:\n${successEvidence || "No usable delegated result returned."}`,
    ].filter(Boolean);
    return parts.join("\n");
  }

  if (toolName === "execute_plan") {
    // THE REPORT IS THE DELIVERABLE. It carries every completed step's result — and a `direct` or
    // `reuse` step's output reaches the model through no other channel, since those run as nested
    // calls inside the tool and never become tool messages of their own. Without a branch here it
    // fell through to the 600-char fallback below, which also collapses newlines: the orchestrator
    // received the roll-call plus a fragment of the first step, cut mid-word, and was told to write
    // the final answer from results it could not see. The executor has already budgeted this text
    // per step and in total; this only bounds the worst case.
    return truncatePlainText(resultText, PLAN_REPORT_MAX_CHARS);
  }

  if (toolName === "parallel_delegate") {
    const succeeded = Number(metadata?.["succeeded"] ?? 0);
    const failed = Number(metadata?.["failed"] ?? 0);
    const taskCount = Number(metadata?.["taskCount"] ?? succeeded + failed);
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    return [
      `Parallel delegation completed. Successful tasks: ${succeeded}/${taskCount}. Failed tasks: ${failed}.`,
      "IMPORTANT: Relay ALL specific details from the evidence below (names, numbers, values, statuses) in your answer. Do NOT replace them with guessed details.",
      `Observed evidence:\n${evidence || "No usable delegated result returned."}`,
    ].join("\n");
  }

  if (toolName === "run_task_graph") {
    const completed = Array.isArray(metadata?.["completed"]) ? (metadata?.["completed"] as unknown[]).length : 0;
    const failed = Array.isArray(metadata?.["failed"]) ? (metadata?.["failed"] as unknown[]).length : 0;
    const blocked = Array.isArray(metadata?.["blocked"]) ? (metadata?.["blocked"] as unknown[]).length : 0;
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    const taskGraphStatus = failed > 0 || blocked > 0
      ? `Task graph finished with incomplete status. Nodes completed: ${completed}. Failed: ${failed}. Blocked: ${blocked}.`
      : `Task graph completed. Nodes completed: ${completed}. Failed: ${failed}. Blocked: ${blocked}.`;
    return [
      taskGraphStatus,
      "IMPORTANT: Relay ALL specific details from the evidence below (task states, selected agents, values) in your answer. Do NOT replace them with guessed details.",
      `Observed evidence:\n${evidence || "No usable task-graph result returned."}`,
    ].join("\n");
  }

  if (toolName === "run_workflow") {
    // No saved workflow matched (a routing miss, not a completed run and not a failure):
    // relay the tool's routing guidance verbatim instead of the "Workflow completed.
    // Executed steps" framing, so the model delegates rather than treating it as
    // executed evidence (audit bd3d60dc).
    if (metadata?.["workflowNotFound"] === true) {
      return resultText.trim() || "No saved workflow matched this request. Delegate to mission_coordinator or answer the user directly.";
    }
    const workflowName = typeof metadata?.["workflowName"] === "string" ? String(metadata["workflowName"]) : "workflow";
    const workflowType = typeof metadata?.["workflowType"] === "string" ? String(metadata["workflowType"]) : "workflow";
    const blocked = metadata?.["blocked"] === true;
    const stepCount = Number(metadata?.["stepCount"] ?? 1);
    const executedSteps = Number(metadata?.["executedSteps"] ?? stepCount);
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    // Artifact-bearing completion: the deliverables are FILES attached to the
    // turn, not chat text. Without this pivot the model relays the document
    // body verbatim and ships its truncated head as the final answer
    // (audit 2445da2e: 1600 chars of the paper's TOC ending in "…" while the
    // real paper/deck/notes sat in the attachments).
    const workflowArtifactPaths = Array.isArray(metadata?.["artifacts"])
      ? (metadata["artifacts"] as Array<Record<string, unknown>>)
        .map((artifact) => typeof artifact["outputPath"] === "string" ? String(artifact["outputPath"]) : (typeof artifact["filename"] === "string" ? String(artifact["filename"]) : ""))
        .filter(Boolean)
      : [];
    const completedInstruction = workflowArtifactPaths.length > 0
      ? "IMPORTANT: The workflow's deliverables were SAVED AS FILES and are attached to this message — do NOT paste their contents into your answer. Write a SHORT final summary in the user's language: state what was completed, list EVERY artifact path below with a one-line description, and note anything the evidence marks as incomplete. Do NOT start fresh ad hoc delegation or rerun research for the same request.\n"
        + `Artifact files (already attached):\n${workflowArtifactPaths.map((path) => `- ${path}`).join("\n")}`
      : "IMPORTANT: Treat this as executed workflow output, not a plan. Relay the concrete evidence below and do not claim extra steps were run. Do NOT start fresh ad hoc delegation, create_ephemeral_agent, or rerun research for the same request in this turn unless the workflow evidence itself identifies one smallest corrective follow-up.";
    return [
      `Workflow ${workflowName} [${workflowType}] ${blocked ? "blocked" : "completed"}. Executed steps: ${executedSteps}/${stepCount}.`,
      blocked
        ? "IMPORTANT: This workflow did not complete. Treat the evidence below as a failure report, not as completed research. Do NOT jump straight to drafting-only agents like paper_author or summarizer unless earlier evidence was already collected successfully."
        : completedInstruction,
      `Observed evidence:\n${evidence || "No usable workflow result returned."}`,
    ].join("\n");
  }

  if (toolName === "create_ephemeral_agent") {
    const agentName = typeof metadata?.["agentName"] === "string" ? String(metadata["agentName"]) : "ephemeral agent";
    const rejectedTools = Array.isArray(metadata?.["rejectedTools"]) ? (metadata?.["rejectedTools"] as unknown[]).map(String).filter(Boolean) : [];
    const evidence = truncatePlainText(stripPresentationFormatting(stripAgentPrefix(resultText)), 1600);
    const failed = looksLikeDelegatedFailureEvidence(evidence);
    return [
      `Ephemeral agent ${agentName} ${failed ? "failed" : "completed"}.`,
      rejectedTools.length > 0 ? `Rejected tools: ${rejectedTools.join(", ")}.` : "",
      failed
        ? "IMPORTANT: This ephemeral-agent attempt failed. Report the failure honestly using only the explicit evidence below. Do NOT claim the task was completed or delegated successfully."
        : "IMPORTANT: Relay ALL specific details from the evidence below in your answer.",
      `Observed evidence:\n${evidence || "No usable ephemeral-agent result returned."}`,
    ].filter(Boolean).join("\n");
  }

  if (toolName === "search_agents") {
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    return [
      "Agent routing suggestions only. No delegation has happened yet.",
      "IMPORTANT: Treat this as candidate-selection guidance, not as proof that any task was routed or executed.",
      "If this turn ends without a completed delegate_to_agent call, do NOT tell the user that work was routed to any suggested agent.",
      `Observed evidence:\n${evidence || "No routing suggestions returned."}`,
    ].join("\n");
  }

  if (toolName === "search_workflows") {
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    return [
      "Workflow catalog suggestions only. No workflow has been executed yet.",
      "IMPORTANT: Treat this as reusable-workflow discovery, not as proof that any scene or job ran.",
      "If this turn ends without a completed run_workflow call, do NOT tell the user that a workflow was executed.",
      "If concrete matches were returned, prefer run_workflow next instead of delegate_to_agent or other ad hoc orchestration.",
      `Observed evidence:\n${evidence || "No workflow matches returned."}`,
    ].join("\n");
  }

  if (toolName === "list_agents") {
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    return [
      "Agent search results only. No delegation has happened yet.",
      "IMPORTANT: Treat this as candidate-selection guidance, not as proof that any task was routed or executed.",
      "If this turn ends without a completed delegate_to_agent call, do NOT tell the user that work was routed to any suggested agent.",
      `Observed evidence:\n${evidence || "No agent candidates returned."}`,
    ].join("\n");
  }

  // Informational capability directory the user explicitly asked for — relay it
  // in full (generously capped) instead of the small generic fallback. The full
  // list is below; explicitly tell the model not to abbreviate or claim
  // truncation (the slow local model otherwise lists only the first few).
  if (toolName === "agent_catalog") {
    return [
      "Complete specialist agent directory below — it is NOT truncated.",
      "If the user asked which agents exist or what they can do, list EVERY entry below. Do NOT abbreviate, sample, summarize to a few, or claim the list was cut off.",
      truncatePlainText(resultText, 12_000),
    ].join("\n");
  }

  return fallback;
}
