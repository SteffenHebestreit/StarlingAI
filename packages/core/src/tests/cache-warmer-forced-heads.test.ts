import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMMessage, LLMToolDef } from "../providers/lmstudio.js";

/**
 * THE WARM-KEEPER WARMS THE HEADS A FORCED TURN ACTUALLY SENDS (agents.performance.promptCacheWarmForcedHeads).
 *
 * c297c5ea's first two forced orchestrator calls were both cold — 12.8 s and 12.7 s to first
 * token, cacheN 0 — although the warm-keeper had warmed the orchestrator head seconds before: a
 * forced iteration sends a SUBSET of the tool block, and the subset itself flips once the plan is
 * recorded (record_plan offered while none exists, execute_plan once one does). Live probe E7
 * prices a switch to a cold subset at 8.3 s, 0% reused.
 *
 * T1 drives real turns through runtime.ts (the forced-tool-call-controls harness: a routing tier
 * that says "VERDICT: yes", turn-plan mocked for the plan state), captures every FORCED
 * provider.stream call, then boots the warm-keeper against the same config and captures its
 * complete() calls. Every forced call must have a warm call whose tool array is the same JSON and
 * whose folded system text is a prefix of the forced call's — covering lean base + module on a
 * module turn. The matcher is also run on the warm sets the plan's corrections ruled out (the
 * full head alone, the literal no-plan-argument subset, the subset without the module, the subset
 * reversed), and must reject each of them, so a green T1 cannot come from a matcher that accepts
 * anything.
 *
 * T2: a turn starting mid-queue aborts the head in flight and no further head is sent; with the
 * flag off only the full head goes out.
 */

const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn());
const auditMock = vi.hoisted(() => vi.fn());
const routingCompleteMock = vi.hoisted(() => vi.fn(async () => ({
  content: "VERDICT: yes",
  tool_calls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
})));

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: (...args: unknown[]) => completeMock(...(args as [])),
    stream: (...args: unknown[]) => streamMock(...(args as [])),
    embed: async () => [],
    isHealthy: () => true,
  };
  const routingProvider = { ...provider, complete: (...args: unknown[]) => routingCompleteMock(...(args as [])) };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: (tier: string) => (tier === "routing" ? routingProvider : null),
  };
});
vi.mock("../guardrails/rate-limiter.js", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("../guardrails/input.js", () => ({
  checkInput: vi.fn(() => ({ allowed: true, detectedPatterns: [] })),
  checkToolOutput: vi.fn(() => ({ allowed: true })),
}));
vi.mock("../guardrails/moderation.js", () => ({
  moderateInputText: vi.fn(async () => null),
  moderateToolResultText: vi.fn(async () => null),
}));
vi.mock("../guardrails/output.js", () => ({ scanOutput: vi.fn((text: string) => ({ safe: true, redacted: text })) }));
vi.mock("../audit/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../audit/logger.js")>()),
  logAudit: (...args: unknown[]) => auditMock(...args),
}));

const planState = vi.hoisted(() => ({ recorded: false }));
vi.mock("../agent/turn-plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/turn-plan.js")>();
  return {
    ...actual,
    loadTurnPlan: async (sessionId: string) => (planState.recorded
      ? {
          objective: "answer with researched data",
          steps: [{ id: "s1", description: "research", kind: "delegate" as const }],
          acceptanceCriteria: ["cites a source"],
          stopConditions: [],
          riskTier: "low" as const,
          wide: false,
          createdAt: new Date().toISOString(),
        }
      : actual.loadTurnPlan(sessionId)),
  };
});

/** An artifact request: looksLikeArtifactCreationRequest injects the orchestration module. */
const ARTIFACT_TURN = "Create a short presentation with sources about the price of a regional rail pass";
/** A plain question the routing tier calls source-sensitive. */
const SOURCE_TURN = "What does a regional rail pass cost right now?";

let dir: string | undefined;

function writeConfig(performance: Record<string, unknown>): string {
  dir = mkdtempSync(join(tmpdir(), "sai-warm-forced-"));
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    agents: {
      defaults: { model: { primary: "lmstudio/qwen" } },
      mainAssistant: { toolMode: "orchestration_only" },
      performance: { splitOrchestrationPrompt: true, promptCacheWarmKeeper: true, promptCacheWarmIdleMs: 1_000, ...performance },
    },
    orchestration: { upfrontSourceSensitiveClassifier: true, forceToolChoiceWhenOrchestrationRequired: true },
    subAgents: { probe_agent: { description: "Finds things.", systemPrompt: "You find things.", tools: ["read_file"] } },
    workspacePath: dir,
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  return dir;
}

/** A forced call burns (prose, no tool call); every later call answers, so the turn ends. */
function streamBurnThenAnswer(): void {
  streamMock.mockImplementation((_messages: unknown, _tools: unknown, _signal: unknown, options?: Record<string, unknown>) => (async function* () {
    if (options?.["toolChoice"] === "required") {
      yield { type: "text_delta", content: "x".repeat(400) };
      yield { type: "done", finishReason: "length", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      return;
    }
    yield { type: "text_delta", content: "done" };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })());
}

interface Captured { messages: LLMMessage[]; tools: LLMToolDef[] }

const wireTools = (tools: readonly LLMToolDef[]) => JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })));

interface ForcedCall extends Captured {
  label: string;
  moduleChars: number;
  baseChars: number;
  /** prompt_section_sizes' head hashes (M0): the folded head, and lean base + module without the date. */
  headSystemHash: string;
  baseModuleHash: string;
}

/** Run one turn per (plan state, message) and keep its FIRST forced provider.stream call. */
async function forcedCallsOfTurns(): Promise<ForcedCall[]> {
  const out: ForcedCall[] = [];
  for (const recorded of [false, true]) {
    for (const [label, message] of [["artifact", ARTIFACT_TURN], ["source", SOURCE_TURN]] as const) {
      planState.recorded = recorded;
      streamMock.mockReset();
      auditMock.mockReset();
      streamBurnThenAnswer();
      vi.resetModules();
      // The whole registry, as the gateway has it: without it record_plan and execute_plan are
      // not registered, and the plan-state subsets would be indistinguishable.
      await import("../tools/register-builtins.js");
      const [{ AgentSession }, { runTurn }] = await Promise.all([import("../agent/session.js"), import("../agent/runtime.js")]);
      const session = new AgentSession({ channel: "test", workspacePath: dir! });
      await runTurn({ session, userMessage: message });
      const forced = streamMock.mock.calls.find((args) => (args[3] as Record<string, unknown> | undefined)?.["toolChoice"] === "required");
      expect(forced, `${label}/planRecorded=${recorded}: the turn made no forced call`).toBeDefined();
      const sizes = auditMock.mock.calls.find((args) => args[0] === "prompt_section_sizes")?.[1] as Record<string, number | string> | undefined;
      out.push({
        label: `${label}/planRecorded=${recorded}`,
        messages: forced![0] as LLMMessage[],
        tools: forced![1] as LLMToolDef[],
        moduleChars: Number(sizes?.["orchestrationModule"] ?? 0),
        baseChars: Number(sizes?.["base"] ?? 0),
        headSystemHash: String(sizes?.["headSystemHash"] ?? ""),
        baseModuleHash: String(sizes?.["baseModuleHash"] ?? ""),
      });
    }
  }
  return out;
}

async function bootWarmer(): Promise<{ warm: Captured[]; warmer: typeof import("../agent/cache-warmer.js") }> {
  completeMock.mockReset();
  completeMock.mockImplementation(async () => ({ content: "ok", tool_calls: [], usage: { promptTokens: 0, completionTokens: 1, totalTokens: 1 }, finishReason: "stop" }));
  vi.resetModules();
  await import("../tools/register-builtins.js");
  const warmer = await import("../agent/cache-warmer.js");
  warmer.startCacheWarmer();
  for (let i = 0; i < 200 && completeMock.mock.calls.length < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 20));
  warmer.stopCacheWarmer();
  return { warm: completeMock.mock.calls.map((args) => ({ messages: args[0] as LLMMessage[], tools: args[1] as LLMToolDef[] })), warmer };
}

/**
 * The T1 matcher: which forced calls no warm call covers, and why. A warm call covers a forced
 * call when (i) the tool arrays are the same JSON in the same order, (ii) the warm call's folded
 * system text is a prefix of the forced call's, and (iii) on a module turn that prefix reaches
 * past lean base + module.
 */
async function uncovered(forced: readonly ForcedCall[], warm: readonly Captured[]): Promise<string[]> {
  const { normalizeMessagesForModel } = await import("../providers/lmstudio.js");
  const system = (messages: readonly LLMMessage[]) => String(normalizeMessagesForModel(messages, "qwen")[0]?.content ?? "");
  const misses: string[] = [];
  for (const call of forced) {
    const sent = system(call.messages);
    const sameTools = warm.filter((w) => wireTools(w.tools) === wireTools(call.tools));
    if (sameTools.length === 0) { misses.push(`${call.label}: (i) no warm call with this tool array`); continue; }
    const prefixed = sameTools.filter((w) => {
      const warmed = system(w.messages);
      return warmed.length > 0 && warmed.length < sent.length && sent.startsWith(warmed);
    });
    if (prefixed.length === 0) { misses.push(`${call.label}: (ii) no warm system text is a prefix of the sent one`); continue; }
    if (call.moduleChars > 0 && !prefixed.some((w) => system(w.messages).length >= call.baseChars + call.moduleChars)) {
      misses.push(`${call.label}: (iii) the warm prefix stops short of lean base + module`);
    }
  }
  return misses;
}

describe("the warm-keeper warms the forced heads a turn actually sends", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    completeMock.mockReset();
    auditMock.mockReset();
    routingCompleteMock.mockClear();
    planState.recorded = false;
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("T1: every forced call of a module turn, in both plan states, meets a warm call with its tools and a prefix of its head", async () => {
    writeConfig({ promptCacheWarmForcedHeads: true });
    const forced = await forcedCallsOfTurns();
    expect(forced).toHaveLength(4);
    const moduleTurns = forced.filter((c) => c.moduleChars > 0);
    // The fixture must exercise the module head in both plan states, or (iii) proves nothing...
    expect(moduleTurns.map((c) => c.label)).toEqual(["artifact/planRecorded=false", "artifact/planRecorded=true"]);
    // ...and the two plan states must be two different subsets (record_plan / execute_plan).
    expect(new Set(moduleTurns.map((c) => wireTools(c.tools))).size).toBe(2);

    const { warm } = await bootWarmer();
    expect(await uncovered(moduleTurns, warm)).toEqual([]);

    // A plain source question is forced WITHOUT the module (it names no artifact, and the upfront
    // judge's "yes" builds no intent guidance), so its head is lean base + date line on the same
    // subset. The subset IS warm — only the system text differs, reason (ii) — and that variant is
    // deliberately not warmed until the head hashes show how often real forced turns send it.
    const plain = forced.filter((c) => c.moduleChars === 0);
    expect(plain).toHaveLength(2);
    const plainMisses = await uncovered(plain, warm);
    expect(plainMisses).toHaveLength(2);
    expect(plainMisses.every((m) => m.includes("(ii)"))).toBe(true);

    // The full head still goes out, first: every turn that is not forced sends it.
    const { getToolsAsLLMDefs } = await import("../tools/registry.js");
    const { getMainAssistantToolNames } = await import("../agent/default-tools.js");
    expect(wireTools(warm[0]!.tools)).toBe(wireTools(getToolsAsLLMDefs(getMainAssistantToolNames())));
    expect(warm[0]!.messages.filter((m) => m.role === "system")).toHaveLength(1);
    // Ordered by expected benefit: full, then the record_plan head (the first forced call), then execute_plan.
    expect(warm.map((w) => w.tools.some((t) => t.name === "record_plan"))).toEqual([true, true, false]);
    expect(warm.map((w) => w.tools.some((t) => t.name === "execute_plan"))).toEqual([true, false, true]);
  }, 60_000);

  it("T1 discriminates: the warm sets the corrections ruled out each leave a forced call uncovered", async () => {
    writeConfig({ promptCacheWarmForcedHeads: true });
    const forced = (await forcedCallsOfTurns()).filter((c) => c.moduleChars > 0);
    const { warm } = await bootWarmer();
    const [full, planHead, dispatchHead] = warm;
    const { filterForcedOrchestrationTools } = await import("../agent/forced-orchestration-tools.js");
    // The control: the warm set as built covers them.
    expect(await uncovered(forced, warm)).toEqual([]);

    // (a) today's warmer: the full head alone.
    expect((await uncovered(forced, [full!])).length).toBeGreaterThan(0);
    // (b) the literal proposal, filterForcedOrchestrationTools(list) with no plan argument: that is
    // the execute_plan subset, so the planRecorded=false calls stay uncovered.
    const literal = { messages: planHead!.messages, tools: filterForcedOrchestrationTools(full!.tools) };
    const literalMisses = await uncovered(forced, [full!, literal]);
    expect(literalMisses.some((m) => m.includes("planRecorded=false"))).toBe(true);
    // (c) the subsets on the lean base without the module: a module turn's prefix falls short.
    const noModule = [planHead!, dispatchHead!].map((w) => ({ messages: [w.messages[0]!, w.messages[w.messages.length - 1]!], tools: w.tools }));
    expect((await uncovered(forced, [full!, ...noModule])).some((m) => m.includes("(iii)"))).toBe(true);
    // (d) the subsets in reverse order: a different tool array on the wire.
    const reversed = [planHead!, dispatchHead!].map((w) => ({ messages: w.messages, tools: [...w.tools].reverse() }));
    expect((await uncovered(forced, [full!, ...reversed])).some((m) => m.includes("(i)"))).toBe(true);
  }, 60_000);

  it("(e) documents the list_agents variant: a turn that suppresses it sends a subset no warm head covers", async () => {
    // suppressAgentCatalogTool drops list_agents on freshness/source/artifact turns unless the
    // user asked for the catalog. Whether those turns are forced often enough to earn their own
    // head is what toolsHash on the provider rows will count; until then it is NOT warmed.
    writeConfig({ promptCacheWarmForcedHeads: true });
    const forced = await forcedCallsOfTurns();
    const { warm } = await bootWarmer();
    // What these four turns sent. Measured when this was written: all four kept list_agents (the
    // upfront judge's "yes" sets no freshness/source/artifact guidance flag, and those flags are
    // what suppress it), which is also what c297c5ea's forced calls look like: toolCount 10 =
    // the nine forced orchestration tools with list_agents, plus record_plan.
    const withCatalog = forced.filter((c) => c.tools.some((t) => t.name === "list_agents")).length;
    console.info(`[forced heads] forced calls with list_agents: ${withCatalog} of ${forced.length}`);
    expect(warm.slice(1).every((w) => w.tools.some((t) => t.name === "list_agents"))).toBe(true);
    // The variant a guidance-flagged turn would send: the same subset minus list_agents. Not
    // warmed, and the matcher says so for the right reason — a different tool array.
    const suppressed = forced.filter((c) => c.moduleChars > 0).map((c) => ({ ...c, label: `${c.label}/no-list_agents`, tools: c.tools.filter((t) => t.name !== "list_agents") }));
    const misses = await uncovered(suppressed, warm);
    expect(misses).toHaveLength(2);
    expect(misses.every((m) => m.includes("(i)"))).toBe(true);
  }, 60_000);
});

describe("M0: prompt_section_sizes names the head the turn sent", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    auditMock.mockReset();
    routingCompleteMock.mockClear();
    planState.recorded = false;
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("headSystemHash is the folded head the provider sent; baseModuleHash names the variant, date line left out", async () => {
    writeConfig({});
    const forced = await forcedCallsOfTurns();
    const { normalizeMessagesForModel } = await import("../providers/lmstudio.js");
    const { hashText } = await import("../providers/prompt-head.js");
    for (const call of forced) {
      const sent = String(normalizeMessagesForModel(call.messages, "qwen")[0]?.content ?? "");
      // The same hash the provider row's systemHash carries for this call, so the two rows join.
      expect(call.headSystemHash, call.label).toBe(hashText(sent));
    }
    const moduleTurns = forced.filter((c) => c.moduleChars > 0);
    const plainTurns = forced.filter((c) => c.moduleChars === 0);
    // One variant per head shape, whatever the plan state: lean base + module, or lean base alone.
    expect(new Set(moduleTurns.map((c) => c.baseModuleHash)).size).toBe(1);
    expect(new Set(plainTurns.map((c) => c.baseModuleHash)).size).toBe(1);
    expect(moduleTurns[0]!.baseModuleHash).not.toBe(plainTurns[0]!.baseModuleHash);
  }, 60_000);

  it("headSystemHash still names what was sent when the session carries an earlier-conversation summary", async () => {
    // A long session's collapsed history OPENS with a system message (the rolling summary of the
    // trimmed-out turns), and the provider folds it into the head with the rest of the leading run.
    // Hashing the head alone then named a head no call ever sent, so the row could not be joined
    // with its turn's provider rows exactly on the sessions whose summary moves the cache key.
    writeConfig({});
    planState.recorded = false;
    streamMock.mockReset();
    auditMock.mockReset();
    streamBurnThenAnswer();
    vi.resetModules();
    await import("../tools/register-builtins.js");
    const [{ AgentSession }, { runTurn }, { normalizeMessagesForModel }, { hashText }] = await Promise.all([
      import("../agent/session.js"), import("../agent/runtime.js"), import("../providers/lmstudio.js"), import("../providers/prompt-head.js"),
    ]);
    const session = new AgentSession({ channel: "test", workspacePath: dir!, earlierSummary: "Summary of earlier turns: a synthetic note." });
    await runTurn({ session, userMessage: SOURCE_TURN });
    const first = streamMock.mock.calls[0];
    expect(first, "the turn made no main call").toBeDefined();
    const sent = String(normalizeMessagesForModel(first![0] as LLMMessage[], "qwen")[0]?.content ?? "");
    expect(sent).toContain("Summary of earlier turns");
    const sizes = auditMock.mock.calls.find((args) => args[0] === "prompt_section_sizes")?.[1] as Record<string, unknown> | undefined;
    expect(sizes?.["headSystemHash"]).toBe(hashText(sent));
  }, 60_000);
});

describe("the warm queue yields to a turn", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("T2: a turn starting mid-queue aborts the head in flight and no further head is sent", async () => {
    writeConfig({ promptCacheWarmForcedHeads: true });
    const signals: AbortSignal[] = [];
    let release: (() => void) | undefined;
    completeMock.mockReset();
    completeMock.mockImplementation((_messages: unknown, _tools: unknown, signal: AbortSignal) => {
      signals.push(signal);
      // Slow: resolves only when released, rejects when aborted — the way a real prefill ends.
      return new Promise((resolve, reject) => {
        release = () => resolve({ content: "ok", tool_calls: [], usage: { promptTokens: 0, completionTokens: 1, totalTokens: 1 }, finishReason: "stop" });
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    vi.resetModules();
    await import("../tools/register-builtins.js");
    const warmer = await import("../agent/cache-warmer.js");
    warmer.startCacheWarmer();
    for (let i = 0; i < 100 && signals.length < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    // First head done, second in flight.
    release!();
    for (let i = 0; i < 100 && signals.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(signals).toHaveLength(2);

    warmer.markOrchestratorActivity();
    expect(signals[1]!.aborted, "the head in flight was not aborted").toBe(true);
    // The turn ends at once; the stale queue must still not send its third head.
    warmer.markOrchestratorIdle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(completeMock).toHaveBeenCalledTimes(2);
    warmer.stopCacheWarmer();
  }, 30_000);

  it("sends one output token, thinking off, and only the full head with the flag off", async () => {
    writeConfig({});
    const { warm, warmer } = await bootWarmer();
    expect(warm).toHaveLength(1);
    expect(completeMock.mock.calls[0]![3]).toEqual({ maxTokens: 1, controls: { enableThinking: false, reasoningEffort: "none" } });
    // The latency probe (E9) builds the forced heads with the flag off: that is what decides the flag.
    expect(warmer.collectWarmHeads().map((h) => h.label)).toEqual(["full"]);
    expect(warmer.collectWarmHeads({ forcedHeads: true }).map((h) => h.label)).toEqual(["full", "forced_plan", "forced_dispatch"]);
  }, 30_000);

  it("leaves thinking controls out where the off-switch is head text (gpt-oss), keeping the one-token ceiling", async () => {
    dir = mkdtempSync(join(tmpdir(), "sai-warm-forced-"));
    writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
      agents: { defaults: { model: { primary: "lmstudio/openai/gpt-oss-20b" } }, mainAssistant: { toolMode: "orchestration_only" }, performance: { promptCacheWarmKeeper: true } },
      subAgents: {},
      workspacePath: dir,
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
    vi.resetModules();
    const warmer = await import("../agent/cache-warmer.js");
    expect(warmer.warmCallOptions()).toEqual({ maxTokens: 1 });
  });
});
