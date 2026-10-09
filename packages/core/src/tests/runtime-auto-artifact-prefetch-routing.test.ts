/**
 * An --auto turn the discovery prefetch routed to a deliverable-emitting agent is forced to call a
 * tool first, whatever language it is written in.
 *
 * orchestration.autonomousModeAntiRefusal forces the first tool call of an --auto artifact build,
 * and it used to learn that a turn was one only from the deliverable-intent word lists. "Zeichne den
 * folgenden Bestellablauf als Mermaid-Flussdiagramm" matched none of their verbs or nouns, so the
 * turn went unforced and the model drew the diagram inline, although the capsule it had been given
 * named diagram_designer [high] (E2E core-build-artifact-mermaid). The routing the prefetch already
 * ran is now read back: a top agent admitted at high confidence that holds a deliverable-emitting
 * tool arms the same forced call. Nothing else changes: a medium-confidence top agent, a top agent
 * that only writes files, a late prefetch, no prefetch, no --auto, or the flag off all leave the
 * turn as it was.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const streamMock = vi.hoisted(() => vi.fn());
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
vi.mock("../audit/logger.js", () => ({ logAudit: vi.fn(), subscribeToAudit: () => () => {} }));

const MERMAID_REQUEST = "Zeichne den folgenden Bestellablauf als Mermaid-Flussdiagramm: Bestellung geht ein → "
  + "Zahlung prüfen → wenn bezahlt: Ware kommissionieren → Versand → Zustellung; wenn nicht bezahlt: "
  + "Zahlungserinnerung senden → nach 14 Tagen ohne Zahlung: Bestellung stornieren.";
const SMALL_TALK = "how was your weekend?";

/** Agents as the shipped roster declares their tools (workspace/agents). */
const SUB_AGENTS = {
  diagram_designer: {
    description: "Draws diagrams.",
    systemPrompt: "Draw.",
    tools: ["read_file", "generate_mermaid_diagram", "generate_document", "write_file", "edit_file"],
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
    agents: { mainAssistant: { toolMode: "orchestration_only" } },
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
): Promise<{ toolChoice?: unknown } | undefined> {
  streamMock.mockImplementation(() => textStream("Hier ist das Diagramm."));
  const session = new loaded.AgentSession({ channel: "test", workspacePath: loaded.workspacePath, systemPrompt: "You are a test agent." });
  await loaded.runTurn({ session, userMessage, ...(autoApprove ? { autoApprove: true } : {}) });
  expect(streamMock.mock.calls.length).toBeGreaterThan(0);
  // The call could have been forced: an orchestration tool was on offer. Without this, a turn
  // offered none would pass every "not forced" case below for the wrong reason.
  const offered = ((streamMock.mock.calls[0]?.[1] ?? []) as Array<{ name: string }>).map((tool) => tool.name);
  expect(offered).toContain("delegate_to_agent");
  return streamMock.mock.calls[0]?.[3] as { toolChoice?: unknown } | undefined;
}

/** The system text of the turn's first orchestrator call. */
function firstPromptText(): string {
  return ((streamMock.mock.calls[0]?.[0] ?? []) as Array<{ content?: unknown }>)
    .map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");
}

afterEach(async () => {
  streamMock.mockReset();
  completeMock.mockClear();
  delete process.env["SAI_CONFIG_PATH"];
  vi.doUnmock("../agent/discovery-prefetch.js");
  vi.resetModules();
  (await import("../config/loader.js")).resetConfigForTests();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("an --auto turn routed to a deliverable-emitting agent is forced to call a tool first", () => {
  it("the Mermaid request the word lists miss forces the first call when diagram_designer is the high-confidence top agent", async () => {
    const loaded = await load({ capsule: { agents: [{ name: "diagram_designer", confidence: "high" }, { name: "summarizer", confidence: "medium" }] } });
    // The word lists do not see it, or this test would prove nothing about the routing signal.
    expect(loaded.deliverableIntent.classifyDeliverableIntent(MERMAID_REQUEST).wantsArtifact).toBe(false);
    const options = await firstCallOptions(loaded, MERMAID_REQUEST, true);
    expect(prefetchCalls.count).toBe(1);
    expect(options?.toolChoice).toBe("required");
  });

  it("a small-talk --auto turn whose top agent is only medium confidence is not forced", async () => {
    const loaded = await load({ capsule: { agents: [{ name: "diagram_designer", confidence: "medium" }] } });
    expect(await firstCallOptions(loaded, SMALL_TALK, true)).toBeUndefined();
    expect(prefetchCalls.count).toBe(1);
  });

  it("a high-confidence top agent that only writes files, or holds no artifact tool at all, does not force", async () => {
    const writesFiles = await load({ capsule: { agents: [{ name: "summarizer", confidence: "high" }] } });
    expect(await firstCallOptions(writesFiles, SMALL_TALK, true)).toBeUndefined();
    streamMock.mockReset();
    const noArtifactTool = await load({ capsule: { agents: [{ name: "mail_agent", confidence: "high" }] } });
    expect(await firstCallOptions(noArtifactTool, MERMAID_REQUEST, true)).toBeUndefined();
  });

  it("only the top agent counts: an emitter in second place does not force", async () => {
    const loaded = await load({ capsule: { agents: [{ name: "mail_agent", confidence: "high" }, { name: "diagram_designer", confidence: "high" }] } });
    expect(await firstCallOptions(loaded, MERMAID_REQUEST, true)).toBeUndefined();
  });

  it("with autoApprove off nothing changes: the same routing forces nothing", async () => {
    const loaded = await load({ capsule: { agents: [{ name: "diagram_designer", confidence: "high" }] } });
    expect(await firstCallOptions(loaded, MERMAID_REQUEST, false)).toBeUndefined();
    // The prefetch ran and its capsule reached the prompt as before.
    expect(prefetchCalls.count).toBe(1);
    expect(firstPromptText()).toContain("- diagram_designer [high]");
  });

  it("with autonomousModeAntiRefusal off the same --auto turn is not forced", async () => {
    const loaded = await load({ antiRefusal: false, capsule: { agents: [{ name: "diagram_designer", confidence: "high" }] } });
    expect(await firstCallOptions(loaded, MERMAID_REQUEST, true)).toBeUndefined();
  });

  it("when the prefetch did not run the turn is not forced", async () => {
    const loaded = await load({ discoveryPrefetch: false, capsule: { agents: [{ name: "diagram_designer", confidence: "high" }] } });
    expect(await firstCallOptions(loaded, MERMAID_REQUEST, true)).toBeUndefined();
    expect(prefetchCalls.count).toBe(0);
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
