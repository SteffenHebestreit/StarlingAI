/**
 * Agent Runtime — the main agent loop.
 * LLM call → parse tool calls → execute (with guardrails) → loop → final response
 */
import { getChatProvider, getChatProviderForTier, getChatProviderWithOverride } from "../providers/index.js";
import type { ChatProvider, LLMMessage, LLMResponse, StreamChunk } from "../providers/lmstudio.js";
import { getToolsAsLLMDefs, executeTool, normalizeToolCall, type SwarmState, type ToolContext } from "../tools/registry.js";
import { isToolAllowed } from "../guardrails/tool-tiers.js";
import { checkInput, checkToolOutput } from "../guardrails/input.js";
import { moderateInputText, moderateToolResultText } from "../guardrails/moderation.js";
import { scanOutput } from "../guardrails/output.js";
import { checkRateLimit } from "../guardrails/rate-limiter.js";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import type { AgentSession, SessionHistoryMessage } from "./session.js";
import { classifyToolIntervention, type InterventionNotice } from "./interventions.js";
import { getMainAssistantToolNames, type MainAssistantToolMode } from "./default-tools.js";
import { registerSessionAbortController, deregisterSessionAbortController } from "./warden.js";
import { formatFlowMemoryGuidance } from "./flow-memory.js";
import { sanitizeAssistantContent, NARRATED_TOOL_TEXT_RE } from "./sanitize-response.js";
import { formatScopedMemoryGuidance } from "../memory/service.js";
import { lookupTrajectory, writeTrajectory, invalidateTrajectory } from "../memory/trajectory-cache.js";
import { graphMarkSessionRetrievalsUseful, graphMarkSessionRetrievalsUnhelpful } from "../memory/graph-service.js";
import type { SubAgentProgressEvent } from "./sub-agent.js";
import { listAllJobs } from "../credentials/jobs.js";
import { listAllScenes } from "../credentials/scenes.js";
import {
  buildDynamicTurnGuidance,
  type DynamicTurnGuidance,
  buildLanguageAndIdentityTurnGuidance,
  WORKFLOW_HINT_TERMS,
  WORKFLOW_ACTION_TERMS,
  WORKFLOW_DELIVERABLE_HINT_TERMS,
  WORKFLOW_REQUEST_PATTERNS,
} from "./intent-classifier.js";

const log = childLogger("agent:runtime");

const DEFAULT_MAX_TOOL_ITERATIONS = 20;
const MAX_LENGTH_CONTINUATION_ATTEMPTS = 2;
const MAX_CONTINUATION_OVERLAP_CHARS = 400;
const PER_TURN_TOOL_CALL_LIMITS: Partial<Record<string, number>> = {
  delegate_to_agent: 5,
  search_agents: 4,
  search_workflows: 2,
  run_workflow: 2,
  create_ephemeral_agent: 1,
  computer_session_start: 1,
  computer_focus_window: 2,
  computer_snapshot: 3,
  computer_list_windows: 2,
  computer_click: 8,
  computer_type: 6,
  computer_hotkey: 6,
  computer_scroll: 4,
  computer_move_mouse: 4,
  computer_wait: 3,
  vscode_focus_panel: 2,
  vscode_run_terminal_command: 3,
};
export interface RunTurnOptions {
  session: AgentSession;
  userMessage: string;
  onChunk?: (text: string) => void;
  onStatus?: (status: { phase: string; message: string; iteration?: number }) => void;
  onToolCall?: (toolCallId: string, name: string, args: Record<string, unknown>) => void;
  onToolResult?: (toolCallId: string, name: string, result: string, metadata?: Record<string, unknown>) => void;
  onSubAgentProgress?: (event: SubAgentProgressEvent) => void;
  onComputerAction?: (action: { computerSessionId: string; actionType: string; [key: string]: unknown }) => void;
  onComputerScreenshot?: (screenshot: { computerSessionId: string; dataUrl: string; width: number; height: number; [key: string]: unknown }) => void;
  onComputerSessionState?: (sessionState: { computerSessionId: string; state: string; [key: string]: unknown }) => void;
  onIntervention?: (notice: InterventionNotice) => void;
  onSwarmState?: (state: SwarmState) => void;
  approvalCallback?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  inputCallback?: (question: string, choices?: string[], timeoutMs?: number) => Promise<string>;
  signal?: AbortSignal;
  /** Sub-agents this turn is allowed to delegate to (undefined = no restriction) */
  allowedAgents?: string[];
  /** Tool names that must pause for human approval this turn (enforced unconditionally) */
  humanInLoopSteps?: string[];
  /** Auto-approve all tool calls this turn — skips the approvalCallback gate entirely. */
  autoApprove?: boolean;
  /** Override sub-agent maxIterations for delegated tasks this turn. 0 disables the cap. */
  maxIterationsOverride?: number;
  /** When set, this turn is a tool-dev session — iteration limits are lifted. */
  _toolDevSessionId?: string;
  /** Active reusable workflow execution stack for nested workflow/self-reentry guards. Internal. */
  _workflowExecutionStack?: string[];
  /** Override the per-turn timeout in ms (replaces config gateway.turnTimeoutMs). 0 disables the timeout. */
  turnTimeoutOverrideMs?: number;
  /** Per-message Qwen3.5 thinking toggle. true = on, false = off, undefined = model default. */
  enableThinking?: boolean;
}

export interface TurnOutput {
  response: string;
  toolCallsExecuted: number;
  guardrailEvents: Array<{ type: string; details: string }>;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  blocked: boolean;
  swarmState?: SwarmState;
  performance?: TurnPerformanceMetrics;
}

export interface TurnPerformanceMetrics {
  turnDurationMs: number;
  firstModelResponseMs?: number;
  llmCalls: number;
  llmTimeMs: number;
  toolCallsRequested: number;
  toolExecutionTimeMs: number;
  systemPromptChars: number;
  collapsedHistoryMessages: number;
  collapsedHistoryChars: number;
  promptChars: number;
  completionChars: number;
  toolIterations: number;
  finishReason: string;
  blocked: boolean;
}

export function getPerTurnToolCallLimit(toolName: string): number | undefined {
  return PER_TURN_TOOL_CALL_LIMITS[toolName];
}

export function buildDelegationLoopResponse(
  session: AgentSession,
  latestOutput: string,
  reason: "identical-output" | "limit" = "identical-output",
): string {
  const normalized = latestOutput.trim() || "The delegated agent returned no usable output.";
  const evidence = findRecentDelegateEvidence(session.getHistory());
  const bestAvailable = evidence?.evidence?.trim() || normalized;

  if (reason === "limit") {
    const intro = evidence
      ? "I stopped here because the delegation limit for this turn was reached. Here is the best grounded result collected so far:"
      : "I stopped here because the delegation limit for this turn was reached before a grounded final answer could be completed.";
    return `${intro}\n\n${bestAvailable}\n\nIf you want me to continue past this limit, tell me to raise the delegation limit for this task. Otherwise, we can stop here.`;
  }

  return [
    "Delegation loop detected. I stopped the repeated delegation and am using the best grounded result collected so far.",
    "",
    bestAvailable,
    "",
    "If you want another attempt, tell me to try a different strategy. Otherwise, we can stop here.",
  ].join("\n");
}

function stableSerialize(value: unknown): string {
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

function collapseDuplicateToolCallsInResponse(
  toolCalls: LLMResponse["tool_calls"],
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
): LLMResponse["tool_calls"] {
  const seenFingerprints = new Set<string>();
  const filtered: LLMResponse["tool_calls"] = [];

  for (const toolCall of toolCalls) {
    const fingerprint = `${toolCall.name}|${stableSerialize(toolCall.arguments ?? {})}`;
    if (seenFingerprints.has(fingerprint)) {
      logAudit("tool_call_blocked", {
        tool: toolCall.name,
        reason: "duplicate_same_response",
        args: toolCall.arguments,
      }, {
        sessionId,
        severity: "warn",
      });
      guardrailEvents.push({ type: "tool_blocked", details: `${toolCall.name}:duplicate_same_response` });
      continue;
    }

    seenFingerprints.add(fingerprint);
    filtered.push(toolCall);
  }

  return filtered;
}

function collapseExcessDirectDelegationsInResponse(
  toolCalls: LLMResponse["tool_calls"],
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
): LLMResponse["tool_calls"] {
  let seenDirectDelegation = false;
  const filtered: LLMResponse["tool_calls"] = [];

  for (const toolCall of toolCalls) {
    if (toolCall.name !== "delegate_to_agent") {
      filtered.push(toolCall);
      continue;
    }

    if (!seenDirectDelegation) {
      seenDirectDelegation = true;
      filtered.push(toolCall);
      continue;
    }

    logAudit("tool_call_blocked", {
      tool: toolCall.name,
      reason: "multiple_direct_delegations_same_response",
      args: toolCall.arguments,
    }, {
      sessionId,
      severity: "warn",
    });
    guardrailEvents.push({ type: "tool_blocked", details: `${toolCall.name}:multiple_direct_delegations_same_response` });
  }

  return filtered;
}

const ORCHESTRATION_LAUNCHER_TOOL_NAMES = new Set([
  "delegate_to_agent",
  "parallel_delegate",
  "run_task_graph",
  "run_workflow",
  "create_ephemeral_agent",
]);
const PERSISTED_SWARM_STATE_TOOL_NAMES = new Set([
  ...ORCHESTRATION_LAUNCHER_TOOL_NAMES,
  "swarm_delegate",
]);
const AGENT_DISCOVERY_TOOL_NAMES = new Set([
  "search_agents",
  "list_agents",
  "search_workflows",
]);

interface WorkflowCatalogMatch {
  name: string;
  workflowType: "scene" | "job";
  score: number;
  matchedTerms: string[];
}

interface WorkflowCatalogSignal {
  required: boolean;
  reason: "explicit_request" | "catalog_match" | "uncertain_match" | "hint_terms" | "none";
  strongestMatch?: WorkflowCatalogMatch;
  /** Plausible but unconfirmed candidates — used to ASK the user instead of forcing routing. */
  uncertainCandidates?: WorkflowCatalogMatch[];
}

interface ApprovedWorkflowFollowUp {
  workflowName: string;
  workflowType: "scene";
  params: Record<string, string>;
  candidateName: string;
}

const RUN_CANDIDATE_RE = /(?:^|\n)\s*RUN_CANDIDATE:\s*(.+?)\s*$/im;
const AFFIRMATIVE_WORKFLOW_APPROVAL_RE = /^\s*(?:yes|yeah|yep|sure|ok(?:ay)?|please do(?: that)?|do it|go ahead|run (?:it|that)|start (?:it|that)|ja|jep|klar|ja bitte|mach(?:\s+es)?|tu(?:\s+es)?|bitte(?:\s+(?:mach(?:\s+es)?|starte(?:\s+es)?|ausf(?:ü|ue)hren))?|starte(?:\s+es)?|ausf(?:ü|ue)hren(?:\s+bitte)?)\s*[.!?]*\s*$/i;

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

function detectApprovedRunCandidateFollowUp(
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

function buildApprovedRunCandidateGuidance(followUp: ApprovedWorkflowFollowUp): string {
  return [
    "Approved workflow follow-up detected for this turn.",
    `The previous n8n_project_list result ended with RUN_CANDIDATE: ${followUp.candidateName}.`,
    "The user just approved running that exact workflow.",
    `Call run_workflow now with name \"${followUp.workflowName}\", workflowType \"${followUp.workflowType}\", and params.workflowName \"${followUp.candidateName}\".`,
    "Do NOT call search_agents, search_workflows, delegate_to_agent, parallel_delegate, or run_task_graph first.",
    "Do NOT answer in natural language before issuing that run_workflow call.",
  ].join(" ");
}

function isApprovedRunCandidateToolCall(
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

function extractWorkflowCatalogMatchesFromMetadata(metadata: Record<string, unknown> | undefined): WorkflowCatalogMatch[] {
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

function extractAgentRoutingSuggestionFromMetadata(
  metadata: Record<string, unknown> | undefined,
): { agentName: string; query?: string; fallbackAgents?: string[] } | undefined {
  const agentName = typeof metadata?.["topResult"] === "string"
    ? String(metadata["topResult"]).trim()
    : "";
  if (!agentName) return undefined;

  const query = typeof metadata?.["query"] === "string"
    ? String(metadata["query"]).trim()
    : "";
  const fallbackAgents = Array.isArray(metadata?.["suggestedFallbackAgents"])
    ? (metadata?.["suggestedFallbackAgents"] as unknown[])
      .map((value) => typeof value === "string" ? value.trim() : "")
      .filter((value): value is string => Boolean(value) && value !== agentName)
    : [];

  return {
    agentName,
    query: query || undefined,
    fallbackAgents: fallbackAgents.length > 0 ? fallbackAgents : undefined,
  };
}

function searchAgentsReturnedNoMatch(metadata: Record<string, unknown> | undefined): boolean {
  const resultCount = typeof metadata?.["resultCount"] === "number" ? metadata["resultCount"] : 0;
  const weakCount = typeof metadata?.["weakCount"] === "number" ? metadata["weakCount"] : 0;
  const topResult = typeof metadata?.["topResult"] === "string" ? metadata["topResult"].trim() : "";
  return resultCount === 0 && weakCount === 0 && !topResult;
}

function chooseConfiguredAgent(candidates: readonly string[]): string | undefined {
  const configuredAgents = getConfig().subAgents ?? {};
  return candidates.find((name) => name in configuredAgents);
}

type RequiredResearchFallbackRoute = {
  toolName: "delegate_to_agent" | "create_ephemeral_agent";
  args: Record<string, unknown>;
  label: string;
};

function buildRequiredResearchFallbackRoute(
  userMessage: string,
  guidance: DynamicTurnGuidance | null | undefined,
  allowedToolNameSet: Set<string>,
): RequiredResearchFallbackRoute | null {
  const preferredAgents = guidance?.freshnessSensitive && !guidance?.sourceSensitive
    ? ["web_task_coordinator", "researcher", "mission_coordinator"]
    : ["mission_coordinator", "researcher"];
  const selectedAgent = chooseConfiguredAgent(preferredAgents) ?? preferredAgents[0]!;
  const fallbackAgents = preferredAgents.filter((agentName) => agentName !== selectedAgent && chooseConfiguredAgent([agentName]));

  if (allowedToolNameSet.has("create_ephemeral_agent")) {
    return {
      toolName: "create_ephemeral_agent",
      label: "ephemeral_research_specialist",
      args: {
        agentName: "ephemeral_research_specialist",
        description: "Purpose-built specialist for source-grounded research and product/component verification.",
        systemPrompt: [
          "You are a source-grounded research specialist.",
          "Use web_search and web_fetch to gather evidence before answering.",
          "Return concise findings with source URLs and be explicit about uncertainty.",
          "Do not invent product names, specifications, or artifact paths.",
        ].join(" "),
        tools: ["web_search", "web_fetch", "read_shared_facts", "share_finding"],
        maxIterations: 5,
        // Leaf sub-agents default to `subAgentTurnSloMs` (60 s), which is far
        // too short for a research specialist doing 5 web_search iterations.
        // Grant 5 minutes — the same budget as the configured researcher agent.
        timeoutMs: 300_000,
        task: userMessage,
      },
    };
  }

  if (allowedToolNameSet.has("delegate_to_agent")) {
    return {
      toolName: "delegate_to_agent",
      label: selectedAgent,
      args: {
        agentName: selectedAgent,
        fallbackAgents,
        task: userMessage,
      },
    };
  }

  return null;
}

function buildSearchAgentsNoMatchFallbackPrompt(route: RequiredResearchFallbackRoute): string {
  if (route.toolName === "delegate_to_agent") {
    const fallbackAgents = Array.isArray(route.args["fallbackAgents"]) ? route.args["fallbackAgents"].map(String).filter(Boolean) : [];
    return [
      "ROUTING FALLBACK: search_agents returned no usable specialist candidates for this source-sensitive request.",
      "Do NOT call search_agents or list_agents again in this turn.",
      `You MUST call delegate_to_agent now with agentName="${route.label}"${fallbackAgents.length ? ` and fallbackAgents=[${fallbackAgents.map((name) => `"${name}"`).join(",")}]` : ""} using the original user request as the task.`,
      "A further discovery-only response is invalid; delegation must happen before any final answer.",
    ].join(" ");
  }

  return [
    "ROUTING FALLBACK: search_agents returned no usable specialist candidates for this source-sensitive request.",
    "Do NOT call search_agents or list_agents again in this turn.",
    "You MUST call create_ephemeral_agent now using the provided research-specialist shape and the original user request as the task.",
    "A further discovery-only response is invalid; orchestration must happen before any final answer.",
  ].join(" ");
}

function isExplicitAgentCatalogRequest(message: string): boolean {
  return /\b(list|show|display|print|enumerate|inspect|browse|catalog|catalogue|katalog|liste|auflisten|anzeigen)\b[\s\S]{0,80}\b(agents?|sub[- ]?agents?|specialists?|spezialisten|agenten|catalog|catalogue|katalog)\b/i.test(message)
    || /\b(agents?|sub[- ]?agents?|specialists?|spezialisten|agenten|catalog|catalogue|katalog)\b[\s\S]{0,80}\b(list|show|display|print|enumerate|inspect|browse|liste|auflisten|anzeigen)\b/i.test(message);
}

function mergeWorkflowCatalogMatches(...groups: WorkflowCatalogMatch[][]): WorkflowCatalogMatch[] {
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

function shouldRequireWorkflowExecutionAfterSearch(matches: WorkflowCatalogMatch[]): boolean {
  const topMatch = matches[0];
  if (!topMatch) return false;
  return topMatch.score >= 0.2 || topMatch.matchedTerms.length >= 3;
}

function formatWorkflowExecutionPromptFromSearch(matches: WorkflowCatalogMatch[]): string {
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

function isWorkflowNameResolutionFailureMessage(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes("workflow not found:")
    || (normalized.includes("workflow name '") && normalized.includes("is ambiguous"));
}

function formatWorkflowExecutionCorrectionPromptFromSearch(matches: WorkflowCatalogMatch[], lastError: string): string {
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

function isWorkflowCatalogToolName(toolName: string): boolean {
  return toolName === "search_workflows" || toolName === "run_workflow";
}

// ─── Workflow catalog detector (opt-in trigger model) ─────────────────────
//
// The previous detector scored token-overlap between the user message and a
// concatenated `name + description + task + params` blob for every scene/job.
// That design mis-fired constantly:
//   • pasted iptables/wireguard configs dominated tokenisation
//   • German function words (wir/ich/des/den/was/muss/tun) all looked like topic terms
//   • topic words (`cluster`, `wireguard`, `tunnel`) legitimately overlap with infra
//     scenes regardless of whether the user is asking how to *deploy* or how to *understand*
//   • substring matches like `"sim"` ⊂ `"simplify"` and `"site"` ⊂ `"call sites"`
//
// Replacement: scenes/jobs declare narrow opt-in triggers in their config.
// Three layered signals drive the guardrail now:
//   A. Explicit workflow request (e.g. "use the X scene", "run workflow Y") — already covered
//      by `WORKFLOW_REQUEST_PATTERNS`.
//   B. Author-declared triggers (`scene.triggers.patterns: [{ all: [regex, ...] }, ...]`).
//      An entry matches when ALL of its `all` regexes match the message; ANY entry → match.
//   C. Action-verb gate. Scenes marked `requiresActionVerb: true` only fire as a CONFIRMED
//      intent when the message also contains an imperative/action verb. Without one, the
//      match becomes an UNCERTAIN candidate — we ask the user instead of forcing routing.
//
// Anything without `triggers` is still discoverable via `search_workflows` by the LLM —
// it just no longer trips the guardrail on its own. This is intentional: false positives
// were dramatically worse than the recall loss on rare borderline phrasings.

/**
 * Action verbs (DE + EN) that signal the user wants something *done*, not
 * just explained. Used by `requiresActionVerb` triggers to distinguish
 * "wie konfiguriere ich X" (no verb of execution → uncertain) from
 * "konfiguriere X jetzt" (`konfiguriere` is action verb → confirmed).
 *
 * NOTE: imperative/infinitive forms only. Question words like "wie/was/wer"
 * and modal+verb constructions ("wie konfiguriere ich") legitimately contain
 * an action stem; we still want those to count as "uncertain" when no other
 * imperative verb is present, so the user gets asked instead of force-routed.
 */
const WORKFLOW_ACTION_VERB_PATTERN = new RegExp(
  "\\b(?:" + [
    // English imperatives
    "apply", "deploy", "rollout", "roll\\s*out", "run", "execute", "provision",
    "scale", "migrate", "install", "uninstall", "update", "upgrade", "configure",
    "setup", "set\\s*up", "spin\\s*up", "tear\\s*down", "restart", "reboot",
    "create", "build", "publish", "release", "ship",
    // German imperatives + verbal nouns
    "ausroll(?:en|e)?", "anwend(?:en|e)?", "umsetz(?:en|e)?", "provisionier(?:en|e)?",
    "skalier(?:en|e)?", "migrier(?:en|e)?", "installier(?:en|e)?", "deinstallier(?:en|e)?",
    "aktualisier(?:en|e)?", "upgrade(?:n|t)?", "starte(?:n)?", "neu\\s*starte(?:n)?",
    "richte\\s*ein", "einricht(?:en|e)?", "aufsetz(?:en|e)?", "anlegen", "erstell(?:en|e)?",
    "baue(?:n)?", "ver(?:o|oe|\u00f6)ffentlich(?:en|e)?", "ausf(?:u|ue|\u00fc)hr(?:en|e)?",
    "durchf(?:u|ue|\u00fc)hr(?:en|e)?", "einspiel(?:en|e)?", "auspielen",
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

  const normalized = userMessage.toLowerCase();

  // Signal A: explicit workflow request — these are unambiguous.
  if (WORKFLOW_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { required: true, reason: "explicit_request" };
  }

  // Signal B: author-declared triggers + Signal C: action-verb gate.
  const candidates = compileWorkflowTriggerEntries();
  if (candidates.length === 0) {
    // No catalog triggers configured anywhere — fall through to hint-term heuristic only.
  } else {
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
  }

  // Last-resort heuristic: explicit workflow vocabulary in user prose
  // (e.g. "show me available scenes", "list workflows"). Cheap and bounded —
  // these terms are themselves narrow signals of intent.
  const matchedHints = WORKFLOW_HINT_TERMS.filter((term) => normalized.includes(term));
  const matchedDeliverableHints = WORKFLOW_DELIVERABLE_HINT_TERMS.filter((term) => normalized.includes(term));
  if (
    matchedHints.length >= 2
    || (matchedHints.length === 1 && WORKFLOW_ACTION_TERMS.some((term) => normalized.includes(term)))
    || matchedDeliverableHints.length >= 2
  ) {
    return { required: true, reason: "hint_terms" };
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
      "However, the message lacks a clear action verb (apply / deploy / run / ausrollen / anwenden / durchführen ...) — the user may just be asking for an explanation.",
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

// Internal exports for unit tests.
const __workflowCatalog = {
  detectWorkflowCatalogSignal,
  buildWorkflowCatalogGuidance,
  WORKFLOW_ACTION_VERB_PATTERN,
};

const __swarmStateContinuity = {
  loadPreviousTurnSwarmTasks,
  buildPersistableSwarmTaskDelta,
};

function collapseMixedOrchestrationLaunchersInResponse(
  toolCalls: LLMResponse["tool_calls"],
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
): LLMResponse["tool_calls"] {
  let firstLauncherName: string | null = null;
  const filtered: LLMResponse["tool_calls"] = [];

  for (const toolCall of toolCalls) {
    if (!ORCHESTRATION_LAUNCHER_TOOL_NAMES.has(toolCall.name)) {
      filtered.push(toolCall);
      continue;
    }

    if (!firstLauncherName) {
      firstLauncherName = toolCall.name;
      filtered.push(toolCall);
      continue;
    }

    logAudit("tool_call_blocked", {
      tool: toolCall.name,
      reason: "multiple_orchestration_launchers_same_response",
      keptTool: firstLauncherName,
      args: toolCall.arguments,
    }, {
      sessionId,
      severity: "warn",
    });
    guardrailEvents.push({ type: "tool_blocked", details: `${toolCall.name}:multiple_orchestration_launchers_same_response` });
  }

  return filtered;
}

function collapseMixedDiscoveryAndOrchestrationToolsInResponse(
  toolCalls: LLMResponse["tool_calls"],
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
): LLMResponse["tool_calls"] {
  const selectedPhase: "discovery" | "orchestration" | null = toolCalls.some((toolCall) =>
    ORCHESTRATION_LAUNCHER_TOOL_NAMES.has(toolCall.name)
  )
    ? "orchestration"
    : toolCalls.some((toolCall) => AGENT_DISCOVERY_TOOL_NAMES.has(toolCall.name))
      ? "discovery"
      : null;
  const filtered: LLMResponse["tool_calls"] = [];

  for (const toolCall of toolCalls) {
    const phase = ORCHESTRATION_LAUNCHER_TOOL_NAMES.has(toolCall.name)
      ? "orchestration"
      : AGENT_DISCOVERY_TOOL_NAMES.has(toolCall.name)
        ? "discovery"
        : null;

    if (!phase) {
      filtered.push(toolCall);
      continue;
    }

    if (selectedPhase === phase) {
      filtered.push(toolCall);
      continue;
    }

    logAudit("tool_call_blocked", {
      tool: toolCall.name,
      reason: "mixed_discovery_and_orchestration_same_response",
      keptPhase: selectedPhase,
      args: toolCall.arguments,
    }, {
      sessionId,
      severity: "warn",
    });
    guardrailEvents.push({ type: "tool_blocked", details: `${toolCall.name}:mixed_discovery_and_orchestration_same_response` });
  }

  return filtered;
}

export function buildRepeatedOutputFingerprint(toolName: string, args: Record<string, unknown>, resultText: string): string {
  return `${toolName}|${stableSerialize(args)}|${resultText.slice(0, 500)}`;
}

export { __workflowCatalog };
export { __swarmStateContinuity };

function sanitizeUserFacingAssistantResponse(value: string, toolIterations: number): string {
  return sanitizeAssistantContent(value, toolIterations > 0);
}

const EMPTY_ASSISTANT_RESPONSE_FALLBACK = "I wasn't able to generate a usable reply for that turn. Please try again.";

function looksLikeGenericNoUsableReply(value: string): boolean {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized === EMPTY_ASSISTANT_RESPONSE_FALLBACK
    || /^i wasn'?t able to generate a usable reply\b/i.test(normalized)
    || /^please try again\.?$/i.test(normalized);
}

function shouldResynthesizeUserFacingResponse(raw: string, cleaned: string, toolIterations: number): boolean {
  if (!raw.trim() || cleaned.length === 0) return true;
  if (toolIterations > 0 && looksLikeGenericNoUsableReply(cleaned)) return true;
  if (toolIterations === 0) return false;
  if (!NARRATED_TOOL_TEXT_RE.test(raw)) return false;
  return cleaned.length === 0 || cleaned.length < Math.min(120, Math.ceil(raw.length / 3));
}

const CONTINUATION_PROMISE_RE = /\b(i(?:'ll| will)(?:\s+now)?|i am going to|ich werde(?:\s+nun)?|ich beauftrage(?:\s+nun)?|n[äa]chste orchestrierung|next orchestration|next logical step|n[äa]chste logische aktion)\b/i;
const IMPLICIT_CONTINUATION_EXECUTION_RE = /\b(?:i(?:\s+have|'ve)[\s\S]{0,80}\b(?:corrected|fixed|updated|adjusted)\b[\s\S]{0,80}\b(?:am\s+)?(?:now\s+)?(?:running|executing|starting|retrying|restarting)\b|ich\s+habe[\s\S]{0,80}\b(?:korrigiert|angepasst|berichtigt)\b[\s\S]{0,80}\b(?:und\s+)?(?:f(?:[üu]hre|uehre)|starte|versuche|sto(?:ss|ß)e)\b[\s\S]{0,40}\b(?:nun|jetzt)\b[\s\S]{0,20}\b(?:aus|an)\b)/i;
const MAINTENANCE_EXECUTION_PROMISE_RE = /\b(?:i(?:'ll| will)\s+(?:create|generate|delegate|build)|ich\s+(?:werde|erstelle|generiere|delegiere|beauftrage)|(?:erstelle|generiere|delegiere|beauftrage)\s+ich(?:\s+nun|\s+jetzt)?)\b/i;
const MISLEADING_EXECUTED_NEXT_STEP_RE = /\b(the next (?:logical )?(?:step|action)|der n[äa]chste(?: logische)?(?: schritt| aktion)|die n[äa]chste(?: logische)? aktion)\b[\s\S]{0,80}\b(which has been executed|has been executed|was executed|has already been executed|wurde(?:\s+bereits)?\s+ausgef[üu]hrt|ist bereits erfolgt)\b/i;
const NEXT_TURN_HANDOFF_RE = /\b(would you like me to (?:initiate|start|retry)|in the next turn|im n[äa]chsten zug|im n[äa]chsten turn|neue[nr]? delegations(?:strategie|versuch)|new delegation attempt|no further tool calls can be made in this turn|keine weiteren tool calls .* in diesem zug)\b/i;

function looksLikeContinuationPromise(value: string): boolean {
  return CONTINUATION_PROMISE_RE.test(value) || IMPLICIT_CONTINUATION_EXECUTION_RE.test(value);
}

function looksLikeMaintenanceExecutionPromise(value: string): boolean {
  return looksLikeContinuationPromise(value) || MAINTENANCE_EXECUTION_PROMISE_RE.test(value);
}

function shouldRewriteTerminalResponse(value: string, toolIterations: number): boolean {
  if (toolIterations === 0) return false;
  return looksLikeContinuationPromise(value)
    || MISLEADING_EXECUTED_NEXT_STEP_RE.test(value)
    || NEXT_TURN_HANDOFF_RE.test(value);
}

function hasRecentUnresolvedDelegatedAction(history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[]): boolean {
  const recentMessages = [...history].reverse().slice(0, 12);

  for (const message of recentMessages) {
    if (message.role !== "tool") continue;

    const metadata = message.metadata ?? {};
    const delegationOutcome = typeof metadata["delegationOutcome"] === "string"
      ? String(metadata["delegationOutcome"]).toLowerCase()
      : undefined;
    const terminalState = typeof metadata["terminalState"] === "string"
      ? String(metadata["terminalState"]).toLowerCase()
      : undefined;
    const content = String(message.content ?? "");

    if (
      delegationOutcome === "partial"
      || delegationOutcome === "failure"
      || terminalState === "max_iterations"
      || terminalState === "timeout"
      || terminalState === "cancelled"
      || /PARTIAL RESULT|max_iterations|timed out|could not complete|delegation limit/i.test(content)
    ) {
      return true;
    }
  }

  return false;
}

function hasRecentWorkflowAuthoringMaintenanceContext(history: readonly { role: string; content?: string | null }[]): boolean {
  let skippedCurrentUser = false;
  let inspectedPriorUserMessages = 0;

  for (const message of [...history].reverse()) {
    if (message.role !== "user") continue;

    const content = String(message.content ?? "").trim();
    if (!content) continue;

    if (!skippedCurrentUser) {
      skippedCurrentUser = true;
      continue;
    }

    inspectedPriorUserMessages += 1;
    const normalized = content.toLowerCase();
    const guidance = buildDynamicTurnGuidance(content);
    const workflowLike = WORKFLOW_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized))
      || WORKFLOW_HINT_TERMS.some((term) => normalized.includes(term));

    if (guidance?.swarmMaintenanceSensitive && workflowLike) {
      return true;
    }

    if (inspectedPriorUserMessages >= 2) {
      break;
    }
  }

  return false;
}

async function rewriteTerminalResponseIfNeeded(
  response: string,
  toolIterations: number,
  session: AgentSession,
  provider: ChatProvider,
  signal: AbortSignal,
): Promise<string> {
  if (!shouldRewriteTerminalResponse(response, toolIterations)) {
    return response;
  }

  const rewritten = await forceSynthesis(
    session,
    provider,
    signal,
    "Write the final user-facing answer for this turn now. This turn is ending. Do NOT promise that you will do another tool call, delegation, orchestration step, or investigation next. Do NOT say 'I will now', 'next orchestration', or similar future-action phrasing unless that action already happened. Do NOT turn a proposed next step into a completed action: phrases in delegated evidence like 'I will now attempt...' or 'the next step...' are not proof that the action ran, and you must not say a next step 'has been executed' unless this turn includes the completed tool result for that action. Either give the best current answer from the gathered evidence or ask one concise user-facing question if a user decision is required.",
  );

  const cleaned = sanitizeUserFacingAssistantResponse(rewritten ?? "", 0);
  return cleaned || response;
}

async function finalizeUserFacingAssistantResponse(
  rawResponse: string,
  toolIterations: number,
  session: AgentSession,
  provider: ChatProvider,
  signal: AbortSignal,
): Promise<string> {
  const cleaned = sanitizeUserFacingAssistantResponse(rawResponse, toolIterations);
  let resolved: string;
  if (!shouldResynthesizeUserFacingResponse(rawResponse, cleaned, toolIterations)) {
    const stableResponse = resolveEmptyAssistantResponseFallback(rawResponse, cleaned, session);
    resolved = await rewriteTerminalResponseIfNeeded(stableResponse, toolIterations, session, provider, signal);
  } else {
    const synthesized = await forceSynthesis(
      session,
      provider,
      signal,
      "You have already executed the necessary tools. Write the final user-facing answer now. Do NOT narrate searches, fetches, document generation, or tool calls. Never include literal [Tool: ...] traces.",
    );
    if (synthesized) {
      const cleanedSynthesized = sanitizeUserFacingAssistantResponse(synthesized, 0);
      if (cleanedSynthesized) {
        resolved = await rewriteTerminalResponseIfNeeded(cleanedSynthesized, toolIterations, session, provider, signal);
      } else {
        const fallback = resolveEmptyAssistantResponseFallback(rawResponse, cleaned, session);
        resolved = await rewriteTerminalResponseIfNeeded(fallback, toolIterations, session, provider, signal);
      }
    } else {
      const fallback = resolveEmptyAssistantResponseFallback(rawResponse, cleaned, session);
      resolved = await rewriteTerminalResponseIfNeeded(fallback, toolIterations, session, provider, signal);
    }
  }

  return await enforceDelegateCoverage(resolved, toolIterations, session, provider, signal);
}

const DELEGATE_TOOL_RESULT_RE = /^(Delegated result from|Parallel delegation completed|Task graph (completed|finished))/i;
const EVIDENCE_SECTION_RE = /^Observed evidence:\s*/m;

function isForcedSynthesisSystemMessage(message: { role: string; content?: string | null }): boolean {
  return message.role === "system"
    && typeof message.content === "string"
    && (
      message.content.startsWith("[SYNTHESIS REQUIRED]")
      || message.content.startsWith("[WARDEN STOP — FORCED SYNTHESIS]")
    );
}

function hasRecentForcedSynthesisNudge(
  history: readonly { role: string; content?: string | null }[],
): boolean {
  const recent = [...history].reverse().slice(0, 16);
  return recent.some((message) => isForcedSynthesisSystemMessage(message));
}

function resolveEmptyAssistantResponseFallback(
  rawResponse: string,
  cleaned: string,
  session: AgentSession,
): string {
  const stableResponse = cleaned || rawResponse.trim();
  if (stableResponse) return stableResponse;

  const history = session.getHistory();
  if (hasRecentForcedSynthesisNudge(history)) {
    const evidence = findRecentDelegateEvidence(history);
    if (evidence) {
      logAudit(
        "guardrail_flagged",
        {
          type: "empty_response_evidence_backstop",
          evidenceLength: evidence.evidence.length,
          evidenceItems: evidence.itemCount,
        },
        { sessionId: session.id, channel: session.channel, severity: "warn" },
      );
      return evidence.evidence;
    }
  }

  return EMPTY_ASSISTANT_RESPONSE_FALLBACK;
}

function looksLikeDelegateMetadata(meta: Record<string, unknown> | undefined): boolean {
  if (!meta) return false;
  if (typeof meta["delegationOutcome"] === "string") return true;
  if (typeof meta["agentName"] === "string") return true;
  if (meta["delegationSucceeded"] === true) return true;
  if (typeof meta["taskCount"] === "number" || typeof meta["succeeded"] === "number") return true;
  return false;
}

function countStructuredItems(text: string): number {
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

function findRecentDelegateEvidence(
  history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[],
): { evidence: string; itemCount: number } | null {
  const recent = [...history].reverse().slice(0, 24);
  let bestCandidate: { evidence: string; itemCount: number; score: number } | null = null;

  for (const message of recent) {
    if (message.role !== "tool") continue;
    const content = String(message.content ?? "");
    const meta = message.metadata ?? {};

    const isDelegate = DELEGATE_TOOL_RESULT_RE.test(content) || looksLikeDelegateMetadata(meta);
    if (!isDelegate) continue;

    const evidenceMatch = EVIDENCE_SECTION_RE.exec(content);
    const evidence = evidenceMatch
      ? content.slice(evidenceMatch.index + evidenceMatch[0].length).trim()
      : content.trim();
    if (!evidence || evidence.length < 400) continue;

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

const EXPLICIT_SOURCE_RECHECK_RE = /\b(verify|verification|check|recheck|validate|validation|source|sources|citation|citations|cite|official|datasheet|spec(?:ification)?s?|price|prices|supplier|suppliers|mouser|digikey|lcsc|aliexpress|search|lookup|look\s+up|find\s+online|recherch|pruef|pruefe|pruefen|verifiz|validier|quelle|quellen|beleg|belege)\b/i;
const CONTEXTUAL_DECISION_FOLLOW_UP_RE = /\b(ok|okay|thx|thanks|thank\s+you|danke|got\s+it|verstanden|we\s+will|we'll|wir\s+werden|wir\s+nutzen|wir\s+nehmen|i\s+will|ich\s+werde|ich\s+nehme|let'?s|lass\s+uns|use\s+them|using\s+them|go\s+with|nehmen\s+wir)\b/i;

function shouldReusePriorDelegateEvidenceForSourceFollowUp(
  userMessage: string,
  guidance: DynamicTurnGuidance | null | undefined,
  priorEvidence: { evidence: string; itemCount: number } | null,
): boolean {
  if (!guidance?.sourceSensitive || guidance.freshnessSensitive || guidance.artifactSensitive) return false;
  if (!priorEvidence || priorEvidence.evidence.length < 400) return false;
  if (EXPLICIT_SOURCE_RECHECK_RE.test(userMessage)) return false;
  if (/[?？]/.test(userMessage)) return false;
  return userMessage.length <= 700 && CONTEXTUAL_DECISION_FOLLOW_UP_RE.test(userMessage);
}

function buildPriorEvidenceFollowUpPrompt(evidence: { evidence: string; itemCount: number }): string {
  return [
    "CONTINUATION FROM PRIOR EVIDENCE: The latest user message appears to accept or refine a previously researched topic, not request fresh verification.",
    "Use the existing delegated evidence and the user's latest decision to answer directly.",
    "Do NOT call tools or delegate again unless the user explicitly asks for new source checks, current prices, supplier availability, or additional external facts.",
    `Prior delegated evidence preview (${evidence.evidence.length} chars, ${evidence.itemCount} structured items): ${truncatePlainText(evidence.evidence, 2200)}`,
  ].join(" ");
}

/**
 * Decide whether to skip the LLM synthesis call entirely and surface the
 * delegated evidence verbatim.  Fires when either the model has been
 * caught looping on rejected tool calls (`synthesis_required_tool_call_rejected`)
 * or the runtime hit max iterations with substantial evidence already in
 * the transcript.  The threshold deliberately accepts modest evidence
 * payloads — operators repeatedly hit the failure mode where 1-2 KB of
 * tool output exists but the synthesis call returns 50-100 chars of
 * apology, leaving the user with effectively no answer.
 */
/**
 * Terminal finish reasons that indicate the runtime is "giving up" after
 * a tool/orchestration loop — there's no useful work left to do, but we
 * still owe the user the evidence we already have.  Extends beyond the
 * original `synthesis_required_tool_call_rejected` to cover:
 *
 *  - `all_tool_calls_blocked`: model kept retrying tools that hit
 *    per-turn caps — operator-visible 73-char "I can't" replies.
 *  - `max_tool_iterations`: hit the iteration cap; the previous fallback
 *    message ("I've gathered partial results...") is technically truthful
 *    but throws away the partial results.
 */
const EVIDENCE_BACKSTOP_GIVE_UP_REASONS = new Set([
  "synthesis_required_tool_call_rejected",
  "all_tool_calls_blocked",
  "max_tool_iterations",
]);

function shouldBypassTerminalSynthesisWithEvidence(
  finishReason: string,
  evidence: { evidence: string; itemCount: number } | null,
): boolean {
  if (!evidence) return false;
  if (!EVIDENCE_BACKSTOP_GIVE_UP_REASONS.has(finishReason)) return false;
  // Threshold: anything materially structured (>= 4 items) OR >= 800 chars
  // is good enough to stand on its own as a backstop answer.  The previous
  // 4000-char / 12-item bar excluded most real-world delegated outputs and
  // forced the runtime through a synthesis path that consistently produced
  // empty / apologetic 50–100 char replies.
  return evidence.itemCount >= 4 || evidence.evidence.length >= 800;
}

/**
 * Catch the post-synthesis case the bypass missed: the synthesis call ran,
 * but came back with a suspiciously short reply while substantial evidence
 * is still sitting in the transcript.  In that situation the answer the
 * user actually wants is the evidence — not whatever 50-100 char fragment
 * the synthesis produced.
 */
function looksLikeUnderpoweredSynthesis(synthesized: string | null): boolean {
  if (synthesized === null) return true;
  const trimmed = synthesized.trim();
  if (trimmed.length === 0) return true;
  // 300 chars is roughly two paragraphs of substantive text — anything
  // shorter for a turn that did real tool work is almost certainly an
  // apology, an empty acknowledgement, or a refusal.
  if (trimmed.length < 300) return true;
  if (looksLikeGenericNoUsableReply(trimmed)) return true;
  // Refusal / apology shapes that don't carry information.
  if (/^(?:i\s+(?:am\s+)?(?:sorry|unable|can(?:not|'?t)|wasn'?t\s+able)|sorry,\s+i)\b/i.test(trimmed)
    && trimmed.length < 600) {
    return true;
  }
  return false;
}

async function enforceDelegateCoverage(
  finalResponse: string,
  toolIterations: number,
  session: AgentSession,
  provider: ChatProvider,
  signal: AbortSignal,
): Promise<string> {
  if (toolIterations === 0) return finalResponse;
  if (!finalResponse || finalResponse.length < 50) return finalResponse;

  const evidence = findRecentDelegateEvidence(session.getHistory());
  if (!evidence) return finalResponse;

  const initialCoverage = measureEvidenceCoverage(finalResponse, evidence);
  const finalItems = initialCoverage.textItems;
  const itemShortfall = initialCoverage.itemShortfall;
  const lengthShortfall = initialCoverage.lengthShortfall;

  if (!itemShortfall && !lengthShortfall) return finalResponse;

  // I14: Hallucinated-truncation detector. When the model's draft answer
  // CLAIMS the evidence is truncated, cut off, abgeschnitten, or "not
  // visible in my context" while substantial structured evidence is
  // actually sitting in the most recent tool result, no amount of
  // re-prompting will fix it — the model has convinced itself the data
  // is gone. Detect that pattern and present the evidence verbatim
  // instead of going through another LLM round-trip that will produce
  // the same hallucination.
  const HALLUCINATED_TRUNCATION_RE =
    /\b(abgeschnitten|truncated|cut off|nicht sichtbar|in meinem Kontext nicht|not visible|content (is|was) (truncated|missing|cut)|Ergebnis(?:blöcke|inhalt) (?:wurden?|ist|sind)\s+(?:hier\s+)?(?:abgeschnitten|nicht)|cannot see|kann (?:ich)? (?:die|den)\s+\w+\s+nicht (?:sehen|finden))/i;
  // Evidence is "rich" when EITHER it has many structured items OR it
  // is large in absolute terms relative to the draft. The item-only
  // gate misses unstructured prose deliverables and bold-numbered
  // headlines that the counter previously missed.
  const evidenceIsRich =
    (evidence.evidence.length >= 1500 && evidence.itemCount >= 5)
    || (evidence.evidence.length >= 1500
        && finalResponse.length < Math.ceil(evidence.evidence.length * 0.3));
  const draftClaimsTruncation = HALLUCINATED_TRUNCATION_RE.test(finalResponse);
  if (evidenceIsRich && draftClaimsTruncation) {
    logAudit(
      "hallucinated_truncation_bypass",
      {
        evidenceLength: evidence.evidence.length,
        evidenceItems: evidence.itemCount,
        finalLength: finalResponse.length,
        finalItems,
        bypassReason: "model_claimed_truncation_with_evidence_present",
      },
      { sessionId: session.id, channel: session.channel, severity: "warn" },
    );
    return evidence.evidence;
  }

  logAudit(
    "coverage_shortfall_resynthesis",
    {
      evidenceLength: evidence.evidence.length,
      evidenceItems: evidence.itemCount,
      finalLength: finalResponse.length,
      finalItems,
      itemShortfall,
      lengthShortfall,
    },
    { sessionId: session.id, channel: session.channel, severity: "warn" },
  );

  // E24: structured synthesis template with evidence enumeration. We give
  // the model a fill-in-the-blanks checklist so it has to visibly account
  // for each item rather than drift into a summary that drops rows.
  const enumerationTemplate = evidence.itemCount >= 3
    ? ` Use this structure:\n\n### All items from the evidence\n1. <first item — full text with source>\n2. <second item — full text with source>\n... continue for all ${evidence.itemCount} items.\n\n### Summary\n<one short paragraph>\n\n`
    : "";
  const instruction = [
    "COVERAGE CORRECTION: Your previous draft answer dropped material from the most recent delegated tool result.",
    `The delegated evidence contained ${evidence.itemCount} structured items (bullets, numbered list rows, or table rows) and ${evidence.evidence.length} characters of content,`,
    `but your draft contained only ${finalItems} items and ${finalResponse.length} characters.`,
    "Rewrite the answer NOW so it includes EVERY item, headline, source, URL, name, number, and source attribution from the delegated evidence above.",
    "If the evidence covers multiple sources (e.g. several news outlets, several repositories, several findings), your answer MUST visibly cover ALL of them \u2014 do not keep only the first source.",
    "Preserve the structure (numbered list, bullets, table) and headings of the evidence.",
    "Do NOT summarize, do NOT trim, do NOT collapse rows into 'and others', do NOT add markers like '(truncated)' or '(abgeschnitten)'.",
    "Do NOT claim the evidence is truncated, cut off, abgeschnitten, or invisible \u2014 the FULL evidence is in the tool result above and you MUST relay it verbatim.",
    "Do NOT call any tools \u2014 the evidence is already collected. Just rewrite the user-facing answer.",
    enumerationTemplate ? `\n\nREQUIRED OUTPUT TEMPLATE:${enumerationTemplate}` : "",
  ].filter(Boolean).join(" ");

  const resynth = await forceSynthesis(session, provider, signal, instruction);
  if (!resynth) {
    // Resynthesis failed entirely. If the original draft was a
    // truncation hallucination and we have rich evidence, bypass.
    if (evidenceIsRich && draftClaimsTruncation) {
      return evidence.evidence;
    }
    return finalResponse;
  }
  const cleanedResynth = sanitizeUserFacingAssistantResponse(resynth, 0);
  if (!cleanedResynth) return finalResponse;
  // I14: If the resynthesis ALSO claims truncation while rich evidence
  // exists, the model is locked into the hallucination. Bypass to the
  // raw evidence rather than ship either bad draft.
  if (evidenceIsRich && HALLUCINATED_TRUNCATION_RE.test(cleanedResynth)) {
    logAudit(
      "hallucinated_truncation_bypass",
      {
        evidenceLength: evidence.evidence.length,
        evidenceItems: evidence.itemCount,
        finalLength: finalResponse.length,
        finalItems,
        resynthLength: cleanedResynth.length,
        bypassReason: "resynthesis_repeated_truncation_claim",
      },
      { sessionId: session.id, channel: session.channel, severity: "warn" },
    );
    return evidence.evidence;
  }
  // Only accept if the resynthesis genuinely improved coverage.
  const resynthCoverage = measureEvidenceCoverage(cleanedResynth, evidence);
  const newItems = resynthCoverage.textItems;
  const improved = cleanedResynth.length > finalResponse.length * 1.2 || newItems > finalItems;
  if (!improved) {
    // Resynthesis did not materially improve the undercovered answer.
    // When rich delegated evidence exists, prefer that evidence over
    // keeping the incomplete summary that triggered correction.
    if (evidenceIsRich) {
      return evidence.evidence;
    }
    return finalResponse;
  }
  if (resynthCoverage.itemShortfall || resynthCoverage.lengthShortfall) {
    logAudit(
      "hallucinated_truncation_bypass",
      {
        evidenceLength: evidence.evidence.length,
        evidenceItems: evidence.itemCount,
        finalLength: finalResponse.length,
        finalItems,
        resynthLength: cleanedResynth.length,
        resynthItems: newItems,
        bypassReason: "resynthesis_still_under_coverage_threshold",
      },
      { sessionId: session.id, channel: session.channel, severity: "warn" },
    );
    return evidence.evidence;
  }
  return await rewriteTerminalResponseIfNeeded(cleanedResynth, toolIterations, session, provider, signal);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateForContext(value: string, maxChars: number): string {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function truncatePlainText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function stripAgentPrefix(value: string): string {
  return value.replace(/^\[[^\]]+\]:\s*/i, "").trim();
}

function stripWorkflowPreamble(value: string): string {
  // Remove "Workflow <name> [scene|job] completed/blocked ...\n\n" system prefix
  // so only the actual deliverable content reaches the orchestrator LLM.
  return value.replace(/^Workflow\s+\S+\s+\[(?:scene|job)\]\s+\S[^\n]*\n\n?/, "").trim();
}

function stripPresentationFormatting(value: string): string {
  return value
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function looksLikeDelegatedFailureEvidence(value: string): boolean {
  const preview = value.trim().slice(0, 600);
  if (!preview) return false;
  if (/^sub-agent produced no final response\.?$/i.test(preview)) return true;
  if (/<\|channel\>\w+/i.test(preview)) return true;
  return /^error:/i.test(preview)
    || /\b(no results|not found|unable to|failed to|timed out|cancelled|incomplete|max.{0,20}iterations|could not complete|did not complete|cannot complete|cannot proceed|delegation limit|already failed|not permitted|produced no final response|no usable delegated result returned)\b/i.test(preview)
    || /\b(container error|containerized delegation failed|sandbox (?:bootstrap|startup|start) failed|bootstrap failed|runtime crash(?:ed)?|terminated unexpectedly)\b/i.test(preview)
    || /\b(blocker:|missing source data|required .* unavailable|requested .* unavailable|not available in the current workspace|not available in the workspace|could not be fulfilled with exact figures|cannot be generated at this time|please provide the structured json data to proceed|please provide the source data to proceed|please provide .*json data|i need .*structured json.* to proceed|i need .*data to proceed|task cannot be completed|table does not exist|confirmed non-existent|no source provided the specific .* data)\b/i.test(preview);
}

const CONTINUATION_CUE_RE = /\b(next (logical )?(step|action)|n[äa]chste (logische )?(schritt|aktion)|before summarizing|continue orchestration|continue with|drill down|inspect the contents|fetch the contents|final required action|determine the actual data file format|extract the raw numerical values)\b/i;
const USER_INTERACTION_CUE_RE = /\b(please confirm|confirm .* before|approval required|needs approval|ask the user|missing .* from the user|which one|which option|clarify|need the user to|authorization reference|approved target scope)\b/i;

type PostOrchestrationDisposition = "continue" | "synthesize" | "ask_user" | "failure" | "none";

export function classifyPostOrchestrationDisposition(
  toolResultMessages: Array<LLMMessage & { metadata?: Record<string, unknown> }>,
): PostOrchestrationDisposition {
  const orchestrationResults = toolResultMessages.filter((message) => {
    const text = typeof message.content === "string" ? message.content : "";
    const isWorkflowExecutionResult = /^Workflow\s+.+\s+\[[^\]]+\]\s+(blocked|completed)\./i.test(text);
    return text.includes("Observed evidence:")
      && (
        text.includes("Delegated result from")
        || text.includes("Parallel delegation completed")
        || text.includes("Task graph completed")
        || isWorkflowExecutionResult
        || text.includes("Ephemeral agent ")
      );
  });

  if (orchestrationResults.length === 0) {
    return "none";
  }

  let sawContinuationCue = false;

  for (const message of orchestrationResults) {
    const text = typeof message.content === "string" ? message.content : "";
    const metadata = message.metadata ?? {};
    const terminalState = typeof metadata["terminalState"] === "string" ? String(metadata["terminalState"]) : undefined;
    const delegationSucceeded = metadata["delegationSucceeded"] !== false;
    const delegationOutcome = typeof metadata["delegationOutcome"] === "string" ? String(metadata["delegationOutcome"]) : undefined;
    const delegationPartial = delegationOutcome === "partial";

    if (USER_INTERACTION_CUE_RE.test(text)) {
      return "ask_user";
    }

    if (
      !delegationSucceeded
      || delegationOutcome === "failure"
      || (!delegationPartial && terminalState && terminalState !== "completed")
      || (!delegationPartial && looksLikeDelegatedFailureEvidence(text))
    ) {
      return "failure";
    }

    // A timed-out partial result carries enough evidence to synthesize from.
    // Force "synthesize" immediately rather than letting the model re-delegate.
    if (delegationPartial && terminalState === "timeout") {
      return "synthesize";
    }

    if (CONTINUATION_CUE_RE.test(text)) {
      sawContinuationCue = true;
    }
  }

  return sawContinuationCue ? "continue" : "synthesize";
}

export function buildModelVisibleToolResult(
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
    const delegationPartial = delegationOutcome === "partial";
    const delegationFailed = delegationOutcome === "failure"
      || (!delegationPartial && (
        metadata?.["delegationSucceeded"] === false
        || /^error:/i.test(cleaned)
        || looksLikeDelegatedFailureEvidence(cleaned)
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

    const evidence = truncatePlainText(cleaned, 1600);
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
        ? "IMPORTANT: The specialist timed out with partial evidence. Use the evidence below to synthesize a final answer now. Do NOT delegate again for this task in this turn."
        : "IMPORTANT: Use the partial evidence below to continue your workflow. Do NOT treat this as a workflow failure. Proceed with any dependent tools.";
      const parts = [
        `Delegated result from ${agentName} — TASK COMPLETED (PARTIAL${timedOut ? ", TIMEOUT" : ""}).`,
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
      ? truncatePlainText(stripWorkflowPreamble(stripAgentPrefix(resultText)), 10_000)
      : evidence;
    const importantNote = isLongDeliverable
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
    const workflowName = typeof metadata?.["workflowName"] === "string" ? String(metadata["workflowName"]) : "workflow";
    const workflowType = typeof metadata?.["workflowType"] === "string" ? String(metadata["workflowType"]) : "workflow";
    const blocked = metadata?.["blocked"] === true;
    const stepCount = Number(metadata?.["stepCount"] ?? 1);
    const executedSteps = Number(metadata?.["executedSteps"] ?? stepCount);
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    return [
      `Workflow ${workflowName} [${workflowType}] ${blocked ? "blocked" : "completed"}. Executed steps: ${executedSteps}/${stepCount}.`,
      blocked
        ? "IMPORTANT: This workflow did not complete. Treat the evidence below as a failure report, not as completed research. Do NOT jump straight to drafting-only agents like paper_author or summarizer unless earlier evidence was already collected successfully."
        : "IMPORTANT: Treat this as executed workflow output, not a plan. Relay the concrete evidence below and do not claim extra steps were run. Do NOT start fresh ad hoc delegation, create_ephemeral_agent, or rerun research for the same request in this turn unless the workflow evidence itself identifies one smallest corrective follow-up.",
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
      "Agent catalog listing only. No delegation has happened yet.",
      "IMPORTANT: Treat this as discovery context, not as proof that any task was routed or executed.",
      `Observed evidence:\n${evidence || "No agent catalog returned."}`,
    ].join("\n");
  }

  return fallback;
}

export function buildTemporalContextPrompt(now: Date = new Date()): string {
  const formattedDate = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const isoDate = now.toISOString().slice(0, 10);
  return [
    `Authoritative temporal context for this turn: today's date is ${formattedDate} (${isoDate}). Current year: ${now.getFullYear()}.`,
    "If the answer mentions the current date, year, recency, deadlines, schedules, or terms like today, latest, current, next, or recent, it must be consistent with this date.",
    "When tool results provide dated evidence, prefer the freshest dated evidence and never fall back to older model memory.",
  ].join(" ");
}

export async function runTurn(opts: RunTurnOptions): Promise<TurnOutput> {
  const config = getConfig();
  // Per-turn timeout — inline override wins, then config, then default 15 min.
  // An explicit override of 0 disables the timeout entirely.
  const resolvedTurnTimeoutMs = opts.turnTimeoutOverrideMs ?? config.gateway?.turnTimeoutMs ?? 1_800_000;
  const turnTimeoutMs = resolvedTurnTimeoutMs > 0 ? resolvedTurnTimeoutMs : undefined;
  const turnAbort = turnTimeoutMs ? new AbortController() : undefined;
  const inertAbort = new AbortController();
  const timeoutHandle = turnAbort
    ? setTimeout(() => turnAbort.abort(), turnTimeoutMs)
    : undefined;

  // Warden abort: allows the Warden to cancel this turn mid-flight on severe anomalies.
  const wardenAbort = new AbortController();
  const sessionId = opts.session.id;
  registerSessionAbortController(sessionId, wardenAbort);

  // Merge caller signal + timeout signal + warden signal: any source can cancel the turn.
  const allSignals: AbortSignal[] = [];
  if (opts.signal) allSignals.push(opts.signal);
  if (turnAbort) allSignals.push(turnAbort.signal);
  allSignals.push(wardenAbort.signal);
  const signal: AbortSignal = allSignals.length === 1
    ? allSignals[0]!
    : AbortSignal.any(allSignals);

  try {
    return await _runTurn(opts, signal, turnAbort?.signal ?? inertAbort.signal);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    deregisterSessionAbortController(sessionId);
  }
}

async function _runTurn(opts: RunTurnOptions, signal: AbortSignal, timeoutSignal: AbortSignal): Promise<TurnOutput> {
  const { session, userMessage } = opts;
  const guardrailEvents: TurnOutput["guardrailEvents"] = [];
  const turnStartedAt = Date.now();
  let firstModelResponseMs: number | undefined;
  let llmCalls = 0;
  let llmTimeMs = 0;
  let toolCallsRequested = 0;
  let toolExecutionTimeMs = 0;
  let lastPromptMetrics = {
    systemPromptChars: 0,
    collapsedHistoryMessages: 0,
    collapsedHistoryChars: 0,
    promptChars: 0,
  };

  // ── Rate limit check ──────────────────────────────────────────────────────
  const rl = await checkRateLimit(session.id, "request");
  if (!rl.allowed) {
    logAudit("rate_limited", { remaining: 0, resetAt: rl.resetAt }, { sessionId: session.id });
    return blocked("Rate limit exceeded. Please wait before sending another message.");
  }

  // ── Input guardrail ───────────────────────────────────────────────────────
  const inputCheck = checkInput(userMessage);
  if (!inputCheck.allowed) {
    const details = inputCheck.reason ?? "Prompt injection detected";
    logAudit("guardrail_blocked", { type: "input", reason: details, patterns: inputCheck.detectedPatterns }, {
      sessionId: session.id,
      severity: "warn",
    });
    guardrailEvents.push({ type: "input_blocked", details });
    return blocked(`I can't process that message: ${details}`);
  }

  if (inputCheck.detectedPatterns && inputCheck.detectedPatterns.length > 0) {
    guardrailEvents.push({ type: "input_flagged", details: inputCheck.reason ?? "" });
    logAudit("guardrail_flagged", { patterns: inputCheck.detectedPatterns }, { sessionId: session.id, severity: "warn" });
  }

  const moderatedInput = await moderateInputText(userMessage);
  if (moderatedInput?.blocked) {
    const details = `Model moderation blocked input: ${moderatedInput.summary}`;
    logAudit("guardrail_blocked", { type: "input_model", reason: details, categories: moderatedInput.categories }, {
      sessionId: session.id,
      severity: "warn",
    });
    guardrailEvents.push({ type: "input_model_blocked", details });
    return blocked(`I can't process that message: ${details}`);
  }

  if (moderatedInput?.flagged) {
    const details = `Model moderation flagged input: ${moderatedInput.summary}`;
    guardrailEvents.push({ type: "input_model_flagged", details });
    logAudit("guardrail_flagged", { type: "input_model", categories: moderatedInput.categories }, { sessionId: session.id, severity: "warn" });
  }

  // ── Build message history ─────────────────────────────────────────────────
  session.addMessage({ role: "user", content: userMessage });
  session.pruneTransientTurnSystemMessages();
  session.incrementTurn();

  logAudit("message_received", { length: userMessage.length }, {
    sessionId: session.id,
    channel: session.channel,
    userId: session.userId,
  });

  const detectedDynamicGuidance = buildDynamicTurnGuidance(userMessage);
  const priorDelegateEvidenceForFollowUp = findRecentDelegateEvidence(session.getHistory());
  const reusePriorDelegateEvidenceForFollowUp = shouldReusePriorDelegateEvidenceForSourceFollowUp(
    userMessage,
    detectedDynamicGuidance,
    priorDelegateEvidenceForFollowUp,
  );
  const effectiveToolMode: MainAssistantToolMode | undefined = detectedDynamicGuidance?.computerAccessSensitive && !detectedDynamicGuidance?.pentestSensitive
    ? "delegate_only"
    : ((detectedDynamicGuidance?.freshnessSensitive || (detectedDynamicGuidance?.sourceSensitive && !reusePriorDelegateEvidenceForFollowUp) || detectedDynamicGuidance?.artifactSensitive)
        ? "orchestration_only"
        : undefined);
  const initialDynamicGuidance = reusePriorDelegateEvidenceForFollowUp
    ? null
    : effectiveToolMode
    ? (buildDynamicTurnGuidance(userMessage, effectiveToolMode) ?? detectedDynamicGuidance)
    : detectedDynamicGuidance;
  const priorEvidenceFollowUpPrompt = reusePriorDelegateEvidenceForFollowUp && priorDelegateEvidenceForFollowUp
    ? buildPriorEvidenceFollowUpPrompt(priorDelegateEvidenceForFollowUp)
    : "";
  let allowedToolNames = getMainAssistantToolNames(effectiveToolMode);
  const suppressAgentCatalogTool = Boolean(
    (initialDynamicGuidance?.freshnessSensitive || initialDynamicGuidance?.sourceSensitive || initialDynamicGuidance?.artifactSensitive)
    && !isExplicitAgentCatalogRequest(userMessage),
  );
  if (suppressAgentCatalogTool) {
    allowedToolNames = allowedToolNames.filter((toolName) => toolName !== "list_agents");
  }
  const allowedToolNameSet = new Set(allowedToolNames);
  const recentWorkflowAuthoringMaintenanceContext = hasRecentWorkflowAuthoringMaintenanceContext(session.getHistory());
  const workflowCatalogSignal = detectWorkflowCatalogSignal(userMessage);
  const approvedRunCandidateFollowUp = detectApprovedRunCandidateFollowUp(session.getHistory(), userMessage);
  const tools = getToolsAsLLMDefs(allowedToolNames);
  // When autoApprove is set, wrap the approvalCallback to always return true.
  const resolvedApprovalCallback = opts.autoApprove
    ? async (_toolName: string, _args: Record<string, unknown>) => true
    : opts.approvalCallback;

  const carriedSwarmTasks = loadPreviousTurnSwarmTasks(session.getHistory());
  const carriedSwarmTaskFingerprint = stableSerialize(carriedSwarmTasks);
  const toolContext: ToolContext = {
    sessionId: session.id,
    workspacePath: session.getWorkspacePath(),
    approvalCallback: resolvedApprovalCallback,
    inputCallback: opts.inputCallback,
    onSubAgentProgress: opts.onSubAgentProgress,
    onComputerAction: opts.onComputerAction,
    onComputerScreenshot: opts.onComputerScreenshot,
    onComputerSessionState: opts.onComputerSessionState,
    allowedAgents: opts.allowedAgents,
    humanInLoopSteps: opts.humanInLoopSteps,
    autoApprove: opts.autoApprove,
    maxIterationsOverride: opts.maxIterationsOverride,
    turnTimeoutOverrideMs: opts.turnTimeoutOverrideMs,
    onSwarmState: opts.onSwarmState,
    signal,
    _workflowExecutionStack: opts._workflowExecutionStack,
    swarmState: {
      objective: userMessage,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Seed from previous turn so retries reuse completed research instead of
      // running the same sub-agent tasks from scratch.
      tasks: carriedSwarmTasks,
    },
  };
  let turnUsedSwarmTools = false;
  const getTurnSwarmState = (): SwarmState | undefined => selectPersistableSwarmState(
    toolContext.swarmState,
    carriedSwarmTasks,
    carriedSwarmTaskFingerprint,
    turnUsedSwarmTools,
  );

  let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let iterationCount = 0;
  // Per-tool output tracking within this turn — detects stuck loops (same result ≥N times).
  const _recentOutputsByTool = new Map<string, string[]>();
  const _turnToolCallCounts = new Map<string, number>();
  const _lastToolResultByName = new Map<string, string>();
  const _lastToolCallSig = new Map<string, { args: string; result: string; metadata?: Record<string, unknown> }>();
  const IDENTICAL_OUTPUT_LOOP_THRESHOLD = 3;
  // Iteration-level loop detection — tracks tool-name sets across iterations.
  const _iterationToolSets: string[] = [];
  const ITERATION_LOOP_THRESHOLD = 4;
  // Assistant text repetition detection — catches the LLM re-emitting identical text each iteration.
  let _lastAssistantContent = "";
  // Per-tool consecutive-iteration streak — catches tools re-appearing even when the full set varies.
  const _toolIterationStreak = new Map<string, number>();
  const TOOL_STREAK_THRESHOLD = 3;
  // Consecutive iterations where every tool call was blocked (per-turn limit / not-allowed).
  let _consecutiveFullyBlockedIterations = 0;
  // D16: Consecutive delegation failures — when ≥2, escalate to warden-stop synthesis.
  let _consecutiveDelegationFailures = 0;
  // I8: Reused-delegation counter — `executeDelegationWithFallback` returns
  // metadata.reused=true when a coordinator paraphrases a task whose
  // signature already completed in this session. After 2 reuses in one turn
  // the coordinator is clearly stuck re-asking for finished work; we stop and
  // synthesize from the cached output instead of burning more LLM iterations.
  let _turnReusedDelegationCount = 0;
  const REUSED_DELEGATION_LOOP_THRESHOLD = 2;
  // F29: Turn-level scorecard accumulators
  let _turnDelegationCount = 0;
  let _turnShareFindingCount = 0;
  let _forcedSynthesisFired = false;
  // G33: Collected share_finding texts for trajectory cache write
  const sharedFindingsThisTurn: string[] = [];
  const FULLY_BLOCKED_ITERATION_THRESHOLD = 2;
  const requiresDelegatedResearch = effectiveToolMode === "orchestration_only"
    && Boolean(initialDynamicGuidance?.freshnessSensitive || initialDynamicGuidance?.sourceSensitive);
  const requiresArtifactDelegation = effectiveToolMode === "orchestration_only"
    && Boolean(initialDynamicGuidance?.artifactSensitive);
  const requiresMaintenanceFollowUpDelegation = recentWorkflowAuthoringMaintenanceContext
    && (allowedToolNameSet.has("delegate_to_agent")
      || allowedToolNameSet.has("parallel_delegate")
      || allowedToolNameSet.has("run_task_graph")
      || allowedToolNameSet.has("create_ephemeral_agent"));
  let delegatedResearchRetryUsed = false;
  let delegatedResearchEnforcementPrompt = "";
  let maintenanceDelegationRetryUsed = false;
  let maintenanceDelegationEnforcementPrompt = "";
  let unresolvedDelegationContinuationRetryUsed = false;
  let unresolvedDelegationEnforcementPrompt = "";
  const isWorkflowExecutionTurn = session.channel === "workflow" || (opts._workflowExecutionStack?.length ?? 0) > 0;
  const workflowCatalogSuppressedForMaintenance = Boolean(
    initialDynamicGuidance?.swarmMaintenanceSensitive || recentWorkflowAuthoringMaintenanceContext,
  );
  const workflowCatalogGuidance = !isWorkflowExecutionTurn && !workflowCatalogSuppressedForMaintenance && workflowCatalogSignal.required
    ? buildWorkflowCatalogGuidance(workflowCatalogSignal)
    : "";
  const approvedRunCandidateGuidance = !isWorkflowExecutionTurn && approvedRunCandidateFollowUp
    ? buildApprovedRunCandidateGuidance(approvedRunCandidateFollowUp)
    : "";
  const workflowCatalogRequired = Boolean(
    (allowedToolNameSet.has("search_workflows") || allowedToolNameSet.has("run_workflow"))
    && !isWorkflowExecutionTurn
    && !initialDynamicGuidance?.pentestMethodologySensitive
    && !workflowCatalogSuppressedForMaintenance
    && workflowCatalogSignal.required
    // Uncertain matches advise the model to ASK the user; they do NOT enforce
    // that a workflow tool must be called this turn.
    && workflowCatalogSignal.reason !== "uncertain_match",
  );
  let workflowCatalogRetryUsed = false;
  let workflowCatalogEnforcementPrompt = "";
  // Seed from history: if the previous turn already ran search_workflows / run_workflow in this
  // session, skip the catalog-check enforcement on the follow-up turn (e.g. "try again").
  // We only look in messages that belong to the immediately prior completed turn — between the
  // second-to-last user message and the current (most recent) user message.
  const workflowCatalogAttemptedInPriorTurn = (() => {
    if (!workflowCatalogRequired) return false;
    const hist = session.getHistory();
    let foundCurrentUser = false;
    for (let i = hist.length - 1; i >= Math.max(0, hist.length - 40); i--) {
      const msg = hist[i];
      if (msg?.role === "user") {
        if (!foundCurrentUser) { foundCurrentUser = true; continue; }
        // Reached the start of the prior turn — stop here
        break;
      }
      if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
        if (msg.tool_calls.some((tc) => isWorkflowCatalogToolName(tc.function.name))) {
          return true;
        }
      }
    }
    return false;
  })();
  let workflowCatalogAttemptedThisTurn = workflowCatalogAttemptedInPriorTurn;
  let workflowExecutionRetryUsed = false;
  let workflowExecutionCorrectionRetryUsed = false;
  let workflowExecutionEnforcementPrompt = "";
  let approvedRunCandidateRetryUsed = false;
  let approvedRunCandidateEnforcementPrompt = "";
  let workflowSearchMatches: WorkflowCatalogMatch[] = [];
  let workflowRunCompletedThisTurn = false;
  let pendingSearchAgentSuggestion: { agentName: string; query?: string; fallbackAgents?: string[] } | undefined;
  let searchAgentsNoMatchCount = 0;
  let requiredResearchFallbackRoute: RequiredResearchFallbackRoute | null = null;
  let searchAgentsNoMatchFallbackPrompt = "";
  const provider = opts.enableThinking !== undefined
    ? getChatProviderWithOverride({ enableThinking: opts.enableThinking })
    : getChatProvider();
  // Tool development sessions have no iteration cap — they use convergence-based completion
  // and lease/heartbeat oversight via the tool-dev-warden instead.
  const isToolDevSession = !!opts._toolDevSessionId;
  const maxToolIterations = isToolDevSession
    ? Number.MAX_SAFE_INTEGER
    : (opts.maxIterationsOverride === 0
        ? Number.MAX_SAFE_INTEGER
        : (opts.maxIterationsOverride ?? getConfig().agents.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS));
  let terminalSynthesisInstruction =
    "You have reached the tool-call limit for this turn. Using ONLY the information gathered in the tool results above, write a complete, useful response to the original request. Do NOT call any more tools. If data is incomplete, acknowledge it and provide the best answer possible with what you have.";
  let terminalFinishReason = "max_tool_iterations";
  const blockMissingWorkflowCatalogCheck = (): TurnOutput => blocked(
    "This request required a workflow catalog check before delegation or a direct answer, but the model skipped the workflow tools.",
    getTurnSwarmState(),
    buildTurnPerformanceMetrics({
      turnStartedAt,
      firstModelResponseMs,
      llmCalls,
      llmTimeMs,
      toolCallsRequested,
      toolExecutionTimeMs,
      lastPromptMetrics,
      completionChars: 0,
      finishReason: "missing_workflow_catalog_check",
      blocked: true,
      toolIterations: iterationCount,
    }),
  );

  // ── G33: Trajectory cache lookup ─────────────────────────────────────────
  // Before the first LLM call, check if we have a cached trajectory for a
  // semantically similar recent query.  If yes, inject it as extra system context
  // so the model can decide whether to reuse or re-research the evidence.
  let trajectoryInjectionContext = "";
  let injectedTrajectoryIdentity: { normalizedQuery: string; finishedAt: string } | null = null;
  try {
    const cachedHit = await lookupTrajectory(
      userMessage,
      session.getWorkspacePath(),
      initialDynamicGuidance?.freshnessSensitive ?? false,
    );
    const cachedTrajectory = cachedHit?.entry ?? null;
    if (cachedTrajectory && cachedTrajectory.finalAnswer.length > 50) {
      const evidence = cachedTrajectory.sharedFindings.length > 0
        ? `\n\nEvidence gathered:\n${cachedTrajectory.sharedFindings.slice(0, 5).map(f => `• ${f.slice(0, 300)}`).join("\n")}`
        : "";
      trajectoryInjectionContext =
        `[CACHED RECENT EVIDENCE — verify before reuse, cached at ${cachedTrajectory.finishedAt}]\n${cachedTrajectory.finalAnswer.slice(0, 1500)}${evidence}`;
      injectedTrajectoryIdentity = {
        normalizedQuery: cachedTrajectory.normalizedQuery,
        finishedAt: cachedTrajectory.finishedAt,
      };
      logAudit(
        "trajectory_cache_hit",
        {
          similarity: Number(cachedHit!.similarity.toFixed(3)),
          ageMs: Date.now() - new Date(cachedTrajectory.finishedAt).getTime(),
          findingsCount: cachedTrajectory.sharedFindings.length,
          finalAnswerChars: cachedTrajectory.finalAnswer.length,
        },
        { sessionId: session.id, channel: session.channel },
      );
    }
  } catch { /* best-effort — never block the turn */ }

  // ── Main agent loop ───────────────────────────────────────────────────────
  while (iterationCount < maxToolIterations) {
    if (signal.aborted) {
      // Only synthesize when the INTERNAL timeout fired — not when the caller (WS) disconnected.
      // Synthesising after a WS close wastes LLM budget: the result can never be delivered.
      const wasInternalTimeout = timeoutSignal.aborted;
      if (wasInternalTimeout && iterationCount > 0) {
        const synthesized = await forceSynthesis(
          session, provider, signal,
          "The request timed out mid-turn. Using ONLY the tool results gathered so far, write the most useful partial response you can. Be explicit about what was completed and what was not.",
        );
        if (synthesized) {
          const finalResponse = sanitizeUserFacingAssistantResponse(synthesized, iterationCount) || synthesized;
          persistAssistantTurnState(session, finalResponse, getTurnSwarmState());
          if (opts.onChunk) opts.onChunk(finalResponse);
          const performance = buildTurnPerformanceMetrics({
            turnStartedAt, firstModelResponseMs, llmCalls, llmTimeMs, toolCallsRequested,
            toolExecutionTimeMs, lastPromptMetrics, completionChars: finalResponse.length,
            finishReason: "aborted_synthesized", blocked: false, toolIterations: iterationCount,
          });
          return {
            response: finalResponse, toolCallsExecuted: iterationCount,
            guardrailEvents, usage: totalUsage, blocked: false,
            swarmState: getTurnSwarmState(), performance,
          };
        }
      }
      return blocked(
        "Request cancelled or timed out",
        getTurnSwarmState(),
        buildTurnPerformanceMetrics({
          turnStartedAt,
          firstModelResponseMs,
          llmCalls,
          llmTimeMs,
          toolCallsRequested,
          toolExecutionTimeMs,
          lastPromptMetrics,
          completionChars: 0,
          finishReason: "aborted",
          blocked: true,
          toolIterations: iterationCount,
        }),
      );
    }

    const systemPrompt = session.getSystemPrompt();
    const temporalContext = buildTemporalContextPrompt();
    const dynamicGuidance = iterationCount === 0 ? initialDynamicGuidance : null;
    const flowGuidance = iterationCount === 0
      ? formatFlowMemoryGuidance(session.getWorkspacePath(), userMessage, { limit: 3 })
      : "";
    const languageAndIdentityGuidance = iterationCount === 0
      ? buildLanguageAndIdentityTurnGuidance(userMessage)
      : "";
    const memoryGuidance = iterationCount === 0
      ? await formatScopedMemoryGuidance(session.getWorkspacePath(), userMessage, {
          sessionId: session.id,
          scopes: ["session", "workspace", "user"],
          limit: 4,
          maxChars: Math.min(1_400, Math.round(getConfig().agents.performance.promptBudgetChars * 0.08)),
        })
      : "";
    const collapsedHistory = session.getCollapsedHistory();
    const systemMessages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "system", content: temporalContext },
      ...(languageAndIdentityGuidance ? [{ role: "system" as const, content: languageAndIdentityGuidance }] : []),
      ...(priorEvidenceFollowUpPrompt ? [{ role: "system" as const, content: priorEvidenceFollowUpPrompt }] : []),
      ...(dynamicGuidance ? [{ role: "system" as const, content: dynamicGuidance.prompt }] : []),
      ...(workflowCatalogGuidance ? [{ role: "system" as const, content: workflowCatalogGuidance }] : []),
      ...(approvedRunCandidateGuidance ? [{ role: "system" as const, content: approvedRunCandidateGuidance }] : []),
      ...(delegatedResearchEnforcementPrompt ? [{ role: "system" as const, content: delegatedResearchEnforcementPrompt }] : []),
      ...(searchAgentsNoMatchFallbackPrompt ? [{ role: "system" as const, content: searchAgentsNoMatchFallbackPrompt }] : []),
      ...(maintenanceDelegationEnforcementPrompt ? [{ role: "system" as const, content: maintenanceDelegationEnforcementPrompt }] : []),
      ...(unresolvedDelegationEnforcementPrompt ? [{ role: "system" as const, content: unresolvedDelegationEnforcementPrompt }] : []),
      ...(workflowCatalogEnforcementPrompt ? [{ role: "system" as const, content: workflowCatalogEnforcementPrompt }] : []),
      ...(approvedRunCandidateEnforcementPrompt ? [{ role: "system" as const, content: approvedRunCandidateEnforcementPrompt }] : []),
      ...(workflowExecutionEnforcementPrompt ? [{ role: "system" as const, content: workflowExecutionEnforcementPrompt }] : []),
      ...(flowGuidance ? [{ role: "system" as const, content: flowGuidance }] : []),
      ...(memoryGuidance ? [{ role: "system" as const, content: memoryGuidance }] : []),
      // G33: Inject cached trajectory evidence on first iteration only
      ...(iterationCount === 0 && trajectoryInjectionContext ? [{ role: "system" as const, content: trajectoryInjectionContext }] : []),
    ];
    lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory);

    // ── Prompt budget check ───────────────────────────────────────────────
    // Warn once per turn on the first iteration if the system prompt exceeds the budget.
    if (iterationCount === 0) {
      const promptBudget = getConfig().agents.performance.promptBudgetChars;
      if (lastPromptMetrics.systemPromptChars > promptBudget) {
        logAudit("prompt_budget_exceeded", {
          systemPromptChars: lastPromptMetrics.systemPromptChars,
          budgetChars: promptBudget,
          excessChars: lastPromptMetrics.systemPromptChars - promptBudget,
          agentId: session.id,
        }, { sessionId: session.id, severity: "warn" });
        log.warn({ sessionPromptChars: lastPromptMetrics.systemPromptChars, budget: promptBudget }, "System prompt exceeds budget — consider trimming history or shortening the system prompt");
      }
    }

    const messages: LLMMessage[] = [...systemMessages, ...collapsedHistory];

    if (iterationCount === 0 && dynamicGuidance) {
      logAudit("turn_guidance_applied", {
        sourceSensitive: dynamicGuidance.sourceSensitive,
        freshnessSensitive: dynamicGuidance.freshnessSensitive,
      }, { sessionId: session.id, severity: "info" });
    } else if (iterationCount === 0 && priorEvidenceFollowUpPrompt) {
      logAudit("turn_guidance_applied", {
        sourceSensitive: false,
        freshnessSensitive: false,
        reusedPriorDelegatedEvidence: true,
        originalSourceSensitive: detectedDynamicGuidance?.sourceSensitive ?? false,
      }, { sessionId: session.id, severity: "info" });
    }

    let llmResponse: LLMResponse;
    const llmStartedAt = Date.now();
    llmCalls += 1;
    try {
      const suppressInitialInlineStreaming = iterationCount === 0 && (
        requiresDelegatedResearch
        || requiresArtifactDelegation
        || workflowCatalogRequired
        || requiresMaintenanceFollowUpDelegation
      );
      const chunkSink = iterationCount === 0 && !suppressInitialInlineStreaming ? opts.onChunk : undefined;
      if (!chunkSink) {
        opts.onStatus?.({
          phase: suppressInitialInlineStreaming ? "routing" : "synthesizing",
          message: suppressInitialInlineStreaming
            ? "Selecting the required specialist path before drafting the answer."
            : "Reviewing completed tool results and preparing the final response.",
          iteration: iterationCount,
        });
      }
      const activeTools = searchAgentsNoMatchFallbackPrompt
        ? tools.filter((tool) => tool.name !== "search_agents" && tool.name !== "list_agents")
        : tools;
      llmResponse = await collectStream(provider.stream(messages, activeTools, signal), chunkSink, {
        deferTextUntilToolDecision: activeTools.length > 0,
      });
      const llmDurationMs = Date.now() - llmStartedAt;
      llmTimeMs += llmDurationMs;
      if (firstModelResponseMs === undefined) {
        firstModelResponseMs = Date.now() - turnStartedAt;
      }
      if (llmResponse.tool_calls.length === 0 && llmResponse.finishReason === "length") {
        const continued = await continueLengthLimitedResponse(provider, messages, llmResponse, signal, chunkSink);
        llmResponse = continued.response;
        llmCalls += continued.additionalCalls;
        llmTimeMs += continued.additionalTimeMs;
      }
    } catch (err) {
      log.error({ err, sessionId: session.id }, "LLM call failed");
      return blocked(
        `LLM error: ${String(err)}`,
        getTurnSwarmState(),
        buildTurnPerformanceMetrics({
          turnStartedAt,
          firstModelResponseMs,
          llmCalls,
          llmTimeMs,
          toolCallsRequested,
          toolExecutionTimeMs,
          lastPromptMetrics,
          completionChars: 0,
          finishReason: "llm_error",
          blocked: true,
          toolIterations: iterationCount,
        }),
      );
    }

    totalUsage.promptTokens += llmResponse.usage.promptTokens;
    totalUsage.completionTokens += llmResponse.usage.completionTokens;
    totalUsage.totalTokens += llmResponse.usage.totalTokens;

    for (const tc of llmResponse.tool_calls) normalizeToolCall(tc);
    llmResponse.tool_calls = collapseDuplicateToolCallsInResponse(llmResponse.tool_calls, session.id, guardrailEvents);
    llmResponse.tool_calls = collapseExcessDirectDelegationsInResponse(llmResponse.tool_calls, session.id, guardrailEvents);
    llmResponse.tool_calls = collapseMixedOrchestrationLaunchersInResponse(llmResponse.tool_calls, session.id, guardrailEvents);
    llmResponse.tool_calls = collapseMixedDiscoveryAndOrchestrationToolsInResponse(llmResponse.tool_calls, session.id, guardrailEvents);

    if (llmResponse.tool_calls.length > 0 && llmResponse.content?.trim()) {
      logAudit("assistant_text_with_tool_calls_suppressed", {
        contentChars: llmResponse.content.length,
        toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
        finishReason: llmResponse.finishReason,
      }, { sessionId: session.id, severity: "warn" });
      guardrailEvents.push({ type: "assistant_text_suppressed", details: "tool_call_response" });
      llmResponse = { ...llmResponse, content: null };
    }

    const workflowCatalogToolRequested = llmResponse.tool_calls.some((toolCall) => isWorkflowCatalogToolName(toolCall.name));
    const runWorkflowRequested = llmResponse.tool_calls.some((toolCall) => toolCall.name === "run_workflow");
    const approvedRunCandidateToolRequested = approvedRunCandidateFollowUp
      ? llmResponse.tool_calls.some((toolCall) => isApprovedRunCandidateToolCall(toolCall, approvedRunCandidateFollowUp))
      : false;
    if (workflowCatalogToolRequested) {
      workflowCatalogAttemptedThisTurn = true;
    }

    if (approvedRunCandidateFollowUp && !workflowRunCompletedThisTurn && !approvedRunCandidateToolRequested) {
      if (!approvedRunCandidateRetryUsed) {
        approvedRunCandidateRetryUsed = true;
        approvedRunCandidateEnforcementPrompt = [
          "COMPLIANCE CORRECTION: the user just approved a recent n8n RUN_CANDIDATE follow-up.",
          `You MUST call run_workflow now with name \"${approvedRunCandidateFollowUp.workflowName}\", workflowType \"${approvedRunCandidateFollowUp.workflowType}\", and params.workflowName \"${approvedRunCandidateFollowUp.candidateName}\".`,
          "Do NOT call search_agents, search_workflows, delegate_to_agent, parallel_delegate, run_task_graph, or give a tool-free answer first.",
          "Any response that skips this exact run_workflow call is invalid for this turn.",
        ].join(" ");
        guardrailEvents.push({ type: "workflow_required", details: "approved_run_candidate_follow_up_rejected" });
        logAudit("guardrail_flagged", {
          type: "approved_run_candidate_follow_up_rejected",
          candidateName: approvedRunCandidateFollowUp.candidateName,
          toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
        }, { sessionId: session.id, severity: "warn" });
        continue;
      }

      return blocked(
        "This turn required running the approved n8n workflow candidate, but the model still skipped the required run_workflow call.",
        getTurnSwarmState(),
        buildTurnPerformanceMetrics({
          turnStartedAt,
          firstModelResponseMs,
          llmCalls,
          llmTimeMs,
          toolCallsRequested,
          toolExecutionTimeMs,
          lastPromptMetrics,
          completionChars: 0,
          finishReason: "missing_approved_run_candidate_execution",
          blocked: true,
          toolIterations: iterationCount,
        }),
      );
    }

    const nonWorkflowOrchestrationRequested = llmResponse.tool_calls.some((toolCall) =>
      ORCHESTRATION_LAUNCHER_TOOL_NAMES.has(toolCall.name) && toolCall.name !== "run_workflow"
    );
    const nonWorkflowDiscoveryRequested = llmResponse.tool_calls.some((toolCall) =>
      AGENT_DISCOVERY_TOOL_NAMES.has(toolCall.name) && toolCall.name !== "search_workflows"
    );
    const repeatedWorkflowSearchRequested = llmResponse.tool_calls.some((toolCall) => toolCall.name === "search_workflows");
    if (
      !workflowCatalogSuppressedForMaintenance
      &&
      shouldRequireWorkflowExecutionAfterSearch(workflowSearchMatches)
      && !workflowRunCompletedThisTurn
      && !runWorkflowRequested
      && (nonWorkflowOrchestrationRequested || nonWorkflowDiscoveryRequested || repeatedWorkflowSearchRequested)
    ) {
      if (!workflowExecutionRetryUsed) {
        workflowExecutionRetryUsed = true;
        workflowExecutionEnforcementPrompt = formatWorkflowExecutionPromptFromSearch(workflowSearchMatches);
        guardrailEvents.push({ type: "workflow_required", details: "workflow_run_required_after_search" });
        logAudit("guardrail_flagged", {
          type: "workflow_run_required_after_search",
          toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
          workflowMatches: workflowSearchMatches.slice(0, 3),
        }, { sessionId: session.id, severity: "warn" });
        continue;
      }

      return blocked(
        "This turn already searched the workflow catalog and found reusable matches, but the model still skipped run_workflow.",
        getTurnSwarmState(),
        buildTurnPerformanceMetrics({
          turnStartedAt,
          firstModelResponseMs,
          llmCalls,
          llmTimeMs,
          toolCallsRequested,
          toolExecutionTimeMs,
          lastPromptMetrics,
          completionChars: 0,
          finishReason: "missing_required_workflow_execution",
          blocked: true,
          toolIterations: iterationCount,
        }),
      );
    }

    if (workflowCatalogRequired && !workflowCatalogAttemptedThisTurn && llmResponse.tool_calls.length > 0) {
      if (!workflowCatalogRetryUsed) {
        workflowCatalogRetryUsed = true;
        workflowCatalogEnforcementPrompt = [
          "COMPLIANCE CORRECTION: This request is workflow-shaped and reusable workflow tools are available.",
          "Do NOT jump straight to delegate_to_agent or a direct natural-language answer.",
          "You MUST inspect the workflow catalog first.",
          ...(workflowCatalogSignal.strongestMatch
            ? [`Strong reusable match: ${workflowCatalogSignal.strongestMatch.name} [${workflowCatalogSignal.strongestMatch.workflowType}].`]
            : []),
          "If the exact reusable scene, job, or workflow is already known, call run_workflow now.",
          "Otherwise call search_workflows now, then either run_workflow or explain the catalog matches honestly.",
          "A catalog-free response is invalid for this turn.",
        ].join(" ");
        guardrailEvents.push({ type: "workflow_required", details: "workflow_catalog_check_rejected" });
        logAudit("guardrail_flagged", {
          type: "workflow_catalog_check_rejected",
          toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
          strongestMatch: workflowCatalogSignal.strongestMatch,
          reason: workflowCatalogSignal.reason,
        }, { sessionId: session.id, severity: "warn" });
        continue;
      }

      return blockMissingWorkflowCatalogCheck();
    }

    const synthesisRequiredInHistory = collapsedHistory.some((message) => isForcedSynthesisSystemMessage(message));
    const userResponseRequiredInHistory = collapsedHistory.some((message) =>
      message.role === "system"
      && typeof message.content === "string"
      && message.content.startsWith("[USER RESPONSE REQUIRED]"),
    );

    if (synthesisRequiredInHistory && llmResponse.tool_calls.length > 0) {
      logAudit("guardrail_flagged", {
        type: "tool_calls_after_synthesis_required",
        toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
      }, { sessionId: session.id, severity: "warn" });
      guardrailEvents.push({ type: "synthesis_required", details: "post_orchestration_tool_call_rejected" });
      _forcedSynthesisFired = true;
      terminalFinishReason = "synthesis_required_tool_call_rejected";
      terminalSynthesisInstruction =
        "A previous orchestration result already required final synthesis, but the model attempted another tool call. Reject that tool call. Using ONLY the evidence already present in the tool results above, write the final user-facing answer now. Do NOT call tools, delegate, search, browse, or promise automatic continuation.";
      opts.onStatus?.({ phase: "synthesizing", message: "Stopping repeated tool calls and writing the answer from gathered evidence.", iteration: iterationCount });
      log.warn({ sessionId: session.id, toolCalls: llmResponse.tool_calls.map((toolCall) => toolCall.name) }, "Model attempted more tool calls after synthesis was required — forcing synthesis");
      break;
    }

    if (userResponseRequiredInHistory && llmResponse.tool_calls.length > 0) {
      logAudit("guardrail_flagged", {
        type: "tool_calls_after_user_response_required",
        toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
      }, { sessionId: session.id, severity: "warn" });
      guardrailEvents.push({ type: "synthesis_required", details: "post_orchestration_tool_call_rejected" });
      _forcedSynthesisFired = true;
      terminalFinishReason = "user_response_required_tool_call_rejected";
      terminalSynthesisInstruction =
        "A previous delegated result requires a user response, clarification, authorization, or approval, but the model attempted another tool call. Reject that tool call. Ask the user the required question in one concise message using only the evidence already present above. Do NOT call tools, delegate, search, browse, or promise automatic continuation.";
      opts.onStatus?.({ phase: "synthesizing", message: "Stopping extra tool calls and preparing the required user-facing question.", iteration: iterationCount });
      log.warn({ sessionId: session.id, toolCalls: llmResponse.tool_calls.map((toolCall) => toolCall.name) }, "Model attempted more tool calls after delegated results required a user response — forcing synthesis");
      break;
    }

    // ── No tool calls — final response ────────────────────────────────────
    // NOTE: do NOT short-circuit on finishReason === "stop" here — many quantized
    // models (LM Studio, Ollama) return finish_reason:"stop" even when they include
    // tool_calls in the same response.  Only treat the turn as complete when there
    // are literally zero tool calls to process.
    if (llmResponse.tool_calls.length === 0) {
      const rawResponse = llmResponse.content ?? "";
      const unresolvedDelegatedActionInHistory = hasRecentUnresolvedDelegatedAction(session.getHistory());
      const promisedContinuationWithoutTools = looksLikeContinuationPromise(rawResponse);
      const promisedMaintenanceExecutionWithoutTools = requiresMaintenanceFollowUpDelegation
        && looksLikeMaintenanceExecutionPromise(rawResponse);

      if (promisedMaintenanceExecutionWithoutTools) {
        if (!maintenanceDelegationRetryUsed) {
          maintenanceDelegationRetryUsed = true;
          maintenanceDelegationEnforcementPrompt = [
            "COMPLIANCE CORRECTION: This is follow-up information for an ongoing workflow-authoring maintenance request.",
            "Do NOT claim that you are creating, generating, or delegating the workflow unless this response actually includes the orchestration tool call.",
            "You MUST call an orchestration tool now.",
            "Prefer delegate_to_agent with swarm_maintainer when available.",
            "A tool-free promise to create the workflow is invalid for this turn.",
          ].join(" ");
          guardrailEvents.push({ type: "delegation_required", details: "tool_free_maintenance_answer_rejected" });
          logAudit("guardrail_flagged", {
            type: "tool_free_maintenance_answer_rejected",
            recentWorkflowAuthoringMaintenanceContext,
          }, { sessionId: session.id, severity: "warn" });
          continue;
        }

        return blocked(
          "This workflow-authoring follow-up required an orchestration tool, but the model only promised the action without executing it.",
          getTurnSwarmState(),
          buildTurnPerformanceMetrics({
            turnStartedAt,
            firstModelResponseMs,
            llmCalls,
            llmTimeMs,
            toolCallsRequested,
            toolExecutionTimeMs,
            lastPromptMetrics,
            completionChars: 0,
            finishReason: "missing_required_maintenance_delegation",
            blocked: true,
            toolIterations: iterationCount,
          }),
        );
      }

      if (workflowCatalogRequired && !workflowCatalogAttemptedThisTurn) {
        if (!workflowCatalogRetryUsed) {
          workflowCatalogRetryUsed = true;
          workflowCatalogEnforcementPrompt = [
            "COMPLIANCE CORRECTION: This request is workflow-shaped and reusable workflow tools are available.",
            "Do NOT answer from memory or promise delegation before checking the workflow catalog.",
            ...(workflowCatalogSignal.strongestMatch
              ? [`Strong reusable match: ${workflowCatalogSignal.strongestMatch.name} [${workflowCatalogSignal.strongestMatch.workflowType}].`]
              : []),
            "You MUST call search_workflows or run_workflow now.",
            "If no reusable workflow matches, explain that only after the catalog check completes.",
            "A tool-free answer is invalid for this turn.",
          ].join(" ");
          guardrailEvents.push({ type: "workflow_required", details: "tool_free_workflow_answer_rejected" });
          logAudit("guardrail_flagged", {
            type: "tool_free_workflow_answer_rejected",
            strongestMatch: workflowCatalogSignal.strongestMatch,
            reason: workflowCatalogSignal.reason,
          }, { sessionId: session.id, severity: "warn" });
          continue;
        }

        return blockMissingWorkflowCatalogCheck();
      }

      if (
        !workflowCatalogSuppressedForMaintenance
        &&
        shouldRequireWorkflowExecutionAfterSearch(workflowSearchMatches)
        && !workflowRunCompletedThisTurn
      ) {
        if (!workflowExecutionRetryUsed) {
          workflowExecutionRetryUsed = true;
          workflowExecutionEnforcementPrompt = formatWorkflowExecutionPromptFromSearch(workflowSearchMatches);
          guardrailEvents.push({ type: "workflow_required", details: "tool_free_workflow_run_rejected" });
          logAudit("guardrail_flagged", {
            type: "tool_free_workflow_run_rejected",
            workflowMatches: workflowSearchMatches.slice(0, 3),
          }, { sessionId: session.id, severity: "warn" });
          continue;
        }

        return blocked(
          "This turn found reusable workflow matches but the model tried to finish without running one.",
          getTurnSwarmState(),
          buildTurnPerformanceMetrics({
            turnStartedAt,
            firstModelResponseMs,
            llmCalls,
            llmTimeMs,
            toolCallsRequested,
            toolExecutionTimeMs,
            lastPromptMetrics,
            completionChars: 0,
            finishReason: "missing_required_workflow_execution",
            blocked: true,
            toolIterations: iterationCount,
          }),
        );
      }

      if (promisedContinuationWithoutTools && unresolvedDelegatedActionInHistory && !unresolvedDelegationContinuationRetryUsed) {
        unresolvedDelegationContinuationRetryUsed = true;
        unresolvedDelegationEnforcementPrompt = [
          "COMPLIANCE CORRECTION: The session already contains an unfinished delegated action from a previous turn.",
          "The user's latest message is follow-up guidance for that unfinished work.",
          "Do NOT write that you will now do something unless this response actually includes the tool call.",
          "You MUST either call the required tool or orchestration tool now, or explicitly state that no action is being executed in this turn.",
          "For server administration follow-ups, prefer delegate_to_agent(agentName: \"shell_agent\", task: \"...\") or ops_triage when diagnosis is needed.",
          "A tool-free continuation promise is invalid for this turn.",
        ].join(" ");
        guardrailEvents.push({ type: "delegation_required", details: "tool_free_continuation_promise_rejected" });
        logAudit("guardrail_flagged", {
          type: "tool_free_continuation_promise_rejected",
          serverAccessSensitive: initialDynamicGuidance?.serverAccessSensitive ?? false,
          computerAccessSensitive: initialDynamicGuidance?.computerAccessSensitive ?? false,
        }, { sessionId: session.id, severity: "warn" });
        continue;
      }

      const currentTurnHasExecutableOrchestration = _turnDelegationCount > 0
        || workflowRunCompletedThisTurn
        || ((_turnToolCallCounts.get("run_workflow") ?? 0) > 0);

      if (requiresArtifactDelegation && !currentTurnHasExecutableOrchestration) {
        if (!delegatedResearchRetryUsed) {
          delegatedResearchRetryUsed = true;
          delegatedResearchEnforcementPrompt = [
            "COMPLIANCE CORRECTION: This request asks for a durable downloadable or viewable artifact.",
            "Do NOT paste the full artifact source into chat.",
            "You MUST call an orchestration tool now so a specialist can write/export the artifact file.",
            "For HTML pages, how-to blogs, documentation pages, or static websites, prefer delegate_to_agent with agentName='content_writer'.",
            "Ask the specialist to save the file as an artifact and publish the artifact path/download details. The final chat answer should be only a concise summary and artifact reference.",
            "A tool-free artifact dump is invalid for this turn.",
          ].join(" ");
          guardrailEvents.push({ type: "delegation_required", details: "tool_free_artifact_answer_rejected" });
          logAudit("guardrail_flagged", {
            type: "tool_free_artifact_answer_rejected",
            artifactSensitive: initialDynamicGuidance?.artifactSensitive ?? false,
          }, { sessionId: session.id, severity: "warn" });
          opts.onStatus?.({ phase: "guardrail", message: "The draft skipped artifact creation, so I am retrying with the required specialist workflow.", iteration: iterationCount });
          continue;
        }

        return blocked(
          "This request required artifact-producing delegation, but the model tried to answer without using an orchestration tool.",
          getTurnSwarmState(),
          buildTurnPerformanceMetrics({
            turnStartedAt,
            firstModelResponseMs,
            llmCalls,
            llmTimeMs,
            toolCallsRequested,
            toolExecutionTimeMs,
            lastPromptMetrics,
            completionChars: 0,
            finishReason: "missing_required_artifact_delegation",
            blocked: true,
            toolIterations: iterationCount,
          }),
        );
      }

      if (requiresDelegatedResearch && !currentTurnHasExecutableOrchestration) {
        if (!delegatedResearchRetryUsed) {
          delegatedResearchRetryUsed = true;
          const route: RequiredResearchFallbackRoute | null = requiredResearchFallbackRoute ?? buildRequiredResearchFallbackRoute(userMessage, initialDynamicGuidance, allowedToolNameSet);
          if (route) {
            requiredResearchFallbackRoute = route;
            searchAgentsNoMatchFallbackPrompt ||= buildSearchAgentsNoMatchFallbackPrompt(route);
          }
          delegatedResearchEnforcementPrompt = route
            ? buildSearchAgentsNoMatchFallbackPrompt(route)
            : [
                "COMPLIANCE CORRECTION: This request requires specialist-agent orchestration.",
                "Do NOT answer directly from memory.",
                "You MUST call an orchestration tool now instead of writing a natural-language answer.",
                "For a simple web lookup, prefer delegate_to_agent with researcher.",
                "For broader multi-step online research, hardware/product verification, component recommendations, or source-backed reports, prefer delegate_to_agent with mission_coordinator. Use web_task_coordinator only for live single-shot lookups or browser-heavy workflows.",
                "A tool-free answer before delegation is invalid for this turn.",
              ].join(" ");
          guardrailEvents.push({ type: "delegation_required", details: "tool_free_research_answer_rejected" });
          logAudit("guardrail_flagged", {
            type: "tool_free_research_answer_rejected",
            freshnessSensitive: initialDynamicGuidance?.freshnessSensitive ?? false,
            sourceSensitive: initialDynamicGuidance?.sourceSensitive ?? false,
          }, { sessionId: session.id, severity: "warn" });
          opts.onStatus?.({ phase: "guardrail", message: "The draft skipped required research orchestration, so I am retrying with a specialist agent.", iteration: iterationCount });
          continue;
        }

        return blocked(
          "This request required delegation to a specialist agent, but the model tried to answer without using an orchestration tool.",
          getTurnSwarmState(),
          buildTurnPerformanceMetrics({
            turnStartedAt,
            firstModelResponseMs,
            llmCalls,
            llmTimeMs,
            toolCallsRequested,
            toolExecutionTimeMs,
            lastPromptMetrics,
            completionChars: 0,
            finishReason: "missing_required_delegation",
            blocked: true,
            toolIterations: iterationCount,
          }),
        );
      }

      // Output guardrail scan
      const outputScan = scanOutput(rawResponse);
      const effectiveToolIterations = promisedContinuationWithoutTools && unresolvedDelegatedActionInHistory
        ? Math.max(iterationCount, 1)
        : iterationCount;
      let finalResponse = await finalizeUserFacingAssistantResponse(rawResponse, effectiveToolIterations, session, provider, signal);

      if (!outputScan.safe && outputScan.redacted) {
        finalResponse = outputScan.redacted;
        guardrailEvents.push({ type: "output_redacted", details: (outputScan.detectedTypes ?? []).join(", ") });
        logAudit("output_redacted", { types: outputScan.detectedTypes }, { sessionId: session.id, severity: "warn" });
      }

      persistAssistantTurnState(session, finalResponse, getTurnSwarmState());

      const performance = buildTurnPerformanceMetrics({
        turnStartedAt,
        firstModelResponseMs,
        llmCalls,
        llmTimeMs,
        toolCallsRequested,
        toolExecutionTimeMs,
        lastPromptMetrics,
        completionChars: finalResponse.length,
        finishReason: llmResponse.finishReason,
        blocked: false,
        toolIterations: iterationCount,
      });

      logAudit("turn_performance", { ...performance, usage: totalUsage }, {
        sessionId: session.id,
        channel: session.channel,
      });

      logAudit("message_sent", { length: finalResponse.length, toolCalls: iterationCount, usage: totalUsage, performance }, {
        sessionId: session.id,
        channel: session.channel,
      });

      // F29: Per-turn quality scorecard
      logAudit("turn_scorecard", {
        delegationCount: _turnDelegationCount,
        shareFindingCount: _turnShareFindingCount,
        forcedSynthesisFired: _forcedSynthesisFired,
        wardenFailureCount: _consecutiveDelegationFailures,
        finalAnswerLength: finalResponse.length,
        toolIterations: iterationCount,
      }, { sessionId: session.id, channel: session.channel });

      // G33: Write trajectory for future cache reuse
      if (_turnShareFindingCount > 0 && finalResponse.length > 50) {
        writeTrajectory(
          {
            channel: session.channel,
            normalizedQuery: userMessage.toLowerCase().trim().slice(0, 300),
            sharedFindings: sharedFindingsThisTurn,
            finalAnswer: finalResponse.slice(0, 2000),
          },
          session.getWorkspacePath(),
          initialDynamicGuidance?.freshnessSensitive ?? false,
        ).catch(() => undefined);
      }

      // E26: close the graph-memory retrieval feedback loop for this turn.
      // A non-blocked turn that produced a substantive answer is treated as a
      // successful outcome — memories retrieved during the turn get credited
      // (wasUseful=true + importance boost). Same signal the sub-agent uses.
      // An apology or stub answer is treated as an unhelpful outcome: the
      // memories were retrieved and still didn't help, so mark them
      // wasUseful=false and apply a modest importance penalty. This is the
      // negative-signal counterpart that closes the E26 loop in both
      // directions rather than relying solely on slow decay.
      const isApology = finalResponse.toLowerCase().startsWith("i apologize");
      if (finalResponse.length > 50 && !isApology) {
        graphMarkSessionRetrievalsUseful(session.id, { boost: 0.04 }).catch(() => {});
        // G33 follow-up: positive signal — the injected cached trajectory
        // contributed to a successful answer. Pairs with `trajectory_cache_hit`
        // and `trajectory_cache_invalidated` so operators can compute the
        // hit-and-helpful rate from the audit log without further plumbing.
        if (injectedTrajectoryIdentity) {
          logAudit(
            "trajectory_cache_used",
            {
              normalizedQuery: injectedTrajectoryIdentity.normalizedQuery.slice(0, 200),
              finishedAt: injectedTrajectoryIdentity.finishedAt,
              finalAnswerChars: finalResponse.length,
              toolIterations: iterationCount,
            },
            { sessionId: session.id, channel: session.channel },
          );
        }
      } else if (finalResponse.length <= 50 || isApology) {
        graphMarkSessionRetrievalsUnhelpful(session.id, { penalty: 0.02 }).catch(() => {});
        // G33 follow-up: if a cached trajectory was injected and the turn
        // still ended in apology / stub, the cached evidence is almost
        // certainly stale or wrong. Invalidate it so future similar
        // queries don't keep inheriting the same bad outcome.
        if (injectedTrajectoryIdentity) {
          invalidateTrajectory(session.getWorkspacePath(), injectedTrajectoryIdentity);
          logAudit(
            "trajectory_cache_invalidated",
            {
              normalizedQuery: injectedTrajectoryIdentity.normalizedQuery.slice(0, 200),
              finishedAt: injectedTrajectoryIdentity.finishedAt,
              reason: isApology ? "apology" : "stub_response",
              finalAnswerChars: finalResponse.length,
            },
            { sessionId: session.id, channel: session.channel, severity: "warn" },
          );
        }
      }

      return {
        response: finalResponse,
        toolCallsExecuted: iterationCount,
        guardrailEvents,
        usage: totalUsage,
        blocked: false,
        swarmState: getTurnSwarmState(),
        performance,
      };
    }

    // ── Assistant text repetition detection ────────────────────────────────
    // If the LLM regenerates nearly identical text across iterations while also
    // requesting tool calls, it is stuck in a regeneration loop.  Break early.
    // Only update _lastAssistantContent when the model actually produced text;
    // tool-only iterations (content=null) should NOT reset the comparison.
    // Whitespace-only content (e.g. "\n\n" left after stripping Qwen3 thinking
    // tags) is not meaningful text — skip the check to avoid false positives.
    if (llmResponse.content && llmResponse.content.trim() && iterationCount >= 2) {
      if (_lastAssistantContent) {
        const curPrefix = llmResponse.content.slice(0, 200);
        const prevPrefix = _lastAssistantContent.slice(0, 200);
        if (curPrefix === prevPrefix) {
          logAudit("tool_loop_detected", {
            reason: "assistant_text_repetition",
            iterations: iterationCount,
            contentPrefix: curPrefix.slice(0, 100),
          }, { sessionId: session.id, severity: "warn" });
          log.warn({ iterationCount }, "Assistant text repeated across iterations — forcing synthesis");
          break; // falls through to forceSynthesis below
        }
      }
      _lastAssistantContent = llmResponse.content;
    }

    // ── Process tool calls ────────────────────────────────────────────────

    session.addMessage({
      role: "assistant",
      content: llmResponse.content,
      tool_calls: llmResponse.tool_calls.map(tc => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    });

    const toolResultMessages: Array<LLMMessage & { metadata?: Record<string, unknown> }> = [];
    let workflowExecutionCorrectionPending = false;
    let workflowExecutionCorrectionExhausted = false;

    for (const tc of llmResponse.tool_calls) {
      if (signal.aborted) break;

      if (requiredResearchFallbackRoute && (tc.name === "search_agents" || tc.name === "list_agents")) {
        const originalTool = tc.name;
        tc.name = requiredResearchFallbackRoute.toolName;
        tc.arguments = { ...requiredResearchFallbackRoute.args };
        logAudit("tool_call_recovered", {
          originalTool,
          rewrittenTo: requiredResearchFallbackRoute.toolName,
          reason: "search_agents_no_match_fallback",
          recoveredAgentName: requiredResearchFallbackRoute.label,
          noMatchCount: searchAgentsNoMatchCount,
        }, { sessionId: session.id, severity: "warn" });
        guardrailEvents.push({ type: "tool_recovered", details: `${originalTool}:search_agents_no_match_fallback` });
      }

      toolCallsRequested += 1;
      // F29: Count delegation and share_finding calls for the turn scorecard
      if (
        tc.name === "delegate_to_agent" ||
        tc.name === "parallel_delegate" ||
        tc.name === "run_task_graph" ||
        tc.name === "swarm_delegate" ||
        tc.name === "create_ephemeral_agent"
      ) {
        _turnDelegationCount += 1;
      } else if (tc.name === "share_finding") {
        _turnShareFindingCount += 1;
        // G33: Collect finding text for trajectory cache
        const findingText = typeof tc.arguments?.["finding"] === "string"
          ? (tc.arguments["finding"] as string).slice(0, 500)
          : typeof tc.arguments?.["content"] === "string"
            ? (tc.arguments["content"] as string).slice(0, 500)
            : "";
        if (findingText) sharedFindingsThisTurn.push(findingText);
      }
      const nextToolCallCount = (_turnToolCallCounts.get(tc.name) ?? 0) + 1;
      _turnToolCallCounts.set(tc.name, nextToolCallCount);
      const perTurnToolLimit = getPerTurnToolCallLimit(tc.name);

      if (perTurnToolLimit && nextToolCallCount > perTurnToolLimit) {
        logAudit("tool_call_blocked", {
          tool: tc.name,
          reason: "per_turn_limit",
          limit: perTurnToolLimit,
          attemptedCallNumber: nextToolCallCount,
        }, {
          sessionId: session.id,
          severity: "warn",
        });
        guardrailEvents.push({ type: "tool_blocked", details: `${tc.name}:per_turn_limit` });

        const limitMessage = `Error: Tool '${tc.name}' call limit (${perTurnToolLimit}) reached for this turn. Stop calling this tool and synthesize your findings or ask the user for the missing information directly.`;
        if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, limitMessage);

        if (tc.name === "delegate_to_agent") {
          const finalResponse = buildDelegationLoopResponse(session, _lastToolResultByName.get(tc.name) ?? "", "limit");
          persistAssistantTurnState(session, finalResponse, getTurnSwarmState());

          const performance = buildTurnPerformanceMetrics({
            turnStartedAt,
            firstModelResponseMs,
            llmCalls,
            llmTimeMs,
            toolCallsRequested,
            toolExecutionTimeMs,
            lastPromptMetrics,
            completionChars: finalResponse.length,
            finishReason: "delegate_loop_terminated",
            blocked: false,
            toolIterations: iterationCount,
          });

          logAudit("turn_performance", { ...performance, usage: totalUsage }, {
            sessionId: session.id,
            channel: session.channel,
            severity: "warn",
          });

          logAudit("message_sent", { length: finalResponse.length, toolCalls: iterationCount, usage: totalUsage, performance }, {
            sessionId: session.id,
            channel: session.channel,
            severity: "warn",
          });

          // F29: Per-turn quality scorecard (delegate-loop-terminated path)
          logAudit("turn_scorecard", {
            delegationCount: _turnDelegationCount,
            shareFindingCount: _turnShareFindingCount,
            forcedSynthesisFired: _forcedSynthesisFired,
            wardenFailureCount: _consecutiveDelegationFailures,
            finalAnswerLength: finalResponse.length,
            toolIterations: iterationCount,
            finishReason: "delegate_loop_terminated",
          }, { sessionId: session.id, channel: session.channel, severity: "warn" });

          return {
            response: finalResponse,
            toolCallsExecuted: iterationCount,
            guardrailEvents,
            usage: totalUsage,
            blocked: false,
            swarmState: getTurnSwarmState(),
            performance,
          };
        }

        toolResultMessages.push({
          role: "tool",
          content: limitMessage,
          tool_call_id: tc.id,
        });
        continue;
      }

      // Rate limit tool calls
      const toolRl = await checkRateLimit(session.id, "tool_call");
      if (!toolRl.allowed) {
        const rateLimitMessage = "Error: Rate limit exceeded for tool calls. Please reduce frequency.";
        if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, rateLimitMessage);
        toolResultMessages.push({
          role: "tool",
          content: rateLimitMessage,
          tool_call_id: tc.id,
        });
        continue;
      }

      if (!allowedToolNameSet.has(tc.name)) {
        // ── Agent-name-as-tool recovery ──────────────────────────────────────
        // Local LLMs sometimes call "computer_use_agent(...)" as if it were a
        // tool, instead of delegate_to_agent(agentName: "computer_use_agent").
        // If the unrecognised tool name matches a configured sub-agent AND
        // delegate_to_agent is available, silently rewrite the call.
        const knownAgents = getConfig().subAgents ?? {};
        if (tc.name in knownAgents && allowedToolNameSet.has("delegate_to_agent")) {
          const recoveredAgentName = tc.name;
          const recoveredTask = typeof tc.arguments?.task === "string"
            ? tc.arguments.task
            : (typeof tc.arguments?.query === "string" ? tc.arguments.query : JSON.stringify(tc.arguments));
          tc.arguments = { agentName: recoveredAgentName, task: recoveredTask };
          tc.name = "delegate_to_agent";
          logAudit("tool_call_recovered", {
            originalTool: recoveredAgentName,
            rewrittenTo: "delegate_to_agent",
            reason: "agent_name_as_tool",
          }, { sessionId: session.id, severity: "info" });
        } else {
        logAudit("tool_call_blocked", { tool: tc.name, reason: "not_in_turn_toolset" }, {
          sessionId: session.id,
          severity: "warn",
        });
        guardrailEvents.push({ type: "tool_blocked", details: `${tc.name}:not_in_turn_toolset` });
        const unavailableMessage = tc.name === "write_file" || tc.name === "export_workspace_artifact"
          ? `Error: Direct artifact tool '${tc.name}' is not available in this turn. Do not retry it directly. Use delegate_to_agent with content_writer or another artifact-capable specialist, or synthesize from existing evidence if no artifact tool is available.`
          : `Error: Tool '${tc.name}' is not available in this turn. Use only the tools that were provided for this request. If this is a desktop-control task, delegate to computer_use_agent instead of calling direct computer_* or browser_* tools.`;
        if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, unavailableMessage);
        toolResultMessages.push({
          role: "tool",
          content: unavailableMessage,
          tool_call_id: tc.id,
        });
        continue;
        }
      }

      // Block disallowed tools
      if (!isToolAllowed(tc.name)) {
        logAudit("tool_call_blocked", { tool: tc.name, reason: "not_allowed" }, {
          sessionId: session.id,
          severity: "warn",
        });
        guardrailEvents.push({ type: "tool_blocked", details: tc.name });
        const blockedMessage = `Error: Tool '${tc.name}' is blocked by security policy.`;
        if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, blockedMessage);
        toolResultMessages.push({
          role: "tool",
          content: blockedMessage,
          tool_call_id: tc.id,
        });
        continue;
      }

      logAudit("tool_call_requested", { tool: tc.name, args: tc.arguments }, { sessionId: session.id });
      if (opts.onToolCall) opts.onToolCall(tc.id, tc.name, tc.arguments);

      // Reject tool calls with unparseable arguments from the LLM
      if (tc.arguments && "_parse_error" in tc.arguments) {
        const rawArgs = (tc.arguments as Record<string, unknown>)["_raw"];
        const intervention = classifyToolIntervention({
          toolName: tc.name,
          success: false,
          error: "Malformed JSON arguments produced by the model",
          malformedArguments: true,
        });
        logAudit("tool_call_failed", {
          tool: tc.name,
          reason: "invalid_arguments",
          raw: String(rawArgs).slice(0, 200),
          issueCode: intervention?.reasonCode,
          intervention,
        }, {
          sessionId: session.id, severity: "warn",
        });
        if (intervention) opts.onIntervention?.(intervention);
        const parseErrorMessage = `Error: Could not parse arguments for tool '${tc.name}'. The arguments were malformed JSON. Do not retry the same large inline payload; synthesize from existing evidence or use a smaller valid tool call.`;
        if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, parseErrorMessage);
        toolResultMessages.push({
          role: "tool",
          content: parseErrorMessage,
          tool_call_id: tc.id,
        });
        continue;
      }

      if (tc.name === "delegate_to_agent") {
        const requestedAgentName = typeof tc.arguments?.["agentName"] === "string"
          ? String(tc.arguments["agentName"]).trim()
          : "";
        if (!requestedAgentName && pendingSearchAgentSuggestion?.agentName) {
          tc.arguments = {
            ...(tc.arguments ?? {}),
            agentName: pendingSearchAgentSuggestion.agentName,
            fallbackAgents: Array.isArray(tc.arguments?.["fallbackAgents"]) && tc.arguments["fallbackAgents"].length > 0
              ? tc.arguments["fallbackAgents"]
              : pendingSearchAgentSuggestion.fallbackAgents,
          };
          logAudit("tool_call_recovered", {
            originalTool: "delegate_to_agent",
            rewrittenTo: "delegate_to_agent",
            reason: "reuse_search_agents_top_result",
            recoveredAgentName: pendingSearchAgentSuggestion.agentName,
            routingQuery: pendingSearchAgentSuggestion.query ?? null,
            recoveredFallbackAgents: pendingSearchAgentSuggestion.fallbackAgents ?? [],
          }, {
            sessionId: session.id,
            severity: "info",
          });
        }
      } else if (tc.name === "swarm_delegate" && pendingSearchAgentSuggestion?.agentName && allowedToolNameSet.has("delegate_to_agent")) {
        tc.name = "delegate_to_agent";
        tc.arguments = {
          ...(tc.arguments ?? {}),
          agentName: pendingSearchAgentSuggestion.agentName,
          fallbackAgents: Array.isArray(tc.arguments?.["fallbackAgents"]) && tc.arguments["fallbackAgents"].length > 0
            ? tc.arguments["fallbackAgents"]
            : pendingSearchAgentSuggestion.fallbackAgents,
        };
        logAudit("tool_call_recovered", {
          originalTool: "swarm_delegate",
          rewrittenTo: "delegate_to_agent",
          reason: "reuse_search_agents_top_result",
          recoveredAgentName: pendingSearchAgentSuggestion.agentName,
          routingQuery: pendingSearchAgentSuggestion.query ?? null,
          recoveredFallbackAgents: pendingSearchAgentSuggestion.fallbackAgents ?? [],
        }, {
          sessionId: session.id,
          severity: "info",
        });
      }

      const argsSig = JSON.stringify(tc.arguments ?? {});
      const cachedToolCall = _lastToolCallSig.get(tc.name);
      if (tc.name !== "delegate_to_agent" && cachedToolCall && cachedToolCall.args === argsSig) {
        const cachedResultText = `${cachedToolCall.result}\n\n[Note: This is a cached result — you already called '${tc.name}' with identical arguments earlier in this turn. Do NOT call it again. Use this result and move to a different step.]`;
        _lastToolResultByName.set(tc.name, cachedToolCall.result);

        logAudit("tool_call_completed", {
          tool: tc.name,
          success: true,
          outputChars: cachedToolCall.result.length,
          metadata: cachedToolCall.metadata,
          cachedResult: true,
          suspiciousReturn: false,
          intervention: null,
        }, {
          sessionId: session.id,
          severity: "warn",
        });

        if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, cachedResultText, cachedToolCall.metadata);

        toolResultMessages.push({
          role: "tool",
          content: buildModelVisibleToolResult(tc.name, cachedResultText, cachedToolCall.metadata),
          tool_call_id: tc.id,
          metadata: cachedToolCall.metadata,
        });

        pendingSearchAgentSuggestion = tc.name === "search_agents"
          ? extractAgentRoutingSuggestionFromMetadata(cachedToolCall.metadata)
          : undefined;

        if (tc.name === "search_agents" && requiresDelegatedResearch && searchAgentsReturnedNoMatch(cachedToolCall.metadata)) {
          searchAgentsNoMatchCount += 1;
          const route: RequiredResearchFallbackRoute | null = requiredResearchFallbackRoute ?? buildRequiredResearchFallbackRoute(userMessage, initialDynamicGuidance, allowedToolNameSet);
          if (route) {
            requiredResearchFallbackRoute = route;
            searchAgentsNoMatchFallbackPrompt = buildSearchAgentsNoMatchFallbackPrompt(route);
            logAudit("guardrail_flagged", {
              type: "agent_discovery_no_match_fallback",
              noMatchCount: searchAgentsNoMatchCount,
              fallbackTool: route.toolName,
              fallbackAgent: route.label,
              cachedResult: true,
            }, { sessionId: session.id, severity: "warn" });
            opts.onStatus?.({ phase: "guardrail", message: "Agent discovery returned no usable match, so I am falling back to a required research specialist instead of searching again.", iteration: iterationCount });
          }
        }
        continue;
      }

      const toolStartedAt = Date.now();
      const result = await executeTool(tc.name, tc.arguments, toolContext);
      if (PERSISTED_SWARM_STATE_TOOL_NAMES.has(tc.name)) {
        turnUsedSwarmTools = true;
      }
      toolExecutionTimeMs += Date.now() - toolStartedAt;
      const intervention = classifyToolIntervention({
        toolName: tc.name,
        success: result.success,
        output: result.output,
        error: result.error,
      });

      logAudit(
        result.success ? "tool_call_completed" : "tool_call_failed",
        {
          tool: tc.name,
          success: result.success,
          error: result.error,
          outputChars: result.output.length,
          metadata: result.metadata,
          issueCode: intervention?.reasonCode,
          suspiciousReturn: result.success && Boolean(intervention),
          intervention,
        },
        { sessionId: session.id, severity: result.success ? "info" : "warn" }
      );

      let resultText = result.success
        ? result.output
        : (result.error?.trim()
            ? `Error: ${result.error}`
            : (result.output.trim() || "Error: Unknown error"));

      const workflowMatchesFromResult = extractWorkflowCatalogMatchesFromMetadata(result.metadata);

      if (tc.name === "search_workflows") {
        workflowSearchMatches = result.success
          ? extractWorkflowCatalogMatchesFromMetadata(result.metadata)
          : [];
      } else if (tc.name === "run_workflow" && workflowMatchesFromResult.length > 0) {
        workflowSearchMatches = mergeWorkflowCatalogMatches(workflowSearchMatches, workflowMatchesFromResult);
      } else if (tc.name === "run_workflow" && result.success) {
        workflowRunCompletedThisTurn = true;
      }

      pendingSearchAgentSuggestion = tc.name === "search_agents"
        ? extractAgentRoutingSuggestionFromMetadata(result.metadata)
        : undefined;

      if (tc.name === "search_agents" && requiresDelegatedResearch && searchAgentsReturnedNoMatch(result.metadata)) {
        searchAgentsNoMatchCount += 1;
        const route: RequiredResearchFallbackRoute | null = requiredResearchFallbackRoute ?? buildRequiredResearchFallbackRoute(userMessage, initialDynamicGuidance, allowedToolNameSet);
        if (route) {
          requiredResearchFallbackRoute = route;
          searchAgentsNoMatchFallbackPrompt = buildSearchAgentsNoMatchFallbackPrompt(route);
          logAudit("guardrail_flagged", {
            type: "agent_discovery_no_match_fallback",
            noMatchCount: searchAgentsNoMatchCount,
            fallbackTool: route.toolName,
            fallbackAgent: route.label,
          }, { sessionId: session.id, severity: "warn" });
          opts.onStatus?.({ phase: "guardrail", message: "Agent discovery returned no usable match, so I am falling back to a required research specialist instead of searching again.", iteration: iterationCount });
        }
      }

      if (
        tc.name === "run_workflow"
        && !result.success
      ) {
        const workflowCorrectionMatches = mergeWorkflowCatalogMatches(workflowSearchMatches, workflowMatchesFromResult);
        const workflowErrorText = result.error?.trim() || resultText;
        if (
          isWorkflowNameResolutionFailureMessage(workflowErrorText)
          && !workflowCatalogSuppressedForMaintenance
          && shouldRequireWorkflowExecutionAfterSearch(workflowCorrectionMatches)
        ) {
          if (!workflowExecutionCorrectionRetryUsed) {
            workflowExecutionCorrectionRetryUsed = true;
            workflowExecutionEnforcementPrompt = formatWorkflowExecutionCorrectionPromptFromSearch(workflowCorrectionMatches, workflowErrorText);
            workflowExecutionCorrectionPending = true;
            guardrailEvents.push({ type: "workflow_required", details: "workflow_run_correction_required" });
            logAudit("guardrail_flagged", {
              type: "workflow_run_correction_required",
              attemptedWorkflowName: typeof tc.arguments?.["name"] === "string" ? tc.arguments["name"] : undefined,
              error: workflowErrorText,
              workflowMatches: workflowCorrectionMatches.slice(0, 3),
            }, { sessionId: session.id, severity: "warn" });
          } else {
            workflowExecutionCorrectionExhausted = true;
          }
        }
      }

      _lastToolResultByName.set(tc.name, resultText);

      // ── Reused-delegation loop detection ─────────────────────────────────
      // When a coordinator keeps paraphrasing the same task, the underlying
      // signature still matches and `executeDelegationWithFallback` returns
      // the cached output with metadata.reused=true. Counting these in-turn
      // catches semantic loops that the byte-equality fingerprint below
      // misses (because each paraphrase mutates the args).
      if (
        tc.name === "delegate_to_agent"
        && result.success
        && (result.metadata as { reused?: unknown } | undefined)?.reused === true
      ) {
        _turnReusedDelegationCount += 1;
        if (_turnReusedDelegationCount >= REUSED_DELEGATION_LOOP_THRESHOLD) {
          logAudit(
            "tool_call_completed",
            {
              tool: tc.name,
              success: true,
              outputChars: result.output.length,
              reusedDelegationLoop: true,
              reusedDelegationCount: _turnReusedDelegationCount,
            },
            { sessionId: session.id, severity: "warn" },
          );
          const finalResponse = buildDelegationLoopResponse(session, result.output, "identical-output");
          persistAssistantTurnState(session, finalResponse, getTurnSwarmState());
          const performance = buildTurnPerformanceMetrics({
            turnStartedAt,
            firstModelResponseMs,
            llmCalls,
            llmTimeMs,
            toolCallsRequested,
            toolExecutionTimeMs,
            lastPromptMetrics,
            completionChars: finalResponse.length,
            finishReason: "delegate_loop_terminated",
            blocked: false,
            toolIterations: iterationCount,
          });
          return {
            response: finalResponse,
            toolCallsExecuted: toolCallsRequested,
            guardrailEvents,
            usage: totalUsage,
            blocked: false,
            swarmState: getTurnSwarmState(),
            performance,
          };
        }
      }

      // ── Identical output loop detection ──────────────────────────────────
      // Track BOTH successes and failures — repeated errors are loops too.
      {
        const outputFingerprint = buildRepeatedOutputFingerprint(tc.name, tc.arguments, resultText);
        const prev = _recentOutputsByTool.get(tc.name) ?? [];
        prev.push(outputFingerprint);
        if (prev.length > IDENTICAL_OUTPUT_LOOP_THRESHOLD) prev.shift();
        _recentOutputsByTool.set(tc.name, prev);

        if (
          prev.length >= IDENTICAL_OUTPUT_LOOP_THRESHOLD &&
          prev.every(o => o === prev[0])
        ) {
          const loopIntervention = classifyToolIntervention({
            toolName: tc.name,
            success: result.success,
            output: result.output,
            error: result.error,
            repeatedIdenticalOutput: true,
          });
          logAudit(
            "tool_call_completed",
            {
              tool: tc.name,
              success: result.success,
              outputChars: result.output.length,
              suspiciousReturn: true,
              repeatedIdenticalOutput: true,
              issueCode: loopIntervention?.reasonCode,
              intervention: loopIntervention,
            },
            { sessionId: session.id, severity: "warn" },
          );

          if (tc.name === "delegate_to_agent") {
            const finalResponse = buildDelegationLoopResponse(session, result.output, "identical-output");
            persistAssistantTurnState(session, finalResponse, getTurnSwarmState());

            const performance = buildTurnPerformanceMetrics({
              turnStartedAt,
              firstModelResponseMs,
              llmCalls,
              llmTimeMs,
              toolCallsRequested,
              toolExecutionTimeMs,
              lastPromptMetrics,
              completionChars: finalResponse.length,
              finishReason: "delegate_loop_terminated",
              blocked: false,
              toolIterations: iterationCount,
            });

            logAudit("turn_performance", { ...performance, usage: totalUsage }, {
              sessionId: session.id,
              channel: session.channel,
              severity: "warn",
            });

            logAudit("message_sent", { length: finalResponse.length, toolCalls: iterationCount, usage: totalUsage, performance }, {
              sessionId: session.id,
              channel: session.channel,
              severity: "warn",
            });

            // F29: Per-turn quality scorecard (identical-output loop terminated path)
            logAudit("turn_scorecard", {
              delegationCount: _turnDelegationCount,
              shareFindingCount: _turnShareFindingCount,
              forcedSynthesisFired: _forcedSynthesisFired,
              wardenFailureCount: _consecutiveDelegationFailures,
              finalAnswerLength: finalResponse.length,
              toolIterations: iterationCount,
              finishReason: "delegate_loop_terminated",
            }, { sessionId: session.id, channel: session.channel, severity: "warn" });

            return {
              response: finalResponse,
              toolCallsExecuted: iterationCount,
              guardrailEvents,
              usage: totalUsage,
              blocked: false,
              swarmState: getTurnSwarmState(),
              performance,
            };
          }

          resultText +=
            `\n\n[System notice: ${tc.name} has returned identical output ${IDENTICAL_OUTPUT_LOOP_THRESHOLD} times in a row. ` +
            `You are stuck in a loop. Do NOT call this tool again. Summarise what you have found so far and report it to the user, or try a clearly different approach.]`;
          if (loopIntervention) opts.onIntervention?.(loopIntervention);
          _recentOutputsByTool.set(tc.name, []); // reset so alert fires at most once per burst
        }
      }

      // Redact any secrets that leaked into the tool output before the LLM ever sees it
      // (DB error messages, SSH banners, etc. can echo credentials back).
      const secretScan = scanOutput(resultText);
      if (!secretScan.safe && secretScan.redacted) {
        resultText = secretScan.redacted;
        guardrailEvents.push({ type: "tool_output_secret_redacted", details: `${tc.name}:${(secretScan.detectedTypes ?? []).join(",")}` });
        logAudit("output_redacted", {
          surface: "tool_output",
          tool: tc.name,
          detectedTypes: secretScan.detectedTypes,
        }, { sessionId: session.id, severity: "warn" });
      }

      // Prevent indirect prompt injection from tool output payloads
      const outCheck = checkToolOutput(resultText);
      if (!outCheck.allowed) {
        const blockedIntervention = classifyToolIntervention({
          toolName: tc.name,
          success: false,
          error: outCheck.reason,
          outputBlocked: true,
        });
        logAudit("tool_output_blocked", {
          tool: tc.name,
          reason: outCheck.reason,
          issueCode: blockedIntervention?.reasonCode,
          intervention: blockedIntervention,
        }, { sessionId: session.id, severity: "error" });
        resultText = "Error: Tool output blocked by guardrails (suspicious payload detected).";
        guardrailEvents.push({ type: "tool_output_blocked", details: tc.name });
        if (blockedIntervention) opts.onIntervention?.(blockedIntervention);
      } else if (intervention) {
        opts.onIntervention?.(intervention);
      }

      if (outCheck.allowed) {
        const moderatedToolResult = await moderateToolResultText(resultText);
        if (moderatedToolResult?.blocked) {
          logAudit("tool_output_blocked", {
            tool: tc.name,
            reason: `Model moderation blocked tool output: ${moderatedToolResult.summary}`,
            categories: moderatedToolResult.categories,
          }, { sessionId: session.id, severity: "error" });
          resultText = "Error: Tool output blocked by model-backed guardrails.";
          guardrailEvents.push({ type: "tool_output_model_blocked", details: tc.name });
        } else if (moderatedToolResult?.flagged) {
          guardrailEvents.push({ type: "tool_output_model_flagged", details: `${tc.name}: ${moderatedToolResult.summary}` });
          logAudit("guardrail_flagged", {
            type: "tool_output_model",
            tool: tc.name,
            categories: moderatedToolResult.categories,
          }, { sessionId: session.id, severity: "warn" });
        }
      }

      _lastToolCallSig.set(tc.name, {
        args: argsSig,
        result: resultText,
        metadata: result.metadata,
      });

      if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, resultText, result.metadata);

      const modelVisibleResultText = buildModelVisibleToolResult(tc.name, resultText, result.metadata);

      toolResultMessages.push({
        role: "tool",
        content: modelVisibleResultText,
        tool_call_id: tc.id,
        metadata: result.metadata,
      });

      if (workflowExecutionCorrectionExhausted) {
        session.addMessages(toolResultMessages);
        return blocked(
          "This turn searched the workflow catalog but still failed to call run_workflow with one of the returned workflow names.",
          getTurnSwarmState(),
          buildTurnPerformanceMetrics({
            turnStartedAt,
            firstModelResponseMs,
            llmCalls,
            llmTimeMs,
            toolCallsRequested,
            toolExecutionTimeMs,
            lastPromptMetrics,
            completionChars: 0,
            finishReason: "invalid_workflow_name_after_search",
            blocked: true,
            toolIterations: iterationCount,
          }),
        );
      }

    }

    session.addMessages(toolResultMessages);

    if (workflowExecutionCorrectionPending) {
      continue;
    }

    // ── Post-orchestration synthesis nudge ─────────────────────────────────
    // When orchestration returns grounded evidence, inject a strong nudge
    // telling the model to synthesize NOW instead of re-delegating for the same data.
    {
      const disposition = classifyPostOrchestrationDisposition(toolResultMessages);
      if (disposition === "synthesize") {
        _consecutiveDelegationFailures = 0;
        session.addMessage({
          role: "system",
          content:
            "[SYNTHESIS REQUIRED] The orchestration results above contain grounded evidence blocks. " +
            "You MUST now write your final answer using ONLY the details from those Observed evidence blocks. " +
            "Do NOT delegate again for the same information — the evidence is already collected. " +
            "Copy the exact names, numbers, values, task states, and statuses from the evidence into your answer.",
        });
      } else if (disposition === "continue") {
        _consecutiveDelegationFailures = 0;
        session.addMessage({
          role: "system",
          content:
            "[CONTINUE ORCHESTRATION] The latest delegated evidence identifies a concrete follow-up action that has not yet been executed. " +
            "You may continue in this same turn if the next action is materially different from prior delegations and directly advances the request. " +
            "Do NOT repeat the same delegation, and do NOT ask for information already present in the evidence. " +
            "Treat delegated phrases like 'I will now attempt...' or 'the next step...' as proposed follow-up work, not proof that it already happened. Do NOT tell the user a next step 'has been executed' unless this turn includes the completed tool result for that action.",
        });
      } else if (disposition === "ask_user") {
        _consecutiveDelegationFailures = 0;
        session.addMessage({
          role: "system",
          content:
            "[USER RESPONSE REQUIRED] The latest delegated evidence indicates that further progress requires clarification, authorization, approval, or another user decision. " +
            "Ask the user yourself in one concise message and do NOT call more tools until they respond.",
        });
      } else if (disposition === "failure") {
        _consecutiveDelegationFailures += 1;
        if (_consecutiveDelegationFailures >= 2) {
          // D16: Warden escalation
          _forcedSynthesisFired = true; // F29
          session.addMessage({
            role: "system",
            content:
              "[WARDEN STOP — FORCED SYNTHESIS] Two or more consecutive delegation attempts have failed. " +
              "You MUST stop delegating and respond to the user now. " +
              "If any partial evidence exists in the evidence blocks above, synthesize it into the best possible answer. " +
              "If there is no usable evidence, tell the user honestly that the information could not be retrieved at this time and suggest what they could do next. " +
              "Do NOT call any more delegation tools in this turn.",
          });
        } else {
          session.addMessage({
            role: "system",
            content:
              "[DELEGATION FAILED] The latest delegated action failed or did not return useful evidence. " +
              "Do NOT retry the same exact delegation. You may attempt a different strategy or ask the user for guidance.",
          });
        }
      }

      if (toolResultMessages.length > 0) {
        session.addMessage({
          role: "system",
          content:
            "[USER INTERACTION OWNERSHIP] The main assistant owns all user-facing interaction. " +
            "If the latest delegated results require clarification, authorization, approval, or another user decision, ask the user yourself in one concise message and stop delegating until they respond. " +
            "If meaningful intermediate results were confirmed and more work still remains, provide a short progress update summarizing what is already known and what remains open. " +
            "Only describe a next action if you are actually going to call another tool in this same turn. Never restate a proposed follow-up from delegated evidence as already executed unless a completed tool result in this turn proves it happened. If synthesis is required or the turn is ending, do not promise automatic continuation.",
        });
      }
    }

    iterationCount++;

    // ── All-blocked iteration guard ────────────────────────────────────────
    // If every tool call in this iteration was blocked (per-turn limit, not-allowed,
    // or parse error) the model is stuck — force synthesis after N such iterations.
    {
      const executed = toolResultMessages.filter(m => {
        const txt = typeof m.content === "string" ? m.content : "";
        return !txt.startsWith("Error:") && !txt.includes("blocked by security policy") && !txt.includes("call limit");
      });
      if (executed.length === 0 && toolResultMessages.length > 0) {
        _consecutiveFullyBlockedIterations++;
      } else {
        _consecutiveFullyBlockedIterations = 0;
      }
      if (_consecutiveFullyBlockedIterations >= FULLY_BLOCKED_ITERATION_THRESHOLD) {
        logAudit("tool_loop_detected", {
          reason: "all_tool_calls_blocked",
          consecutiveBlockedIterations: _consecutiveFullyBlockedIterations,
          iterations: iterationCount,
        }, { sessionId: session.id, severity: "warn" });
        terminalFinishReason = "all_tool_calls_blocked";
        terminalSynthesisInstruction =
          "The model repeatedly attempted tool calls that were blocked or unavailable. Stop trying tools. Using ONLY the evidence already present in the conversation, write the best possible final answer now. If the requested artifact could not be created because the direct file tool was unavailable, say that plainly and do not invent an artifact path.";
        _forcedSynthesisFired = true;
        log.warn({ iterationCount, blocked: _consecutiveFullyBlockedIterations }, "All tool calls blocked for consecutive iterations — forcing synthesis");
        break;
      }
    }

    // ── Iteration-level loop detection ──────────────────────────────────────
    // (a) Identical tool-name set repeating N iterations in a row → force-synthesise.
    const iterToolNames = llmResponse.tool_calls.map(tc => tc.name);
    const iterToolSet = [...iterToolNames].sort().join(",");
    const iterToolSetFullyBoundedByPerTurnCaps = iterToolNames.length > 0
      && iterToolNames.every((toolName) => getPerTurnToolCallLimit(toolName) !== undefined);
    _iterationToolSets.push(iterToolSet);
    if (_iterationToolSets.length > ITERATION_LOOP_THRESHOLD) _iterationToolSets.shift();
    if (
      !iterToolSetFullyBoundedByPerTurnCaps &&
      _iterationToolSets.length >= ITERATION_LOOP_THRESHOLD &&
      _iterationToolSets.every(s => s === _iterationToolSets[0])
    ) {
      logAudit("tool_loop_detected", {
        reason: "iteration_tool_set_repeat",
        toolSet: iterToolSet,
        iterations: iterationCount,
      }, { sessionId: session.id, severity: "warn" });
      log.warn({ iterationCount, toolSet: iterToolSet }, "Same tool-call set repeated across iterations — forcing synthesis");
      break; // falls through to forceSynthesis below
    }

    // (b) Per-tool consecutive-iteration streak — catches "growing" patterns where the
    //     overall tool set changes each iteration but the same core tools keep appearing.
    //     Skip tools that already have a per-turn limit — those are bounded by the limit
    //     and handled by the all-blocked-iterations guard above.
    {
      const currentIterTools = new Set(llmResponse.tool_calls.map(tc => tc.name));
      for (const toolName of currentIterTools) {
        if (!getPerTurnToolCallLimit(toolName)) {
          _toolIterationStreak.set(toolName, (_toolIterationStreak.get(toolName) ?? 0) + 1);
        }
      }
      // Reset streak for tools NOT called in this iteration
      for (const [toolName] of _toolIterationStreak) {
        if (!currentIterTools.has(toolName)) _toolIterationStreak.delete(toolName);
      }
      let streakLoop = false;
      for (const [toolName, streak] of _toolIterationStreak) {
        if (streak >= TOOL_STREAK_THRESHOLD) {
          logAudit("tool_loop_detected", {
            reason: "tool_streak_across_iterations",
            tool: toolName,
            consecutiveIterations: streak,
            iterations: iterationCount,
          }, { sessionId: session.id, severity: "warn" });
          log.warn({ toolName, streak, iterationCount }, "Tool repeated across too many consecutive iterations — forcing synthesis");
          streakLoop = true;
          break;
        }
      }
      if (streakLoop) break; // falls through to forceSynthesis below
    }
  }

  // Exceeded max iterations (or iteration-level loop) — force a synthesis response from the LLM
  opts.onStatus?.({ phase: "synthesizing", message: "Writing the final response from the evidence gathered so far.", iteration: iterationCount });
  const terminalEvidenceBackstop = findRecentDelegateEvidence(session.getHistory());
  const bypassTerminalSynthesis = shouldBypassTerminalSynthesisWithEvidence(terminalFinishReason, terminalEvidenceBackstop);
  const synthesized = bypassTerminalSynthesis
    ? null
    : await forceSynthesis(
        session, provider, signal, terminalSynthesisInstruction,
      );
  // When we have evidence in scope, prefer it over the generic
  // "I've gathered partial results" message — that string was correct
  // about what happened but threw away the partial results.  Only fall
  // back to the static message when no usable evidence exists.
  const fallbackMsg = (bypassTerminalSynthesis && terminalEvidenceBackstop)
    ? terminalEvidenceBackstop.evidence
    : terminalFinishReason === "max_tool_iterations"
      ? "I've gathered partial results but reached the tool-call limit. Please review the tool outputs above for details."
      : resolveEmptyAssistantResponseFallback("", "", session);
  // Second-chance evidence backstop.  Even when the synthesis call ran,
  // it often comes back with an apologetic 50-200 char reply while
  // substantial structured evidence sits in the transcript — the exact
  // "all the info, no answer" failure mode operators report.  When the
  // synthesis is underpowered AND we have evidence available, prefer the
  // evidence.  Strictly post-hoc — doesn't change cases where synthesis
  // genuinely produced a real answer.
  const useEvidenceOverSynthesis = !bypassTerminalSynthesis
    && terminalEvidenceBackstop
    && looksLikeUnderpoweredSynthesis(synthesized);
  if (useEvidenceOverSynthesis && terminalEvidenceBackstop) {
    logAudit("sub_agent_synthesis_forced", {
      reason: "underpowered_synthesis_replaced_with_evidence",
      finishReason: terminalFinishReason,
      synthesizedLength: synthesized?.length ?? 0,
      evidenceLength: terminalEvidenceBackstop.evidence.length,
      evidenceItems: terminalEvidenceBackstop.itemCount,
    }, { sessionId: session.id, severity: "warn" });
  }
  const finalCandidate = useEvidenceOverSynthesis && terminalEvidenceBackstop
    ? terminalEvidenceBackstop.evidence
    : (synthesized ?? fallbackMsg);
  const normalizedFinalMsg = sanitizeUserFacingAssistantResponse(finalCandidate, iterationCount) || fallbackMsg;
  const evidenceBackstopMsg = looksLikeGenericNoUsableReply(normalizedFinalMsg)
    ? (terminalEvidenceBackstop?.evidence ?? resolveEmptyAssistantResponseFallback("", "", session))
    : normalizedFinalMsg;
  const finalMsg = await rewriteTerminalResponseIfNeeded(evidenceBackstopMsg, iterationCount, session, provider, signal);
  persistAssistantTurnState(session, finalMsg, getTurnSwarmState());
  if (opts.onChunk) opts.onChunk(finalMsg);

  const performance = buildTurnPerformanceMetrics({
    turnStartedAt,
    firstModelResponseMs,
    llmCalls,
    llmTimeMs,
    toolCallsRequested,
    toolExecutionTimeMs,
    lastPromptMetrics,
    completionChars: finalMsg.length,
    finishReason: terminalFinishReason,
    blocked: false,
    toolIterations: iterationCount,
  });
  logAudit("turn_performance", { ...performance, usage: totalUsage }, {
    sessionId: session.id,
    channel: session.channel,
    severity: "warn",
  });
  logAudit("message_sent", { length: finalMsg.length, toolCalls: iterationCount, usage: totalUsage, performance }, {
    sessionId: session.id,
    channel: session.channel,
    severity: "warn",
  });
  logAudit("turn_scorecard", {
    delegationCount: _turnDelegationCount,
    shareFindingCount: _turnShareFindingCount,
    forcedSynthesisFired: _forcedSynthesisFired,
    wardenFailureCount: _consecutiveDelegationFailures,
    finalAnswerLength: finalMsg.length,
    toolIterations: iterationCount,
    finishReason: terminalFinishReason,
  }, { sessionId: session.id, channel: session.channel, severity: "warn" });
  return {
    response: finalMsg,
    toolCallsExecuted: iterationCount,
    guardrailEvents,
    usage: totalUsage,
    blocked: false,
    swarmState: getTurnSwarmState(),
    performance,
  };
}

/**
 * Inject a synthesis prompt and make one final LLM call with no tools.
 * Used when the turn hits max iterations or is cancelled mid-flight.
 * Returns null if the synthesis call itself fails or is aborted.
 */
async function forceSynthesis(
  session: AgentSession,
  provider: ChatProvider,
  signal: AbortSignal,
  instruction: string,
): Promise<string | null> {
  try {
    // Don't attempt synthesis if already aborted and we have nothing
    if (signal.aborted && session.getHistory().length < 3) return null;

    // Inject a synthesize-now user message (not stored in permanent history)
    const messages: LLMMessage[] = [
      { role: "system", content: session.getSystemPrompt() },
      { role: "system", content: buildTemporalContextPrompt() },
      ...session.getCollapsedHistory(),
      { role: "user", content: `[SYSTEM INSTRUCTION — RESPOND NOW]: ${instruction}` },
    ];

    // Use a fresh 60s timeout — independent of the (possibly already aborted) turn signal
    const synthAbort = new AbortController();
    const synthTimer = setTimeout(() => synthAbort.abort(), 60_000);

    // E25: prefer the synthesis-tier provider when configured — smaller,
    // instruction-tuned models produce tighter final answers and avoid the
    // reasoning-model tendency to re-narrate tool calls during rewrite.
    const synthesisProvider = getChatProviderForTier("synthesis") ?? provider;

    try {
      const response = await synthesisProvider.complete(messages, [], synthAbort.signal);
      const text = response.content?.trim();
      return text || null;
    } finally {
      clearTimeout(synthTimer);
    }
  } catch {
    return null;
  }
}

function blocked(reason: string, swarmState?: SwarmState, performance?: TurnPerformanceMetrics): TurnOutput {
  return {
    response: reason,
    toolCallsExecuted: 0,
    guardrailEvents: [{ type: "blocked", details: reason }],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    blocked: true,
    swarmState,
    performance,
  };
}

/**
 * Walk backward through session history and extract completed/partial swarm
 * tasks from the most recent assistant message that has persisted swarm state.
 *
 * These are seeded into the new turn's swarmState.tasks so that, on a retry,
 * sub-agents see prior research and skip re-running identical tasks instead of
 * doing all the work from scratch.
 *
 * Only `completed` and `partial` tasks are carried forward. `failed`, `running`,
 * `pending`, and `blocked` tasks are dropped so they can be re-attempted cleanly.
 */
function loadPreviousTurnSwarmTasks(history: readonly SessionHistoryMessage[]): SwarmState["tasks"] {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    if (msg.role !== "assistant") continue;
    const raw = msg.metadata?.["swarmState"];
    if (!raw || typeof raw !== "object") continue;
    const prev = raw as SwarmState;
    if (!prev.tasks) continue;
    const carried: SwarmState["tasks"] = {};
    for (const [id, task] of Object.entries(prev.tasks)) {
      if (task.status === "completed" || task.status === "partial") {
        carried[id] = task;
      }
    }
    // Only return if there is something worth carrying forward
    if (Object.keys(carried).length > 0) return carried;
  }
  return {};
}

function buildPersistableSwarmTaskDelta(
  currentTasks: SwarmState["tasks"],
  carriedTasks: SwarmState["tasks"],
): SwarmState["tasks"] {
  const delta: SwarmState["tasks"] = {};

  for (const [taskId, task] of Object.entries(currentTasks)) {
    const carriedTask = carriedTasks[taskId];
    if (!carriedTask) {
      delta[taskId] = task;
      continue;
    }

    const carriedAttempts = carriedTask.attempts ?? [];
    const currentAttempts = task.attempts ?? [];
    const nextAttempts = currentAttempts.slice(carriedAttempts.length);
    const carriedOutput = typeof carriedTask.output === "string" ? carriedTask.output : "";
    const currentOutput = typeof task.output === "string" ? task.output : "";
    const carriedError = typeof carriedTask.error === "string" ? carriedTask.error : "";
    const currentError = typeof task.error === "string" ? task.error : "";
    const outputChanged = currentOutput !== carriedOutput;
    const errorChanged = currentError !== carriedError;
    const statusChanged = task.status !== carriedTask.status;

    if (nextAttempts.length === 0 && !outputChanged && !errorChanged && !statusChanged) {
      continue;
    }

    delta[taskId] = {
      ...task,
      attempts: nextAttempts,
      output: outputChanged ? task.output : undefined,
      error: errorChanged ? task.error : undefined,
    };
  }

  return delta;
}

function selectPersistableSwarmState(
  swarmState: SwarmState | undefined,
  carriedTasks: SwarmState["tasks"],
  carriedTaskFingerprint: string,
  usedSwarmTools: boolean,
): SwarmState | undefined {
  if (!swarmState) return undefined;
  const currentTasks = swarmState.tasks ?? {};
  if (Object.keys(currentTasks).length === 0) return undefined;
  const persistableTasks = buildPersistableSwarmTaskDelta(currentTasks, carriedTasks);
  if (Object.keys(persistableTasks).length === 0) {
    return undefined;
  }
  if (!usedSwarmTools && stableSerialize(currentTasks) === carriedTaskFingerprint) {
    return undefined;
  }
  return {
    ...swarmState,
    tasks: persistableTasks,
  };
}

function persistAssistantTurnState(session: AgentSession, content: string, swarmState?: SwarmState): void {
  if (swarmState) {
    session.addMessage({
      role: "assistant",
      content,
      metadata: { swarmState: structuredClone(swarmState) },
    });
    return;
  }

  session.addMessage({ role: "assistant", content });
}

function appendNonDuplicatedContinuation(existing: string, continuation: string): string {
  if (!continuation) return existing;
  if (!existing) return continuation;
  if (existing.endsWith(continuation)) return existing;

  const maxOverlap = Math.min(existing.length, continuation.length, MAX_CONTINUATION_OVERLAP_CHARS);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (existing.slice(-size) === continuation.slice(0, size)) {
      return `${existing}${continuation.slice(size)}`;
    }
  }

  return `${existing}${continuation}`;
}

async function continueLengthLimitedResponse(
  provider: ChatProvider,
  baseMessages: readonly LLMMessage[],
  initialResponse: LLMResponse,
  signal: AbortSignal,
  onChunk?: (text: string) => void,
): Promise<{ response: LLMResponse; additionalCalls: number; additionalTimeMs: number }> {
  let response: LLMResponse = { ...initialResponse, tool_calls: [...initialResponse.tool_calls] };
  let additionalCalls = 0;
  let additionalTimeMs = 0;

  for (let attempt = 0; attempt < MAX_LENGTH_CONTINUATION_ATTEMPTS; attempt += 1) {
    if (response.finishReason !== "length" || response.tool_calls.length > 0 || signal.aborted) {
      break;
    }

    const partialContent = response.content ?? "";
    if (!partialContent.trim()) {
      break;
    }

    const continuationMessages: LLMMessage[] = [
      ...baseMessages,
      { role: "assistant", content: partialContent },
      {
        role: "user",
        content: [
          "Continue your previous response exactly where it stopped.",
          "Return only the next continuation chunk.",
          "Do not restart the answer, do not repeat earlier lines, do not add a new introduction, and do not call tools.",
        ].join(" "),
      },
    ];

    const continuationStartedAt = Date.now();
    const continuationResponse = await collectStream(provider.stream(continuationMessages, [], signal), onChunk);
    additionalCalls += 1;
    additionalTimeMs += Date.now() - continuationStartedAt;

    response = {
      content: appendNonDuplicatedContinuation(partialContent, continuationResponse.content ?? ""),
      tool_calls: continuationResponse.tool_calls,
      usage: {
        promptTokens: response.usage.promptTokens + continuationResponse.usage.promptTokens,
        completionTokens: response.usage.completionTokens + continuationResponse.usage.completionTokens,
        totalTokens: response.usage.totalTokens + continuationResponse.usage.totalTokens,
      },
      finishReason: continuationResponse.finishReason,
    };
  }

  return { response, additionalCalls, additionalTimeMs };
}

function measurePrompt(systemMessages: readonly LLMMessage[], history: readonly LLMMessage[]): {
  systemPromptChars: number;
  collapsedHistoryMessages: number;
  collapsedHistoryChars: number;
  promptChars: number;
} {
  const systemPromptChars = systemMessages.reduce((sum, message) => {
    const contentLength = typeof message.content === "string" ? message.content.length : 0;
    return sum + contentLength;
  }, 0);
  const collapsedHistoryChars = history.reduce((sum, message) => {
    const contentLength = typeof message.content === "string" ? message.content.length : 0;
    return sum + contentLength;
  }, 0);
  return {
    systemPromptChars,
    collapsedHistoryMessages: history.length,
    collapsedHistoryChars,
    promptChars: systemPromptChars + collapsedHistoryChars,
  };
}

/**
 * Consume a streaming LLM generator into a complete LLMResponse.
 * Optionally defers text until the response is known not to contain tool calls.
 */
async function collectStream(
  generator: AsyncGenerator<StreamChunk>,
  onChunk?: (text: string) => void,
  options: { deferTextUntilToolDecision?: boolean } = {},
): Promise<LLMResponse> {
  let content = "";
  const toolCallBuffers = new Map<string, { id: string; name: string; args: string }>();
  let finishReason = "stop";
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let sawToolCall = false;

  for await (const chunk of generator) {
    if (chunk.type === "text_delta" && chunk.content) {
      content += chunk.content;
      if (!options.deferTextUntilToolDecision) {
        onChunk?.(chunk.content);
      }
    } else if (chunk.type === "tool_call_start" && chunk.toolCallId && chunk.toolName) {
      sawToolCall = true;
      toolCallBuffers.set(chunk.toolCallId, { id: chunk.toolCallId, name: chunk.toolName, args: "" });
    } else if (chunk.type === "tool_call_delta" && chunk.toolCallId && chunk.argumentsDelta) {
      const buf = toolCallBuffers.get(chunk.toolCallId);
      if (buf) buf.args += chunk.argumentsDelta;
    } else if (chunk.type === "done") {
      if (chunk.finishReason) finishReason = chunk.finishReason;
      if (chunk.usage) usage = chunk.usage;
    }
  }

  const tool_calls = [...toolCallBuffers.values()].map(buf => ({
    id: buf.id,
    name: buf.name,
    arguments: (() => {
      try { return JSON.parse(buf.args) as Record<string, unknown>; }
      catch { return { _parse_error: true, _raw: buf.args } as Record<string, unknown>; }
    })(),
  }));

  if (options.deferTextUntilToolDecision && onChunk && !sawToolCall && content) {
    onChunk(content);
  }

  return { content: content || null, tool_calls, usage, finishReason };
}

function buildTurnPerformanceMetrics(input: {
  turnStartedAt: number;
  firstModelResponseMs?: number;
  llmCalls: number;
  llmTimeMs: number;
  toolCallsRequested: number;
  toolExecutionTimeMs: number;
  lastPromptMetrics: {
    systemPromptChars: number;
    collapsedHistoryMessages: number;
    collapsedHistoryChars: number;
    promptChars: number;
  };
  completionChars: number;
  finishReason: string;
  blocked: boolean;
  toolIterations: number;
}): TurnPerformanceMetrics {
  return {
    turnDurationMs: Date.now() - input.turnStartedAt,
    firstModelResponseMs: input.firstModelResponseMs,
    llmCalls: input.llmCalls,
    llmTimeMs: input.llmTimeMs,
    toolCallsRequested: input.toolCallsRequested,
    toolExecutionTimeMs: input.toolExecutionTimeMs,
    systemPromptChars: input.lastPromptMetrics.systemPromptChars,
    collapsedHistoryMessages: input.lastPromptMetrics.collapsedHistoryMessages,
    collapsedHistoryChars: input.lastPromptMetrics.collapsedHistoryChars,
    promptChars: input.lastPromptMetrics.promptChars,
    completionChars: input.completionChars,
    toolIterations: input.toolIterations,
    finishReason: input.finishReason,
    blocked: input.blocked,
  };
}
