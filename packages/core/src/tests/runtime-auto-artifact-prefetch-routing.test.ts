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
/** Questions about making something, which the word lists fire on as on a request to make it. */
const WORD_LIST_QUESTIONS = ["Wie erstelle ich eine Präsentation in PowerPoint?", "How do I build a website with Hugo?"];
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
    // Asked once for the whole turn, in both option orders at once and only as far as the mode line,
    // under the turn's signal, as routing-tier work.
    expect(readoutMock).toHaveBeenCalledTimes(1);
    const [, input, readoutOptions] = readoutMock.mock.calls[0] as [unknown, { userMessage: string; priorTurnDigest?: string }, { bothOrders?: boolean; concurrentOrders?: boolean; maxTokens?: number; signal?: AbortSignal }];
    expect(input).toEqual({ userMessage: MERMAID_REQUEST });
    expect(readoutOptions.bothOrders).toBe(true);
    expect(readoutOptions.concurrentOrders).toBe(true);
    expect(readoutOptions.maxTokens).toBe(loaded.turnSetup.PRODUCE_INTENT_READ_MAX_TOKENS);
    expect(loaded.turnSetup.PRODUCE_INTENT_READ_MAX_TOKENS).toBeLessThan(10);
    expect(readoutOptions.signal).toBeInstanceOf(AbortSignal);
    expect(readoutCallSites).toEqual([{ callSite: "routing_tier", agentName: "intent_readout" }]);
    // One row: the reading, rounded, and never the message or the readout's restatement.
    const rows = modeReadRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "produce", arm: "routing", choice: "PRODUCE", top: 0.9123, margin: 0.8346, runnerUp: "GATHER", orderAgreed: true });
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

  // askIntentReadout returns a reading when only one of the two passes read the facet: the
  // reversed call failed, or missed the slot. One order alone is the reading the design rejected.
  it("a mode only one option order read does not force, and the row names the pass", async () => {
    const loaded = await load({ capsule: { agents: [{ name: "diagram_designer", confidence: "high" }] } });
    const reading = modeReading("PRODUCE");
    readoutMock.mockResolvedValue({
      ...reading,
      readout: { ...reading.readout, facets: { mode: { ...reading.readout.facets.mode, orders: { served: "PRODUCE", singlePass: "served" } } } },
    });
    expect(await firstCallOptions(loaded, MERMAID_REQUEST, true)).toBeUndefined();
    expect(readoutMock).toHaveBeenCalledTimes(1);
    expect(modeReadRows()).toMatchObject([{ outcome: "single_pass", choice: "PRODUCE", singlePass: "served", orderAgreed: null }]);
  });

  it("a follow-up is read with the prior exchange", async () => {
    const loaded = await load({ capsule: { agents: [{ name: "chart_designer", confidence: "high" }] } });
    const session = new loaded.AgentSession({ channel: "test", workspacePath: loaded.workspacePath, systemPrompt: "You are a test agent." });
    streamMock.mockImplementation(() => textStream("I can draw that Gantt chart for you."));
    // Without --auto the first turn asks nothing; it only leaves the exchange the follow-up refers to.
    await loaded.runTurn({ session, userMessage: QUESTIONS[0]! });
    expect(readoutMock).not.toHaveBeenCalled();
    readoutMock.mockResolvedValue(modeReading("PRODUCE"));
    await loaded.runTurn({ session, userMessage: "yes, go ahead", autoApprove: true });
    expect(readoutMock).toHaveBeenCalledTimes(1);
    const input = readoutMock.mock.calls[0]?.[1] as { userMessage: string; priorTurnDigest?: string };
    expect(input.userMessage).toBe("yes, go ahead");
    expect(input.priorTurnDigest).toContain(`User asked: ${QUESTIONS[0]}`);
    expect(input.priorTurnDigest).toContain("Assistant answered: I can draw that Gantt chart");
  });

  it("a stopped turn stops the read", async () => {
    const loaded = await load({ capsule: { agents: [{ name: "chart_designer", confidence: "high" }] } });
    const session = new loaded.AgentSession({ channel: "test", workspacePath: loaded.workspacePath, systemPrompt: "You are a test agent." });
    streamMock.mockImplementation(() => textStream("Here is how it works."));
    const stop = new AbortController();
    let readSignal: AbortSignal | undefined;
    // Resolves only once its signal fires, as askIntentReadout does on an abort; the turn is stopped
    // while the read is pending. Through anything but the turn's signal it would end on its own
    // timeout, 6 s later, as a "timeout".
    readoutMock.mockImplementation((_provider: unknown, _input: unknown, options: { signal: AbortSignal }) => {
      readSignal = options.signal;
      setTimeout(() => stop.abort(), 20);
      return new Promise((resolve) => {
        options.signal.addEventListener("abort", () => resolve({ ok: false, reason: "aborted", ms: 1 }), { once: true });
      });
    });
    const started = Date.now();
    await loaded.runTurn({ session, userMessage: QUESTIONS[0]!, autoApprove: true, signal: stop.signal }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readoutMock).toHaveBeenCalledTimes(1);
    expect(readSignal?.aborted).toBe(true);
    expect(modeReadRows()).toMatchObject([{ outcome: "aborted" }]);
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 20_000);

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
    readoutMock.mockResolvedValue(modeReading("PRODUCE"));
    const onAuto = await load({});
    expect(onAuto.deliverableIntent.classifyDeliverableIntent(WEBSITE_REQUEST).wantsArtifact).toBe(true);
    expect((await firstCallOptions(onAuto, WEBSITE_REQUEST, true))?.toolChoice).toBe("required");
    expect(readoutMock).toHaveBeenCalledTimes(1);
    readoutMock.mockClear();
    streamMock.mockReset();
    const withoutAuto = await load({});
    expect(await firstCallOptions(withoutAuto, WEBSITE_REQUEST, false)).toBeUndefined();
    streamMock.mockReset();
    const flagOff = await load({ antiRefusal: false });
    expect(await firstCallOptions(flagOff, WEBSITE_REQUEST, true)).toBeUndefined();
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

describe("an --auto turn the word lists see asks the readout too, and a question is not forced", () => {
  it("a question the word lists fire on is not forced when the readout reads an answer", async () => {
    for (const question of WORD_LIST_QUESTIONS) {
      for (const choice of ["converse", "GATHER", "VERIFY"]) {
        streamMock.mockReset();
        readoutMock.mockReset();
        readoutCallSites.length = 0;
        auditMock.mockClear();
        // No prefetch: the word-list arm asks on its own, before and without any routing.
        const loaded = await load({ discoveryPrefetch: false });
        expect(loaded.deliverableIntent.classifyDeliverableIntent(question).wantsArtifact, question).toBe(true);
        readoutMock.mockResolvedValue(modeReading(choice));
        expect(await firstCallOptions(loaded, question, true), `${question} / ${choice}`).toBeUndefined();
        expect(prefetchCalls.count).toBe(0);
        expect(readoutMock).toHaveBeenCalledTimes(1);
        const [, input, readoutOptions] = readoutMock.mock.calls[0] as [unknown, { userMessage: string }, { bothOrders?: boolean; concurrentOrders?: boolean; signal?: AbortSignal }];
        expect(input).toEqual({ userMessage: question });
        expect(readoutOptions).toMatchObject({ bothOrders: true, concurrentOrders: true });
        expect(readoutOptions.signal).toBeInstanceOf(AbortSignal);
        expect(readoutCallSites).toEqual([{ callSite: "routing_tier", agentName: "intent_readout" }]);
        expect(modeReadRows()).toMatchObject([{ outcome: "ask", choice, arm: "word_list" }]);
      }
    }
  });

  it("a build the word lists see is forced when the readout reads work, routed to an emitter or not, and is read once", async () => {
    for (const capsule of [undefined, { agents: [{ name: "diagram_designer", confidence: "high" }] }]) {
      for (const choice of ["PRODUCE", "ACT", "ORCHESTRATE"]) {
        streamMock.mockReset();
        readoutMock.mockReset();
        auditMock.mockClear();
        const loaded = await load({ ...(capsule ? { capsule } : {}) });
        readoutMock.mockResolvedValue(modeReading(choice));
        expect((await firstCallOptions(loaded, WEBSITE_REQUEST, true))?.toolChoice, choice).toBe("required");
        // Asked by the word-list arm alone: the routing arm does not ask again for a request the lists see.
        expect(readoutMock, choice).toHaveBeenCalledTimes(1);
        expect(modeReadRows()).toMatchObject([{ outcome: "produce", choice, arm: "word_list" }]);
      }
    }
  });

  // The user's decision 6 (option 3): an --auto question is never forced, a build is. The read's
  // four outcomes on a question the word lists fire on: a verdict here, a read that missed and a
  // readout the deployment cannot give in the cases below.
  it("the same word-list question is forced on a reading of work and not on a reading of an answer", async () => {
    const question = WORD_LIST_QUESTIONS[0]!;
    for (const [choice, forced] of [["PRODUCE", true], ["converse", false]] as const) {
      streamMock.mockReset();
      readoutMock.mockReset();
      auditMock.mockClear();
      const loaded = await load({ discoveryPrefetch: false });
      expect(loaded.deliverableIntent.classifyDeliverableIntent(question).wantsArtifact).toBe(true);
      readoutMock.mockResolvedValue(modeReading(choice));
      expect((await firstCallOptions(loaded, question, true))?.toolChoice, choice).toBe(forced ? "required" : undefined);
      expect(modeReadRows()).toMatchObject([{ outcome: forced ? "produce" : "ask", arm: "word_list" }]);
    }
  });

  // The read's own bound ends it (PRODUCE_INTENT_READ_TIMEOUT_MS, not a parameter of the turn), so
  // this case waits it out.
  it("a word-list question whose read timed out, on a server that gives readings, is not forced", async () => {
    const question = WORD_LIST_QUESTIONS[0]!;
    const loaded = await load({ discoveryPrefetch: false });
    // Resolves only once its signal fires, as askIntentReadout does on an abort.
    readoutMock.mockImplementation((_provider: unknown, _input: unknown, options: { signal: AbortSignal }) => new Promise((resolve) => {
      options.signal.addEventListener("abort", () => resolve({ ok: false, reason: "aborted", ms: 1 }), { once: true });
    }));
    expect(await firstCallOptions(loaded, question, true)).toBeUndefined();
    expect(readoutMock).toHaveBeenCalledTimes(1);
    expect(modeReadRows()).toMatchObject([{ outcome: "timeout", arm: "word_list" }]);
  }, 20_000);

  // A read that missed this time says nothing about the request, so neither a question nor a
  // build is forced for it: the build is left to the orchestrator for that turn.
  it("nor does a read that missed otherwise force the arm: an error, one option order alone, no mode facet", async () => {
    const reading = modeReading("PRODUCE");
    const missed = [
      { result: { ok: false, reason: "error", ms: 12, error: "500" }, outcome: "error" },
      { result: { ...reading, readout: { ...reading.readout, facets: { mode: { ...reading.readout.facets.mode, orders: { served: "PRODUCE", singlePass: "served" } } } } }, outcome: "single_pass" },
      { result: { ...reading, readout: { ...reading.readout, facets: {} } }, outcome: "no_mode" },
    ];
    for (const message of [WORD_LIST_QUESTIONS[0]!, WEBSITE_REQUEST]) {
      for (const { result, outcome } of missed) {
        streamMock.mockReset();
        readoutMock.mockReset();
        auditMock.mockClear();
        const loaded = await load({});
        readoutMock.mockResolvedValue(result);
        expect(await firstCallOptions(loaded, message, true), `${message} / ${outcome}`).toBeUndefined();
        expect(readoutMock).toHaveBeenCalledTimes(1);
        expect(modeReadRows()).toMatchObject([{ outcome, arm: "word_list" }]);
      }
    }
  });

  // A Claude routing tier or a server without token logprobs never gives a reading; on such a
  // deployment every --auto build would otherwise be left to answer inline. A question among
  // them is forced there too: the readout cannot tell it from a build.
  it("where the routing tier gives no logprobs the word lists decide as before: a build, and a question, is forced", async () => {
    for (const message of [WEBSITE_REQUEST, WORD_LIST_QUESTIONS[0]!]) {
      streamMock.mockReset();
      readoutMock.mockReset();
      auditMock.mockClear();
      const noLogprobs = await load({});
      readoutMock.mockResolvedValue({ ok: false, reason: "no_logprobs", ms: 12 });
      expect((await firstCallOptions(noLogprobs, message, true))?.toolChoice, message).toBe("required");
      expect(readoutMock).toHaveBeenCalledTimes(1);
      expect(modeReadRows()).toMatchObject([{ outcome: "no_logprobs", arm: "word_list" }]);

      streamMock.mockReset();
      readoutMock.mockReset();
      auditMock.mockClear();
      const claude = await load({ routingTier: "anthropic/claude-haiku-4-5" });
      expect((await firstCallOptions(claude, message, true))?.toolChoice, message).toBe("required");
      expect(readoutMock).not.toHaveBeenCalled();
      expect(modeReadRows()).toMatchObject([{ outcome: "no_logprobs_provider", arm: "word_list" }]);
    }
  });

  it("no read is asked, and nothing changes, without --auto, with the flag off, on a workflow step or on an --agent directive turn", async () => {
    readoutMock.mockResolvedValue(modeReading("converse"));
    const withoutAuto = await load({});
    expect(await firstCallOptions(withoutAuto, WORD_LIST_QUESTIONS[0]!, false)).toBeUndefined();
    streamMock.mockReset();
    const flagOff = await load({ antiRefusal: false });
    expect(await firstCallOptions(flagOff, WORD_LIST_QUESTIONS[0]!, true)).toBeUndefined();
    streamMock.mockReset();
    const workflow = await load({});
    expect(await firstCallOptions(workflow, WEBSITE_REQUEST, true, "workflow")).toBeUndefined();
    expect(readoutMock).not.toHaveBeenCalled();

    streamMock.mockReset();
    const directive = await load({});
    streamMock.mockImplementation(() => textStream("Here is the site."));
    const session = new directive.AgentSession({ channel: "test", workspacePath: directive.workspacePath, systemPrompt: "You are a test agent." });
    await directive.runTurn({ session, userMessage: WEBSITE_REQUEST, autoApprove: true, directiveAgent: "diagram_designer", allowedAgents: ["diagram_designer"] });
    expect((streamMock.mock.calls[0]?.[3] as { toolChoice?: unknown } | undefined)?.toolChoice).toBe("required");
    expect(readoutMock).not.toHaveBeenCalled();
    expect(modeReadRows()).toEqual([]);
  });
});

describe("startProduceIntentRead", () => {
  it("passes the prior exchange, and resolves missed with the reason on a timeout, a stopped turn or a throw", async () => {
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
    })).toBe("missed");
    expect(modeReadRows()).toMatchObject([{ outcome: "timeout" }]);

    auditMock.mockClear();
    const stopped = new AbortController();
    const read = turnSetup.startProduceIntentRead({ userMessage: QUESTIONS[0]!, sessionId: "s-stopped", signal: stopped.signal });
    stopped.abort();
    expect(await read).toBe("missed");
    expect(modeReadRows()).toMatchObject([{ outcome: "aborted" }]);

    auditMock.mockClear();
    readoutMock.mockReset().mockRejectedValue(new Error("boom"));
    expect(await turnSetup.startProduceIntentRead({ userMessage: QUESTIONS[0]!, sessionId: "s-throws", signal: new AbortController().signal })).toBe("missed");
    expect(modeReadRows()).toMatchObject([{ outcome: "error" }]);
  });

  it("resolves unavailable where the routing tier gives no logprobs: a reply without them, or a Claude tier", async () => {
    const { turnSetup } = await load({});
    readoutMock.mockResolvedValue({ ok: false, reason: "no_logprobs", ms: 12 });
    expect(await turnSetup.startProduceIntentRead({ userMessage: QUESTIONS[0]!, sessionId: "s-no-logprobs", signal: new AbortController().signal })).toBe("unavailable");
    expect(modeReadRows()).toMatchObject([{ outcome: "no_logprobs", ms: 12 }]);

    auditMock.mockClear();
    readoutMock.mockReset();
    const claude = await load({ routingTier: "anthropic/claude-haiku-4-5" });
    expect(await claude.turnSetup.startProduceIntentRead({ userMessage: QUESTIONS[0]!, sessionId: "s-claude", signal: new AbortController().signal })).toBe("unavailable");
    expect(readoutMock).not.toHaveBeenCalled();
    expect(modeReadRows()).toMatchObject([{ outcome: "no_logprobs_provider" }]);
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

  // Measured 2026-10-09: "Wie erstelle ich eine Präsentation in PowerPoint?" read converse served and
  // PRODUCE reversed on every read, and the average sometimes came out PRODUCE.
  it("is work only when both orders read work: an average that two disagreeing orders put on PRODUCE is an answer", async () => {
    const { turnSetup } = await load({});
    const verdict = (choice: string, served: string, reversed: string) =>
      turnSetup.produceIntentVerdict({ choice, orders: { served, reversed, agreed: served === reversed } });
    expect(verdict("PRODUCE", "converse", "PRODUCE")).toBe("ask");
    expect(verdict("PRODUCE", "PRODUCE", "GATHER")).toBe("ask");
    expect(verdict("converse", "converse", "PRODUCE")).toBe("ask");
    expect(verdict("PRODUCE", "PRODUCE", "PRODUCE")).toBe("produce");
    // Work in both orders, if not the same work.
    expect(verdict("PRODUCE", "PRODUCE", "ORCHESTRATE")).toBe("produce");
    expect(verdict("ACT", "ACT", "ACT")).toBe("produce");
    // Both orders on work and the average on an answer (possible when they split the work between two modes): an answer.
    expect(verdict("converse", "PRODUCE", "ACT")).toBe("ask");
  });

  it("a turn whose two orders disagree is not forced, though the average reads PRODUCE, and the row has both orders", async () => {
    const loaded = await load({ capsule: { agents: [{ name: "diagram_designer", confidence: "high" }] } });
    const reading = modeReading("PRODUCE");
    readoutMock.mockResolvedValue({
      ...reading,
      readout: { ...reading.readout, facets: { mode: { ...reading.readout.facets.mode, orders: { served: "converse", reversed: "PRODUCE", agreed: false } } } },
    });
    expect(await firstCallOptions(loaded, QUESTIONS[0]!, true)).toBeUndefined();
    expect(modeReadRows()).toMatchObject([{ outcome: "ask", choice: "PRODUCE", servedChoice: "converse", reversedChoice: "PRODUCE", orderAgreed: false }]);
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
