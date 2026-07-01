// Tool-output post-processing sub-phase (god-file seam): the cohesive tail of the
// main loop's per-tool-call body that runs AFTER executeTool has produced a result
// and its loop-control decisions (dedup, per-cap, loop detection, early returns) have
// already been made inline. Given one tool call + its raw result text, it: redacts
// leaked secrets, screens for indirect prompt injection, runs model-backed moderation,
// records the call signature for in-turn dedup, fires the onToolResult/onIntervention
// callbacks, frames the model-visible tool-result message, and appends it to the
// turn's toolResultMessages. Extracted verbatim from runTurnImpl/_runTurn (runtime.ts)
// into a module function driven by an explicit context object — this file deliberately
// does NOT import from runtime.js. It carries NO continue/break/return control: the
// enclosing loop keeps its iteration control (the workflowExecutionCorrectionExhausted
// early return stays inline at the call site, after this span).
//
// INVARIANT: imports ONLY from leaf/sibling modules (guardrails, audit, interventions,
// tool-result-format, provider/session/registry types). It must NEVER import from
// runtime.js — keep it cycle-free.

import { logAudit } from "../audit/logger.js";
import { scanOutput } from "../guardrails/output.js";
import { checkToolOutput } from "../guardrails/input.js";
import { moderateToolResultText } from "../guardrails/moderation.js";
import { classifyToolIntervention, type InterventionNotice } from "./interventions.js";
import { buildModelVisibleToolResult } from "./tool-result-format.js";
import type { LLMMessage } from "../providers/lmstudio.js";
import type { ToolResult } from "../tools/registry.js";
import type { AgentSession } from "./session.js";

/** The per-call inputs + mutable collectors the moved span reads and writes. The tool
 * call, its executed result, the classified intervention and the arg signature are the
 * read-only per-call inputs; guardrailEvents, the signature cache and toolResultMessages
 * are mutated in place exactly as the inline closure did; onIntervention/onToolResult are
 * the enclosing `opts` callbacks passed through so effects observe live turn state. */
export interface ToolResultPostProcessContext {
  // --- read-only per-call inputs ---
  readonly toolCall: { id: string; name: string; arguments: Record<string, unknown> };
  readonly result: ToolResult;
  readonly intervention: InterventionNotice | null;
  readonly argsSig: string;
  readonly session: AgentSession;

  // --- enclosing `opts` callbacks (passed through, never imported) ---
  readonly onIntervention?: (notice: InterventionNotice) => void;
  readonly onToolResult?: (toolCallId: string, name: string, result: string, metadata?: Record<string, unknown>) => void;

  // --- mutable collectors mutated in place (same references as the enclosing turn) ---
  readonly guardrailEvents: Array<{ type: string; details: string }>;
  readonly lastToolCallSig: Map<string, { args: string; result: string; metadata?: Record<string, unknown> }>;
  readonly toolResultMessages: Array<LLMMessage & { metadata?: Record<string, unknown> }>;
}

/**
 * Runs the tool-output post-processing tail for ONE tool call. `resultText` is passed in
 * (the already-computed result string, possibly amended by upstream loop-detection notices)
 * and the possibly-redacted/blocked final value is returned so the caller can read it back
 * exactly as the inline code left it. All side effects (guardrail events, signature cache,
 * message append, callbacks) happen on the shared context references.
 */
export const postProcessToolResult = async (
  resultText: string,
  ctx: ToolResultPostProcessContext,
): Promise<string> => {
  const { toolCall: tc, result, intervention, argsSig, session, guardrailEvents } = ctx;

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
    if (blockedIntervention) ctx.onIntervention?.(blockedIntervention);
  } else if (intervention) {
    ctx.onIntervention?.(intervention);
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

  ctx.lastToolCallSig.set(tc.name, {
    args: argsSig,
    result: resultText,
    metadata: result.metadata,
  });

  if (ctx.onToolResult) ctx.onToolResult(tc.id, tc.name, resultText, result.metadata);

  const modelVisibleResultText = buildModelVisibleToolResult(tc.name, resultText, result.metadata);

  ctx.toolResultMessages.push({
    role: "tool",
    content: modelVisibleResultText,
    tool_call_id: tc.id,
    metadata: result.metadata,
  });

  return resultText;
};
