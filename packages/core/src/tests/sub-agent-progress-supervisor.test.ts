import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const completeMock = vi.fn();

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  // Spread the real module: sub-agent.ts and its helpers import value exports
  // (computePromptTokenBudget, DeadlineAbort, ...) from here, and a mock that
  // replaced the whole module broke every time production code grew an export.
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

/**
 * WIRING test for the progress supervisor — deliberately separate from the pure-policy
 * unit tests in progress-verifier.test.ts.
 *
 * The policy being correct proves nothing about whether it RUNS. Its predecessor was a
 * correct, unit-tested stall guard that could never reach a verdict: it was nested inside
 * the `unbounded` branch, below a markUnbounded() call that flipped the guard that branch
 * sat under, so it executed at most once per run while its rule needed two consecutive
 * samples. A green suite said nothing about that.
 *
 * So these drive the real runSubAgent loop and assert on the run's own account of why it
 * ended. An earlier draft asserted only "the model was called few times" and passed
 * against a run the supervisor never touched — the loop had bailed for an unrelated
 * reason and the count looked identical. The wind-down REASON is the only assertion here
 * that cannot be satisfied by accident.
 *
 * The three fixtures are the three measured runs, reproduced through the real loop:
 *   burner   every tool call fails, reasoning piles up      -> COLD arm, "burning"
 *   staller  one productive call, then the same read forever -> WARM arm, "stalled"
 *            (literally the content_writer shape: read_shared_facts in circles)
 *   worker   same reasoning volume, but genuinely working    -> never touched
 */

/**
 * Enough reasoning per iteration to cross REASONING_ABSOLUTE_CEILING_CHARS on the 3rd.
 *
 * Was 20,000, sized to the old 45,000 budget. That budget is gone: length no longer decides
 * whether a run is stuck (the reasoning TEXT does, sampled inside the stream), and what is
 * left between iterations is a resource backstop three times higher than anything measured.
 * This fixture therefore has to reach backstop scale for the WIRING it proves — that the
 * supervisor is connected to the loop and can wind a run down — to be exercised at all.
 */
const REASONING_PER_ITERATION = 120_000;
const CLOCK_STEP_MS = 200_000; // one supervisor window (180s) plus slack
const SUPERVISOR_WIND_DOWN = "wound down by the progress supervisor";

type Fixture = "burner" | "staller" | "worker";

function writeTempConfig(agentName: string, maxIterations: number): { tempDir: string; configPath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-progress-supervisor-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    subAgents: {
      [agentName]: {
        description: "Progress supervisor fixture",
        systemPrompt: "Work the task.",
        tools: ["read_shared_facts", "read_file"],
        maxIterations,
        // The schema maximum, and above the clock these fixtures actually advance (the
        // worker's 8 calls x CLOCK_STEP_MS; the other two wind down on the 4th), so a
        // wind-down here is the supervisor's decision and never the time budget's. At 600 s
        // the budget went critical on the 4th call; that only stayed invisible while "no
        // more tools" meant an emptied list the stub ignored. It is tool_choice "none" now,
        // and a tool call returned under it is discarded rather than executed.
        turnTimeoutMs: 1_800_000,
      },
    },
  }), "utf8");
  return { tempDir, configPath };
}

/**
 * Advance a fake wall clock by one supervisor window per model call, without touching
 * real timers (the loop awaits real promises). Only Date.now moves, which is exactly what
 * the supervisor's throttle reads.
 */
function installSteppingClock(): () => void {
  const realNow = Date.now();
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow + offset);
  return () => { offset += CLOCK_STEP_MS; };
}

/**
 * One iteration. All three fixtures emit the same wall of reasoning and one tool call per
 * iteration; the ONLY difference is the call itself.
 *
 *  worker   a different query every time — executes, succeeds and brings back a result the
 *           run has not seen, so the supervisor's progress counter climbs.
 *  staller  the SAME query every time — the first executes, and every repeat after it is
 *           served from the idempotent-call cache, which short-circuits before the
 *           progress counter by design. A model re-reading the same context in circles.
 *  burner   a GRANTED tool whose every call fails. It has to be granted: an ungranted
 *           name is rejected by a different path that ends the run on its own, which
 *           would make this test pass without the supervisor doing anything.
 *
 * The argument is `query`, which the tool answers with the query in it. It was `topic`, which
 * read_shared_facts ignores, so the "worker" got the byte-identical "No shared facts available
 * yet" eight times: working only while progress meant a successful call. Progress is a NEW
 * result now (isNovelToolOutcome), and eight identical answers are the loop shape itself.
 */
function iteration(index: number, fixture: Fixture, reasoningChars: number) {
  const call = fixture === "burner"
    ? { id: `call-${index}`, name: "read_file", arguments: { path: `missing-${index}.txt` } }
    : {
      id: `call-${index}`,
      name: "read_shared_facts",
      arguments: { query: fixture === "worker" ? `topic-${index}` : "the same topic, forever" },
    };
  return {
    content: "",
    reasoning: "t".repeat(reasoningChars),
    tool_calls: [call],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "tool_calls",
  };
}

async function runFixture(
  agentName: string,
  fixture: Fixture,
  maxIterations: number,
): Promise<{ output: string; calls: number }> {
  const { tempDir, configPath } = writeTempConfig(agentName, maxIterations);
  process.env["SAI_CONFIG_PATH"] = configPath;
  vi.resetModules();

  const step = installSteppingClock();
  let call = 0;
  completeMock.mockImplementation(() => {
    const response = iteration(call++, fixture, REASONING_PER_ITERATION);
    step();
    return Promise.resolve(response);
  });

  const { runSubAgent } = await import("../agent/sub-agent.js");
  const output = String(await runSubAgent({
    agentName,
    task: "Do something useful.",
    parentSessionId: `supervisor-wiring-${agentName}`,
    workspacePath: tempDir,
  }));
  rmSync(tempDir, { recursive: true, force: true });
  return { output, calls: completeMock.mock.calls.length };
}

describe("sub-agent progress supervisor — wiring", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const swarmMemory = await import("../swarm/memory.js");
    await swarmMemory.resetSharedMemoryForTests();
  });

  it("winds a burning run down, and SAYS the supervisor did it", async () => {
    const { output, calls } = await runFixture("burner_agent", "burner", 14);
    // The reasoning budget is crossed after 3 iterations at 20,000 chars, so the
    // supervisor intervenes on the 4th iteration's top-of-loop sample — nowhere near the
    // 14-iteration budget the run would otherwise have burned through.
    expect(output).toContain(SUPERVISOR_WIND_DOWN);
    expect(calls).toBeLessThan(14);
    expect(calls).toBeGreaterThan(1);
  });

  it("winds down the content_writer shape: one real read, then the same read forever", async () => {
    const { output, calls } = await runFixture("staller_agent", "staller", 14);
    expect(output).toContain(SUPERVISOR_WIND_DOWN);
    expect(calls).toBeLessThan(14);
  });

  it("does NOT touch a run doing the same volume of reasoning that also gets things done", async () => {
    // The discriminator, and the reason the two tests above are not merely measuring
    // "runs stop eventually": identical reasoning volume, identical clock, identical agent
    // and identical tool. The only difference is that this run's calls actually do work.
    const maxIterations = 8;
    const { output, calls } = await runFixture("worker_agent", "worker", maxIterations);
    expect(output).not.toContain(SUPERVISOR_WIND_DOWN);
    // It used its whole budget having burned 8 x 20,000 = 160,000 reasoning chars — 3.5x
    // the cold-start budget — without ever being flagged, because it was working.
    expect(calls).toBeGreaterThanOrEqual(maxIterations);
  });
});

/**
 * THE BUSY STALL, at max effort — the hole run c297c5ea fell through.
 *
 * Max effort grants every long run an unbounded budget, and the supervisor's 'ask' for a run that
 * has written something is dropped for an unbounded run (notifyLongRunning), so a run that wrote
 * one file and then circled was watched by nothing. The loop here is the one the refusal rule
 * cannot see: the arguments change every call (a fresh pattern each time), so no cache ever
 * answers, every call executes and succeeds — and every answer is the same "No matches.". Counted
 * as successful calls that is progress in every window; counted as new results it is a stall
 * with 5 calls in each window, i.e. busy.
 */
describe("sub-agent progress supervisor — a busy stall at max effort", () => {
  const BUSY_CALLS_PER_ITERATION = 5;

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  /** `loopBrake: false` runs it with agents.performance.loopBrake off; `writeFirst: false` skips the
   *  opening edit; `samePattern` asks the SAME grep every call (so the caches answer the repeats). */
  async function runBusyLoop(
    grepOutput: (pattern: string) => string,
    maxIterations: number,
    opts: { loopBrake?: boolean; writeFirst?: boolean; samePattern?: boolean } = {},
  ) {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-busy-stall-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      ...(opts.loopBrake === false ? { agents: { performance: { loopBrake: false } } } : {}),
      subAgents: {
        busy_agent: {
          description: "Busy-stall fixture",
          systemPrompt: "Work the task.",
          tools: ["edit_file", "grep_files"],
          maxIterations,
          turnTimeoutMs: 1_800_000,
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const step = installSteppingClock();
    let turn = 0;
    let pattern = 0;
    completeMock.mockImplementation(() => {
      // One real edit first — the run HAS written something, which is what made the old rule say 'ask'.
      const tool_calls = turn++ === 0 && opts.writeFirst !== false
        ? [{ id: "edit-0", name: "edit_file", arguments: { path: "deck.html", old_string: "a", new_string: "b" } }]
        : Array.from({ length: BUSY_CALLS_PER_ITERATION }, () => {
          pattern += 1;
          return { id: `grep-${pattern}`, name: "grep_files", arguments: { pattern: opts.samePattern ? "p" : `p${pattern}`, path: "deck.html" } };
        });
      step();
      return Promise.resolve({ content: "", tool_calls, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "tool_calls" });
    });

    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    const { runWithEffortContext } = await import("../runtime/effort-context.js");
    let greps = 0;
    registerTool({
      name: "edit_file",
      description: "Stub edit.",
      parameters: { type: "object", properties: {} },
      async execute(args) {
        return { success: true, output: `Edited ${String(args["path"])}.`, metadata: { outputPath: String(args["path"]), path: String(args["path"]) } };
      },
    });
    registerTool({
      name: "grep_files",
      description: "Stub grep.",
      parameters: { type: "object", properties: {} },
      async execute(args) {
        greps += 1;
        return { success: true, output: grepOutput(String(args["pattern"])) };
      },
    });
    try {
      const result = await runWithEffortContext("max", () => runSubAgentWithStats({
        agentName: "busy_agent",
        task: "Find where the deck initialises.",
        parentSessionId: "busy-stall-wiring",
        workspacePath: tempDir,
      }));
      return { result, greps, calls: completeMock.mock.calls.length };
    } finally {
      unregisterTool("edit_file");
      unregisterTool("grep_files");
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  it("winds the run down as looping within two windows of the loop's start, though it wrote a file", async () => {
    const { result, greps, calls } = await runBusyLoop(() => "No matches.", 12);
    expect(result.output).toContain(SUPERVISOR_WIND_DOWN);
    // One window per model call: the edit's window and the first grep window each bring a new
    // result ("No matches." is new once); the next two are busy with nothing new, and the sample
    // after them winds the run down. Then the wind-down's own synthesis call — 5 in all, of 12.
    expect(calls).toBe(5);
    // Every grep executed — no cache and no refusal is what stopped this one.
    expect(greps).toBe(3 * BUSY_CALLS_PER_ITERATION);
    expect(result.loopEnforced).toMatchObject({ tool: "grep_files", via: "busy_stall", endedRun: true });
  });

  it("leaves the same run alone when each call brings back something new", async () => {
    const { result, calls } = await runBusyLoop((pattern) => `deck.html:12: ${pattern} found`, 8);
    expect(result.output).not.toContain(SUPERVISOR_WIND_DOWN);
    expect(calls).toBeGreaterThanOrEqual(8);
    expect(result.loopEnforced).toBeUndefined();
  });

  // THE ESCAPE HATCH, through the loop. agents.performance.loopBrake false promises the supervisor
  // exactly as it was: successful calls as progress AND no busy arm. The pure-policy test cannot see
  // whether sub-agent.ts passes the flag on, and each half of the promise needs its own run,
  // because either half alone hides the other.

  it("loopBrake false: a run that wrote a file and then re-asks the cached grep is not wound down (no busy arm)", async () => {
    // The same grep every call: one execution, then cache replays. Successful calls stay flat, so
    // the old rule sees a stall with a file written — 'ask', which max effort drops. With the busy
    // arm wired in regardless of the flag, 5 cached calls a window would wind it down as looping.
    const { result, calls, greps } = await runBusyLoop(() => "No matches.", 8, { loopBrake: false, samePattern: true });
    expect(greps).toBe(1);
    expect(result.output).not.toContain(SUPERVISOR_WIND_DOWN);
    expect(calls).toBeGreaterThanOrEqual(8);
    expect(result.loopEnforced).toBeUndefined();
  });

  it("loopBrake false: successful calls are progress again, so fresh questions with the same empty answer run on", async () => {
    // Nothing written, every call a new pattern that executes and succeeds with the same text.
    // Counted as successes (the old rule) that is progress in every window; counted as new results
    // it is a stall with nothing written, which winds the run down.
    const { result, calls } = await runBusyLoop(() => "No matches.", 8, { loopBrake: false, writeFirst: false });
    expect(result.output).not.toContain(SUPERVISOR_WIND_DOWN);
    expect(calls).toBeGreaterThanOrEqual(8);
    expect(result.loopEnforced).toBeUndefined();
  });

  it("loopBrake on: the same fresh-questions run IS wound down, so the case above discriminates", async () => {
    const { result, calls } = await runBusyLoop(() => "No matches.", 8, { writeFirst: false });
    expect(result.output).toContain(SUPERVISOR_WIND_DOWN);
    expect(calls).toBeLessThan(8);
  });
});
