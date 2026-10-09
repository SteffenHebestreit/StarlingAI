// Turn-preparation spans lifted out of runTurnImpl (runtime.ts) — HELPER-LIFT
// god-file seams. These run ONCE, before the main agent loop; each takes bounded
// read-only inputs and returns the value(s) the loop consumes. No iteration state,
// no control-flow escape. Per the seam convention (sibling modules do not import
// runtime.js), any runtime-private helper is passed in; everything else is imported.
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { askIntentReadout, type IntentFacetRead } from "../decisions/intent-readout.js";
import { lookupTrajectory } from "../memory/trajectory-cache.js";
import type { ChatProvider } from "../providers/lmstudio.js";
import { runWithCallAttribution } from "../runtime/request-context.js";
import { toSoftRoutingHint, type DynamicTurnGuidance } from "./intent-classifier.js";
import { userMessageCarriesActionableUrl } from "./citation-honesty.js";
import type { MainAssistantToolMode } from "./default-tools.js";
import { prefetchCapabilityCandidates, type DiscoveryCapsuleAgent } from "./discovery-prefetch.js";
import { noteIntentShadowCapsule } from "./intent-shadow.js";
import { readPromotedAgents } from "./promoted-agents.js";
import { resolveRoutingTierProvider, routingTierModelId } from "./routing-tier-provider.js";
import { timedPhase } from "./turn-metrics.js";
import { DELIVERABLE_EMITTING_TOOLS } from "../tools/delegation-artifact-classification.js";

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
  /** The turn has no catalog tools: the capsule names no workflow (prefetchCapabilityCandidates). */
  withoutWorkflows?: boolean;
  budgetMs?: number;
  /**
   * The capsule's agents with their routing confidence, in its order, called before the returned
   * promise settles. Only when the capsule came within the budget, so a caller sees exactly the
   * routing the turn's first prompt was built with; not at all on a timeout or an error.
   */
  onCapsuleAgents?: (agents: readonly DiscoveryCapsuleAgent[]) => void;
}): Promise<string> {
  const budgetMs = params.budgetMs ?? DISCOVERY_PREFETCH_BUDGET_MS;
  return timedPhase("discoveryPrefetch", async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The capsule's agent names, for the intent readout's shadow (agent/intent-shadow.ts): the
    // candidate list the turn actually had, so none when the capsule came too late.
    let capsuleAgents: readonly string[] = [];
    let capsuleCandidates: readonly DiscoveryCapsuleAgent[] = [];
    let capsuleLate = false;
    try {
      const capsule = await Promise.race([
        prefetchCapabilityCandidates(params.userMessage, {
          ...(params.allowedAgents ? { allowedAgents: [...params.allowedAgents] } : {}),
          ...(params.withoutWorkflows ? { withoutWorkflows: true } : {}),
          sessionId: params.sessionId,
          onAgents: (names, agents) => {
            capsuleAgents = names;
            capsuleCandidates = agents ?? [];
          },
        }),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => {
            capsuleLate = true;
            resolve("");
          }, budgetMs);
        }),
      ]);
      noteIntentShadowCapsule(params.sessionId, capsuleLate ? { status: "timeout" } : { status: "ok", agents: capsuleAgents });
      if (!capsuleLate && params.onCapsuleAgents) {
        try {
          params.onCapsuleAgents(capsuleCandidates);
        } catch {
          // An observer's failure is never the capsule's.
        }
      }
      return capsule;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }).catch(() => "");
}

/**
 * The discovery prefetch routed the turn to an agent whose work is a deliverable: the capsule's top
 * agent was admitted at high confidence and holds a tool whose call is itself the deliverable
 * (DELIVERABLE_EMITTING_TOOLS: a diagram, a chart, a site, a deck, a document).
 *
 * This is how an --auto turn's forced first tool call (orchestration.autonomousModeAntiRefusal)
 * sees an artifact request the deliverable-intent word lists miss. "Zeichne den folgenden
 * Bestellablauf als Mermaid-Flussdiagramm" matched none of their verbs or nouns, so the turn was
 * not forced, and the model drew the diagram inline while the capsule it had been given named
 * diagram_designer [high] (E2E core-build-artifact-mermaid). Routing reads the request in any
 * language, and the turn has already paid for it. Only the top agent counts, and an agent the
 * configuration does not know holds no tool.
 *
 * The confidence check narrows less than it reads. With an embedding model configured, as on the
 * deployed stack, the prefetch admits an agent only at a semantic score of 0.72 or more, and 0.72 is
 * also where "high" begins (tools/agent-routing.ts confidenceLabel), so every agent the capsule
 * lists is high. The check filters only the lexical path routing takes without an embedding model,
 * which admits an agent from 0.45. On the deployed stack the condition is the top agent's tools
 * alone, whether or not the request asks for a deliverable, so it no longer arms the forced call by
 * itself: it decides whether the turn asks the intent readout (startProduceIntentRead), and only a
 * reading that the request asks for something to be made or done arms it.
 */
export function prefetchRoutedToDeliverableEmitter(agents: readonly DiscoveryCapsuleAgent[]): boolean {
  const top = agents[0];
  if (!top || top.confidence !== "high") return false;
  const config = getConfig();
  const agentCfg = config.subAgents[top.name] ?? readPromotedAgents(config.workspacePath)[top.name];
  return (agentCfg?.tools ?? []).some((tool) => DELIVERABLE_EMITTING_TOOLS.has(tool));
}

/**
 * The intent readout's `mode` options under which a request asks for an answer, not for something to
 * be made or done: a reply from general knowledge (converse), findings (GATHER), a verdict on
 * something that already exists (VERIFY). The other three, PRODUCE, ACT and ORCHESTRATE, are work.
 */
export const ASK_MODES: ReadonlySet<string> = new Set(["converse", "GATHER", "VERIFY"]);

/**
 * Wall-clock bound on the produce-intent read, both option orders together. Iteration 0 waits for
 * it, so it is well under the shadow's own bound (INTENT_SHADOW_TIMEOUT_MS, 15 s). The shadow's
 * 0.86-1.16 s a call is not what a turn saw. Probed on the Halo (2026-10-09) with a new message for
 * every read and the four ways of asking interleaved in one run, 24 reads each alone and 24 with
 * the source judge's call beside it, as a turn sends it, and 20 with the judge after every slot of
 * the server had been overwritten: the two orders one after the other, each writing its whole
 * reply, took p50 3.8 s alone and 5.3 s beside the judge, and ran past this bound on all 20 reads
 * after the overwrite. Asked as now, both at once and the mode line alone
 * (PRODUCE_INTENT_READ_MAX_TOKENS), the read took p50 1.9 s alone (p90 2.0 s), 2.7 s beside the
 * judge (p90 3.1 s) and 5.1 s after the overwrite (p90 and max 5.1 s). None of those 68 reached the
 * bound, but after the overwrite less than a second was left: a turn that finds the server's slots
 * taken by other prompts is the one to watch.
 */
export const PRODUCE_INTENT_READ_TIMEOUT_MS = 6_000;

/**
 * The produce-intent read's output cap: the reply's first line and no more. The verdict reads the
 * mode facet alone, and mode is the line the grammar writes first, so nothing after it can change
 * it: the six other letters and the English restatement were tokens the turn's first call waited
 * for, 43 to 54 a pass, decoded at about 42 a second a stream on the Halo (2026-10-09). `mode: C`
 * is three tokens on Qwen's tokenizer (a cap of two read no mode); three more leave room for a
 * tokenizer that splits the label. A reply cut there reads the mode as the whole reply does and the
 * other facets as missing (parseIntentReadout).
 */
export const PRODUCE_INTENT_READ_MAX_TOKENS = 6;

/** What the readout's mode says of the request: something to be made or done, or an answer. */
export type ProduceIntentVerdict = "produce" | "ask";

/**
 * The readout's mode as a verdict: "produce" only when every reading of it is work — the choice and,
 * on a both-orders reading, each order's own choice (PRODUCE, ACT or ORCHESTRATE, not necessarily the
 * same one) — "ask" when any of them is one of ASK_MODES, null when the facet was not read. Pure.
 *
 * The averaged choice alone forced questions. "Wie erstelle ich eine Präsentation in PowerPoint?"
 * read converse in the served order and PRODUCE in the reversed one on all 47 reads of the probe of
 * 2026-10-09, and the average landed on PRODUCE on 5 of them. On 64 build reads the rule changed no
 * verdict: every build read work in both orders except a request to run a research workflow, which
 * read GATHER in one order and in the average too, so either rule reads it as an answer and the
 * readout does not force it (agent/runtime.ts says what does). Requiring both orders costs a build
 * nothing there, and keeps a question whose orders disagree from being forced.
 */
export function produceIntentVerdict(mode: Pick<IntentFacetRead, "choice" | "orders"> | undefined): ProduceIntentVerdict | null {
  if (!mode) return null;
  const readings = [mode.choice, mode.orders?.served, mode.orders?.reversed].filter((choice): choice is string => choice !== undefined);
  return readings.some((choice) => ASK_MODES.has(choice)) ? "ask" : "produce";
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * Ask the intent readout whether an --auto turn the discovery prefetch routed to a deliverable
 * emitter (prefetchRoutedToDeliverableEmitter) asks for something to be made or done, before its
 * first call is forced. On the embedding path that routing reads the top agent's tools and not the request, and
 * in the E2E window of 2026-10-09 only routing margins kept a question from being forced: for a
 * question about an attached .docx the emitter on top fell 0.03 short of the admission floor, and
 * "Tell me how API keys work" put an agent that holds none at 0.846, just ahead of emitters admitted
 * at 0.817. The readout's mode reads the request itself, in any language, and asks exactly this:
 * what the request asks the assistant to do, the verb and not the topic. On the bench it read mode
 * right in 84.8 % of 312 cases with both option orders averaged and in 74.2 % with one, and on real
 * turns seven questions had PRODUCE as runner-up with the two orders disagreeing, so both are asked,
 * at once (askIntentReadout concurrentOrders) and only as far as the mode line
 * (PRODUCE_INTENT_READ_MAX_TOKENS): the turn's first call waits for them. Both orders must read
 * work for the verdict to be "produce" (produceIntentVerdict).
 *
 * Resolves to "produce", "ask", or null when there is no reading: an Anthropic routing tier (the
 * readout needs a grammar and token logprobs, which only a llama.cpp server gives, and the shadow
 * skips it there for the same reason), no provider, a timeout, the turn stopped, a reply without
 * logprobs, an error, or no mode facet in it. A mode only one of the two orders read is no reading
 * either: askIntentReadout still answers when the reversed call failed or missed the slot, with the
 * served pass alone (or the reversed pass alone), and one order is the reading that was rejected
 * for this decision. The routing arm does not force on null: a question is not to be forced, and
 * without a reading the orchestrator decides as it does on any other turn.
 *
 * The verdict keeps a question from being forced only when the readout reads it as one. A question
 * how to make a thing that names no tool to make it with ("How do I make a good slide about
 * tides?") read PRODUCE in both orders on every read of the probe of 2026-10-09, and is forced like
 * the request to make it (agent/runtime.ts has the measurement).
 *
 * The word-list arm asks the same read (`arm: "word_list"`): the deliverable-intent word lists fire
 * on a question about making something as on a request to make it. There "ask" releases the forced
 * call and null leaves it to the word lists, as before, which forces a question among them too: an
 * exception to the decision of 2026-10-09 that the user has yet to rule on (agent/runtime.ts says
 * why it was kept).
 *
 * Logs one row (guardrail_flagged, type auto_artifact_build_mode_read): the outcome, and for a
 * reading the mode's choice, top probability, margin, runner-up, each order's own choice and whether
 * they agreed, and which pass read it when only one did. Never the user's message, the digest or the
 * readout's restatement. Never rejects.
 */
export async function startProduceIntentRead(params: {
  userMessage: string;
  /** The prior exchange, as the facet triage and the shadow give it to the readout (buildPriorTurnDigest). */
  priorTurnDigest?: string;
  sessionId: string;
  /** The turn's signal: a stopped turn stops the read. */
  signal: AbortSignal;
  timeoutMs?: number;
  /**
   * Which --auto arm asked, for the row: the deliverable-intent word lists, which force without a
   * reading, or the prefetch's routing, which does not (agent/runtime.ts autonomousArtifactBuild).
   */
  arm?: "word_list" | "routing";
}): Promise<ProduceIntentVerdict | null> {
  const started = Date.now();
  const record = (outcome: string, mode?: IntentFacetRead, ms?: number): void => {
    try {
      logAudit("guardrail_flagged", {
        type: "auto_artifact_build_mode_read",
        outcome,
        ...(params.arm ? { arm: params.arm } : {}),
        ...(mode
          ? {
              choice: mode.choice,
              top: round4(mode.top),
              margin: round4(mode.margin),
              runnerUp: mode.runnerUp ?? null,
              servedChoice: mode.orders?.served ?? null,
              reversedChoice: mode.orders?.reversed ?? null,
              orderAgreed: mode.orders?.agreed ?? null,
              ...(mode.orders?.singlePass ? { singlePass: mode.orders.singlePass } : {}),
            }
          : {}),
        ms: ms ?? Date.now() - started,
      }, { sessionId: params.sessionId, severity: "info" });
    } catch {
      // A row that could not be written costs the measurement, never the turn.
    }
  };
  try {
    let modelId = "";
    try {
      modelId = routingTierModelId();
    } catch {
      // unknown: asked, and a reply without logprobs is recorded as that
    }
    if (modelId.split("/")[0]?.trim() === "anthropic") {
      record("no_logprobs_provider");
      return null;
    }
    let provider: ChatProvider;
    try {
      provider = resolveRoutingTierProvider();
    } catch {
      record("no_provider");
      return null;
    }
    const timeout = AbortSignal.timeout(params.timeoutMs ?? PRODUCE_INTENT_READ_TIMEOUT_MS);
    const result = await runWithCallAttribution({ callSite: "routing_tier", agentName: "intent_readout" }, () => askIntentReadout(
      provider,
      { userMessage: params.userMessage, ...(params.priorTurnDigest ? { priorTurnDigest: params.priorTurnDigest } : {}) },
      { signal: AbortSignal.any([params.signal, timeout]), bothOrders: true, concurrentOrders: true, maxTokens: PRODUCE_INTENT_READ_MAX_TOKENS },
    ));
    if (!result.ok) {
      record(params.signal.aborted ? "aborted" : timeout.aborted ? "timeout" : result.reason, undefined, result.ms);
      return null;
    }
    const mode = result.readout.facets.mode;
    if (mode?.orders?.singlePass) {
      record("single_pass", mode, result.readout.ms);
      return null;
    }
    const verdict = produceIntentVerdict(mode);
    record(verdict ?? "no_mode", mode, result.readout.ms);
    return verdict;
  } catch {
    record("error");
    return null;
  }
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

/**
 * The evidence requirement a turn hands its tools (ToolContext.turnEvidence), or undefined.
 *
 * The up-front judge's verdict reached only the turn's own enforcement (requiresDelegatedResearch,
 * the tool mode). The delegations the turn then made — inside record_plan's fold and execute_plan
 * above all — never saw it, so the research gate fell back to an English-only word shape and a plan
 * written in German ran web_coder on a research step (E2E 2026-10-07). Only the orchestrator's own
 * turn carries it: a workflow step runs the agents the scene's author named, and a directed turn
 * (`--agent`) runs the agent the user named. A workflow step is either a nested turn (channel
 * "workflow", or a workflow on the execution stack) or a queued scene or job, scheduled tasks
 * included, which the scene worker runs as a turn of its own on channel "scene" with no stack: the
 * judge runs on those too, and the trigger would otherwise replace the agent the author named.
 */
export function turnEvidenceRequirement(params: {
  upfrontSourceSensitive: boolean;
  channel: string;
  workflowDepth: number;
  directiveAgent?: string;
}): { required: true } | undefined {
  if (!params.upfrontSourceSensitive) return undefined;
  if (params.channel === "workflow" || params.channel === "scene" || params.workflowDepth > 0) return undefined;
  if (params.directiveAgent?.trim()) return undefined;
  return { required: true };
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
