/**
 * INPUT bound for the sub-agent conversation.
 *
 * The sub-agent history array is append-only and nothing ever shrank it — unlike the
 * orchestrator's Session, the sub-agent path had no trimmer, no compaction and no
 * context-window check at all. That is the path on which the output truncations were
 * measured: the completion budget is now DERIVED from what the prompt leaves free
 * (providers/lmstudio.ts computeOutputTokenBudget), so an unbounded history first
 * starves that budget and then overflows the served window.
 */
import {
  computePromptTokenBudget,
  estimatePromptTokensForRequest,
  PROMPT_ESTIMATE_CHARS_PER_TOKEN,
  type LLMMessage,
  type LLMToolDef,
} from "../providers/lmstudio.js";

/** Bound for a tool result that survives trimming because it is the last evidence. */
const MAX_PINNED_TOOL_RESULT_CHARS = 4_000;
const TOOL_RESULT_CLAMP_MARKER = "\n… [truncated — this tool result was clamped to fit the context window]";

/** Drops the OLDEST messages after the first — the task statement is pinned — until the
 *  estimate fits, always keeping the last `minKeep`. An assistant message carrying
 *  tool_calls is dropped together with the tool results that answer it: splitting the
 *  pair produces a request that strict chat templates reject. Mutates in place.
 *
 *  The budget comes from providers/lmstudio.ts computePromptTokenBudget — the same
 *  bound, in the same token unit, that the orchestrator's Session trimmer uses, so
 *  both paths leave the provider the headroom it needs to derive a usable max_tokens. */
export function trimSubAgentHistory(
  history: LLMMessage[],
  opts: {
    systemPromptChars: number;
    tools: readonly LLMToolDef[];
    contextWindow: number;
    minKeep?: number;
  },
): { dropped: number; clamped: number } {
  const minKeep = opts.minKeep ?? 6;
  const budget = computePromptTokenBudget(opts.contextWindow);
  const systemTokens = Math.ceil(opts.systemPromptChars / PROMPT_ESTIMATE_CHARS_PER_TOKEN);
  const fits = (): boolean =>
    systemTokens + estimatePromptTokensForRequest(history, opts.tools) <= budget;

  let dropped = 0;
  while (history.length > minKeep && !fits()) {
    // The LAST surviving tool result is evidence, not filler: both deadline-synthesis
    // paths (agent/sub-agent.ts attemptTimeoutSynthesis / attemptPreDeadlineSynthesis)
    // bail out unconditionally when the history holds no `role: "tool"` message, so
    // trimming the final one turns a 20-iteration run that hits its deadline into a
    // bare interrupted scaffold. A block that would remove it is SKIPPED (not a stop —
    // stopping there would strand the whole rest of the history above the budget); the
    // pinned result is clamped below if it is itself what no longer fits.
    let index = 1;
    let progressed = false;
    while (index <= history.length - minKeep) {
      const span = dropSpan(history, index);
      if (span === 0) break;
      if (dropKeepsAToolResult(history, index, span)) {
        history.splice(index, span);
        dropped += span;
        progressed = true;
        break;
      }
      index += span;
    }
    if (!progressed) break;
  }

  // Pinning the last tool result must not mean overflowing the window when THAT
  // message is the oversized one (a 200KB fetch/read result is routine). Clamp its
  // content to a bounded excerpt: the synthesis guard only needs the message to
  // exist, and an excerpt is evidence where a dropped message is nothing.
  let clamped = 0;
  if (!fits()) {
    for (const message of history) {
      if (message.role !== "tool") continue;
      if (typeof message.content !== "string" || message.content.length <= MAX_PINNED_TOOL_RESULT_CHARS) continue;
      message.content = message.content.slice(0, MAX_PINNED_TOOL_RESULT_CHARS) + TOOL_RESULT_CLAMP_MARKER;
      clamped++;
      if (fits()) break;
    }
  }
  return { dropped, clamped };
}

/** How many messages the drop at `index` covers: the message itself plus the tool
 *  results that answer its tool_calls. Splitting that pair produces a request strict
 *  chat templates reject. 0 when there is nothing at `index`. */
function dropSpan(history: readonly LLMMessage[], index: number): number {
  const victim = history[index];
  if (!victim) return 0;
  const answeredIds = new Set((victim.tool_calls ?? []).map((c) => c.id));
  let span = 1;
  while (answeredIds.size > 0) {
    const next = history[index + span];
    if (!next || next.role !== "tool") break;
    if (next.tool_call_id !== undefined && !answeredIds.has(next.tool_call_id)) break;
    span++;
  }
  return span;
}

/** Would dropping `span` messages at `index` still leave at least one tool result? */
function dropKeepsAToolResult(history: readonly LLMMessage[], index: number, span: number): boolean {
  // A block that holds no tool result can never remove the last one.
  if (!history.slice(index, index + span).some((m) => m.role === "tool")) return true;
  return history.some((m, i) => m.role === "tool" && (i < index || i >= index + span));
}
