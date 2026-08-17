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

/** Enough reasoning per iteration to cross COLD_START_REASONING_BUDGET_CHARS on the 3rd. */
const REASONING_PER_ITERATION = 20_000;
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
        turnTimeoutMs: 600_000,
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
 *  worker   a different topic every time — executes and succeeds, so successfulToolCount
 *           climbs.
 *  staller  the SAME topic every time — the first executes, and every repeat after it is
 *           served from the idempotent-call cache, which short-circuits before
 *           successfulToolCount by design. A model re-reading the same context in circles.
 *  burner   a GRANTED tool whose every call fails. It has to be granted: an ungranted
 *           name is rejected by a different path that ends the run on its own, which
 *           would make this test pass without the supervisor doing anything.
 */
function iteration(index: number, fixture: Fixture, reasoningChars: number) {
  const call = fixture === "burner"
    ? { id: `call-${index}`, name: "read_file", arguments: { path: `missing-${index}.txt` } }
    : {
      id: `call-${index}`,
      name: "read_shared_facts",
      arguments: { topic: fixture === "worker" ? `topic-${index}` : "the same topic, forever" },
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
