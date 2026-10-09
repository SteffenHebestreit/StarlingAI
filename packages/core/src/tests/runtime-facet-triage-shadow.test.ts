/**
 * Facet triage in SHADOW mode — it must observe, and change nothing.
 *
 * Shadow is the whole basis for trusting the later slices: if it altered the turn even
 * slightly, the agreement statistic it produces would be measuring a different system from
 * the one it claims to describe. So the test is an equivalence check — same turn, flag off
 * and flag shadow, same model calls, same tools, same answer — plus the row it must emit.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn());
/** Whether a routing tier is configured. False is the DEPLOYED shape: under a model preset
 *  getChatProviderForTier returns null for every tier, which is why the receptionist and the
 *  upfront judge recorded zero runs in production. */
const tierState = vi.hoisted(() => ({ available: false }));

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: (...args: unknown[]) => completeMock(...args),
    stream: (...args: unknown[]) => streamMock(...args),
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: () => (tierState.available ? provider : null),
    createChatProvider: () => provider,
    tierModelDefaults: () => ({ enableThinking: false, reasoningEffort: "none" }),
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
// NOT a hoisted vi.mock: loadRuntime() calls vi.resetModules() so each test gets its own
// config, and a hoisted mock does not apply inside the fresh registry — the runtime would
// use the REAL logger and every audit assertion would silently find nothing. vi.doMock,
// applied just before the dynamic import, is what reaches that registry.
const auditEvents: unknown[][] = [];

const tempConfigDirs: string[] = [];

const VERDICT = {
  mode: "GATHER",
  domain: ["research"],
  deliverable: "evidence",
  multi: false,
  parts: [],
  alone: true,
  source_sensitive: true,
  decision: "single_agent",
  missing: [],
  query_en: "",
  language: "en",
  confidence: 0.88,
};

async function loadRuntime(
  routingTriage: "off" | "shadow",
  opts: { routingTier?: boolean; presetFallback?: boolean } = {},
) {
  tierState.available = opts.routingTier ?? true;
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-triage-shadow-"));
  tempConfigDirs.push(tempDir);
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    agents: { mainAssistant: { toolMode: "orchestration_only" } },
    orchestration: {
      routingTriage,
      routingTierPresetFallback: opts.presetFallback ?? false,
      // The judge is what shadow compares against, so it must be on.
      upfrontSourceSensitiveClassifier: true,
      planFirst: false,
      discoveryPrefetch: false,
      qaDeliveryLoop: false,
      riskGatedQA: false,
      finalResponseQaGate: false,
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  vi.resetModules();
  auditEvents.length = 0;
  vi.doMock("../audit/logger.js", () => ({
    logAudit: (...args: unknown[]) => { auditEvents.push(args); },
  }));
  const [{ AgentSession, resetSessionsForTests }, { runTurn }] = await Promise.all([
    import("../agent/session.js"),
    import("../agent/runtime.js"),
  ]);
  return { AgentSession, resetSessionsForTests, runTurn };
}

/** The one `routing_triage_decided` row, or undefined. */
function triageRow(): Record<string, unknown> | undefined {
  const row = auditEvents.find((event) => event[0] === "routing_triage_decided");
  return row?.[1] as Record<string, unknown> | undefined;
}

function textStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

/** Every complete() call that carried the triage's JSON grammar. */
function triageCalls(): unknown[][] {
  return completeMock.mock.calls.filter((call) => {
    const options = call[3] as { responseFormat?: { name?: string } } | undefined;
    return options?.responseFormat?.name === "routing_triage";
  });
}

const QUESTION = "what does the current base rate look like";

afterEach(() => {
  streamMock.mockReset();
  completeMock.mockReset();
  delete process.env["SAI_CONFIG_PATH"];
  for (const dir of tempConfigDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("routingTriage: shadow", () => {
  it("issues exactly one triage call, thinking off and grammar-constrained, even with NO routing tier", async () => {
    // routingTier:false is the deployed Claude-preset shape. The call-site fallback is what
    // makes the lane reachable there at all; without it this test finds zero calls, which is
    // precisely the production state the audit recorded for the judge and the receptionist.
    const { AgentSession, resetSessionsForTests, runTurn } = await loadRuntime("shadow", { routingTier: false });
    resetSessionsForTests();
    completeMock.mockImplementation(async (_messages: unknown, _tools: unknown, _signal: unknown, options?: { responseFormat?: { name?: string } }) => ({
      content: options?.responseFormat?.name === "routing_triage" ? JSON.stringify(VERDICT) : "VERDICT: yes",
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));
    streamMock.mockImplementation(() => textStream("Here is the answer."));

    await runTurn({
      session: new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." }),
      userMessage: QUESTION,
    });

    const calls = triageCalls();
    expect(calls).toHaveLength(1);
    const options = calls[0]![3] as { controls: { enableThinking: boolean }; maxTokens: number };
    expect(options.controls.enableThinking).toBe(false);
    expect(options.maxTokens).toBeLessThanOrEqual(256);
    // No tools on a classification call.
    expect(calls[0]![1]).toEqual([]);
    // And the row says the judge could not be compared against, rather than implying agreement.
    const row = triageRow() as unknown as { judgeComparable: boolean; sourceSensitiveAgrees: boolean | null };
    expect(row.judgeComparable).toBe(false);
    expect(row.sourceSensitiveAgrees).toBeNull();
  });

  it("logs the verdict and whether it agrees with the judge it would replace", async () => {
    const { AgentSession, resetSessionsForTests, runTurn } = await loadRuntime("shadow");
    resetSessionsForTests();
    completeMock.mockImplementation(async (_messages: unknown, _tools: unknown, _signal: unknown, options?: { responseFormat?: { name?: string } }) => ({
      content: options?.responseFormat?.name === "routing_triage" ? JSON.stringify(VERDICT) : "VERDICT: yes",
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));
    streamMock.mockImplementation(() => textStream("Here is the answer."));

    await runTurn({
      session: new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." }),
      userMessage: QUESTION,
    });

    const data = triageRow() as unknown as {
      ok: boolean;
      mode: string;
      verdict: { mode: string; sourceSensitive: boolean };
      judgeComparable: boolean;
      judgeVerdict: boolean | null;
      sourceSensitiveAgrees: boolean | null;
    };
    expect(data).toBeDefined();
    expect(data.ok).toBe(true);
    expect(data.mode).toBe("shadow");
    expect(data.verdict.mode).toBe("GATHER");
    // Both said source-sensitive: the agreement the gate is computed from.
    expect(data.judgeComparable).toBe(true);
    expect(data.judgeVerdict).toBe(true);
    expect(data.sourceSensitiveAgrees).toBe(true);
  });

  it("records a disagreement rather than hiding it", async () => {
    const { AgentSession, resetSessionsForTests, runTurn } = await loadRuntime("shadow");
    resetSessionsForTests();
    completeMock.mockImplementation(async (_messages: unknown, _tools: unknown, _signal: unknown, options?: { responseFormat?: { name?: string } }) => ({
      // Triage says NOT source-sensitive; the judge says it is.
      content: options?.responseFormat?.name === "routing_triage"
        ? JSON.stringify({ ...VERDICT, source_sensitive: false })
        : "VERDICT: yes",
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));
    streamMock.mockImplementation(() => textStream("Here is the answer."));

    await runTurn({
      session: new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." }),
      userMessage: QUESTION,
    });

    expect((triageRow() as unknown as { sourceSensitiveAgrees: boolean | null }).sourceSensitiveAgrees).toBe(false);
  });

  it("excludes a judge that did not ANSWER, instead of scoring its fail-safe false as a verdict", async () => {
    // The judge's parse is fail-safe: a call that throws, or a reply with no yes/no token,
    // leaves the verdict at `false` — the same value as a genuine "not source-sensitive".
    // If eligibility alone decided comparability, a window of backend errors would show up
    // as the triage disagreeing, and the ">=95% agreement" gate would be measuring outages.
    const { AgentSession, resetSessionsForTests, runTurn } = await loadRuntime("shadow");
    resetSessionsForTests();
    completeMock.mockImplementation(async (_messages: unknown, _tools: unknown, _signal: unknown, options?: { responseFormat?: { name?: string } }) => ({
      // Triage answers cleanly and says source-sensitive; the judge replies with no verdict
      // token at all (an empty completion is what a reasoning burn returns on this backend).
      content: options?.responseFormat?.name === "routing_triage" ? JSON.stringify(VERDICT) : "",
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));
    streamMock.mockImplementation(() => textStream("Here is the answer."));

    await runTurn({
      session: new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." }),
      userMessage: QUESTION,
    });

    const data = triageRow() as unknown as {
      ok: boolean; judgeComparable: boolean; judgeStatus: string; judgeVerdict: boolean | null; sourceSensitiveAgrees: boolean | null;
    };
    expect(data.ok).toBe(true);
    expect(data.judgeComparable).toBe(false);
    expect(data.judgeStatus).toBe("no_answer");
    expect(data.judgeVerdict).toBeNull();
    expect(data.sourceSensitiveAgrees).toBeNull();
  });

  it("routingTierPresetFallback makes the JUDGE reachable too, so the gate has data", async () => {
    // The asymmetry this closes: the triage resolved its provider through the call-site
    // fallback while the judge still went through the tier resolver, which returns null
    // under any model preset. On a preset deployment every shadow row then read
    // judgeComparable:false — the agreement statistic the S4 gate is defined on had no
    // data at all, on exactly the deployment carrying the traffic.
    const { AgentSession, resetSessionsForTests, runTurn } = await loadRuntime("shadow", {
      routingTier: false, presetFallback: true,
    });
    resetSessionsForTests();
    completeMock.mockImplementation(async (_messages: unknown, _tools: unknown, _signal: unknown, options?: { responseFormat?: { name?: string } }) => ({
      content: options?.responseFormat?.name === "routing_triage" ? JSON.stringify(VERDICT) : "VERDICT: yes",
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));
    streamMock.mockImplementation(() => textStream("Here is the answer."));

    await runTurn({
      session: new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." }),
      userMessage: QUESTION,
    });

    const data = triageRow() as unknown as {
      judgeComparable: boolean; judgeStatus: string; sourceSensitiveAgrees: boolean | null;
    };
    expect(data.judgeComparable).toBe(true);
    expect(data.judgeStatus).toBe("answered");
    expect(data.sourceSensitiveAgrees).toBe(true);
  });

  it("DISCRIMINANCE: with the fallback OFF and no tier, the judge stays unreachable", async () => {
    // Same configuration minus the flag. If this also reported a comparable judge, the
    // test above would be measuring the mock rather than the fallback.
    const { AgentSession, resetSessionsForTests, runTurn } = await loadRuntime("shadow", {
      routingTier: false, presetFallback: false,
    });
    resetSessionsForTests();
    completeMock.mockImplementation(async (_messages: unknown, _tools: unknown, _signal: unknown, options?: { responseFormat?: { name?: string } }) => ({
      content: options?.responseFormat?.name === "routing_triage" ? JSON.stringify(VERDICT) : "VERDICT: yes",
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));
    streamMock.mockImplementation(() => textStream("Here is the answer."));

    await runTurn({
      session: new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." }),
      userMessage: QUESTION,
    });

    const data = triageRow() as unknown as { judgeComparable: boolean; judgeStatus: string };
    expect(data.judgeComparable).toBe(false);
    expect(data.judgeStatus).toBe("not_started");
  });

  it("skips the classification entirely on a workflow step, which is already routed", async () => {
    // A scene step's agent set, task and deliverable were decided when the workflow was
    // authored. A four-step job would otherwise pay four extra routing-tier calls.
    const { AgentSession, resetSessionsForTests, runTurn } = await loadRuntime("shadow");
    resetSessionsForTests();
    completeMock.mockImplementation(async (_messages: unknown, _tools: unknown, _signal: unknown, options?: { responseFormat?: { name?: string } }) => ({
      content: options?.responseFormat?.name === "routing_triage" ? JSON.stringify(VERDICT) : "VERDICT: yes",
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));
    streamMock.mockImplementation(() => textStream("Here is the answer."));

    await runTurn({
      session: new AgentSession({ channel: "scene", workspacePath: "/workspace", systemPrompt: "You are a test agent." }),
      userMessage: QUESTION,
    });

    expect(triageCalls()).toHaveLength(0);
    expect(triageRow()).toBeUndefined();
  });

  it("records a failed call as a failure, never as a neutral verdict", async () => {
    const { AgentSession, resetSessionsForTests, runTurn } = await loadRuntime("shadow");
    resetSessionsForTests();
    completeMock.mockImplementation(async (_messages: unknown, _tools: unknown, _signal: unknown, options?: { responseFormat?: { name?: string } }) => ({
      content: options?.responseFormat?.name === "routing_triage" ? "I'd say this is a research question." : "VERDICT: no",
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));
    streamMock.mockImplementation(() => textStream("Here is the answer."));

    await runTurn({
      session: new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." }),
      userMessage: QUESTION,
    });

    const data = triageRow() as unknown as { ok: boolean; verdict: unknown; failureReason: string; sourceSensitiveAgrees: boolean | null };
    expect(data.ok).toBe(false);
    expect(data.verdict).toBeNull();
    expect(data.failureReason).toBe("parse_failed");
    // A failed call contributes nothing to the agreement statistic.
    expect(data.sourceSensitiveAgrees).toBeNull();
  });

  it("changes nothing about the turn: same model calls, same tools, same answer", async () => {
    // The equivalence that makes shadow data trustworthy.
    async function runOnce(mode: "off" | "shadow") {
      const { AgentSession, resetSessionsForTests, runTurn } = await loadRuntime(mode);
      resetSessionsForTests();
      completeMock.mockImplementation(async (_messages: unknown, _tools: unknown, _signal: unknown, options?: { responseFormat?: { name?: string } }) => ({
        content: options?.responseFormat?.name === "routing_triage" ? JSON.stringify(VERDICT) : "VERDICT: yes",
        tool_calls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: "stop",
      }));
      streamMock.mockImplementation(() => textStream("Here is the answer."));
      const result = await runTurn({
        session: new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." }),
        userMessage: QUESTION,
      });
      const snapshot = {
        response: result.response,
        streamCalls: streamMock.mock.calls.length,
        toolNames: streamMock.mock.calls.map((call) => ((call[1] ?? []) as Array<{ name: string }>).map((tool) => tool.name)),
        triageCallCount: triageCalls().length,
      };
      streamMock.mockReset();
      completeMock.mockReset();
      return snapshot;
    }

    const off = await runOnce("off");
    const shadow = await runOnce("shadow");

    expect(shadow.response).toBe(off.response);
    expect(shadow.streamCalls).toBe(off.streamCalls);
    expect(shadow.toolNames).toEqual(off.toolNames);
    // The ONLY difference is the extra classification call.
    expect(off.triageCallCount).toBe(0);
    expect(shadow.triageCallCount).toBe(1);
  });
});
