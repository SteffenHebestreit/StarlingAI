/**
 * Sub-Agent Runner
 *
 * Executes a named sub-agent from config with its own model, system prompt, and
 * restricted tool set.  Called by the delegate_to_agent tool.
 *
 * Each sub-agent is isolated:
 *  - Fresh conversation history (no access to parent session)
 *  - Its own chat provider instance (potentially a different model/backend)
 *  - A restricted tool list derived from its config
 *  - Audit entries tagged with the parent session ID so tracing works
 */

import type { LLMMessage } from "../providers/lmstudio.js";
import { getConfig } from "../config/loader.js";
import { getToolsAsLLMDefs, rerankToolsForTask, executeTool, normalizeToolCall, type ToolContext, type SwarmState, type SwarmTaskState, type ToolResult } from "../tools/registry.js";
import { isToolAllowed } from "../guardrails/tool-tiers.js";
import { scanOutput } from "../guardrails/output.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { withSpan } from "../observability/tracing.js";
import { runSubAgentInContainer } from "./container-runner.js";
import { looksLikeContainerLevelFailure, looksLikeModelTemplateArtifact, looksLikeProviderErrorEcho } from "./container-failure.js";
import { appendOutcome, computeAdaptiveSubAgentTimeoutMs, extractTaskKeywords } from "./outcomes.js";
import { formatFlowMemoryGuidance } from "./flow-memory.js";
import { acquireSlot, releaseSlot, DEFAULT_CONCURRENCY } from "../swarm/concurrency.js";
import { createChatProvider, getChatProviderForTier, resolveProviderEndpoint } from "../providers/index.js";
import { computerSessionManager } from "./computer-session.js";
import { browserSessionManager } from "./browser-session.js";
import {
  longRunningGenerationManager,
  DEFAULT_SOFT_THRESHOLD_MS,
  DEFAULT_SOFT_THRESHOLD_TOKENS,
  DEFAULT_CONTINUE_GRANT_MS,
  DEFAULT_CONTINUE_GRANT_TOKENS,
} from "./long-running-generation.js";
import { formatScopedMemoryGuidance } from "../memory/service.js";
import { formatSkillGuidance } from "../skills/service.js";
import { graphMarkSessionRetrievalsUseful, graphMarkSessionRetrievalsUnhelpful } from "../memory/graph-service.js";
import { isSessionDegraded } from "./warden.js";
import { consumeAgentMessages, readAllFacts } from "../swarm/memory.js";
import { sanitizeTranscriptContent } from "./sanitize-response.js";
import { truncateToolResult, extractKeyFacts } from "../tools/result-shaping.js";
import { buildDynamicTurnGuidance } from "./intent-classifier.js";
import { shareFinding } from "../tools/memory.js";
import { buildCanonicalSourceSensitiveDelegationTask, deriveSourceSensitiveDelegationFocus } from "./source-sensitive-delegation.js";
// Lazy-import clearSearchSessionState to avoid pulling in web.ts at module
// load time, which would re-register web_search/web_fetch and break tests
// that register their own mocks before importing this module.
let _clearSearchSessionState: ((sessionId: string) => void) | undefined;
async function getSearchCleanup(): Promise<(sessionId: string) => void> {
  if (!_clearSearchSessionState) {
    const web = await import("../tools/web.js");
    _clearSearchSessionState = web.clearSearchSessionState;
  }
  return _clearSearchSessionState;
}

const log = childLogger("agent:sub-agent");

const DEFAULT_MAX_ITERATIONS = 5;
// These thresholds are measured in *extracted* finding bytes — the length of
// what extractKeyFacts() distills and stores as a shared fact (≤ 600 chars each).
// This makes the cap measure actual stored knowledge density, not raw dump volume.
// With web_search capped at 14 calls × ~600 chars = ~8,400 chars max from search
// alone, the strip threshold (12,000) acts as an emergency brake for delegation
// chains rather than a normal research stopper.
const SUFFICIENT_EVIDENCE_NUDGE_BYTES = 4_000;    // ~7 extracted findings
const SUFFICIENT_EVIDENCE_TOOL_STRIP_BYTES = 12_000; // ~20 extracted findings
const EVIDENCE_GATHERING_TOOL_NAMES = new Set([
  "delegate_to_agent",
  "parallel_delegate",
  "swarm_delegate",
  "run_task_graph",
  "web_search",
  "web_fetch",
  "browser_navigate",
  // Browser interaction tools require per-call approval; include them so they
  // are stripped when synthesis is forced and cannot hit the approval gate
  // after the agent already has sufficient evidence.
  "browser_click",
  "browser_type",
  "browser_select_option",
  "site_fill_credentials",
]);

// Single-delegation passthrough — when a coordinator's only substantive tool
// output is one delegation result of this size or larger, return it verbatim
// rather than running a redundant synthesis pass over content that already is
// the final answer. This dodges the "coordinator times out trying to wrap a
// completed sub-agent answer" failure mode that destroys 10+ minutes of work.
const PASSTHROUGH_DELEGATION_MIN_BYTES = 3_000;

// Tools whose presence does NOT disqualify single-delegation passthrough:
// discovery, memory lookup, shared-fact reads, light bookkeeping. If the
// coordinator only ran these plus one substantial delegation, the delegation
// body is the work product.
const PASSTHROUGH_TRIVIAL_TOOL_NAMES = new Set([
  "search_agents",
  "search_workflows",
  "list_agents",
  "list_files",
  "workspace_search",
  "datetime_arithmetic",
  "memory_search",
  "memory_store",
  "memory_promote",
  "read_shared_facts",
  "share_finding",
  "get_swarm_state",
  "research_notes_read",
  "research_notes_summary",
]);

const PASSTHROUGH_DELEGATION_TOOL_NAMES = new Set([
  "delegate_to_agent",
  "parallel_delegate",
  "swarm_delegate",
  "run_task_graph",
  "run_workflow",
]);

const DELEGATE_TOOL_RESULT_PREFIX_RE = /^(Delegated result from|Parallel delegation completed|Task graph (?:completed|finished)|Workflow\s+\S+\s+\[)/i;

interface SingleDelegationPassthroughCandidate {
  output: string;
  delegationToolName: string;
  bytes: number;
  /** Inferred from the wrapper prefix; mirrored on the coordinator's outcome. */
  inferredOutcome: "success" | "partial" | "failure";
}

/** Detect whether the agent's tool history is "single substantial delegation
 * plus only trivial discovery/bookkeeping calls". Returns the full delegation
 * body when so, otherwise null. The caller is expected to surface the body
 * verbatim instead of running another synthesis LLM pass. */
function tryExtractSingleDelegationPassthrough(params: {
  history: readonly LLMMessage[];
  bytesByTool: ReadonlyMap<string, number>;
  toolNames: ReadonlyArray<string>;
}): SingleDelegationPassthroughCandidate | null {
  let chosenDelegationTool: string | null = null;
  let chosenDelegationBytes = 0;
  let substantialCount = 0;
  for (const [name, bytes] of params.bytesByTool.entries()) {
    if (!PASSTHROUGH_DELEGATION_TOOL_NAMES.has(name)) continue;
    if (bytes < PASSTHROUGH_DELEGATION_MIN_BYTES) continue;
    substantialCount += 1;
    if (bytes > chosenDelegationBytes) {
      chosenDelegationBytes = bytes;
      chosenDelegationTool = name;
    }
  }
  if (substantialCount !== 1 || !chosenDelegationTool) return null;

  for (const name of params.toolNames) {
    if (name === chosenDelegationTool) continue;
    if (PASSTHROUGH_TRIVIAL_TOOL_NAMES.has(name)) continue;
    // A non-trivial, non-chosen tool means the agent did real aggregation work
    // beyond a single delegation — passthrough would discard that work.
    return null;
  }

  for (let i = params.history.length - 1; i >= 0; i--) {
    const msg = params.history[i]!;
    if (msg.role !== "tool") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (!content || content.length < PASSTHROUGH_DELEGATION_MIN_BYTES) continue;
    if (!DELEGATE_TOOL_RESULT_PREFIX_RE.test(content)) continue;

    let inferredOutcome: "success" | "partial" | "failure" = "success";
    if (/—\s*TASK FAILED|—\s*FAILED/i.test(content)) inferredOutcome = "failure";
    else if (/—\s*PARTIAL PROGRESS|—\s*PARTIAL/i.test(content)) inferredOutcome = "partial";

    return {
      output: content,
      delegationToolName: chosenDelegationTool,
      bytes: content.length,
      inferredOutcome,
    };
  }
  return null;
}

/** Return the FULL body of the most-recent substantial delegation tool result
 * in `history`, or null. Used by the timeout/interrupt path to surface the
 * actual delegated specialist's answer instead of a 900-char head snippet. */
function extractMostRecentSubstantialDelegationBody(
  history: readonly LLMMessage[],
  minBytes: number = PASSTHROUGH_DELEGATION_MIN_BYTES,
): { content: string; bytes: number } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    if (msg.role !== "tool") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (!content || content.length < minBytes) continue;
    if (!DELEGATE_TOOL_RESULT_PREFIX_RE.test(content)) continue;
    return { content, bytes: content.length };
  }
  return null;
}

function chooseConfiguredSubAgent(candidates: readonly string[]): string | undefined {
  const configuredAgents = getConfig().subAgents ?? {};
  return candidates.find((name) => name in configuredAgents);
}

function chooseConfiguredAllowedSubAgent(candidates: readonly string[], allowedAgents?: readonly string[]): string | undefined {
  const allowedSet = Array.isArray(allowedAgents) && allowedAgents.length > 0
    ? new Set(allowedAgents)
    : null;
  const configuredAgents = getConfig().subAgents ?? {};
  return candidates.find((name) => name in configuredAgents && (!allowedSet || allowedSet.has(name)));
}

function defaultSourceSensitiveFallbackAgents(agentName: string | undefined): string[] {
  return ["mission_coordinator", "researcher"]
    .filter((candidate) => candidate !== agentName)
    .filter((candidate) => chooseConfiguredSubAgent([candidate]) === candidate);
}

function buildSourceSensitiveChildTaskTitle(agentName: string | undefined, focus: string | undefined): string {
  const target = agentName?.trim() || "specialist";
  const compactFocus = focus?.replace(/\s+/g, " ").trim();
  const title = compactFocus
    ? `Source-sensitive ${target} task: ${compactFocus}`
    : `Source-sensitive ${target} task`;
  return title.length > 120 ? `${title.slice(0, 117)}...` : title;
}

type SubAgentRequiredResearchFallbackRoute = {
  toolName: "delegate_to_agent";
  label: string;
  args: Record<string, unknown>;
  /**
   * Mutable counter shared across all rewrite sites. Once the rewriter
   * has fired once, further discovery calls from the same agent within
   * the same run get blocked rather than re-rewritten — see
   * `enforceSubAgentRequiredResearchFallbackRouteOnToolCall`.
   *
   * Without this guard the coordinator that originally triggered
   * "no agents matched" loops on (search_agents → rewritten to
   * delegate_to_agent(parent_task) → swarm sees the parent's own
   * running task by signature and returns "Task is already running"),
   * which produces zero progress and burns ~5–10s of LLM time per
   * iteration before the budget runs out.
   */
  applyCount: { value: number };
};

function buildSubAgentRequiredResearchFallbackRoute(params: {
  task: string;
  agentName: string;
  allowedAgents?: readonly string[];
  effectiveToolNames?: readonly string[];
  excludedAgents?: readonly string[];
}): SubAgentRequiredResearchFallbackRoute | null {
  if (!(params.effectiveToolNames ?? []).includes("delegate_to_agent")) return null;

  const excludedAgents = new Set(params.excludedAgents ?? []);
  const preferredAgents = defaultSourceSensitiveFallbackAgents(params.agentName)
    .filter((candidate) => !excludedAgents.has(candidate))
    .filter((candidate) => chooseConfiguredAllowedSubAgent([candidate], params.allowedAgents) === candidate);
  const selectedAgent = preferredAgents[0];
  if (!selectedAgent && Array.isArray(params.allowedAgents) && params.allowedAgents.length > 0) {
    return null;
  }

  const fallbackAgents = preferredAgents.filter((candidate) => candidate !== selectedAgent);
  return {
    toolName: "delegate_to_agent",
    label: selectedAgent ?? "autonomous_routing",
    args: {
      ...(selectedAgent ? { agentName: selectedAgent } : {}),
      ...(fallbackAgents.length > 0 ? { fallbackAgents } : {}),
      task: params.task,
      taskTitle: buildSourceSensitiveChildTaskTitle(selectedAgent, "fallback after agent discovery no-match"),
    },
    applyCount: { value: 0 },
  };
}

function subAgentSearchAgentsReturnedNoMatch(result: ToolResult): boolean {
  const resultCount = typeof result.metadata?.["resultCount"] === "number"
    ? Number(result.metadata["resultCount"])
    : undefined;
  const topResult = typeof result.metadata?.["topResult"] === "string"
    ? String(result.metadata["topResult"]).trim()
    : "";
  if (resultCount === 0 && !topResult) return true;
  return /^No agents matched\b/i.test(result.output.trim());
}

function enforceSubAgentRequiredResearchFallbackRouteOnToolCall(
  toolCall: { name: string; arguments: Record<string, unknown> },
  route: SubAgentRequiredResearchFallbackRoute,
  subSessionId: string,
  agentName: string,
): boolean {
  const discoveryRetryTools = new Set(["search_agents", "list_agents", "search_workflows"]);
  if (!discoveryRetryTools.has(toolCall.name)) return false;

  // Hard cap: only rewrite the FIRST repeated discovery call. On subsequent
  // calls, leave the original tool name intact and let the per-tool cap for
  // search_agents/list_agents/search_workflows surface a structured refusal
  // that the model can act on without burning another LLM round-trip on a
  // guaranteed-no-op delegation.
  if (route.applyCount.value >= 1) {
    logAudit("sub_agent_tool_call", {
      agentName,
      tool: toolCall.name,
      phase: "recovered",
      reason: "required_research_discovery_retry_capped",
      rewriteApplyCount: route.applyCount.value,
    }, { sessionId: subSessionId, severity: "warn" });
    return false;
  }

  const originalTool = toolCall.name;
  toolCall.name = route.toolName;
  toolCall.arguments = { ...route.args };
  route.applyCount.value += 1;
  logAudit("sub_agent_tool_call", {
    agentName,
    tool: originalTool,
    phase: "recovered",
    reason: "required_research_discovery_retry_rewritten",
    rewrittenTo: route.toolName,
    recoveredAgentName: route.label,
  }, { sessionId: subSessionId, severity: "warn" });
  return true;
}

function withDefaultSourceSensitiveFallbackAgents(args: Record<string, unknown>): Record<string, unknown> {
  const agentName = typeof args["agentName"] === "string" ? String(args["agentName"]).trim() : undefined;
  if (!agentName) return args;
  const existingFallbacks = Array.isArray(args["fallbackAgents"])
    ? args["fallbackAgents"].map(String).filter(Boolean)
    : [];
  if (existingFallbacks.length > 0) return args;
  const fallbackAgents = defaultSourceSensitiveFallbackAgents(agentName);
  return fallbackAgents.length > 0 ? { ...args, fallbackAgents } : args;
}

// Built-in default: 2 (safe for single local GPU).
// Configurable at runtime via orchestration.maxParallelSlices in the gateway settings.
const DEFAULT_MAX_SOURCE_SENSITIVE_PARALLEL_SLICES = 2;

function enforceSourceSensitivePreEvidenceDelegation(
  toolCall: { name: string; arguments: Record<string, unknown> },
  parentTask: string,
  subSessionId: string,
  agentName: string,
): void {
  const originalArgs = toolCall.arguments ?? {};
  let nextArgs: Record<string, unknown> | null = null;

  if (toolCall.name === "delegate_to_agent" || toolCall.name === "swarm_delegate" || toolCall.name === "create_ephemeral_agent") {
    const originalTask = typeof originalArgs["task"] === "string" ? String(originalArgs["task"]) : "";
    const focus = deriveSourceSensitiveDelegationFocus(originalTask, parentTask);
    const delegatedAgentName = typeof originalArgs["agentName"] === "string" ? String(originalArgs["agentName"]).trim() : undefined;
    nextArgs = withDefaultSourceSensitiveFallbackAgents({
      ...originalArgs,
      task: buildCanonicalSourceSensitiveDelegationTask(parentTask, undefined, focus),
      taskTitle: buildSourceSensitiveChildTaskTitle(delegatedAgentName, focus),
    });
    delete nextArgs["context"];
  } else if (toolCall.name === "parallel_delegate") {
    const rawTasks = Array.isArray(originalArgs["tasks"])
      ? originalArgs["tasks"].filter((taskSpec): taskSpec is Record<string, unknown> => Boolean(taskSpec) && typeof taskSpec === "object")
      : [];
    if (rawTasks.length > 0) {
      const cappedTasks = rawTasks.slice(0, getConfig().orchestration?.maxParallelSlices ?? DEFAULT_MAX_SOURCE_SENSITIVE_PARALLEL_SLICES);
      if (rawTasks.length > cappedTasks.length) {
        logAudit(
          "sub_agent_tool_call",
          {
            agentName,
            tool: "parallel_delegate",
            phase: "recovered",
            reason: "source_sensitive_parallel_slice_cap",
            originalTaskCount: rawTasks.length,
            cappedTaskCount: cappedTasks.length,
          },
          { sessionId: subSessionId, severity: "info" },
        );
      }
      nextArgs = {
        ...originalArgs,
        tasks: cappedTasks.map((taskSpec, index) => {
          const originalTask = typeof taskSpec["task"] === "string" ? String(taskSpec["task"]) : "";
          const focus = deriveSourceSensitiveDelegationFocus(originalTask, parentTask);
          const nextTask = withDefaultSourceSensitiveFallbackAgents({
            ...taskSpec,
            task: buildCanonicalSourceSensitiveDelegationTask(parentTask, `SLICE ${index + 1}/${cappedTasks.length}`, focus),
          });
          delete nextTask["context"];
          return nextTask;
        }),
      };
    }
  } else if (toolCall.name === "run_task_graph") {
    const rawNodes = Array.isArray(originalArgs["nodes"])
      ? originalArgs["nodes"].filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === "object")
      : [];
    if (rawNodes.length > 0) {
      nextArgs = {
        ...originalArgs,
        objective: parentTask,
        nodes: rawNodes.map((node, index) => {
          const originalTask = typeof node["task"] === "string" ? String(node["task"]) : "";
          const focus = deriveSourceSensitiveDelegationFocus(originalTask, parentTask);
          const nextNode = withDefaultSourceSensitiveFallbackAgents({
            ...node,
            task: buildCanonicalSourceSensitiveDelegationTask(parentTask, `GRAPH NODE ${index + 1}/${rawNodes.length}`, focus),
          });
          delete nextNode["context"];
          return nextNode;
        }),
      };
    }
  }

  if (!nextArgs || JSON.stringify(nextArgs) === JSON.stringify(originalArgs)) return;
  toolCall.arguments = nextArgs;
  logAudit("sub_agent_tool_call", {
    agentName,
    tool: toolCall.name,
    phase: "recovered",
    reason: "source_sensitive_pre_evidence_parent_task_enforced",
  }, { sessionId: subSessionId, severity: "info" });
}

function deriveRootSessionId(sessionId: string): string {
  let current = sessionId;
  while (current.startsWith("sub:")) {
    const inner = current.slice("sub:".length);
    const lastColon = inner.lastIndexOf(":");
    if (lastColon === -1) return inner;
    const secondLastColon = inner.lastIndexOf(":", lastColon - 1);
    if (secondLastColon === -1) return inner;
    current = inner.slice(0, secondLastColon);
  }
  return current;
}

function hashSharedFindingKey(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function formatSharedFactsContext(sessionId: string, maxChars = 2_400): Promise<{ content: string; signature: string }> {
  try {
    const facts = await readAllFacts(deriveRootSessionId(sessionId));
    const entries = Object.entries(facts)
      .filter(([, value]) => value.trim().length > 0)
      .sort(([left], [right]) => left.localeCompare(right));
    const signature = entries.map(([key, value]) => `${key}:${value}`).join("\n");
    if (entries.length === 0) return { content: "", signature };

    const lines: string[] = [];
    let usedChars = 0;
    for (const [key, value] of entries) {
      const line = `- ${key}: ${value.replace(/\s+/g, " ").trim()}`;
      if (usedChars + line.length > maxChars && lines.length > 0) break;
      lines.push(line.length > maxChars ? `${line.slice(0, maxChars - 3)}...` : line);
      usedChars += line.length;
      if (lines.length >= 12) break;
    }

    return {
      content: [
        "## Shared findings snapshot",
        "Use these before calling more tools. Do not duplicate work already captured here; verify any remaining assumptions against evidence before drafting.",
        ...lines,
      ].join("\n"),
      signature,
    };
  } catch (err) {
    log.debug({ err, sessionId }, "Failed to read shared facts snapshot");
    return { content: "", signature: "" };
  }
}

// Returns the extracted finding text that was stored, or null if skipped
// (too short, duplicate, or boilerplate). The caller counts the returned
// length toward cumulativeUsefulEvidenceBytes so the evidence cap tracks
// actual stored knowledge density rather than raw tool output volume.
async function autoShareUsefulFinding(params: {
  sessionId: string;
  agentName: string;
  toolName: string;
  evidence: string;  // raw (structured) tool output — not whitespace-collapsed
  sharedKeys: Set<string>;
}): Promise<string | null> {
  // Normalize only for length check and dedup key — preserve structure for extraction
  const normalized = params.evidence.replace(/\s+/g, " ").trim();
  if (normalized.length < 180) return null;
  if (params.toolName === "share_finding" || params.toolName === "read_shared_facts") return null;
  if (/^(?:No agents matched|No workflows matched|Tool calls executed:|Iterations completed:)/i.test(normalized)) return null;

  const key = `auto_${params.agentName.replace(/[^a-z0-9_]+/gi, "_").toLowerCase().slice(0, 24)}_${params.toolName.replace(/[^a-z0-9_]+/gi, "_").toLowerCase().slice(0, 24)}_${hashSharedFindingKey(normalized)}`;
  if (params.sharedKeys.has(key)) return null;
  params.sharedKeys.add(key);

  // Extract key facts from the structured (un-normalized) evidence: strips
  // boilerplate headers and bare URLs, extracts title+snippet per search result.
  // This produces a compact, information-dense summary instead of a head-truncated
  // raw dump that wastes shared-facts space on headers and URL lines.
  const extracted = extractKeyFacts(params.evidence, params.toolName);

  await shareFinding(
    params.sessionId,
    key,
    `[${params.agentName}/${params.toolName}] ${extracted}`,
  );
  return extracted;
}

// Per-tool call caps enforced inside sub-agent runs.
// These prevent a single tool from dominating the iteration budget
// (e.g. repeated computer_session_start after a connection failure).
const SUB_AGENT_PER_TOOL_CAPS: Partial<Record<string, number>> = {
  computer_session_start: 4,
  computer_session_stop: 2,
  computer_session_attach: 2,
  computer_list_nodes: 2,
  computer_list_windows: 3,
  computer_focus_window: 3,
  computer_snapshot: 8,
  web_search: 14,
  web_fetch: 16,
  search_workflows: 2,
  search_agents: 2,
  list_agents: 2,
  run_workflow: 2,
  computer_click: 6,
  computer_type: 4,
  computer_hotkey: 4,
  delegate_to_agent: 3,
  swarm_delegate: 3,
  create_ephemeral_agent: 1,
  // Path-keyed cap (see PATH_KEYED_WRITE_TOOLS below). For these tools the
  // cap is per `(tool, path)` rather than per `tool`, so a content_writer
  // building a 4-file website doesn't get blocked at the 3rd file. The
  // number here is the soft TOTAL cap as a backstop; session 2d810e7d
  // (2026-05-28) showed an honest 4-file write blocked at file 4 under
  // the old flat cap of 3.
  write_file: 12,
  edit_file: 12,
  generate_document: 4,
  generate_website: 2,
  generate_docx: 4,
  generate_pptx: 4,
  generate_pdf: 4,
  export_workspace_artifact: 4,
  bundle_artifact_zip: 2,
};

// For these tools the cap is enforced per-(tool, path) so writing N
// different files only counts as 1 call against each path. A real loop
// (same path written repeatedly) still trips the cap at PER_PATH_CAP.
const PATH_KEYED_WRITE_TOOLS = new Set<string>([
  "write_file", "edit_file",
  "generate_document", "generate_docx", "generate_pptx", "generate_pdf",
  "export_workspace_artifact",
]);
const PER_PATH_WRITE_CAP = 2;

const COORDINATOR_SUB_AGENT_PER_TOOL_CAP_OVERRIDES: Partial<Record<string, number>> = {
  delegate_to_agent: 6,
  swarm_delegate: 6,
  // When the I13 cascade-timeout fallback injects web_search / web_fetch into a
  // coordinator that ran out of delegation options, the default cap of 6 is far
  // too low for multi-topic research briefs. Allow coordinators up to 20 direct
  // searches and 25 fetches so they can produce a meaningful synthesis instead of
  // returning a partial answer after hitting the cap mid-task.
  web_search: 20,
  web_fetch: 25,
};

const COMPUTER_OBSERVATION_ONLY_TOOLS = new Set<string>([
  "computer_list_nodes",
  "computer_list_sessions",
  "computer_session_start",
  "computer_session_attach",
  "computer_list_windows",
  "computer_snapshot",
  "computer_capture_region",
  "computer_wait_for",
  // http_request lets observation-mode runs query REST APIs (e.g. LM Studio /v1/models)
  // instead of being stranded when vision analysis is unavailable.
  "http_request",
  // get_site_credentials is read-only (tier 0, never exposes secrets) and provides
  // stored URLs so the agent doesn't hallucinate ports/paths from training data.
  "get_site_credentials",
]);

const MAIL_READ_ONLY_TOOLS = new Set<string>([
  "mail_list_accounts",
  "mail_list_mailboxes",
  "mail_search",
  "mail_read",
  "mail_list_unread",
]);

const ORCHESTRATION_DISCOVERY_TOOL_NAMES = new Set<string>([
  "list_agents",
  "search_agents",
  "search_tools",
  "search_workflows",
  "delegate_to_agent",
  "swarm_delegate",
  "run_workflow",
  "parallel_delegate",
  "run_task_graph",
]);

const GATEWAY_BOUND_SERVICE_TOOL_PREFIXES = [
  "mail_",
  "calendar_",
  "contacts_",
];

const WORKFLOW_OUTPUT_PASSTHROUGH_AUXILIARY_TOOL_NAMES = new Set<string>([
  "search_workflows",
  "share_finding",
]);

// Tools whose output is deterministic enough within a single sub-agent run that
// re-issuing the call with identical arguments is wasted work. The existing
// `lastToolCallSig` map only catches *consecutive* duplicates (A→A); this set
// powers a broader (name, args) cache that also catches A→B→A loops, which
// account for the majority of iteration-budget burn in research and discovery
// runs. Excluded by design: any tool that reflects mutating state (browser
// session, computer session, swarm state, mail send/draft, file writes) or
// queries that may legitimately need a fresh fetch (get_swarm_state, browser_*).
const IDEMPOTENT_TOOLS = new Set<string>([
  "read_file",
  "list_files",
  "list_agents",
  "search_agents",
  "search_tools",
  "search_workflows",
  "extract_file_content",
  "spreadsheet_read",
  "list_pdf_form_fields",
  "list_tts_voices",
  "geocode_location",
  "route_distance_time",
  "web_search",
  "web_fetch",
  "workspace_search",
]);

/**
 * Tools that observe or mutate LIVE, changing state — a browser page or a remote
 * desktop. Their result is never safe to dedup/cache against an earlier identical
 * call, because the state changes between calls: e.g. after site_fill_credentials
 * submits a login, re-navigating to the same URL or re-snapshotting must fetch the
 * NEW post-login page, not replay the stale pre-login form. Caching these makes a
 * successful login look like it failed (and trips the blocked-iteration loop
 * detector). The loop detector still catches genuinely stuck repeats.
 */
export function isLiveStateTool(name: string): boolean {
  return name.startsWith("browser_") || name.startsWith("computer_");
}

function isApprovalGateFailure(text: string | undefined): boolean {
  if (!text) return false;
  return /\b(?:approval (?:timed out|expired|failed|was not granted|not granted|explicitly denied)|execution denied by user|requires human approval|no approval channel)\b/i.test(text);
}

function buildApprovalRetryBlockedMessage(toolName: string, priorFailure: string): string {
  const normalized = priorFailure.replace(/\s+/g, " ").trim();
  return [
    `Tool '${toolName}' is no longer available in this sub-agent run because its human approval gate was not satisfied.`,
    normalized ? `Earlier approval result: ${normalized}` : "Earlier approval result: approval was not granted.",
    "Do not retry this approval-gated tool in the same run. Report the blocker and ask the user to retry when they can approve the prompt.",
  ].join(" ");
}

function resolveSubAgentToolCap(toolName: string, isCoordinatorAgent: boolean): number | undefined {
  const orchestration = getConfig().orchestration;
  if (isCoordinatorAgent) {
    const cfgOverride = orchestration?.coordinatorToolCaps?.[toolName];
    if (cfgOverride !== undefined) return cfgOverride;
    const builtInOverride = COORDINATOR_SUB_AGENT_PER_TOOL_CAP_OVERRIDES[toolName];
    if (builtInOverride !== undefined) return builtInOverride;
  }
  const cfgOverride = orchestration?.subAgentToolCaps?.[toolName];
  if (cfgOverride !== undefined) return cfgOverride;
  return SUB_AGENT_PER_TOOL_CAPS[toolName];
}

function isComputerObservationOnlyTask(task: string): boolean {
  const normalized = task.toLowerCase();
  if (!normalized.trim()) return false;

  const observationIntent = /(list|identify|inspect|analy[sz]e|describe|report|read|check|show|visible|screenshot|snapshot|screen|what is on (?:the )?screen|loaded models|model names|welche|liste|prüfe|analysiere|beschreibe|sichtbar)/i.test(normalized);
  if (!observationIntent) return false;

  const explicitInteraction = /(click|doubleclick|type|press|hotkey|shortcut|open|launch|navigate|scroll|drag|upload|download|log in|login|sign in|fill|submit|reply|send|switch tab|switch window|focus the input|paste|öffne|starte|navigiere|klick|eingeben|einloggen|anmelden|hochladen|herunterladen|ausfüllen|absenden|antworten|senden|einfügen)/i.test(normalized);
  return !explicitInteraction;
}

function isMailInboxReadTask(task: string): boolean {
  const normalized = task.toLowerCase();
  if (!normalized.trim()) return false;

  const mailIntent = /(email|emails|mail|inbox|mailbox|posteingang|nachricht|nachrichten|unread|neu(?:e)? e-?mails?)/i.test(normalized);
  if (!mailIntent) return false;

  const readIntent = /(check|read|list|show|summari[sz]e|scan|look for|look up|prüf|lies|liste|fass|zusammen|zeige|check mal)/i.test(normalized);
  if (!readIntent) return false;

  const writeIntent = /(draft|reply|respond|send|compose|write back|antwort|senden|entwurf|verfassen)/i.test(normalized);
  return !writeIntent;
}

export function isExplicitUnreadMailInboxTask(task: string): boolean {
  const normalized = task.toLowerCase();
  if (!isMailInboxReadTask(normalized)) return false;
  return /(unread|ungelesen|neu(?:e|en)?\s+(?:e-?mails?|nachrichten?)|new(?:est)?\s+(?:emails?|messages?|mail))/i.test(normalized);
}

export function getEffectiveToolNames(agentName: string, configuredTools: string[] | undefined, task: string): string[] | undefined {
  if (!configuredTools) return configuredTools;
  if (agentName !== "computer_use_agent" || !isComputerObservationOnlyTask(task)) {
    if (agentName === "mail_agent" && isMailInboxReadTask(task)) {
      return configuredTools.filter((toolName) => MAIL_READ_ONLY_TOOLS.has(toolName));
    }
    return configuredTools;
  }
  return configuredTools.filter((toolName) => COMPUTER_OBSERVATION_ONLY_TOOLS.has(toolName));
}

function buildTaskModeGuidance(agentName: string, task: string): string {
  if (agentName !== "computer_use_agent" || !isComputerObservationOnlyTask(task)) {
    if (agentName === "mail_agent" && isMailInboxReadTask(task)) {
      const preferredReadTool = isExplicitUnreadMailInboxTask(task) ? "mail_list_unread" : "mail_search";
      return [
        "TASK MODE - QUICK INBOX CHECK.",
        "For this task, call a mail_* read tool immediately before writing any narrative.",
        "If the account is unspecified, call mail_list_accounts first.",
        `Then prefer ${preferredReadTool}${preferredReadTool === "mail_search" ? " for broad inbox listings, date filters, and requests that include read mail" : " for explicit unread or new-mail checks"}, and call mail_read only for the few messages you summarize.`,
        "Do not draft, update, send, categorize, or delegate for this task.",
      ].join("\n");
    }
    if (agentName === "shell_agent" && /\b(ssh|server|host|docker|container|containers|systemctl|journalctl|kubectl|n8n-server)\b/i.test(task)) {
      return [
        "TASK MODE - DIRECT REMOTE CLI EXECUTION.",
        "This task asks for a concrete server-side command or inventory result, not exploratory repo inspection.",
        "If the context names a configured SSH target, call ssh_exec with nodeName immediately instead of searching local files for connection details.",
        "For one-shot checks like docker ps, systemctl status, journalctl, or df -h, prefer a single decisive remote command and then summarize the actual output.",
        "If ssh_exec returns command output, treat that output as the answer. Do not override successful stdout with diagnosis, fallback theories, or a contradictory failure summary.",
        "If the remote command fails, report the exact ssh_exec error or approval blocker verbatim. Quote the literal failing phrase such as 'Permission denied', 'Connection refused', or 'timed out' instead of paraphrasing it into generic possibilities.",
        "Do not replace concrete stderr with speculative text like 'might be authentication or network'. If the evidence is only an SSH error, return that exact SSH error.",
      ].join("\n");
    }
    if (agentName === "ops_triage" && /\b(ssh|server|host|docker|container|containers|systemctl|journalctl|kubectl|n8n-server)\b/i.test(task)) {
      return [
        "TASK MODE - REMOTE INCIDENT TRIAGE.",
        "Start with one or two high-signal remote checks using ssh_exec or service_check, not a broad workspace search.",
        "If the context names a configured SSH target, prefer ssh_exec with nodeName before looking for local config files.",
        "Report concrete failure signals first. Avoid exploratory narration that does not produce evidence.",
      ].join("\n");
    }
    if (agentName === "computer_use_agent") {
      return "CREDENTIAL LOOKUP: Before making http_request calls to a service, call get_site_credentials with the hostname or short name to retrieve the stored URL, port, and API key. Do NOT guess default ports or URLs from training data.";
    }
    return "";
  }

  return [
    "TASK MODE — READ-ONLY OBSERVATION.",
    "The user asked you to inspect, list, or describe the current state, not to operate the desktop UI.",
    "Start with connection/session discovery if needed, then capture a computer_snapshot immediately.",
    "Prefer additional computer_snapshot or computer_capture_region calls over any interaction.",
    "Do NOT click, type, use hotkeys, scroll, drag, open apps, or launch dialogs for this task.",
    "If the current desktop does not already show the requested evidence, report that limitation explicitly instead of probing blindly.",
    "If you need to make an http_request to a service, call get_site_credentials first to retrieve the stored URL and port. Do NOT guess URLs or default ports from training data.",
  ].join("\n");
}

function isDirectRemoteCliTask(agentName: string, task: string): boolean {
  if (agentName !== "shell_agent") {
    return false;
  }
  return /\b(docker\s+ps|whoami|systemctl(?:\s+status)?|journalctl|df\s+-h|uname\s+-a|ps\s+aux)\b/i.test(task)
    && /\b(ssh|server|host|docker|container|containers|n8n-server)\b/i.test(task);
}

function buildModelExecutionGuidance(modelId: string, enableThinking: boolean | undefined): string {
  if (!modelId.toLowerCase().includes("gemma-4-e4b-it")) {
    return "";
  }

  return [
    "MODEL FIT — COMPACT SPECIALIST EXECUTION.",
    "Keep the plan short and implicit. Do not write long preambles before acting.",
    "Prefer one decisive tool call at a time unless the current agent is explicitly coordinating parallel work.",
    "After each tool result, either make the next needed tool call immediately or stop and summarize. Do not narrate future actions.",
    "Stop as soon as the task can be completed from the current evidence. Do not keep searching for marginal improvements.",
    "If two consecutive steps fail or return no materially new evidence, report the blocker instead of looping.",
    enableThinking
      ? "Use deeper reasoning only when reconciling conflicting evidence, extracting exact conclusions from dense output, or choosing between multiple plausible next steps."
      : "Keep reasoning lightweight. Favor direct evidence extraction and deterministic tool sequences over speculative exploration.",
  ].join("\n");
}

function isOrchestrationCapableRun(toolNames: string[] | undefined): boolean {
  return toolNames?.some((toolName) => ORCHESTRATION_DISCOVERY_TOOL_NAMES.has(toolName)) ?? false;
}

function buildSubAgentToolInventory(toolNames: string[] | undefined): string {
  const availableTools = toolNames ?? [];
  if (availableTools.length === 0) {
    return [
      "TOOL INVENTORY",
      "No callable tools are available in this run.",
      "Do not claim to have used tools you do not have. If the task cannot be completed from the provided context alone, say so explicitly.",
    ].join("\n");
  }

  const guidance = [
    "TOOL INVENTORY",
    `You may use only these tools in this run: ${availableTools.join(", ")}`,
    "The runtime provides the real tool schemas separately. Use those exact tool definitions for names and parameters. Do not invent or paraphrase tool names.",
  ];

  const hasDirectWebResearch = availableTools.includes("web_search") || availableTools.includes("web_fetch");
  const canSearchForSpecialists = availableTools.includes("search_agents");
  const canDelegateToSpecialists = availableTools.includes("delegate_to_agent") || availableTools.includes("swarm_delegate");

  if (hasDirectWebResearch) {
    guidance.push("When the task depends on current, external, or source-sensitive facts, validate them with up-to-date web evidence whenever feasible instead of relying only on prior knowledge.");
  } else if (canSearchForSpecialists && canDelegateToSpecialists) {
    guidance.push("When the task depends on current, external, or source-sensitive facts that you cannot verify with your own tools, use search_agents and then delegate_to_agent to route the work to a research-capable specialist before answering.");
  } else if (canSearchForSpecialists) {
    guidance.push("When the task depends on current, external, or source-sensitive facts that you cannot verify with your own tools, use search_agents to identify a research-capable specialist instead of guessing.");
  } else if (canDelegateToSpecialists) {
    guidance.push("When the task depends on current, external, or source-sensitive facts that you cannot verify with your own tools, delegate to a research-capable specialist instead of guessing.");
  }

  if (availableTools.includes("search_agents")) {
    guidance.push("If the right specialist is not obvious, call search_agents before delegating.");
  }
  if (availableTools.includes("search_workflows")) {
    guidance.push("If the request looks like a recurring packet, paper, review, or other reusable flow, call search_workflows before inventing a new plan.");
  }
  if (availableTools.includes("list_agents")) {
    guidance.push("Call list_agents(query) — not list_agents() — when you need to browse several agent candidates at once. It requires a task description and searches semantically, same as search_agents but returns up to 10 candidates.");
  }
  if (availableTools.includes("delegate_to_agent")) {
    guidance.push("Sub-agent names are not tools. Invoke another specialist only through delegate_to_agent or swarm_delegate.");
  } else if (availableTools.includes("swarm_delegate")) {
    guidance.push("Sub-agent names are not tools. Invoke specialists through swarm_delegate and let the swarm pick the right agent.");
  }
  if (availableTools.includes("parallel_delegate")) {
    guidance.push("Use parallel_delegate only for genuinely independent partitions of work.");
  }
  if (availableTools.includes("run_task_graph")) {
    guidance.push("Use run_task_graph when later steps depend on earlier findings.");
  }
  if (availableTools.includes("run_workflow")) {
    guidance.push("Use run_workflow when a scene or job already matches the task shape closely.");
  }

  return guidance.join("\n");
}

function buildSubAgentAgentDiscoveryGuidance(agentName: string, allowedAgents: string[] | undefined): string {
  const config = getConfig();
  const catalogNames = Object.keys(config.subAgents)
    .filter((name) => name !== agentName)
    .filter((name) => !allowedAgents || allowedAgents.includes(name))
    .sort((left, right) => left.localeCompare(right));

  const header = [
    "AGENT DISCOVERY",
    allowedAgents && allowedAgents.length > 0
      ? `Delegation in this run is restricted to these agents: ${allowedAgents.join(", ")}`
      : "You may delegate only to configured specialist agents that are visible in this run.",
    "If the right specialist is not obvious, search first and delegate second.",
  ];

  if (catalogNames.length === 0) {
    header.push("No other delegate targets are available in this run.");
    return header.join("\n");
  }

  const catalogLines = catalogNames.slice(0, 24).map((name) => {
    const description = config.subAgents[name]?.description?.trim() ?? "No description available.";
    return `- ${name}: ${description}`;
  });

  if (catalogNames.length > 24) {
    catalogLines.push(`- ${catalogNames.length - 24} more configured agents are available; use list_agents(query) or search_agents(query) to discover them semantically.`);
  }

  return [...header, ...catalogLines].join("\n");
}

function sanitizeSubAgentTask(configuredTools: string[] | undefined, task: string): string {
  let sanitizedTask = task;
  if (configuredTools?.some((toolName: string) => toolName.startsWith("computer_"))) {
    sanitizedTask = sanitizedTask
      .replace(/(?:using|use|press|hit|with|via)\s+(?:keyboard\s+shortcut\s+)?(?:Ctrl|Alt|Shift|Cmd|Meta|Win)\+[A-Za-z+]+/gi, "using mouse clicks on visible UI elements")
      .replace(/(?:Ctrl|Alt|Cmd|Meta)\+(?:Shift|Alt)\+[A-Za-z]/gi, "(blocked shortcut — use mouse click)")
      .replace(/(?:command\s+palette|Ctrl\+Shift\+P)/gi, "visible UI elements")
      .replace(/(?:keyboard\s+shortcut|shortcut|key\s*(?:combo|combination))\s+(?:to\s+)?(?:open|toggle|show|launch)/gi, "mouse click to open");
  }
  return sanitizedTask;
}

function looksLikeNarratedToolCall(content: string): boolean {
  const preview = content.slice(0, 2000);
  if (!preview.trim()) return false;
  return /<tool_call>|<function=|<parameter=|\[Tool:/i.test(preview);
}

function looksLikeUnsupportedScanClaim(content: string): boolean {
  const preview = content.slice(0, 2000);
  if (!preview.trim()) return false;

  const blockingClaim = /\b(http\s*403|403 forbidden|forbidden|waf|rate limit(?:ing)?|bot detection|access restriction|access restrictions)\b/i.test(preview);
  const attemptedAction = /\b(attempt(?:ing|ed)?|scan(?:ning|ned)?|recon(?:naissance)?|navigat(?:e|ing|ed)|access(?:ing|ed)?|request(?:ing|ed)?)\b/i.test(preview);
  return blockingClaim && attemptedAction;
}

function looksLikeHallucinatedDelegationSummary(content: string): boolean {
  const preview = content.slice(0, 2000);
  if (!preview.trim()) return false;

  if (/let me check the agent outputs directly/i.test(preview)) {
    return true;
  }

  const mentionsAgentCompletion =
    /\b[a-z][a-z0-9_]*_agent\b[\s\S]{0,40}\b(completed|executed|finished)\b/i.test(preview) ||
    /\b(completed|executed|finished)\b[\s\S]{0,40}\b[a-z][a-z0-9_]*_agent\b/i.test(preview);
  if (mentionsAgentCompletion) {
    return true;
  }

  const completionClaim = /\b(task graph completed|all phases were executed|completed phases|engagement has been completed successfully|penetration test complete|pentest complete|test initiated|starting engagement)\b/i.test(preview);
  const referencedAgents = preview.match(/\b[a-z][a-z0-9_]*_agent\b/gi) ?? [];
  return completionClaim && referencedAgents.length >= 2;
}

/**
 * Detect the specific failure mode where a sub-agent's model exhausts its
 * completion budget without ever emitting a callable tool call.
 *
 * Observed live with content_writer + qwen3.6-35b-a3b for HTML SPA artifact
 * tasks: the model attempts to put the entire 30 KB document into a single
 * `write_file(content=...)` argument; the tool-call JSON outgrows the 8192
 * completion-token cap; the provider can't parse the truncated call and
 * returns empty content + empty tool_calls. The sub-agent then exits with
 * `iterations: 0, toolCount: 0, completionTokens >= maxTokens, output:
 * "Sub-agent produced no final response."` — and previously got recorded as
 * "completed/success" because the semantic-outcome heuristic only looked for
 * "not found / unable to / error:" in the empty-ish output.
 *
 * Caller already gates on `toolCount === 0`, so this only fires when no tool
 * ran at all.
 */
export function looksLikeExhaustedBudgetNoTool(output: string, stats: SubAgentExecutionStats): boolean {
  const trimmed = output.trim();
  // Canonical "model returned empty content" marker, or any trivially empty answer.
  const triviallyEmpty = trimmed.length < 60 || trimmed === "Sub-agent produced no final response.";
  if (!triviallyEmpty) return false;
  // Real signal that the model actually tried — a few thousand completion tokens
  // burned but no usable content reached the caller. 1500 is well above any
  // legitimate "the model decided this question had no answer" response, which
  // would normally cost <300 tokens.
  return stats.usage.completionTokens >= 1500;
}

function rejectSuspiciousNoToolOutput(
  opts: SubAgentRunOptions,
  stats: SubAgentExecutionStats,
  output: string,
  turnTimeoutMs: number | undefined,
  runStartedAt: number,
): SubAgentRunResult | null {
  if (stats.toolCount > 0) return null;

  const failureStats: SubAgentExecutionStats = {
    ...stats,
    outcome: "failure",
    terminalState: "error",
  };

  let reason: string | null = null;
  if (looksLikeHallucinatedDelegationSummary(output)) {
    reason = "claimed delegated work completed without executing any tool calls";
  } else if (looksLikeNarratedToolCall(output)) {
    reason = "emitted narrated tool-call text without executing any tool calls";
  } else if (looksLikeUnsupportedScanClaim(output)) {
    reason = "reported scan blocking or HTTP findings without executing any tool calls";
  } else if (looksLikeExhaustedBudgetNoTool(output, stats)) {
    // Qwen failure mode: the model tries to inline a large artifact (HTML/JS/CSS)
    // as a single huge write_file argument. The tool-call JSON exceeds the 8192
    // completion-token cap, the provider can't parse the truncated call, and
    // returns empty content + empty tool_calls. Previously this was misclassified
    // as `outcome: "success", terminalState: "completed"` because the
    // semantic-outcome regex didn't match the canonical
    // "Sub-agent produced no final response." string. Now it's a real failure
    // so the orchestrator surfaces it instead of inlining the artifact as a
    // chat code block.
    reason = "exhausted completion budget without calling any tool — the model likely tried to inline a large artifact instead of using a focused write_file/generate_website call";
  }

  if (!reason) return null;

  const error = `Sub-agent error: '${opts.agentName}' ${reason}.`;

  logAudit(
    "sub_agent_completed",
    {
      agentName: opts.agentName,
      iterations: stats.iterations,
      resultLength: output.length,
      promptChars: stats.promptChars,
      userContentChars: stats.userContentChars,
      toolCount: stats.toolCount,
      usage: stats.usage,
      model: stats.model,
      durationMs: Date.now() - runStartedAt,
      outcome: failureStats.outcome,
      terminalState: failureStats.terminalState,
      suspiciousNoToolOutput: true,
      suspiciousNoToolReason: reason,
    },
    { sessionId: stats.sessionId, severity: "warn" }
  );

  appendOutcome(opts.workspacePath, {
    ts: new Date().toISOString(),
    agent: opts.agentName,
    task: opts.task.slice(0, 200),
    outcome: "failure",
    iterations: stats.iterations,
    totalTokens: stats.usage.totalTokens,
    durationMs: Date.now() - runStartedAt,
    timeoutMs: turnTimeoutMs,
    error: reason,
  });

  return { output: error, stats: failureStats };
}

function normalizeSubAgentOutput(content: string | null | undefined): string {
  const normalized = typeof content === "string" ? content.trim() : "";
  return normalized.length > 0 ? normalized : "Sub-agent produced no final response.";
}

function truncateToolAuditText(value: string | null | undefined, maxLength = 280): string | undefined {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!normalized) return undefined;
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
    : normalized;
}

function summarizeToolAuditMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  const summary: Record<string, unknown> = {};
  for (const key of [
    "query",
    "rewrittenQuery",
    "resultCount",
    "backend",
    "requestedBackend",
    "attemptedBackends",
    "url",
    "fetchMethod",
    "contentType",
    "contentLength",
    "outputPath",
    "filename",
    "previewMode",
  ]) {
    if (key in metadata) {
      summary[key] = metadata[key];
    }
  }

  const ranking = metadata["ranking"];
  if (ranking && typeof ranking === "object") {
    const rankingRecord = ranking as Record<string, unknown>;
    const topResults = Array.isArray(rankingRecord["topResults"])
      ? rankingRecord["topResults"]
          .slice(0, 3)
          .map((entry) => {
            if (typeof entry !== "object" || entry === null) {
              return entry;
            }
            const value = entry as Record<string, unknown>;
            return {
              title: typeof value["title"] === "string" ? value["title"] : undefined,
              url: typeof value["url"] === "string" ? value["url"] : undefined,
              score: typeof value["score"] === "number" ? value["score"] : undefined,
            };
          })
      : [];
    if (topResults.length > 0) {
      summary["ranking"] = { topResults };
    }
  }

  if (Array.isArray(metadata["artifacts"])) {
    summary["artifactCount"] = metadata["artifacts"].length;
  }
  if (Array.isArray(metadata["accounts"])) {
    summary["accountCount"] = metadata["accounts"].length;
  }
  if (Array.isArray(metadata["messages"])) {
    summary["messageCount"] = metadata["messages"].length;
  }

  const message = metadata["message"];
  if (message && typeof message === "object") {
    const value = message as Record<string, unknown>;
    const messageSummary: Record<string, unknown> = {};
    for (const key of ["accountId", "mailbox", "uid", "subject", "from", "date"]) {
      if (key in value) {
        messageSummary[key] = value[key];
      }
    }
    if (Object.keys(messageSummary).length > 0) {
      summary["message"] = messageSummary;
    }
  }

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function buildSubAgentToolAuditPayload(params: {
  agentName: string;
  tool: string;
  phase: "start" | "done";
  args?: Record<string, unknown>;
  toolCallId?: string;
  deterministic?: boolean;
  result?: ToolResult;
  errorText?: string;
  resultPreview?: string;
  successOverride?: boolean;
  cachedResult?: boolean;
  skippedReason?: string;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    agentName: params.agentName,
    tool: params.tool,
    phase: params.phase,
  };

  if (params.toolCallId) payload["toolCallId"] = params.toolCallId;
  if (params.deterministic) payload["deterministic"] = true;
  if (params.args && Object.keys(params.args).length > 0) payload["args"] = params.args;
  if (params.cachedResult) payload["cachedResult"] = true;
  if (params.skippedReason) payload["skippedReason"] = params.skippedReason;

  if (params.phase === "done") {
    const success = params.result ? params.result.success : (params.successOverride ?? !params.errorText);
    payload["success"] = success;

    const error = truncateToolAuditText(params.result?.error ?? params.errorText, 220);
    if (error) payload["error"] = error;

    const metadata = params.result?.metadata && typeof params.result.metadata === "object"
      ? summarizeToolAuditMetadata(params.result.metadata)
      : undefined;
    if (metadata) payload["metadata"] = metadata;

    const outputChars = params.result?.output.length;
    if (typeof outputChars === "number") payload["outputChars"] = outputChars;

    const preview = params.resultPreview
      ?? (params.result?.success
        ? truncateToolAuditText(params.result.output)
        : truncateToolAuditText(params.result?.error ?? params.errorText ?? params.result?.output));
    if (preview) payload["resultPreview"] = preview;
  }

  return payload;
}

function formatSwarmProgressForInterruption(state: SwarmState | undefined): string {
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

function stripToolResultLabel(value: string): string {
  return value.replace(/^(?:[a-z][a-z0-9_]*|artifact):\s+/, "").trim();
}

function stripInterruptedProgressPrefix(value: string): string {
  return value
    .replace(/^\*\*\[[^\]]+\]\*\*\s*(?:\((?:failed|partial)\))?:\s*/i, "")
    .replace(/^(?:parallel|task)_\d+\s+\[[^\]]+\]\s*/i, "")
    .replace(/^[a-z_]+\s+\[[^\]]+\]\s*/i, "")
    .trim();
}

function looksLikeInterruptedEvidenceBoilerplate(value: string): boolean {
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

function looksLikeHallucinatedTruncationClaim(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /\b(?:workflow|tool|delegat(?:ed|ion)|evidence|output|result|context|inhalt|ergebnis)\b.{0,140}\b(?:truncated|cut\s+off|cuts\s+off|abgeschnitten|not\s+visible|nicht\s+sichtbar|cannot\s+see)\b/i.test(trimmed)
    || /\b(?:truncated|cut\s+off|cuts\s+off|abgeschnitten|not\s+visible|nicht\s+sichtbar|cannot\s+see)\b.{0,140}\b(?:workflow|tool|delegat(?:ed|ion)|evidence|output|result|context|inhalt|ergebnis)\b/i.test(trimmed);
}

function collectInterruptedEvidenceSnippets(text: string): string[] {
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

function extractUsefulInterruptedToolEvidence(text: string): string | null {
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

function buildInterruptedSubAgentOutput(params: {
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

type SubAgentOutcome = "success" | "partial" | "failure";

function resolveInterruptedEvidenceSnippets(params: {
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

function looksLikeTimeoutLikeError(error: unknown): boolean {
  const text = String(error ?? "").trim();
  if (!text) return false;
  return /\b(timed out|timeout|abort(?:ed|error)?)\b/i.test(text);
}

function looksLikePlanningOnlyResult(result: string): boolean {
  const preview = result.slice(0, 600).trim();
  if (!preview) return false;

  const startsLikePlanning = /^\s*(let me|now let me|first let me|now i can|now i (?:have|understand)\b[\s\S]{0,160}\blet me|i (?:now )?(?:have|understand)\b[\s\S]{0,160}\blet me|i(?:'m| am) going to|i(?:'ll| will)|i(?:'m| am) trying to|i need to|next,? i(?:'m| am) going to)\b/i.test(preview);
  if (!startsLikePlanning) return false;

  const planningAction = /\b(try|attempt|start|check|verify|fetch|get|gather|collect|retrieve|research|search|look for|look up|read|download|continue|proceed|focus|click|type|open|inspect|retry|use|switch|launch|list|attach|create|update|modify|edit|write|patch|save)\b/i.test(preview);
  if (!planningAction) return false;

  const unresolvedMarker = /\b(sessionid|session id|empty string|null|again|different approach|tool list|available tools)\b/i.test(preview);
  const terminalMarker = /\b(completed|done|finished|succeeded|successfully|typed|opened|clicked|verified|updated|modified|edited|wrote|written|saved|patched|failed|error|could not|did not)\b/i.test(preview);
  return !terminalMarker && (unresolvedMarker || preview.length <= 220);
}

function looksLikeFailureResult(result: string): boolean {
  if (!result.trim()) return true;
  const preview = result.slice(0, 600);
  if (/^sub-agent produced no final response\.?$/i.test(preview.trim())) {
    return true;
  }
  if (looksLikeContainerLevelFailure(preview)) {
    return true;
  }
  if (looksLikeModelTemplateArtifact(result)) {
    return true;
  }
  if (/\b(no results|not found|unable to|failed to|error:|timed out|cancelled|incomplete|max.{0,20}iterations|sub_agent_max_iterations|could not complete|did not complete)\b/i.test(preview)) {
    return true;
  }

  if (/\b(i can(?:not|'t) access|i do not have access|i can(?:not|'t) retrieve|cannot retrieve the latest|cannot access real[- ]time|knowledge cutoff|my knowledge is based on the data i was trained on)\b/i.test(preview)) {
    return true;
  }

  if (/\b(need to start a session|no computer_session_start|not available in my tool list|available tools are only|missing tool|cannot complete because .*tool)\b/i.test(preview)) {
    return true;
  }

  return looksLikePlanningOnlyResult(preview);
}

function maybePreferWorkflowOutput(result: string, workflowOutput: string | null, toolNames: string[]): string {
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

function hasDeliverableArtifact(artifacts: Record<string, unknown>[]): boolean {
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

function formatArtifactEvidenceSnippets(artifacts: Record<string, unknown>[]): string[] {
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

function classifyInterruptedOutcome(params: {
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

function buildArtifactCompletionOutput(params: {
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
function stripHallucinatedToolTags(text: string): string {
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

function summarizeMailBody(text: string, maxLength = 220): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "No body preview available.";
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`;
}

export interface SubAgentRunOptions {
  agentName: string;
  task: string;
  /** Optional human-readable title for this delegation, set by the caller via
   * delegate_to_agent's `taskTitle` argument or by the discovery-fallback
   * rewriter. The runner uses it to detect "this task was routed via the
   * no-specialist-match fallback path", which short-circuits its own
   * discovery passes (Fix 4) — without this signal, every coordinator that
   * receives a fallback-routed task wastes 2 LLM rounds redoing the same
   * search_agents/search_workflows call the parent already failed on. */
  taskTitle?: string;
  context?: string;
  parentSessionId: string;
  workspacePath: string;
  /** Authenticated user that owns the parent turn — propagated so sub-agents
   * enforce the same per-user resource access (mail, credentials, compute). */
  userId?: string;
  allowedAgents?: string[];
  signal?: AbortSignal;
  approvalCallback?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  onProgress?: (event: SubAgentProgressEvent) => void;
  humanInLoopSteps?: string[];
  onComputerAction?: (action: { computerSessionId: string; actionType: string; [key: string]: unknown }) => void;
  onComputerScreenshot?: (screenshot: { computerSessionId: string; dataUrl: string; width: number; height: number; [key: string]: unknown }) => void;
  onComputerSessionState?: (sessionState: { computerSessionId: string; state: string; [key: string]: unknown }) => void;
  /** Override the agent's configured maxIterations for this invocation. 0 disables the cap. */
  maxIterationsOverride?: number;
  /** Override the agent's timeout for this invocation in ms. 0 disables the timeout. */
  turnTimeoutOverrideMs?: number;
  /** Shared orchestration state for nested delegated runs. Internal. */
  swarmState?: SwarmState;
  /** Optional live callback whenever nested swarm state changes. Internal. */
  onSwarmState?: (state: SwarmState) => void;
  /** Shared turn-local delegation counters for nested runs. Internal. */
  _turnAgentCounts?: Map<string, number>;
  /** Shared per-agent delegation repeat-cap overrides for nested runs. Internal. */
  _turnAgentRepeatLimitOverrides?: Record<string, number>;
  /** Shared total delegation budget override for nested runs. Internal. */
  _turnTotalDelegationLimitOverride?: number;
  /** Active reusable workflow execution stack for nested workflow/self-reentry guards. Internal. */
  _workflowExecutionStack?: string[];
  /** Inline config — bypasses config lookup (used by agent_factory for ephemeral agents) */
  inlineConfig?: import("../config/schema.js").SubAgentConfig;
  /**
   * E18: Soft deadline — when Date.now() >= softDeadlineMs the runner injects a
   * wrap-up nudge so the agent calls share_finding and produces a final answer
   * before the hard timeout fires. Set by coordinators to allocate a fraction
   * of their own budget to each delegated specialist.
   */
  softDeadlineMs?: number;
}

export interface SubAgentProgressEvent {
  agentName: string;
  kind: "started" | "thinking" | "tool_start" | "tool_done" | "completed";
  iteration: number;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: string;
  metadata?: Record<string, unknown>;
  summary?: string;
}

export interface SubAgentExecutionStats {
  agentName: string;
  sessionId: string;
  promptChars: number;
  userContentChars: number;
  toolCount: number;
  toolNames: string[];
  iterations: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  maxIterations: number;
  model: string;
  capabilities: string[];
  outcome?: SubAgentOutcome;
  terminalState?: "completed" | "max_iterations" | "timeout" | "cancelled" | "error" | "missing_config";
  containerColdStartMs?: number;
  containerBootstrapMs?: number;
  containerRuntimeMs?: number;
}

export interface SubAgentRunResult {
  output: string;
  stats: SubAgentExecutionStats;
  artifacts?: Record<string, unknown>[];
}

export async function runSubAgentWithStats(opts: SubAgentRunOptions): Promise<SubAgentRunResult> {
  return withSpan(
    `sub_agent ${opts.agentName}`,
    {
      "starlingai.agent.name": opts.agentName,
      "starlingai.session.parent": opts.parentSessionId,
      "starlingai.task.preview": opts.task.slice(0, 240),
    },
    async (span) => {
      const result = await runSubAgentWithStatsInner(opts);
      span.setAttribute("starlingai.agent.iterations", result.stats.iterations);
      span.setAttribute("starlingai.agent.toolCount", result.stats.toolCount);
      if (result.stats.terminalState) {
        span.setAttribute("starlingai.agent.terminalState", result.stats.terminalState);
      }
      span.setAttribute("starlingai.agent.tokens", result.stats.usage.totalTokens);
      return result;
    },
  );
}

async function runSubAgentWithStatsInner(opts: SubAgentRunOptions): Promise<SubAgentRunResult> {
  const config = getConfig();
  const agentCfg = opts.inlineConfig ?? config.subAgents[opts.agentName];
  const runStartedAt = Date.now();

  opts.onProgress?.({
    agentName: opts.agentName,
    kind: "started",
    iteration: 0,
    summary: `Started delegated work in ${opts.agentName}.`,
  });

  if (!agentCfg) {
    return {
      output: `Sub-agent '${opts.agentName}' is not defined in config.subAgents`,
      stats: {
        agentName: opts.agentName,
        sessionId: `sub:${opts.parentSessionId}:${opts.agentName}:missing`,
        promptChars: 0,
        userContentChars: opts.task.length + (opts.context?.length ?? 0),
        toolCount: 0,
        toolNames: [],
        iterations: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: DEFAULT_MAX_ITERATIONS,
        model: "",
        capabilities: [],
        outcome: "failure",
        terminalState: "missing_config",
      },
    };
  }

  // Coordinator agents (those with run_task_graph / parallel_delegate) orchestrate
  // nested sub-agents whose cumulative runtime can approach the full turn budget.
  // Give them a much higher default floor so adaptive timeouts based on *shorter*
  // prior runs don't prematurely abort in-flight task graphs.
  const COORDINATOR_TOOL_NAMES = ["run_task_graph", "parallel_delegate", "run_workflow"];
  const isCoordinatorAgent = agentCfg.tools?.some((t: string) => COORDINATOR_TOOL_NAMES.includes(t)) ?? false;
  const leafDefaultMs = config.agents.performance?.subAgentTurnSloMs ?? 60_000;
  const coordinatorDefaultMs = Math.round(config.gateway.turnTimeoutMs * 0.85);
  const defaultTimeoutMs = agentCfg.turnTimeoutMs ?? (isCoordinatorAgent ? coordinatorDefaultMs : leafDefaultMs);
  const adaptiveTimeout = opts.turnTimeoutOverrideMs === undefined && agentCfg.turnTimeoutMs === undefined
    ? computeAdaptiveSubAgentTimeoutMs(opts.agentName, opts.workspacePath, defaultTimeoutMs)
    : null;
  const resolvedTurnTimeoutMs = opts.turnTimeoutOverrideMs ?? agentCfg.turnTimeoutMs ?? adaptiveTimeout?.timeoutMs ?? defaultTimeoutMs;
  const turnTimeoutMs = resolvedTurnTimeoutMs && resolvedTurnTimeoutMs > 0 ? resolvedTurnTimeoutMs : undefined;
  const sanitizedTask = sanitizeSubAgentTask(agentCfg.tools, opts.task);
  const sourceSensitiveTask = buildDynamicTurnGuidance(sanitizedTask)?.sourceSensitive === true;
  // Fix 4: detect when this task was routed via the no-specialist-match
  // discovery fallback. The taskTitle marker is set by both the runtime-side
  // rewriter (after main-assistant search_agents returned no match) and the
  // sub-agent-side rewriter (after a sub-agent's own discovery returned no
  // match). When set, the swarm has already attempted discovery and found
  // nothing — running it again here would waste another LLM round on a
  // guaranteed-no-match call.
  const cameViaDiscoveryFallback = typeof opts.taskTitle === "string"
    && /fallback after agent discovery no-match/i.test(opts.taskTitle);
  // I13: Mutable so the cascade-timeout fallback can inject web_search +
  // web_fetch when all delegations have failed and a coordinator agent
  // would otherwise be left with no working capability.
  let effectiveToolNames = getEffectiveToolNames(opts.agentName, agentCfg.tools, sanitizedTask);
  if (cameViaDiscoveryFallback && effectiveToolNames) {
    const beforeCount = effectiveToolNames.length;
    const discoveryStripSet = new Set(["search_agents", "search_workflows", "list_agents"]);
    effectiveToolNames = effectiveToolNames.filter((name) => !discoveryStripSet.has(name));
    if (effectiveToolNames.length < beforeCount) {
      logAudit(
        "sub_agent_started",
        {
          agentName: opts.agentName,
          stage: "discovery_fallback_strip",
          strippedTools: ["search_agents", "search_workflows", "list_agents"]
            .filter((name) => !effectiveToolNames!.includes(name)),
          taskTitle: opts.taskTitle,
        },
        { sessionId: opts.parentSessionId, severity: "info" },
      );
    }
  }
  let turnTimeoutReached = false;
  const timeoutHandle = turnTimeoutMs
    ? setTimeout(() => { turnTimeoutReached = true; }, turnTimeoutMs)
    : undefined;
  // The wall-clock timeout is a stop-after-current-operation deadline, not
  // an abort signal for the provider/tool call currently in flight. External
  // cancellation still aborts immediately through opts.signal.
  const signal = opts.signal;

  const subSessionId = `sub:${opts.parentSessionId}:${opts.agentName}:${Date.now()}`;

  // Surface a live, take-over-able browser preview for the whole browser_agent
  // run (parity with the computer-use session preview). The session is stopped
  // in the finally below; request_human_assist flips it to "needs help" on a
  // CAPTCHA. Only when a browser-vnc backend is actually reachable.
  let browserSessionId: string | undefined;
  if (opts.agentName === "browser_agent" && browserSessionManager.isEnabled()) {
    try {
      browserSessionId = browserSessionManager.register({
        agentName: opts.agentName,
        parentSessionId: opts.parentSessionId,
        runSessionId: subSessionId,
      }).id;
    } catch (err) {
      log.warn({ err }, "Failed to register browser session for live preview");
    }
  }

  try {

    logAudit(
      "sub_agent_started",
      {
        agentName: opts.agentName,
        task: sanitizedTask.slice(0, 120),
        capabilities: agentCfg.capabilities,
        configuredTools: agentCfg.tools ?? [],
        effectiveTools: effectiveToolNames ?? [],
        tags: agentCfg.tags,
        ...(turnTimeoutMs ? { timeoutMs: turnTimeoutMs } : {}),
        ...(adaptiveTimeout ? {
          adaptiveTimeoutMs: adaptiveTimeout.timeoutMs,
          adaptiveTimeoutBaselineMs: adaptiveTimeout.baselineMs,
          adaptiveTimeoutSamples: adaptiveTimeout.sampleSize,
        } : {}),
      },
      { sessionId: subSessionId, userId: undefined, channel: `sub-agent:${opts.agentName}` }
    );

    // Merge defaults with per-agent overrides
    const modelConfig = { ...config.agents.defaults.model, ...(agentCfg.model ?? {}) };

    const providerEndpoint = resolveProviderEndpoint(modelConfig, config);

    // ── Dispatch to container runner if configured ───────────────────────────
    // An agent is containerized when EITHER:
    //   a) its own config has container.enabled: true  (explicit opt-in), OR
    //   b) agents.defaultContainerized is true globally AND container.disabled !== true
    //      (opt-out model)
    //
    // EXCEPTION: agents whose tool list contains orchestration/discovery tools
    // or gateway-bound service tools must run in-process.
    //
    // Orchestration/discovery tools (delegate_to_agent, swarm_delegate,
    // parallel_delegate, run_task_graph, run_workflow, search_agents,
    // search_workflows, list_agents) require access to the parent process's
    // tool registry and Docker socket.
    //
    // Mail/calendar/contacts tools call the headless mail-service via gateway
    // config and service discovery. Inside the generic agent-worker container
    // they do not inherit the gateway's runtime config and usually run with
    // `--network none`, which turns simple inbox checks into opaque container
    // failures before the deterministic mail fast path can run.
    const requiresHostRegistry = (agentCfg.tools ?? []).some((t: string) =>
      ORCHESTRATION_DISCOVERY_TOOL_NAMES.has(t),
    );
    const requiresGatewayServices = (agentCfg.tools ?? []).some((toolName: string) =>
      GATEWAY_BOUND_SERVICE_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix)),
    );
    const isContainerized =
      !requiresHostRegistry && !requiresGatewayServices && (
        agentCfg.container?.enabled === true ||
        (config.agents.defaultContainerized === true && agentCfg.container?.disabled !== true)
      );
    if (isContainerized) {
      const maxConcurrent = agentCfg.maxConcurrent ?? DEFAULT_CONCURRENCY;
      await acquireSlot(opts.agentName, maxConcurrent, opts.parentSessionId);
      let containerRun;
      try {
        const containerReason = agentCfg.container?.enabled ? "explicit" : "defaultContainerized";
        log.info({ agentName: opts.agentName, maxConcurrent, containerReason }, "Dispatching to containerized sub-agent");
        containerRun = await runSubAgentInContainer({ ...opts, signal }, agentCfg, modelConfig, providerEndpoint.baseUrl, providerEndpoint.apiKey);
      } finally {
        releaseSlot(opts.agentName);
      }
      // Detect container-level failures (spawn errors, non-zero exits, container
      // crashes, timeouts) that the runner reports as a failure-prefixed string
      // in containerRun.output rather than throwing. Without this, the metadata
      // would claim outcome=success while the visible output reads "container
      // error: unknown", and the rest of the orchestration pipeline (retry
      // cascade, score-keeping, audit telemetry) would treat the call as
      // successful and never fall back to a different agent.
      //
      // Also demote when the container's output is just LLM template special
      // tokens (e.g. `<|mask_end|>`) — Qwen variants under forced synthesis
      // sometimes emit a stray template token instead of real content, and
      // the runtime previously classified that 12-char garbage as success
      // (audit session cb90e56a, May 2026).
      const containerFailed = looksLikeContainerLevelFailure(containerRun.output)
        || looksLikeModelTemplateArtifact(containerRun.output);
      const stats: SubAgentExecutionStats = {
        agentName: opts.agentName,
        sessionId: subSessionId,
        promptChars: 0,
        userContentChars: opts.task.length + (opts.context?.length ?? 0),
        toolCount: 0,
        toolNames: [],
        iterations: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: agentCfg.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        model: modelConfig.primary ?? "",
        capabilities: agentCfg.capabilities ?? [],
        outcome: containerFailed ? "failure" : "success",
        terminalState: containerFailed ? "error" : "completed",
        containerColdStartMs: containerRun.metrics.containerColdStartMs,
        containerBootstrapMs: containerRun.metrics.containerBootstrapMs,
        containerRuntimeMs: containerRun.metrics.containerRuntimeMs,
      };
      logAudit(
        "sub_agent_completed",
        {
          agentName: opts.agentName,
          resultLength: containerRun.output.length,
          outcome: stats.outcome,
          terminalState: stats.terminalState,
          containerized: true,
          ...containerRun.metrics,
        },
        { sessionId: subSessionId },
      );
      return {
        output: containerRun.output,
        stats,
      };
    }

    const provider = createChatProvider(modelConfig, providerEndpoint);
    // E25: prefer the synthesis-tier provider for the three sub-agent
    // synthesis paths (timeout, pre-deadline soft, max-iterations) — same
    // rationale as runtime.ts:3127. Falls back to the primary `provider`
    // when no tier is configured. Resolved once per run so we don't pay
    // the lookup cost in every synthesis branch.
    const synthProvider = getChatProviderForTier("synthesis") ?? provider;

    // Build system prompt
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
    const flowGuidance = formatFlowMemoryGuidance(opts.workspacePath, sanitizedTask, {
      targetAgent: opts.agentName,
      limit: 3,
    });
    const memoryGuidance = await formatScopedMemoryGuidance(opts.workspacePath, sanitizedTask, {
      sessionId: opts.parentSessionId,
      targetAgent: opts.agentName,
      scopes: ["session", "workspace", "user", "agent"],
      limit: 4,
      maxChars: Math.min(1_400, Math.round((config.agents.performance?.promptBudgetChars ?? 32_000) * 0.06)),
    });
    // Procedural memory for specialists: surface relevant learned procedures for
    // this specific delegated task. Relevance-gated (empty when nothing matches)
    // and bounded, mirroring the flow/memory guidance above.
    const skillGuidance = config.skillLibrary.enabled
      ? await formatSkillGuidance(opts.workspacePath, sanitizedTask, {
          maxChars: Math.min(1_200, Math.round((config.agents.performance?.promptBudgetChars ?? 32_000) * 0.06)),
          // Agent-scoped: boost + surface procedures explicitly tagged for this
          // specialist so its own learned skills reliably reach it.
          agent: opts.agentName,
        })
      : "";
    const taskModeGuidance = buildTaskModeGuidance(opts.agentName, sanitizedTask);
    const modelExecutionGuidance = buildModelExecutionGuidance(modelConfig.primary, modelConfig.enableThinking);
    const toolInventoryGuidance = buildSubAgentToolInventory(effectiveToolNames);
    const agentDiscoveryGuidance = isOrchestrationCapableRun(effectiveToolNames)
      ? buildSubAgentAgentDiscoveryGuidance(opts.agentName, opts.allowedAgents)
      : "";
    // Fix 4: discovery-fallback notice. When this run was routed via the
    // no-specialist-match fallback, tell the model that discovery already
    // failed in the parent context, so it should skip search_agents /
    // search_workflows / list_agents (which we have also stripped from its
    // tool set) and proceed directly to delegation or its own work tools.
    const discoveryFallbackNotice = cameViaDiscoveryFallback
      ? "[DISCOVERY FALLBACK CONTEXT] This task was routed to you because the parent's "
        + "search_agents / search_workflows lookups returned no specialist match. "
        + "Discovery has already been attempted — do NOT call search_agents, search_workflows, "
        + "or list_agents (these tools are unavailable). Proceed directly with delegate_to_agent "
        + "(use autonomous routing by omitting agentName, or pick from the explicit fallback list "
        + "if one is offered) or with your own evidence-gathering tools (web_search, web_fetch, etc.)."
      : "";
    // E19 graceful-degradation ladder: short velocity-warning nudge injected
    // when the warden has flagged this session with an imminent storm/flood
    // alert. Tells the model to narrow scope and finish quickly instead of
    // fanning out further. Paired with a tool-list cap below.
    const isDegraded = isSessionDegraded(subSessionId);
    const degradedNudge = isDegraded
      ? "VELOCITY WARNING: Your session is approaching a tool-storm / messaging-flood threshold. "
        + "Narrow scope, batch tool calls, and finish quickly. Do not spawn further delegations "
        + "or parallel tool fan-out unless strictly required to complete the task."
      : "";
    const systemPrompt = agentCfg.systemPrompt
      ? `${agentCfg.systemPrompt}${modelExecutionGuidance ? `\n\n${modelExecutionGuidance}` : ""}${taskModeGuidance ? `\n\n${taskModeGuidance}` : ""}${toolInventoryGuidance ? `\n\n${toolInventoryGuidance}` : ""}${agentDiscoveryGuidance ? `\n\n${agentDiscoveryGuidance}` : ""}${discoveryFallbackNotice ? `\n\n${discoveryFallbackNotice}` : ""}${degradedNudge ? `\n\n${degradedNudge}` : ""}\n\nAgent name: ${opts.agentName}\nCurrent workspace: ${opts.workspacePath}\nToday's date: ${today}${flowGuidance ? `\n\n${flowGuidance}` : ""}${skillGuidance ? `\n\n${skillGuidance}` : ""}${memoryGuidance ? `\n\n${memoryGuidance}` : ""}`
      : `You are a specialized AI sub-agent named "${opts.agentName}". Complete the given task and return your result.${toolInventoryGuidance ? `\n\n${toolInventoryGuidance}` : ""}${agentDiscoveryGuidance ? `\n\n${agentDiscoveryGuidance}` : ""}${discoveryFallbackNotice ? `\n\n${discoveryFallbackNotice}` : ""}${degradedNudge ? `\n\n${degradedNudge}` : ""}\n\nAgent name: ${opts.agentName}\nCurrent workspace: ${opts.workspacePath}\nToday's date: ${today}${flowGuidance ? `\n\n${flowGuidance}` : ""}${skillGuidance ? `\n\n${skillGuidance}` : ""}${memoryGuidance ? `\n\n${memoryGuidance}` : ""}`;

    // Get available tools for this agent. E20: rerank by semantic
    // relevance to the current task so the model sees the most relevant
    // tools first — useful when the tool list is large and the model's
    // attention budget is finite.
    let tools = getToolsAsLLMDefs(effectiveToolNames);
    if (tools.length > 6) {
      try {
        tools = await rerankToolsForTask(tools, sanitizedTask);
      } catch (err) {
        log.debug({ err, agentName: opts.agentName }, "Tool rerank failed — using registration order");
      }
    }

    // E19 graceful-degradation ladder: if the warden flagged this session
    // with an imminent storm/flood alert, tighten the tool budget so the
    // model can't fan out further. Kept after rerank so the top-ranked tools
    // are the ones retained.
    if (isDegraded && tools.length > 6) {
      tools = tools.slice(0, 6);
      log.info(
        { agentName: opts.agentName, subSessionId, remainingTools: tools.length },
        "Sub-agent running in degraded mode — tool list capped",
      );
    }

    const toolContext: ToolContext = {
      sessionId: subSessionId,
      workspacePath: opts.workspacePath,
      userId: opts.userId,
      currentAgentName: opts.agentName,
      allowedAgents: opts.allowedAgents,
      allowedTools: effectiveToolNames,
      approvalCallback: opts.approvalCallback,
      humanInLoopSteps: opts.humanInLoopSteps,
      onComputerAction: opts.onComputerAction,
      onComputerScreenshot: opts.onComputerScreenshot,
      onComputerSessionState: opts.onComputerSessionState,
      swarmState: opts.swarmState,
      onSwarmState: opts.onSwarmState,
      _turnAgentCounts: opts._turnAgentCounts,
      _turnAgentRepeatLimitOverrides: opts._turnAgentRepeatLimitOverrides,
      _turnTotalDelegationLimitOverride: opts._turnTotalDelegationLimitOverride,
      _workflowExecutionStack: opts._workflowExecutionStack,
      signal,
    };

    // ── A2A: drain any pending messages addressed to this agent ────────────────
    // Agents can send messages to peers via send_agent_message. Those messages
    // are queued in swarm/memory.ts and delivered here at the start of the next
    // run — giving the agent a chance to act on them without the orchestrator
    // mediating the content.
    let a2aContext = "";
    try {
      const pending = await consumeAgentMessages(subSessionId, opts.agentName);
      if (pending.length > 0) {
        a2aContext = `\n\n## Pending messages from peer agents\n${pending
          .map((m) => {
            // Sanitize message content to prevent prompt injection from peer agents
            const safeContent = sanitizeTranscriptContent("user", m.content, false);
            return `From ${m.fromAgent} [${m.ts}]: ${safeContent}`;
          })
          .join("\n---\n")}`;
        logAudit("a2a_messages_delivered", {
          agentName: opts.agentName,
          count: pending.length,
          fromAgents: [...new Set(pending.map((m) => m.fromAgent))],
        }, { sessionId: subSessionId, severity: "info", channel: "swarm" });
      }
    } catch (err) {
      log.debug({ err, agentName: opts.agentName }, "Failed to consume A2A messages — swarm bus or Redis may be unavailable");
    }

    const initialSharedFacts = await formatSharedFactsContext(subSessionId);
    let lastSharedFactsSignature = initialSharedFacts.signature;
    const sharedFactsContext = initialSharedFacts.content
      ? `\n\n${initialSharedFacts.content}`
      : "";

    // Build initial message
    const userContent = opts.context
      ? `Context:\n${opts.context}${a2aContext}${sharedFactsContext}\n\nTask: ${sanitizedTask}`
      : `${sanitizedTask}${a2aContext}${sharedFactsContext}`;

    const history: LLMMessage[] = [{ role: "user", content: userContent }];

    const maxIterations = opts.maxIterationsOverride === 0
      ? Number.MAX_SAFE_INTEGER
      : (opts.maxIterationsOverride ?? agentCfg.maxIterations ?? DEFAULT_MAX_ITERATIONS);
    let iterations = 0;
    let toolCount = 0;
    let successfulToolCount = 0;
    // I11: Pre-emptive soft-deadline synthesis tracking. We fire the
    // soft-deadline synthesis at most once per sub-agent run.
    let softDeadlineSynthesisAttempted = false;
    // Long-running generation thresholds. Each `continue` grant from the
    // operator bumps these up so the next prompt fires only after the
    // newly-granted budget is also spent.
    let lrgWallThresholdMs = DEFAULT_SOFT_THRESHOLD_MS;
    let lrgTokenThreshold = DEFAULT_SOFT_THRESHOLD_TOKENS;
    // When the operator explicitly set --timeout N (any non-zero value via
    // turnTimeoutOverrideMs), they have already declared a budget for this
    // turn. Suppress the pause-and-ask handoff entirely so we don't pester
    // them halfway through a run they pre-authorized. Their own timeout
    // catches the run when it actually expires.
    const operatorPreAuthorizedBudget =
      opts.turnTimeoutOverrideMs !== undefined && opts.turnTimeoutOverrideMs > DEFAULT_SOFT_THRESHOLD_MS;
    // When the operator answers "stop", we set this so the next loop
    // iteration goes straight to attemptTimeoutSynthesis instead of
    // making another LLM call.
    let lrgOperatorStop = false;
    const artifacts: Record<string, unknown>[] = [];
    const artifactKeys = new Set<string>();
    const toolNames: string[] = [];
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    // Track last tool call signature per tool name for consecutive-duplicate detection
    const lastToolCallSig = new Map<string, { args: string; result: string; success: boolean }>();
    // Broader (name, args) cache for IDEMPOTENT_TOOLS — catches A→B→A loops the
    // consecutive map misses (the second A overwrites the first A's slot, so
    // the third A sees no `prev` match). Bounded only by per-tool caps and the
    // sub-agent run lifetime; both are tight, so an explicit size cap is unnecessary.
    const idempotentCallCache = new Map<string, { result: string; success: boolean; callCount: number }>();
    // Per-tool call counters — prevents a single tool from dominating iteration budget
    const perToolCallCount = new Map<string, number>();
    // Per-(tool, path) counters for path-keyed write tools. A real loop
    // rewrites the same path; a legitimate multi-file project hits distinct
    // paths. Counting per-path lets us catch the loop without blocking a
    // 4-file website build at file 3.
    const perWritePathCount = new Map<string, number>();
    let workflowPassthroughOutput: string | null = null;
    // Observability: per-tool byte totals for context-budget runaway detection
    const bytesByTool = new Map<string, number>();
    // E21: Source-diversity — detect when research plateaus on repeated domains
    const visitedSourceDomains = new Set<string>();
    let consecutiveStaleDomainFetches = 0;
    // E18: Soft-deadline nudge — fire once when softDeadlineMs is reached
    let softDeadlineInjected = false;
    // E19 wave 2 follow-up: mid-turn graceful-degradation enforcement.
    //   Turn-start `isDegraded` (above) only catches sessions already flagged
    //   when the sub-agent boots. If the warden raises tool_storm_imminent /
    //   agent_message_flood_imminent *while* the loop is mid-flight, the
    //   in-progress iteration would otherwise continue with the full tool
    //   list and no velocity nudge. We re-check per iteration and apply the
    //   same nudge + tool cap once, logging a single transition event.
    let degradedMidTurnApplied = isDegraded;
    // Phase A5: nudge agents to call share_finding after collecting substantive evidence
    let substantiveEvidenceCount = 0;
    let shareFindinCalledThisRun = false;
    // Phase B8: stop heuristic — count share_finding calls to detect "enough evidence collected"
    let shareFindinCallCount = 0;
    // I13: In-loop sufficiency / cascade-failure guard.
    //   • cumulativeTimeoutSignalCount counts "timed out after Nms" markers
    //     observed in delegation tool results across the whole run. When
    //     this hits ≥2, we strip delegation tools and force the agent to
    //     write an honest final answer from whatever fragments exist
    //     instead of dispatching yet another doomed parallel_delegate.
    //   • cumulativeUsefulEvidenceBytes accumulates non-boilerplate bytes
    //     from successful tool results. Once it crosses the sufficiency
    //     threshold, we inject a one-shot nudge telling the agent it has
    //     enough material — answer now unless one specific fact is still
    //     missing. Both flags fire at most once per run.
    let cumulativeTimeoutSignalCount = 0;
    let cumulativeUsefulEvidenceBytes = 0;
    let recentEvidenceSnippets: string[] = [];
    let autoSharedFindingCount = 0;
    const autoSharedFindingKeys = new Set<string>();
    let cascadeSynthesisForced = false;
    let sufficiencySynthesisNudged = false;
    let sufficiencyToolsStripped = false;
    let consecutiveBlockedToolIterations = 0;
    const BLOCKED_TOOL_ITERATION_THRESHOLD = 2;
    const approvalBlockedTools = new Map<string, string>();
    let requiredResearchFallbackRoute: SubAgentRequiredResearchFallbackRoute | null = null;
    // Track tools stripped by the evidence-cap mechanism so that blocked
    // calls to those tools are classified as "evidence_cap_enforced" rather
    // than "not_in_agent_tools", preventing false-positive warden alerts.
    const evidenceCapStrippedTools = new Set<string>();
    // G32: task-class fingerprint for outcome-weighted routing (written into every appendOutcome call)
    const taskKeywords = extractTaskKeywords(sanitizedTask);

    /** G32: Thin wrapper that auto-injects taskKeywords + sharedFindingsCount.
     *  Also closes the graph-memory retrieval feedback loop on success/partial
     *  outcomes so retrieved memories that led to a real deliverable get
     *  credited (wasUseful=true + importance boost). */
    const recordOutcome = (
      fields: Parameters<typeof appendOutcome>[1],
    ): void => {
      appendOutcome(opts.workspacePath, {
        ...fields,
        taskKeywords,
        sharedFindingsCount: shareFindinCallCount,
      });
      if (fields.outcome === "success" || fields.outcome === "partial") {
        // Partial outcomes credit less than full success — still positive,
        // because some of the retrieved memories *did* contribute.
        const boost = fields.outcome === "success" ? 0.05 : 0.02;
        graphMarkSessionRetrievalsUseful(subSessionId, { boost }).catch(() => {});
      } else if (fields.outcome === "failure") {
        // Negative signal: the turn terminated in failure with retrieved
        // memories still pending. Mark them wasUseful=false and nudge
        // importance downward — a stronger signal than slow decay because
        // we know the memories were present and still didn't help.
        graphMarkSessionRetrievalsUnhelpful(subSessionId, { penalty: 0.03 }).catch(() => {});
      }
    };

    const buildStats = (
      terminalState: SubAgentExecutionStats["terminalState"] = "completed",
      outcome: SubAgentOutcome = terminalState === "completed" ? "success" : "failure",
    ): SubAgentExecutionStats => ({
      agentName: opts.agentName,
      sessionId: subSessionId,
      promptChars: systemPrompt.length,
      userContentChars: userContent.length,
      toolCount,
      toolNames: [...toolNames],
      iterations,
      usage: { ...usage },
      maxIterations,
      model: modelConfig.primary,
      capabilities: agentCfg.capabilities ?? [],
      outcome,
      terminalState,
    });

    const withArtifacts = (result: { output: string; stats: SubAgentExecutionStats }): SubAgentRunResult => (
      artifacts.length > 0
        ? { ...result, artifacts: artifacts.map((artifact) => ({ ...artifact })) }
        : result
    );

    const logSubAgentCompletionAudit = (
      stats: SubAgentExecutionStats,
      output: string,
      extra: Record<string, unknown> = {},
      severity: "info" | "warn" | "error" = "info",
    ): void => {
      logAudit(
        "sub_agent_completed",
        {
          agentName: opts.agentName,
          iterations: stats.iterations,
          resultLength: output.length,
          promptChars: stats.promptChars,
          userContentChars: stats.userContentChars,
          toolCount: stats.toolCount,
          usage: stats.usage,
          model: stats.model,
          durationMs: Date.now() - runStartedAt,
          outcome: stats.outcome,
          terminalState: stats.terminalState,
          bytesByTool: Object.fromEntries(bytesByTool),
          ...extra,
        },
        { sessionId: subSessionId, severity },
      );
    };

    /** Single-delegation passthrough — see PASSTHROUGH_DELEGATION_MIN_BYTES.
     * If this agent's only substantive tool work was one large delegation,
     * return that delegation's body as the agent's own result instead of
     * running another LLM synthesis pass on top of an answer that is already
     * the answer. Returns null when the condition does not apply. */
    const tryReturnSingleDelegationPassthrough = (
      reasonTag: string,
    ): SubAgentRunResult | null => {
      if (signal?.aborted) return null;
      const candidate = tryExtractSingleDelegationPassthrough({
        history,
        bytesByTool,
        toolNames: [...toolNames],
      });
      if (!candidate) return null;

      const result = candidate.output;
      const stats = buildStats("completed", candidate.inferredOutcome);

      recordOutcome({
        ts: new Date().toISOString(),
        agent: opts.agentName,
        task: opts.task.slice(0, 200),
        outcome: candidate.inferredOutcome,
        iterations,
        totalTokens: usage.totalTokens,
        durationMs: Date.now() - runStartedAt,
        timeoutMs: turnTimeoutMs,
      });
      logAudit(
        "sub_agent_synthesis_forced",
        {
          agentName: opts.agentName,
          reason: "single_delegation_passthrough",
          passthroughTrigger: reasonTag,
          delegationToolName: candidate.delegationToolName,
          delegationBytes: candidate.bytes,
          inferredOutcome: candidate.inferredOutcome,
          iterations,
        },
        { sessionId: subSessionId, severity: "info" },
      );
      logSubAgentCompletionAudit(
        stats,
        result,
        {
          singleDelegationPassthrough: true,
          passthroughTrigger: reasonTag,
          delegationToolName: candidate.delegationToolName,
          delegationBytes: candidate.bytes,
        },
        candidate.inferredOutcome === "failure" ? "warn" : "info",
      );
      log.info(
        {
          agentName: opts.agentName,
          delegationToolName: candidate.delegationToolName,
          delegationBytes: candidate.bytes,
          reasonTag,
          inferredOutcome: candidate.inferredOutcome,
        },
        "Single-delegation passthrough — returning delegated body verbatim",
      );
      opts.onProgress?.({
        agentName: opts.agentName,
        kind: "completed",
        iteration: iterations,
        summary: `Returned single-delegation result directly from ${opts.agentName}.`,
      });
      return withArtifacts({ output: result, stats });
    };

    /** Closure shorthand for buildInterruptedSubAgentOutput callers in the
     * run function — pre-fills `primaryDelegationBody` from history so the
     * full delegated specialist's body is surfaced verbatim instead of being
     * lost behind 900-char snippets. Returns null when no substantial body
     * was collected, which lets callers preserve their existing snippet flow. */
    const currentPrimaryDelegationBody = (): { content: string; bytes: number } | null =>
      extractMostRecentSubstantialDelegationBody(history);

    const rescueSanitizedEmptyResult = async (rawResult: string): Promise<string> => {
      const visibleResult = stripHallucinatedToolTags(rawResult);
      if (visibleResult || toolCount === 0 || signal?.aborted) {
        return visibleResult || rawResult;
      }

      try {
        log.warn(
          { agentName: opts.agentName, iterations, toolCalls: toolCount },
          "Sub-agent final output became empty after stripping hallucinated tool markup — forcing synthesis rescue",
        );
        const rescueMessages: LLMMessage[] = [
          {
            role: "system",
            content: systemPrompt +
              "\n\nYour previous final answer contained only invalid tool-call markup and became empty after sanitization. " +
              "DO NOT call any more tools. Produce your COMPLETE final answer now from the evidence already gathered in the conversation. " +
              "Include the key facts, URLs, and extracts you retrieved.",
          },
          ...history,
        ];
        const rescueResponse = await provider.complete(rescueMessages, [], signal);
        usage.promptTokens += rescueResponse.usage.promptTokens;
        usage.completionTokens += rescueResponse.usage.completionTokens;
        usage.totalTokens += rescueResponse.usage.totalTokens;

        if (rescueResponse.tool_calls.length === 0) {
          const rescued = stripHallucinatedToolTags(normalizeSubAgentOutput(rescueResponse.content));
          if (rescued) {
            log.info(
              { agentName: opts.agentName, rescuedLength: rescued.length },
              "Sanitized-empty output rescue succeeded",
            );
            return rescued;
          }
        }
      } catch (rescueErr) {
        log.warn({ rescueErr, agentName: opts.agentName }, "Sanitized-empty output rescue failed");
      }

      return "Sub-agent produced no final response.";
    };

    const recoverNoResponseAfterSubstantiveWork = (rawResult: string): { result: string; forcedOutcome: SubAgentOutcome | null } => {
      const noFinalResponse = rawResult === "Sub-agent produced no final response.";
      const planningOnlyResponse = looksLikePlanningOnlyResult(rawResult);
      if (!noFinalResponse && !planningOnlyResponse) {
        return { result: rawResult, forcedOutcome: null };
      }

      const interruptedOutcome = classifyInterruptedOutcome({
        successfulToolCount,
        artifacts,
        swarmState: opts.swarmState,
      });
      if (interruptedOutcome !== "partial") {
        return { result: rawResult, forcedOutcome: null };
      }

      const recovered = buildInterruptedSubAgentOutput({
        agentName: opts.agentName,
        reason: noFinalResponse
          ? "produced no final response after substantive work."
          : "returned an in-progress planning note after substantive work.",
        swarmState: opts.swarmState,
        toolNames,
        toolCount,
        iterations,
        artifacts,
        evidenceSnippets: resolveInterruptedEvidenceSnippets({ recentEvidenceSnippets, history }),
        primaryDelegationBody: extractMostRecentSubstantialDelegationBody(history),
      });
      log.warn(
        { agentName: opts.agentName, toolCount, successfulToolCount, iterations, planningOnlyResponse },
        "Sub-agent completed substantive work but produced no usable final narrative — returning partial progress summary",
      );
      return { result: recovered, forcedOutcome: "partial" };
    };

    const recoverHallucinatedTruncationAfterSubstantiveWork = (rawResult: string): { result: string; forcedOutcome: SubAgentOutcome | null } => {
      if (!looksLikeHallucinatedTruncationClaim(rawResult)) {
        return { result: rawResult, forcedOutcome: null };
      }

      const usableBufferedSnippets = resolveInterruptedEvidenceSnippets({
        recentEvidenceSnippets,
        history,
        maxSnippets: 6,
      }).filter((snippet) => !looksLikeHallucinatedTruncationClaim(snippet));
      const usableHistorySnippets = usableBufferedSnippets.length > 0
        ? usableBufferedSnippets
        : resolveInterruptedEvidenceSnippets({ history, maxSnippets: 6 })
            .filter((snippet) => !looksLikeHallucinatedTruncationClaim(snippet));

      if (usableHistorySnippets.length === 0) {
        return { result: rawResult, forcedOutcome: null };
      }

      const recovered = buildInterruptedSubAgentOutput({
        agentName: opts.agentName,
        reason: "produced an incomplete synthesis after substantive work.",
        swarmState: toolContext.swarmState,
        toolNames,
        toolCount,
        iterations,
        artifacts,
        evidenceSnippets: usableHistorySnippets,
        primaryDelegationBody: extractMostRecentSubstantialDelegationBody(history),
      });
      log.warn(
        { agentName: opts.agentName, resultLength: rawResult.length, recoveredSnippets: usableHistorySnippets.length },
        "Sub-agent claimed collected evidence was truncated — returning recovered tool evidence instead",
      );
      return { result: recovered, forcedOutcome: "partial" };
    };

    const attemptTimeoutSynthesis = async (): Promise<SubAgentRunResult | null> => {
      if (!turnTimeoutMs || toolCount === 0 || !history.some((message) => message.role === "tool") || opts.signal?.aborted) {
        return null;
      }

      // Single-delegation passthrough first. If the only substantive work was
      // one substantial delegation, the synthesis pass is wasted effort — the
      // delegated specialist's body IS the answer. Returning it directly
      // avoids burning the grace window on a synthesis that often produces a
      // truncated head of the same content anyway.
      const passthrough = tryReturnSingleDelegationPassthrough("timeout_synthesis");
      if (passthrough) return passthrough;

      // The grace window has to fit at least one full LLM inference on the
      // slowest provider the runtime is actually used with. The previous
      // 5s cap was tuned for cloud APIs; on a local 35B model where each
      // completion takes 25–60s, the synthesis was aborted before it
      // could produce a single token and the run died with only the
      // interrupted-output scaffold. Scale to 15% of the turn budget,
      // capped at 25s so an 8-minute coordinator does not get an
      // unboundedly large deadline-grace either.
      const graceTimeoutMs = Math.max(5_000, Math.min(25_000, Math.round(turnTimeoutMs * 0.15)));
      const graceAbort = new AbortController();
      const graceTimer = setTimeout(() => graceAbort.abort(), graceTimeoutMs);
      const graceSignal = opts.signal
        ? AbortSignal.any([opts.signal, graceAbort.signal])
        : graceAbort.signal;

      try {
        const synthMessages: LLMMessage[] = [
          {
            role: "system",
            content: systemPrompt +
              "\n\nYour execution time budget has expired. DO NOT call any more tools. " +
              "Produce your COMPLETE final answer immediately from the tool results already in the conversation. " +
              "Include the key facts, URLs, and evidence you already retrieved. " +
              "Do NOT mention the timeout unless the prior evidence itself requires it.",
          },
          ...history,
        ];
        const synthResponse = await synthProvider.complete(synthMessages, [], graceSignal);
        usage.promptTokens += synthResponse.usage.promptTokens;
        usage.completionTokens += synthResponse.usage.completionTokens;
        usage.totalTokens += synthResponse.usage.totalTokens;

        if (synthResponse.tool_calls.length > 0) {
          return null;
        }

        let result = normalizeSubAgentOutput(synthResponse.content);
        if (result === "Sub-agent produced no final response.") {
          return null;
        }
        if (looksLikeProviderErrorEcho(result)) {
          log.warn(
            { agentName: opts.agentName, preview: result.slice(0, 200) },
            "Grace-deadline synthesis returned a regurgitated provider error — falling through to interrupted-output recovery",
          );
          return null;
        }
        result = await rescueSanitizedEmptyResult(result);
        const recovered = recoverNoResponseAfterSubstantiveWork(result);
        result = recovered.result;
        result = maybePreferWorkflowOutput(result, workflowPassthroughOutput, toolNames);
        const truncationRecovered = recoverHallucinatedTruncationAfterSubstantiveWork(result);
        result = truncationRecovered.result;
        if (result === "Sub-agent produced no final response.") {
          return null;
        }

        const outputScan = scanOutput(result);
        if (!outputScan.safe && outputScan.redacted) {
          logAudit(
            "output_redacted",
            { agentName: opts.agentName, types: outputScan.detectedTypes },
            { sessionId: subSessionId, severity: "warn" }
          );
          result = outputScan.redacted;
        }

        const semanticOutcome: SubAgentOutcome = recovered.forcedOutcome
          ?? truncationRecovered.forcedOutcome
          ?? (/no results|not found|unable to|failed to|error:/i.test(result.slice(0, 300))
            ? "partial"
            : "success");
        const stats = buildStats("completed", semanticOutcome);
        const suspicious = rejectSuspiciousNoToolOutput(
          opts,
          stats,
          result,
          turnTimeoutMs,
          runStartedAt,
        );
        if (suspicious) {
          return suspicious;
        }

        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: semanticOutcome,
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
        });
        logSubAgentCompletionAudit(
          stats,
          result,
          { synthesizedAfterTimeout: true, timeoutMs: turnTimeoutMs, timeoutGraceMs: graceTimeoutMs },
          semanticOutcome === "success" ? "info" : "warn",
        );
        opts.onProgress?.({
          agentName: opts.agentName,
          kind: "completed",
          iteration: iterations,
          summary: `Completed delegated work in ${opts.agentName} after timeout-aware synthesis.`,
        });
        return withArtifacts({ output: result, stats });
      } catch (synthErr) {
        log.warn({ synthErr, agentName: opts.agentName }, "Timeout synthesis failed");
        return null;
      } finally {
        clearTimeout(graceTimer);
      }
    };

    // I11: Pre-emptive (soft-deadline) synthesis. Same shape as
    // `attemptTimeoutSynthesis` but runs BEFORE the hard deadline with a
    // real budget so the model has a full inference window to convert its
    // accumulated tool results into a useful answer. Without this, leaf
    // agents on slow local models routinely die with web_search hits and
    // page snapshots in conversation history but no final synthesis,
    // and the coordinator above sees only "Sub-agent timed out" with
    // none of the actually-collected data.
    const attemptPreDeadlineSynthesis = async (budgetMs: number): Promise<SubAgentRunResult | null> => {
      if (toolCount === 0 || !history.some((message) => message.role === "tool") || opts.signal?.aborted) {
        return null;
      }

      // Single-delegation passthrough — the soft-deadline synthesis would just
      // re-wrap one already-final delegation result. Skip the LLM call when
      // we can return the body directly.
      const passthrough = tryReturnSingleDelegationPassthrough("soft_deadline_synthesis");
      if (passthrough) return passthrough;

      const synthAbort = new AbortController();
      const synthTimer = setTimeout(() => synthAbort.abort(), budgetMs);
      const synthSignal = opts.signal
        ? AbortSignal.any([opts.signal, synthAbort.signal])
        : synthAbort.signal;

      try {
        const synthMessages: LLMMessage[] = [
          {
            role: "system",
            content: systemPrompt +
              "\n\n[SOFT DEADLINE REACHED — SYNTHESIZE NOW]\n" +
              "You have used most of your execution budget. Stop calling tools. " +
              "Produce your COMPLETE final answer immediately from the tool results already in the conversation history above. " +
              "Include EVERY headline, fact, URL, name, number, source attribution, and snippet you already retrieved — across ALL sources, not just the first one. " +
              "If the evidence covers multiple sources (e.g. several news outlets), your answer MUST visibly cover all of them. " +
              "If your synthesis would exceed roughly 3000 characters, also include the full content verbatim — do not abbreviate, do not collapse list items, do not write '(truncated)'. " +
              "If you genuinely have no usable evidence, say so plainly and list what you tried. " +
              "Do NOT mention the soft deadline. Do NOT call any tools. Write the answer the user actually asked for.",
          },
          ...history,
        ];
        const synthResponse = await synthProvider.complete(synthMessages, [], synthSignal);
        usage.promptTokens += synthResponse.usage.promptTokens;
        usage.completionTokens += synthResponse.usage.completionTokens;
        usage.totalTokens += synthResponse.usage.totalTokens;

        // If the model still tried to call tools despite the explicit "no
        // tools" instruction, fall through and let the iteration loop
        // either succeed normally or hit the hard timeout.
        if (synthResponse.tool_calls.length > 0) {
          return null;
        }

        let result = normalizeSubAgentOutput(synthResponse.content);
        if (result === "Sub-agent produced no final response.") {
          return null;
        }
        if (looksLikeProviderErrorEcho(result)) {
          log.warn(
            { agentName: opts.agentName, preview: result.slice(0, 200) },
            "Soft-deadline synthesis returned a regurgitated provider error — falling through to interrupted-output recovery",
          );
          return null;
        }
        result = await rescueSanitizedEmptyResult(result);
        const recovered = recoverNoResponseAfterSubstantiveWork(result);
        result = recovered.result;
        result = maybePreferWorkflowOutput(result, workflowPassthroughOutput, toolNames);
        if (result === "Sub-agent produced no final response.") {
          return null;
        }

        const outputScan = scanOutput(result);
        if (!outputScan.safe && outputScan.redacted) {
          logAudit(
            "output_redacted",
            { agentName: opts.agentName, types: outputScan.detectedTypes },
            { sessionId: subSessionId, severity: "warn" }
          );
          result = outputScan.redacted;
        }

        const semanticOutcome: SubAgentOutcome = recovered.forcedOutcome
          ?? (/no results|not found|unable to|failed to|error:/i.test(result.slice(0, 300))
            ? "partial"
            : "success");
        const stats = buildStats("completed", semanticOutcome);
        const suspicious = rejectSuspiciousNoToolOutput(
          opts,
          stats,
          result,
          turnTimeoutMs,
          runStartedAt,
        );
        if (suspicious) {
          return suspicious;
        }

        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: semanticOutcome,
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
        });
        logSubAgentCompletionAudit(
          stats,
          result,
          { synthesizedAtSoftDeadline: true, softDeadlineBudgetMs: budgetMs, timeoutMs: turnTimeoutMs },
          semanticOutcome === "success" ? "info" : "warn",
        );
        opts.onProgress?.({
          agentName: opts.agentName,
          kind: "completed",
          iteration: iterations,
          summary: `Completed delegated work in ${opts.agentName} via pre-deadline synthesis.`,
        });
        return withArtifacts({ output: result, stats });
      } catch (synthErr) {
        log.warn({ synthErr, agentName: opts.agentName }, "Pre-deadline synthesis failed");
        return null;
      } finally {
        clearTimeout(synthTimer);
      }
    };

    const emitSubAgentToolAudit = (params: Parameters<typeof buildSubAgentToolAuditPayload>[0]): void => {
      const payload = buildSubAgentToolAuditPayload(params);
      const isWarn = params.phase === "done" && (payload["success"] === false || typeof payload["skippedReason"] === "string");
      logAudit("sub_agent_tool_call", payload, { sessionId: subSessionId, severity: isWarn ? "warn" : "info" });
    };

    const recordArtifacts = (metadata: unknown, defaults: Record<string, unknown> = {}): void => {
      if (!metadata) {
        return;
      }

      if (Array.isArray(metadata)) {
        for (const entry of metadata) {
          recordArtifacts(entry, defaults);
        }
        return;
      }

      if (typeof metadata !== "object") {
        return;
      }

      const value = metadata as Record<string, unknown>;
      const outputPath = typeof value["outputPath"] === "string" ? value["outputPath"] : "";
      const dataUrl = typeof value["dataUrl"] === "string" ? value["dataUrl"] : "";
      const externalUrl = typeof value["externalUrl"] === "string" ? value["externalUrl"] : "";
      if (outputPath || dataUrl || externalUrl) {
        const artifact = { ...defaults, ...value };
        const key = [
          typeof artifact["outputPath"] === "string" ? artifact["outputPath"] : "",
          typeof artifact["dataUrl"] === "string" ? artifact["dataUrl"] : "",
          typeof artifact["externalUrl"] === "string" ? artifact["externalUrl"] : "",
          typeof artifact["filename"] === "string" ? artifact["filename"] : "",
          typeof artifact["sourceTool"] === "string" ? artifact["sourceTool"] : "",
        ].join("::");
        if (!artifactKeys.has(key)) {
          artifactKeys.add(key);
          artifacts.push(artifact);
        }
      }

      const nestedArtifacts = value["artifacts"];
      if (Array.isArray(nestedArtifacts)) {
        for (const nestedArtifact of nestedArtifacts) {
          recordArtifacts(nestedArtifact, defaults);
        }
      }
    };

    if (opts.agentName === "mail_agent" && isExplicitUnreadMailInboxTask(sanitizedTask)) {
      const executeTrackedMailTool = async (toolName: string, args: Record<string, unknown>): Promise<import("../tools/registry.js").ToolResult> => {
        toolCount += 1;
        toolNames.push(toolName);
        emitSubAgentToolAudit({
          agentName: opts.agentName,
          tool: toolName,
          phase: "start",
          args,
          deterministic: true,
        });
        const result = await executeTool(toolName, args, toolContext);
        emitSubAgentToolAudit({
          agentName: opts.agentName,
          tool: toolName,
          phase: "done",
          args,
          deterministic: true,
          result,
        });
        return result;
      };

      const accountsResult = await executeTrackedMailTool("mail_list_accounts", {});
      if (!accountsResult.success) {
        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: "failure",
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
          error: accountsResult.error ?? "mail_list_accounts failed",
        });
        const output = `Sub-agent error: ${accountsResult.error ?? "mail_list_accounts failed"}`;
        const stats = buildStats("error");
        logSubAgentCompletionAudit(stats, output, {
          deterministicMailCheck: true,
          error: accountsResult.error ?? "mail_list_accounts failed",
        }, "warn");
        return {
          output,
          stats,
        };
      }

      const accounts = Array.isArray(accountsResult.metadata?.["accounts"])
        ? accountsResult.metadata["accounts"] as Array<Record<string, unknown>>
        : [];
      const accountIds = accounts
        .map((account) => String(account["id"] ?? "").trim())
        .filter((accountId) => accountId.length > 0);

      if (accountIds.length === 0) {
        const result = "No mail accounts are configured.";
        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: "success",
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
        });
        const stats = buildStats("completed");
        logSubAgentCompletionAudit(stats, result, { deterministicMailCheck: true });
        return withArtifacts({ output: result, stats });
      }

      const unreadResult = await executeTrackedMailTool("mail_list_unread", { accountIds, limit: 5 });
      if (!unreadResult.success) {
        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: "failure",
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
          error: unreadResult.error ?? "mail_list_unread failed",
        });
        const output = `Sub-agent error: ${unreadResult.error ?? "mail_list_unread failed"}`;
        const stats = buildStats("error");
        logSubAgentCompletionAudit(stats, output, {
          deterministicMailCheck: true,
          error: unreadResult.error ?? "mail_list_unread failed",
        }, "warn");
        return {
          output,
          stats,
        };
      }

      const unreadMessages = Array.isArray(unreadResult.metadata?.["messages"])
        ? unreadResult.metadata["messages"] as Array<Record<string, unknown>>
        : [];

      let result: string;
      if (unreadMessages.length === 0) {
        result = `No unread messages found across configured accounts (${accountIds.join(", ")}).`;
      } else {
        const detailedSummaries: string[] = [];
        for (const message of unreadMessages.slice(0, 3)) {
          const accountId = String(message["accountId"] ?? "").trim();
          const mailbox = String(message["mailbox"] ?? "").trim();
          const uid = Number(message["uid"] ?? 0);
          const subject = String(message["subject"] ?? "(no subject)");
          const from = String(message["from"] ?? "unknown sender");
          const date = String(message["date"] ?? "unknown date");

          let preview = "No body preview available.";
          if (accountId && mailbox && Number.isFinite(uid) && uid > 0) {
            const readResult = await executeTrackedMailTool("mail_read", { accountId, mailbox, uid });
            if (readResult.success) {
              const fullMessage = (readResult.metadata?.["message"] as Record<string, unknown> | undefined) ?? message;
              preview = summarizeMailBody(String(fullMessage["textBody"] ?? ""));
            }
          }

          detailedSummaries.push(`- [${accountId}] ${mailbox}#${uid} | ${subject} | from ${from} | ${date} | ${preview}`);
        }

        const accountList = accounts
          .map((account) => {
            const id = String(account["id"] ?? "").trim();
            const address = String(account["address"] ?? "").trim();
            return address ? `${id} <${address}>` : id;
          })
          .filter(Boolean)
          .join(", ");

        result = [
          `Unread messages found: ${unreadMessages.length}.`,
          accountList ? `Checked accounts: ${accountList}.` : "",
          "Most recent unread messages:",
          ...detailedSummaries,
        ].filter(Boolean).join("\n");
      }

      const outputScan = scanOutput(result);
      if (!outputScan.safe && outputScan.redacted) {
        logAudit(
          "output_redacted",
          { agentName: opts.agentName, types: outputScan.detectedTypes },
          { sessionId: subSessionId, severity: "warn" },
        );
        result = outputScan.redacted;
      }

      recordOutcome({
        ts: new Date().toISOString(),
        agent: opts.agentName,
        task: opts.task.slice(0, 200),
        outcome: "success",
        iterations,
        totalTokens: usage.totalTokens,
        durationMs: Date.now() - runStartedAt,
        timeoutMs: turnTimeoutMs,
      });
      const stats = buildStats("completed");
      logSubAgentCompletionAudit(stats, result, { deterministicMailCheck: true });
      log.info({ agentName: opts.agentName, toolCount }, "Sub-agent completed via deterministic inbox check");
      return withArtifacts({ output: result, stats });
    }

    while (iterations < maxIterations) {
      // Long-running-generation handoff. When this run has burned past
      // the soft thresholds (wall time OR completion tokens), pause and
      // ask the operator whether to keep going, get more budget, or
      // synthesize what's been collected. Stops asking once the operator
      // grants `unbounded`. See long-running-generation.ts for the
      // rationale (session 00e55867 lost a half-built website to an
      // unannounced upstream timeout).
      if (
        !lrgOperatorStop
        && !longRunningGenerationManager.isUnbounded(subSessionId)
        && (
          (Date.now() - runStartedAt) > lrgWallThresholdMs
          || usage.completionTokens > lrgTokenThreshold
        )
      ) {
        const lrgOutcome = await longRunningGenerationManager.requestContinuation({
          agentName: opts.agentName,
          runSessionId: subSessionId,
          ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
          reason: `${opts.agentName} has been generating for ${Math.round((Date.now() - runStartedAt) / 1000)}s and burned ${usage.completionTokens} completion tokens across ${iterations} iterations; ${toolCount} tool calls so far`,
          elapsedMs: Date.now() - runStartedAt,
          completionTokens: usage.completionTokens,
          iterations,
          // When the operator pre-authorized the run with --timeout N, the
          // handoff still fires (so they see the run in the dock and can
          // stop it if they want) but the default outcome on no-response is
          // "continue" instead of "stop" — the run grants itself another
          // round of budget and keeps going.
          ...(operatorPreAuthorizedBudget ? { defaultOutcome: "continue" as const } : {}),
        });
        if (lrgOutcome === "continue") {
          lrgWallThresholdMs += DEFAULT_CONTINUE_GRANT_MS;
          lrgTokenThreshold += DEFAULT_CONTINUE_GRANT_TOKENS;
        } else if (lrgOutcome === "stop" || lrgOutcome === "timeout") {
          // Operator (or fallback timer) asked us to stop. Mark the run
          // for synthesis on the next iteration — reuses the existing
          // timeout-synthesis path so collected evidence is relayed.
          lrgOperatorStop = true;
          turnTimeoutReached = true;
        }
        // "unbounded" → the manager's _unboundedRuns set was updated;
        // this branch is now a no-op for the rest of the run.
      }

      // I11: Pre-emptive soft-deadline synthesis.
      // The hard `turnTimeoutMs` deadline triggers `attemptTimeoutSynthesis`
      // with only ~5s of grace, which is not enough on a 35B local model
      // where each LLM call takes 10-20s. The leaf agent then dies with
      // useful tool results (web_search hits, navigation snapshots, etc.)
      // sitting in conversation history but no final answer for the
      // coordinator to reuse. Reserve a real synthesis budget BEFORE the
      // hard deadline so the model has one full inference window to turn
      // its accumulated evidence into an answer.
      //
      // Reserved budget = max(20s, min(60s, turnTimeoutMs * 0.25)).
      // For a 180s leaf timeout that's a 45s synthesis window starting at
      // 135s elapsed. For a 900s leaf that's a 60s window starting at
      // 840s. Tool calls are blocked during this window — only synthesis
      // is allowed. We only fire the soft deadline once and only when
      // (a) the hard timeout hasn't already triggered, (b) we have real
      // tool output to synthesize from, and (c) the soft deadline has
      // genuinely been crossed.
      if (
        turnTimeoutMs
        && turnTimeoutMs >= 60_000
        && !turnTimeoutReached
        && !softDeadlineSynthesisAttempted
        && toolCount > 0
        && history.some((message) => message.role === "tool")
      ) {
        const elapsed = Date.now() - runStartedAt;
        // I11.1: Bumped reservation to 33% (min 30s, max 75s). The previous
        // 25% / 20s window was repeatedly eaten by an in-flight tool call
        // that started just before the soft-deadline check, leaving only
        // a couple of seconds before the hard wall. A larger reservation
        // gives the synthesis pass a real chance to fire even when the
        // last tool round took 30-40s.
        const reservedSynthesisMs = Math.max(30_000, Math.min(75_000, Math.round(turnTimeoutMs * 0.33)));
        if (elapsed >= turnTimeoutMs - reservedSynthesisMs) {
          softDeadlineSynthesisAttempted = true;
          logAudit(
            "sub_agent_soft_deadline",
            {
              agentName: opts.agentName,
              elapsedMs: elapsed,
              turnTimeoutMs,
              reservedSynthesisMs,
              iterations,
              toolCount,
            },
            { sessionId: subSessionId, severity: "info" }
          );
          const synthesized = await attemptPreDeadlineSynthesis(reservedSynthesisMs);
          if (synthesized) {
            return synthesized;
          }
          // Synthesis attempt failed — fall through and keep iterating until
          // the hard deadline. The hard-deadline branch below will retry.
        }
      }

      if (turnTimeoutReached && turnTimeoutMs) {
        const synthesized = await attemptTimeoutSynthesis();
        if (synthesized) {
          return synthesized;
        }
        const interruptedOutcome = classifyInterruptedOutcome({
          successfulToolCount,
          artifacts,
          swarmState: toolContext.swarmState,
        });
        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: interruptedOutcome,
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
          error: `timeout (${turnTimeoutMs}ms) reached after current operation finished`,
        });
        const output = buildInterruptedSubAgentOutput({
          agentName: opts.agentName,
          reason: `timed out after ${turnTimeoutMs}ms after finishing the current operation`,
          swarmState: toolContext.swarmState,
          toolNames,
          toolCount,
          iterations,
          artifacts,
          evidenceSnippets: resolveInterruptedEvidenceSnippets({ recentEvidenceSnippets, history }),
          primaryDelegationBody: currentPrimaryDelegationBody(),
        });
        const stats = buildStats("timeout", interruptedOutcome);
        logSubAgentCompletionAudit(stats, output, { timeoutMs: turnTimeoutMs, stopAfterCurrentOperation: true }, "warn");
        return withArtifacts({
          output,
          stats,
        });
      }

      if (signal?.aborted) {
        const interruptedOutcome = classifyInterruptedOutcome({
          successfulToolCount,
          artifacts,
          swarmState: toolContext.swarmState,
        });
        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: interruptedOutcome,
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
          error: "cancelled",
        });
        const output = buildInterruptedSubAgentOutput({
          agentName: opts.agentName,
          reason: "was cancelled",
          swarmState: toolContext.swarmState,
          toolNames,
          toolCount,
          iterations,
          artifacts,
          evidenceSnippets: resolveInterruptedEvidenceSnippets({ recentEvidenceSnippets, history }),
          primaryDelegationBody: currentPrimaryDelegationBody(),
        });
        const stats = buildStats("cancelled", interruptedOutcome);
        logSubAgentCompletionAudit(stats, output, { cancelled: true }, "warn");
        return withArtifacts({
          output,
          stats,
        });
      }

      // ── Iteration budget awareness ──────────────────────────────────────
      // When running low on iterations, take increasingly aggressive
      // measures to force the agent to synthesize instead of tool-calling.
      const remaining = maxIterations - iterations;
      const elapsedMs = Date.now() - runStartedAt;
      const synthesisBufferMs = turnTimeoutMs
        ? Math.max(3_000, Math.min(10_000, Math.round(turnTimeoutMs * 0.15)))
        : undefined;
      const timeRemainingMs = turnTimeoutMs ? Math.max(0, turnTimeoutMs - elapsedMs) : undefined;
      const timeBudgetCritical = toolCount > 0
        && synthesisBufferMs !== undefined
        && timeRemainingMs !== undefined
        && timeRemainingMs <= synthesisBufferMs;
      let effectiveSystemPrompt = systemPrompt;
      let effectiveTools = tools;

      if (timeBudgetCritical) {
        effectiveTools = [];
        effectiveSystemPrompt +=
          `\n\n⚠️ TIME BUDGET CRITICAL: Only about ${timeRemainingMs}ms remain before timeout. ` +
          "NO MORE TOOLS AVAILABLE. Produce your COMPLETE final answer NOW from the evidence already gathered. " +
          "Include the key facts, URLs, and extracts you already retrieved.";
        log.info(
          { agentName: opts.agentName, iterations, toolCount, timeRemainingMs, synthesisBufferMs },
          "Time budget nearly exhausted — stripping tools to force synthesis",
        );
      } else if (remaining === 1 && toolCount > 0) {
        // HARD: last iteration — strip ALL tools so the LLM *cannot* make
        // any more tool calls and is forced to produce a text answer.
        effectiveTools = [];
        effectiveSystemPrompt +=
          "\n\n⚠️ FINAL ITERATION — NO MORE TOOLS AVAILABLE. " +
          "You have used all your tool-call iterations. Produce your COMPLETE final answer NOW. " +
          "Synthesize everything you have gathered from previous tool calls — include ALL content, " +
          "URLs, facts, and extracts verbatim. Do NOT summarize away details. " +
          "Your response is the ONLY output the coordinator will receive from you.";
        log.info(
          { agentName: opts.agentName, iterations, maxIterations, toolCount },
          "Last iteration reached — stripping tools to force synthesis",
        );
      } else if (remaining === 2 && toolCount > 0) {
        effectiveSystemPrompt +=
          `\n\n⚠️ BUDGET WARNING: You have only ${remaining} iterations remaining (out of ${maxIterations}). ` +
          "You have already gathered substantial content. Stop calling tools UNLESS critical information is still missing. " +
          "Use your next response to produce your complete final answer with all facts, URLs, and evidence you have collected so far.";
      }

      // E18: Soft deadline — inject a wrap-up nudge once when the caller-supplied
      // deadline expires. Coordinators set this to ~70% of their own budget so
      // specialists begin wrapping up before the hard timeout fires.
      if (
        opts.softDeadlineMs !== undefined
        && !softDeadlineInjected
        && Date.now() >= opts.softDeadlineMs
        && toolCount > 0
      ) {
        softDeadlineInjected = true;
        effectiveSystemPrompt +=
          "\n\n⚠️ SOFT DEADLINE REACHED: Your allocated time budget for this task is expiring. " +
          "Plan to wrap up within the next 1–2 iterations: " +
          "call share_finding with any important evidence you have gathered, " +
          "then produce your complete final answer.";
        log.info(
          { agentName: opts.agentName, iterations, softDeadlineMs: opts.softDeadlineMs },
          "Soft deadline reached — injecting wrap-up nudge",
        );
      }

      // §12: Iteration-budget nudge — fire when many iterations pass without
      // any tool calls, even if the soft-deadline hasn't expired.  Prevents
      // agents that are "thinking aloud" from consuming the entire budget
      // without making progress.
      if (
        !softDeadlineInjected
        && toolCount === 0
        && iterations >= Math.floor(maxIterations * 0.7)
      ) {
        softDeadlineInjected = true; // reuse the flag so this fires only once
        effectiveSystemPrompt +=
          "\n\n⚠️ ITERATION BUDGET WARNING: You have used many iterations without calling any tools. " +
          "If you need to gather information, call the appropriate tools now. " +
          "If you already have enough context, produce your final answer immediately.";
        log.info(
          { agentName: opts.agentName, iterations, maxIterations, toolCount },
          "§12: Iteration-budget nudge injected (no tool calls at 70% of budget)",
        );
      }

      // E19 wave 2 follow-up: mid-turn degradation flip. If the warden
      // marked this session degraded after the turn already started, apply
      // the velocity nudge + tool cap to *this* iteration so the in-flight
      // loop tightens immediately instead of finishing the current turn at
      // full fan-out.
      if (!degradedMidTurnApplied && isSessionDegraded(subSessionId)) {
        degradedMidTurnApplied = true;
        effectiveSystemPrompt +=
          "\n\n⚠️ VELOCITY WARNING (mid-turn): The warden flagged this session "
          + "as approaching a tool-storm / messaging-flood threshold while you were "
          + "running. Narrow scope, batch tool calls, and finish quickly. Do not "
          + "spawn further delegations or parallel tool fan-out unless strictly "
          + "required to complete the task.";
        if (effectiveTools.length > 6) {
          effectiveTools = effectiveTools.slice(0, 6);
        }
        log.info(
          {
            agentName: opts.agentName,
            subSessionId,
            iteration: iterations + 1,
            remainingTools: effectiveTools.length,
          },
          "Sub-agent entered degraded mode mid-turn — nudge injected, tool list capped",
        );
      }

      const messages: LLMMessage[] = [
        { role: "system", content: effectiveSystemPrompt },
        ...history,
      ];

      opts.onProgress?.({
        agentName: opts.agentName,
        kind: "thinking",
        iteration: iterations + 1,
        summary: `Planning the next delegated step in ${opts.agentName}.`,
      });

      let response;
      try {
        response = await provider.complete(messages, effectiveTools, signal);
      } catch (err) {
        if (opts.signal?.aborted) {
          const interruptedOutcome = classifyInterruptedOutcome({
            successfulToolCount,
            artifacts,
            swarmState: toolContext.swarmState,
          });
          recordOutcome({
            ts: new Date().toISOString(),
            agent: opts.agentName,
            task: opts.task.slice(0, 200),
            outcome: interruptedOutcome,
            iterations,
            totalTokens: usage.totalTokens,
            durationMs: Date.now() - runStartedAt,
            timeoutMs: turnTimeoutMs,
            error: "cancelled",
          });
          const output = buildInterruptedSubAgentOutput({
            agentName: opts.agentName,
            reason: "was cancelled",
            swarmState: toolContext.swarmState,
            toolNames,
            toolCount,
            iterations,
            artifacts,
            evidenceSnippets: recentEvidenceSnippets,
            primaryDelegationBody: currentPrimaryDelegationBody(),
          });
          const stats = buildStats("cancelled", interruptedOutcome);
          logSubAgentCompletionAudit(stats, output, { cancelled: true }, "warn");
          return withArtifacts({
            output,
            stats,
          });
        }
        const interruptedOutcome = classifyInterruptedOutcome({
          successfulToolCount,
          artifacts,
          swarmState: toolContext.swarmState,
        });
        if (looksLikeTimeoutLikeError(err) && interruptedOutcome === "partial") {
          log.warn({ err, agentName: opts.agentName }, "Sub-agent LLM call timed out after substantive work — returning partial recovered evidence");
          recordOutcome({
            ts: new Date().toISOString(),
            agent: opts.agentName,
            task: opts.task.slice(0, 200),
            outcome: interruptedOutcome,
            iterations,
            totalTokens: usage.totalTokens,
            durationMs: Date.now() - runStartedAt,
            timeoutMs: turnTimeoutMs,
            error: String(err).slice(0, 200),
          });
          const output = buildInterruptedSubAgentOutput({
            agentName: opts.agentName,
            reason: "timed out while finalizing the answer after substantive work",
            swarmState: toolContext.swarmState,
            toolNames,
            toolCount,
            iterations,
            artifacts,
            evidenceSnippets: resolveInterruptedEvidenceSnippets({ recentEvidenceSnippets, history }),
            primaryDelegationBody: currentPrimaryDelegationBody(),
          });
          const stats = buildStats("timeout", interruptedOutcome);
          logSubAgentCompletionAudit(stats, output, {
            timeoutDuringFinalSynthesis: true,
            error: String(err).slice(0, 200),
          }, "warn");
          return withArtifacts({ output, stats });
        }
        log.error({ err, agentName: opts.agentName }, "Sub-agent LLM call failed");
        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: "failure",
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
          error: String(err).slice(0, 200),
        });
        const output = `Sub-agent error: ${String(err)}`;
        const stats = buildStats("error");
        logSubAgentCompletionAudit(stats, output, { error: String(err).slice(0, 200) }, "warn");
        return withArtifacts({ output, stats });
      }

      usage.promptTokens += response.usage.promptTokens;
      usage.completionTokens += response.usage.completionTokens;
      usage.totalTokens += response.usage.totalTokens;

      if (turnTimeoutReached && turnTimeoutMs && response.tool_calls.length > 0) {
        const synthesized = await attemptTimeoutSynthesis();
        if (synthesized) {
          return synthesized;
        }
        const interruptedOutcome = classifyInterruptedOutcome({
          successfulToolCount,
          artifacts,
          swarmState: toolContext.swarmState,
        });
        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: interruptedOutcome,
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
          error: `timeout (${turnTimeoutMs}ms) reached before starting another tool run`,
        });
        const output = buildInterruptedSubAgentOutput({
          agentName: opts.agentName,
          reason: `timed out after ${turnTimeoutMs}ms before starting another tool run`,
          swarmState: toolContext.swarmState,
          toolNames,
          toolCount,
          iterations,
          artifacts,
          evidenceSnippets: resolveInterruptedEvidenceSnippets({ recentEvidenceSnippets, history }),
          primaryDelegationBody: currentPrimaryDelegationBody(),
        });
        const stats = buildStats("timeout", interruptedOutcome);
        logSubAgentCompletionAudit(stats, output, { timeoutMs: turnTimeoutMs, stopAfterCurrentOperation: true }, "warn");
        return withArtifacts({ output, stats });
      }

      // No tool calls — final answer
      if (response.tool_calls.length === 0) {
        let result = normalizeSubAgentOutput(response.content);

        // Recovery: if the agent used tools (gathered real content) but returned
        // an empty final response, force one synthesis pass so the fetched data
        // isn't lost.  This catches a common Qwen pattern where the model emits
        // tool calls on every iteration then returns content: "" on the last.
        const emptyAfterWork = result === "Sub-agent produced no final response." && toolCount > 0;
        if (emptyAfterWork && !signal?.aborted) {
          log.warn(
            { agentName: opts.agentName, iterations, toolCalls: toolCount },
            "Sub-agent returned empty response after tool use — forcing synthesis pass",
          );
          try {
            const rescueMessages: LLMMessage[] = [
              {
                role: "system",
                content: systemPrompt +
                  "\n\nYou returned an empty response but you have already gathered content from previous tool calls. " +
                  "DO NOT call any more tools. " +
                  "Produce your COMPLETE final answer now. Include ALL content you retrieved — URLs, facts, and extracts. " +
                  "Your response is the ONLY output the coordinator will receive from you.",
              },
              ...history,
            ];
            const rescueResponse = await provider.complete(rescueMessages, [], signal);
            usage.promptTokens += rescueResponse.usage.promptTokens;
            usage.completionTokens += rescueResponse.usage.completionTokens;
            usage.totalTokens += rescueResponse.usage.totalTokens;
            if (rescueResponse.tool_calls.length === 0) {
              const rescued = normalizeSubAgentOutput(rescueResponse.content);
              if (rescued !== "Sub-agent produced no final response.") {
                result = rescued;
                log.info(
                  { agentName: opts.agentName, rescuedLength: result.length },
                  "Empty-response synthesis rescue succeeded",
                );
              }
            }
          } catch (rescueErr) {
            log.warn({ rescueErr, agentName: opts.agentName }, "Empty-response synthesis rescue failed");
          }
        }

        result = await rescueSanitizedEmptyResult(result);
        const recovered = recoverNoResponseAfterSubstantiveWork(result);
        result = recovered.result;
        result = maybePreferWorkflowOutput(result, workflowPassthroughOutput, toolNames);
        const truncationRecovered = recoverHallucinatedTruncationAfterSubstantiveWork(result);
        result = truncationRecovered.result;

        // Scan for secrets before returning to parent session
        const outputScan = scanOutput(result);
        if (!outputScan.safe && outputScan.redacted) {
          logAudit(
            "output_redacted",
            { agentName: opts.agentName, types: outputScan.detectedTypes },
            { sessionId: subSessionId, severity: "warn" }
          );
          result = outputScan.redacted;
        }

        const semanticOutcome: SubAgentOutcome = recovered.forcedOutcome
          ?? truncationRecovered.forcedOutcome
          ?? (/no results|not found|unable to|failed to|error:/i.test(result.slice(0, 300))
            ? "partial"
            : "success");
        const stats = buildStats("completed", semanticOutcome);
        const suspicious = rejectSuspiciousNoToolOutput(
          opts,
          stats,
          result,
          turnTimeoutMs,
          runStartedAt,
        );
        if (suspicious) {
          return suspicious;
        }

        history.push({ role: "assistant", content: result });

        logSubAgentCompletionAudit(
          stats,
          result,
          adaptiveTimeout ? {
            adaptiveTimeoutMs: adaptiveTimeout.timeoutMs,
            adaptiveTimeoutBaselineMs: adaptiveTimeout.baselineMs,
            adaptiveTimeoutSamples: adaptiveTimeout.sampleSize,
          } : {},
          semanticOutcome === "success" ? "info" : "warn",
        );

        // Detect likely failure patterns from the output text
        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: semanticOutcome,
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
        });

        log.info({ agentName: opts.agentName, iterations }, "Sub-agent completed");
        opts.onProgress?.({
          agentName: opts.agentName,
          kind: "completed",
          iteration: iterations,
          summary: `Completed delegated work in ${opts.agentName}.`,
        });
        return withArtifacts({ output: result, stats });
      }

      // Process tool calls — repair any mangled tool names first
      for (const tc of response.tool_calls) normalizeToolCall(tc);
      if (sourceSensitiveTask && cumulativeUsefulEvidenceBytes < 120 && substantiveEvidenceCount === 0 && !shareFindinCalledThisRun) {
        for (const tc of response.tool_calls) {
          enforceSourceSensitivePreEvidenceDelegation(tc, sanitizedTask, subSessionId, opts.agentName);
        }
      }
      if (requiredResearchFallbackRoute) {
        for (const tc of response.tool_calls) {
          enforceSubAgentRequiredResearchFallbackRouteOnToolCall(tc, requiredResearchFallbackRoute, subSessionId, opts.agentName);
        }
      }

      if (response.tool_calls.length > 0 && response.content?.trim()) {
        logAudit(
          "sub_agent_assistant_text_with_tool_calls_suppressed",
          {
            agentName: opts.agentName,
            contentChars: response.content.length,
            toolNames: response.tool_calls.map((toolCall) => toolCall.name),
            finishReason: response.finishReason,
          },
          { sessionId: subSessionId, severity: "warn" },
        );
        response = { ...response, content: null };
      }

      const assistantToolCalls = response.tool_calls.map(tc => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));

      history.push({
        role: "assistant",
        content: response.content,
        tool_calls: assistantToolCalls,
      });

      const toolResults: LLMMessage[] = [];
      let decisiveDirectRemoteToolResult: import("../tools/registry.js").ToolResult | null = null;
      let decisiveDirectRemoteToolName: string | null = null;
      let executedToolThisIteration = false;

      for (const [toolCallIndex, tc] of response.tool_calls.entries()) {
        if (signal?.aborted) break;
        if (requiredResearchFallbackRoute && enforceSubAgentRequiredResearchFallbackRouteOnToolCall(tc, requiredResearchFallbackRoute, subSessionId, opts.agentName)) {
          const assistantToolCall = assistantToolCalls[toolCallIndex];
          if (assistantToolCall) {
            assistantToolCall.function.name = tc.name;
            assistantToolCall.function.arguments = JSON.stringify(tc.arguments);
          }
        }
        toolCount++;

        if (tc.arguments && "_parse_error" in tc.arguments) {
          const rawArgs = String((tc.arguments as Record<string, unknown>)["_raw"] ?? "");
          emitSubAgentToolAudit({
            agentName: opts.agentName,
            tool: tc.name,
            phase: "done",
            args: { _raw: rawArgs.slice(0, 200) },
            toolCallId: tc.id,
            errorText: `Malformed JSON arguments produced for tool '${tc.name}'. Do not retry this call with a large inline payload; answer from existing evidence or use a smaller artifact-producing tool call.`,
            skippedReason: "invalid_arguments",
          });
          toolResults.push({
            role: "tool",
            content: `Error: Could not parse arguments for tool '${tc.name}'. The arguments were malformed JSON. Do not retry this exact tool call; synthesize from existing evidence or use a smaller valid tool call.`,
            tool_call_id: tc.id,
          });
          continue;
        }

        const priorApprovalFailure = approvalBlockedTools.get(tc.name);
        if (priorApprovalFailure) {
          const blockedMessage = buildApprovalRetryBlockedMessage(tc.name, priorApprovalFailure);
          emitSubAgentToolAudit({
            agentName: opts.agentName,
            tool: tc.name,
            phase: "done",
            args: tc.arguments,
            toolCallId: tc.id,
            errorText: blockedMessage,
            skippedReason: "approval_gate_unresolved",
          });
          logAudit(
            "sub_agent_tool_blocked",
            { agentName: opts.agentName, tool: tc.name, reason: "approval_gate_unresolved" },
            { sessionId: subSessionId, severity: "warn" },
          );
          toolResults.push({
            role: "tool",
            content: blockedMessage,
            tool_call_id: tc.id,
          });
          continue;
        }

        // Enforce tool allow-list
        if (effectiveToolNames && !effectiveToolNames.includes(tc.name)) {
          log.warn({ agentName: opts.agentName, tool: tc.name }, "Sub-agent attempted disallowed tool");
          // Distinguish between tools stripped by the evidence-cap mechanism
          // (normal synthesis enforcement, not a security event) and tools
          // genuinely absent from the agent's configured tool set.
          const blockReason = evidenceCapStrippedTools.has(tc.name)
            ? "evidence_cap_enforced"
            : "not_in_agent_tools";
          logAudit(
            "sub_agent_tool_blocked",
            { agentName: opts.agentName, tool: tc.name, reason: blockReason },
            { sessionId: subSessionId, severity: "warn" }
          );
          toolResults.push({
            role: "tool",
            content: evidenceCapStrippedTools.has(tc.name)
              ? `Tool '${tc.name}' has been disabled — you have gathered enough evidence. Write your final answer now.`
              : `Tool '${tc.name}' is not in this agent's allowed tool set.`,
            tool_call_id: tc.id,
          });
          continue;
        }

        if (!isToolAllowed(tc.name)) {
          toolResults.push({
            role: "tool",
            content: `Tool '${tc.name}' is blocked by security policy.`,
            tool_call_id: tc.id,
          });
          continue;
        }

        emitSubAgentToolAudit({
          agentName: opts.agentName,
          tool: tc.name,
          phase: "start",
          args: tc.arguments,
          toolCallId: tc.id,
        });

        opts.onProgress?.({
          agentName: opts.agentName,
          kind: "tool_start",
          iteration: iterations + 1,
          toolName: tc.name,
          toolCallId: tc.id,
          args: tc.arguments,
          summary: `Running ${tc.name} in ${opts.agentName}.`,
        });

        toolNames.push(tc.name);

        // Per-tool call cap — prevent wasteful loops on a single tool.
        // For path-keyed write tools, the primary cap is per-(tool, path):
        // writing 4 distinct files only counts once against each path. The
        // total per-tool cap is still enforced as a backstop against
        // runaway-with-different-paths.
        const priorCount = perToolCallCount.get(tc.name) ?? 0;
        const toolCap = resolveSubAgentToolCap(tc.name, isCoordinatorAgent);
        const writePath = PATH_KEYED_WRITE_TOOLS.has(tc.name)
          ? (() => {
            const raw = tc.arguments?.["path"] ?? tc.arguments?.["output_file"] ?? tc.arguments?.["filename"];
            return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
          })()
          : null;
        if (writePath !== null) {
          const pathKey = `${tc.name}:${writePath}`;
          const pathCount = perWritePathCount.get(pathKey) ?? 0;
          if (pathCount >= PER_PATH_WRITE_CAP) {
            log.warn(
              { agentName: opts.agentName, tool: tc.name, path: writePath, count: pathCount, cap: PER_PATH_WRITE_CAP },
              "Sub-agent exceeded per-path write cap (same path rewritten too many times)",
            );
            emitSubAgentToolAudit({
              agentName: opts.agentName,
              tool: tc.name,
              phase: "done",
              args: tc.arguments,
              toolCallId: tc.id,
              errorText: `Tool '${tc.name}' has already written '${writePath}' ${pathCount} times this run (limit: ${PER_PATH_WRITE_CAP} per path). Move on to a different path or finalize.`,
              skippedReason: "per_path_write_cap",
            });
            toolResults.push({
              role: "tool",
              content: `Tool '${tc.name}' has already written '${writePath}' ${pathCount} times this run (limit: ${PER_PATH_WRITE_CAP} per path). Move on to a different path or finalize.`,
              tool_call_id: tc.id,
            });
            continue;
          }
          perWritePathCount.set(pathKey, pathCount + 1);
        }
        if (toolCap !== undefined && priorCount >= toolCap) {
          log.warn(
            { agentName: opts.agentName, tool: tc.name, count: priorCount, cap: toolCap },
            "Sub-agent exceeded per-tool call cap",
          );
          emitSubAgentToolAudit({
            agentName: opts.agentName,
            tool: tc.name,
            phase: "done",
            args: tc.arguments,
            toolCallId: tc.id,
            errorText: `Tool '${tc.name}' has been called ${priorCount} times this run (limit: ${toolCap}). You must proceed without calling it again. Work with the results you already have.`,
            skippedReason: "per_tool_cap",
          });
          toolResults.push({
            role: "tool",
            content: `Tool '${tc.name}' has been called ${priorCount} times this run (limit: ${toolCap}). You must proceed without calling it again. Work with the results you already have.`,
            tool_call_id: tc.id,
          });
          continue;
        }
        perToolCallCount.set(tc.name, priorCount + 1);

        // ABA-duplicate detection (idempotent tools only): if the same tool
        // was previously called with these exact args at *any* point this run,
        // return the cached result. Catches loops like read_file(a) →
        // read_file(b) → read_file(a) that the consecutive map below misses
        // because slot A was overwritten by B. Restricted to read-only /
        // pure-query tools so we never short-circuit a deliberate re-poll of
        // mutating state (browser session, swarm state, mail send, etc).
        const argsSig = JSON.stringify(tc.arguments);
        if (IDEMPOTENT_TOOLS.has(tc.name)) {
          const idemKey = `${tc.name}::${argsSig}`;
          const cached = idempotentCallCache.get(idemKey);
          if (cached) {
            cached.callCount += 1;
            log.warn(
              { agentName: opts.agentName, tool: tc.name, repeatCount: cached.callCount },
              "Sub-agent re-issued idempotent tool call (ABA dedup) — returning cached result",
            );
            const cachedNote = cached.success
              ? "[Note: This is a cached result — you already called this idempotent tool with identical arguments earlier this run. The output has not changed; move on.]"
              : "[Note: This is a cached failed result from earlier this run — the call did not succeed and re-trying with the same arguments will not help. Work from the partial result you have or report the blocker.]";
            emitSubAgentToolAudit({
              agentName: opts.agentName,
              tool: tc.name,
              phase: "done",
              args: tc.arguments,
              toolCallId: tc.id,
              resultPreview: cached.result,
              successOverride: cached.success,
              cachedResult: true,
            });
            toolResults.push({
              role: "tool",
              content: `${cached.result}\n\n${cachedNote}`,
              tool_call_id: tc.id,
            });
            continue;
          }
        }

        // Consecutive-duplicate detection: if same tool + same args as the
        // immediately prior call, return the cached result with a warning
        // instead of wasting an iteration on a redundant network round-trip.
        const prev = lastToolCallSig.get(tc.name);
        if (prev && prev.args === argsSig && !isLiveStateTool(tc.name)) {
          log.warn(
            { agentName: opts.agentName, tool: tc.name },
            "Sub-agent repeated identical tool call — returning cached result",
          );
          const cachedNote = prev.success
            ? "[Note: This is a cached result — you already called this tool with identical arguments. Move on to the next step.]"
            : "[Note: This is a cached failed result — you already called this tool with identical arguments and it did not succeed. Do NOT call it again. Work from this partial result or report the blocker explicitly.]";
          emitSubAgentToolAudit({
            agentName: opts.agentName,
            tool: tc.name,
            phase: "done",
            args: tc.arguments,
            toolCallId: tc.id,
            resultPreview: prev.result,
            successOverride: prev.success,
            cachedResult: true,
          });
          toolResults.push({
            role: "tool",
            content: `${prev.result}\n\n${cachedNote}`,
            tool_call_id: tc.id,
          });
          continue;
        }

        const result = await executeTool(tc.name, tc.arguments, toolContext);
        executedToolThisIteration = true;
        emitSubAgentToolAudit({
          agentName: opts.agentName,
          tool: tc.name,
          phase: "done",
          args: tc.arguments,
          toolCallId: tc.id,
          result,
        });
        let resultContent = result.success
          ? result.output
          : (result.error?.trim()
              ? `Error: ${result.error}`
              : (result.output.trim() || "Error: unknown"));

        if (!result.success && isApprovalGateFailure(result.error ?? resultContent)) {
          const approvalFailure = result.error?.trim() || resultContent.replace(/^Error:\s*/i, "").trim();
          approvalBlockedTools.set(tc.name, approvalFailure);
          tools = tools.filter((tool) => tool.name !== tc.name);
          resultContent += "\n\n[APPROVAL BLOCKED] Human approval was not granted for this sensitive action. Do not request the same approval-gated tool again in this run; report the blocker and ask the user to retry when they can approve it.";
          logAudit(
            "sub_agent_tool_blocked",
            { agentName: opts.agentName, tool: tc.name, reason: "approval_gate_unresolved" },
            { sessionId: subSessionId, severity: "warn" },
          );
        }

        // Redact any secrets leaked into the tool output before the sub-agent sees it.
        const toolOutputScan = scanOutput(resultContent);
        if (!toolOutputScan.safe && toolOutputScan.redacted) {
          resultContent = toolOutputScan.redacted;
          logAudit(
            "output_redacted",
            { surface: "tool_output", agentName: opts.agentName, tool: tc.name, detectedTypes: toolOutputScan.detectedTypes },
            { sessionId: subSessionId, severity: "warn" },
          );
        }

        // Hard-cap individual tool results to prevent large pages (e.g. Wikipedia) from
        // exhausting the sub-agent's context budget and dropping subsequent tool calls.
        resultContent = truncateToolResult(resultContent, tc.name);

        if (result.success) {
          successfulToolCount += 1;
          // Track substantive evidence for share_finding nudge (Phase A5)
          const SUBSTANTIVE_THRESHOLDS: Record<string, number> = {
            web_search: 1_024,
            web_fetch: 5_120,
            browser_navigate: 5_120,
          };
          const threshold = SUBSTANTIVE_THRESHOLDS[tc.name];
          if (threshold !== undefined && resultContent.length >= threshold) {
            substantiveEvidenceCount += 1;
          }
        }
        if (sourceSensitiveTask && !requiredResearchFallbackRoute && result.success) {
          const discoveryNoMatch = tc.name === "search_agents" && subAgentSearchAgentsReturnedNoMatch(result);
          if (discoveryNoMatch) {
            const trippedAgents = Array.isArray(result.metadata?.["trippedAgents"])
              ? result.metadata?.["trippedAgents"].map(String).filter(Boolean)
              : [];
            requiredResearchFallbackRoute = buildSubAgentRequiredResearchFallbackRoute({
              task: sanitizedTask,
              agentName: opts.agentName,
              allowedAgents: opts.allowedAgents,
              effectiveToolNames,
              excludedAgents: trippedAgents,
            });
          }
        }
        if (tc.name === "share_finding") {
          shareFindinCalledThisRun = true;
          shareFindinCallCount += 1;
        }
        if (tc.name === "run_workflow" && result.success) {
          workflowPassthroughOutput = result.output;
        }
        if (
          response.tool_calls.length === 1
          && tc.name === "ssh_exec"
          && isDirectRemoteCliTask(opts.agentName, sanitizedTask)
        ) {
          decisiveDirectRemoteToolResult = result;
          decisiveDirectRemoteToolName = tc.name;
        }
        lastToolCallSig.set(tc.name, { args: argsSig, result: resultContent, success: result.success });
        if (IDEMPOTENT_TOOLS.has(tc.name)) {
          idempotentCallCache.set(`${tc.name}::${argsSig}`, {
            result: resultContent,
            success: result.success,
            callCount: 1,
          });
        }
        // Track bytes per tool for observability
        bytesByTool.set(tc.name, (bytesByTool.get(tc.name) ?? 0) + resultContent.length);

        // I13: Cascade-timeout detector. Delegation tools wrap one or many
        // child sub-agents; when those children hit their hard timeout, the
        // delegation result content carries one "timed out after Nms" marker
        // per timed-out child. Count them so the post-tool guard below can
        // decide whether the swarm has cascade-failed.
        const isDelegationTool = tc.name === "delegate_to_agent"
          || tc.name === "parallel_delegate"
          || tc.name === "swarm_delegate"
          || tc.name === "run_task_graph";
        if (isDelegationTool) {
          const timeoutMatches = resultContent.match(/timed out after \d+ms/gi);
          if (timeoutMatches) {
            cumulativeTimeoutSignalCount += timeoutMatches.length;
          }
        }

        // I13: Useful-evidence accumulator. Sum non-boilerplate bytes from
        // successful tool results so the post-tool guard can decide whether
        // the agent already has enough material to answer. Strip the
        // timeout-summary boilerplate (the "Sub-agent X timed out" header
        // + "Partial progress before interruption" stanza) so it doesn't
        // count as "evidence" — those bytes are negative signal already
        // counted above.  CRITICAL: stop the strip at "Recovered evidence
        // snippets from completed tools:" so the grandchild's harvested
        // tool outputs (added by sub-agent.ts:buildInterruptedSubAgentOutput)
        // propagate up to the grandparent's recentEvidenceSnippets buffer.
        // Without this, a timed-out delegation cascade discarded all the
        // grandchild's web_search / web_fetch evidence at the parent level.
        if (
          result.success
          && !/^(All candidate agents failed|Tool '[^']+' has been called|Tool '[^']+' is)/i.test(resultContent)
        ) {
          const usefulPortion = resultContent
            // Strip timeout boilerplate. Stop before recovered-snippets header
            // OR before the next parallel_delegate result separator (\n\n---)
            // so that multi-paragraph task descriptions inside partial-progress
            // blocks are fully consumed and not counted as useful evidence.
            .replace(
              /Sub-agent '[^']+' timed out after \d+ms\s+Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
              "",
            )
            .replace(
              /Sub-agent '[^']+' produced no final response after substantive work\.\s+Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
              "",
            )
            // Same for cancelled-stanza boilerplate.
            .replace(
              /Sub-agent '[^']+' was cancelled\s+Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
              "",
            )
            // Single-line timeout markers without a partial-progress block.
            .replace(/Sub-agent '[^']+' timed out after \d+ms\n?/g, "")
            .replace(/Sub-agent '[^']+' produced no final response after substantive work\.\n?/g, "")
            .replace(/Sub-agent '[^']+' was cancelled\n?/g, "");
          const recoveredInterruptedEvidence = extractUsefulInterruptedToolEvidence(resultContent)
            ?? extractUsefulInterruptedToolEvidence(usefulPortion);
          const usefulTrimmed = (recoveredInterruptedEvidence ?? usefulPortion).trim();
          if (
            !usefulTrimmed
            || looksLikeInterruptedEvidenceBoilerplate(usefulTrimmed)
            || looksLikeProviderErrorEcho(usefulTrimmed)
          ) {
            continue;
          }
          const snippetThreshold = recoveredInterruptedEvidence ? 80 : 180;
          if (usefulTrimmed.length >= snippetThreshold) {
            const snippet = truncateToolAuditText(usefulTrimmed, 900);
            if (snippet) {
              recentEvidenceSnippets = [...recentEvidenceSnippets, `${tc.name}: ${snippet}`].slice(-6);
            }
            try {
              // autoShareUsefulFinding returns the extracted finding text that was
              // stored, or null if skipped. Count only the extracted length so that
              // cumulativeUsefulEvidenceBytes reflects actual stored knowledge
              // density — not raw dump volume inflated by search headers and URLs.
              const extractedFinding = await autoShareUsefulFinding({
                sessionId: subSessionId,
                agentName: opts.agentName,
                toolName: tc.name,
                evidence: usefulTrimmed,
                sharedKeys: autoSharedFindingKeys,
              });
              if (extractedFinding !== null) {
                autoSharedFindingCount += 1;
                cumulativeUsefulEvidenceBytes += extractedFinding.length;
                logAudit("sub_agent_tool_call", {
                  agentName: opts.agentName,
                  tool: tc.name,
                  phase: "shared_finding_auto",
                  autoSharedFindingCount,
                  extractedChars: extractedFinding.length,
                }, { sessionId: subSessionId, severity: "info" });
              }
            } catch (err) {
              log.debug({ err, agentName: opts.agentName, tool: tc.name }, "Failed to auto-share useful tool evidence");
            }
          }
        }

        // E21: Track source domain diversity for research plateau detection
        if (result.success && (tc.name === "web_fetch" || tc.name === "browser_navigate")) {
          const rawUrl = (tc.arguments as Record<string, unknown> | undefined)?.["url"];
          const urlStr = typeof rawUrl === "string" ? rawUrl : null;
          if (urlStr) {
            try {
              const domain = new URL(urlStr).hostname.replace(/^www\./i, "");
              if (visitedSourceDomains.has(domain)) {
                consecutiveStaleDomainFetches += 1;
              } else {
                visitedSourceDomains.add(domain);
                consecutiveStaleDomainFetches = 0;
              }
            } catch { /* invalid URL */ }
          }
        }

        // When web_search reports degraded/hard-blocked, remove it from the
        // tools array so the LLM cannot call it on subsequent iterations.
        if (tc.name === "web_search" && result.metadata?.searchDegraded && !result.success) {
          const beforeLen = tools.length;
          tools = tools.filter(t => t.name !== "web_search");
          if (tools.length < beforeLen) {
            log.info(
              { agentName: opts.agentName, iterations },
              "Removed web_search from tools — search backend degraded",
            );
          }
        }

        recordArtifacts(result.metadata, {
          sourceAgent: opts.agentName,
          sourceTool: tc.name,
        });

        opts.onProgress?.({
          agentName: opts.agentName,
          kind: "tool_done",
          iteration: iterations + 1,
          toolName: tc.name,
          toolCallId: tc.id,
          result: resultContent,
          metadata: result.metadata,
          summary: result.success
            ? `Finished ${tc.name} in ${opts.agentName}.`
            : `Encountered an issue while running ${tc.name} in ${opts.agentName}.`,
        });

        toolResults.push({
          role: "tool",
          content: resultContent,
          tool_call_id: tc.id,
        });
      }

      if (decisiveDirectRemoteToolResult) {
        let directResult = decisiveDirectRemoteToolResult.success
          ? decisiveDirectRemoteToolResult.output
          : `Error: ${decisiveDirectRemoteToolResult.error ?? (decisiveDirectRemoteToolResult.output || "unknown")}`;

        const outputScan = scanOutput(directResult);
        if (!outputScan.safe && outputScan.redacted) {
          logAudit(
            "output_redacted",
            { agentName: opts.agentName, types: outputScan.detectedTypes },
            { sessionId: subSessionId, severity: "warn" }
          );
          directResult = outputScan.redacted;
        }

        iterations += 1;
        const directOutcome: SubAgentOutcome = decisiveDirectRemoteToolResult.success ? "success" : "partial";
        const stats = buildStats("completed", directOutcome);
        recordOutcome({
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: directOutcome,
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
          ...(decisiveDirectRemoteToolResult.success ? {} : { error: directResult.slice(0, 200) }),
        });
        logSubAgentCompletionAudit(stats, directResult, {
          deterministicDirectRemoteCli: true,
          tool: decisiveDirectRemoteToolName,
        }, directOutcome === "success" ? "info" : "warn");
        log.info({ agentName: opts.agentName, tool: decisiveDirectRemoteToolName }, "Sub-agent completed via direct remote CLI shortcut");
        return withArtifacts({ output: stripHallucinatedToolTags(directResult), stats });
      }

      if (response.tool_calls.length > 0 && !executedToolThisIteration && toolResults.length > 0) {
        consecutiveBlockedToolIterations += 1;
        if (consecutiveBlockedToolIterations >= BLOCKED_TOOL_ITERATION_THRESHOLD) {
          const lastTR = toolResults[toolResults.length - 1]!;
          lastTR.content +=
            "\n\n[TOOL LOOP STOP] Every tool call in the last iterations was blocked, capped, or malformed. " +
            "No tools will be available on the next step. Produce the final answer from existing evidence now; do not retry the same tool call.";
          tools = [];
          if (effectiveToolNames) effectiveToolNames = [];
          logAudit(
            "sub_agent_tool_loop_detected",
            {
              agentName: opts.agentName,
              reason: "all_tool_calls_blocked",
              consecutiveBlockedIterations: consecutiveBlockedToolIterations,
              iterations,
              toolNames: response.tool_calls.map((toolCall) => toolCall.name),
            },
            { sessionId: subSessionId, severity: "warn" },
          );
          // Break out of the iteration loop immediately — letting qwen do
          // one more "thinking-mode" pass with tools stripped burns 50–100 s
          // generating ~5 k completion tokens that boil down to a 134-char
          // dead-end (session 8a0c2be3, 2026-05-28: tool_loop_detected fired
          // at 7 s, sub_agent_completed at 103 s — 96 s of pure waste). The
          // post-loop synthesis pass below still gets one shot at producing
          // a final answer from history.
          break;
        }
      } else {
        consecutiveBlockedToolIterations = 0;
      }

      // Append a budget nudge to the last tool result when on the
      // penultimate iteration, so the agent sees it in the most recent
      // context (not just the system prompt which it may overlook).
      if (remaining === 2 && toolCount > 0 && toolResults.length > 0) {
        const lastTR = toolResults[toolResults.length - 1]!;
        lastTR.content += "\n\n[⚠️ BUDGET: You have 1 iteration left after this one. " +
          "On your next turn you will have NO tools available. " +
          "Produce your COMPLETE final answer NOW or on the very next turn.]";
      }

      // Phase A5: when substantial evidence has been gathered but share_finding hasn't
      // been called yet, inject a nudge so the agent publishes its findings before
      // running out of iterations or dropping evidence.
      if (substantiveEvidenceCount >= 2 && !shareFindinCalledThisRun && toolResults.length > 0) {
        const lastTR = toolResults[toolResults.length - 1]!;
        lastTR.content += "\n\n[EVIDENCE CHECKPOINT] You have collected substantial evidence (" +
          substantiveEvidenceCount + " tool results \u2265 size threshold). " +
          "Call share_finding with the strongest facts you have gathered so far, then continue or finish.";
      }

      // Phase B8: when the agent has called share_finding enough times it has
      // gathered sufficient evidence. Inject a stop nudge to prevent endless loops.
      if (shareFindinCallCount >= 3 && toolResults.length > 0) {
        const lastTR = toolResults[toolResults.length - 1]!;
        lastTR.content += "\n\n[EVIDENCE COMPLETE] You have called share_finding " +
          shareFindinCallCount + " times and gathered sufficient evidence. " +
          "Do NOT call more web_search or web_fetch. Synthesize your findings into a final answer now.";
      }

      // E21: Source-diversity plateau — inject breadth-sufficient nudge when the agent
      // has not visited a new source domain in 2+ consecutive fetches.
      if (consecutiveStaleDomainFetches >= 2 && visitedSourceDomains.size >= 2 && toolResults.length > 0) {
        const lastTR = toolResults[toolResults.length - 1]!;
        lastTR.content += "\n\n[BREADTH SUFFICIENT] You have fetched from " +
          visitedSourceDomains.size + " unique domain(s) with no new source in the last " +
          consecutiveStaleDomainFetches + " fetches. " +
          "Source coverage has plateaued. Stop fetching — call share_finding with your best evidence and synthesize a final answer.";
      }

      // I13: In-loop sufficiency / cascade-failure guard. Runs after tool
      // results have been collected for this iteration but before they are
      // pushed into history and the next LLM call is made. This is the
      // "do I have enough?" / "did the swarm cascade-fail?" gate that was
      // previously missing — without it the coordinator would keep
      // dispatching new delegations even when 6 children had already
      // timed out, eventually hit the per-agent cap, and only then
      // produce a 1097-char shrug ignoring whatever real fragments came
      // back. Both branches fire at most once per run.
      if (!cascadeSynthesisForced && cumulativeTimeoutSignalCount >= 2 && toolResults.length > 0) {
        cascadeSynthesisForced = true;
        const beforeLen = tools.length;
        tools = tools.filter((t) =>
          t.name !== "delegate_to_agent"
          && t.name !== "parallel_delegate"
          && t.name !== "swarm_delegate"
          && t.name !== "run_task_graph",
        );
        // I13.2: Direct-fallback tool injection. After delegation has
        // cascade-failed, a delegation-only coordinator agent (e.g.
        // web_task_coordinator) is left with NO working capability and
        // can only apologize. If the runtime exposes web_search /
        // web_fetch and they are not already in the agent's allow-list,
        // inject them so the coordinator can do the gather itself in
        // the same turn instead of returning a refusal. We extend BOTH
        // the loop-local `tools` (visible to the model) and the
        // `effectiveToolNames` allow-list (enforced at the call site).
        const fallbackToolNames: string[] = [];
        if (effectiveToolNames) {
          const candidates = ["web_search", "web_fetch"];
          const fallbackDefs = getToolsAsLLMDefs(candidates).filter(
            (def) => !tools.some((t) => t.name === def.name),
          );
          if (fallbackDefs.length > 0) {
            tools = [...tools, ...fallbackDefs];
            const newAllowList = [...effectiveToolNames];
            for (const def of fallbackDefs) {
              if (!newAllowList.includes(def.name)) {
                newAllowList.push(def.name);
                fallbackToolNames.push(def.name);
              }
            }
            effectiveToolNames = newAllowList;
          }
        }
        const lastTR = toolResults[toolResults.length - 1]!;
        const fallbackHint = fallbackToolNames.length > 0
          ? " You now have direct access to " + fallbackToolNames.join(" and ") +
            " — use them YOURSELF to finish the task in this same turn. Do NOT delegate."
          : "";
        lastTR.content +=
          "\n\n[⚠️ CASCADE TIMEOUT DETECTED] " +
          cumulativeTimeoutSignalCount + " sub-agent invocation(s) have timed out this run. " +
          "Delegation tools are now DISABLED for the rest of this turn — do NOT attempt more delegations." +
          fallbackHint +
          " If you still cannot complete the task, write a HONEST final answer NOW: list which sub-agents you tried, " +
          "state that they timed out, and report what (if anything) was actually retrieved. " +
          "Do NOT invent results. Do NOT pretend the timeouts succeeded.";
        logAudit(
          "sub_agent_synthesis_forced",
          {
            agentName: opts.agentName,
            reason: "cascade_timeout",
            timeoutSignals: cumulativeTimeoutSignalCount,
            usefulEvidenceBytes: cumulativeUsefulEvidenceBytes,
            delegationToolsRemoved: beforeLen - (tools.length - fallbackToolNames.length),
            fallbackToolsInjected: fallbackToolNames,
            iterations,
          },
          { sessionId: subSessionId, severity: "warn" },
        );
        log.warn(
          { agentName: opts.agentName, timeoutSignals: cumulativeTimeoutSignalCount, fallbackToolsInjected: fallbackToolNames, iterations },
          "Cascade timeout detected — stripped delegation tools and injected direct fallbacks",
        );
      } else if (
        !sufficiencyToolsStripped
        && !cascadeSynthesisForced
        && cumulativeUsefulEvidenceBytes >= SUFFICIENT_EVIDENCE_TOOL_STRIP_BYTES
        && toolResults.length > 0
        && tools.some((tool) => EVIDENCE_GATHERING_TOOL_NAMES.has(tool.name))
      ) {
        // Single-delegation passthrough — short-circuit before stripping. When
        // the only substantive evidence came from one large delegation, the
        // synthesis pass that strip+nudge forces is wasted work: we already
        // have a complete final answer in tool history. Returning it directly
        // saves the rest of the time budget and prevents the "coordinator
        // wraps a complete sub-agent answer for 8 minutes then times out"
        // failure mode from destroying real evidence.
        const passthrough = tryReturnSingleDelegationPassthrough("evidence_strip");
        if (passthrough) return passthrough;

        sufficiencyToolsStripped = true;
        const stripSet = new Set<string>(EVIDENCE_GATHERING_TOOL_NAMES);
        // After enough evidence is gathered, repeated `share_finding`
        // calls are pure noise: they don't add to the useful-evidence
        // total and each one costs another LLM round-trip on a slow
        // local model. When the agent has already published twice,
        // strip share_finding alongside the gather tools so the next
        // iteration has nothing left to call and must synthesize.
        // (Below the 2-call mark we leave it available so the agent
        // can still publish one more strong finding before answering.)
        if (shareFindinCallCount >= 2) {
          stripSet.add("share_finding");
        }
        const strippedToolNames = tools
          .filter((tool) => stripSet.has(tool.name))
          .map((tool) => tool.name);
        for (const name of strippedToolNames) evidenceCapStrippedTools.add(name);
        tools = tools.filter((tool) => !stripSet.has(tool.name));
        if (effectiveToolNames) {
          effectiveToolNames = effectiveToolNames.filter((name) => !stripSet.has(name));
        }
        const lastTR = toolResults[toolResults.length - 1]!;
        lastTR.content +=
          "\n\n[✓ EVIDENCE COMPLETE] You now have approximately " +
          cumulativeUsefulEvidenceBytes + " characters of useful tool output. " +
          "Evidence-gathering tools are disabled for the rest of this run. " +
          "Write the final answer now from the collected evidence. Do not call search, fetch, browser, or delegation tools again.";
        logAudit(
          "sub_agent_synthesis_forced",
          {
            agentName: opts.agentName,
            reason: "sufficient_evidence_tools_stripped",
            usefulEvidenceBytes: cumulativeUsefulEvidenceBytes,
            strippedToolNames,
            shareFindinCallCount,
            iterations,
          },
          { sessionId: subSessionId, severity: "info" },
        );
        // Fix 5: bounded synthesis immediately after strip. Without this, the
        // next iteration's LLM call runs unbounded; on slow local models the
        // synthesis pass routinely hangs for 5–10 minutes (hitting the hard
        // turn timeout with no synthesis emitted), which is exactly the
        // failure mode that destroyed the original recording-device turn.
        // Reserve a synthesis window of min(remaining-budget, 90s, 25% of
        // turnTimeoutMs) and attempt the synthesis directly. If it produces
        // a usable result, return it. If not, fall through and let the next
        // iteration try with whatever budget remains.
        if (turnTimeoutMs && !signal?.aborted) {
          history.push(...toolResults);
          toolResults.length = 0;
          const elapsed = Date.now() - runStartedAt;
          const remaining = Math.max(0, turnTimeoutMs - elapsed);
          if (remaining > 5_000) {
            const synthBudget = Math.min(
              remaining - 2_000,
              300_000,                          // cap at 5 min (was 90s, raised for large local models)
              Math.round(turnTimeoutMs * 0.4),
            );
            if (synthBudget > 5_000) {
              const synthesized = await attemptPreDeadlineSynthesis(synthBudget);
              if (synthesized) return synthesized;
            }
          }
        }
      } else if (
        !sufficiencySynthesisNudged
        && !cascadeSynthesisForced
        && cumulativeUsefulEvidenceBytes >= SUFFICIENT_EVIDENCE_NUDGE_BYTES
        && toolResults.length > 0
        && toolNames.some((name) => EVIDENCE_GATHERING_TOOL_NAMES.has(name))
      ) {
        sufficiencySynthesisNudged = true;
        const lastTR = toolResults[toolResults.length - 1]!;
        lastTR.content +=
          "\n\n[✓ EVIDENCE SUFFICIENT] You have gathered approximately " +
          cumulativeUsefulEvidenceBytes + " characters of useful tool output. " +
          "Before calling any more tools, ask yourself: do I really need MORE data, " +
          "or can I answer the user's question NOW from what I already have? " +
          "Default to answering. Only call another tool if a SPECIFIC, NAMED fact is still missing.";
        logAudit(
          "sub_agent_synthesis_forced",
          {
            agentName: opts.agentName,
            reason: "sufficient_evidence",
            usefulEvidenceBytes: cumulativeUsefulEvidenceBytes,
            iterations,
          },
          { sessionId: subSessionId, severity: "info" },
        );
      }

      history.push(...toolResults);
      const refreshedSharedFacts = await formatSharedFactsContext(subSessionId);
      if (refreshedSharedFacts.content && refreshedSharedFacts.signature !== lastSharedFactsSignature) {
        lastSharedFactsSignature = refreshedSharedFacts.signature;
        history.push({
          role: "system",
          content: [
            "[SHARED FINDINGS CHECK BEFORE NEXT ITERATION]",
            "Review these shared findings before calling more tools. Do not repeat work that is already captured here; use them when drafting the final answer.",
            refreshedSharedFacts.content,
          ].join("\n"),
        });
      }
      // Break out of the iteration loop when the model wasted a full
      // round on tools that have already been stripped. After
      // `sufficient_evidence_tools_stripped` fires, a model on a slow
      // local provider routinely keeps emitting the same blocked tool
      // names for several more iterations — each call returns the
      // "Tool '...' has been disabled" stub, the loop continues, and
      // 60–90 seconds of wall time is burned per round before the hard
      // deadline kills the run with no synthesis. Detecting an
      // entirely-blocked iteration (every result content is the
      // disabled-or-capped stub) and falling out of the loop lets the
      // post-loop forced-synthesis pass run while time still remains.
      if (
        sufficiencyToolsStripped
        && response.tool_calls.length > 0
        && toolResults.length > 0
        && toolResults.every((tr) => {
          const c = typeof tr.content === "string" ? tr.content : "";
          return /^Tool '[^']+' (?:has been disabled|has been called|is not in this agent's allowed tool set|is blocked by security policy)/.test(c);
        })
      ) {
        logAudit(
          "sub_agent_synthesis_forced",
          {
            agentName: opts.agentName,
            reason: "all_tool_calls_blocked_after_strip",
            iterations,
            blockedToolNames: response.tool_calls.map((tc) => tc.name),
          },
          { sessionId: subSessionId, severity: "warn" },
        );
        break;
      }
      iterations++;
    }

    logAudit(
      "sub_agent_max_iterations",
      { agentName: opts.agentName, iterations, toolCount, usage, model: modelConfig.primary },
      { sessionId: subSessionId, severity: "warn" }
    );

    // Force a final synthesis pass — send the conversation history back to the
    // LLM with NO tools so it cannot make more tool calls and must produce a
    // plain-text answer from whatever it has gathered so far.
    if (!signal?.aborted) {
      // Single-delegation passthrough — when the only substantive evidence is
      // one large delegation, the post-loop synthesis pass is wasted work.
      // Return the delegation body directly.
      const passthrough = tryReturnSingleDelegationPassthrough("max_iterations_synthesis");
      if (passthrough) return passthrough;
      try {
        const synthMessages: LLMMessage[] = [
          {
            role: "system",
            content: systemPrompt +
              "\n\nYou have exhausted your tool-call budget. " +
              "DO NOT call any more tools. " +
              "Synthesize everything you have gathered so far and return your COMPLETE final answer now. " +
              "Include ALL content you retrieved from web_fetch, read_file, or any other tool — " +
              "do not summarize away details. Your response is the ONLY output the coordinator will receive from you. " +
              "If you fetched useful content earlier in the conversation, reproduce the key facts, URLs, and extracts verbatim. " +
              "If search failed but you have model knowledge on the topic, provide that and note it was not live-verified.",
          },
          ...history,
        ];
        const synthResponse = await synthProvider.complete(synthMessages, [], signal);
        usage.promptTokens += synthResponse.usage.promptTokens;
        usage.completionTokens += synthResponse.usage.completionTokens;
        usage.totalTokens += synthResponse.usage.totalTokens;

        if (synthResponse.tool_calls.length === 0) {
          let result = normalizeSubAgentOutput(synthResponse.content);

          // ── Empty-response rescue for synthesis path ─────────────────────
          // Qwen models sometimes return empty content even in the synthesis
          // pass. If the agent used tools, retry once with an emphatic prompt.
          if (result === "Sub-agent produced no final response." && toolCount > 0 && !signal?.aborted) {
            try {
              log.warn({ agentName: opts.agentName, toolCount }, "Synthesis returned empty — attempting rescue");
              const rescueMessages: LLMMessage[] = [
                {
                  role: "system",
                  content:
                    "You returned an empty response but you have already gathered content from " +
                    toolCount + " tool calls during this session. " +
                    "Review your conversation history — you MUST have information from web_fetch, " +
                    "read_file, or other tools. Produce your COMPLETE final answer now. " +
                    "Include ALL content you retrieved — URLs, facts, and extracts verbatim. " +
                    "Do NOT call any tools. Do NOT return an empty response.",
                },
                ...history,
              ];
              const rescueResponse = await provider.complete(rescueMessages, [], signal);
              usage.promptTokens += rescueResponse.usage.promptTokens;
              usage.completionTokens += rescueResponse.usage.completionTokens;
              usage.totalTokens += rescueResponse.usage.totalTokens;
              const rescueResult = normalizeSubAgentOutput(rescueResponse.content);
              if (rescueResult !== "Sub-agent produced no final response.") {
                log.info({ agentName: opts.agentName, rescueLength: rescueResult.length }, "Synthesis rescue succeeded");
                result = rescueResult;
              } else {
                log.warn({ agentName: opts.agentName }, "Synthesis rescue also returned empty");
              }
            } catch (rescueErr) {
              log.warn({ rescueErr, agentName: opts.agentName }, "Synthesis rescue failed");
            }
          }

          result = await rescueSanitizedEmptyResult(result);
          result = maybePreferWorkflowOutput(result, workflowPassthroughOutput, toolNames);
          const truncationRecovered = recoverHallucinatedTruncationAfterSubstantiveWork(result);
          result = truncationRecovered.result;

          const outputScan = scanOutput(result);
          if (!outputScan.safe && outputScan.redacted) {
            logAudit(
              "output_redacted",
              { agentName: opts.agentName, types: outputScan.detectedTypes },
              { sessionId: subSessionId, severity: "warn" }
            );
            result = outputScan.redacted;
          }
          const completedFromArtifact = hasDeliverableArtifact(artifacts) && !looksLikeFailureResult(result);
          const stats = completedFromArtifact
            ? buildStats("completed", "success")
            : buildStats("max_iterations", "partial");
          const suspicious = rejectSuspiciousNoToolOutput(
            opts,
            stats,
            result,
            turnTimeoutMs,
            runStartedAt,
          );
          if (suspicious) {
            return suspicious;
          }
          recordOutcome({
            ts: new Date().toISOString(),
            agent: opts.agentName,
            task: opts.task.slice(0, 200),
            outcome: completedFromArtifact ? "success" : "partial",
            iterations,
            totalTokens: usage.totalTokens,
            durationMs: Date.now() - runStartedAt,
            timeoutMs: turnTimeoutMs,
          });
          logSubAgentCompletionAudit(
            stats,
            result,
            {
              synthesizedAfterMaxIterations: true,
              completedFromArtifact,
              artifactCount: artifacts.length,
            },
            completedFromArtifact ? "info" : "warn",
          );
          log.info({ agentName: opts.agentName, iterations, completedFromArtifact }, "Sub-agent synthesized after max iterations");
          opts.onProgress?.({
            agentName: opts.agentName,
            kind: "completed",
            iteration: iterations,
            summary: `Completed delegated work in ${opts.agentName}.`,
          });
          return withArtifacts({ output: result, stats });
        }
      } catch (synthErr) {
        log.warn({ synthErr, agentName: opts.agentName }, "Synthesis pass after max iterations failed");
      }
    }

    recordOutcome({
      ts: new Date().toISOString(),
      agent: opts.agentName,
      task: opts.task.slice(0, 200),
      outcome: hasDeliverableArtifact(artifacts) ? "success" : "partial",
      iterations,
      totalTokens: usage.totalTokens,
      durationMs: Date.now() - runStartedAt,
      timeoutMs: turnTimeoutMs,
      ...(hasDeliverableArtifact(artifacts) ? {} : { error: `max_iterations (${maxIterations}) reached` }),
    });

    const completedFromArtifact = hasDeliverableArtifact(artifacts);
    // When synthesis-after-max-iterations didn't produce a real text answer
    // (model kept emitting tool calls or threw) we used to return a 112-char
    // boilerplate string and discard ~10 KB of useful evidence the agent had
    // already gathered. Route through buildInterruptedSubAgentOutput so the
    // recovered tool-result snippets propagate up to the parent agent under
    // the "Recovered evidence snippets from completed tools:" header that the
    // runtime knows how to extract.
    const recoveredEvidenceSnippets = resolveInterruptedEvidenceSnippets({
      recentEvidenceSnippets,
      history,
      maxSnippets: 6,
    });
    const recoveredUsefulEvidence = recoveredEvidenceSnippets.length > 0;
    const maxIterationsOutput = workflowPassthroughOutput
      ? maybePreferWorkflowOutput(workflowPassthroughOutput, workflowPassthroughOutput, toolNames)
      : completedFromArtifact
      ? buildArtifactCompletionOutput({
          agentName: opts.agentName,
          maxIterations,
          artifacts,
        })
      : recoveredEvidenceSnippets.length > 0
      ? buildInterruptedSubAgentOutput({
          agentName: opts.agentName,
          reason: `reached the maximum number of tool-call iterations (${maxIterations}). Partial result may be incomplete.`,
          swarmState: toolContext.swarmState,
          toolNames,
          toolCount,
          iterations,
          artifacts,
          evidenceSnippets: recoveredEvidenceSnippets,
          primaryDelegationBody: extractMostRecentSubstantialDelegationBody(history),
        })
      : `Sub-agent '${opts.agentName}' reached the maximum number of tool-call iterations (${maxIterations}) before producing usable topic-related output.`;
    const maxIterationsStats = completedFromArtifact
      ? buildStats("completed", "success")
      : buildStats("max_iterations", recoveredUsefulEvidence || Boolean(workflowPassthroughOutput) ? "partial" : "failure");
    logSubAgentCompletionAudit(maxIterationsStats, maxIterationsOutput, {
      synthesizedAfterMaxIterations: false,
      completedFromArtifact,
      artifactCount: artifacts.length,
    }, completedFromArtifact ? "info" : "warn");

    return withArtifacts({
      output: maxIterationsOutput,
      stats: maxIterationsStats,
    });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);

    // Tear down the live browser preview for this run (also unblocks any
    // still-pending human-assist wait with a "stopped" outcome).
    if (browserSessionId) {
      try { browserSessionManager.stop(browserSessionId, "run_ended"); } catch { /* best effort */ }
    }
    // Resolve any pending long-running-generation prompt for this run so
    // the dashboard's pending list doesn't keep showing it after the run
    // has already finished.
    try { longRunningGenerationManager.stop(subSessionId, "run_ended"); } catch { /* best effort */ }

    // Clean up per-session search circuit-breaker state to avoid memory leaks.
    const clearSearch = await getSearchCleanup();
    clearSearch(subSessionId);

    // Transfer any computer sessions the sub-agent created back to the parent
    // so the orchestrator can reuse them if it falls back to direct tool calls.
    try {
      const subPrefix = `sub:${opts.parentSessionId}`;
      for (const session of computerSessionManager.listActiveSessions()) {
        if (session.leaseOwner.startsWith(subPrefix)) {
          computerSessionManager.attachSession(session.id, opts.parentSessionId, true);
          log.info(
            { sessionId: session.id, from: session.leaseOwner, to: opts.parentSessionId },
            "Transferred computer session lease from sub-agent back to parent",
          );
        }
      }
    } catch (err) {
      log.warn({ err }, "Failed to transfer computer session leases back to parent");
    }
  }
}

export async function runSubAgent(opts: SubAgentRunOptions): Promise<string> {
  const result = await runSubAgentWithStats(opts);
  return result.output;
}
