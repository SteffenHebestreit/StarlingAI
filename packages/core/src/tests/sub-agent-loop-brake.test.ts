import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE LOOP BRAKE, driven through the real sub-agent loop (agent/sub-agent.ts, the two cache
 * branches and the blocked-iteration stop; the rule itself is progress-verifier.ts
 * classifyCallReplay, unit-tested in progress-verifier.test.ts).
 *
 * The shape is run c297c5ea's: four content_writer runs re-issued their most repeated grep_files
 * call 128, 110, 99 and 68 times, three of them to the 199-iteration limit, while the cached-result
 * note ("move on") went out 545 times. Replay 1 and 2 stay answers; the 4th identical call since
 * the last successful write is refused; an iteration of nothing but refusals is blocked, and two
 * in a row end the run.
 *
 * The scripted model never gives up on its own, so every stop here is the loop's. Under
 * tool_choice "none" (the post-loop synthesis) it answers in text, as a model does.
 */

const completeMock = vi.fn();
const audit = vi.hoisted(() => ({ rows: [] as Array<{ type: string; data: Record<string, unknown> }> }));

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal, options?: unknown) {
      return completeMock(messages, tools, signal, options);
    }
  },
}));

vi.mock("../audit/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/logger.js")>();
  return {
    ...actual,
    logAudit: vi.fn((type: string, data: Record<string, unknown>) => {
      audit.rows.push({ type, data });
    }),
  };
});

type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
type Message = { role: string; content?: string | null; tool_call_id?: string };

const FINAL_TEXT = "Final answer from the evidence gathered.";

function toolTurn(calls: ToolCall[]) {
  return { content: "", tool_calls: calls, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "tool_calls" };
}

function textTurn(text = FINAL_TEXT) {
  return { content: text, tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" };
}

let callSeq = 0;
function call(name: string, args: Record<string, unknown>): ToolCall {
  callSeq += 1;
  return { id: `call-${callSeq}`, name, arguments: args };
}

/**
 * The scripted model: each entry is one response's tool calls, then text. Under tool_choice "none"
 * it writes text whatever the script says next.
 */
function scriptModel(script: Array<ToolCall[] | "text">, after: () => ToolCall[] | "text" = () => "text"): void {
  const queue = [...script];
  completeMock.mockImplementation(async (_messages: unknown, _tools: unknown, _signal: unknown, options?: { toolChoice?: string }) => {
    if (options?.toolChoice === "none") return textTurn();
    const next = queue.length > 0 ? queue.shift()! : after();
    return next === "text" ? textTurn() : toolTurn(next);
  });
}

function writeTempConfig(
  tools: string[],
  extra: Record<string, unknown> = {},
  agent: Record<string, unknown> = {},
): { tempDir: string; configPath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-loop-brake-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    ...extra,
    subAgents: {
      loop_agent: {
        description: "Loop brake test agent",
        systemPrompt: "Do the task with your tools.",
        tools,
        maxIterations: 30,
        // Room for T4's reads without the overflow trim: the digest under test is the batch one.
        model: { contextWindow: 131_072 },
        ...agent,
      },
    },
  }), "utf8");
  return { tempDir, configPath };
}

type Stub = { name: string; run: (args: Record<string, unknown>) => { success: boolean; output: string; metadata?: Record<string, unknown> } };

/** Runs the agent with stub tools registered AFTER the runner is imported, so no module import can
 *  put a real tool back over them. Returns the result and how often each stub executed. */
async function runAgent(stubs: Stub[], opts: { config?: Record<string, unknown>; agent?: Record<string, unknown>; task?: string } = {}) {
  const { tempDir, configPath } = writeTempConfig(stubs.map((stub) => stub.name), opts.config, opts.agent);
  process.env["SAI_CONFIG_PATH"] = configPath;
  vi.resetModules();
  const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
  const { registerTool, unregisterTool } = await import("../tools/registry.js");
  const executed: Array<{ tool: string; args: Record<string, unknown> }> = [];
  for (const stub of stubs) {
    registerTool({
      name: stub.name,
      description: `Stub ${stub.name}.`,
      parameters: { type: "object", properties: {} },
      async execute(args) {
        executed.push({ tool: stub.name, args: args as Record<string, unknown> });
        return stub.run(args as Record<string, unknown>);
      },
    });
  }
  try {
    const result = await runSubAgentWithStats({
      agentName: "loop_agent",
      task: opts.task ?? "Check the deck and report.",
      parentSessionId: `loop-brake-${callSeq}`,
      workspacePath: tempDir,
    });
    return { result, executed };
  } finally {
    for (const stub of stubs) unregisterTool(stub.name);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const rowsOf = (type: string) => audit.rows.filter((row) => row.type === type);
const refusals = () => rowsOf("sub_agent_tool_loop_enforced").filter((row) => row.data["action"] === "refuse");
const loopStops = () => rowsOf("sub_agent_tool_loop_detected").filter((row) => row.data["reason"] === "all_tool_calls_blocked");

const grepStub = (output: (args: Record<string, unknown>) => string = (args) => `No matches for /${String(args["pattern"])}/.`): Stub => ({
  name: "grep_files",
  run: (args) => ({ success: true, output: output(args) }),
});

describe("the loop brake in the sub-agent loop", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    audit.rows.length = 0;
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("T1: a straight loop runs once, is replayed twice, refused at the 4th call and stopped at the 5th", async () => {
    // 60 identical calls on offer; the run must take 5 of them and a synthesis.
    scriptModel([], () => [call("grep_files", { pattern: "Reveal", path: "deck.html" })]);
    const { result, executed } = await runAgent([grepStub()]);

    expect(executed).toHaveLength(1);
    // 1 executed + 2 replays + 2 refusals, then the post-loop synthesis. Unbraked it ran to 30.
    expect(completeMock.mock.calls.length).toBeLessThanOrEqual(7);
    // Refused at the 4th and the 5th identical call; the stop fires on the 5th.
    expect(refusals().map((row) => row.data["repeats"])).toEqual([4, 5]);
    expect(refusals()[0]!.data).toMatchObject({ tool: "grep_files", sinceWrite: true, answered: 3 });
    expect(loopStops()).toHaveLength(1);
    // The wire list never changed: every call, the synthesis included, sent the same tools.
    const toolLists = completeMock.mock.calls.map((args) => JSON.stringify(args[1]));
    expect(new Set(toolLists).size).toBe(1);
    expect(result.loopEnforced).toEqual({
      tool: "grep_files",
      target: JSON.stringify({ pattern: "Reveal", path: "deck.html" }),
      repeats: 5,
      via: "refuse",
      endedRun: true,
    });
    // The completion row says so too, without the arguments.
    expect(rowsOf("sub_agent_completed").at(-1)?.data["loopEnforced"]).toEqual({ tool: "grep_files", via: "refuse", repeats: 5, endedRun: true });
    expect(result.output).toContain(FINAL_TEXT);
  });

  it("T1: the refusal says why and the one hint rides in the tail, never in the head", async () => {
    scriptModel([], () => [call("grep_files", { pattern: "Reveal", path: "deck.html" })]);
    await runAgent([grepStub()]);
    const calls = completeMock.mock.calls.map((args) => args[0] as Message[]);
    const heads = new Set(calls.map((messages) => messages[0]!.content));
    expect(heads.size).toBe(1);
    const hinted = calls.filter((messages) => messages.some((m, i) => i > 0 && m.role === "system" && /LOOP BRAKE/.test(String(m.content))));
    // Only the call right after the first refusal carries it.
    expect(hinted).toHaveLength(1);
    const lastMessages = calls.at(-1)!;
    const refusal = lastMessages.find((m) => m.role === "tool" && /^Refused: 'grep_files'/.test(String(m.content)));
    expect(refusal?.content).toMatch(/returned the same result 3 times/);
  });

  it("T1: the consecutive-duplicate cache (a non-idempotent tool) is braked the same way", async () => {
    // verify_page is not in IDEMPOTENT_TOOLS: only the per-tool "same arguments as last time" cache answers it.
    scriptModel([], () => [call("verify_page", { path: "app.html" })]);
    const { result, executed } = await runAgent([{ name: "verify_page", run: () => ({ success: true, output: "FAIL: ReferenceError at line 12" }) }]);
    expect(executed).toHaveLength(1);
    expect(refusals().map((row) => row.data["repeats"])).toEqual([4, 5]);
    expect(loopStops()).toHaveLength(1);
    expect(result.loopEnforced?.via).toBe("refuse");
  });

  it("T2: an A,B,A,B loop on the ABA cache stops within 10 model calls, each call run once", async () => {
    let flip = 0;
    scriptModel([], () => [call("grep_files", { pattern: flip++ % 2 === 0 ? "Reveal" : "initialize", path: "deck.html" })]);
    const { executed } = await runAgent([grepStub()]);
    expect(completeMock.mock.calls.length).toBeLessThanOrEqual(10);
    expect(executed.map((entry) => entry.args["pattern"])).toEqual(["Reveal", "initialize"]);
    expect(loopStops()).toHaveLength(1);
  });

  it("T3: 39af10b8's margin — four reads, then the write, and the file is written", async () => {
    const writes: string[] = [];
    scriptModel([
      [call("read_file", { path: "context.md" })],
      [call("read_file", { path: "context.md" })],
      [call("read_file", { path: "context.md" })],
      [call("read_file", { path: "context.md" })],
      [call("write_file", { path: "cpsa-f.html", content: "<!DOCTYPE html><html></html>" })],
      "text",
    ]);
    const { result } = await runAgent([
      { name: "read_file", run: () => ({ success: true, output: "No shared facts available yet for this session." }) },
      {
        name: "write_file",
        run: (args) => {
          writes.push(String(args["path"]));
          return { success: true, output: `Wrote ${String(args["path"])}.`, metadata: { outputPath: String(args["path"]) } };
        },
      },
    ]);
    expect(writes).toEqual(["cpsa-f.html"]);
    // The 4th read was refused; the write that followed is progress, so nothing stopped the run.
    expect(refusals()).toHaveLength(1);
    expect(loopStops()).toHaveLength(0);
    expect(result.stats.terminalState).toBe("completed");
    expect(result.loopEnforced).toMatchObject({ via: "refuse", endedRun: false });
  });

  it("T4: once the digest has shrunk the answer, the re-reads get the whole file and none is refused", async () => {
    const BIG = `${"B".repeat(2_499)}|${"b".repeat(2_500)}`; // 5,000 chars, over the 2,000 a stale result keeps
    const others = ["r1.md", "r2.md", "r3.md", "r4.md", "r5.md", "r6.md"];
    scriptModel([
      [call("read_file", { path: "big.md" })],
      ...others.map((path) => [call("read_file", { path })]),
      [call("read_file", { path: "big.md" })],
      [call("read_file", { path: "big.md" })],
      [call("read_file", { path: "big.md" })],
      "text",
    ]);
    await runAgent([{
      name: "read_file",
      run: (args) => ({ success: true, output: args["path"] === "big.md" ? BIG : `${String(args["path"])}:${"x".repeat(12_000)}` }),
    }]);

    // The scenario is the one under test: the digest ran, and big.md's first answer was shrunk.
    expect(rowsOf("sub_agent_history_digested").length).toBeGreaterThan(0);
    expect(refusals()).toHaveLength(0);
    const finalMessages = completeMock.mock.calls.at(-1)![0] as Message[];
    const bigAnswers = finalMessages.filter((m) => m.role === "tool" && String(m.content).startsWith("B".repeat(100)));
    expect(bigAnswers.some((m) => !String(m.content).includes(BIG))).toBe(true); // the digested original
    expect(bigAnswers.filter((m) => String(m.content).includes(BIG))).toHaveLength(3); // the three re-reads, whole
  });

  it("T4b: once the overflow trim has DROPPED the answer, the re-asks are answered in full and none is refused", async () => {
    // T4's digest rewrites the answer in place, which the content check sees. A trim instead
    // removes the message from the history with its text intact, which only the identity check
    // (is that message object still in the history?) sees. A small window makes the trim drop the
    // first grep's block; every read stays under the 2,000 chars a stale result is digested to, so
    // no digest runs and the drop alone takes the answer away.
    const grepCall = () => call("grep_files", { pattern: "Reveal", path: "deck.html" });
    const reads = (batch: number) => Array.from({ length: 10 }, (_, i) => call("read_file", { path: `part-${batch}-${i}.md` }));
    scriptModel([
      [grepCall()],
      reads(1), reads(2), reads(3), reads(4),
      [grepCall()],
      [grepCall()],
      [grepCall()],
      "text",
    ]);
    const { executed } = await runAgent([
      grepStub(),
      { name: "read_file", run: (args) => ({ success: true, output: `${String(args["path"])}:${"x".repeat(1_900)}` }) },
    ], { agent: { model: { contextWindow: 32_768 } } });

    expect(rowsOf("sub_agent_history_trimmed").length).toBeGreaterThan(0);
    expect(rowsOf("sub_agent_history_digested")).toHaveLength(0);
    expect(executed.filter((entry) => entry.tool === "grep_files")).toHaveLength(1);
    const finalMessages = completeMock.mock.calls.at(-1)![0] as Message[];
    const grepAnswers = finalMessages.filter((m) => m.role === "tool" && String(m.content).startsWith("No matches for /Reveal/."));
    // The executed answer was dropped; the three re-asks are answered, whole, and none refused.
    expect(grepAnswers).toHaveLength(3);
    expect(refusals()).toHaveLength(0);
  });

  it("T5: build, test, fix — twenty edits with verify_page between them are never refused", async () => {
    const verdicts = ["FAIL: SyntaxError at line 3", "FAIL: SyntaxError at line 3", "PASS"];
    let verifyCalls = 0;
    const script: Array<ToolCall[] | "text"> = [];
    for (let i = 0; i < 10; i++) {
      script.push([call("edit_file", { path: "app.html", old_string: `v${i}`, new_string: `v${i + 1}` })]);
      script.push([call("verify_page", { path: "app.html" })]);
    }
    script.push("text");
    scriptModel(script);
    const { executed } = await runAgent([
      { name: "edit_file", run: (args) => ({ success: true, output: `Edited ${String(args["path"])}.`, metadata: { outputPath: String(args["path"]), path: String(args["path"]) } }) },
      { name: "verify_page", run: () => ({ success: true, output: verdicts[Math.min(verifyCalls++, verdicts.length - 1)]! }) },
    ]);
    expect(executed.filter((entry) => entry.tool === "verify_page")).toHaveLength(10);
    expect(executed.filter((entry) => entry.tool === "edit_file")).toHaveLength(10);
    expect(refusals()).toHaveLength(0);
    expect(loopStops()).toHaveLength(0);
  });

  it("T6: a refused call beside a new one is progress — no stop", async () => {
    scriptModel([
      [call("grep_files", { pattern: "Reveal", path: "deck.html" })],
      [call("grep_files", { pattern: "Reveal", path: "deck.html" })],
      [call("grep_files", { pattern: "Reveal", path: "deck.html" })],
      [call("grep_files", { pattern: "Reveal", path: "deck.html" }), call("grep_files", { pattern: "slide", path: "deck.html" })],
      [call("grep_files", { pattern: "Reveal", path: "deck.html" }), call("grep_files", { pattern: "section", path: "deck.html" })],
      "text",
    ]);
    const { result, executed } = await runAgent([grepStub()]);
    expect(executed.map((entry) => entry.args["pattern"])).toEqual(["Reveal", "slide", "section"]);
    expect(refusals()).toHaveLength(2);
    expect(loopStops()).toHaveLength(0);
    expect(result.stats.terminalState).toBe("completed");
    expect(result.output).toContain(FINAL_TEXT);
  });

  it("a later stop the refusals did not cause leaves endedRun false", async () => {
    // loopEnforced.endedRun is what C5's consumers read to tell "the brake ended this run" from
    // "the brake acted once and the run went on". Here the run is refused once, changes course,
    // and is later stopped by a different blocked streak (a failing call answered from the cache),
    // with no refusal in it: the stop is real, the brake's part in it is not.
    const grepCall = () => call("grep_files", { pattern: "Reveal", path: "deck.html" });
    scriptModel(
      [[grepCall()], [grepCall()], [grepCall()], [grepCall()], [call("grep_files", { pattern: "slide", path: "deck.html" })]],
      () => [call("verify_page", { path: "app.html" })],
    );
    const { result, executed } = await runAgent([
      grepStub(),
      { name: "verify_page", run: () => ({ success: false, output: "Error: the page server is unavailable" }) },
    ]);
    expect(refusals()).toHaveLength(1);
    expect(executed.filter((entry) => entry.tool === "verify_page")).toHaveLength(1);
    expect(loopStops()).toHaveLength(1);
    expect(result.loopEnforced).toMatchObject({ tool: "grep_files", via: "refuse", repeats: 4, endedRun: false });
  });

  it("leaves live-state tools alone: a browser snapshot re-polled runs every time", async () => {
    let polls = 0;
    scriptModel([], () => (polls++ < 6 ? [call("browser_snapshot", {})] : "text"));
    const { executed } = await runAgent([{ name: "browser_snapshot", run: () => ({ success: true, output: "page: loading…" }) }]);
    expect(executed).toHaveLength(6);
    expect(refusals()).toHaveLength(0);
  });

  it("a mid-stream burn row counts progress the way the supervisor does: new results, not successes", async () => {
    // progress_verifier_intervened is written by the supervisor AND by the mid-stream burn branch.
    // With the brake on, the supervisor's productiveToolCalls counts new results; a burn row still
    // counting successful calls would give one field two meanings on one event type. Two greps
    // here, both successful, the second one's answer already seen: 1 new result, 2 successes. The
    // first burn is corrected, the second winds the run down; both rows carry the count.
    const burn = () => ({ content: "", reasoning: "t".repeat(2_000), tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "length", truncatedBy: "reasoning_burn" });
    const turns: unknown[] = [
      toolTurn([call("grep_files", { pattern: "Reveal", path: "deck.html" })]),
      toolTurn([call("grep_files", { pattern: "reveal", path: "deck.html" })]),
      burn(),
      burn(),
    ];
    completeMock.mockImplementation(async (_messages: unknown, _tools: unknown, _signal: unknown, options?: { toolChoice?: string }) => {
      if (options?.toolChoice === "none") return textTurn();
      return turns.length > 0 ? turns.shift() : textTurn();
    });
    await runAgent([grepStub(() => "No matches.")]);
    const burnRows = rowsOf("progress_verifier_intervened").filter((row) => row.data["trigger"] === "mid_stream");
    expect(burnRows.map((row) => [row.data["action"], row.data["productiveToolCalls"]])).toEqual([["corrected", 1], ["wound_down", 1]]);
  });

  it("the replay (pnpm loops:replay) models the same caches as this loop", async () => {
    // agent/loop-replay.ts cannot load this runner, so it carries a copy of which tools the A→B→A
    // cache answers and which no cache ever answers. A tool added here and not there makes the
    // replay's stops and savings silently wrong; this is where that shows.
    const { tempDir, configPath } = writeTempConfig([]);
    process.env["SAI_CONFIG_PATH"] = configPath;
    try {
      vi.resetModules();
      const subAgent = await import("../agent/sub-agent.js");
      const { REPLAY_IDEMPOTENT_TOOLS } = await import("../agent/loop-replay.js");
      expect([...REPLAY_IDEMPOTENT_TOOLS].sort()).toEqual([...subAgent.IDEMPOTENT_TOOLS].sort());
      // loop-replay.ts neverReplayed(): the live-state prefixes plus exactly these.
      expect([...subAgent.NEVER_REPLAYED_TOOLS]).toEqual(["generate_image"]);
      expect(["browser_snapshot", "computer_click", "read_file"].map(subAgent.isLiveStateTool)).toEqual([true, true, false]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("agents.performance.loopBrake false restores the unbraked replays", async () => {
    let turns = 0;
    scriptModel([], () => (turns++ < 8 ? [call("grep_files", { pattern: "Reveal", path: "deck.html" })] : "text"));
    const { result, executed } = await runAgent([grepStub()], { config: { agents: { performance: { loopBrake: false } } } });
    expect(executed).toHaveLength(1);
    expect(refusals()).toHaveLength(0);
    expect(loopStops()).toHaveLength(0);
    expect(result.loopEnforced).toBeUndefined();
    expect(result.output).toContain(FINAL_TEXT);
  });
});
