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
 * ABORTED the instant a real turn starts (so it never queues ahead of the user), and
 * cache_prompt still reuses whatever prefix was prefilled before the abort — so it is
 * strictly best-effort and never makes a turn slower. Flag-gated (default off) so
 * first-token latency can be A/B'd. Concurrency-safe: warms only when ALL orchestrator
 * turns are idle (an active-turn counter), so it never contends with a live turn.
 */
import { getConfig } from "../config/loader.js";
import { getChatProvider } from "../providers/index.js";
import { defaultSystemPrompt, splitOrchestrationModule } from "./session.js";
import { getToolsAsLLMDefs } from "../tools/registry.js";
import { getMainAssistantToolNames } from "./default-tools.js";
import { childLogger } from "../logger.js";

const log = childLogger("agent:cache-warmer");

let rewarmTimer: ReturnType<typeof setTimeout> | null = null;
let warmAbort: AbortController | null = null;
let running = false;
let activeTurns = 0;

function enabled(): boolean {
  return getConfig().agents?.performance?.promptCacheWarmKeeper === true;
}
function idleMs(): number {
  return getConfig().agents?.performance?.promptCacheWarmIdleMs ?? 4000;
}

async function warmOnce(): Promise<void> {
  if (!enabled() || warmAbort || activeTurns > 0) return;
  const provider = getChatProvider();
  if (!provider) return;
  let base: string;
  try {
    base = defaultSystemPrompt(getConfig().workspacePath);
    // Warm the SAME lean base the split turn actually sends — otherwise the warmed KV prefix
    // diverges at "## Swarm Rules" from the live lean base and the warm-up buys almost nothing.
    if (getConfig().agents?.performance?.splitOrchestrationPrompt === true) {
      base = splitOrchestrationModule(base).leanBase;
    }
  } catch {
    return;
  }
  if (!base) return;

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

  const ac = new AbortController();
  warmAbort = ac;
  const t0 = Date.now();
  try {
    // The prefill of `base` plus the tool block is the entire point; the tiny generation
    // off a "." user message is cheap and irrelevant to the cached prefix.
    await provider.complete([{ role: "system", content: base }, { role: "user", content: "." }], tools, ac.signal);
    if (!ac.signal.aborted) {
      log.debug(
        { ms: Date.now() - t0, baseChars: base.length, toolCount: tools.length, toolChars: JSON.stringify(tools).length },
        "orchestrator prompt prefix warmed",
      );
    }
  } catch {
    // aborted (a real turn took over) or a transient provider error — best-effort.
  } finally {
    if (warmAbort === ac) warmAbort = null;
  }
}

/** A real orchestrator turn is starting — free the model: cancel any pending re-warm
 *  and abort any in-flight warm so it never queues ahead of the user's turn. */
export function markOrchestratorActivity(): void {
  activeTurns += 1;
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
    void warmOnce();
  }, idleMs());
  if (typeof rewarmTimer.unref === "function") rewarmTimer.unref();
}

export function startCacheWarmer(): void {
  if (running || !enabled()) return;
  running = true;
  // Boot warm-up so the very first turn after startup reuses the prefix.
  void warmOnce();
  log.info({ idleMs: idleMs() }, "Prompt-cache warm-keeper started");
}

export function stopCacheWarmer(): void {
  running = false;
  if (rewarmTimer) {
    clearTimeout(rewarmTimer);
    rewarmTimer = null;
  }
  if (warmAbort) {
    warmAbort.abort();
    warmAbort = null;
  }
}
