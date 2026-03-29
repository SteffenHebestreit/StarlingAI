/**
 * Agent Runtime — the main agent loop.
 * LLM call → parse tool calls → execute (with guardrails) → loop → final response
 */
import { getChatProvider, getChatProviderWithOverride } from "../providers/index.js";
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
import type { AgentSession } from "./session.js";
import { classifyToolIntervention, type InterventionNotice } from "./interventions.js";
import { getMainAssistantToolNames, type MainAssistantToolMode } from "./default-tools.js";

const log = childLogger("agent:runtime");

const DEFAULT_MAX_TOOL_ITERATIONS = 20;
const PER_TURN_TOOL_CALL_LIMITS: Partial<Record<string, number>> = {
  delegate_to_agent: 3,
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
const FRESHNESS_HINT_TERMS = [
  "aktuell", "aktuelle", "aktuellen", "heute", "jetzt", "live", "neu", "neueste", "neusten",
  "letzte ziehung", "letzten ziehung", "gewinnzahlen", "zahlen heute",
  "2025", "2026", "current", "currently", "fresh", "latest", "live", "new", "news", "now",
  "recent", "recently", "today", "updated", "updates",
];
const SOURCE_HINT_TERMS = [
  "beleg", "belege", "offizielle quelle", "offizielle quellen", "quelle", "quellen",
  "cite", "cites", "citation", "citations", "docs", "documentation", "official", "release notes",
  "repo", "repository", "roadmap", "source", "sources", "spec", "specification", "standard",
];
const COMPUTER_ACCESS_HINT_TERMS = [
  "use my computer", "access my computer", "my computer", "my pc", "my machine",
  "remote windows pc", "remote pc", "remote desktop", "rdp", "vnc",
  "work on it", "work on my", "control my computer", "connect to my pc",
  "local desktop", "local windows desktop", "lokalen desktop", "localen desktop", "lokaler desktop",
];
const OWNED_COMPUTER_ACCESS_PATTERNS = [
  /\b(my|our)\s+(remote\s+)?(windows\s+|linux\s+|mac\s+|macos\s+)?(pc|computer|machine|workstation|desktop|laptop)\b/,
  /\b(access|control|connect to|use|work on)\s+(my|our)\s+(remote\s+)?(windows\s+|linux\s+|mac\s+|macos\s+)?(pc|computer|machine|workstation|desktop|laptop)\b/,
];
const PENTEST_HINT_TERMS = [
  "pentest", "security test", "security assessment", "vulnerability", "vuln", "scan",
  "nmap", "nikto", "sqlmap", "exploit", "cve", "audit", "hardening",
];

export interface RunTurnOptions {
  session: AgentSession;
  userMessage: string;
  onChunk?: (text: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string, metadata?: Record<string, unknown>) => void;
  onComputerAction?: (action: { computerSessionId: string; actionType: string; [key: string]: unknown }) => void;
  onComputerScreenshot?: (screenshot: { computerSessionId: string; dataUrl: string; width: number; height: number; [key: string]: unknown }) => void;
  onComputerSessionState?: (sessionState: { computerSessionId: string; state: string; [key: string]: unknown }) => void;
  onIntervention?: (notice: InterventionNotice) => void;
  onSwarmState?: (state: SwarmState) => void;
  approvalCallback?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  signal?: AbortSignal;
  /** Sub-agents this turn is allowed to delegate to (undefined = no restriction) */
  allowedAgents?: string[];
  /** Tool names that must pause for human approval this turn (enforced unconditionally) */
  humanInLoopSteps?: string[];
  /** Auto-approve all tool calls this turn — skips the approvalCallback gate entirely. */
  autoApprove?: boolean;
  /** Override sub-agent maxIterations for delegated tasks this turn. */
  maxIterationsOverride?: number;
  /** Override the per-turn timeout in ms (replaces config gateway.turnTimeoutMs). */
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

export interface DynamicTurnGuidance {
  prompt: string;
  sourceSensitive: boolean;
  freshnessSensitive: boolean;
  computerAccessSensitive?: boolean;
  pentestSensitive?: boolean;
}

export function getPerTurnToolCallLimit(toolName: string): number | undefined {
  return PER_TURN_TOOL_CALL_LIMITS[toolName];
}

export function buildDelegationLoopResponse(latestOutput: string, reason: "identical-output" | "limit" = "identical-output"): string {
  const normalized = latestOutput.trim() || "The delegated agent returned no usable output.";
  const intro = reason === "limit"
    ? "Delegation limit reached for this turn. The delegated agent is still asking for the same missing information."
    : "Delegation loop detected. The delegated agent is still returning the same response.";
  return `${intro}\n\nLatest delegated response:\n\n${normalized}`;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateForContext(value: string, maxChars: number): string {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function stripAgentPrefix(value: string): string {
  return value.replace(/^\[[^\]]+\]:\s*/i, "").trim();
}

function stripPresentationFormatting(value: string): string {
  return value
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

export function buildModelVisibleToolResult(
  toolName: string,
  resultText: string,
  metadata?: Record<string, unknown>,
): string {
  const fallback = truncateForContext(resultText, 600);

  if (toolName === "delegate_to_agent") {
    const agentName = typeof metadata?.["agentName"] === "string" ? String(metadata["agentName"]) : "delegated agent";
    const attemptedAgents = Array.isArray(metadata?.["attemptedAgents"])
      ? (metadata?.["attemptedAgents"] as unknown[]).map(String).filter(Boolean)
      : [];
    const routingReason = metadata?.["routingReason"] && typeof metadata["routingReason"] === "object"
      ? metadata["routingReason"] as Record<string, unknown>
      : undefined;
    const cleaned = stripPresentationFormatting(stripAgentPrefix(resultText));
    const summary = truncateForContext(cleaned, 320);
    const parts = [
      `Delegated result from ${agentName}.`,
      attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
      routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
      `Result summary: ${summary || "No usable delegated result returned."}`,
    ].filter(Boolean);
    return parts.join(" ");
  }

  if (toolName === "parallel_delegate") {
    const succeeded = Number(metadata?.["succeeded"] ?? 0);
    const failed = Number(metadata?.["failed"] ?? 0);
    const taskCount = Number(metadata?.["taskCount"] ?? succeeded + failed);
    return `Parallel delegation completed. Successful tasks: ${succeeded}/${taskCount}. Failed tasks: ${failed}. Result summary: ${truncateForContext(resultText, 260)}`;
  }

  if (toolName === "run_task_graph") {
    const completed = Array.isArray(metadata?.["completed"]) ? (metadata?.["completed"] as unknown[]).length : 0;
    const failed = Array.isArray(metadata?.["failed"]) ? (metadata?.["failed"] as unknown[]).length : 0;
    const blocked = Array.isArray(metadata?.["blocked"]) ? (metadata?.["blocked"] as unknown[]).length : 0;
    return `Task graph completed. Nodes completed: ${completed}. Failed: ${failed}. Blocked: ${blocked}. Result summary: ${truncateForContext(resultText, 260)}`;
  }

  if (toolName === "create_ephemeral_agent") {
    const agentName = typeof metadata?.["agentName"] === "string" ? String(metadata["agentName"]) : "ephemeral agent";
    const rejectedTools = Array.isArray(metadata?.["rejectedTools"]) ? (metadata?.["rejectedTools"] as unknown[]).map(String).filter(Boolean) : [];
    return `Ephemeral agent ${agentName} completed. ${rejectedTools.length > 0 ? `Rejected tools: ${rejectedTools.join(", ")}. ` : ""}Result summary: ${truncateForContext(stripPresentationFormatting(stripAgentPrefix(resultText)), 260)}`;
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

export function buildDynamicTurnGuidance(userMessage: string, toolMode: MainAssistantToolMode = getConfig().agents.mainAssistant.toolMode): DynamicTurnGuidance | null {
  const normalized = userMessage.trim().toLowerCase();
  if (!normalized) return null;

  const freshnessSensitive = FRESHNESS_HINT_TERMS.some((term) => normalized.includes(term));
  const sourceSensitive = SOURCE_HINT_TERMS.some((term) => normalized.includes(term));
  const computerAccessSensitive = COMPUTER_ACCESS_HINT_TERMS.some((term) => normalized.includes(term))
    || OWNED_COMPUTER_ACCESS_PATTERNS.some((pattern) => pattern.test(normalized));
  const pentestSensitive = PENTEST_HINT_TERMS.some((term) => normalized.includes(term));

  if (!freshnessSensitive && !sourceSensitive && !computerAccessSensitive) return null;

  const reasons: string[] = [];
  if (freshnessSensitive) reasons.push("freshness-sensitive");
  if (sourceSensitive) reasons.push("source-sensitive");
  if (computerAccessSensitive && !pentestSensitive) reasons.push("owned-computer-access");

  const delegateMode = toolMode !== "hybrid";
  const promptParts: string[] = [];

  if (reasons.length > 0) {
    promptParts.push(`This turn is ${reasons.join(" and ")}.`);
  }

  if (computerAccessSensitive && !pentestSensitive) {
    promptParts.push(
      "The user is asking you to access or operate their own computer or remote workstation, not to run a security assessment.",
      "Do not route this request to pentest_set_scope, nmap_scan, or other pentest tools unless the user explicitly asks for scanning, vulnerability testing, or exploitation.",
      "You MUST use the delegate_to_agent tool with agentName='computer_use_agent' to handle all computer-use and VS Code interaction tasks. Pass the full user request as the task, including any specific targets like window titles, input fields, or text to type. If the user mentions a specific IP or hostname, include it in the task context so the agent can match it to a configured node or create an ad-hoc connection.",
      "Do NOT attempt to call computer_* or vscode_* tools directly — they are NOT in your tool set. Do NOT call 'computer_use_agent' as a tool name — it is an agent, not a tool. Use delegate_to_agent(agentName='computer_use_agent', task='...') instead.",
      "The computer_use_agent has access to computer_list_nodes which discovers pre-configured machines. If the user asks for a specific machine by IP, hostname, or description, include that in the delegation context. The agent will match it to a node or create an ad-hoc connection.",
      "If the user asks for their local desktop or local Windows desktop, include in the task context that the computer_use_agent should prefer adapter 'remote_node' rather than 'local_vscode' unless the user explicitly asked to control the VS Code workbench itself.",
      "If delegation to computer_use_agent returns a partial or incomplete result, you may retry delegation ONCE with a more specific task description. Do NOT fall back to calling computer_* tools directly — they are NOT in your tool set and will fail.",
      "CRITICAL: If the computer_use_agent has already failed or been exhausted for this turn, do NOT retry it again. Synthesize from whatever partial results you have and tell the user what happened.",
      "Ignore prior pentest-related tool results unless the user explicitly switches back to security testing.",
    );
  }

  if (freshnessSensitive || sourceSensitive) {
    promptParts.push(
      delegateMode
        ? "Do not answer from memory. Delegate immediately to a suitable specialist agent for any web lookup, freshness-sensitive fact, or browser-dependent step."
        : "Use direct web tools before answering if they are available.",
      "A tool-free answer is invalid unless prior tool results already contain the necessary evidence for this exact request.",
      delegateMode
        ? "Use delegate_to_agent for simple specialist routing. For multi-step specialist collaboration, delegate to a coordinator-style agent that can orchestrate researcher, browser, and evidence-analysis agents."
        : "Start with web_search. Use web_fetch only if the search snippets are insufficient.",
      "For live factual values such as lottery numbers, prices, scores, exchange rates, dates, or schedules, copy the exact value and its associated date from the freshest tool result. Do not substitute prior knowledge or older values.",
      delegateMode
        ? "If a page is JS-driven, route it through a browser specialist. If another agent needs the extracted evidence, ensure the browser specialist publishes key facts with share_finding so downstream agents can read them via read_shared_facts."
        : "If a page appears JS-driven or incomplete in web_fetch, use browser_navigate and then browser_snapshot or browser_wait_for to inspect the rendered page.",
      delegateMode
        ? "Do not stop after a browser snapshot. Route the snapshot findings to an evidence-analysis or summarization specialist when interpretation is required."
        : "Do not claim that a site is unreadable due to JavaScript or dynamic loading unless browser tools were attempted and still failed to reveal the needed data.",
      "Prefer official specifications, repositories, release notes, and vendor documentation over commentary.",
      "If the gathered evidence is incomplete, say that clearly and ask a concise follow-up question only when missing information blocks a correct answer.",
    );
  }

  return {
    prompt: promptParts.join(" "),
    sourceSensitive,
    freshnessSensitive,
    computerAccessSensitive,
    pentestSensitive,
  };
}

export async function runTurn(opts: RunTurnOptions): Promise<TurnOutput> {
  const config = getConfig();
  // Per-turn timeout — inline override wins, then config, then default 15 min.
  const turnTimeoutMs = opts.turnTimeoutOverrideMs ?? config.gateway?.turnTimeoutMs ?? 900_000;
  const turnAbort = new AbortController();
  const timeoutHandle = setTimeout(() => turnAbort.abort(), turnTimeoutMs);

  // Merge caller signal with per-turn timeout: either source can cancel the turn.
  const signal: AbortSignal = opts.signal
    ? AbortSignal.any([opts.signal, turnAbort.signal])
    : turnAbort.signal;

  try {
    return await _runTurn(opts, signal, turnAbort.signal);
  } finally {
    clearTimeout(timeoutHandle);
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
  session.incrementTurn();

  logAudit("message_received", { length: userMessage.length }, {
    sessionId: session.id,
    channel: session.channel,
    userId: session.userId,
  });

  const initialDynamicGuidance = buildDynamicTurnGuidance(userMessage);
  const effectiveToolMode: MainAssistantToolMode | undefined = initialDynamicGuidance?.computerAccessSensitive && !initialDynamicGuidance?.pentestSensitive
    ? "delegate_only"
    : undefined;
  const allowedToolNames = getMainAssistantToolNames(effectiveToolMode);
  const allowedToolNameSet = new Set(allowedToolNames);
  const tools = getToolsAsLLMDefs(allowedToolNames);
  // When autoApprove is set, wrap the approvalCallback to always return true.
  const resolvedApprovalCallback = opts.autoApprove
    ? async (_toolName: string, _args: Record<string, unknown>) => true
    : opts.approvalCallback;

  const toolContext: ToolContext = {
    sessionId: session.id,
    workspacePath: session.getWorkspacePath(),
    approvalCallback: resolvedApprovalCallback,
    onComputerAction: opts.onComputerAction,
    onComputerScreenshot: opts.onComputerScreenshot,
    onComputerSessionState: opts.onComputerSessionState,
    allowedAgents: opts.allowedAgents,
    humanInLoopSteps: opts.humanInLoopSteps,
    autoApprove: opts.autoApprove,
    maxIterationsOverride: opts.maxIterationsOverride,
    onSwarmState: opts.onSwarmState,
    signal,
    swarmState: {
      objective: userMessage,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: {},
    },
  };

  let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let iterationCount = 0;
  // Per-tool output tracking within this turn — detects stuck loops (same result ≥N times).
  const _recentOutputsByTool = new Map<string, string[]>();
  const _turnToolCallCounts = new Map<string, number>();
  const _lastToolResultByName = new Map<string, string>();
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
  const FULLY_BLOCKED_ITERATION_THRESHOLD = 2;
  const provider = opts.enableThinking !== undefined
    ? getChatProviderWithOverride({ enableThinking: opts.enableThinking })
    : getChatProvider();
  const maxToolIterations = opts.maxIterationsOverride ?? getConfig().agents.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;

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
          session.addMessage({ role: "assistant", content: synthesized });
          if (opts.onChunk) opts.onChunk(synthesized);
          const performance = buildTurnPerformanceMetrics({
            turnStartedAt, firstModelResponseMs, llmCalls, llmTimeMs, toolCallsRequested,
            toolExecutionTimeMs, lastPromptMetrics, completionChars: synthesized.length,
            finishReason: "aborted_synthesized", blocked: false, toolIterations: iterationCount,
          });
          return {
            response: synthesized, toolCallsExecuted: iterationCount,
            guardrailEvents, usage: totalUsage, blocked: false,
            swarmState: toolContext.swarmState, performance,
          };
        }
      }
      return blocked(
        "Request cancelled or timed out",
        toolContext.swarmState,
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
    const dynamicGuidance = iterationCount === 0 ? (initialDynamicGuidance ?? buildDynamicTurnGuidance(userMessage, effectiveToolMode)) : null;
    const collapsedHistory = session.getCollapsedHistory();
    const systemMessages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "system", content: temporalContext },
      ...(dynamicGuidance ? [{ role: "system" as const, content: dynamicGuidance.prompt }] : []),
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
    }

    let llmResponse: LLMResponse;
    const llmStartedAt = Date.now();
    llmCalls += 1;
    try {
      llmResponse = await collectStream(provider.stream(messages, tools, signal), opts.onChunk);
      const llmDurationMs = Date.now() - llmStartedAt;
      llmTimeMs += llmDurationMs;
      if (firstModelResponseMs === undefined) {
        firstModelResponseMs = Date.now() - turnStartedAt;
      }
    } catch (err) {
      log.error({ err, sessionId: session.id }, "LLM call failed");
      return blocked(
        `LLM error: ${String(err)}`,
        toolContext.swarmState,
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

    // ── No tool calls — final response ────────────────────────────────────
    // NOTE: do NOT short-circuit on finishReason === "stop" here — many quantized
    // models (LM Studio, Ollama) return finish_reason:"stop" even when they include
    // tool_calls in the same response.  Only treat the turn as complete when there
    // are literally zero tool calls to process.
    if (llmResponse.tool_calls.length === 0) {
      const rawResponse = llmResponse.content ?? "(no response)";

      // Output guardrail scan
      const outputScan = scanOutput(rawResponse);
      let finalResponse = rawResponse;

      if (!outputScan.safe && outputScan.redacted) {
        finalResponse = outputScan.redacted;
        guardrailEvents.push({ type: "output_redacted", details: (outputScan.detectedTypes ?? []).join(", ") });
        logAudit("output_redacted", { types: outputScan.detectedTypes }, { sessionId: session.id, severity: "warn" });
      }

      session.addMessage({ role: "assistant", content: finalResponse });

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

      return {
        response: finalResponse,
        toolCallsExecuted: iterationCount,
        guardrailEvents,
        usage: totalUsage,
        blocked: false,
        swarmState: toolContext.swarmState,
        performance,
      };
    }

    // ── Assistant text repetition detection ────────────────────────────────
    // If the LLM regenerates nearly identical text across iterations while also
    // requesting tool calls, it is stuck in a regeneration loop.  Break early.
    // Only update _lastAssistantContent when the model actually produced text;
    // tool-only iterations (content=null) should NOT reset the comparison.
    if (llmResponse.content && iterationCount >= 2) {
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
    // Repair tool names where the model baked arguments into the name field
    for (const tc of llmResponse.tool_calls) normalizeToolCall(tc);

    session.addMessage({
      role: "assistant",
      content: llmResponse.content,
      tool_calls: llmResponse.tool_calls.map(tc => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    });

    const toolResultMessages: LLMMessage[] = [];

    for (const tc of llmResponse.tool_calls) {
      if (signal.aborted) break;
      toolCallsRequested += 1;

      const perTurnToolLimit = getPerTurnToolCallLimit(tc.name);
      const nextToolCallCount = (_turnToolCallCounts.get(tc.name) ?? 0) + 1;
      _turnToolCallCounts.set(tc.name, nextToolCallCount);

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

        if (tc.name === "delegate_to_agent") {
          const finalResponse = buildDelegationLoopResponse(_lastToolResultByName.get(tc.name) ?? "", "limit");
          session.addMessage({ role: "assistant", content: finalResponse });

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

          return {
            response: finalResponse,
            toolCallsExecuted: iterationCount,
            guardrailEvents,
            usage: totalUsage,
            blocked: false,
            swarmState: toolContext.swarmState,
            performance,
          };
        }

        toolResultMessages.push({
          role: "tool",
          content: `Error: Tool '${tc.name}' call limit (${perTurnToolLimit}) reached for this turn. Stop calling this tool and synthesize your findings or ask the user for the missing information directly.`,
          tool_call_id: tc.id,
        });
        continue;
      }

      // Rate limit tool calls
      const toolRl = await checkRateLimit(session.id, "tool_call");
      if (!toolRl.allowed) {
        toolResultMessages.push({
          role: "tool",
          content: "Rate limit exceeded for tool calls. Please reduce frequency.",
          tool_call_id: tc.id,
        });
        continue;
      }

      if (!allowedToolNameSet.has(tc.name)) {
        logAudit("tool_call_blocked", { tool: tc.name, reason: "not_in_turn_toolset" }, {
          sessionId: session.id,
          severity: "warn",
        });
        guardrailEvents.push({ type: "tool_blocked", details: `${tc.name}:not_in_turn_toolset` });
        toolResultMessages.push({
          role: "tool",
          content: `Tool '${tc.name}' is not available in this turn. Use only the tools that were provided for this request. If this is a desktop-control task, delegate to computer_use_agent instead of calling direct computer_* or browser_* tools.`,
          tool_call_id: tc.id,
        });
        continue;
      }

      // Block disallowed tools
      if (!isToolAllowed(tc.name)) {
        logAudit("tool_call_blocked", { tool: tc.name, reason: "not_allowed" }, {
          sessionId: session.id,
          severity: "warn",
        });
        guardrailEvents.push({ type: "tool_blocked", details: tc.name });
        toolResultMessages.push({
          role: "tool",
          content: `Tool '${tc.name}' is blocked by security policy.`,
          tool_call_id: tc.id,
        });
        continue;
      }

      logAudit("tool_call_requested", { tool: tc.name, args: tc.arguments }, { sessionId: session.id });
      if (opts.onToolCall) opts.onToolCall(tc.name, tc.arguments);

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
        toolResultMessages.push({
          role: "tool",
          content: `Error: Could not parse arguments for tool '${tc.name}'. The arguments were malformed JSON. Please retry with valid JSON arguments.`,
          tool_call_id: tc.id,
        });
        continue;
      }

      const toolStartedAt = Date.now();
      const result = await executeTool(tc.name, tc.arguments, toolContext);
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
        : `Error: ${result.error ?? "Unknown error"}`;

      _lastToolResultByName.set(tc.name, resultText);

      // ── Identical output loop detection ──────────────────────────────────
      // Track BOTH successes and failures — repeated errors are loops too.
      {
        const outputFingerprint = resultText.slice(0, 500);
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
            const finalResponse = buildDelegationLoopResponse(result.output, "identical-output");
            session.addMessage({ role: "assistant", content: finalResponse });

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

            return {
              response: finalResponse,
              toolCallsExecuted: iterationCount,
              guardrailEvents,
              usage: totalUsage,
              blocked: false,
              swarmState: toolContext.swarmState,
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

      if (opts.onToolResult) opts.onToolResult(tc.name, resultText, result.metadata);

      const modelVisibleResultText = buildModelVisibleToolResult(tc.name, resultText, result.metadata);

      toolResultMessages.push({
        role: "tool",
        content: modelVisibleResultText,
        tool_call_id: tc.id,
      });
    }

    session.addMessages(toolResultMessages);
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
        log.warn({ iterationCount, blocked: _consecutiveFullyBlockedIterations }, "All tool calls blocked for consecutive iterations — forcing synthesis");
        break;
      }
    }

    // ── Iteration-level loop detection ──────────────────────────────────────
    // (a) Identical tool-name set repeating N iterations in a row → force-synthesise.
    const iterToolSet = llmResponse.tool_calls.map(tc => tc.name).sort().join(",");
    _iterationToolSets.push(iterToolSet);
    if (_iterationToolSets.length > ITERATION_LOOP_THRESHOLD) _iterationToolSets.shift();
    if (
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
  const synthesized = await forceSynthesis(
    session, provider, signal,
    "You have reached the tool-call limit for this turn. Using ONLY the information gathered in the tool results above, write a complete, useful response to the original request. Do NOT call any more tools. If data is incomplete, acknowledge it and provide the best answer possible with what you have.",
  );
  const finalMsg = synthesized ?? "I've gathered partial results but reached the tool-call limit. Please review the tool outputs above for details.";
  session.addMessage({ role: "assistant", content: finalMsg });
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
    finishReason: "max_tool_iterations",
    blocked: false,
    toolIterations: iterationCount,
  });
  logAudit("turn_performance", { ...performance, usage: totalUsage }, {
    sessionId: session.id,
    channel: session.channel,
    severity: "warn",
  });
  return {
    response: finalMsg,
    toolCallsExecuted: iterationCount,
    guardrailEvents,
    usage: totalUsage,
    blocked: false,
    swarmState: toolContext.swarmState,
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

    try {
      const response = await provider.complete(messages, [], synthAbort.signal);
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
 * Fires onChunk for each text_delta so callers receive true token-by-token streaming.
 */
async function collectStream(
  generator: AsyncGenerator<StreamChunk>,
  onChunk?: (text: string) => void,
): Promise<LLMResponse> {
  let content = "";
  const toolCallBuffers = new Map<string, { id: string; name: string; args: string }>();
  let finishReason = "stop";
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for await (const chunk of generator) {
    if (chunk.type === "text_delta" && chunk.content) {
      content += chunk.content;
      onChunk?.(chunk.content);
    } else if (chunk.type === "tool_call_start" && chunk.toolCallId && chunk.toolName) {
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
