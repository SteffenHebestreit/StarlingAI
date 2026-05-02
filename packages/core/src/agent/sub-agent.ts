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
import { appendOutcome, computeAdaptiveSubAgentTimeoutMs, extractTaskKeywords } from "./outcomes.js";
import { formatFlowMemoryGuidance } from "./flow-memory.js";
import { acquireSlot, releaseSlot, DEFAULT_CONCURRENCY } from "../swarm/concurrency.js";
import { createChatProvider, getChatProviderForTier, resolveProviderEndpoint } from "../providers/index.js";
import { computerSessionManager } from "./computer-session.js";
import { formatScopedMemoryGuidance } from "../memory/service.js";
import { graphMarkSessionRetrievalsUseful, graphMarkSessionRetrievalsUnhelpful } from "../memory/graph-service.js";
import { isSessionDegraded } from "./warden.js";
import { consumeAgentMessages } from "../swarm/memory.js";
import { sanitizeTranscriptContent } from "./sanitize-response.js";
import { truncateToolResult } from "../tools/result-shaping.js";
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
  web_search: 6,
  web_fetch: 12,
  search_workflows: 2,
  run_workflow: 2,
  computer_click: 6,
  computer_type: 4,
  computer_hotkey: 4,
  delegate_to_agent: 3,
  swarm_delegate: 3,
  create_ephemeral_agent: 1,
};

const COORDINATOR_SUB_AGENT_PER_TOOL_CAP_OVERRIDES: Partial<Record<string, number>> = {
  delegate_to_agent: 6,
  swarm_delegate: 6,
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

function resolveSubAgentToolCap(toolName: string, isCoordinatorAgent: boolean): number | undefined {
  if (isCoordinatorAgent) {
    const override = COORDINATOR_SUB_AGENT_PER_TOOL_CAP_OVERRIDES[toolName];
    if (override !== undefined) {
      return override;
    }
  }
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
      return [
        "TASK MODE - QUICK INBOX CHECK.",
        "For this task, call a mail_* read tool immediately before writing any narrative.",
        "If the account is unspecified, call mail_list_accounts first.",
        "Then prefer mail_list_unread or mail_search, and call mail_read only for the few messages you summarize.",
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
    guidance.push("Call list_agents when you need the full delegate catalog with descriptions and tool access.");
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
    catalogLines.push(`- ${catalogNames.length - 24} more configured agents are available; use list_agents or search_agents to inspect them.`);
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
    const via = task.selectedAgent ? ` via ${task.selectedAgent}` : "";
    return `- ${task.id} [${task.status}] ${task.title}${via}${summary ? ` | ${summary.replace(/\s+/g, " ").slice(0, 220)}` : ""}`;
  });

  return lines.join("\n");
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
}): string {
  const swarmSummary = formatSwarmProgressForInterruption(params.swarmState);
  const progressLines: string[] = [];

  if (swarmSummary) {
    progressLines.push(swarmSummary);
  }

  if (params.toolCount > 0) {
    const uniqueToolNames = [...new Set(params.toolNames)].slice(0, 8);
    progressLines.push(`- Tool calls executed: ${params.toolCount}${uniqueToolNames.length > 0 ? ` (${uniqueToolNames.join(", ")})` : ""}`);
  }

  if (params.iterations > 0) {
    progressLines.push(`- Iterations completed: ${params.iterations}`);
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

  const evidenceSnippets = (params.evidenceSnippets ?? []).filter(Boolean).slice(-4);
  if (evidenceSnippets.length > 0) {
    progressLines.push("Recovered evidence snippets from completed tools:");
    for (const snippet of evidenceSnippets) {
      progressLines.push(`- ${snippet}`);
    }
  }

  if (progressLines.length === 0) {
    return `Sub-agent '${params.agentName}' ${params.reason}`;
  }

  return `Sub-agent '${params.agentName}' ${params.reason}\nPartial progress before interruption:\n${progressLines.join("\n")}`;
}

type SubAgentOutcome = "success" | "partial" | "failure";

function looksLikePlanningOnlyResult(result: string): boolean {
  const preview = result.slice(0, 600).trim();
  if (!preview) return false;

  const startsLikePlanning = /^\s*(let me|now let me|first let me|i(?:'m| am) going to|i(?:'ll| will)|i(?:'m| am) trying to|i need to|next,? i(?:'m| am) going to)\b/i.test(preview);
  if (!startsLikePlanning) return false;

  const planningAction = /\b(try|attempt|start|check|verify|fetch|get|gather|collect|retrieve|research|search|look for|look up|read|download|continue|proceed|focus|click|type|open|inspect|retry|use|switch|launch|list|attach|create)\b/i.test(preview);
  if (!planningAction) return false;

  const unresolvedMarker = /\b(sessionid|session id|empty string|null|again|different approach|tool list|available tools)\b/i.test(preview);
  const terminalMarker = /\b(completed|done|finished|succeeded|successfully|typed|opened|clicked|verified|failed|error|could not|did not)\b/i.test(preview);
  return !terminalMarker && (unresolvedMarker || preview.length <= 220);
}

function looksLikeFailureResult(result: string): boolean {
  if (!result.trim()) return true;
  const preview = result.slice(0, 600);
  if (/^sub-agent produced no final response\.?$/i.test(preview.trim())) {
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

    if (["generate_document", "generate_pdf", "generate_chart_html", "generate_mermaid_diagram", "export_workspace_artifact"].includes(sourceTool)) {
      return true;
    }

    return ["html", "pdf", "markdown", "json", "text", "mermaid"].includes(previewMode)
      || contentType.startsWith("text/markdown")
      || contentType.startsWith("text/html")
      || contentType.startsWith("application/pdf")
      || contentType.startsWith("application/json");
  });
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
  return text
    .replace(/<\|channel\>\w+\s*/g, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<function=[^>]*>[\s\S]*?<\/function>/g, "")
    .replace(/<\/tool_call>/g, "")
    .trim();
}

function summarizeMailBody(text: string, maxLength = 220): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "No body preview available.";
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`;
}

export interface SubAgentRunOptions {
  agentName: string;
  task: string;
  context?: string;
  parentSessionId: string;
  workspacePath: string;
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
  // I13: Mutable so the cascade-timeout fallback can inject web_search +
  // web_fetch when all delegations have failed and a coordinator agent
  // would otherwise be left with no working capability.
  let effectiveToolNames = getEffectiveToolNames(opts.agentName, agentCfg.tools, sanitizedTask);
  const timeoutAbort = turnTimeoutMs ? new AbortController() : undefined;
  const timeoutHandle = timeoutAbort
    ? setTimeout(() => timeoutAbort.abort(), turnTimeoutMs)
    : undefined;
  const signal = opts.signal && timeoutAbort
    ? AbortSignal.any([opts.signal, timeoutAbort.signal])
    : opts.signal ?? timeoutAbort?.signal;

  const subSessionId = `sub:${opts.parentSessionId}:${opts.agentName}:${Date.now()}`;

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
    //      (opt-out model — closed GAP-1 from ROADMAP)
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
        outcome: "success",
        terminalState: "completed",
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
    const taskModeGuidance = buildTaskModeGuidance(opts.agentName, sanitizedTask);
    const modelExecutionGuidance = buildModelExecutionGuidance(modelConfig.primary, modelConfig.enableThinking);
    const toolInventoryGuidance = buildSubAgentToolInventory(effectiveToolNames);
    const agentDiscoveryGuidance = isOrchestrationCapableRun(effectiveToolNames)
      ? buildSubAgentAgentDiscoveryGuidance(opts.agentName, opts.allowedAgents)
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
      ? `${agentCfg.systemPrompt}${modelExecutionGuidance ? `\n\n${modelExecutionGuidance}` : ""}${taskModeGuidance ? `\n\n${taskModeGuidance}` : ""}${toolInventoryGuidance ? `\n\n${toolInventoryGuidance}` : ""}${agentDiscoveryGuidance ? `\n\n${agentDiscoveryGuidance}` : ""}${degradedNudge ? `\n\n${degradedNudge}` : ""}\n\nAgent name: ${opts.agentName}\nCurrent workspace: ${opts.workspacePath}\nToday's date: ${today}${flowGuidance ? `\n\n${flowGuidance}` : ""}${memoryGuidance ? `\n\n${memoryGuidance}` : ""}`
      : `You are a specialized AI sub-agent named "${opts.agentName}". Complete the given task and return your result.${toolInventoryGuidance ? `\n\n${toolInventoryGuidance}` : ""}${agentDiscoveryGuidance ? `\n\n${agentDiscoveryGuidance}` : ""}${degradedNudge ? `\n\n${degradedNudge}` : ""}\n\nAgent name: ${opts.agentName}\nCurrent workspace: ${opts.workspacePath}\nToday's date: ${today}${flowGuidance ? `\n\n${flowGuidance}` : ""}${memoryGuidance ? `\n\n${memoryGuidance}` : ""}`;

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
      currentAgentName: opts.agentName,
      allowedAgents: opts.allowedAgents,
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

    // Build initial message
    const userContent = opts.context
      ? `Context:\n${opts.context}${a2aContext}\n\nTask: ${sanitizedTask}`
      : `${sanitizedTask}${a2aContext}`;

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
    let cascadeSynthesisForced = false;
    let sufficiencySynthesisNudged = false;
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
        evidenceSnippets: recentEvidenceSnippets,
      });
      log.warn(
        { agentName: opts.agentName, toolCount, successfulToolCount, iterations, planningOnlyResponse },
        "Sub-agent completed substantive work but produced no usable final narrative — returning partial progress summary",
      );
      return { result: recovered, forcedOutcome: "partial" };
    };

    const attemptTimeoutSynthesis = async (): Promise<SubAgentRunResult | null> => {
      if (!turnTimeoutMs || toolCount === 0 || !history.some((message) => message.role === "tool") || opts.signal?.aborted) {
        return null;
      }

      const graceTimeoutMs = Math.max(1_500, Math.min(5_000, Math.round(turnTimeoutMs * 0.1)));
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

    if (opts.agentName === "mail_agent" && isMailInboxReadTask(sanitizedTask)) {
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
        && !timeoutAbort?.signal.aborted
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

      if (signal?.aborted) {
        if (timeoutAbort?.signal.aborted && turnTimeoutMs) {
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
            error: `timeout (${turnTimeoutMs}ms) reached`,
          });
          const output = buildInterruptedSubAgentOutput({
            agentName: opts.agentName,
            reason: `timed out after ${turnTimeoutMs}ms`,
            swarmState: toolContext.swarmState,
            toolNames,
            toolCount,
            iterations,
            artifacts,
          });
          const stats = buildStats("timeout", interruptedOutcome);
          logSubAgentCompletionAudit(stats, output, { timeoutMs: turnTimeoutMs }, "warn");
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
        if (timeoutAbort?.signal.aborted && turnTimeoutMs) {
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
            error: `timeout (${turnTimeoutMs}ms) reached`,
          });
          const output = buildInterruptedSubAgentOutput({
            agentName: opts.agentName,
            reason: `timed out after ${turnTimeoutMs}ms`,
            swarmState: toolContext.swarmState,
            toolNames,
            toolCount,
            iterations,
            artifacts,
          });
          const stats = buildStats("timeout", interruptedOutcome);
          logSubAgentCompletionAudit(stats, output, { timeoutMs: turnTimeoutMs }, "warn");
          return withArtifacts({
            output,
            stats,
          });
        }
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
          });
          const stats = buildStats("cancelled", interruptedOutcome);
          logSubAgentCompletionAudit(stats, output, { cancelled: true }, "warn");
          return withArtifacts({
            output,
            stats,
          });
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

      history.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls.map(tc => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });

      const toolResults: LLMMessage[] = [];
      let decisiveDirectRemoteToolResult: import("../tools/registry.js").ToolResult | null = null;
      let decisiveDirectRemoteToolName: string | null = null;

      for (const tc of response.tool_calls) {
        if (signal?.aborted) break;
        toolCount++;

        // Enforce tool allow-list
        if (effectiveToolNames && !effectiveToolNames.includes(tc.name)) {
          log.warn({ agentName: opts.agentName, tool: tc.name }, "Sub-agent attempted disallowed tool");
          logAudit(
            "sub_agent_tool_blocked",
            { agentName: opts.agentName, tool: tc.name, reason: "not_in_agent_tools" },
            { sessionId: subSessionId, severity: "warn" }
          );
          toolResults.push({
            role: "tool",
            content: `Tool '${tc.name}' is not in this agent's allowed tool set.`,
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

        // Per-tool call cap — prevent wasteful loops on a single tool
        const priorCount = perToolCallCount.get(tc.name) ?? 0;
        const toolCap = resolveSubAgentToolCap(tc.name, isCoordinatorAgent);
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
        if (prev && prev.args === argsSig) {
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
        // timeout-summary stanzas so we don't double-count them as
        // "evidence" — they are negative signal, already counted above.
        if (
          result.success
          && !/^(All candidate agents failed|Tool '[^']+' has been called|Tool '[^']+' is)/i.test(resultContent)
        ) {
          const usefulPortion = resultContent.replace(
            /Sub-agent '[^']+' timed out after \d+ms[\s\S]{0,400}?(?=\n\n|$)/g,
            "",
          );
          cumulativeUsefulEvidenceBytes += usefulPortion.length;
          if (usefulPortion.length >= 180) {
            const snippet = truncateToolAuditText(usefulPortion, 900);
            if (snippet) {
              recentEvidenceSnippets = [...recentEvidenceSnippets, `${tc.name}: ${snippet}`].slice(-6);
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
        !sufficiencySynthesisNudged
        && !cascadeSynthesisForced
        && cumulativeUsefulEvidenceBytes >= 3_000
        && toolResults.length > 0
        && toolNames.some((name) =>
          name === "delegate_to_agent"
          || name === "parallel_delegate"
          || name === "swarm_delegate"
          || name === "run_task_graph"
          || name === "web_search"
          || name === "web_fetch"
          || name === "browser_navigate")
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
    const maxIterationsOutput = workflowPassthroughOutput
      ? maybePreferWorkflowOutput(workflowPassthroughOutput, workflowPassthroughOutput, toolNames)
      : completedFromArtifact
      ? buildArtifactCompletionOutput({
          agentName: opts.agentName,
          maxIterations,
          artifacts,
        })
      : `Sub-agent '${opts.agentName}' reached the maximum number of tool-call iterations (${maxIterations}). Partial result may be incomplete.`;
    const maxIterationsStats = completedFromArtifact
      ? buildStats("completed", "success")
      : buildStats("max_iterations", "partial");
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
