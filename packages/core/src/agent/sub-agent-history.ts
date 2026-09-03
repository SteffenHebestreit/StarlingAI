/**
 * INPUT bound for the sub-agent conversation.
 *
 * The sub-agent history array is append-only and nothing ever shrank it — unlike the
 * orchestrator's Session, the sub-agent path had no trimmer, no compaction and no
 * context-window check at all. That is the path on which the output truncations were
 * measured: the completion budget is now DERIVED from what the prompt leaves free
 * (providers/lmstudio.ts computeOutputTokenBudget), so an unbounded history first
 * starves that budget and then overflows the served window.
 *
 * TWO bounds live here, and they answer different questions.
 *
 * 1. The DROP loop below is the overflow guard. It only runs once the request no
 *    longer fits computePromptTokenBudget. Measured on run 3959f3ac (backend_coder,
 *    13 iterations): contextWindow 131072 → budget
 *      max(⌊131072×0.5⌋, min(⌊131072×0.75⌋, 131072 − 10486 − 8192)) = 98_304 tokens,
 *    while the LAST iteration's prompt was ≈30_700 tokens — 3.2× under the threshold.
 *    So it never fired, and no `sub_agent_history_trimmed` row exists for that run.
 *    That is CORRECT behaviour for an overflow guard and it is not the thing to tune:
 *    lowering the budget to "make it fire" trades a wall-clock problem for a lost-
 *    context one, and splicing at index 1 destroys the KV prefix on every pass.
 *
 * 2. The DIGEST pass is the wall-clock bound, and it runs unconditionally. Fitting the
 *    window says nothing about what the prompt COSTS: the whole history is re-sent
 *    every iteration, so the quantity that buys latency is Σ(per-iteration prompt), not
 *    the peak. The same run prefilled 238_357 cumulative prompt tokens across 13
 *    completions and spent ≈60 s per iteration at chunkCount 0 (reading, not
 *    generating). Two things dominated that sum and neither is bounded anywhere else:
 *      • one read_file result of 25_929 chars (≈8_643 tokens at 3.0 chars/token) that
 *        slid under MAX_TOOL_RESULT_CHARS (32_768) untouched and was then re-sent
 *        verbatim for the remaining ~10 iterations;
 *      • the agent's OWN emitted file bodies, echoed back as write_file/edit_file
 *        `tool_calls[].arguments` on the assistant messages — the largest class for a
 *        builder, and previously unclampable at any size (the clamp below refuses any
 *        message that is not `role: "tool"`).
 *    Both are STALE by construction: the agent has already acted on them, and the
 *    bytes still exist on disk where read_file can fetch them back. Digesting them
 *    stops the prompt growing monotonically with build size.
 *
 * The digest is pure string work — no model call. Compaction that costs an inference
 * competes with the wall clock it exists to protect.
 *
 * Cost it is honest about: rewriting a message at position k breaks the provider's KV
 * prefix from k onward for ONE request. Thereafter the prefix is stable again AND
 * smaller, so a single re-prefill buys a permanently cheaper tail — which is why the
 * fresh window below exists (nothing the agent just did is ever rewritten) and why the
 * digest is idempotent (a digested message is never rewritten a second time).
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

/** How many of the agent's own tool-calling turns stay verbatim, newest first.
 *  2, not 1: an agent routinely reads in one turn and edits against what it read in
 *  the next, so the result it is actively working from must survive a full round trip.
 *  Everything older it has already acted on. */
export const FRESH_TOOL_TURNS = 2;

/** Bound a STALE tool result is digested to. Head+tail, because a file read's last
 *  lines ("does it still close?") are evidence as much as its first. Sized so a
 *  digested result is comfortably under the threshold that selected it — that, not a
 *  sentinel scan, is what makes the pass idempotent across iterations. */
const MAX_STALE_TOOL_RESULT_CHARS = 2_000;
const STALE_RESULT_HEAD_CHARS = 1_200;
const STALE_RESULT_TAIL_CHARS = 400;

/** A stale `tool_calls[].arguments` payload is digested per STRING VALUE, so the
 *  short fields stay intact — `path`, `action`, and the `old_string` anchor an
 *  edit_file was aimed at remain readable, only the file BODY goes. Anything at or
 *  under MIN is left alone (a whole small file is cheap and occasionally load-bearing);
 *  anything above keeps KEEP chars. KEEP + marker ≪ MIN keeps it idempotent. */
const STALE_ARG_VALUE_MIN_CHARS = 800;
const STALE_ARG_VALUE_KEEP_CHARS = 240;

/**
 * A DELEGATED DELIVERABLE IS NOT A STALE FILE READ.
 *
 * Everything else this pass shrinks can be recovered — the digest even says how ("re-read the
 * source"). A completed sub-agent's answer can not: it lives in this array and nowhere else,
 * and three separate salvage paths relay it verbatim to the caller when the run runs out of
 * time, each gated on the body still being at least PASSTHROUGH_DELEGATION_MIN_BYTES. Digested
 * to ~1,750 chars it falls under that bar, so a coordinator that delegated, made two more tool
 * calls and then hit its deadline handed back a snippet instead of the specialist's work —
 * exactly the loss the passthrough was built to prevent, and with a recovery instruction that
 * points at a file that does not exist.
 *
 * So a delegation result is exempt from the wall-clock digest. It is not exempt from the
 * overflow DROP below: when the prompt genuinely does not fit, dropping the oldest messages is
 * still correct, and the salvage paths read the newest delegation anyway.
 */
const DELEGATION_RESULT_PREFIX_RE = /^\s*(Delegated result from|Parallel delegation completed|Task graph (completed|finished))/i;

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
): { dropped: number; clamped: number; digested: number } {
  const minKeep = opts.minKeep ?? 6;
  const budget = computePromptTokenBudget(opts.contextWindow);
  const systemTokens = Math.ceil(opts.systemPromptChars / PROMPT_ESTIMATE_CHARS_PER_TOKEN);
  const fits = (): boolean =>
    systemTokens + estimatePromptTokensForRequest(history, opts.tools) <= budget;

  // Wall-clock bound first: it is unconditional, so it also shrinks what the overflow
  // guard below would otherwise have had to DROP outright.
  const digested = digestStaleHistory(history);

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
  return { dropped, clamped, digested };
}

/** Index at which the fresh window starts: the FRESH_TOOL_TURNS-th tool-calling
 *  assistant message counted from the end. Everything at or after it is what the agent
 *  is currently working from and is never rewritten. 0 when the run has not made that
 *  many tool-calling turns yet — nothing is stale, and the caller's loop then covers
 *  nothing. Structural (message roles only), so it holds for any agent and any task. */
/**
 * Where a sub-agent iteration's nudges go.
 *
 * The head is the KV-cache key: the provider folds the leading system run into one message and
 * the chat template renders the tool block right behind it, so a single character appended to the
 * system prompt re-prefills the tool block AND the whole accumulated history. Measured on a
 * 24,731-token sub-agent context: unchanged head 0.33 s; the same request with the budget-warning
 * text appended to the system message 41.29 s; that identical text moved to a trailing message
 * 0.87 s. Three of the loop's six nudges are one-shot latches, so each of them broke the prefix
 * twice — once when it appeared and once when it was gone.
 *
 * Delivered after the history, a non-leading system message is relabelled as context in position
 * by the provider and read as the most recent instruction, which is exactly what a per-iteration
 * nudge is. The same rule the orchestrator got in 2066738, one level down.
 */
export function composeSubAgentMessages(
  systemPrompt: string,
  history: readonly LLMMessage[],
  nudges: readonly string[],
): LLMMessage[] {
  const trailing = nudges.filter((n) => n.trim().length > 0).join("\n\n");
  return [
    { role: "system", content: systemPrompt },
    ...history,
    ...(trailing ? [{ role: "system" as const, content: trailing }] : []),
  ];
}

export function freshWindowStart(history: readonly LLMMessage[], freshTurns = FRESH_TOOL_TURNS): number {
  let turns = 0;
  for (let i = history.length - 1; i >= 1; i--) {
    const message = history[i];
    if (message?.role !== "assistant" || (message.tool_calls?.length ?? 0) === 0) continue;
    turns++;
    if (turns >= freshTurns) return i;
  }
  return 0;
}

/** Shrinks what the agent has already acted on. Returns how many messages changed.
 *  Mutates in place, like the trimmer it runs inside. */
function digestStaleHistory(history: LLMMessage[], freshTurns = FRESH_TOOL_TURNS): number {
  const boundary = freshWindowStart(history, freshTurns);
  let digested = 0;
  // From 1: index 0 is the task statement, pinned here for the same reason the drop
  // loop pins it — it is the only statement of what the run is FOR.
  for (let i = 1; i < boundary; i++) {
    const message = history[i];
    if (!message) continue;
    let changed = false;

    if (message.role === "tool" && typeof message.content === "string"
      && !DELEGATION_RESULT_PREFIX_RE.test(message.content)) {
      const digest = digestStaleToolResult(message.content);
      if (digest !== null) {
        message.content = digest;
        changed = true;
      }
    }

    for (const call of message.tool_calls ?? []) {
      const digest = digestStaleToolCallArguments(call.function.arguments);
      if (digest !== null) {
        call.function.arguments = digest;
        changed = true;
      }
    }

    if (changed) digested++;
  }
  return digested;
}

/** Head+tail excerpt of an over-sized stale tool result, or null to leave it alone.
 *  The marker names the original size and points at the recovery path: the bytes are
 *  still on disk / still fetchable, and re-reading a window of them costs one tool call
 *  against the ~8_600 tokens per iteration the verbatim copy was costing. */
function digestStaleToolResult(content: string): string | null {
  if (content.length <= MAX_STALE_TOOL_RESULT_CHARS) return null;
  const head = content.slice(0, STALE_RESULT_HEAD_CHARS);
  const tail = content.slice(content.length - STALE_RESULT_TAIL_CHARS);
  const digest = `${head}\n… [${content.length - head.length - tail.length} chars elided — `
    + `stale tool result, already acted on. Re-read the source (read_file offset/limit) `
    + `if you still need the middle.]\n${tail}`;
  return digest.length < content.length ? digest : null;
}

/** Same for a stale tool_call argument payload, keyed on the JSON string VALUES so the
 *  call stays parseable — a chat template that parses `arguments` must not be handed a
 *  stub. Anything we cannot parse, or cannot make smaller, is left exactly as it was. */
function digestStaleToolCallArguments(argumentsJson: string): string | null {
  if (argumentsJson.length <= STALE_ARG_VALUE_MIN_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const digestedArgs: Record<string, unknown> = {};
  let changed = false;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > STALE_ARG_VALUE_MIN_CHARS) {
      digestedArgs[key] = `${value.slice(0, STALE_ARG_VALUE_KEEP_CHARS)}`
        + `\n… [${value.length - STALE_ARG_VALUE_KEEP_CHARS} chars elided — already written to disk; read_file to see it]`;
      changed = true;
    } else {
      digestedArgs[key] = value;
    }
  }
  if (!changed) return null;
  const digest = JSON.stringify(digestedArgs);
  return digest.length < argumentsJson.length ? digest : null;
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
