import type { LLMResponse } from "../providers/lmstudio.js";
import type { AgentSession } from "./session.js";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { stableSerialize, BUILDER_AGENT_ROLE_RE } from "./runtime-utils.js";
import { findRecentDelegateEvidence } from "./interrupted-delegation-evidence.js";

export function stripUntrustedDelegationContext(args: Record<string, unknown>): Record<string, unknown> {
  if (!("context" in args)) return args;
  const nextArgs = { ...args };
  delete nextArgs["context"];
  return nextArgs;
}

/**
 * Derive a usable delegation task string from the raw arguments of a tool call
 * that named a sub-agent as if it were a tool (e.g. `researcher({query:"…"})`).
 * Returns null when the arguments carry no real task — a parse-error sentinel,
 * an empty object, or only non-string fields — so the caller rejects the call
 * instead of fabricating a task by stringifying the argument object. That
 * fabrication previously leaked `{"_parse_error":true,"_raw":""}` straight into
 * a delegation as the task (audit a3828367: an empty `web_task_coordinator()`
 * call), bypassing the delegate tool's own "task is required" guard.
 * Field names are matched, not content, so this stays language-independent.
 */
export function deriveDelegationTaskFromArgs(args: Record<string, unknown> | undefined): string | null {
  if (!args || typeof args !== "object" || "_parse_error" in args) return null;
  for (const key of ["task", "query", "prompt", "input", "message", "objective", "request", "instruction"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  // No conventional task field — only stringify when there is genuine string
  // content to carry; refuse empty or all-non-string argument objects.
  const hasStringContent = Object.values(args).some(v => typeof v === "string" && v.trim());
  return hasStringContent ? JSON.stringify(args) : null;
}

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

export function getPerTurnToolCallLimit(toolName: string): number | undefined {
  const cfgOverride = getConfig().orchestration?.perTurnCaps?.[toolName];
  if (cfgOverride !== undefined) return cfgOverride;
  return PER_TURN_TOOL_CALL_LIMITS[toolName];
}

export function buildDelegationLoopResponse(
  session: AgentSession,
  latestOutput: string,
  reason: "identical-output" | "limit" = "identical-output",
): string {
  const normalized = latestOutput.trim() || "The delegated agent returned no usable output.";
  const evidence = findRecentDelegateEvidence(session.getHistory(), { scopeToCurrentTurn: true });
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

export function collapseDuplicateToolCallsInResponse(
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

export function collapseExcessDirectDelegationsInResponse(
  toolCalls: LLMResponse["tool_calls"],
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
  onDiscardedBuilderTask?: (spec: string) => void,
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

    // When the dropped surplus delegation is a BUILD task to a builder agent, its task
    // text is the model's own build spec — preserve it for the corrective build instead
    // of losing it (audit c2f76a00: the model emitted research + a detailed content_writer
    // quiz-app spec in one response; the spec was dropped here and the eventual corrective
    // build, running on generic facts only, shipped a 4KB welcome page).
    const droppedAgent = typeof toolCall.arguments?.["agentName"] === "string" ? String(toolCall.arguments["agentName"]) : "";
    const droppedTask = typeof toolCall.arguments?.["task"] === "string" ? String(toolCall.arguments["task"]) : "";
    if (BUILDER_AGENT_ROLE_RE.test(droppedAgent) && droppedTask.trim().length >= 200) {
      onDiscardedBuilderTask?.(droppedTask.trim());
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

export const ORCHESTRATION_LAUNCHER_TOOL_NAMES = new Set([
  "delegate_to_agent",
  "parallel_delegate",
  "run_task_graph",
  "run_workflow",
  "create_ephemeral_agent",
]);
export const PERSISTED_SWARM_STATE_TOOL_NAMES = new Set([
  ...ORCHESTRATION_LAUNCHER_TOOL_NAMES,
  "swarm_delegate",
]);
export const AGENT_DISCOVERY_TOOL_NAMES = new Set([
  "search_agents",
  "list_agents",
  "search_tools",
  "search_workflows",
]);

export function collapseMixedOrchestrationLaunchersInResponse(
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

export function collapseMixedDiscoveryAndOrchestrationToolsInResponse(
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
