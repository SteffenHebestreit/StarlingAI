/**
 * An --auto turn the discovery prefetch routed to a deliverable-emitting agent is forced to call a
 * tool first, whatever language it is written in, when the intent readout reads the request as work.
 *
 * orchestration.autonomousModeAntiRefusal forces the first tool call of an --auto artifact build,
 * and it used to learn that a turn was one only from the deliverable-intent word lists. "Zeichne den
 * folgenden Bestellablauf als Mermaid-Flussdiagramm" matched none of their verbs or nouns, so the
 * turn went unforced and the model drew the diagram inline, although the capsule it had been given
 * named diagram_designer [high] (E2E core-build-artifact-mermaid). The routing the prefetch already
 * ran is read back: a top agent admitted at high confidence that holds a deliverable-emitting tool.
 *
 * That routing reads the agent's tools, not the request, so a question routed to such an agent
 * ("Explain how a Gantt chart works") would be forced as well. Such a turn asks the intent readout
 * (both option orders) what the request asks the assistant to do, and only PRODUCE, ACT or
 * ORCHESTRATE arm the forced call. Without a reading (an error, a timeout, a Claude routing tier)
 * the turn is not forced. Nothing else changes, and no other turn asks the readout: a
 * medium-confidence top agent, a top agent that only writes files, a late prefetch, no prefetch, no
 * --auto, the flag off, a request the word lists already see, or a workflow step.
 *
 * A medium-confidence top agent comes only from the lexical routing used without an embedding
 * model. With one, every agent the prefetch admits is high, so the top agent's tools are the whole
 * routing condition; discovery-prefetch-semantic-arming.test.ts runs that path with real routing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const streamMock = vi.hoisted(() => vi.fn());
/** The intent readout, stubbed: what each test's request reads as. */
const readoutMock = vi.hoisted(() => vi.fn());
/** The request context each readout call ran under. */
const readoutCallSites = vi.hoisted(() => [] as Array<{ callSite?: string; agentName?: string }>);
const auditMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn(async () => ({
  content: "synthesized",
  tool_calls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
})));

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: (...args: Parameters<typeof completeMock>) => completeMock(...args),
    stream: (...args: unknown[]) => streamMock(...args),
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    getActiveModelPreset: () => undefined,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    // No routing tier: the receptionist and the up-front source judge both decline, so the only
    // thing that can force this turn's first call is the --auto artifact build under test.
    getChatProviderForTier: () => null,
    createChatProvider: () => provider,
    tierModelDefaults: () => ({}),
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
vi.mock("../audit/logger.js", () => ({
  logAudit: (...args: unknown[]) => auditMock(...args),
  subscribeToAudit: () => () => {},
}));

/** Questions about a chart the word lists see no request in; the routing would put a chart agent first. */
const QUESTIONS = [
  "Explain how a Gantt chart works",
  "Explique-moi comment fonctionne un diagramme de Gantt.",
];
const MERMAID_REQUEST = "Zeichne den folgenden Bestellablauf als Mermaid-Flussdiagramm: Bestellung geht ein → "
  + "Zahlung prüfen → wenn bezahlt: Ware kommissionieren → Versand → Zustellung; wenn nicht bezahlt: "
  + "Zahlungserinnerung senden → nach 14 Tagen ohne Zahlung: Bestellung stornieren.";
const SMALL_TALK = "how was your weekend?";
const WEBSITE_REQUEST = "build me a website about local bird species";

/** Agents as the shipped roster declares their tools (workspace/agents). */
const SUB_AGENTS = {
  diagram_designer: {
    description: "Draws diagrams.",
    systemPrompt: "Draw.",
    tools: ["read_file", "generate_mermaid_diagram", "generate_document", "write_file", "edit_file"],
  },
  chart_designer: {
    description: "Plots charts.",
    systemPrompt: "Chart.",
    tools: ["read_file", "generate_chart_html", "generate_document", "write_file", "edit_file"],
  },
  // Holds write_file and edit_file, as 40 of the 48 configured agents do, and emits nothing.
  summarizer: { description: "Summarizes.", systemPrompt: "Summarize.", tools: ["read_file", "write_file", "edit_file"] },
  mail_agent: { description: "Reads mail.", systemPrompt: "Mail.", tools: ["mail_search", "mail_read"] },
};

type CapsuleAgent = { name: string; confidence?: string };
interface CapsuleStub {
  agents: CapsuleAgent[];
  delayMs?: number;
}

const tempDirs: string[] = [];
const prefetchCalls = { count: 0 };

async function load(opts: {
  capsule?: CapsuleStub;
  antiRefusal?: boolean;
  discoveryPrefetch?: boolean;
  promoted?: Record<string, unknown>;
  /** The routing tier's model id (agents.defaults.model.tiers.routing). */
  routingTier?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), "sai-auto-artifact-prefetch-"));
  tempDirs.push(dir);
  const workspacePath = join(dir, "workspace");
  mkdirSync(join(workspacePath, ".starlingai"), { recursive: true });
  if (opts.promoted) {
    writeFileSync(join(workspacePath, ".starlingai", "promoted_agents.json"), JSON.stringify(opts.promoted), "utf8");
  }
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath,
    agents: {
      mainAssistant: { toolMode: "orchestration_only" },
      ...(opts.routingTier ? { defaults: { model: { tiers: { routing: opts.routingTier } } } } : {}),
    },
    subAgents: SUB_AGENTS,
    orchestration: {
      autonomousModeAntiRefusal: opts.antiRefusal ?? true,
      forceToolChoiceWhenOrchestrationRequired: true,
      discoveryPrefetch: opts.discoveryPrefetch ?? true,
      planFirst: false,
      qaDeliveryLoop: false,
      riskGatedQA: false,
      finalResponseQaGate: false,
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  prefetchCalls.count = 0;
  const capsule = opts.capsule ?? { agents: [] };
  // A plain factory, as the other runtime tests stub this module: importing the original from
  // inside the factory waits on the runtime's own import cycle and never settles.
  vi.doMock("../agent/discovery-prefetch.js", () => ({
    formatDiscoveryCapsule: () => "",
    prefetchCapabilityCandidates: async (
      _query: string,
      prefetchOpts?: { onAgents?: (names: readonly string[], agents: readonly CapsuleAgent[]) => void },
    ) => {
      prefetchCalls.count += 1;
      if (capsule.delayMs) await new Promise((resolve) => setTimeout(resolve, capsule.delayMs));
      prefetchOpts?.onAgents?.(capsule.agents.map((agent) => agent.name), capsule.agents);
      if (capsule.agents.length === 0) return "";
      return `[CAPABILITY CANDIDATES — discovered up-front for this turn]\n${capsule.agents
        .map((agent) => `- ${agent.name}${agent.confidence ? ` [${agent.confidence}]` : ""}`).join("\n")}`;
    },
  }));
  // Only askIntentReadout is stubbed; INTENT_FACETS and the rest stay real. The request context is
  // read from the same module instance the turn uses, so the attribution the call ran under is seen.
  vi.doMock("../decisions/intent-readout.js", async (importOriginal) => {
    const { currentRequestContext } = await import("../runtime/request-context.js");
    return {
      ...(await importOriginal<typeof import("../decisions/intent-readout.js")>()),
      askIntentReadout: (...args: unknown[]) => {
        const context = currentRequestContext();
        readoutCallSites.push({
          ...(context?.callSite ? { callSite: context.callSite } : {}),
          ...(context?.agentName ? { agentName: context.agentName } : {}),
        });
        return readoutMock(...args);
      },
    };
  });
  const [{ AgentSession, resetSessionsForTests }, { runTurn }, turnSetup, deliverableIntent] = await Promise.all([
    import("../agent/session.js"),
    import("../agent/runtime.js"),
    import("../agent/turn-setup.js"),
    import("../agent/deliverable-intent.js"),
    // The real prefetch module is what imports this one, and importing it registers
    // delegate_to_agent and the other orchestration tools. Stubbed out, the turn would be offered
    // only the memory tools, and no orchestration tool would be left to force.
    import("../tools/sub-agent.js"),
  ]);
  resetSessionsForTests();
  return { AgentSession, runTurn, workspacePath, turnSetup, deliverableIntent };
}

function textStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

/** The options the turn's first orchestrator call was sent with; undefined when nothing was forced. */
async function firstCallOptions(
  loaded: Awaited<ReturnType<typeof load>>,
  userMessage: string,
  autoApprove: boolean,
  channel = "test",
): Promise<{ toolChoice?: unknown } | undefined> {
  streamMock.mockImplementation(() => textStream("Hier ist das Diagramm."));
  const session = new loaded.AgentSession({ channel, workspacePath: loaded.workspacePath, systemPrompt: "You are a test agent." });
  await loaded.runTurn({ session, userMessage, ...(autoApprove ? { autoApprove: true } : {}) });
  expect(streamMock.mock.calls.length).toBeGreaterThan(0);
  // The call could have been forced: an orchestration tool was on offer. Without this, a turn
  // offered none would pass every "not forced" case below for the wrong reason.
  const offered = ((streamMock.mock.calls[0]?.[1] ?? []) as Array<{ name: string }>).map((tool) => tool.name);
  expect(offered).toContain("delegate_to_agent");
  return streamMock.mock.calls[0]?.[3] as { toolChoice?: unknown } | undefined;
}

/** A both-orders readout whose mode facet reads `choice`, the two orders agreeing. */
function modeReading(choice: string) {
  return {
    ok: true as const,
    readout: {
      version: "test",
      facets: {
        mode: {
          choice,
          top: 0.91234,
          runnerUp: choice === "PRODUCE" ? "GATHER" : "PRODUCE",
          margin: 0.83456,
          probabilities: {},
          logScores: {},
          mass: 1,
          temperature: 1,
          orders: { served: choice, reversed: choice, agreed: true },
        },
      },
      misses: {},
      queryEn: "a restatement that must not reach the audit row",
      language: "en",
      tokens: 20,
      ms: 840,
    },
  };
}

/** The audit rows the produce-intent read logged. */
function modeReadRows(): Array<Record<string, unknown>> {
  return auditMock.mock.calls
    .filter(([event, data]) => event === "guardrail_flagged" && (data as { type?: string })?.type === "auto_artifact_build_mode_read")
    .map(([, data]) => data as Record<string, unknown>);
}

/** The system text of the turn's first orchestrator call. */
function firstPromptText(): string {
  return ((streamMock.mock.calls[0]?.[0] ?? []) as Array<{ content?: unknown }>)
    .map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
}

afterEach(async () => {
  streamMock.mockReset();
  completeMock.mockClear();
  readoutMock.mockReset();
  readoutCallSites.length = 0;
  auditMock.mockClear();
  delete process.env["SAI_CONFIG_PATH"];
  vi.doUnmock("../agent/discovery-prefetch.js");
  vi.doUnmock("../decisions/intent-readout.js");
  vi.resetModules();
  (await import("../config/loader.js")).resetConfigForTests();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("an --auto turn routed to a deliverable-emitting agent is forced to call a tool first when the readout reads work", () => {
  it("the Mermaid request the word lists miss forces the first call when the readout reads PRODUCE", async () => {
    const loaded = await load({ capsule: { agents: [{ name: "diagram_designer", confidence: "high" }, { name: "summarizer", confidence: "medium" }] } });
    // The word lists do not see it, or this test would prove nothing about the routing signal.
    expect(loaded.deliverableIntent.classifyDeliverableIntent(MERMAID_REQUEST).wantsArtifact).toBe(false);
    readoutMock.mockResolvedValue(modeReading("PRODUCE"));
    const options = await firstCallOptions(loaded, MERMAID_REQUEST, true);
    expect(prefetchCalls.count).toBe(1);
    expect(options?.toolChoice).toBe("required");
    // Asked once for the whole turn, in both option orders, under the turn's signal, as routing-tier work.
    expect(readoutMock).toHaveBeenCalledTimes(1);
    const [, input, readoutOptions] = readoutMock.mock.calls[0] as [unknown, { userMessage: string; priorTurnDigest?: string }, { bothOrders?: boolean; signal?: AbortSignal }];
    expect(input).toEqual({ userMessage: MERMAID_REQUEST });
    expect(readoutOptions.bothOrders).toBe(true);
    expect(readoutOptions.signal).toBeInstanceOf(AbortSignal);
    expect(readoutCallSites).toEqual([{ callSite: "routing_tier", agentName: "intent_readout" }]);
    // One row: the reading, rounded, and never the message or the readout's restatement.
    const rows = modeReadRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "produce", choice: "PRODUCE", top: 0.9123, margin: 0.8346, runnerUp: "GATHER", orderAgreed: true });
    expect(JSON.stringify(rows[0])).not.toContain("Bestellablauf");
    expect(JSON.stringify(rows[0])).not.toContain("restatement");
  });

  it("ACT and ORCHESTRATE are work too: either forces the first call", async () => {
    for (const choice of ["ACT", "ORCHESTRATE"]) {
      streamMock.mockReset();
      readoutMock.mockReset();
      const loaded = await load({ capsule: { agents: [{ name: "diagram_designer", confidence: "high" }] } });
      readoutMock.mockResolvedValue(modeReading(choice));
      expect((await firstCallOptions(loaded, MERMAID_REQUEST, true))?.toolChoice, choice).toBe("required");
      expect(readoutMock, choice).toHaveBeenCalledTimes(1);
    }
  });

  // The routing alone would force these: chart_designer holds generate_chart_html, and on the
  // embedding path its being listed at all makes it high.
  it("a question the word lists miss, routed to a chart agent, is not forced when the readout reads an answer", async () => {
    for (const question of QUESTIONS) {
      for (const choice of ["converse", "GATHER", "VERIFY"]) {
        streamMock.mockReset();
        readoutMock.mockReset();
        auditMock.mockClear();
        const loaded = await load({ capsule: { agents: [{ name: "chart_designer", confidence: "high" }] } });
        expect(loaded.deliverableIntent.classifyDeliverableIntent(question).wantsArtifact, question).toBe(false);
        readoutMock.mockResolvedValue(modeReading(choice));
        expect(await firstCallOptions(loaded, question, true), `${question} / ${choice}`).toBeUndefined();
        expect(readoutMock).toHaveBeenCalledTimes(1);
        expect((readoutMock.mock.calls[0]?.[2] as { bothOrders?: boolean }).bothOrders).toBe(true);
        expect(modeReadRows()).toMatchObject([{ outcome: "ask", choice }]);
      }
    }
  });

  it("without a reading the turn is not forced, and the row says why", async () => {
    const noLogprobs = await load({ capsule: { agents: [{ name: "diagram_designer", confidence: "high" }] } });
    readoutMock.mockResolvedValue({ ok: false, reason: "no_logprobs", ms: 12 });
    expect(await firstCallOptions(noLogprobs, MERMAID_REQUEST, true)).toBeUndefined();
    expect(modeReadRows()).toMatchObject([{ outcome: "no_logprobs", ms: 12 }]);
    expect(modeReadRows()[0]).not.toHaveProperty("choice");

    streamMock.mockReset();
    readoutMock.mockReset();
    auditMock.mockClear();
    const noMode = await load({ capsule: { agents: [{ name: "diagram_designer", confidence: "high" }] } });
    const reading = modeReading("PRODUCE");
    readoutMock.mockResolvedValue({ ...reading, readout: { ...reading.readout, facets: {} } });
    expect(await firstCallOptions(noMode, MERMAID_REQUEST, true)).toBeUndefined();
    expect(modeReadRows()).toMatchObject([{ outcome: "no_mode" }]);
  });

  it("with a Claude routing tier the readout is not asked and the turn is not forced", async () => {
    const loaded = await load({ routingTier: "anthropic/claude-haiku-4-5", capsule: { agents: [{ name: "diagram_designer", confidence: "high" }] } });
    readoutMock.mockResolvedValue(modeReading("PRODUCE"));
    expect(await firstCallOptions(loaded, MERMAID_REQUEST, true)).toBeUndefined();
    expect(readoutMock).not.toHaveBeenCalled();
    expect(modeReadRows()).toMatchObject([{ outcome: "no_logprobs_provider" }]);
  });

  // turn_performance partitions a turn into model time, tool time and named phases. The wait is a
  // phase; counted in llmTimeMs as well, the same seconds were blamed on the model too.
  it("the wait for the read is its own phase and not orchestrator model time", async () => {
    const loaded = await load({ capsule: { agents: [{ name: "chart_designer", confidence: "high" }] } });
    readoutMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return modeReading("GATHER");
    });
    expect(await firstCallOptions(loaded, QUESTIONS[0]!, true)).toBeUndefined();
    const performance = auditMock.mock.calls.find(([event]) => event === "turn_performance")?.[1] as
      { llmTimeMs: number; phaseTimingsMs?: Record<string, number> } | undefined;
    const waitMs = performance?.phaseTimingsMs?.["produceIntentReadWait"] ?? 0;
    expect(waitMs).toBeGreaterThanOrEqual(400);
    expect(performance?.llmTimeMs).toBeLessThan(waitMs / 2);
  });
});

describe("no other turn asks the readout", () => {
  // Reachable only on the lexical path (no embedding model configured), which admits an agent from
  // 0.45; on the embedding path the floor is 0.72, where "high" begins.
  it("on the lexical path, an --auto turn whose top agent is only medium confidence is not forced", async () => {
    const loaded = await load({ capsule: { agents: [{ name: "diagram_designer", confidence: "medium" }] } });
    readoutMock.mockResolvedValue(modeReading("PRODUCE"));
    expect(await firstCallOptions(loaded, SMALL_TALK, true)).toBeUndefined();
    expect(prefetchCalls.count).toBe(1);
    expect(readoutMock).not.toHaveBeenCalled();
  });

  it("a high-confidence top agent that only writes files, or holds no artifact tool at all, does not force", async () => {
    readoutMock.mockResolvedValue(modeReading("PRODUCE"));
    const writesFiles = await load({ capsule: { agents: [{ name: "summarizer", confidence: "high" }] } });
    expect(await firstCallOptions(writesFiles, SMALL_TALK, true)).toBeUndefined();
    streamMock.mockReset();
    const noArtifactTool = await load({ capsule: { agents: [{ name: "mail_agent", confidence: "high" }] } });
    expect(await firstCallOptions(noArtifactTool, MERMAID_REQUEST, true)).toBeUndefined();
    expect(readoutMock).not.toHaveBeenCalled();
  });

  it("only the top agent counts: an emitter in second place does not force", async () => {
    const loaded = await load({ capsule: { agents: [{ name: "mail_agent", confidence: "high" }, { name: "diagram_designer", confidence: "high" }] } });
    readoutMock.mockResolvedValue(modeReading("PRODUCE"));
    expect(await firstCallOptions(loaded, MERMAID_REQUEST, true)).toBeUndefined();
    expect(readoutMock).not.toHaveBeenCalled();
  });

  it("with autoApprove off nothing changes: the same routing forces nothing", async () => {
    const loaded = await load({ capsule: { agents: [{ name: "diagram_designer", confidence: "high" }] } });
    readoutMock.mockResolvedValue(modeReading("PRODUCE"));
    expect(await firstCallOptions(loaded, MERMAID_REQUEST, false)).toBeUndefined();
    // The prefetch ran and its capsule reached the prompt as before.
    expect(prefetchCalls.count).toBe(1);
    expect(firstPromptText()).toContain("- diagram_designer [high]");
    expect(readoutMock).not.toHaveBeenCalled();
  });

  it("with autonomousModeAntiRefusal off the same --auto turn is not forced", async () => {
    const loaded = await load({ antiRefusal: false, capsule: { agents: [{ name: "diagram_designer", confidence: "high" }] } });
    readoutMock.mockResolvedValue(modeReading("PRODUCE"));
    expect(await firstCallOptions(loaded, MERMAID_REQUEST, true)).toBeUndefined();
    expect(readoutMock).not.toHaveBeenCalled();
  });

  // The flag and autoApprove are checked once per arm: where the prefetch starts for the routing
  // arm (the two cases above), and in autonomousArtifactBuild for the word-list arm (this case).
  it("the word-list arm keeps its own gates: a request the lists see is forced only on --auto with the flag on", async () => {
    const onAuto = await load({});
    expect(onAuto.deliverableIntent.classifyDeliverableIntent(WEBSITE_REQUEST).wantsArtifact).toBe(true);
    expect((await firstCallOptions(onAuto, WEBSITE_REQUEST, true))?.toolChoice).toBe("required");
    streamMock.mockReset();
    const withoutAuto = await load({});
    expect(await firstCallOptions(withoutAuto, WEBSITE_REQUEST, false)).toBeUndefined();
    streamMock.mockReset();
    const flagOff = await load({ antiRefusal: false });
    expect(await firstCallOptions(flagOff, WEBSITE_REQUEST, true)).toBeUndefined();
  });

  it("a request the word lists see is forced by them, routed to an emitter or not, and asks no readout", async () => {
    const loaded = await load({ capsule: { agents: [{ name: "diagram_designer", confidence: "high" }] } });
    readoutMock.mockResolvedValue(modeReading("converse"));
    expect((await firstCallOptions(loaded, WEBSITE_REQUEST, true))?.toolChoice).toBe("required");
    expect(readoutMock).not.toHaveBeenCalled();
  });

  // The directive forces the first call already, and the delegation that runs its agent releases
  // the --auto arm: the verdict would change nothing, and its wait would delay the first token.
  it("an --agent directive turn to an emitter asks no readout, and the directive still forces the first call", async () => {
    const loaded = await load({ capsule: { agents: [{ name: "diagram_designer", confidence: "high" }] } });
    readoutMock.mockResolvedValue(modeReading("PRODUCE"));
    streamMock.mockImplementation(() => textStream("Hier ist das Diagramm."));
    const session = new loaded.AgentSession({ channel: "test", workspacePath: loaded.workspacePath, systemPrompt: "You are a test agent." });
    await loaded.runTurn({
      session,
      userMessage: MERMAID_REQUEST,
      autoApprove: true,
      directiveAgent: "diagram_designer",
      allowedAgents: ["diagram_designer"],
    });
    const options = streamMock.mock.calls[0]?.[3] as { toolChoice?: unknown; prefillToolCall?: unknown } | undefined;
    expect(options?.toolChoice).toBe("required");
    expect(options?.prefillToolCall).toEqual({ tool: "delegate_to_agent" });
    expect(prefetchCalls.count).toBe(1);
    expect(readoutMock).not.toHaveBeenCalled();
    expect(modeReadRows()).toEqual([]);
  });

  it("a workflow step routed to an emitter asks no readout and is not forced", async () => {
    const loaded = await load({ capsule: { agents: [{ name: "diagram_designer", confidence: "high" }] } });
    readoutMock.mockResolvedValue(modeReading("PRODUCE"));
    expect(await firstCallOptions(loaded, MERMAID_REQUEST, true, "workflow")).toBeUndefined();
    expect(prefetchCalls.count).toBe(1);
    expect(readoutMock).not.toHaveBeenCalled();
  });

  it("when the prefetch did not run the turn is not forced", async () => {
    const loaded = await load({ discoveryPrefetch: false, capsule: { agents: [{ name: "diagram_designer", confidence: "high" }] } });
    readoutMock.mockResolvedValue(modeReading("PRODUCE"));
    expect(await firstCallOptions(loaded, MERMAID_REQUEST, true)).toBeUndefined();
    expect(prefetchCalls.count).toBe(0);
    expect(readoutMock).not.toHaveBeenCalled();
  });

  // The turn's own prefetch budget (DISCOVERY_PREFETCH_BUDGET_MS, 2.5 s) is not a parameter of the
  // turn, so this case waits it out.
  it("when the prefetch came too late the turn asks no readout and is not forced", async () => {
    const loaded = await load({ capsule: { agents: [{ name: "diagram_designer", confidence: "high" }], delayMs: 2_800 } });
    readoutMock.mockResolvedValue(modeReading("PRODUCE"));
    expect(await firstCallOptions(loaded, MERMAID_REQUEST, true)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(readoutMock).not.toHaveBeenCalled();
  }, 20_000);
});

describe("startProduceIntentRead", () => {
  it("passes the prior exchange, and resolves null with the reason on a timeout, a stopped turn or a throw", async () => {
    const { turnSetup } = await load({});
    readoutMock.mockResolvedValue(modeReading("GATHER"));
    const controller = new AbortController();
    expect(await turnSetup.startProduceIntentRead({
      userMessage: QUESTIONS[0]!,
      priorTurnDigest: "User asked: x\nAssistant answered: y",
      sessionId: "s-read",
      signal: controller.signal,
    })).toBe("ask");
    expect(readoutMock.mock.calls[0]?.[1]).toEqual({ userMessage: QUESTIONS[0], priorTurnDigest: "User asked: x\nAssistant answered: y" });

    // The readout returns "aborted" once its signal fires, as askIntentReadout does.
    const untilAborted = (_provider: unknown, _input: unknown, options: { signal: AbortSignal }) =>
      new Promise((resolve) => {
        options.signal.addEventListener("abort", () => resolve({ ok: false, reason: "aborted", ms: 1 }), { once: true });
      });
    auditMock.mockClear();
    readoutMock.mockReset().mockImplementation(untilAborted);
    expect(await turnSetup.startProduceIntentRead({
      userMessage: QUESTIONS[0]!,
      sessionId: "s-timeout",
      signal: new AbortController().signal,
      timeoutMs: 20,
    })).toBeNull();
    expect(modeReadRows()).toMatchObject([{ outcome: "timeout" }]);

    auditMock.mockClear();
    const stopped = new AbortController();
    const read = turnSetup.startProduceIntentRead({ userMessage: QUESTIONS[0]!, sessionId: "s-stopped", signal: stopped.signal });
    stopped.abort();
    expect(await read).toBeNull();
    expect(modeReadRows()).toMatchObject([{ outcome: "aborted" }]);

    auditMock.mockClear();
    readoutMock.mockReset().mockRejectedValue(new Error("boom"));
    expect(await turnSetup.startProduceIntentRead({ userMessage: QUESTIONS[0]!, sessionId: "s-throws", signal: new AbortController().signal })).toBeNull();
    expect(modeReadRows()).toMatchObject([{ outcome: "error" }]);
  });
});

describe("produceIntentVerdict", () => {
  it("reads converse, GATHER and VERIFY as an answer, every other mode as work, and no facet as no verdict", async () => {
    const { turnSetup } = await load({});
    const { INTENT_FACETS } = await import("../decisions/intent-readout.js");
    const modeKeys = INTENT_FACETS.find((definition) => definition.name === "mode")?.keys ?? [];
    expect(modeKeys).toHaveLength(6);
    const verdicts = Object.fromEntries(modeKeys.map((choice) => [choice, turnSetup.produceIntentVerdict({ choice })]));
    expect(verdicts).toEqual({ converse: "ask", GATHER: "ask", PRODUCE: "produce", ACT: "produce", VERIFY: "ask", ORCHESTRATE: "produce" });
    // Every option ASK_MODES names is one the readout can give: a renamed option fails here, not in a turn.
    for (const choice of turnSetup.ASK_MODES) expect(modeKeys).toContain(choice);
    expect(turnSetup.produceIntentVerdict(undefined)).toBeNull();
  });
});

describe("prefetchRoutedToDeliverableEmitter", () => {
  it("is true only for a high-confidence top agent that holds a deliverable-emitting tool", async () => {
    const { turnSetup } = await load({});
    const routed = turnSetup.prefetchRoutedToDeliverableEmitter;
    expect(routed([{ name: "diagram_designer", confidence: "high" }])).toBe(true);
    expect(routed([{ name: "diagram_designer", confidence: "medium" }])).toBe(false);
    expect(routed([{ name: "diagram_designer", confidence: "low" }])).toBe(false);
    expect(routed([{ name: "diagram_designer" }])).toBe(false);
    expect(routed([{ name: "summarizer", confidence: "high" }])).toBe(false);
    expect(routed([{ name: "mail_agent", confidence: "high" }])).toBe(false);
    expect(routed([{ name: "mail_agent", confidence: "high" }, { name: "diagram_designer", confidence: "high" }])).toBe(false);
    expect(routed([])).toBe(false);
    // An agent the configuration does not know holds no tool.
    expect(routed([{ name: "unknown_agent", confidence: "high" }])).toBe(false);
  });

  it("reads a promoted agent's tools as routing does", async () => {
    const { turnSetup } = await load({
      promoted: { chart_maker: { description: "Charts.", systemPrompt: "Chart.", tools: ["generate_chart_html"] } },
    });
    expect(turnSetup.prefetchRoutedToDeliverableEmitter([{ name: "chart_maker", confidence: "high" }])).toBe(true);
  });
});

describe("startDiscoveryPrefetch onCapsuleAgents", () => {
  it("hands over the capsule's agents with their confidence before the capsule resolves", async () => {
    const { turnSetup } = await load({ capsule: { agents: [{ name: "diagram_designer", confidence: "high" }, { name: "summarizer", confidence: "medium" }] } });
    const seen: unknown[] = [];
    let resolved = false;
    const capsule = turnSetup.startDiscoveryPrefetch({
      userMessage: MERMAID_REQUEST,
      sessionId: "s-prefetch",
      onCapsuleAgents: (agents) => { seen.push({ agents, resolved }); },
    }).then((text) => { resolved = true; return text; });
    expect(await capsule).toContain("diagram_designer [high]");
    expect(seen).toEqual([{
      agents: [{ name: "diagram_designer", confidence: "high" }, { name: "summarizer", confidence: "medium" }],
      resolved: false,
    }]);
  });

  it("is not called when the capsule came too late, and an observer that throws costs no capsule", async () => {
    const late = await load({ capsule: { agents: [{ name: "diagram_designer", confidence: "high" }], delayMs: 200 } });
    const seen: unknown[] = [];
    const lateCapsule = await late.turnSetup.startDiscoveryPrefetch({
      userMessage: MERMAID_REQUEST,
      sessionId: "s-late",
      budgetMs: 20,
      onCapsuleAgents: (agents) => { seen.push(agents); },
    });
    expect(lateCapsule).toBe("");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(seen).toEqual([]);

    const inTime = await load({ capsule: { agents: [{ name: "diagram_designer", confidence: "high" }] } });
    const capsule = await inTime.turnSetup.startDiscoveryPrefetch({
      userMessage: MERMAID_REQUEST,
      sessionId: "s-throws",
      onCapsuleAgents: () => { throw new Error("observer"); },
    });
    expect(capsule).toContain("diagram_designer");
  });
});

describe("DELIVERABLE_EMITTING_TOOLS", () => {
  it("holds the generators and none of the bare workspace tools", async () => {
    const { ARTIFACT_PRODUCING_TOOLS, DELIVERABLE_EMITTING_TOOLS } = await import("../tools/delegation-artifact-classification.js");
    for (const tool of ["generate_mermaid_diagram", "generate_chart_html", "generate_website", "generate_presentation", "generate_docx", "generate_pptx"]) {
      expect(DELIVERABLE_EMITTING_TOOLS.has(tool), tool).toBe(true);
    }
    for (const tool of ["write_file", "edit_file", "create_dir", "shell_exec"]) {
      expect(DELIVERABLE_EMITTING_TOOLS.has(tool), tool).toBe(false);
    }
    for (const tool of DELIVERABLE_EMITTING_TOOLS) expect(ARTIFACT_PRODUCING_TOOLS.has(tool), tool).toBe(true);
  });
});
