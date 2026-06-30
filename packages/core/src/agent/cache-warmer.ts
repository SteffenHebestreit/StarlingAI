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

  const ac = new AbortController();
  warmAbort = ac;
  const t0 = Date.now();
  try {
    // The prefill of `base` is the entire point; the tiny generation off a "."
    // user message is cheap and irrelevant to the cached prefix.
    await provider.complete([{ role: "system", content: base }, { role: "user", content: "." }], [], ac.signal);
    if (!ac.signal.aborted) log.debug({ ms: Date.now() - t0 }, "orchestrator prompt prefix warmed");
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
