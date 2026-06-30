/**
 * Required-research fallback routing + search-agents-no-match cluster (god-file
 * seam): pure routing helpers that push a stalled source-sensitive turn into a
 * research delegation, build the canonical fallback route/prompt, and enforce it
 * on an offending tool call. Extracted verbatim from runtime.ts.
 *
 * INVARIANT: this module imports ONLY from leaf/sibling modules (config, audit,
 * runtime-utils, intent-classifier, provider types). It must NEVER import from
 * runtime.js — keep it cycle-free.
 */
import type { LLMResponse } from "../providers/lmstudio.js";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { looksMultiDomainResearch, type DynamicTurnGuidance } from "./intent-classifier.js";
import { stableSerialize } from "./runtime-utils.js";

export function extractAgentRoutingSuggestionFromMetadata(
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

export function searchAgentsReturnedNoMatch(metadata: Record<string, unknown> | undefined): boolean {
  const resultCount = typeof metadata?.["resultCount"] === "number" ? metadata["resultCount"] : 0;
  const topResult = typeof metadata?.["topResult"] === "string" ? metadata["topResult"].trim() : "";
  return resultCount === 0 && !topResult;
}

export function chooseConfiguredAgent(candidates: readonly string[]): string | undefined {
  const configuredAgents = getConfig().subAgents ?? {};
  return candidates.find((name) => name in configuredAgents);
}

export type RequiredResearchFallbackRoute = {
  toolName: "delegate_to_agent" | "create_ephemeral_agent";
  args: Record<string, unknown>;
  label: string;
};

export function buildRequiredResearchFallbackRoute(
  userMessage: string,
  guidance: DynamicTurnGuidance | null | undefined,
  allowedToolNameSet: Set<string>,
  allowedAgents?: string[] | null,
): RequiredResearchFallbackRoute | null {
  // De-layer single-domain research: a coordinator only earns its extra hop when
  // the task genuinely spans multiple areas (Anthropic/Cognition consensus).
  // Otherwise route straight to the researcher specialist. Freshness single-shot
  // lookups keep web_task_coordinator (its purpose-built lane).
  const multiDomain = looksMultiDomainResearch(userMessage);
  const basePreference = guidance?.freshnessSensitive && !guidance?.sourceSensitive
    ? ["web_task_coordinator", "researcher", "mission_coordinator"]
    : (multiDomain ? ["mission_coordinator", "researcher"] : ["researcher", "mission_coordinator"]);
  // Inside a scoped scene/job step the session restricts which agents may run. Routing
  // to an agent outside that set hard-fails ("not permitted in this scene"), so respect
  // it: keep only allowed preferences, and when none of the default research agents are
  // allowed, fall back to the step's OWN allowed agents (the step task names them — e.g.
  // an image step's only agent is image_sourcer). Unrestricted turns keep the old list.
  const allowSet = allowedAgents && allowedAgents.length > 0 ? new Set(allowedAgents) : null;
  const preferredAgents = allowSet
    ? (basePreference.filter((name) => allowSet.has(name)).concat(allowedAgents!.filter((name) => !basePreference.includes(name))))
    : basePreference;
  if (preferredAgents.length === 0) return null;
  const selectedAgent = chooseConfiguredAgent(preferredAgents) ?? preferredAgents[0]!;
  const fallbackAgents = preferredAgents.filter((agentName) => agentName !== selectedAgent && chooseConfiguredAgent([agentName]));

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

  return null;
}

export function buildSearchAgentsNoMatchFallbackPrompt(route: RequiredResearchFallbackRoute): string {
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

export function enforceRequiredResearchFallbackRouteOnToolCall(
  toolCall: LLMResponse["tool_calls"][number],
  route: RequiredResearchFallbackRoute,
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
): void {
  const discoveryRetryTools = new Set(["search_agents", "list_agents", "search_workflows"]);
  const shouldRewriteDiscoveryRetry = discoveryRetryTools.has(toolCall.name);
  const shouldEnforceCanonicalRouteArgs = toolCall.name === route.toolName;
  if (!shouldRewriteDiscoveryRetry && !shouldEnforceCanonicalRouteArgs) return;

  const originalTool = toolCall.name;
  const originalArgs = toolCall.arguments ?? {};
  const routeArgs = { ...route.args };
  const changed = originalTool !== route.toolName || stableSerialize(originalArgs) !== stableSerialize(routeArgs);
  if (!changed) return;

  toolCall.name = route.toolName;
  toolCall.arguments = routeArgs;
  guardrailEvents.push({ type: "delegation_required", details: "required_research_original_task_enforced" });
  logAudit("tool_call_recovered", {
    originalTool,
    rewrittenTo: route.toolName,
    reason: shouldRewriteDiscoveryRetry
      ? "required_research_discovery_retry_rewritten"
      : "required_research_original_task_enforced",
    recoveredAgentName: route.label,
  }, { sessionId, severity: shouldRewriteDiscoveryRetry ? "warn" : "info" });
}

export function isExplicitAgentCatalogRequest(message: string): boolean {
  return /\b(list|show|display|print|enumerate|inspect|browse|catalog|catalogue|katalog|liste|auflisten|anzeigen)\b[\s\S]{0,80}\b(agents?|sub[- ]?agents?|specialists?|spezialisten|agenten|catalog|catalogue|katalog)\b/i.test(message)
    || /\b(agents?|sub[- ]?agents?|specialists?|spezialisten|agenten|catalog|catalogue|katalog)\b[\s\S]{0,80}\b(list|show|display|print|enumerate|inspect|browse|liste|auflisten|anzeigen)\b/i.test(message);
}
