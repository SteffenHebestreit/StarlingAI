import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * THE COVERAGE CHECK LEAVES A COMPUTED AGGREGATE ALONE (E2E 2026-10-09, session 820e1171).
 *
 * The researcher read the stock table and reported 596 for Südtal over an 18-row listing. The
 * orchestrator's reply stated 596, which is short by construction next to 18 rows, so
 * enforceDelegateCoverage asked to rewrite it "for all 18 items", and the rewrite added four
 * invented rows and a total of 740. A delegation that computed its figure with web_table now
 * carries the figure's key (computedAggregateKeys), and a reply that states that figure is not
 * re-synthesized. A reply stating another total, and a delegation without the keys, still are.
 */

const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn(async () => ({
  content: "COVERAGE REWRITE with every row",
  tool_calls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
})));
const logAuditMock = vi.hoisted(() => vi.fn());
type DelegationResult = { success: boolean; output: string; metadata: Record<string, unknown> };
const delegation = vi.hoisted(() => ({ result: null as null | DelegationResult }));

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: (...args: unknown[]) => completeMock(...(args as [])),
    stream: (...args: unknown[]) => streamMock(...(args as [])),
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: () => null,
    createChatProvider: () => provider,
    tierModelDefaults: (tier: string) => (tier === "routing" ? { enableThinking: false, reasoningEffort: "none" } : {}),
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
vi.mock("../audit/logger.js", () => ({ logAudit: logAuditMock }));

vi.mock("../tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/registry.js")>();
  return {
    ...actual,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>, ctx: never, meta?: never) => {
      const stubbed = name === "delegate_to_agent" ? delegation.result : null;
      return stubbed ?? actual.executeTool(name, args, ctx, meta);
    }),
  };
});

const SUEDTAL = [17, 9, 1, 38, 22, 0, 11, 30, 5, 0, 4, 2, 95, 180, 36, 44, 29, 73];
const LISTING = SUEDTAL.map((value, index) => `- NW-${1101 + index}: ${value} Stück`).join("\n");
const RESEARCHER_ANSWER = `Lagerbestand am Standort Südtal je Artikel (lager.html, Tabelle "lagerbestand"):\n${LISTING}\n\nGesamtbestand Südtal: 596 Stück, mit web_table über alle 18 Zeilen berechnet.`;

function researcherResult(metadata: Record<string, unknown> = {}): DelegationResult {
  return {
    success: true,
    output: `[researcher]: ${RESEARCHER_ANSWER}`,
    metadata: {
      agentName: "researcher",
      taskId: "task_1",
      attemptedAgents: ["researcher"],
      delegationSucceeded: true,
      delegationOutcome: "success",
      delegationVerdict: "heuristic",
      terminalState: "completed",
      ...metadata,
    },
  };
}

function toolCallStream(id: string, name: string, args: Record<string, unknown>) {
  return (async function* () {
    yield { type: "tool_call_start", toolCallId: id, toolName: name };
    yield { type: "tool_call_delta", toolCallId: id, argumentsDelta: JSON.stringify(args) };
    yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

function answerStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

const tempDirs: string[] = [];

async function runTurn(result: DelegationResult, reply: string) {
  delegation.result = result;
  const configDir = mkdtempSync(join(tmpdir(), "sai-coverage-aggregate-"));
  const workspacePath = mkdtempSync(join(tmpdir(), "sai-coverage-aggregate-ws-"));
  tempDirs.push(configDir, workspacePath);
  writeFileSync(join(configDir, "starlingai.json"), JSON.stringify({ agents: { mainAssistant: { toolMode: "orchestration_only" } } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(configDir, "starlingai.json");
  vi.resetModules();
  const [{ AgentSession }, runtime] = await Promise.all([import("../agent/session.js"), import("../agent/runtime.js")]);
  let call = 0;
  streamMock.mockImplementation(() => {
    call += 1;
    return call === 1
      ? toolCallStream("call_researcher", "delegate_to_agent", { agentName: "researcher", task: "Gesamtbestand Südtal aus lager.html" })
      : answerStream(reply);
  });
  const session = new AgentSession({ channel: "test", workspacePath, systemPrompt: "You are a test agent." });
  const turn = await runtime.runTurn({ session, userMessage: "Wie hoch ist der Gesamtbestand am Standort Südtal laut http://www.nordlicht-werkzeuge.test/lager.html?" });
  return turn;
}

const audited = (event: string) => logAuditMock.mock.calls.filter(([type]) => type === event).map(([, data]) => data as Record<string, unknown>);
const guardrailTypes = () => audited("guardrail_flagged").map((data) => data["type"]);

describe("the coverage check and an aggregate web_table computed", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    streamMock.mockReset();
    completeMock.mockClear();
    logAuditMock.mockReset();
    delegation.result = null;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const REPLY_596 = "Der Gesamtbestand am Standort Südtal beträgt 596 Stück (aus der Lagertabelle berechnet).";

  it("leaves a reply that states the computed figure as it is", async () => {
    const turn = await runTurn(researcherResult({ computedAggregateKeys: ["596"] }), REPLY_596);
    expect(audited("coverage_shortfall_resynthesis")).toEqual([]);
    expect(guardrailTypes()).toContain("coverage_shortfall_waived_computed_aggregate");
    expect(audited("guardrail_flagged").find((data) => data["type"] === "coverage_shortfall_waived_computed_aggregate")).toMatchObject({ evidenceItems: 18 });
    expect(turn.response).toContain("596 Stück");
    expect(turn.response).not.toContain("COVERAGE REWRITE");
  }, 60_000);

  it("re-synthesizes, as before, when the delegation carries no computed keys", async () => {
    await runTurn(researcherResult(), REPLY_596);
    expect(audited("coverage_shortfall_resynthesis")).toHaveLength(1);
    expect(guardrailTypes()).not.toContain("coverage_shortfall_waived_computed_aggregate");
  }, 60_000);

  it("re-synthesizes a reply that states another total than the one computed", async () => {
    await runTurn(researcherResult({ computedAggregateKeys: ["596"] }), "Der Gesamtbestand am Standort Südtal beträgt 604 Stück laut der Lagertabelle.");
    expect(audited("coverage_shortfall_resynthesis")).toHaveLength(1);
    expect(guardrailTypes()).not.toContain("coverage_shortfall_waived_computed_aggregate");
  }, 60_000);
});
