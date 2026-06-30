/**
 * Source-sensitive enforcement cluster (god-file seam): pure helpers that, on a
 * source-sensitive turn, rewrite the orchestrator's outgoing delegation tool calls
 * into the canonical "gather verified evidence first" frame — while honoring the
 * model's coordinator/builder choices and preserving write-only render specs.
 *
 * Extracted verbatim from runtime.ts. These functions are pure (history/args in,
 * rewritten args or boolean out) and never touch a runtime main-loop singleton.
 *
 * INVARIANT: this module imports ONLY from leaf/sibling modules (runtime-utils,
 * audit, types, intent-classifier, the source-sensitive-delegation /
 * citation-honesty / research-fallback-routing / delegation-response-collapse
 * clusters). It must NEVER import from runtime.js — keep it cycle-free.
 */
import type { LLMResponse } from "../providers/lmstudio.js";
import { logAudit } from "../audit/logger.js";
import type { DynamicTurnGuidance } from "./intent-classifier.js";
import type { SessionHistoryMessage } from "./session.js";
import {
  stableSerialize,
  BUILDER_AGENT_ROLE_RE,
  DELEGATE_TOOL_RESULT_RE,
  looksLikeDelegateMetadata,
} from "./runtime-utils.js";
import { buildSourceSensitiveOriginalRequestTask, deriveSourceSensitiveDelegationFocus, buildSourceSensitiveCoordinatorTask } from "./source-sensitive-delegation.js";
import { isBroadSourceSensitiveAdvisoryRequest } from "./citation-honesty.js";
import { chooseConfiguredAgent } from "./research-fallback-routing.js";
import { stripUntrustedDelegationContext } from "./delegation-response-collapse.js";

function defaultResearchFallbackAgentsFor(agentName: string | undefined, guidance: DynamicTurnGuidance | null | undefined): string[] {
  const preferredAgents = guidance?.freshnessSensitive && !guidance?.sourceSensitive
    ? ["web_task_coordinator", "researcher", "mission_coordinator"]
    : ["mission_coordinator", "researcher"];
  return preferredAgents
    .filter((candidate) => candidate !== agentName)
    .filter((candidate) => chooseConfiguredAgent([candidate]) === candidate);
}

function withDefaultResearchFallbackAgents(
  args: Record<string, unknown>,
  guidance: DynamicTurnGuidance | null | undefined,
): Record<string, unknown> {
  const agentName = typeof args["agentName"] === "string" ? String(args["agentName"]).trim() : undefined;
  if (!agentName) return args;
  const existingFallbacks = Array.isArray(args["fallbackAgents"])
    ? args["fallbackAgents"].map(String).filter(Boolean)
    : [];
  if (existingFallbacks.length > 0) return args;
  const fallbackAgents = defaultResearchFallbackAgentsFor(agentName, guidance);
  return fallbackAgents.length > 0 ? { ...args, fallbackAgents } : args;
}

export function hasRecentSourceSensitivePartialDelegation(
  history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[],
): boolean {
  const recent = [...history].reverse().slice(0, 12);

  for (const message of recent) {
    if (message.role !== "tool") continue;
    const content = String(message.content ?? "");
    const meta = message.metadata ?? {};
    if (!DELEGATE_TOOL_RESULT_RE.test(content) && !looksLikeDelegateMetadata(meta)) continue;

    const delegationOutcome = typeof meta["delegationOutcome"] === "string"
      ? String(meta["delegationOutcome"]).toLowerCase()
      : "";

    if (delegationOutcome === "failure") return true;
    // Any PARTIAL outcome means the swarm did not fully cover the request, so the
    // curated shared findings must ground the final synthesis — regardless of
    // terminalState. A coordinator that synthesizes after its inner researchers time
    // out reports outcome "partial" with terminalState "completed"; the old list
    // (timeout/max_iterations/cancelled/empty) excluded that case, so the backstop
    // never fired and a confident training-data answer shipped that CONTRADICTED the
    // verified finding (audit 1ba15cb5: shared finding = IM73A135V01 is analog; the
    // answer said "digital PDM").
    if (delegationOutcome === "partial") return true;
  }

  return false;
}

function hasRecentSparseSourceSensitiveMemoryReuse(
  history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[],
  userMessage: string,
): boolean {
  if (!isBroadSourceSensitiveAdvisoryRequest(userMessage)) return false;

  const recent = [...history].reverse().slice(0, 12);

  for (const message of recent) {
    if (message.role !== "tool") continue;
    const content = String(message.content ?? "");
    const meta = message.metadata ?? {};
    if (!DELEGATE_TOOL_RESULT_RE.test(content) && !looksLikeDelegateMetadata(meta)) continue;

    const reusedFromSessionMemory = meta["reusedFromSessionMemory"] === true;
    const factCount = typeof meta["factCount"] === "number" ? Number(meta["factCount"]) : 0;
    const partialCount = typeof meta["partialCount"] === "number" ? Number(meta["partialCount"]) : 0;
    if (reusedFromSessionMemory && factCount > 0 && factCount <= 3 && partialCount === 0) {
      return true;
    }
  }

  return false;
}

/** Pull the prior turn's topic + answer from history so a contextless follow-up
 *  ("validate your response") can be delegated with the real subject folded in. */
function extractPriorTurnContext(
  history: readonly SessionHistoryMessage[],
  currentMessage: string,
): { priorUserRequest?: string; priorAssistantAnswer?: string } {
  const current = currentMessage.trim();
  let priorAssistantAnswer: string | undefined;
  let priorUserRequest: string | undefined;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]!;
    const content = typeof message.content === "string" ? message.content.trim() : "";
    const hasToolCalls = Array.isArray((message as { tool_calls?: unknown[] }).tool_calls)
      && (((message as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0);
    if (!priorAssistantAnswer && message.role === "assistant" && content.length > 40 && !hasToolCalls) {
      priorAssistantAnswer = content;
    }
    if (!priorUserRequest && message.role === "user" && content && content !== current) {
      priorUserRequest = content;
    }
    if (priorAssistantAnswer && priorUserRequest) break;
  }
  return { priorUserRequest, priorAssistantAnswer };
}

/**
 * True when a create_ephemeral_agent spec grants WRITE/artifact tools but no
 * web-reaching tools (web_search / web_fetch / browser_*). Such an agent renders
 * already-gathered evidence — it is NOT a researcher — so the source-sensitive
 * "WEB RESEARCH TASK — gather datasheets/sourcing/pricing" preamble must not be
 * injected into its task: that boilerplate both mis-frames the writer AND is the
 * exact trigger for the agent-factory research-capability gate, which then rejects
 * the writer for lacking web tools (audit 74e49d90: presentation_builder rejected,
 * artifact never built, turn shipped a raw evidence dump). Mirrors the gate's own
 * web-tool set (web_search/web_fetch/browser_*; url_inspect does not count).
 * Empty/omitted tools ⇒ inherits all (may include web) ⇒ do not skip.
 */
export function ephemeralAgentSpecLacksWebTools(args: Record<string, unknown>): boolean {
  const tools = Array.isArray(args["tools"])
    ? args["tools"].filter((t): t is string => typeof t === "string")
    : null;
  if (!tools || tools.length === 0) return false;
  return !tools.some((t) => /^web_search$/i.test(t) || /^web_fetch$/i.test(t) || /^browser_/i.test(t));
}

/**
 * A parallel-slice / task-graph node whose target agent BUILDS or COORDINATES must keep its
 * OWN instruction in a source-sensitive turn. Rewriting it into the "use web_search/web_fetch
 * and STOP and report" research frame means a builder (which has no web tools) never produces
 * the artifact, and a coordinator can't decompose+build — audit 0602f246: a content_writer
 * BUILD slice in a research+build parallel_delegate was flattened to a research task and the
 * app was never built. The research is the sibling research slice's job. Keyed on the agent
 * the LLM chose (role), not on matching keywords in the user's message — same accepted signal
 * as the single-delegate coordinator exemption below.
 */
function sourceSensitiveSliceKeepsOwnTask(agentName: string): boolean {
  return BUILDER_AGENT_ROLE_RE.test(agentName) || /(?:coordinator|planner)/i.test(agentName);
}

export function enforceSourceSensitiveOriginalRequestOnToolCall(
  toolCall: LLMResponse["tool_calls"][number],
  userMessage: string,
  guidance: DynamicTurnGuidance | null | undefined,
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
  /**
   * Receives the model's OWN build-task text when the research-first rewrite is about
   * to discard it (a delegate to content_writer/web_coder/backend_coder on a
   * source-sensitive turn). The orchestrator often writes an excellent spec — features,
   * data shape, UI behaviour — and throwing it away leaves the later corrective build
   * with only generic facts (audit c2f76a00: a detailed 100-question quiz-app spec was
   * rewritten to research; the eventual build shipped a 4KB welcome page). The caller
   * stashes it and feeds it back into the corrective build as the blueprint.
   */
  onDiscardedBuilderTask?: (spec: string) => void,
): void {
  if (!guidance?.sourceSensitive) return;
  // A source-sensitive task may still spawn a downstream WRITER to render the
  // gathered evidence into an artifact. Don't rewrite a write-only ephemeral
  // agent's task into a research-gather preamble — it would be rejected for
  // lacking web tools and the artifact would never be produced.
  if (toolCall.name === "create_ephemeral_agent" && ephemeralAgentSpecLacksWebTools(toolCall.arguments ?? {})) {
    return;
  }
  const originalArgs = toolCall.arguments ?? {};
  let nextArgs: Record<string, unknown> | null = null;
  let recoveryReason = "source_sensitive_original_request_enforced";

  if (toolCall.name === "delegate_to_agent" || toolCall.name === "swarm_delegate" || toolCall.name === "create_ephemeral_agent") {
    // When the orchestrator LLM CHOSE a coordinator (mission_coordinator / *_planner),
    // it has decided this request needs multiple steps. Honor that decision: give the
    // coordinator a source-disciplined frame that lets it decompose + build + review,
    // NOT the research-only "gather and STOP and report" rewrite below (which flattens
    // the whole thing to research and blocks any build phase — audit 1740fb0c). This is
    // keyed only on the agent the LLM picked — no message keyword-matching, no forced
    // routing; the multi-step decision stays the model's.
    const chosenAgent = typeof originalArgs["agentName"] === "string" ? String(originalArgs["agentName"]) : "";
    if (
      (toolCall.name === "delegate_to_agent" || toolCall.name === "swarm_delegate")
      && /(?:coordinator|planner)/i.test(chosenAgent)
    ) {
      nextArgs = stripUntrustedDelegationContext({
        ...originalArgs,
        task: buildSourceSensitiveCoordinatorTask(userMessage),
      });
      recoveryReason = "source_sensitive_coordinator_frame";
    } else {
      const originalTask = typeof originalArgs["task"] === "string" ? String(originalArgs["task"]) : "";
      // Preserve the model's build spec before the research-first rewrite discards it.
      if (BUILDER_AGENT_ROLE_RE.test(chosenAgent) && originalTask.trim().length >= 200) {
        onDiscardedBuilderTask?.(originalTask.trim());
      }
      const focus = deriveSourceSensitiveDelegationFocus(originalTask, userMessage);
      nextArgs = withDefaultResearchFallbackAgents(
        stripUntrustedDelegationContext({ ...originalArgs, task: buildSourceSensitiveOriginalRequestTask(userMessage, undefined, focus) }),
        guidance,
      );
    }
  } else if (toolCall.name === "parallel_delegate") {
    const rawTasks = Array.isArray(originalArgs["tasks"])
      ? originalArgs["tasks"].filter((taskSpec): taskSpec is Record<string, unknown> => Boolean(taskSpec) && typeof taskSpec === "object")
      : [];
    if (rawTasks.length > 0) {
      nextArgs = {
        ...originalArgs,
        tasks: rawTasks.map((taskSpec, index) => {
          const sliceAgent = typeof taskSpec["agentName"] === "string" ? String(taskSpec["agentName"]) : "";
          // Builder/coordinator slice: keep its own BUILD/decompose instruction — the
          // research is the sibling research slice's job (audit 0602f246).
          if (sourceSensitiveSliceKeepsOwnTask(sliceAgent)) {
            return stripUntrustedDelegationContext({ ...taskSpec });
          }
          return withDefaultResearchFallbackAgents(
            stripUntrustedDelegationContext({
              ...taskSpec,
              task: buildSourceSensitiveOriginalRequestTask(
                userMessage,
                `SLICE ${index + 1}/${rawTasks.length}`,
                deriveSourceSensitiveDelegationFocus(typeof taskSpec["task"] === "string" ? String(taskSpec["task"]) : "", userMessage),
              ),
            }),
            guidance,
          );
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
        objective: userMessage,
        nodes: rawNodes.map((node, index) => {
          const nodeAgent = typeof node["agentName"] === "string" ? String(node["agentName"]) : "";
          // Builder/coordinator node: keep its own BUILD/decompose instruction (audit 0602f246).
          if (sourceSensitiveSliceKeepsOwnTask(nodeAgent)) {
            return stripUntrustedDelegationContext({ ...node });
          }
          return withDefaultResearchFallbackAgents(
            stripUntrustedDelegationContext({
              ...node,
              task: buildSourceSensitiveOriginalRequestTask(
                userMessage,
                `GRAPH NODE ${index + 1}/${rawNodes.length}`,
                deriveSourceSensitiveDelegationFocus(typeof node["task"] === "string" ? String(node["task"]) : "", userMessage),
              ),
            }),
            guidance,
          );
        }),
      };
    }
  }

  if (!nextArgs || stableSerialize(nextArgs) === stableSerialize(originalArgs)) return;
  toolCall.arguments = nextArgs;
  guardrailEvents.push({ type: "delegation_required", details: `${toolCall.name}:${recoveryReason}` });
  logAudit("tool_call_recovered", {
    originalTool: toolCall.name,
    rewrittenTo: toolCall.name,
    reason: recoveryReason,
  }, { sessionId, severity: "info" });
}

export { extractPriorTurnContext, hasRecentSparseSourceSensitiveMemoryReuse };
