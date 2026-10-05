// Turn-preparation spans lifted out of runTurnImpl (runtime.ts) — HELPER-LIFT
// god-file seams. These run ONCE, before the main agent loop; each takes bounded
// read-only inputs and returns the value(s) the loop consumes. No iteration state,
// no control-flow escape. Per the seam convention (sibling modules do not import
// runtime.js), any runtime-private helper is passed in; everything else is imported.
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { lookupTrajectory } from "../memory/trajectory-cache.js";
import { toSoftRoutingHint, type DynamicTurnGuidance } from "./intent-classifier.js";
import { userMessageCarriesActionableUrl } from "./citation-honesty.js";
import type { MainAssistantToolMode } from "./default-tools.js";
import { prefetchCapabilityCandidates } from "./discovery-prefetch.js";
import { noteIntentShadowCapsule } from "./intent-shadow.js";
import { timedPhase } from "./turn-metrics.js";

/**
 * HARD latency cap on the discovery capsule: the embedding round-trip behind it can stall on a cold
 * or queued embed backend (observed ~15 s on a busy LM Studio). A slow prefetch is abandoned (empty
 * capsule) rather than delaying the turn; the model then discovers on demand.
 */
export const DISCOVERY_PREFETCH_BUDGET_MS = 2500;

/**
 * Start a turn's discovery prefetch (orchestration.discoveryPrefetch): bounded by `budgetMs`, timed
 * as the `discoveryPrefetch` phase, noted for the intent readout's shadow, and never rejecting — an
 * error and the timeout both resolve to "".
 *
 * WHERE IT STARTS (finding 2026-10-05). It reads only the user's message and the turn's agent grant,
 * so the runtime starts it the moment the receptionist's fast lane has declined the turn, beside the
 * source judge, and hands the promise to the first prompt assembly. Started inside that assembly it
 * began only after the judge's wait and the document retrieval, and its embedding round-trip — up to
 * the whole cap — sat on the path to the first orchestrator token instead of behind them.
 */
export function startDiscoveryPrefetch(params: {
  userMessage: string;
  sessionId: string;
  /** The turn's agent grant (a scene, a restricted session): unscoped, the capsule named agents the turn could not call. */
  allowedAgents?: readonly string[];
  budgetMs?: number;
}): Promise<string> {
  const budgetMs = params.budgetMs ?? DISCOVERY_PREFETCH_BUDGET_MS;
  return timedPhase("discoveryPrefetch", async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The capsule's agent names, for the intent readout's shadow (agent/intent-shadow.ts): the
    // candidate list the turn actually had, so none when the capsule came too late.
    let capsuleAgents: readonly string[] = [];
    let capsuleLate = false;
    try {
      const capsule = await Promise.race([
        prefetchCapabilityCandidates(params.userMessage, {
          ...(params.allowedAgents ? { allowedAgents: [...params.allowedAgents] } : {}),
          sessionId: params.sessionId,
          onAgents: (names) => { capsuleAgents = names; },
        }),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => {
            capsuleLate = true;
            resolve("");
          }, budgetMs);
        }),
      ]);
      noteIntentShadowCapsule(params.sessionId, capsuleLate ? { status: "timeout" } : { status: "ok", agents: capsuleAgents });
      return capsule;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }).catch(() => "");
}

export interface TrajectoryInjection {
  /** Extra `[CACHED RECENT EVIDENCE …]` system context, or "" when no usable hit. */
  trajectoryInjectionContext: string;
  /** Identity of the injected cached trajectory (for the later used/invalidated
   *  feedback signal), or null when nothing was injected. */
  injectedTrajectoryIdentity: { normalizedQuery: string; finishedAt: string } | null;
}

/**
 * Whether iteration 0 injects the per-turn context blocks — memory, user model, skills, flow
 * guidance and the cached trajectory. Not under agents.performance.leanContextInjection, where the
 * model pulls that context with recall_context instead. One definition for the prompt assembly that
 * injects the blocks (turn-system-prompt.ts) and the up-front lookups that feed them.
 */
export function turnContextInjected(): boolean {
  return getConfig().agents.performance.leanContextInjection !== true;
}

/**
 * Before the first LLM call, look up a cached trajectory for a semantically similar
 * recent query and, on a hit, return it as extra system context so the model can
 * decide whether to reuse or re-research the evidence. Best-effort — a lookup error
 * yields the empty result and never blocks the turn. Emits trajectory_cache_hit.
 *
 * NOT WHEN IT CANNOT BE SHOWN (finding 2026-10-05). The lookup sits on the critical path (a query
 * embedding plus a parse of the cache file), and under leanContextInjection — the default — the
 * prompt assembly never injects its result. It now runs only when turnContextInjected(), the same
 * condition the assembly injects on; the identity it returns is still only a candidate until the
 * assembly reports the context as shown (AssembleTurnSystemMessagesResult.trajectoryShown).
 */
export async function lookupTrajectoryInjection(params: {
  userMessage: string;
  workspacePath: string;
  freshnessSensitive: boolean;
  sessionId: string;
  channel: string;
}): Promise<TrajectoryInjection> {
  let trajectoryInjectionContext = "";
  let injectedTrajectoryIdentity: { normalizedQuery: string; finishedAt: string } | null = null;
  if (!turnContextInjected()) return { trajectoryInjectionContext, injectedTrajectoryIdentity };
  try {
    const cachedHit = await lookupTrajectory(
      params.userMessage,
      params.workspacePath,
      params.freshnessSensitive,
    );
    const cachedTrajectory = cachedHit?.entry ?? null;
    if (cachedTrajectory && cachedTrajectory.finalAnswer.length > 50) {
      const evidence = cachedTrajectory.sharedFindings.length > 0
        ? `\n\nEvidence gathered:\n${cachedTrajectory.sharedFindings.slice(0, 5).map((f) => `• ${f.slice(0, 300)}`).join("\n")}`
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
        { sessionId: params.sessionId, channel: params.channel },
      );
    }
  } catch { /* best-effort — never block the turn */ }
  return { trajectoryInjectionContext, injectedTrajectoryIdentity };
}

export interface TurnEnforcementSignals {
  softRoutingEnforcement: boolean;
  applyRoutingTone: (text: string) => string;
  inWorkflowStep: boolean;
  requiresDelegatedResearch: boolean;
  requiresArtifactDelegation: boolean;
  activeMainAssistantToolMode: MainAssistantToolMode;
  requiresUrlFetch: boolean;
  requiresSwarmMaintenanceDelegation: boolean;
  requiresMaintenanceDelegation: boolean;
}

/**
 * Derive the turn's routing/enforcement signals from the resolved tool mode +
 * dynamic guidance + config. Pure computation (no side effects, no control flow) —
 * the loop reads these to decide whether it MUST orchestrate before answering and
 * how hard to enforce routing. Moved verbatim from runTurnImpl's setup phase.
 */
export function computeTurnEnforcementSignals(params: {
  effectiveToolMode: MainAssistantToolMode | undefined;
  initialDynamicGuidance: DynamicTurnGuidance | null;
  channel: string;
  allowedToolNameSet: Set<string>;
  userMessage: string;
  recentWorkflowAuthoringMaintenanceContext: boolean;
  /**
   * Test seam for the documented routing policy. Omit in production to read the
   * resolved main-assistant configuration.
   */
  trustModelRouting?: boolean;
  /** Up-front source-sensitivity verdict (orchestration.upfrontSourceSensitiveClassifier). When the
   *  classifier flagged this QUESTION as source-sensitive before the model drafted, treat it exactly
   *  like guidance.sourceSensitive so requiresDelegatedResearch fires — the turn researches FIRST
   *  (draft suppressed + orchestration forced) instead of drafting then being rejected post-hoc. */
  upfrontSourceSensitive?: boolean;
}): TurnEnforcementSignals {
  const { effectiveToolMode, initialDynamicGuidance, channel, allowedToolNameSet, userMessage, recentWorkflowAuthoringMaintenanceContext, upfrontSourceSensitive } = params;
  const trustModelRouting = params.trustModelRouting ?? getConfig().agents.mainAssistant.trustModelRouting;
  const softRoutingEnforcement = getConfig().agents.performance.softRoutingEnforcement === true;
  const applyRoutingTone = (text: string): string =>
    softRoutingEnforcement && text ? toSoftRoutingHint(text) : text;
  // A workflow-channel session is a scoped scene/job STEP: the author already wrote its
  // task (which names the exact agent) and its allowedAgents. The top-level source-sensitive
  // TASK rewrite must NOT fire here — it re-frames the step's delegation as a generic "WEB
  // RESEARCH TASK" and appends researcher/mission_coordinator fallbacks the step forbids (audit
  // 158f1435). The research-routing NUDGE stays on, but its fallback route is allowedAgents-aware.
  const inWorkflowStep = channel === "workflow";
  // Anti-hallucination: a freshness- OR source-sensitive orchestration turn must run real
  // research — never a tool-free answer from training memory (audit fe496ec5: "news von heute"
  // → a 2.5KB invented bulletin, zero delegations). Catches a tool-free draft and routes it
  // through the re-nudge → autoResearchOnRefusal path, which ends with REAL searched results.
  const requiresDelegatedResearch = effectiveToolMode === "orchestration_only"
    && Boolean(
      initialDynamicGuidance?.sourceSensitive
      || (!trustModelRouting && initialDynamicGuidance?.freshnessSensitive)
      || upfrontSourceSensitive,
    );
  const requiresArtifactDelegation = effectiveToolMode === "orchestration_only"
    && Boolean(initialDynamicGuidance?.artifactSensitive);
  const activeMainAssistantToolMode = effectiveToolMode ?? getConfig().agents.mainAssistant.toolMode;
  // Structural URL-fetch enforcement (orchestration.urlFetchEnforcement). A URL in the user's
  // message means they handed the assistant a page to READ; a tool-free answer about it is
  // rejected and a real fetch forced (live session 29796f86: an invented page + false "loaded"
  // claim). Structural URL regex only. Exempt a message that also pasted substantial inline
  // content (answer can be grounded in that) — can only make the guard fire LESS.
  const requiresUrlFetch = getConfig().orchestration?.urlFetchEnforcement === true
    && activeMainAssistantToolMode === "orchestration_only"
    && userMessageCarriesActionableUrl(userMessage)
    && !initialDynamicGuidance?.inlineAnalyticalContent;
  const requiresSwarmMaintenanceDelegation = activeMainAssistantToolMode !== "hybrid"
    && Boolean(initialDynamicGuidance?.swarmMaintenanceSensitive)
    && allowedToolNameSet.has("delegate_to_agent");
  const requiresMaintenanceFollowUpDelegation = recentWorkflowAuthoringMaintenanceContext
    && (allowedToolNameSet.has("delegate_to_agent")
      || allowedToolNameSet.has("parallel_delegate")
      || allowedToolNameSet.has("run_task_graph")
      || allowedToolNameSet.has("create_ephemeral_agent"));
  const requiresMaintenanceDelegation = requiresSwarmMaintenanceDelegation || requiresMaintenanceFollowUpDelegation;
  return {
    softRoutingEnforcement,
    applyRoutingTone,
    inWorkflowStep,
    requiresDelegatedResearch,
    requiresArtifactDelegation,
    activeMainAssistantToolMode,
    requiresUrlFetch,
    requiresSwarmMaintenanceDelegation,
    requiresMaintenanceDelegation,
  };
}
