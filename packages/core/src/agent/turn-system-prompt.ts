/**
 * Per-iteration PROMPT-ASSEMBLY phase for the main agent turn loop.
 *
 * Lifted VERBATIM out of the main while-loop in agent/runtime.ts `_runTurn`
 * (pure decomposition - zero behavior change). It READS turn/iteration state
 * plus the enforcement/guidance prompt strings the loop computed for THIS
 * iteration, and PRODUCES the assembled system messages plus the few derived
 * values the loop consumes afterward (see {@link AssembleTurnSystemMessagesResult}).
 *
 * Every side effect is preserved exactly as it ran inside the loop:
 *  - the timedPhase() discovery/profile prefetch wrappers (same budgets/races),
 *  - the prompt_section_sizes / discovery_prefetch / prompt_budget_exceeded
 *    audit events,
 *  - the freshness-honesty guard,
 *  - the prompt-budget trimmer (same priority order, same
 *    buildSystemMessages()/measurePrompt() re-measure loop).
 *
 * `buildTemporalContextPrompt` and `applyRoutingTone` are passed in as functions
 * (they are runtime.ts-local) so this module needs no import from runtime.js -
 * keeping the dependency edge one-directional (no import cycle).
 */
import type { LLMMessage } from "../providers/lmstudio.js";
import type { AgentSession } from "./session.js";
import { splitOrchestrationModule } from "./session.js";
import type { DynamicTurnGuidance } from "./intent-classifier.js";
import {
  buildLanguageAndIdentityTurnGuidance,
  looksMultiDomainResearch,
} from "./intent-classifier.js";
import {
  looksLikeArtifactCreationRequest,
  looksLikeComposedGuideRequest,
} from "./deliverable-intent.js";
import {
  timedPhase,
  measurePrompt,
  compactBasePromptUnderPressure,
} from "./turn-metrics.js";
import { formatFlowMemoryGuidance } from "./flow-memory.js";
import { formatScopedMemoryGuidance } from "../memory/service.js";
import { retrieveSkillGuidance } from "../skills/service.js";
import { formatUserModelGuidance } from "../user-model/service.js";
import { buildMemoryCapsule } from "./receptionist.js";
import { prefetchCapabilityCandidates } from "./discovery-prefetch.js";
import { buildUserProfileEvidence } from "./user-profile-prefetch.js";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";

const log = childLogger("agent:runtime");

export interface AssembleTurnSystemMessagesParams {
  session: AgentSession;
  iterationCount: number;
  userMessage: string;
  initialDynamicGuidance: DynamicTurnGuidance | null;
  documentRagFoundDocs: boolean;
  trajectoryInjectionContext: string;
  sharedFindingsSystemMessage: string;
  priorEvidenceFollowUpPrompt: string;
  sessionEvidenceReuseNudge: string;
  effortPromptAddendum: string;
  workflowCatalogGuidance: string;
  approvedRunCandidateGuidance: string;
  delegatedResearchEnforcementPrompt: string;
  searchAgentsNoMatchFallbackPrompt: string;
  maintenanceDelegationEnforcementPrompt: string;
  unresolvedDelegationEnforcementPrompt: string;
  workflowCatalogEnforcementPrompt: string;
  approvedRunCandidateEnforcementPrompt: string;
  workflowExecutionEnforcementPrompt: string;
  injectedSkillSlugs: string[];
  heldOutSkillSlugs: string[];
  applyRoutingTone: (text: string) => string;
  buildTemporalContextPrompt: () => string;
  lastPromptMetrics: ReturnType<typeof measurePrompt>;
}

export interface AssembleTurnSystemMessagesResult {
  messages: LLMMessage[];
  collapsedHistory: LLMMessage[];
  dynamicGuidance: DynamicTurnGuidance | null;
  lastPromptMetrics: ReturnType<typeof measurePrompt>;
  injectedSkillSlugs: string[];
  heldOutSkillSlugs: string[];
}

/**
 * Place the per-turn guidance so the leading system run stays byte-identical across iterations.
 *
 * With `stable` on, the request is head → history → guidance: the head is the KV-cache key and
 * never changes within a turn, and the guidance lands after the history, where every provider
 * already handles a non-leading system message (folded to user-role context in position by the
 * LM Studio provider, delivered as user-turn context by the Anthropic one). With it off, the
 * previous shape is preserved: every system message leads, and the head differs per iteration.
 */
export function composeTurnMessages(
  head: readonly LLMMessage[],
  history: readonly LLMMessage[],
  guidance: readonly LLMMessage[],
  stable: boolean,
): LLMMessage[] {
  return stable
    ? [...head, ...history, ...guidance]
    : [...head, ...guidance, ...history];
}

export async function assembleTurnSystemMessages(
  params: AssembleTurnSystemMessagesParams,
): Promise<AssembleTurnSystemMessagesResult> {
  const {
    session,
    iterationCount,
    userMessage,
    initialDynamicGuidance,
    documentRagFoundDocs,
    trajectoryInjectionContext,
    sharedFindingsSystemMessage,
    priorEvidenceFollowUpPrompt,
    sessionEvidenceReuseNudge,
    effortPromptAddendum,
    workflowCatalogGuidance,
    approvedRunCandidateGuidance,
    delegatedResearchEnforcementPrompt,
    searchAgentsNoMatchFallbackPrompt,
    maintenanceDelegationEnforcementPrompt,
    unresolvedDelegationEnforcementPrompt,
    workflowCatalogEnforcementPrompt,
    approvedRunCandidateEnforcementPrompt,
    workflowExecutionEnforcementPrompt,
    applyRoutingTone,
    buildTemporalContextPrompt,
  } = params;
  // Skill slugs are carried in/out: on a context-injecting iteration the body reassigns them;
  // otherwise the passed-in values pass through unchanged (identical to the outer `let`s the
  // loop previously mutated in place). The metrics object is NOT carried in — every path
  // through this function measures the prompt it has just assembled, so the incoming value is
  // never the one returned.
  let injectedSkillSlugs = params.injectedSkillSlugs;
  let heldOutSkillSlugs = params.heldOutSkillSlugs;
  let lastPromptMetrics: ReturnType<typeof measurePrompt>;
    let systemPrompt = session.getSystemPrompt();
    // Split orchestration prompt (agents.performance.splitOrchestrationPrompt, default off): the
    // ~13KB orchestration block (Swarm Rules → Orchestration Strategy) is only needed on turns that
    // actually orchestrate. Lift it out of the always-on base so a direct-answer turn pays a roughly
    // half-size prompt, and inject it back ONLY when the turn shows orchestration intent (the per-turn
    // classifier fired). The delegation TOOLS stay available regardless, so a misclassified turn loses
    // routing GUIDANCE, not capability; the honesty/core sections stay in the lean base either way.
    // Marker-based + guarded (a custom/absent prompt is left untouched), and the lean core stays the
    // cacheable KV prefix for both paths.
    let orchestrationModuleMsg = "";
    if (getConfig().agents.performance.splitOrchestrationPrompt === true) {
      const { leanBase, orchestrationModule } = splitOrchestrationModule(systemPrompt);
      if (orchestrationModule) {
        systemPrompt = leanBase;
        // Inject the module only on turns that actually ROUTE — a delegation-intent classifier
        // flag, an artifact/app/deck/site build, or a composed multi-part deliverable. The mere
        // PRESENCE of guidance is not enough: the direct-answer classes (userOwnFacts,
        // inlineAnalyticalContent, durableMemorySensitive, assistantNaming) also produce a
        // non-null guidance object, but their prompts say recall/store/answer-directly and never
        // delegate — so gating on `!!initialDynamicGuidance` re-injected the ~13KB module on
        // exactly the turn class the split targets (e.g. a CV-fit question), defeating it. Gate
        // on the orchestration-intent SUBSET instead. Delegation tools stay available regardless,
        // so a misclassified turn loses routing prose, not capability.
        const g = initialDynamicGuidance;
        const orchestrationIntent = !!g && (g.freshnessSensitive || g.sourceSensitive || g.mailSensitive
          || g.computerAccessSensitive || g.serverAccessSensitive || g.pentestMethodologySensitive
          || g.swarmMaintenanceSensitive || g.artifactSensitive);
        const needsOrchestrationModule = orchestrationIntent
          || looksLikeArtifactCreationRequest(userMessage)
          || looksLikeComposedGuideRequest(userMessage);
        if (needsOrchestrationModule) orchestrationModuleMsg = orchestrationModule;
      }
    }
    const temporalContext = buildTemporalContextPrompt();
    // The lean catalog withholds the direct capability tools from the request, so
    // the model has to be told that its tool list is a starting point rather than
    // the full set — otherwise a missing tool reads as "I cannot do this".
    const leanToolCatalogNotice = getConfig().agents.performance.leanToolCatalog === true
      ? "TOOL CATALOG IS PARTIAL: the tools listed for this turn are a starting set, not the limit of what you can do. "
        + "More tools exist and can be added to THIS turn on demand. If you need a capability that is not in your current "
        + "tool list (reading or writing files, running code or shell commands, fetching a URL, generating a document or "
        + "image, and so on), call search_tools with a short description of what you need, then call load_tool with the "
        + "exact name it returns — the tool becomes callable on your next step. Never tell the user a task is impossible, "
        + "and never ask them to do it manually, because a tool was missing from the list: look for it and load it first."
      : "";
    const dynamicGuidance = iterationCount === 0 ? initialDynamicGuidance : null;
    // Lean context injection: when on, the heavy per-turn memory/user-model/skill/
    // flow/trajectory blocks are not pushed into the prompt — the model pulls them
    // on demand via recall_context (see config.agents.performance.leanContextInjection).
    // This also skips the retrieval calls entirely, saving latency on turns that
    // don't need that context.
    const leanContextInjection = getConfig().agents.performance.leanContextInjection === true;
    const injectTurnContext = iterationCount === 0 && !leanContextInjection;
    let flowGuidance = injectTurnContext
      ? formatFlowMemoryGuidance(session.getWorkspacePath(), userMessage, { limit: 3 })
      : "";
    const languageAndIdentityGuidance = iterationCount === 0
      ? buildLanguageAndIdentityTurnGuidance(userMessage)
      : "";
    // Memory guidance and procedural-skill guidance are independent and each do a
    // query embedding, so run them concurrently instead of serially on time-to-first
    // -LLM-call. (formatFlowMemoryGuidance above is synchronous — it stays out of the
    // batch.) Skills surface reusable approaches the swarm distilled; guidance only.
    const skillRetrievalEnabled = injectTurnContext && getConfig().skillLibrary.enabled;
    // Discovery prefetch (staged orchestration S4): start it HERE so its embedding
    // round-trip OVERLAPS the memory+skill embeddings below instead of running serially
    // after them — all three independent retrievals fire concurrently, shaving an
    // embedding round-trip off time-to-first-LLM-call on escalated turns. Soft head
    // start (not a gate), compact + droppable, flag-gated default-off; best-effort —
    // never blocks the turn (errors and the timeout both resolve to an empty capsule).
    const DISCOVERY_PREFETCH_BUDGET_MS = 2500;
    const discoveryPrefetchPromise: Promise<string> =
      iterationCount === 0 && getConfig().orchestration?.discoveryPrefetch
        ? timedPhase("discoveryPrefetch", async () => {
            // HARD latency cap: the embedding round-trip behind the capsule can stall on
            // a cold/queued embed backend (observed ~15s on a busy LM Studio). Bound it
            // so a slow prefetch is abandoned (empty capsule) rather than delaying the
            // turn; the model then discovers on demand.
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                prefetchCapabilityCandidates(userMessage),
                new Promise<string>((resolve) => { timer = setTimeout(() => resolve(""), DISCOVERY_PREFETCH_BUDGET_MS); }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          }).catch(() => "")
        : Promise.resolve("");
    // Proactive user-profile prefetch (orchestration.userProfilePrefetch, default-off,
    // eval-gated): on a userOwnFacts turn (a question about the user's OWN background /
    // skills / fit), retrieve their memory records + attached documents (an uploaded
    // CV/profile) up-front and inject the evidence — or an authoritative confirmed-empty
    // marker — so the model answers from a REAL lookup instead of fabricating or admitting
    // blindly (the audited toolCalls=0 "I have no info about you" failure). Started HERE so
    // it OVERLAPS the memory/skill/discovery embeddings; bounded by a hard latency cap so a
    // slow/cold embed backend degrades to "" (the reworded retrieve-first digest then still
    // covers it). Fires ONLY on the narrow self-referential class → trivial turns pay nothing.
    // Generous budget: the engram embedding + Qwen rerank for the profile lookup can
    // take a few seconds, and missing the CV is worse than a slightly slower userOwnFacts
    // turn. Still capped so a stalled embed backend degrades to "" (the per-turn RAG then
    // covers it) rather than hanging the turn.
    const PROFILE_PREFETCH_BUDGET_MS = 8000;
    // SIGNAL (restored 2026-07-27): de-lexicalization deleted the userOwnFacts keyword
    // tables and hardwired the flag to false, which left this whole subsystem unable to
    // fire. The replacement is structural rather than lexical, exactly as that change
    // intended: `documentRagFoundDocs` means the per-turn RAG surfaced real user-scope
    // document content for THIS query — i.e. the user has material of their own that
    // bears on what they just asked. That is language-independent, costs nothing extra
    // (the boolean is already computed upstream), and is precisely the audited failure
    // case: a CV is attached, yet the turn answers "I have no info about you".
    // `userOwnFacts` is kept in the condition so a future semantic classifier can feed
    // this path without touching the gate again.
    const userProfileEvidenceWarranted = documentRagFoundDocs || dynamicGuidance?.userOwnFacts === true;
    const userProfilePrefetchPromise: Promise<string> =
      iterationCount === 0
        && userProfileEvidenceWarranted
        && getConfig().orchestration?.userProfilePrefetch === true
        ? timedPhase("userProfilePrefetch", async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                buildUserProfileEvidence(session.getWorkspacePath(), userMessage, session.id, session.userId, {
                  // DEDUP: the per-turn RAG above already retrieved + injected the CV with the
                  // same profile-biased query, so skip the duplicate doc retrieval here and add
                  // only memory + the right confirmed-empty signal.
                  skipDocRetrieval: true,
                  documentsAlreadyInjected: documentRagFoundDocs,
                }),
                new Promise<string>((resolve) => { timer = setTimeout(() => resolve(""), PROFILE_PREFETCH_BUDGET_MS); }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          }).catch(() => "")
        : Promise.resolve("");
    const [memoryGuidanceText, skillRetrieved, prefetchedDiscoveryCapsule, userProfileEvidence] = await Promise.all([
      injectTurnContext
        ? formatScopedMemoryGuidance(session.getWorkspacePath(), userMessage, {
            sessionId: session.id,
            scopes: ["session", "workspace", "user"],
            limit: 4,
            maxChars: Math.min(1_400, Math.round(getConfig().agents.performance.promptBudgetChars * 0.08)),
          })
        : Promise.resolve(""),
      skillRetrievalEnabled
        ? retrieveSkillGuidance(session.getWorkspacePath(), userMessage, {
            maxChars: Math.min(1_400, Math.round(getConfig().agents.performance.promptBudgetChars * 0.08)),
            // LRN-403: pins this session to one holdout arm per skill (persistent
            // across turns and restarts) so lift measurement compares matched groups.
            assignmentKey: session.id,
          })
        : Promise.resolve(null),
      discoveryPrefetchPromise,
      userProfilePrefetchPromise,
    ]);
    let memoryGuidance = memoryGuidanceText;
    let skillGuidance = "";
    if (skillRetrieved) {
      skillGuidance = skillRetrieved.text;
      injectedSkillSlugs = skillRetrieved.slugs;
      heldOutSkillSlugs = skillRetrieved.heldOutSlugs ?? [];
    }
    // Dialectic user model — small, injected only when populated. Adapts the
    // agent to the user across sessions; droppable under prompt budget.
    let userModelGuidance = injectTurnContext ? formatUserModelGuidance() : "";
    let activeTrajectoryInjectionContext = injectTurnContext ? trajectoryInjectionContext : null;
    // In lean mode, replace the always-on context blocks with a one-line pointer
    // so the model knows to pull what it needs instead of assuming it is in view.
    // Lean-mode context pointer. Even when the fuller context is left to
    // recall_context, the user's DURABLE facts (name/role/preferences/decisions)
    // must be present as authoritative DATA the model can rely on — not left to a
    // tool round-trip, and not papered over with per-question classifier special-
    // cases (user steer: "give it programmatically the user-memory as systemprompt
    // as data to rely on"). Compact + capped (reuses the receptionist capsule) so
    // the prompt stays lean; the user model, session facts, related sessions and
    // skills still come on demand via recall_context.
    let contextRecallDigest = "";
    if (iterationCount === 0 && leanContextInjection) {
      let durableCapsule = "";
      try {
        durableCapsule = buildMemoryCapsule(session.getWorkspacePath(), 600);
      } catch { /* no capsule → recall_context still covers it */ }
      const parts: string[] = [];
      if (durableCapsule.trim()) {
        parts.push(
          "Durable facts the user has had you remember — authoritative; rely on these and do not re-ask or contradict them:",
          durableCapsule,
          "",
        );
      } else if (!userProfileEvidence && !documentRagFoundDocs) {
        // No durable facts are PRELOADED, the proactive profile prefetch did not inject an
        // authoritative result, AND the per-turn document-RAG surfaced no CV/profile this
        // turn. (When ANY of those DID happen — prefetch found a profile / confirmed-empty,
        // OR the [DOCUMENT CONTEXT] carries the CV — this "no facts" marker is suppressed so
        // it can never contradict the retrieved evidence: the "keine gespeicherten
        // Informationen … aber ich sehe Ihren CV" awkwardness.) Make explicit that this is the lean-context
        // default — NOT the result of a lookup — so the model cannot (a) fabricate a profile
        // from nothing, nor (b) read "not preloaded" as "checked and empty" and admit
        // ignorance without retrieving. Structural (keys off an empty capsule), language-independent.
        parts.push(
          "No durable facts, user model, or documents are PRELOADED into this turn — but that is the lean-context default, NOT the result of a lookup: nothing has been searched yet, so absence here is NOT evidence that nothing is stored. If the turn asks about the user's OWN background, experience, skills, employers, education, projects, fit, or identity, you MUST call recall_context (it also returns excerpts from an attached CV/profile) — and search_documents if more is needed — THIS turn BEFORE answering. Only after that retrieval actually returns nothing may you say plainly that you have no stored information and ask them to provide it. Never invent a profile, and never treat 'not preloaded' as 'already checked and empty'. A tool-free 'I have no information about you' is INVALID until the retrieval has run this turn.",
          "",
        );
      }
      parts.push(
        "The user model, this session's working facts, recent related sessions, and learned skills are NOT preloaded — call recall_context(query) to pull those when a turn needs them. Do not assume that deeper context is already in view.",
      );
      contextRecallDigest = parts.join("\n");
    }
    // Plan-first checkpoint: on a genuinely multi-area / multi-step turn, nudge
    // the orchestrator to record a short structured plan before fanning out so
    // the risk-gated QA pass can check the answer against acceptance criteria and
    // the operator dock can surface a high-stakes plan for approval. Soft and
    // droppable; trivial and single-domain turns are unaffected.
    let planGuidance = "";
    if (iterationCount === 0 && (getConfig().orchestration?.planFirst ?? true)) {
      planGuidance = looksMultiDomainResearch(userMessage)
        ? "PLAN FIRST: this spans several steps/areas. Before fanning out, CONSIDER REUSABLE WORKFLOWS: if a 'Strong reusable match' scene/job is noted this turn, plan a reuse step NAMING it (workflow: <name>); otherwise call search_workflows ONCE to check whether an existing scene or job already fits before decomposing into agents. Then call record_plan once with a short plan — objective; the few steps (each tagged reuse | delegate | direct, with agentName for delegate steps and a parallelGroup for genuinely independent work); the acceptance criteria the answer must meet; and stop conditions. Prefer a reuse step over decomposing into agents when one fits. Do not over-fan-out — keep parallel work to independent steps only. Then call execute_plan ONCE: it runs the steps in dependency order, runs a parallelGroup concurrently, passes each step's result to the steps that depend on it, and hands back any `direct` steps for you to do. Do not re-issue the plan's steps as separate calls."
        // Plan on every crucial turn, not just multi-domain research: a brief plan
        // gives the risk-gated QA gate explicit acceptance criteria to verify the
        // answer against, and makes the model decide the route before acting. Kept
        // lightweight so a single-domain task isn't taxed — and a pure direct-
        // knowledge answer skips it entirely (DIRECT ANSWER FIRST still holds).
        : "PLAN FIRST: if this needs any tool, delegation, retrieval, or multi-step work, call record_plan ONCE with a SHORT plan before acting — objective; the step(s) (each tagged reuse | delegate | direct, with agentName for delegate steps); the acceptance criteria the final answer must meet; and stop conditions. A one-line objective with one or two acceptance criteria is enough for a simple single-step task — keep it lightweight. Set riskTier 'high' only when the task makes current/sourced factual claims, takes an external/destructive/credential action, or is otherwise consequential. If the request is fully answerable directly from your own knowledge in one reply, SKIP the plan and just answer. Then run it in the same turn: if the plan has any delegate or reuse step, call execute_plan once to dispatch them (it carries each result into the steps that depend on it); `direct` steps are yours.";
    }
    // discoveryCapsule (staged orchestration S4) was prefetched CONCURRENTLY with the
    // memory+skill embeddings above (discoveryPrefetchPromise) so it no longer adds a
    // serial round-trip to first-token. It injects a compact agent+workflow capsule so
    // the coordinator can plan without first spending slow search_agents/search_workflows
    // rounds. Kept as `let` so the prompt-budget trimmer below can drop it; audited here
    // where the rest of the turn-context capsules are assembled.
    let discoveryCapsule = prefetchedDiscoveryCapsule;
    if (discoveryCapsule) {
      logAudit("discovery_prefetch", { capsuleChars: discoveryCapsule.length }, { sessionId: session.id });
    }
    const collapsedHistory = session.getCollapsedHistory();

    // Freshness-honesty guard (orchestration.freshnessHonestyGuard, default-off,
    // eval-gated): a short, language-independent directive that stops the orchestrator
    // dressing a parametric-memory answer up as freshly-sourced data — the "answered
    // directly with 0 tool calls but opened 'based on current market data…'" failure.
    const freshnessHonestyPrompt = getConfig().orchestration?.freshnessHonestyGuard
      ? "HONESTY ON CURRENCY: Do NOT claim or imply your answer is based on current, live, recent, latest, or external data (market data, news, prices, current events, 'as of today/this year') unless you actually retrieved it via a tool THIS turn. If the answer materially depends on such data, route it to a research-capable specialist and validate it — never assert it from memory, and never frame a from-memory answer as if it were freshly sourced."
      : "";

    // THE HEAD IS THE CACHE KEY. LM Studio / llama.cpp reuse the KV cache for the longest
    // unchanged prefix of the rendered prompt, and the chat template renders the tool block
    // right after the leading run of system messages (which the provider folds into one).
    // Anything in that run that differs between two calls invalidates everything behind it —
    // the ~9K-token tool block and the whole history. Measured on this box: an identical prefix
    // prefilled in 1.36 s; 200 varying characters ahead of it, 6.25 s. So the head holds ONLY
    // what is invariant within a turn: the base prompt, the (per-turn) orchestration module, the
    // date, and the catalog notice. Everything that changes per iteration — language/identity,
    // dynamic guidance, the plan nudge, the discovery capsule, shared findings — is emitted as
    // the TAIL, after the history, where the provider relabels it as the most recent context.
    const buildStableHead = (): LLMMessage[] => [
      { role: "system", content: systemPrompt },
      // Orchestration module (split-prompt mode): injected right after the lean base so the base
      // stays the shared, cacheable prefix; present only on orchestration-intent turns.
      ...(orchestrationModuleMsg ? [{ role: "system" as const, content: orchestrationModuleMsg }] : []),
      { role: "system", content: temporalContext },
      // Lean tool catalog (B37): without this the model treats the shortened tool
      // list as its real capability ceiling — measured, it silently gave up and
      // asked the user to do the work by hand instead of loading the tool it
      // needed. Only present when the catalog is actually withheld, so it costs
      // nothing in the default configuration.
      ...(leanToolCatalogNotice ? [{ role: "system" as const, content: leanToolCatalogNotice }] : []),
    ];
    const buildTurnGuidance = (): LLMMessage[] => [
      ...(languageAndIdentityGuidance ? [{ role: "system" as const, content: languageAndIdentityGuidance }] : []),
      ...(priorEvidenceFollowUpPrompt ? [{ role: "system" as const, content: priorEvidenceFollowUpPrompt }] : []),
      ...(sessionEvidenceReuseNudge ? [{ role: "system" as const, content: sessionEvidenceReuseNudge }] : []),
      ...(dynamicGuidance ? [{ role: "system" as const, content: dynamicGuidance.prompt }] : []),
      ...(freshnessHonestyPrompt ? [{ role: "system" as const, content: freshnessHonestyPrompt }] : []),
      // Proactive user-profile evidence (default-off) leads the general retrieve-first
      // digest: when the prefetch ran it is the AUTHORITATIVE result of a real lookup
      // (found evidence, or a confirmed-empty fact) for a userOwnFacts turn.
      ...(userProfileEvidence ? [{ role: "system" as const, content: userProfileEvidence }] : []),
      ...(contextRecallDigest ? [{ role: "system" as const, content: contextRecallDigest }] : []),
      ...(effortPromptAddendum ? [{ role: "system" as const, content: effortPromptAddendum }] : []),
      ...(planGuidance ? [{ role: "system" as const, content: planGuidance }] : []),
      ...(discoveryCapsule ? [{ role: "system" as const, content: discoveryCapsule }] : []),
      ...(workflowCatalogGuidance ? [{ role: "system" as const, content: workflowCatalogGuidance }] : []),
      ...(approvedRunCandidateGuidance ? [{ role: "system" as const, content: approvedRunCandidateGuidance }] : []),
      ...(delegatedResearchEnforcementPrompt ? [{ role: "system" as const, content: delegatedResearchEnforcementPrompt }] : []),
      ...(searchAgentsNoMatchFallbackPrompt ? [{ role: "system" as const, content: applyRoutingTone(searchAgentsNoMatchFallbackPrompt) }] : []),
      ...(maintenanceDelegationEnforcementPrompt ? [{ role: "system" as const, content: applyRoutingTone(maintenanceDelegationEnforcementPrompt) }] : []),
      ...(unresolvedDelegationEnforcementPrompt ? [{ role: "system" as const, content: unresolvedDelegationEnforcementPrompt }] : []),
      ...(workflowCatalogEnforcementPrompt ? [{ role: "system" as const, content: applyRoutingTone(workflowCatalogEnforcementPrompt) }] : []),
      ...(approvedRunCandidateEnforcementPrompt ? [{ role: "system" as const, content: approvedRunCandidateEnforcementPrompt }] : []),
      ...(workflowExecutionEnforcementPrompt ? [{ role: "system" as const, content: workflowExecutionEnforcementPrompt }] : []),
      ...(flowGuidance ? [{ role: "system" as const, content: flowGuidance }] : []),
      ...(skillGuidance ? [{ role: "system" as const, content: skillGuidance }] : []),
      ...(userModelGuidance ? [{ role: "system" as const, content: userModelGuidance }] : []),
      ...(memoryGuidance ? [{ role: "system" as const, content: memoryGuidance }] : []),
      // G33: Inject cached trajectory evidence on first iteration only
      ...(iterationCount === 0 && activeTrajectoryInjectionContext ? [{ role: "system" as const, content: activeTrajectoryInjectionContext }] : []),
      // Inject shared findings from sub-agents on post-delegation iterations so the
      // main orchestrator's synthesis call sees verified facts instead of hallucinating
      // from training data (e.g. mic interface type, verified part specs, etc.).
      ...(sharedFindingsSystemMessage ? [{ role: "system" as const, content: sharedFindingsSystemMessage }] : []),
    ];
    // The union, for measurement and the budget trimmer, which reason about the system text as
    // one block regardless of where the provider ends up placing it.
    const buildSystemMessages = (): LLMMessage[] => [...buildStableHead(), ...buildTurnGuidance()];

    let systemMessages = buildSystemMessages();
    lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory, session.getToolSchemasChars());

    // ── Per-section prompt-size telemetry ─────────────────────────────────
    // Emitted once per turn (iteration 0) so we can see exactly what dominates
    // the system prompt and prove the win from lean context injection. The base
    // template is typically the bulk; memory/skill/user/flow/trajectory are the
    // reducible part that recall_context now covers on demand.
    if (iterationCount === 0) {
      logAudit("prompt_section_sizes", {
        total: lastPromptMetrics.systemPromptChars,
        base: systemPrompt.length,
        temporal: temporalContext.length,
        dynamicGuidance: dynamicGuidance?.prompt.length ?? 0,
        languageIdentity: languageAndIdentityGuidance.length,
        flow: flowGuidance.length,
        skill: skillGuidance.length,
        userModel: userModelGuidance.length,
        memory: memoryGuidance.length,
        plan: planGuidance.length,
        trajectory: activeTrajectoryInjectionContext?.length ?? 0,
        contextDigest: contextRecallDigest.length,
        leanContextInjection,
      }, { sessionId: session.id, severity: "info" });
    }

    // ── Prompt budget enforcement ─────────────────────────────────────────
    // Fix 6: when the system prompt exceeds the configured budget, trim
    // optional/auxiliary sections in priority order (least → most critical)
    // until under budget OR no further drops are available. The previous
    // behavior was to log a warning and ship the over-budget prompt anyway,
    // which never actually reduced any prompt and made the audit a dead
    // signal. We never touch the main systemPrompt or active enforcement
    // prompts — those were set this turn for a reason.
    if (iterationCount === 0) {
      const promptBudget = getConfig().agents.performance.promptBudgetChars;
      if (lastPromptMetrics.systemPromptChars > promptBudget) {
        const initialChars = lastPromptMetrics.systemPromptChars;
        const droppedSections: Array<{ name: string; chars: number }> = [];

        // Priority 1: trajectory injection (cached evidence — helpful but optional)
        if (lastPromptMetrics.systemPromptChars > promptBudget && activeTrajectoryInjectionContext) {
          droppedSections.push({ name: "trajectoryInjectionContext", chars: activeTrajectoryInjectionContext.length });
          activeTrajectoryInjectionContext = null;
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory, session.getToolSchemasChars());
        }
        // Priority 2: memory guidance (background context — non-critical)
        if (lastPromptMetrics.systemPromptChars > promptBudget && memoryGuidance) {
          droppedSections.push({ name: "memoryGuidance", chars: memoryGuidance.length });
          memoryGuidance = "";
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory, session.getToolSchemasChars());
        }
        // Priority 2b: skill guidance (procedural memory — non-critical)
        if (lastPromptMetrics.systemPromptChars > promptBudget && skillGuidance) {
          droppedSections.push({ name: "skillGuidance", chars: skillGuidance.length });
          skillGuidance = "";
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory, session.getToolSchemasChars());
        }
        // Priority 2c: user-model guidance (cross-session adaptation — non-critical)
        if (lastPromptMetrics.systemPromptChars > promptBudget && userModelGuidance) {
          droppedSections.push({ name: "userModelGuidance", chars: userModelGuidance.length });
          userModelGuidance = "";
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory, session.getToolSchemasChars());
        }
        // Priority 3: flow guidance (workflow memory — non-critical)
        if (lastPromptMetrics.systemPromptChars > promptBudget && flowGuidance) {
          droppedSections.push({ name: "flowGuidance", chars: flowGuidance.length });
          flowGuidance = "";
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory, session.getToolSchemasChars());
        }
        // Priority 3b: discovery prefetch capsule (a planning head start — the model
        // can still discover on demand, so it yields before the plan-first nudge).
        if (lastPromptMetrics.systemPromptChars > promptBudget && discoveryCapsule) {
          droppedSections.push({ name: "discoveryCapsule", chars: discoveryCapsule.length });
          discoveryCapsule = "";
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory, session.getToolSchemasChars());
        }
        // Priority 4: plan-first nudge — high value (governs turn structure), so
        // dropped only under the most extreme prompt pressure, after the above.
        if (lastPromptMetrics.systemPromptChars > promptBudget && planGuidance) {
          droppedSections.push({ name: "planGuidance", chars: planGuidance.length });
          planGuidance = "";
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory, session.getToolSchemasChars());
        }
        // Priority 4 (last resort): compact the base system prompt itself.
        // Until now the trimmer dropped only auxiliary blocks and shipped the
        // base over budget anyway — the base is the dominant consumer, so the
        // audit signal was effectively dead. This strips clearly non-load-bearing
        // verbose sections (response-format/formatting guidance) while preserving
        // Core Principles, Swarm Rules, Tool Use Discipline, and Security. It
        // fires only when everything else has been dropped and we are still over.
        if (lastPromptMetrics.systemPromptChars > promptBudget) {
          const compacted = compactBasePromptUnderPressure(systemPrompt);
          if (compacted.length < systemPrompt.length) {
            droppedSections.push({ name: "basePromptCompaction", chars: systemPrompt.length - compacted.length });
            systemPrompt = compacted;
            systemMessages = buildSystemMessages();
            lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory, session.getToolSchemasChars());
          }
        }

        const stillOver = lastPromptMetrics.systemPromptChars > promptBudget;
        logAudit("prompt_budget_exceeded", {
          systemPromptChars: lastPromptMetrics.systemPromptChars,
          budgetChars: promptBudget,
          initialChars,
          excessChars: Math.max(0, lastPromptMetrics.systemPromptChars - promptBudget),
          agentId: session.id,
          droppedSections: droppedSections.map((section) => section.name),
          droppedChars: droppedSections.reduce((sum, section) => sum + section.chars, 0),
          remainsOverBudget: stillOver,
        }, { sessionId: session.id, severity: stillOver ? "warn" : "info" });
        log.warn({
          initialChars,
          finalChars: lastPromptMetrics.systemPromptChars,
          budget: promptBudget,
          droppedSections: droppedSections.map((section) => section.name),
          remainsOverBudget: stillOver,
        }, stillOver
          ? "System prompt still exceeds budget after trimming optional sections — consider shortening the main system prompt or enforcement messages"
          : "System prompt was over budget; trimmed optional sections to fit");
      }
    }

    const messages: LLMMessage[] = composeTurnMessages(
      buildStableHead(),
      collapsedHistory,
      buildTurnGuidance(),
      getConfig().orchestration?.stablePromptPrefix ?? true,
    );
    return {
      messages,
      collapsedHistory,
      dynamicGuidance,
      lastPromptMetrics,
      injectedSkillSlugs,
      heldOutSkillSlugs,
    };
}
