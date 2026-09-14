import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { trimSubAgentHistory, freshWindowStart, DIGEST_BATCH_MIN_CHARS } from "../agent/sub-agent-history.js";
import {
  computePromptTokenBudget,
  estimatePromptTokensForRequest,
  type LLMMessage,
  type LLMToolDef,
} from "../providers/lmstudio.js";

/**
 * Fixture shaped on run 3959f3ac (backend_coder, qwen3.8-27b via LM Studio):
 * 13 iterations, one 25_929-char read_file result, five files written across
 * append passes, 238_357 CUMULATIVE prompt tokens and ~60 s per iteration at
 * chunkCount 0. The digest still bounds that sum — but the quantity that costs wall
 * clock on a prefix-caching backend is the number of times the history is REWRITTEN
 * (each one re-prefills the fresh window behind it: 10-16 s cold on the 9-13 Sept
 * audit log), not the bytes re-sent warm (0.02-0.06 ms/token). So the assertions pin
 * how many iterations broke the prefix, not just how much the sum fell.
 */

const TOOLS: LLMToolDef[] = [
  { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { name: "write_file", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
  { name: "edit_file", description: "Edit a file", parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } } } },
];

/** backend_coder's system prompt plus the injected tool-inventory/flow blocks. */
const SYSTEM_PROMPT_CHARS = 9_000;
const CONTEXT_WINDOW = 131_072;
const BIG_READ_CHARS = 25_929;

function body(chars: number, seed: string): string {
  const line = `// ${seed} ${"x".repeat(60)}\n`;
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}

/** One builder iteration: the assistant emits a file-shaped tool call, the tool answers. */
function appendIteration(history: LLMMessage[], n: number, opts?: { readChars?: number }): void {
  const id = `call_${n}`;
  if (opts?.readChars !== undefined) {
    history.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "generated/tetris25d/game.js" }) } }],
    });
    history.push({ role: "tool", content: body(opts.readChars, `read${n}`), tool_call_id: id });
    return;
  }
  history.push({
    role: "assistant",
    content: null,
    tool_calls: [{
      id,
      type: "function",
      function: {
        name: "write_file",
        // The file BODY echoed back on the assistant message — the largest class of
        // bytes in a builder's history, and the one the pinned-result clamp refuses.
        arguments: JSON.stringify({ path: `generated/tetris25d/part${n}.js`, content: body(6_000, `write${n}`) }),
      },
    }],
  });
  history.push({ role: "tool", content: `Wrote generated/tetris25d/part${n}.js (6000 bytes)`, tool_call_id: id });
}

/** Replays the run, returning the prompt token count charged at each iteration. */
function replay(opts: { trim: boolean }): {
  perIteration: number[];
  cumulative: number;
  history: LLMMessage[];
  /** Messages rewritten at each iteration — every non-zero entry is one KV-prefix break. */
  digestedPerIteration: number[];
  deferredPerIteration: number[];
} {
  const history: LLMMessage[] = [{ role: "user", content: body(2_473, "task") }];
  const perIteration: number[] = [];
  const digestedPerIteration: number[] = [];
  const deferredPerIteration: number[] = [];
  for (let n = 1; n <= 13; n++) {
    if (opts.trim) {
      const trimmed = trimSubAgentHistory(history, {
        systemPromptChars: SYSTEM_PROMPT_CHARS,
        tools: TOOLS,
        contextWindow: CONTEXT_WINDOW,
      });
      digestedPerIteration.push(trimmed.digested);
      deferredPerIteration.push(trimmed.deferredStaleChars);
    }
    perIteration.push(
      Math.ceil(SYSTEM_PROMPT_CHARS / 3.0) + estimatePromptTokensForRequest(history, TOOLS),
    );
    // Iteration 4 is the one that read the whole 25_929-char file back.
    appendIteration(history, n, n === 4 ? { readChars: BIG_READ_CHARS } : undefined);
  }
  return {
    perIteration,
    cumulative: perIteration.reduce((a, b) => a + b, 0),
    history,
    digestedPerIteration,
    deferredPerIteration,
  };
}

function isStrictlyIncreasing(values: readonly number[]): boolean {
  return values.every((v, i) => i === 0 || v > values[i - 1]!);
}

describe("sub-agent history — the measured run", () => {
  it("reproduces the observed cost when nothing shrinks the history", () => {
    const { perIteration, cumulative } = replay({ trim: false });
    // Every iteration re-prefills everything that came before it, monotonically.
    expect(isStrictlyIncreasing(perIteration)).toBe(true);
    // Same order of magnitude as the audited usage.promptTokens = 238_357.
    expect(cumulative).toBeGreaterThan(150_000);
  });

  it("breaks the prefix ONCE for the whole run and still bounds cumulative prefill", () => {
    const untrimmed = replay({ trim: false });
    const trimmed = replay({ trim: true });

    // Measured on this fixture: untrimmed Σ = 273_000 tokens, per-iteration climbing
    // 3_940 → 35_525. Per-iteration digest (the previous rule): Σ = 124_216 (−54%) but
    // a message rewritten on EVERY iteration from the 7th on — seven prefix breaks, and
    // on the audited runs each one cost 10-16 s cold, more than the ≈0.4 s/iteration the
    // re-sent bytes cost warm. Batched: the stale mass reaches DIGEST_BATCH_MIN_CHARS at
    // iteration 7 (three write bodies + the 26 KB read ≈ 41K chars), four messages go in
    // ONE pass, 20_946 → 9_194 tokens, and the run ends with 34_625 stale chars deferred
    // because carrying them warm is cheaper than the break that would remove them.
    // Σ = 176_155 (−35%), last prompt 21_690 vs 35_525.

    // THE assertion: exactly one iteration rewrote the history.
    const breakingIterations = trimmed.digestedPerIteration.filter((d) => d > 0);
    expect(breakingIterations).toHaveLength(1);
    expect(breakingIterations[0]).toBe(4);
    // And it happened once the stale mass was worth it, never before.
    const breakAt = trimmed.digestedPerIteration.findIndex((d) => d > 0);
    for (const deferred of trimmed.deferredPerIteration.slice(0, breakAt)) {
      expect(deferred).toBeLessThan(DIGEST_BATCH_MIN_CHARS);
    }

    // The per-iteration prompt shrinks exactly there, which an append-only history
    // can never do — and nowhere else.
    expect(isStrictlyIncreasing(trimmed.perIteration)).toBe(false);
    const shrinks = trimmed.perIteration.filter((v, i) => i > 0 && v < trimmed.perIteration[i - 1]!);
    expect(shrinks).toHaveLength(1);
    expect(trimmed.perIteration[breakAt]).toBeLessThan(trimmed.perIteration[breakAt - 1]!);

    // The sum still drops materially and the last prompt is still bounded by the
    // digest, not by how much was built — just not to the per-iteration floor.
    expect(trimmed.cumulative).toBeLessThan(untrimmed.cumulative * 0.7);
    expect(trimmed.perIteration.at(-1)!).toBeLessThan(untrimmed.perIteration.at(-1)! * 0.7);
    // What is left deferred at the end is under one batch, by construction.
    expect(trimmed.deferredPerIteration.at(-1)!).toBeLessThan(DIGEST_BATCH_MIN_CHARS);
    expect(trimmed.deferredPerIteration.at(-1)!).toBeGreaterThan(0);
  });

  it("keeps the freshest tool turns verbatim and digests only what was acted on", () => {
    const history: LLMMessage[] = [{ role: "user", content: "task" }];
    for (let n = 1; n <= 4; n++) appendIteration(history, n, n === 4 ? { readChars: BIG_READ_CHARS } : undefined);

    // Immediately after the read, the result is the freshest evidence: untouched.
    trimSubAgentHistory(history, { systemPromptChars: SYSTEM_PROMPT_CHARS, tools: TOOLS, contextWindow: CONTEXT_WINDOW });
    const readResult = history.find((m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("read4"))!;
    expect((readResult.content as string).length).toBe(BIG_READ_CHARS);

    // One more turn: still inside the fresh window (FRESH_TOOL_TURNS = 2).
    appendIteration(history, 5);
    trimSubAgentHistory(history, { systemPromptChars: SYSTEM_PROMPT_CHARS, tools: TOOLS, contextWindow: CONTEXT_WINDOW });
    expect((readResult.content as string).length).toBe(BIG_READ_CHARS);

    // Two turns on, the agent has acted on it — now it is digested, head+tail.
    appendIteration(history, 6);
    const first = trimSubAgentHistory(history, { systemPromptChars: SYSTEM_PROMPT_CHARS, tools: TOOLS, contextWindow: CONTEXT_WINDOW });
    expect(first.digested).toBeGreaterThan(0);
    const digested = readResult.content as string;
    expect(digested.length).toBeLessThan(2_000);
    expect(digested).toContain("chars elided");
    expect(digested.startsWith("// read4")).toBe(true);
    expect(digested.endsWith(body(BIG_READ_CHARS, "read4").slice(-100))).toBe(true);

    // Idempotent: re-running does not re-digest or re-append a marker.
    appendIteration(history, 7);
    trimSubAgentHistory(history, { systemPromptChars: SYSTEM_PROMPT_CHARS, tools: TOOLS, contextWindow: CONTEXT_WINDOW });
    expect(readResult.content).toBe(digested);
    expect((digested.match(/chars elided/g) ?? []).length).toBe(1);
  });

  it("digests a stale write_file argument into still-parseable JSON", () => {
    const history: LLMMessage[] = [{ role: "user", content: "task" }];
    // Ten, not four: eight stale 6 KB write bodies ≈ 46K chars of stale mass, over the
    // batch threshold. Four left 11.5K — deferred, not digested, under the batching rule.
    for (let n = 1; n <= 10; n++) appendIteration(history, n);
    const result = trimSubAgentHistory(history, { systemPromptChars: SYSTEM_PROMPT_CHARS, tools: TOOLS, contextWindow: CONTEXT_WINDOW });
    expect(result.digested).toBe(8);

    const stale = history.find((m) => m.role === "assistant" && m.tool_calls?.[0]?.function.arguments.includes("part1.js"))!;
    const args = stale.tool_calls![0]!.function.arguments;
    // Parseable — a chat template that reads `arguments` must not be handed a stub.
    const parsed = JSON.parse(args) as { path: string; content: string };
    // The short field survives intact; only the body goes.
    expect(parsed.path).toBe("generated/tetris25d/part1.js");
    expect(parsed.content.length).toBeLessThan(600);
    expect(parsed.content).toContain("already written to disk");
    expect(args.length).toBeLessThan(1_000);
  });

  it("leaves a small argument payload and a small tool result alone", () => {
    const history: LLMMessage[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "notes.md" }) } }] },
      { role: "tool", content: "short result", tool_call_id: "a" },
      { role: "assistant", content: null, tool_calls: [{ id: "b", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "other.md" }) } }] },
      { role: "tool", content: "another short result", tool_call_id: "b" },
      { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "third.md" }) } }] },
      { role: "tool", content: "third short result", tool_call_id: "c" },
    ];
    const before = JSON.stringify(history);
    const result = trimSubAgentHistory(history, { systemPromptChars: SYSTEM_PROMPT_CHARS, tools: TOOLS, contextWindow: CONTEXT_WINDOW });
    expect(result).toEqual({ dropped: 0, clamped: 0, digested: 0, digestedStaleChars: 0, digestTrigger: null, deferredStaleChars: 0 });
    expect(JSON.stringify(history)).toBe(before);
  });

  it("marks nothing stale until the run has made enough tool turns", () => {
    const history: LLMMessage[] = [{ role: "user", content: "task" }];
    appendIteration(history, 1, { readChars: BIG_READ_CHARS });
    expect(freshWindowStart(history)).toBe(0);
    trimSubAgentHistory(history, { systemPromptChars: SYSTEM_PROMPT_CHARS, tools: TOOLS, contextWindow: CONTEXT_WINDOW });
    expect((history[2]!.content as string).length).toBe(BIG_READ_CHARS);
  });
});

/**
 * THE BATCHING RULE.
 *
 * Audit log 9-13 Sept 2026, 141 mid-run sub-agent calls: on 32 of them the prompt SHRANK
 * between adjacent calls of one run (19_082 → 14_556 tokens) and each paid a 10-16 s cold
 * TTFT, because the fresh window slid one turn and the digest rewrote the message that had
 * just left it — every iteration. Warm re-sends of 40-49K tokens reached first token in
 * 1.1-1.4 s. So a rewrite is deferred until the stale mass is worth one break, and then
 * every candidate goes at once.
 */
describe("sub-agent history — the digest batches", () => {
  /** A stale read result of `chars`, followed by the two fresh tool turns that push it out
   *  of the window. `readChars` overrides make the STALE one any size; the fresh ones are
   *  short so nothing but the stale content moves the estimate. */
  const staleHistory = (stale: Array<{ readChars: number } | { writeChars: number }>): LLMMessage[] => {
    const history: LLMMessage[] = [{ role: "user", content: "task" }];
    stale.forEach((entry, i) => {
      const id = `stale_${i}`;
      if ("readChars" in entry) {
        history.push({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `src/${i}.ts` }) } }] });
        history.push({ role: "tool", content: body(entry.readChars, `stale${i}`), tool_call_id: id });
      } else {
        history.push({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: `src/${i}.ts`, content: body(entry.writeChars, `stale${i}`) }) } }] });
        history.push({ role: "tool", content: `Wrote src/${i}.ts`, tool_call_id: id });
      }
    });
    for (const id of ["fresh_a", "fresh_b"]) {
      history.push({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `${id}.md` }) } }] });
      history.push({ role: "tool", content: `${id} result`, tool_call_id: id });
    }
    return history;
  };
  const trim = (history: LLMMessage[], contextWindow = CONTEXT_WINDOW) =>
    trimSubAgentHistory(history, { systemPromptChars: SYSTEM_PROMPT_CHARS, tools: TOOLS, contextWindow });

  it("defers a single 30K-char stale result and reports what it is carrying", () => {
    const history = staleHistory([{ readChars: 30_000 }]);
    expect(freshWindowStart(history)).toBe(3);
    const before = JSON.stringify(history);

    const result = trim(history);

    // Nothing on the wire changed: no rewrite, so no prefix break on this call.
    expect(result.digested).toBe(0);
    expect(result.dropped).toBe(0);
    expect(JSON.stringify(history)).toBe(before);
    expect((history[2]!.content as string).length).toBe(30_000);
    // The dry run priced it: 30K minus the head+tail digest it would become
    // (1_200 + 400 + a marker of well under 400 chars).
    expect(result.deferredStaleChars).toBeGreaterThan(30_000 - 2_000);
    expect(result.deferredStaleChars).toBeLessThan(30_000 - 1_600);
    expect(result.deferredStaleChars).toBeLessThan(DIGEST_BATCH_MIN_CHARS);
  });

  it("digests EVERY stale candidate in one call once the mass reaches the threshold", () => {
    // Two 25K reads (≈23K of stale mass each) plus a 3K write body: 49K, over 40K.
    // The write body alone is far under the threshold and rides along in the batch.
    const history = staleHistory([{ readChars: 25_000 }, { writeChars: 3_000 }, { readChars: 25_000 }]);
    expect(freshWindowStart(history)).toBe(7);

    const result = trim(history);

    expect(result.digested).toBe(3);
    expect(result.deferredStaleChars).toBe(0);
    expect(result.dropped).toBe(0);
    // The row must be able to say WHICH trigger fired and how much mass it bought: this is
    // the healthy one-break-per-batch case, and the overflow case below is not.
    expect(result.digestTrigger).toBe("batch");
    expect(result.digestedStaleChars).toBeGreaterThanOrEqual(DIGEST_BATCH_MIN_CHARS);
    for (const index of [2, 6]) {
      const content = history[index]!.content as string;
      expect(content.length).toBeLessThan(2_000);
      expect(content).toContain("chars elided");
    }
    const writeArgs = JSON.parse(history[3]!.tool_calls![0]!.function.arguments) as { path: string; content: string };
    expect(writeArgs.path).toBe("src/1.ts");
    expect(writeArgs.content).toContain("already written to disk");
    // The fresh window is untouched — it is what the agent is working from.
    expect(history[8]!.content).toBe("fresh_a result");
    expect(history[10]!.content).toBe("fresh_b result");
  });

  it("is idempotent: the next call with nothing new stale changes nothing", () => {
    const history = staleHistory([{ readChars: 25_000 }, { writeChars: 3_000 }, { readChars: 25_000 }]);
    expect(trim(history).digested).toBe(3);
    const afterBatch = JSON.stringify(history);

    const result = trim(history);

    // Byte-identical: the second request carries the same prefix the first one built.
    expect(result).toEqual({ dropped: 0, clamped: 0, digested: 0, digestedStaleChars: 0, digestTrigger: null, deferredStaleChars: 0 });
    expect(JSON.stringify(history)).toBe(afterBatch);
  });

  it("digests before dropping when the request does not fit, threshold or not", () => {
    // Under the threshold (≈28K of stale mass) but over the budget: contextWindow 16_384
    // → budget max(8_192, min(12_288, 16_384 − 10_486 − 8_192)) = 8_192 tokens, and the
    // 30K-char read alone is ≈10K tokens. The digest is what makes it fit; without it,
    // the drop loop would evict the whole read/assistant pair instead of shrinking it.
    const history = staleHistory([{ readChars: 30_000 }]);
    const messagesBefore = history.length;
    expect(computePromptTokenBudget(16_384)).toBe(8_192);

    const result = trim(history, 16_384);

    expect(result.digested).toBe(1);
    expect(result.deferredStaleChars).toBe(0);
    expect(result.dropped).toBe(0);
    expect(result.clamped).toBe(0);
    // Reported as the EXCEPTION it is. On a window this small the same branch fires again on
    // whatever went stale next iteration — one prefix break per iteration — and only this
    // field lets the log tell that apart from the batch case above.
    expect(result.digestTrigger).toBe("overflow");
    expect(result.digestedStaleChars).toBeGreaterThan(28_000);
    expect(result.digestedStaleChars).toBeLessThan(DIGEST_BATCH_MIN_CHARS);
    expect(history).toHaveLength(messagesBefore);
    const read = history[2]!.content as string;
    expect(read).toContain("chars elided");
    expect(read.length).toBeLessThan(2_000);
  });
});

describe("sub-agent history — the overflow guard", () => {
  it("pins the budget at contextWindow 131072", () => {
    // max(⌊131072×0.5⌋, min(⌊131072×0.75⌋, 131072 − 10486 − 8192)) = 98_304.
    // The audited run's peak prompt was ≈30_700 tokens, which is why the drop loop
    // never fired there — a fact worth pinning so a future reserve change cannot move
    // it silently.
    expect(computePromptTokenBudget(CONTEXT_WINDOW)).toBe(98_304);
  });

  it("drops an assistant message together with the tool results answering it", () => {
    const history: LLMMessage[] = [{ role: "user", content: body(400, "task") }];
    for (let n = 1; n <= 12; n++) {
      const id = `call_${n}`;
      history.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `f${n}.md` }) } }],
      });
      history.push({ role: "tool", content: body(1_500, `r${n}`), tool_call_id: id });
    }
    // A tiny window forces the drop loop to run.
    const result = trimSubAgentHistory(history, { systemPromptChars: 200, tools: [], contextWindow: 8_192 });
    expect(result.dropped).toBeGreaterThan(0);

    // Every surviving tool result still has the assistant message that called it.
    const liveIds = new Set(history.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)));
    for (const message of history) {
      if (message.role !== "tool") continue;
      expect(liveIds.has(message.tool_call_id!)).toBe(true);
    }
    // The task statement is pinned.
    expect(history[0]!.content).toBe(body(400, "task"));
  });

  it("clamps rather than drops the last surviving tool result", () => {
    const history: LLMMessage[] = [
      { role: "user", content: body(400, "task") },
      { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", content: body(200_000, "huge"), tool_call_id: "a" },
    ];
    const result = trimSubAgentHistory(history, { systemPromptChars: 200, tools: [], contextWindow: 8_192 });
    expect(result.clamped).toBeGreaterThan(0);
    // Still present as evidence — both deadline-synthesis paths bail without one.
    const survivor = history.find((m) => m.role === "tool")!;
    expect(typeof survivor.content).toBe("string");
    expect((survivor.content as string).length).toBeLessThan(5_000);
  });
});

describe("read_file windows an unwindowed large read", () => {
  it("returns head+tail with the recovery instruction instead of the whole file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-read-window-"));
    // The size that slid under MAX_TOOL_RESULT_CHARS (32_768) and rode along for ~10
    // iterations of the audited run.
    const content = body(BIG_READ_CHARS, "game");
    writeFileSync(join(tempDir, "game.js"), content);
    await import("../tools/filesystem.js");
    const { getTool } = await import("../tools/registry.js");

    const result = await getTool("read_file")!.execute({ path: "game.js" }, { sessionId: "s", workspacePath: tempDir });
    expect(result.success).toBe(true);
    expect(result.output.length).toBeLessThan(content.length);
    expect(result.output).toContain("Call read_file again with offset/limit");
    expect(result.metadata).toMatchObject({ truncated: true });
    // Head AND tail: an agent re-reads a file it built to confirm the END still closes.
    expect(result.output.startsWith("// game")).toBe(true);
    expect(result.output.endsWith(content.slice(-40))).toBe(true);
  });

  it("still returns a normal-sized file whole", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-read-window-"));
    const content = body(4_000, "small");
    writeFileSync(join(tempDir, "small.js"), content);
    await import("../tools/filesystem.js");
    const { getTool } = await import("../tools/registry.js");

    const result = await getTool("read_file")!.execute({ path: "small.js" }, { sessionId: "s", workspacePath: tempDir });
    expect(result.output).toBe(content);
    expect(result.metadata).not.toMatchObject({ truncated: true });
  });
});

/**
 * THE ONE THING IN THIS ARRAY THAT IS NOT RECOVERABLE.
 *
 * Every other stale result can be re-read; the digest even says so. A completed sub-agent's
 * answer lives here and nowhere else, and three salvage paths relay it verbatim when the run
 * runs out of clock — each gated on the body still being at least 3,000 bytes. Digested to
 * ~1,750 it stopped qualifying, so a coordinator that delegated, made two more tool calls and
 * then hit its deadline handed back a snippet instead of the specialist's work.
 */
describe("the history digest and a delegated deliverable", () => {
  const DELIVERABLE = "Delegated result from content_writer — TASK COMPLETED\n\n" + "x".repeat(16_000);
  // 48K, not 16K: the read alone must carry the stale mass over DIGEST_BATCH_MIN_CHARS,
  // because the deliverable beside it is exempt and contributes nothing to the batch.
  const FILE_READ = "line one of a big file\n" + "y".repeat(48_000);

  const historyWithBoth = (): LLMMessage[] => ([
    { role: "user", content: "build the deck" },
    { role: "assistant", content: "", tool_calls: [{ id: "1", name: "delegate_to_agent", function: { name: "delegate_to_agent", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "1", content: DELIVERABLE },
    { role: "assistant", content: "", tool_calls: [{ id: "2", name: "read_file", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "2", content: FILE_READ },
    { role: "assistant", content: "", tool_calls: [{ id: "3", name: "share_finding", function: { name: "share_finding", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "3", content: "ok" },
    { role: "assistant", content: "", tool_calls: [{ id: "4", name: "share_finding", function: { name: "share_finding", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "4", content: "ok" },
  ] as unknown as LLMMessage[]);

  it("leaves the delegation result whole while still digesting the file read beside it", () => {
    const history = historyWithBoth();
    const result = trimSubAgentHistory(history, { systemPromptChars: 100, tools: [], contextWindow: 131_072 });

    // The stale file read is exactly what the digest is for.
    expect(String(history[4]!.content).length).toBeLessThan(FILE_READ.length);
    expect(result.digested).toBeGreaterThan(0);

    // The deliverable is stale by the same measure and must survive it intact: 1,737 chars is
    // what it became, and 3,000 is the bar every passthrough extractor checks.
    expect(history[2]!.content).toBe(DELIVERABLE);
    expect(String(history[2]!.content).length).toBeGreaterThan(3_000);
  });

  it("does not count the exempt deliverable as deferred stale mass either", () => {
    const history = historyWithBoth();
    history[4]!.content = "short read";
    const result = trimSubAgentHistory(history, { systemPromptChars: 100, tools: [], contextWindow: 131_072 });
    // Exempt means not a candidate at all — not "a candidate the batch is waiting on".
    expect(result).toEqual({ dropped: 0, clamped: 0, digested: 0, digestedStaleChars: 0, digestTrigger: null, deferredStaleChars: 0 });
    expect(history[2]!.content).toBe(DELIVERABLE);
  });

  it("recognises the other two delegation result shapes as well", () => {
    for (const prefix of ["Parallel delegation completed", "Task graph completed"]) {
      const history = historyWithBoth();
      history[2]!.content = `${prefix} — 3 agents\n\n${"z".repeat(16_000)}`;
      const before = String(history[2]!.content);
      trimSubAgentHistory(history, { systemPromptChars: 100, tools: [], contextWindow: 131_072 });
      expect(history[2]!.content).toBe(before);
    }
  });
});
