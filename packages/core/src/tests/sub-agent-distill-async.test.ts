import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PER-FINDING DISTILLATION IS OFF THE SUB-AGENT LOOP'S CRITICAL PATH.
 *
 * Audit log 10 Sept 2026, turn 3: the researcher's 142 s run carried 7 distillation calls
 * interleaved with its own iterations — 6.8, 1.5, 3.8, 1.4, 4.0, 7.4, 4.8, 5.2 s, about 30 s
 * or 21 % of the run — each awaited inline at autoShareUsefulFinding before the NEXT model
 * call could start. The distilled text feeds the shared facts (other agents, the synthesis
 * passes) and the sufficiency byte ladder; this agent's next iteration does not read it.
 *
 * The distill provider here returns a promise the test resolves BY HAND, so the ordering
 * below is a property of the code, not of timing. Every assertion is about the sequence of
 * calls that reached the provider / the store, the shared-facts store itself, or the
 * counter value the audit row carries — not about the text the run produced.
 */

interface RecordedCall {
  messages: Array<{ role: string; content: unknown }>;
  toolNames: string[];
}

const events: string[] = [];
const recordedCalls: RecordedCall[] = [];
const responseQueue = vi.fn();
const auditEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];

/** Set per test: what the distill call answers, once the test lets it. */
let distillGate: Promise<string> = Promise.resolve("");
/** Set per test when the distill calls must answer DIFFERENTLY, in call order. Consumed
 *  before `distillGate`; the calls reach the provider in order because each one is issued
 *  synchronously from the tool-result loop that produced its finding. */
let distillAnswers: string[] | null = null;
/** How long a queued answer stays in flight. Anything above 0 keeps the distillations
 *  PENDING across the awaits between the tool-result loop and the end-of-iteration ladder —
 *  which is the state the provisional byte count exists in on a real run. */
let distillDelayMs = 0;
let secondWorkerCallStarted: () => void = () => {};

function isDistillPrompt(messages: RecordedCall["messages"]): boolean {
  return messages.some((m) => m.role === "system" && /evidence-distillation step/i.test(String(m.content)));
}

function text(content: string) {
  return {
    content,
    tool_calls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "stop",
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    content: "",
    tool_calls: [{ id, name, arguments: args }],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "tool_calls",
  };
}

function record(messages: unknown, tools: unknown) {
  const msgs = messages as RecordedCall["messages"];
  recordedCalls.push({ messages: msgs, toolNames: (tools as Array<{ name: string }>).map((t) => t.name) });
  if (isDistillPrompt(msgs)) {
    events.push("distill_call_started");
    const queued = distillAnswers?.shift();
    const gate = queued === undefined
      ? distillGate
      : new Promise<string>((resolve) => setTimeout(() => resolve(queued), distillDelayMs));
    return gate.then((answer) => {
      events.push("distill_resolved");
      return text(answer);
    });
  }
  if (msgs.some((m) => m.role === "tool")) {
    events.push("next_model_call_started");
    secondWorkerCallStarted();
  }
  return responseQueue();
}

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown) {
      return record(messages, tools);
    }
    async completeViaStream(messages: unknown, tools: unknown) {
      return record(messages, tools);
    }
  },
}));

vi.mock("../audit/logger.js", async (importActual) => ({
  ...(await importActual<typeof import("../audit/logger.js")>()),
  logAudit: (event: string, payload: Record<string, unknown>) => {
    auditEvents.push({ event, payload });
    // The run's terminal row. It is logged AFTER the join, so a per-run analysis that
    // windows rows up to sub_agent_completed still contains the findings the run shared.
    if (event === "sub_agent_completed") events.push("completion_row");
  },
}));

// The real store, wrapped: the event is pushed only once the fact IS in shared memory.
vi.mock("../tools/memory.js", async (importActual) => {
  const actual = await importActual<typeof import("../tools/memory.js")>();
  return {
    ...actual,
    shareFinding: async (sessionId: string, key: string, value: string) => {
      await actual.shareFinding(sessionId, key, value);
      events.push("fact_stored");
    },
  };
});

// One module registry for the whole file (the pattern of sub-agent-synthesis-controls.test.ts):
// the loader binds its config PATH at import, so the path is fixed before the first import and
// each test rewrites that file + resetConfigForTests(). It also keeps every module WARM for the
// ordering test at the end, so the run's teardown (a dynamic import in its `finally`) costs
// milliseconds and the "still pending" window below measures the join, not module loading.
const tempDir = mkdtempSync(join(tmpdir(), "starlingai-sub-agent-distill-async-"));
const configPath = join(tempDir, "starlingai.json");
process.env["SAI_CONFIG_PATH"] = configPath;
writeFileSync(configPath, "{}", "utf8");
const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
const { resetConfigForTests } = await import("../config/loader.js");
const { readAllFacts, resetSharedMemoryForTests } = await import("../swarm/memory.js");
const { registerTool, unregisterTool } = await import("../tools/registry.js");

const AGENT = "distill_async_probe";
const DISTILLED = "- IM73A135V01: SNR 73 dB(A), AOP 135 dB SPL (Source: https://www.infineon.com/im73a135v01)";

/** web_search-shaped, 8 results: the heuristic extract runs to its 600-char cap, well past
 *  distillSharedFactsMinChars (200), so the distillation call is reached. `topic` varies the
 *  BODY, which is what the auto-share dedup key hashes — two searches with different topics
 *  are two distinct findings. */
function searchResultFor(topic: string): string {
  return [
    `**Web Search Results for:** ${topic}`,
    "",
    ...Array.from({ length: 8 }, (_, i) => [
      `**Result ${i + 1}: ${topic} XENSIV MEMS microphone — page ${i + 1}**`,
      `https://www.example${i + 1}.test/${topic.replace(/\s+/g, "-").toLowerCase()}`,
      `Analog MEMS microphone with a signal-to-noise ratio of 73 dB(A), an acoustic overload point of 135 dB SPL, IP57 protection, and a supply range of 1.62 V to 3.6 V; page ${i + 1} of the ${topic} listing repeats the headline specifications.`,
      "",
    ].join("\n")),
  ].join("\n");
}
const SEARCH_RESULT = searchResultFor("IM73A135V01 datasheet");

function writeTempConfig(turnTimeoutMs?: number): void {
  writeFileSync(configPath, JSON.stringify({
    agents: { defaultContainerized: false },
    subAgents: {
      [AGENT]: {
        description: "Probe specialist that exercises asynchronous per-finding distillation.",
        systemPrompt: "Gather evidence with the tools, then answer.",
        tools: ["web_search"],
        maxIterations: 3,
        ...(turnTimeoutMs ? { turnTimeoutMs } : {}),
      },
    },
  }), "utf8");
  resetConfigForTests();
}

function registerFakeSearch(body: (query: string) => string = () => SEARCH_RESULT) {
  registerTool({
    name: "web_search",
    description: "Search the web.",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    async execute(args) {
      events.push("tool_result_pushed");
      return { success: true, output: body(String(args.query ?? "")) } as never;
    },
  });
  return () => unregisterTool("web_search");
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Starts the run (does not await it). By default the worker answers one search then a
 *  final text; `responses` / `body` override the worker script and the search bodies. */
function startProbe(
  tag: string,
  options: { responses?: unknown[]; body?: (query: string) => string; turnTimeoutMs?: number } = {},
) {
  writeTempConfig(options.turnTimeoutMs);
  const queue: unknown[] = options.responses ?? [
    toolCall("s1", "web_search", { query: "IM73A135V01 datasheet" }),
    text("Final answer written from the search result."),
  ];
  responseQueue.mockImplementation(() => queue.shift() ?? text("Fallback answer."));
  const cleanup = registerFakeSearch(options.body);
  const parentSessionId = `parent-distill-async-${tag}`;
  const run = runSubAgentWithStats({
    agentName: AGENT,
    task: "Verify the IM73A135V01 microphone specs.",
    parentSessionId,
    workspacePath: tempDir,
  }).then((result) => {
    events.push("run_resolved");
    return result;
  });
  return { run, readFacts: () => readAllFacts(parentSessionId), cleanup };
}

describe("per-finding distillation runs off the tool loop's critical path", () => {
  afterAll(() => {
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    events.length = 0;
    recordedCalls.length = 0;
    auditEvents.length = 0;
    responseQueue.mockReset();
    distillGate = Promise.resolve("");
    distillAnswers = null;
    distillDelayMs = 0;
    secondWorkerCallStarted = () => {};
    resetConfigForTests();
    await resetSharedMemoryForTests();
  });

  it("counts the heuristic extract provisionally and settles the byte counter to the stored length", async () => {
    distillGate = Promise.resolve(DISTILLED);

    const probe = startProbe("bytes");
    try {
      await probe.run;
    } finally {
      probe.cleanup();
    }

    const rows = auditEvents.filter((e) => e.event === "sub_agent_tool_call" && e.payload["phase"] === "shared_finding_auto");
    expect(rows).toHaveLength(1);
    const row = rows[0]!.payload;
    // The heuristic extract of the 8-result page is far longer than the distilled line...
    expect(row["provisionalChars"]).toBeGreaterThan(DISTILLED.length * 3);
    expect(row["extractedChars"]).toBe(DISTILLED.length);
    // ...and the run's counter, provisionally the extract, settled to what was stored:
    // adjusted by (stored − extracted), negative here.
    expect(row["usefulEvidenceBytes"]).toBe(DISTILLED.length);
    expect(row["autoSharedFindingCount"]).toBe(1);
    expect(events.indexOf("fact_stored")).toBeLessThan(events.indexOf("run_resolved"));
  });

  it("an irrelevant distillation (NONE) stores nothing and gives back the bytes it provisionally counted", async () => {
    // TWO searches with different bodies (different dedup keys, so both are real findings):
    // the first distills to NONE, the second to a fact. Both extracts — ~600 chars each —
    // are counted PROVISIONALLY as their tool results are seen, and only then do the
    // distillations settle. If the NONE settle did not subtract its provisional charge, the
    // surviving finding's row would carry both extracts; the assertion below is that the
    // counter is the distilled length ALONE.
    distillAnswers = ["NONE", DISTILLED];

    const probe = startProbe("none", {
      responses: [
        toolCall("s1", "web_search", { query: "off topic" }),
        toolCall("s2", "web_search", { query: "IM73A135V01 datasheet" }),
        text("Final answer written from the search results."),
      ],
      body: (query) => searchResultFor(query === "off topic" ? "unrelated cookie banner" : "IM73A135V01 datasheet"),
    });
    let facts: Record<string, string>;
    try {
      await probe.run;
      facts = await probe.readFacts();
    } finally {
      probe.cleanup();
    }

    // Both findings reached the distiller; only the second one was stored.
    expect(events.filter((e) => e === "distill_resolved")).toHaveLength(2);
    expect(events.filter((e) => e === "fact_stored")).toHaveLength(1);
    expect(Object.keys(facts).filter((key) => key.startsWith("auto_"))).toHaveLength(1);

    const rows = auditEvents.filter((e) => e.payload["phase"] === "shared_finding_auto");
    expect(rows).toHaveLength(1);
    const row = rows[0]!.payload;
    // The provisional charge for THIS finding alone is already several hundred chars...
    expect(row["provisionalChars"]).toBeGreaterThan(DISTILLED.length * 3);
    expect(row["extractedChars"]).toBe(DISTILLED.length);
    // ...so a retained NONE charge would show up here as roughly twice that. The counter
    // is the stored text and nothing else: the NONE settle gave its bytes back.
    expect(row["usefulEvidenceBytes"]).toBe(DISTILLED.length);
    expect(row["autoSharedFindingCount"]).toBe(1);
  });

  it("the soft-deadline synthesis joins pending distills BEFORE it arms its own budget timer", async () => {
    // The synthesis window is a promise — "keep enough time left to write the answer". Its
    // first statement used to be readCuratedFindingsForSynthesis, which opens with
    // joinPendingShares(), so a distillation still in flight (measured 1.4-7.4 s per finding,
    // bounded only by DISTILL_CALL_DEADLINE_MS = 60 s) was charged to the window: at
    // turnTimeoutMs 60 s the reserve is 30 s, and a 7.4 s distill starting just before the
    // deadline ate a quarter of it before the inference could start.
    //
    // Reaching the gate: it needs turnTimeoutMs >= 60 s and elapsed past the reserve. Date.now
    // is advanced by the tool itself; the real setTimeout deadlines never fire.
    distillAnswers = [DISTILLED];
    distillDelayMs = 150;   // still pending when the soft deadline is crossed

    const realNow = Date.now.bind(Date);
    let clockOffset = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
    const realSetTimeout = globalThis.setTimeout;
    const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: Parameters<typeof setTimeout>[0],
      ms?: number,
      ...rest: unknown[]
    ) => {
      // reservedSynthesisMs = min(0.6 x 60 s, max(30 s, 1.25 x slowest call)) = 30 s here.
      if (ms === 30_000) events.push("synth_timer_armed");
      return (realSetTimeout as (...a: unknown[]) => unknown)(fn, ms, ...rest);
    }) as never);

    try {
      const probe = startProbe("softdeadline", {
        turnTimeoutMs: 60_000,
        body: (query) => {
          clockOffset = 40_000;
          return searchResultFor(query);
        },
      });
      try {
        await probe.run;
      } finally {
        probe.cleanup();
      }
    } finally {
      timerSpy.mockRestore();
      nowSpy.mockRestore();
    }

    // The gate really fired.
    expect(auditEvents.filter((e) => e.event === "sub_agent_soft_deadline")).toHaveLength(1);
    const at = (name: string) => events.indexOf(name);
    expect(at("synth_timer_armed")).toBeGreaterThanOrEqual(0);
    // The distillation was still running when the pass began...
    expect(at("distill_call_started")).toBeLessThan(at("synth_timer_armed"));
    // ...and it was joined BEFORE the clock the window is measured on started.
    expect(at("distill_resolved")).toBeLessThan(at("synth_timer_armed"));
    expect(at("fact_stored")).toBeLessThan(at("synth_timer_armed"));
  });

  it("the end-of-iteration sufficiency ladder latches on SETTLED bytes, not on provisional extracts", async () => {
    // Seven searches in ONE iteration. Each provisional extract runs to its ~602-char cap and
    // is added the moment its tool result is seen, so the counter reads ~4,214 — past
    // SUFFICIENT_EVIDENCE_NUDGE_BYTES (4,000) — before a single distillation has settled.
    // Five of the seven are irrelevant, so the run actually holds 180 chars of stored
    // knowledge. `sufficiencySynthesisNudged` never un-fires, and three ignored iterations
    // later NUDGE_IGNORED_STRIP_ITERATIONS hard-strips the gather tools — so latching it on
    // the provisional number ends a run that has almost no evidence.
    distillAnswers = ["NONE", "NONE", "NONE", "NONE", "NONE", DISTILLED, DISTILLED];
    // Still in flight when the ladder is reached — an instantly-resolving distill would settle
    // in the microtasks between the tool loop and the ladder and the bug could not appear.
    distillDelayMs = 40;
    const topics = Array.from({ length: 7 }, (_, i) => `distinct topic number ${i + 1}`);

    const probe = startProbe("ladder", {
      responses: [
        {
          content: "",
          tool_calls: topics.map((topic, i) => ({ id: `s${i}`, name: "web_search", arguments: { query: topic } })),
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "tool_calls",
        },
        text("Final answer written from the search results."),
      ],
      body: (query) => searchResultFor(query),
    });
    try {
      await probe.run;
    } finally {
      probe.cleanup();
    }

    const rows = auditEvents.filter((e) => e.payload["phase"] === "shared_finding_auto");
    expect(rows).toHaveLength(2);
    // Each finding was charged ~602 provisionally, and 7 x 602 is over the 4,000 threshold...
    expect(Number(rows[0]!.payload["provisionalChars"])).toBeGreaterThanOrEqual(600);
    // ...while what actually settled is the two distilled lines and nothing else.
    expect(rows[1]!.payload["usefulEvidenceBytes"]).toBe(DISTILLED.length * 2);
    // So the ladder saw 180, not 4,214, and no rung fired.
    const forcedReasons = auditEvents
      .filter((e) => e.event === "sub_agent_synthesis_forced")
      .map((e) => e.payload["reason"]);
    expect(forcedReasons).not.toContain("sufficient_evidence");
    expect(forcedReasons).not.toContain("sufficient_evidence_tools_stripped");
  });

  it("starts the next model call before the distillation resolves, and logs its completion row only after the fact is stored", async () => {
    let releaseDistill: (answer: string) => void = () => {};
    distillGate = new Promise<string>((resolve) => { releaseDistill = resolve; });
    const secondCall = new Promise<void>((resolve) => { secondWorkerCallStarted = resolve; });

    const probe = startProbe("order");
    try {
      // With the distillation awaited inline, the second worker call does not come while the
      // gate is closed — the 1.5 s fallback lets the test proceed and the assertions below
      // are what fail (verified by restoring the await), not the test's own clock.
      await Promise.race([secondCall, sleep(1_500)]);
      expect(events).toContain("tool_result_pushed");
      expect(events).toContain("distill_call_started");
      expect(events).not.toContain("distill_resolved");

      // The run has computed its final answer and is now blocked on the join, which sits in
      // FRONT of the completion row: neither the row nor the result has appeared.
      const settled = await Promise.race([probe.run.then(() => "resolved"), sleep(1_000).then(() => "pending")]);
      expect(settled).toBe("pending");
      expect(auditEvents.some((e) => e.event === "sub_agent_completed")).toBe(false);
      expect(await probe.readFacts()).toEqual({});

      releaseDistill(DISTILLED);
      await probe.run;
    } finally {
      probe.cleanup();
    }

    const at = (name: string) => events.indexOf(name);
    expect(at("tool_result_pushed")).toBeGreaterThanOrEqual(0);
    expect(at("next_model_call_started")).toBeGreaterThan(at("tool_result_pushed"));
    // The mechanism: the loop moved on to its next model call while the distill was pending.
    expect(at("next_model_call_started")).toBeLessThan(at("distill_resolved"));
    // The join at the choke point: the fact was in shared memory before the result came back.
    expect(at("fact_stored")).toBeGreaterThan(at("distill_resolved"));
    expect(at("run_resolved")).toBeGreaterThan(at("fact_stored"));

    // ONE AUDIT ORDERING FOR EVERY TERMINAL PATH. The max-iterations path already joined
    // before its completion row; this is the final-answer path, where the join used to
    // happen in the run's `finally` — so shared_finding_auto landed AFTER sub_agent_completed
    // and any per-run analysis windowing rows up to the completion row dropped it.
    expect(at("completion_row")).toBeGreaterThan(at("fact_stored"));
    expect(at("run_resolved")).toBeGreaterThan(at("completion_row"));
    const auditOrder = auditEvents.map((e) =>
      e.event === "sub_agent_tool_call" ? String(e.payload["phase"]) : e.event);
    expect(auditOrder).toContain("shared_finding_auto");
    expect(auditOrder.indexOf("shared_finding_auto")).toBeLessThan(auditOrder.indexOf("sub_agent_completed"));

    const facts = await probe.readFacts();
    const stored = Object.entries(facts).find(([key]) => key.startsWith(`auto_${AGENT}_web_search_`));
    expect(stored).toBeDefined();
    expect(stored![1]).toContain(DISTILLED);
    // The distill call reached the provider without tools and exactly once.
    expect(recordedCalls.filter((c) => isDistillPrompt(c.messages))).toHaveLength(1);
    expect(recordedCalls.find((c) => isDistillPrompt(c.messages))!.toolNames).toEqual([]);
  });
});
