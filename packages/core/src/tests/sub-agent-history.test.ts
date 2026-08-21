import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { trimSubAgentHistory, freshWindowStart } from "../agent/sub-agent-history.js";
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
 * chunkCount 0. The quantity under test is that cumulative sum — the whole history
 * is re-sent every iteration, so what buys wall clock is Σ(per-iteration prompt),
 * not the peak.
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
function replay(opts: { trim: boolean }): { perIteration: number[]; cumulative: number; history: LLMMessage[] } {
  const history: LLMMessage[] = [{ role: "user", content: body(2_473, "task") }];
  const perIteration: number[] = [];
  for (let n = 1; n <= 13; n++) {
    if (opts.trim) {
      trimSubAgentHistory(history, {
        systemPromptChars: SYSTEM_PROMPT_CHARS,
        tools: TOOLS,
        contextWindow: CONTEXT_WINDOW,
      });
    }
    perIteration.push(
      Math.ceil(SYSTEM_PROMPT_CHARS / 3.0) + estimatePromptTokensForRequest(history, TOOLS),
    );
    // Iteration 4 is the one that read the whole 25_929-char file back.
    appendIteration(history, n, n === 4 ? { readChars: BIG_READ_CHARS } : undefined);
  }
  return { perIteration, cumulative: perIteration.reduce((a, b) => a + b, 0), history };
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

  it("stops the prompt growing monotonically and cuts cumulative prefill", () => {
    const untrimmed = replay({ trim: false });
    const trimmed = replay({ trim: true });

    // Measured on this fixture: untrimmed Σ = 273_000 tokens, per-iteration climbing
    // 3_940 → 35_525. Digested: Σ = 124_216 (−54%), per-iteration plateauing at ~10_000
    // after the 26 KB read goes stale — the spike at iterations 5-6 is that read while
    // it is still inside the fresh window, which is exactly where it belongs.

    // THE assertion: the per-iteration prompt no longer only grows. It must shrink at
    // least once, which an append-only history can never do.
    expect(isStrictlyIncreasing(trimmed.perIteration)).toBe(false);
    expect(Math.min(...trimmed.perIteration.slice(1))).toBeLessThan(Math.max(...trimmed.perIteration));

    // And the sum — the wall-clock quantity — drops materially.
    expect(trimmed.cumulative).toBeLessThan(untrimmed.cumulative * 0.6);

    // The last prompt is bounded by the digest, not by how much was built.
    expect(trimmed.perIteration.at(-1)!).toBeLessThan(untrimmed.perIteration.at(-1)! * 0.5);
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
    for (let n = 1; n <= 4; n++) appendIteration(history, n);
    trimSubAgentHistory(history, { systemPromptChars: SYSTEM_PROMPT_CHARS, tools: TOOLS, contextWindow: CONTEXT_WINDOW });

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
    expect(result).toEqual({ dropped: 0, clamped: 0, digested: 0 });
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
  const FILE_READ = "line one of a big file\n" + "y".repeat(16_000);

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
