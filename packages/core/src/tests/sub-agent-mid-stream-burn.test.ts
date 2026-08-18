import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const completeViaStreamMock = vi.fn();
const auditEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  // Spread the real module — sub-agent.ts and its helpers import value exports from
  // here, and a wholesale replacement breaks whenever production code grows one.
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async completeViaStream(messages: unknown, tools: unknown, signal?: AbortSignal, options?: unknown) {
      return completeViaStreamMock(messages, tools, signal, options);
    }
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeViaStreamMock(messages, tools, signal, undefined);
    }
  },
}));

vi.mock("../audit/logger.js", async (importActual) => ({
  ...(await importActual<typeof import("../audit/logger.js")>()),
  logAudit: (event: string, payload: Record<string, unknown>) => { auditEvents.push({ event, payload }); },
}));

/**
 * WIRING for the mid-stream burn abort, on the sub-agent side.
 *
 * The provider can stop a burning generation while it streams (see
 * provider-mid-stream-reasoning-burn.test.ts). That is only half the fix: the salvaged
 * response comes back with ZERO tool calls, so the loop's "no tool calls = final
 * answer" branch would hand a 45,000-character monologue to the coordinator AS THE
 * AGENT'S ANSWER — the same silent-wrong-result shape the measured run produced, just
 * five minutes sooner.
 *
 * WHAT CHANGED, AND WHY THIS FILE ARGUES WITH ITS OWN PREVIOUS SELF.
 *
 * This suite used to assert `calls === 1` under the comment "A burning generation must
 * not be retried — that is how a 20-minute failure becomes a 40-minute one". Run
 * dfe964f3 priced the other side of that trade and it is worse: web_coder burned 45,001
 * characters, the run was wound down at iteration 1 of 14, thirteen iterations went
 * unused, and the swarm re-dispatched the byte-identical 1,709-char task to the
 * next-ranked agent, which began burning the same way. The old assertion prevented a
 * retry INSIDE the run and bought a retry OUTSIDE it, on a fresh agent with no memory of
 * the failure. Cost identical, correction impossible.
 *
 * So the first burn now earns exactly one corrective turn. The protection the old
 * assertion really encoded — that a burn cannot be retried UNBOUNDEDLY — is now carried
 * by the two-burn test below, which is the one that would fail if the counter were wrong.
 */

const SUPERVISOR_WIND_DOWN = "wound down by the progress supervisor";
/** The budget the provider aborts at, salvaged and handed back. */
const SALVAGED_REASONING_CHARS = 45_000;
/**
 * Wall-clock a burn actually consumes, advanced per provider call.
 *
 * WITHOUT THIS THE WHOLE FILE IS A LIE. superviseProgress() is gated on
 * PROGRESS_CHECK_INTERVAL_MS (180s) of real elapsed time, so in a suite that runs in
 * milliseconds the supervisor NEVER SAMPLES and every assertion here is made against a
 * harness whose central safety net is switched off. Production takes 15.8 measured
 * minutes per burn — the gate is wide open there and permanently shut here, which is
 * exactly the gap that lets a change be green and inert at the same time.
 *
 * Date.now is spied rather than using fake timers because the run's deadline is a real
 * setTimeout on an AbortController; freezing the timer queue would hang the loop.
 */
const BURN_WALL_CLOCK_MS = 240_000;

interface StubResponse {
  content: string | null;
  reasoning: string;
  tool_calls: unknown[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; estimated: boolean };
  finishReason: string;
  truncatedBy?: string;
}

function writeTempConfig(agentName: string, stagedBuild = false): { tempDir: string; configPath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-mid-stream-burn-"));
  const configPath = join(tempDir, "starlingai.json");
  if (stagedBuild) {
    // An UNFINISHED artifact in the output zone: the on-disk evidence that the run's
    // deliverable is not done, whatever its final turn claims.
    mkdirSync(join(tempDir, "generated", "game"), { recursive: true });
    writeFileSync(
      join(tempDir, "generated", "game", "app.js"),
      `throw new Error("UNFINISHED_STUB: styles");`,
      "utf8",
    );
  }
  writeFileSync(configPath, JSON.stringify({
    subAgents: {
      [agentName]: {
        description: "Mid-stream burn fixture",
        systemPrompt: "Work the task.",
        tools: stagedBuild ? ["read_file", "write_file", "edit_file"] : ["read_file"],
        maxIterations: 6,
        // Comfortably above the clock this fixture advances, so a wind-down here is
        // always the supervisor's decision and never the turn deadline's.
        turnTimeoutMs: 1_800_000,
      },
    },
  }), "utf8");
  // Real material for the corrected turn's tool call to land on.
  writeFileSync(join(tempDir, "notes.txt"), "skeleton source material", "utf8");
  return { tempDir, configPath };
}

/** The provider's salvaged partial after it aborted a burning generation. */
function burnSalvage(truncatedBy: "reasoning_burn" | undefined): StubResponse {
  return {
    content: null,
    reasoning: "r".repeat(SALVAGED_REASONING_CHARS),
    tool_calls: [],
    usage: { promptTokens: 6845, completionTokens: 15_000, totalTokens: 21_845, estimated: true },
    finishReason: "length",
    ...(truncatedBy ? { truncatedBy } : {}),
  };
}

/**
 * The ACTION a corrected run takes on its next turn.
 *
 * It has to be a real tool call, not prose: a run that finishes having called no tool and
 * said little is a failure by the loop's own reckoning (buildNoProgressFailure), and
 * rightly so — being corrected and then still not acting is not a recovery. Asserting
 * recovery therefore means asserting the run ACTS.
 */
function toolCallAnswer(): StubResponse {
  return {
    content: null,
    reasoning: "",
    tool_calls: [{ id: "call_1", name: "read_file", arguments: { path: "notes.txt" } }],
    usage: { promptTokens: 7000, completionTokens: 30, totalTokens: 7030, estimated: true },
    finishReason: "tool_calls",
  };
}

/** An ordinary answer — what a corrected run produces on its next turn. */
function plainAnswer(text: string): StubResponse {
  return {
    content: text,
    reasoning: "",
    tool_calls: [],
    usage: { promptTokens: 7000, completionTokens: 40, totalTokens: 7040, estimated: true },
    finishReason: "stop",
  };
}


/** The ANNOUNCEMENT shape: a model saying what it is about to do, with no tool call. */
function announcement(): StubResponse {
  return {
    content: "Now I'll fill the styles stub with the full CSS subsystem (board 3D scene, cells, panels, overlays).",
    reasoning: "",
    tool_calls: [],
    usage: { promptTokens: 7000, completionTokens: 30, totalTokens: 7030, estimated: true },
    finishReason: "stop",
  };
}

/** Drives the real runSubAgent loop over a fixed response SEQUENCE (last one repeats). */
async function runFixture(agentName: string, sequence: StubResponse[], opts?: { stagedBuild?: boolean }) {
  const { tempDir, configPath } = writeTempConfig(agentName, opts?.stagedBuild ?? false);
  process.env["SAI_CONFIG_PATH"] = configPath;
  vi.resetModules();

  // Advance a real clock so superviseProgress() actually samples between iterations.
  const realNow = Date.now();
  let elapsed = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow + elapsed);

  let call = 0;
  completeViaStreamMock.mockImplementation(() => {
    const next = sequence[Math.min(call, sequence.length - 1)]!;
    call++;
    elapsed += BURN_WALL_CLOCK_MS;
    return Promise.resolve(next);
  });

  const { runSubAgent } = await import("../agent/sub-agent.js");
  // A staged build needs a SPECIFICATION-sized task (> STAGED_BUILD_TASK_CHAR_THRESHOLD),
  // which is what makes the classifier fire — same structural condition as production.
  const task = opts?.stagedBuild
    ? "Build a complete playable browser game as one self-contained page. ".repeat(12)
    : "Do something useful.";
  const output = String(await runSubAgent({
    agentName,
    task,
    parentSessionId: `mid-stream-burn-${agentName}`,
    workspacePath: tempDir,
  }));
  rmSync(tempDir, { recursive: true, force: true });
  return { output, calls: completeViaStreamMock.mock.calls.length };
}

/** The messages array handed to the Nth (0-based) provider call. */
function messagesOfCall(index: number): Array<{ role: string; content: unknown }> {
  return completeViaStreamMock.mock.calls[index]![0] as Array<{ role: string; content: unknown }>;
}

describe("sub-agent — a provider-aborted burn is corrected once, then fatal", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env["SAI_CONFIG_PATH"];
    completeViaStreamMock.mockReset();
    auditEvents.length = 0;
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const swarmMemory = await import("../swarm/memory.js");
    await swarmMemory.resetSharedMemoryForTests();
  });

  it("gives the FIRST burn a corrective turn instead of killing the run", async () => {
    const { output, calls } = await runFixture("burn_once_agent", [
      burnSalvage("reasoning_burn"),
      toolCallAnswer(),
      plainAnswer("Wrote the skeleton."),
    ]);

    // The run survived its first burn, ACTED, and delivered.
    expect(calls).toBe(3);
    expect(output).toContain("Wrote the skeleton.");
    expect(output).not.toContain(SUPERVISOR_WIND_DOWN);

    // The correction actually reached the model, and it names the measured size —
    // without the number the instruction is unfalsifiable to a model that cannot see
    // its own discarded reasoning.
    const second = messagesOfCall(1);
    const corrective = second.filter((m) => m.role === "user").at(-1);
    expect(String(corrective?.content)).toContain("STOP PLANNING");
    expect(String(corrective?.content)).toContain("45,000");

    const intervened = auditEvents.filter((e) => e.event === "progress_verifier_intervened");
    expect(intervened).toHaveLength(1);
    expect(intervened[0]!.payload["action"]).toBe("corrected");
    expect(intervened[0]!.payload["burnCount"]).toBe(1);
  });

  it("winds down on the SECOND burn — the correction is not retried forever", async () => {
    // THE BOUND. This is the assertion the old `calls === 1` was really protecting, and
    // it is the one that fails if REASONING_BURN_RETRY_LIMIT is raised or the counter is
    // reset per iteration: an unbounded correction loop would run to the iteration cap,
    // six calls at ~15 measured minutes each.
    const { output, calls } = await runFixture("burn_twice_agent", [
      burnSalvage("reasoning_burn"),
      burnSalvage("reasoning_burn"),
    ]);

    expect(calls).toBe(2);
    expect(output).toContain(SUPERVISOR_WIND_DOWN);
    // The monologue is NOT presented as the answer.
    expect(output).not.toContain("r".repeat(200));

    const intervened = auditEvents.filter((e) => e.event === "progress_verifier_intervened");
    expect(intervened).toHaveLength(2);
    expect(intervened[0]!.payload["action"]).toBe("corrected");
    expect(intervened[1]!.payload["action"]).toBe("wound_down");
    expect(intervened[1]!.payload["burnCount"]).toBe(2);
  });

  it("does not let the SUPERVISOR wind down the run for the burn the correction answered", async () => {
    // THE INERTNESS PROBE, and the reason this file advances a clock at all.
    //
    // sampleProgress() reports CUMULATIVE reasoning while the supervisor's burn rule is an
    // ABSOLUTE budget, so after one 45,000-char burn the run sits permanently at the
    // threshold. With no rebase, the next superviseProgress() sample re-reaches "burning"
    // on the evidence the correction already answered and winds the run down — the
    // correction ships live, green and completely inert, which is the failure mode this
    // whole change set exists to stop repeating.
    //
    // Revert `reasoningCharsBaseline = reasoningCharsTotal` in sub-agent.ts and this fails.
    const { output } = await runFixture("burn_rebase_agent", [
      burnSalvage("reasoning_burn"),
      toolCallAnswer(),
      plainAnswer("Recovered and delivered."),
    ]);

    expect(output).toContain("Recovered and delivered.");
    expect(output).not.toContain(SUPERVISOR_WIND_DOWN);

    // Exactly one intervention: the correction. A second would be the supervisor
    // re-punishing the same characters.
    const intervened = auditEvents.filter((e) => e.event === "progress_verifier_intervened");
    expect(intervened).toHaveLength(1);
    expect(intervened[0]!.payload["action"]).toBe("corrected");
  });

  it("keeps the history legal for a strict chat template after a correction", async () => {
    // A burn salvages nothing, so the naive repair — push the correction as a user turn —
    // yields two consecutive user messages, and an assistant turn with empty content.
    // Strict templates (the reason this repo folds system messages at all) reject both.
    await runFixture("burn_history_agent", [
      burnSalvage("reasoning_burn"),
      plainAnswer("ok"),
    ]);

    const second = messagesOfCall(1);
    for (let i = 1; i < second.length; i++) {
      expect(
        second[i]!.role === "user" && second[i - 1]!.role === "user",
        `two consecutive user turns at index ${i - 1}`,
      ).toBe(false);
    }
    for (const m of second) {
      if (m.role !== "assistant") continue;
      const hasToolCalls = Array.isArray((m as { tool_calls?: unknown[] }).tool_calls)
        && ((m as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0;
      if (hasToolCalls) continue;
      expect(String(m.content ?? "").length, "empty assistant turn in history").toBeGreaterThan(0);
    }
  });

  it("refuses to accept an ANNOUNCEMENT as the final answer while markers remain", async () => {
    // RUN db88fa5b, exactly. web_coder had used 8 of 14 iterations and 13 tool calls, then
    // returned one sentence — "Now I'll fill the styles stub with the full CSS subsystem" —
    // with no tool call. The loop read "no tool calls = final answer", ended the run with six
    // iterations unused, and the user got a scaffold and a status report. The model wanted to
    // finish; the harness would not let it.
    //
    // The trigger is on-disk evidence, not phrasing: markers remain, so the artifact is
    // demonstrably unfinished whatever the turn says. No phrase list, works in any language.
    const { output, calls } = await runFixture("announce_agent", [
      announcement(),
      toolCallAnswer(),
      plainAnswer("Filled the styles subsystem."),
    ], { stagedBuild: true });

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(output).toContain("Filled the styles subsystem.");
    expect(output).not.toContain("Now I'll fill the styles stub");

    const second = messagesOfCall(1);
    const handedBack = second.filter((m) => m.role === "user").at(-1);
    expect(String(handedBack?.content)).toContain("YOU DESCRIBED THE NEXT STEP BUT DID NOT TAKE IT");
    expect(String(handedBack?.content)).toContain("UNFINISHED_STUB");

    const intervened = auditEvents.filter((e) => e.event === "progress_verifier_intervened");
    expect(intervened.some((e) => e.payload["verdict"] === "announced_without_acting")).toBe(true);
  });

  it("ACCEPTS a final answer when no markers remain — the run really is done", async () => {
    // THE DISCRIMINATOR. Identical shape, identical absence of a tool call; only the on-disk
    // evidence differs. Without this the guard would refuse to let any staged build end.
    const { output, calls } = await runFixture("announce_done_agent", [
      plainAnswer("The artifact is complete and verified."),
    ]);

    expect(calls).toBe(1);
    expect(output).toContain("The artifact is complete and verified.");
    expect(
      auditEvents.filter((e) => e.payload["verdict"] === "announced_without_acting"),
    ).toHaveLength(0);
  });

  it("hands the operator's unbounded grant to the provider, as a live callback", async () => {
    await runFixture("grant_agent", [burnSalvage("reasoning_burn")]);

    // Requirement 4 end-to-end: the option survives whatever wrapper chain
    // (boundary proxy, failover) the provider was built behind.
    const options = completeViaStreamMock.mock.calls[0]![3] as { isUnbounded?: unknown } | undefined;
    expect(typeof options?.isUnbounded).toBe("function");
    expect((options!.isUnbounded as () => boolean)()).toBe(false);
  });

  it("does NOT correct or wind down the same response when the provider did not flag a burn", async () => {
    // THE DISCRIMINATOR. Identical content, identical reasoning volume, identical zero
    // tool calls — only `truncatedBy` differs. If this also fired, the branch would be
    // reacting to "empty answer", not to the provider's decision.
    const { output } = await runFixture("control_agent", [burnSalvage(undefined)]);

    expect(output).not.toContain(SUPERVISOR_WIND_DOWN);
    expect(auditEvents.filter((e) => e.event === "progress_verifier_intervened")).toHaveLength(0);
  });
});

/**
 * THE FIFTH GUILLOTINE — a static deadline that cannot see the model is writing.
 *
 * Run d5747607: `coder` reasoned 52,116 characters across two iterations composing the fills
 * for its markers, and its own declared 900,000 ms budget cut it at 891,072 ms with
 * terminalState "timeout" — before one edit_file was emitted. The four before it were a
 * character budget, the drift rule, the stall sampler and the gateway clock. Same productive
 * step every time; five different timers, none able to tell writing from hanging.
 *
 * The deadline now asks the stream before it fires. Bounded, and refused outright when the
 * generation is circling — an extension, never an exemption.
 */
describe("sub-agent deadline — a run that is still writing gets more time", () => {
  it("extends rather than aborting, and the extension is bounded and loop-gated", async () => {
    const { DEADLINE_COMPOSITION_EXTENSION_LIMIT, DEADLINE_COMPOSITION_EXTENSION_MS } =
      await import("../agent/sub-agent-turn-budget.js");

    // The bound is the whole safety argument: a run may be extended, never made immortal.
    expect(DEADLINE_COMPOSITION_EXTENSION_LIMIT).toBeGreaterThan(0);
    expect(DEADLINE_COMPOSITION_EXTENSION_LIMIT).toBeLessThanOrEqual(5);
    // Total extension must stay well under the gateway turn budget, or a child outlives its
    // parent and the extension buys nothing but a later, more confusing death.
    const totalExtensionMs = DEADLINE_COMPOSITION_EXTENSION_LIMIT * DEADLINE_COMPOSITION_EXTENSION_MS;
    expect(totalExtensionMs).toBeLessThan(1_800_000);
    // One slice must be worth having — at the measured 16.8 tok/s a composition needs minutes.
    expect(DEADLINE_COMPOSITION_EXTENSION_MS).toBeGreaterThanOrEqual(120_000);
  });

  it("the measured run would have been extended, not killed", async () => {
    // coder: 891,072 ms elapsed of a 900,000 ms budget, mid-generation, non-circling.
    // With three 5-minute slices it reaches ~1,791,072 ms — past the ~15 minutes the
    // composition actually needed.
    const { DEADLINE_COMPOSITION_EXTENSION_LIMIT, DEADLINE_COMPOSITION_EXTENSION_MS } =
      await import("../agent/sub-agent-turn-budget.js");
    const measuredBudgetMs = 900_000;
    const reachable = measuredBudgetMs + DEADLINE_COMPOSITION_EXTENSION_LIMIT * DEADLINE_COMPOSITION_EXTENSION_MS;
    expect(reachable).toBeGreaterThan(1_200_000);
  });
});
