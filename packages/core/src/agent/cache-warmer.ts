/**
 * Orchestrator prompt-cache warm-keeper (agents.performance.promptCacheWarmKeeper).
 *
 * The orchestrator's ~24KB base system prompt is identical on every turn, and the
 * model server (cache_prompt=true, see lmstudio.ts) reuses its KV prefix across
 * consecutive calls — but the FIRST turn of a session, or the first after a
 * DELEGATING turn whose sub-agent calls evicted the prefix, pays the full cold
 * prefill (~20s on the audited box). The receptionist fast-lane runs on a DIFFERENT
 * (routing-tier) model, so it never evicts the orchestrator model's cache; that
 * makes it worth keeping the orchestrator prefix warm during idle so the next real
 * turn reuses it instead of re-prefilling.
 *
 * Strategy: on boot, and a short idle window after every orchestrator turn finishes,
 * fire a background minimal completion that prefills the base prompt. The warm-up is
 * ABORTED the instant a real turn starts, so it never queues ahead of the user. An abort
 * is not free, though, and it saves nothing: live probe E5 (2026-09-26) found the server
 * DROPS an aborted prompt (a resend reused 0% of it) and the next head call ran 952 ms
 * slower than after a completed call (410 ms). So a warm-up that collides with a turn
 * costs that turn about a second, and every extra head queued here widens the window in
 * which it can. Flag-gated (default off) so first-token latency can be A/B'd.
 * Concurrency-safe: warms only when ALL orchestrator turns are idle (an active-turn
 * counter), so it never contends with a live turn.
 *
 * Which heads: the one every non-forced turn sends (lean base + the full tool block), and,
 * behind agents.performance.promptCacheWarmForcedHeads, the heads a FORCED orchestration
 * iteration sends (see collectWarmHeads). They go out as a queue, most valuable first, that
 * re-checks between heads that no turn has started since the queue began.
 */
import { getConfig } from "../config/loader.js";
import { applyActiveModelPreset, getChatProvider } from "../providers/index.js";
import { resolveThinkingControls, type ChatProvider, type CompletionCallOptions, type LLMMessage, type LLMToolDef } from "../providers/lmstudio.js";
import { defaultSystemPrompt, splitOrchestrationModule } from "./session.js";
import { getToolsAsLLMDefs } from "../tools/registry.js";
import { getMainAssistantToolNames } from "./default-tools.js";
import { filterForcedOrchestrationTools } from "./forced-orchestration-tools.js";
import { runWithCallAttribution, type RequestCallSite } from "../runtime/request-context.js";
import { childLogger } from "../logger.js";

const log = childLogger("agent:cache-warmer");

/**
 * The label the warm-up's provider_model_call rows carry. Unlabelled, they were a large
 * prompt with no session and no call site, which an analysis of the audit log could not tell
 * apart from an orchestrator call that lost its context, and their GPU time (several seconds
 * after every turn, about 15 s cold at boot) could not be charged to anything.
 */
const CACHE_WARM_ATTRIBUTION = {
  callSite: "cache_warm" as RequestCallSite,
  agentName: "cache_warmer",
  // The re-warm timer fires in whatever context markOrchestratorIdle ran in. The warm-up is
  // between turns and belongs to none of them, so it must not carry a session it inherited.
  sessionId: undefined,
};

let rewarmTimer: ReturnType<typeof setTimeout> | null = null;
let warmAbort: AbortController | null = null;
let running = false;
let activeTurns = 0;
/** Bumped by every turn start, so a queue that began before it stops at its next head even if
 *  that turn has already finished by then (the idle window after it arms a fresh queue). */
let warmGeneration = 0;
let queueRunning = false;

function enabled(): boolean {
  return getConfig().agents?.performance?.promptCacheWarmKeeper === true;
}
function idleMs(): number {
  return getConfig().agents?.performance?.promptCacheWarmIdleMs ?? 4000;
}
function forcedHeadsEnabled(): boolean {
  return getConfig().agents?.performance?.promptCacheWarmForcedHeads === true;
}
function toolBlockFrozen(): boolean {
  return (getConfig().orchestration?.stableToolBlock ?? "off") === "freeze";
}

/** One head the warm-keeper prefills: the leading system run as the turn emits it, and a tool block. */
export interface WarmHead {
  /**
   * "full": the head of every turn that is not forced (lean base + the whole tool block).
   * "full_module": lean base + orchestration module + the whole tool block — under
   *   orchestration.stableToolBlock "freeze", what a forced iteration of a module turn sends.
   * "forced_plan": the first forced iteration of a turn with no plan yet (record_plan offered).
   * "forced_dispatch": a forced iteration once the plan exists (execute_plan offered).
   */
  label: "full" | "full_module" | "forced_plan" | "forced_dispatch";
  /** The system messages in the order turn-system-prompt.ts buildStableHead emits them; the
   *  provider folds them exactly as it folds the turn's, so the warm prefix is a prefix of it. */
  system: LLMMessage[];
  tools: LLMToolDef[];
}

/**
 * The heads to warm, in the order they are worth warming.
 *
 * THE FULL HEAD FIRST: every turn that is not forced sends it, so it is the one a real turn is
 * most likely to meet.
 *
 * THE FORCED HEADS (agents.performance.promptCacheWarmForcedHeads, default off). A turn that must
 * orchestrate before it answers sends a SUBSET of the tool block on its forced iterations, and
 * the subset itself flips once a plan is recorded: record_plan is offered while no plan exists,
 * execute_plan once one does (filterForcedOrchestrationTools). c297c5ea's first two forced calls
 * were both cold for exactly that reason — 12.8 s and 12.7 s to first token, cacheN 0 each — the
 * first because only the full head was warm, the second because the subset had changed under it.
 * Live probe E7 prices a switch to an unwarmed subset at 8.3 s (0% reused), and every switch pays
 * again. c297c5ea was an artifact turn, and artifact turns carry the orchestration module, so each
 * forced head is lean base + module, folded as buildStableHead folds it, with the subset for one
 * plan state — derived through the SAME filter the turn uses. The record_plan head goes first: it
 * is the first forced call of such a turn.
 *
 * Deliberately not warmed: the subset without list_agents (removed on freshness/source/artifact
 * turns unless the user asked for the catalog) and forced heads WITHOUT the module — which is what
 * a plain question the upfront source judge forces sends (it names no artifact and the judge's
 * "yes" builds no intent guidance; cache-warmer-forced-heads.test.ts shows both). Which
 * variants real turns send is what the head hashes on the provider rows count (toolsHash,
 * prompt_section_sizes.baseModuleHash); a variant earns a slot here from those counts, not
 * from a guess. Each extra head costs 8-12 s of GPU cold and 2-5 s to re-warm after every
 * turn, and widens the window in which a user's message meets an in-flight warm-up.
 *
 * UNDER orchestration.stableToolBlock "freeze" THERE ARE NO SUBSET HEADS (2026-10-05). A forced
 * iteration then sends the turn's whole tool block and enforces the subset at the call site
 * (refusals logged as tool_restriction_refused), so its head is the full head, plus the module on
 * a module turn. The forced heads are then "full" itself and "full_module" (lean base + module +
 * the whole tool block); the two subset heads would warm a prefix no call sends. Without a split
 * there is no module, and the full head is the only one.
 */
export function collectWarmHeads(opts: {
  /** Override the flag: the latency probe (E9) measures these heads before anyone turns it on. */
  forcedHeads?: boolean;
  /** Override orchestration.stableToolBlock: E9 measures the forced SUBSET heads whatever the deployment runs. */
  stableToolBlock?: "off" | "freeze";
} = {}): WarmHead[] {
  const config = getConfig();
  let base = defaultSystemPrompt();
  let orchestrationModule: string | null = null;
  // Warm the SAME lean base the split turn actually sends — otherwise the warmed KV prefix
  // diverges at "## Swarm Rules" from the live lean base and the warm-up buys almost nothing.
  if (config.agents?.performance?.splitOrchestrationPrompt === true) {
    const split = splitOrchestrationModule(base);
    base = split.leanBase;
    orchestrationModule = split.orchestrationModule;
  }
  if (!base) return [];

  // WARM THE SHAPE THE TURN ACTUALLY SENDS, tool block included.
  //
  // This used to pass an empty tool array while every real turn carries the orchestrator's
  // whole tool block — 36 schemas and ~9,170 tokens under `orchestration_only`, 89 and
  // ~19,550 under `hybrid`. The server renders tools into the prompt, so a tool-less
  // warm-up prefills a prefix that diverges from the live one before the tools begin, and
  // the next real turn pays the full cold prefill anyway.
  //
  // Measured against the serving model with this deployment's REAL base prompt and real
  // 36-tool block (15,508 prompt tokens), a unique marker per trial:
  //   old warmer, tool-less warm then a real turn -> 17,394 ms
  //   FIXED warmer, tooled warm then the same turn->     456 ms
  //   no warm-up at all, cold                     -> 16,887 ms
  //
  // The old warmer was WORSE THAN NOTHING: it burned 7.3s of GPU and left the real turn
  // slower than an unwarmed one, because it filled the cache with a prefix no turn shares.
  //
  // So the tool array is not a detail of the warm-up; it is most of what is being warmed.
  // It is derived from the same functions the turn uses, so a change to the tool mode or
  // the lean catalog moves both together instead of silently splitting them apart.
  let tools: ReturnType<typeof getToolsAsLLMDefs> = [];
  try {
    tools = getToolsAsLLMDefs(getMainAssistantToolNames());
  } catch {
    // A registry not yet populated at boot: warm what we can rather than not at all.
  }

  const heads: WarmHead[] = [{ label: "full", system: [{ role: "system", content: base }], tools }];
  if ((opts.forcedHeads ?? forcedHeadsEnabled()) && tools.length > 0) {
    // Lean base, then the module as its own system message: the order buildStableHead emits
    // them in, so the provider's fold makes this a strict prefix of the forced turn's head
    // (which goes on with the date line). Without a split there is no module to add: the
    // base already holds it.
    const system: LLMMessage[] = [
      { role: "system", content: base },
      ...(orchestrationModule ? [{ role: "system" as const, content: orchestrationModule }] : []),
    ];
    const frozen = (opts.stableToolBlock ?? (toolBlockFrozen() ? "freeze" : "off")) === "freeze";
    if (frozen) {
      // The forced call sends the full block: its head is "full" (already queued) or, on a module
      // turn, this one. Same tool array as "full", so the two differ only after the lean base.
      if (orchestrationModule) heads.push({ label: "full_module", system, tools });
    } else {
      heads.push(
        { label: "forced_plan", system, tools: filterForcedOrchestrationTools(tools, { planRecorded: false }) },
        { label: "forced_dispatch", system, tools: filterForcedOrchestrationTools(tools, { planRecorded: true }) },
      );
    }
  }
  return heads;
}

/**
 * The options a warm-up is sent with: ONE output token, thinking off.
 *
 * The prefill is the whole point, and the warm-ups used to decode 59-68 thinking tokens after
 * it — about 1.1 s of GPU per warm-up for text nobody reads, while the next user's message may
 * be waiting behind it. Neither setting moves the head: max_tokens is not rendered at all, and on
 * the chat-template families enable_thinking only changes the generation prompt after the last
 * user message, behind the cached prefix.
 *
 * Except where the off-switch IS head text: on gpt-oss the effort is a `Reasoning: <level>`
 * system line prepended at position 0 (lmstudio.ts withReasoningSystemLine), so a thinking-off
 * warm-up would warm a head the turn — sent with its own level — never shares. There the
 * controls are left out and only the output ceiling applies.
 *
 * `primaryModel` names the model the warmed head is sent to when it is not the orchestrator's: a
 * sub-agent's head re-warm (agent/sub-agent-head-rewarm.ts) runs on that agent's own model, and
 * whether the off-switch is head text is a property of that model's family.
 */
export const WARM_CALL_MAX_TOKENS = 1;
const WARM_THINKING_OFF = { enableThinking: false, reasoningEffort: "none" } as const;
export function warmCallOptions(primaryModel?: string): CompletionCallOptions {
  let headSafe: boolean;
  try {
    const primary = primaryModel ?? applyActiveModelPreset(getConfig().agents.defaults.model).primary;
    const modelId = primary.includes("/") ? primary.split("/").slice(1).join("/") : primary;
    headSafe = !resolveThinkingControls(modelId, WARM_THINKING_OFF).systemReasoningLine;
  } catch {
    headSafe = false;
  }
  return { maxTokens: WARM_CALL_MAX_TOKENS, ...(headSafe ? { controls: WARM_THINKING_OFF } : {}) };
}

/** Prefill one head. False when the warm-up was aborted: a turn has taken the model. */
async function warmHead(provider: ChatProvider, head: WarmHead, options: CompletionCallOptions): Promise<boolean> {
  const ac = new AbortController();
  warmAbort = ac;
  const t0 = Date.now();
  try {
    // The prefill of the head is the entire point; the one token generated off a "." user
    // message is irrelevant to the cached prefix.
    await runWithCallAttribution(CACHE_WARM_ATTRIBUTION, () =>
      provider.complete([...head.system, { role: "user", content: "." }], head.tools, ac.signal, options));
    if (!ac.signal.aborted) {
      log.debug(
        { head: head.label, ms: Date.now() - t0, systemChars: head.system.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0), toolCount: head.tools.length },
        "orchestrator prompt prefix warmed",
      );
    }
  } catch {
    // aborted (a real turn took over) or a transient provider error — best-effort.
  } finally {
    if (warmAbort === ac) warmAbort = null;
  }
  return !ac.signal.aborted;
}

/**
 * Warm the heads one after another, most valuable first, for as long as nothing else wants the
 * model. Between two heads it re-checks that no turn has started since the queue began (the
 * generation) and none is running: a turn that started aborts the in-flight head
 * (markOrchestratorActivity) and the queue does not send the next one — E5's abort cost is paid
 * at most once per collision, never once per queued head.
 */
async function warmQueue(): Promise<void> {
  if (!enabled() || queueRunning || warmAbort || activeTurns > 0) return;
  const provider = getChatProvider();
  if (!provider) return;
  let heads: WarmHead[];
  try {
    heads = collectWarmHeads();
  } catch {
    return;
  }
  const generation = warmGeneration;
  const options = warmCallOptions();
  queueRunning = true;
  try {
    for (const head of heads) {
      if (!running || generation !== warmGeneration || activeTurns > 0) return;
      if (!(await warmHead(provider, head, options))) return;
    }
  } finally {
    queueRunning = false;
  }
}

/** A real orchestrator turn is starting — free the model: cancel any pending re-warm
 *  and abort any in-flight warm so it never queues ahead of the user's turn. */
export function markOrchestratorActivity(): void {
  activeTurns += 1;
  warmGeneration += 1;
  if (rewarmTimer) {
    clearTimeout(rewarmTimer);
    rewarmTimer = null;
  }
  if (warmAbort) {
    warmAbort.abort();
    warmAbort = null;
  }
}

/** An orchestrator turn finished — once ALL turns are idle, schedule a re-warm
 *  after the idle window so the next user turn reuses the (possibly evicted) prefix. */
export function markOrchestratorIdle(): void {
  if (activeTurns > 0) activeTurns -= 1;
  if (!enabled() || !running || activeTurns > 0) return;
  if (rewarmTimer) clearTimeout(rewarmTimer);
  rewarmTimer = setTimeout(() => {
    rewarmTimer = null;
    void warmQueue();
  }, idleMs());
  if (typeof rewarmTimer.unref === "function") rewarmTimer.unref();
}

/**
 * How many turns this process is running. runTurn brackets every turn, nested ones included, with
 * the two calls above whether or not the warm-keeper is on, so other background work that must not
 * compete with a turn reads the count here (the sandbox canary, observability/health-checks.ts).
 */
export function orchestratorTurnsRunning(): number {
  return activeTurns;
}

export function startCacheWarmer(): void {
  if (running || !enabled()) return;
  running = true;
  // Boot warm-up so the very first turn after startup reuses the prefix.
  void warmQueue();
  log.info({ idleMs: idleMs() }, "Prompt-cache warm-keeper started");
}

export function stopCacheWarmer(): void {
  running = false;
  warmGeneration += 1;
  if (rewarmTimer) {
    clearTimeout(rewarmTimer);
    rewarmTimer = null;
  }
  if (warmAbort) {
    warmAbort.abort();
    warmAbort = null;
  }
}
