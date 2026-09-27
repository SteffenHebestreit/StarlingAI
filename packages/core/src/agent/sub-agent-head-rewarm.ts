/**
 * Sub-agent head re-warm (agents.performance.subAgentHeadRewarm, default off).
 *
 * WHY. Live probe E8 (2026-09-26, Qwen3.6-35B-A3B on llama.cpp b156): a NEW conversation on
 * content_writer's 8,041-token head found the head cached after a previous run on it had grown to
 * 1.5x or 3x the head, and paid the full cold prefill after 6x. That is the server's load rule, not
 * eviction: llama-server skips a cached entry the new prompt shares under a quarter of (f_keep <
 * 0.25), and a finished run leaves an entry as long as its last prompt, of which the next dispatch
 * shares only the head. In c297c5ea every content_writer re-dispatch paid 9-22 s of cold prefill for
 * that reason: each previous run had ended near 38k tokens on a 7.6k head.
 *
 * WHAT. When an in-process run ends whose last loop call was more than SUB_AGENT_HEAD_REWARM_RATIO
 * times its head, ONE request goes out with the run's head and a one-character user turn,
 * max_tokens 1, thinking off. It leaves an entry that is nearly all head, and the next dispatch
 * loads it. E8, after a 6x run: one finished head-only request made the next new conversation warm
 * in 3 of 3 and the one after it in 3 of 3 (loading the entry does not use it up), for ~0.76 s of
 * prompt (prompt_n 13, cache_n 8,031) but up to ~3.6 s of wall behind the server's queue. Other
 * agents' conversations in between did not hurt. E8 sent it straight after the run, so it goes out
 * the moment the run ends, before the run's result goes back. Presumably it was that cheap because
 * the run's slot still held the head; a re-warm sent after the slot went to another prompt may pay
 * the cold prefill itself (not measured).
 *
 * THE HEAD IS THE LOOP'S OWN. The system message and the tool array are the objects the run's loop
 * call sent (noteLoopCall), not a rebuild: a head that differs anywhere keeps 0% of the cache on
 * this hybrid model (probe E2), so a re-warm of a look-alike would buy nothing.
 *
 * NEVER RACE THE CALL IT IS FOR. Probe E6: a prewarm still in flight when a cold real call on the
 * same head starts costs that call +5.1 s (both prefill at once); a finished one saves 6.8 s. So a
 * new dispatch of the same agent with the same head in the same conversation WAITS for an in-flight
 * re-warm before its first model call, until that re-warm has been in flight
 * SUB_AGENT_HEAD_REWARM_JOIN_MS (then it is stuck, and every later dispatch would pay the same wait
 * for nothing). The other way round, a run that ends while a dispatch of its head is between its
 * join and the end of its first model call sends NONE: that call is the cold real call E6 priced,
 * and it caches the head itself. Without this a sibling that joined a moment before the run ended
 * (parallel slices, a task graph's staggered nodes) met the re-warm on the wire. Every other call —
 * another agent's, the orchestrator's — goes ahead: E8 found interleaving harmless. One prewarm
 * served 0 of 3 CONCURRENT new conversations in E8, so this serves a sequential re-dispatch, not a
 * parallel fan-out.
 *
 * THE UNIT. The ratio is taken in ONE unit, the provider's estimator, for the head and the run
 * alike, which is how latency-probe E8 sizes its runs. The estimator's 3 chars/token over-counts a
 * schema-heavy head: content_writer's ~31k chars of system text and tool schemas estimate at about
 * 10.4k tokens, against 8,041 measured. Scaled the same way, c297c5ea's 7.6k head estimates at about
 * 9.8k, so the server's 38k count of a run over the estimated head reads 3.9x, and none of those ~5x
 * runs would have re-warmed. The server's count rides on the audit row beside it
 * (reportedPromptTokens).
 *
 * Only the llama.cpp / OpenAI-compatible provider with prompt caching declared (promptCache): an
 * Anthropic head is cached by breakpoints with its own lifetime, and a server that does not cache
 * prompts has nothing to warm. Only in-process runs: a container run's calls leave from the
 * container.
 */
import { getConfig } from "../config/loader.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import {
  estimatePromptTokensForRequest,
  type ChatProvider,
  type LLMMessage,
  type LLMToolDef,
} from "../providers/lmstudio.js";
import { runWithCallAttribution, type RequestCallSite } from "../runtime/request-context.js";
import { warmCallOptions } from "./cache-warmer.js";

const log = childLogger("agent:sub-agent-head-rewarm");

/** Above this many heads, a run's last prompt leaves an entry the next dispatch cannot load. E8
 *  measured the edges: warm after 3x, cold after 6x; the rule (f_keep < 0.25) puts it at 4x. */
export const SUB_AGENT_HEAD_REWARM_RATIO = 4;
/** How long after a re-warm went out a new dispatch of its head still waits for it. E8's slowest
 *  re-warm took ~3.6 s of wall (queue); a re-warm still running after 8 s is stuck behind
 *  something, and the dispatch's own cold prefill (~9-22 s) is then the better bet than waiting on.
 *  Counted from the re-warm's start, not from each dispatch's join: the provider's request timeout
 *  is 10 minutes, and a stuck re-warm must not charge every dispatch of that head 8 s of it. */
export const SUB_AGENT_HEAD_REWARM_JOIN_MS = 8_000;
/**
 * A run that was already under way when the key's last re-warm was sent, and ends within this long
 * after that re-warm finished, sends none: its growth predates that re-warm, whose head-only entry
 * E8 found still loadable after another conversation had loaded it. A run that started AFTER it and
 * grew past the ratio again re-warms: E8's consumers stayed short, so whether the entry outlives a
 * long one is not measured. How long an entry stays in the host cache is not measured either; E8
 * found it outlived four other agents' conversations. Two minutes covers the siblings of one fan-out
 * finishing together without betting on a longer lifetime, and a re-warm too many costs ~0.8 s.
 */
export const SUB_AGENT_HEAD_REWARM_DEDUPE_MS = 120_000;
/** The user turn behind the head: the warm-keeper's minimal message (agent/cache-warmer.ts). */
export const SUB_AGENT_HEAD_REWARM_USER_MESSAGE = ".";

export function subAgentHeadRewarmEnabled(): boolean {
  return getConfig().agents?.performance?.subAgentHeadRewarm === true;
}

interface InFlightRewarm {
  done: Promise<void>;
  startedAt: number;
  /** A new dispatch on the same head waited for this re-warm (the audit row says so). */
  joinedByDispatch: boolean;
}

interface FinishedRewarm {
  startedAt: number;
  finishedAt: number;
  ok: boolean;
}

/** At most one re-warm per key in flight, process-wide. */
const inFlight = new Map<string, InFlightRewarm>();
/** The last re-warm per key, for the dedupe rule; pruned past the window. */
const recent = new Map<string, FinishedRewarm>();
/** Per key, the dispatches between their join and the end of their first model call. */
const firstCallsPending = new Map<string, number>();

/** Per (root conversation, agent, head): a conversation's dispatches of one agent share it. */
export function subAgentHeadRewarmKey(rootConversation: string, agentName: string, headHash: string): string {
  return `${rootConversation}\u0000${agentName}\u0000${headHash}`;
}

export type SubAgentHeadRewarmDecision = "send" | "under_ratio" | "in_flight" | "dispatch_starting" | "recent";

/** Whether a run that just ended sends a re-warm. Pure, so the rule is testable without a run. */
export function decideSubAgentHeadRewarm(input: {
  ratio: number;
  inFlight: boolean;
  /** Another dispatch of this head has joined and its first model call has not come back. */
  dispatchStarting?: boolean;
  recent: FinishedRewarm | undefined;
  runStartedAt: number;
  now: number;
}): SubAgentHeadRewarmDecision {
  if (!(input.ratio > SUB_AGENT_HEAD_REWARM_RATIO)) return "under_ratio";
  if (input.inFlight) return "in_flight";
  // Never race the call it is for (E6: +5.1 s): that first call is on its way or on the wire, and it
  // leaves the head cached by itself.
  if (input.dispatchStarting) return "dispatch_starting";
  const last = input.recent;
  if (last?.ok && input.now - last.finishedAt < SUB_AGENT_HEAD_REWARM_DEDUPE_MS && input.runStartedAt < last.startedAt) {
    return "recent";
  }
  return "send";
}

/**
 * Wait for the in-flight re-warm of `key`, if any: until it settles, `maxWaitMs` has passed since
 * it went out, or `signal` aborts, whichever comes first. Resolves true when there was one to wait for.
 */
export async function joinInFlightSubAgentHeadRewarm(
  key: string,
  opts: { signal?: AbortSignal; maxWaitMs?: number } = {},
): Promise<boolean> {
  const entry = inFlight.get(key);
  if (!entry || opts.signal?.aborted) return false;
  const waitMs = entry.startedAt + (opts.maxWaitMs ?? SUB_AGENT_HEAD_REWARM_JOIN_MS) - Date.now();
  // Past its bound it is stuck: waiting on it buys nothing, and the dispatch goes ahead at once.
  if (waitMs <= 0) return false;
  entry.joinedByDispatch = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      // A dispatch never fails because a warm-up did.
      entry.done.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
        onAbort = () => resolve();
        opts.signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
  }
  return true;
}

/** Settle every re-warm in flight (tests; a graceful shutdown may use it too). */
export async function settleSubAgentHeadRewarms(): Promise<void> {
  await Promise.all([...inFlight.values()].map((entry) => entry.done));
}

export function resetSubAgentHeadRewarmForTests(): void {
  inFlight.clear();
  recent.clear();
  firstCallsPending.clear();
}

export interface SubAgentHeadRewarmParams {
  agentName: string;
  /** The conversation at the top of the delegation chain (sub:… prefixes stripped). */
  rootConversation: string;
  /** The run's own session: the re-warm's provider row and audit row carry it. */
  subSessionId: string;
  runStartedAt: number;
  /** The head as the sub_agent_head row names it. */
  headHash: string;
  /** headTokensEst of the sub_agent_head row: the provider's estimator over the head. */
  headTokens: number;
  /** The tool array the loop sends while the head is unchanged (sub-agent.ts `tools`). */
  tools: LLMToolDef[];
  /** The run's own provider: the same endpoint, model and boundary transform as the loop's calls. */
  provider: ChatProvider;
  /** resolveProviderEndpoint(...).providerId of the run's model. */
  providerId: string;
  /** The run's ModelConfig.promptCache. */
  promptCache: boolean | undefined;
  /** The run's ModelConfig.primary: whether thinking-off is head text depends on its family. */
  modelPrimary: string;
}

/**
 * The re-warm of one run's head. Created before the run's first model call (it joins an in-flight
 * re-warm of the same key there), fed every loop call, and told when the run ends.
 */
export class SubAgentHeadRewarm {
  readonly key: string;
  /** The system message object the loop's calls on this head carried first. */
  private headSystem: LLMMessage | undefined;
  private lastPromptTokens = 0;
  private lastReportedPromptTokens = 0;
  private ended = false;
  /** This run is counted in firstCallsPending: it has joined, and its first model call is not back. */
  private firstCallPending = false;

  constructor(private readonly params: SubAgentHeadRewarmParams) {
    this.key = subAgentHeadRewarmKey(params.rootConversation, params.agentName, params.headHash);
  }

  /**
   * Wait (bounded) for an in-flight re-warm of this head before the run's first model call. From
   * here until that call comes back, no run of this head starts a re-warm (dispatch_starting):
   * counted BEFORE the wait, so a run that ends while this one waits or sets up cannot put one on
   * the wire beside its first call.
   */
  async joinInFlight(signal?: AbortSignal): Promise<boolean> {
    if (!this.firstCallPending && !this.ended) {
      this.firstCallPending = true;
      firstCallsPending.set(this.key, (firstCallsPending.get(this.key) ?? 0) + 1);
    }
    const t0 = Date.now();
    const joined = await joinInFlightSubAgentHeadRewarm(this.key, { signal });
    if (joined) log.debug({ agentName: this.params.agentName, waitedMs: Date.now() - t0 }, "dispatch waited for its head's re-warm");
    return joined;
  }

  /** The run's first model call came back, or the run ended without one. */
  private firstCallDone(): void {
    if (!this.firstCallPending) return;
    this.firstCallPending = false;
    const left = (firstCallsPending.get(this.key) ?? 1) - 1;
    if (left > 0) firstCallsPending.set(this.key, left);
    else firstCallsPending.delete(this.key);
  }

  /**
   * One loop call: the messages and tools it sent and the prompt tokens the server reported. Only
   * calls that carried the run's head count (a mid-run tool fallback swaps the array for a new one);
   * the last such call is what the server's cache entry for this run holds.
   */
  noteLoopCall(messages: readonly LLMMessage[], tools: readonly LLMToolDef[], reportedPromptTokens: number): void {
    // Any call that came back has left this run's prompt in the server's cache.
    this.firstCallDone();
    const system = messages[0];
    if (tools !== this.params.tools || system?.role !== "system") return;
    this.headSystem ??= system;
    this.lastPromptTokens = estimatePromptTokensForRequest(messages, tools);
    this.lastReportedPromptTokens = Number.isFinite(reportedPromptTokens) ? reportedPromptTokens : 0;
  }

  /** The run has ended: send the re-warm if its last prompt outgrew the head. Never throws, never
   *  waits: the run's result goes back while the re-warm is on the wire. */
  runEnded(opts: { signal?: AbortSignal }): void {
    this.firstCallDone();
    if (this.ended) return;
    this.ended = true;
    try {
      // A stopped turn has no next dispatch to warm for.
      if (opts.signal?.aborted || !this.headSystem || this.params.headTokens <= 0) return;
      const ratio = this.lastPromptTokens / this.params.headTokens;
      const now = Date.now();
      const decision = decideSubAgentHeadRewarm({
        ratio,
        inFlight: inFlight.has(this.key),
        dispatchStarting: (firstCallsPending.get(this.key) ?? 0) > 0,
        recent: recent.get(this.key),
        runStartedAt: this.params.runStartedAt,
        now,
      });
      if (decision !== "send") {
        if (decision !== "under_ratio") log.debug({ agentName: this.params.agentName, ratio, decision }, "head re-warm skipped");
        return;
      }
      this.send(this.headSystem, ratio, opts.signal);
    } catch (err) {
      log.debug({ err, agentName: this.params.agentName }, "head re-warm not sent");
    }
  }

  private send(headSystem: LLMMessage, ratio: number, turnSignal: AbortSignal | undefined): void {
    const { agentName, subSessionId, provider, tools } = this.params;
    const ac = new AbortController();
    const onTurnAbort = (): void => ac.abort();
    turnSignal?.addEventListener("abort", onTurnAbort, { once: true });
    const startedAt = Date.now();
    // Registered BEFORE the call starts, so a dispatch that begins while it is on the wire finds it
    // and a provider that throws synchronously cannot leave a stale entry behind (the finally below
    // removes it either way).
    const entry: InFlightRewarm = { done: Promise.resolve(), startedAt, joinedByDispatch: false };
    inFlight.set(this.key, entry);
    const callSite: RequestCallSite = "cache_warm";
    entry.done = (async () => {
      let ok = false;
      try {
        await runWithCallAttribution({ callSite, agentName: `${agentName}_head_rewarm`, sessionId: subSessionId }, () =>
          provider.complete(
            [headSystem, { role: "user", content: SUB_AGENT_HEAD_REWARM_USER_MESSAGE }],
            tools,
            ac.signal,
            warmCallOptions(this.params.modelPrimary),
          ));
        ok = !ac.signal.aborted;
      } catch {
        // Aborted with the turn, or a transient provider error: best-effort, the next dispatch
        // pays its cold prefill as it would have without this.
      } finally {
        turnSignal?.removeEventListener("abort", onTurnAbort);
        if (inFlight.get(this.key) === entry) inFlight.delete(this.key);
        const finishedAt = Date.now();
        recent.set(this.key, { startedAt, finishedAt, ok });
        for (const [key, last] of recent) {
          if (finishedAt - last.finishedAt >= SUB_AGENT_HEAD_REWARM_DEDUPE_MS) recent.delete(key);
        }
        logAudit("sub_agent_head_rewarm", {
          agentName,
          headHash: this.params.headHash,
          headTokens: this.params.headTokens,
          // Both in the estimator's unit, the ratio's (see THE UNIT above).
          runPromptTokens: this.lastPromptTokens,
          ...(this.lastReportedPromptTokens > 0 ? { reportedPromptTokens: this.lastReportedPromptTokens } : {}),
          ratio: Math.round(ratio * 100) / 100,
          ms: finishedAt - startedAt,
          ok,
          ...(ac.signal.aborted ? { aborted: true } : {}),
          ...(entry.joinedByDispatch ? { joinedByDispatch: true } : {}),
        }, { sessionId: subSessionId, severity: "info" });
      }
    })();
  }
}

/**
 * The re-warm for a run, or null when none can apply: the flag is off, or the run's provider is not
 * a prompt-caching OpenAI-compatible one.
 */
export function createSubAgentHeadRewarm(params: SubAgentHeadRewarmParams): SubAgentHeadRewarm | null {
  if (!subAgentHeadRewarmEnabled()) return null;
  if (params.providerId === "anthropic" || params.promptCache !== true) return null;
  return new SubAgentHeadRewarm(params);
}
