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
import { getToolsAsLLMDefs, executeTool, normalizeToolCall, type ToolContext } from "../tools/registry.js";
import { isToolAllowed } from "../guardrails/tool-tiers.js";
import { scanOutput } from "../guardrails/output.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { runSubAgentInContainer } from "./container-runner.js";
import { appendOutcome, computeAdaptiveSubAgentTimeoutMs } from "./outcomes.js";
import { formatFlowMemoryGuidance } from "./flow-memory.js";
import { acquireSlot, releaseSlot, DEFAULT_CONCURRENCY } from "../swarm/concurrency.js";
import { createChatProvider, resolveProviderEndpoint } from "../providers/index.js";
import { computerSessionManager } from "./computer-session.js";
import { formatScopedMemoryGuidance } from "../memory/service.js";

const log = childLogger("agent:sub-agent");

const DEFAULT_MAX_ITERATIONS = 5;

// Per-tool call caps enforced inside sub-agent runs.
// These prevent a single tool from dominating the iteration budget
// (e.g. repeated computer_session_start after a connection failure).
const SUB_AGENT_PER_TOOL_CAPS: Partial<Record<string, number>> = {
  computer_session_start: 3,
  computer_session_stop: 2,
  computer_session_attach: 2,
  computer_list_nodes: 2,
  computer_list_windows: 3,
  computer_focus_window: 3,
  computer_snapshot: 8,
  computer_click: 6,
  computer_type: 4,
  computer_hotkey: 4,
  delegate_to_agent: 3,
  create_ephemeral_agent: 1,
};

const COMPUTER_OBSERVATION_ONLY_TOOLS = new Set<string>([
  "computer_list_nodes",
  "computer_session_start",
  "computer_session_attach",
  "computer_list_windows",
  "computer_snapshot",
  "computer_capture_region",
  "computer_wait_for",
]);

const MAIL_READ_ONLY_TOOLS = new Set<string>([
  "mail_list_accounts",
  "mail_list_mailboxes",
  "mail_search",
  "mail_read",
  "mail_list_unread",
]);

function isComputerObservationOnlyTask(task: string): boolean {
  const normalized = task.toLowerCase();
  if (!normalized.trim()) return false;

  const observationIntent = /(list|identify|inspect|analy[sz]e|describe|report|read|check|show|visible|screenshot|snapshot|screen|what is on (?:the )?screen|loaded models|model names|welche|liste|prüfe|analysiere|beschreibe|sichtbar)/i.test(normalized);
  if (!observationIntent) return false;

  const explicitInteraction = /(click|doubleclick|type|press|hotkey|shortcut|open|launch|navigate|scroll|drag|upload|download|log in|login|sign in|fill|submit|reply|send|switch tab|switch window|focus the input|paste)/i.test(normalized);
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
    return "";
  }

  return [
    "TASK MODE — READ-ONLY OBSERVATION.",
    "The user asked you to inspect, list, or describe the current state, not to operate the desktop UI.",
    "Start with connection/session discovery if needed, then capture a computer_snapshot immediately.",
    "Prefer additional computer_snapshot or computer_capture_region calls over any interaction.",
    "Do NOT click, type, use hotkeys, scroll, drag, open apps, or launch dialogs for this task.",
    "If the current desktop does not already show the requested evidence, report that limitation explicitly instead of probing blindly.",
  ].join("\n");
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

/** Strip hallucinated tool-call XML that some models emit in text output. */
function stripHallucinatedToolTags(text: string): string {
  return text
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
  signal?: AbortSignal;
  approvalCallback?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  humanInLoopSteps?: string[];
  onComputerAction?: (action: { computerSessionId: string; actionType: string; [key: string]: unknown }) => void;
  onComputerScreenshot?: (screenshot: { computerSessionId: string; dataUrl: string; width: number; height: number; [key: string]: unknown }) => void;
  onComputerSessionState?: (sessionState: { computerSessionId: string; state: string; [key: string]: unknown }) => void;
  /** Override the agent's configured maxIterations for this invocation. 0 disables the cap. */
  maxIterationsOverride?: number;
  /** Override the agent's timeout for this invocation in ms. 0 disables the timeout. */
  turnTimeoutOverrideMs?: number;
  /** Inline config — bypasses config lookup (used by agent_factory for ephemeral agents) */
  inlineConfig?: import("../config/schema.js").SubAgentConfig;
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
  terminalState?: "completed" | "max_iterations" | "timeout" | "cancelled" | "error" | "missing_config";
  containerColdStartMs?: number;
  containerBootstrapMs?: number;
  containerRuntimeMs?: number;
}

export interface SubAgentRunResult {
  output: string;
  stats: SubAgentExecutionStats;
}

export async function runSubAgentWithStats(opts: SubAgentRunOptions): Promise<SubAgentRunResult> {
  const config = getConfig();
  const agentCfg = opts.inlineConfig ?? config.subAgents[opts.agentName];
  const runStartedAt = Date.now();

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
        terminalState: "missing_config",
      },
    };
  }

  const defaultTimeoutMs = agentCfg.turnTimeoutMs ?? config.agents.performance?.subAgentTurnSloMs ?? 60_000;
  const adaptiveTimeout = opts.turnTimeoutOverrideMs === undefined && agentCfg.turnTimeoutMs === undefined
    ? computeAdaptiveSubAgentTimeoutMs(opts.agentName, opts.workspacePath, defaultTimeoutMs)
    : null;
  const resolvedTurnTimeoutMs = opts.turnTimeoutOverrideMs ?? agentCfg.turnTimeoutMs ?? adaptiveTimeout?.timeoutMs;
  const turnTimeoutMs = resolvedTurnTimeoutMs && resolvedTurnTimeoutMs > 0 ? resolvedTurnTimeoutMs : undefined;
  const timeoutAbort = turnTimeoutMs ? new AbortController() : undefined;
  const timeoutHandle = timeoutAbort
    ? setTimeout(() => timeoutAbort.abort(), turnTimeoutMs)
    : undefined;
  const signal = opts.signal && timeoutAbort
    ? AbortSignal.any([opts.signal, timeoutAbort.signal])
    : opts.signal ?? timeoutAbort?.signal;

  try {
    const subSessionId = `sub:${opts.parentSessionId}:${opts.agentName}:${Date.now()}`;

    logAudit(
      "sub_agent_started",
      {
        agentName: opts.agentName,
        task: opts.task.slice(0, 120),
        capabilities: agentCfg.capabilities,
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
    if (agentCfg.container?.enabled) {
      const maxConcurrent = agentCfg.maxConcurrent ?? DEFAULT_CONCURRENCY;
      await acquireSlot(opts.agentName, maxConcurrent, opts.parentSessionId);
      let containerRun;
      try {
        log.info({ agentName: opts.agentName, maxConcurrent }, "Dispatching to containerized sub-agent");
        containerRun = await runSubAgentInContainer({ ...opts, signal }, agentCfg, modelConfig, providerEndpoint.baseUrl, providerEndpoint.apiKey);
      } finally {
        releaseSlot(opts.agentName);
      }
      logAudit(
        "sub_agent_completed",
        {
          agentName: opts.agentName,
          containerized: true,
          resultLength: containerRun.output.length,
          ...containerRun.metrics,
        },
        { sessionId: subSessionId }
      );
      return {
        output: containerRun.output,
        stats: {
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
          terminalState: "completed",
          containerColdStartMs: containerRun.metrics.containerColdStartMs,
          containerBootstrapMs: containerRun.metrics.containerBootstrapMs,
          containerRuntimeMs: containerRun.metrics.containerRuntimeMs,
        },
      };
    }

    const provider = createChatProvider(modelConfig, providerEndpoint);

    // Sanitize task: strip keyboard shortcut instructions that cause wrong-window side effects.
    // The orchestrator LLM sometimes composes tasks with explicit shortcut instructions
    // (e.g. "use Ctrl+Shift+P to open Command Palette") which the sub-agent follows
    // even when its system prompt says not to. Removing them here is the hard guarantee.
    let sanitizedTask = opts.task;
    if (agentCfg.tools?.some((t: string) => t.startsWith("computer_"))) {
      sanitizedTask = sanitizedTask
        .replace(/(?:using|use|press|hit|with|via)\s+(?:keyboard\s+shortcut\s+)?(?:Ctrl|Alt|Shift|Cmd|Meta|Win)\+[A-Za-z+]+/gi, "using mouse clicks on visible UI elements")
        .replace(/(?:Ctrl|Alt|Cmd|Meta)\+(?:Shift|Alt)\+[A-Za-z]/gi, "(blocked shortcut — use mouse click)")
        .replace(/(?:command\s+palette|Ctrl\+Shift\+P)/gi, "visible UI elements")
        .replace(/(?:keyboard\s+shortcut|shortcut|key\s*(?:combo|combination))\s+(?:to\s+)?(?:open|toggle|show|launch)/gi, "mouse click to open");
    }

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
    const systemPrompt = agentCfg.systemPrompt
      ? `${agentCfg.systemPrompt}${modelExecutionGuidance ? `\n\n${modelExecutionGuidance}` : ""}${taskModeGuidance ? `\n\n${taskModeGuidance}` : ""}\n\nAgent name: ${opts.agentName}\nCurrent workspace: ${opts.workspacePath}\nToday's date: ${today}${flowGuidance ? `\n\n${flowGuidance}` : ""}${memoryGuidance ? `\n\n${memoryGuidance}` : ""}`
      : `You are a specialized AI sub-agent named "${opts.agentName}". Complete the given task and return your result.\n\nAgent name: ${opts.agentName}\nCurrent workspace: ${opts.workspacePath}\nToday's date: ${today}${flowGuidance ? `\n\n${flowGuidance}` : ""}${memoryGuidance ? `\n\n${memoryGuidance}` : ""}`;

    // Get available tools for this agent
    const effectiveToolNames = getEffectiveToolNames(opts.agentName, agentCfg.tools, sanitizedTask);
    const tools = getToolsAsLLMDefs(effectiveToolNames);

    const toolContext: ToolContext = {
      sessionId: subSessionId,
      workspacePath: opts.workspacePath,
      approvalCallback: opts.approvalCallback,
      humanInLoopSteps: opts.humanInLoopSteps,
      onComputerAction: opts.onComputerAction,
      onComputerScreenshot: opts.onComputerScreenshot,
      onComputerSessionState: opts.onComputerSessionState,
      signal,
    };

    // Build initial message
    const userContent = opts.context
      ? `Context:\n${opts.context}\n\nTask: ${sanitizedTask}`
      : sanitizedTask;

    const history: LLMMessage[] = [{ role: "user", content: userContent }];

    const maxIterations = opts.maxIterationsOverride === 0
      ? Number.MAX_SAFE_INTEGER
      : (opts.maxIterationsOverride ?? agentCfg.maxIterations ?? DEFAULT_MAX_ITERATIONS);
    let iterations = 0;
    let toolCount = 0;
    const toolNames: string[] = [];
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    // Track last tool call signature per tool name for consecutive-duplicate detection
    const lastToolCallSig = new Map<string, { args: string; result: string }>();
    // Per-tool call counters — prevents a single tool from dominating iteration budget
    const perToolCallCount = new Map<string, number>();

    const buildStats = (terminalState: SubAgentExecutionStats["terminalState"] = "completed"): SubAgentExecutionStats => ({
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
      terminalState,
    });

    if (opts.agentName === "mail_agent" && isMailInboxReadTask(sanitizedTask)) {
      const executeTrackedMailTool = async (toolName: string, args: Record<string, unknown>): Promise<import("../tools/registry.js").ToolResult> => {
        toolCount += 1;
        toolNames.push(toolName);
        logAudit(
          "sub_agent_tool_call",
          { agentName: opts.agentName, tool: toolName, deterministic: true },
          { sessionId: subSessionId },
        );
        return executeTool(toolName, args, toolContext);
      };

      const accountsResult = await executeTrackedMailTool("mail_list_accounts", {});
      if (!accountsResult.success) {
        appendOutcome(opts.workspacePath, {
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
        return {
          output: `Sub-agent error: ${accountsResult.error ?? "mail_list_accounts failed"}`,
          stats: buildStats("error"),
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
        appendOutcome(opts.workspacePath, {
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: "success",
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
        });
        logAudit(
          "sub_agent_completed",
          {
            agentName: opts.agentName,
            iterations,
            resultLength: result.length,
            promptChars: systemPrompt.length,
            userContentChars: userContent.length,
            toolCount,
            usage,
            model: modelConfig.primary,
            durationMs: Date.now() - runStartedAt,
            deterministicMailCheck: true,
          },
          { sessionId: subSessionId },
        );
        return { output: result, stats: buildStats("completed") };
      }

      const unreadResult = await executeTrackedMailTool("mail_list_unread", { accountIds, limit: 5 });
      if (!unreadResult.success) {
        appendOutcome(opts.workspacePath, {
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
        return {
          output: `Sub-agent error: ${unreadResult.error ?? "mail_list_unread failed"}`,
          stats: buildStats("error"),
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

      appendOutcome(opts.workspacePath, {
        ts: new Date().toISOString(),
        agent: opts.agentName,
        task: opts.task.slice(0, 200),
        outcome: "success",
        iterations,
        totalTokens: usage.totalTokens,
        durationMs: Date.now() - runStartedAt,
        timeoutMs: turnTimeoutMs,
      });
      logAudit(
        "sub_agent_completed",
        {
          agentName: opts.agentName,
          iterations,
          resultLength: result.length,
          promptChars: systemPrompt.length,
          userContentChars: userContent.length,
          toolCount,
          usage,
          model: modelConfig.primary,
          durationMs: Date.now() - runStartedAt,
          deterministicMailCheck: true,
        },
        { sessionId: subSessionId },
      );
      log.info({ agentName: opts.agentName, toolCount }, "Sub-agent completed via deterministic inbox check");
      return { output: result, stats: buildStats("completed") };
    }

    while (iterations < maxIterations) {
      if (signal?.aborted) {
        if (timeoutAbort?.signal.aborted && turnTimeoutMs) {
          appendOutcome(opts.workspacePath, {
            ts: new Date().toISOString(),
            agent: opts.agentName,
            task: opts.task.slice(0, 200),
            outcome: "failure",
            iterations,
            totalTokens: usage.totalTokens,
            durationMs: Date.now() - runStartedAt,
            timeoutMs: turnTimeoutMs,
            error: `timeout (${turnTimeoutMs}ms) reached`,
          });
          return { output: `Sub-agent '${opts.agentName}' timed out after ${turnTimeoutMs}ms`, stats: buildStats("timeout") };
        }
        return { output: "Sub-agent task was cancelled", stats: buildStats("cancelled") };
      }

      const messages: LLMMessage[] = [
        { role: "system", content: systemPrompt },
        ...history,
      ];

      let response;
      try {
        response = await provider.complete(messages, tools, signal);
      } catch (err) {
        if (timeoutAbort?.signal.aborted && turnTimeoutMs) {
          appendOutcome(opts.workspacePath, {
            ts: new Date().toISOString(),
            agent: opts.agentName,
            task: opts.task.slice(0, 200),
            outcome: "failure",
            iterations,
            totalTokens: usage.totalTokens,
            durationMs: Date.now() - runStartedAt,
            timeoutMs: turnTimeoutMs,
            error: `timeout (${turnTimeoutMs}ms) reached`,
          });
          return { output: `Sub-agent '${opts.agentName}' timed out after ${turnTimeoutMs}ms`, stats: buildStats("timeout") };
        }
        if (opts.signal?.aborted) {
          return { output: "Sub-agent task was cancelled", stats: buildStats("cancelled") };
        }
        log.error({ err, agentName: opts.agentName }, "Sub-agent LLM call failed");
        appendOutcome(opts.workspacePath, {
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
        return { output: `Sub-agent error: ${String(err)}`, stats: buildStats("error") };
      }

      usage.promptTokens += response.usage.promptTokens;
      usage.completionTokens += response.usage.completionTokens;
      usage.totalTokens += response.usage.totalTokens;

      // No tool calls — final answer
      if (response.tool_calls.length === 0) {
        let result = normalizeSubAgentOutput(response.content);

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

        const stats = buildStats("completed");
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

        logAudit(
          "sub_agent_completed",
          {
            agentName: opts.agentName,
            iterations,
            resultLength: result.length,
            promptChars: systemPrompt.length,
            userContentChars: userContent.length,
            toolCount,
            usage,
            model: modelConfig.primary,
            durationMs: Date.now() - runStartedAt,
            ...(adaptiveTimeout ? {
              adaptiveTimeoutMs: adaptiveTimeout.timeoutMs,
              adaptiveTimeoutBaselineMs: adaptiveTimeout.baselineMs,
              adaptiveTimeoutSamples: adaptiveTimeout.sampleSize,
            } : {}),
          },
          { sessionId: subSessionId }
        );

        // Detect likely failure patterns from the output text
        const looksLikeFail = /no results|not found|unable to|failed to|error:/i.test(result.slice(0, 300));
        appendOutcome(opts.workspacePath, {
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: looksLikeFail ? "partial" : "success",
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
        });

        log.info({ agentName: opts.agentName, iterations }, "Sub-agent completed");
        return { output: stripHallucinatedToolTags(result), stats };
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

        logAudit(
          "sub_agent_tool_call",
          { agentName: opts.agentName, tool: tc.name },
          { sessionId: subSessionId }
        );

        toolNames.push(tc.name);

        // Per-tool call cap — prevent wasteful loops on a single tool
        const priorCount = perToolCallCount.get(tc.name) ?? 0;
        const toolCap = SUB_AGENT_PER_TOOL_CAPS[tc.name];
        if (toolCap !== undefined && priorCount >= toolCap) {
          log.warn(
            { agentName: opts.agentName, tool: tc.name, count: priorCount, cap: toolCap },
            "Sub-agent exceeded per-tool call cap",
          );
          toolResults.push({
            role: "tool",
            content: `Tool '${tc.name}' has been called ${priorCount} times this run (limit: ${toolCap}). You must proceed without calling it again. Work with the results you already have.`,
            tool_call_id: tc.id,
          });
          continue;
        }
        perToolCallCount.set(tc.name, priorCount + 1);

        // Consecutive-duplicate detection: if same tool + same args as the
        // immediately prior call, return the cached result with a warning
        // instead of wasting an iteration on a redundant network round-trip.
        const argsSig = JSON.stringify(tc.arguments);
        const prev = lastToolCallSig.get(tc.name);
        if (prev && prev.args === argsSig) {
          log.warn(
            { agentName: opts.agentName, tool: tc.name },
            "Sub-agent repeated identical tool call — returning cached result",
          );
          toolResults.push({
            role: "tool",
            content: prev.result + "\n\n[Note: This is a cached result — you already called this tool with identical arguments. Move on to the next step.]",
            tool_call_id: tc.id,
          });
          continue;
        }

        const result = await executeTool(tc.name, tc.arguments, toolContext);
        const resultContent = result.success ? result.output : `Error: ${result.error ?? "unknown"}`;
        lastToolCallSig.set(tc.name, { args: argsSig, result: resultContent });

        toolResults.push({
          role: "tool",
          content: resultContent,
          tool_call_id: tc.id,
        });
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
              "Synthesize everything you have gathered so far and return your final answer now.",
          },
          ...history,
        ];
        const synthResponse = await provider.complete(synthMessages, [], signal);
        usage.promptTokens += synthResponse.usage.promptTokens;
        usage.completionTokens += synthResponse.usage.completionTokens;
        usage.totalTokens += synthResponse.usage.totalTokens;

        if (synthResponse.tool_calls.length === 0) {
          let result = normalizeSubAgentOutput(synthResponse.content);
          const outputScan = scanOutput(result);
          if (!outputScan.safe && outputScan.redacted) {
            logAudit(
              "output_redacted",
              { agentName: opts.agentName, types: outputScan.detectedTypes },
              { sessionId: subSessionId, severity: "warn" }
            );
            result = outputScan.redacted;
          }
          const stats = buildStats("max_iterations");
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
          appendOutcome(opts.workspacePath, {
            ts: new Date().toISOString(),
            agent: opts.agentName,
            task: opts.task.slice(0, 200),
            outcome: "partial",
            iterations,
            totalTokens: usage.totalTokens,
            durationMs: Date.now() - runStartedAt,
            timeoutMs: turnTimeoutMs,
          });
          log.info({ agentName: opts.agentName, iterations }, "Sub-agent synthesized after max iterations");
          return { output: stripHallucinatedToolTags(result), stats };
        }
      } catch (synthErr) {
        log.warn({ synthErr, agentName: opts.agentName }, "Synthesis pass after max iterations failed");
      }
    }

    appendOutcome(opts.workspacePath, {
      ts: new Date().toISOString(),
      agent: opts.agentName,
      task: opts.task.slice(0, 200),
      outcome: "partial",
      iterations,
      totalTokens: usage.totalTokens,
      durationMs: Date.now() - runStartedAt,
      timeoutMs: turnTimeoutMs,
      error: `max_iterations (${maxIterations}) reached`,
    });

    return {
      output: `Sub-agent '${opts.agentName}' reached the maximum number of tool-call iterations (${maxIterations}). Partial result may be incomplete.`,
      stats: buildStats("max_iterations"),
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);

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
