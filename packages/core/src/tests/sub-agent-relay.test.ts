import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, ToolResult } from "../tools/registry.js";
import { formatDelegatedOutput } from "../agent/runtime-evidence-dump.js";
import {
  DIRECT_RUN_SHARE_NOTICE,
  RELAY_MARKER,
  RELAY_OFFER,
  RELAY_UNAVAILABLE_CORRECTION,
  readRelayMarker,
  relayableDelegationAnswer,
} from "../agent/sub-agent-relay.js";
import { buildSubAgentToolInventory } from "../agent/sub-agent-prompt-guidance.js";

/**
 * A COORDINATOR PASSES A FINISHED ANSWER ON INSTEAD OF WRITING IT AGAIN, and a run the main
 * assistant delegated directly is not asked to share what it is about to answer.
 *
 * Live weather turn, 2026-11-14 (185 s): web_task_coordinator handed the lookup to researcher,
 * which, after the runtime's evidence checkpoint, spent 36 s on a share_finding carrying its whole
 * answer and 49 s writing that answer again; the coordinator then spent 24 s rewording it as its
 * own. The lab's real runs: 36 of 82 direct researcher runs had a model call that did nothing but
 * share_finding (23 s on average).
 */

const WEATHER = "**Bremen, heute Nachmittag (Samstag, 14.11.2026)**\n\n| Zeit | Wetter | Temperatur | Regenrisiko |\n|---|---|---|---|\n| 12–16 Uhr | sonnig | 7 °C | 0 % |\n\nQuelle: wetter-nord.example/bremen/heute";

const delegated = (answer: string, meta: Record<string, unknown> = {}): ToolResult => ({
  success: true,
  output: formatDelegatedOutput("researcher", answer),
  metadata: { agentName: "researcher", delegationSucceeded: true, delegationOutcome: "success", terminalState: "completed", ...meta },
});

describe("the answer a delegation can hand on", () => {
  it("is the specialist's own text, without the label and the routing note", () => {
    const routed = { ...delegated(WEATHER), output: formatDelegatedOutput("researcher", WEATHER, { confidence: "high", matchedTerms: ["weather"] }) };
    expect(relayableDelegationAnswer(routed)).toEqual({ agentName: "researcher", answer: WEATHER });
    expect(relayableDelegationAnswer(delegated(WEATHER))?.answer).toBe(WEATHER);
  });

  it("is none for a delegation that failed, fell short or did not run to its end", () => {
    expect(relayableDelegationAnswer({ ...delegated(WEATHER), success: false })).toBeNull();
    expect(relayableDelegationAnswer(delegated(WEATHER, { delegationSucceeded: false }))).toBeNull();
    expect(relayableDelegationAnswer(delegated(WEATHER, { delegationOutcome: "partial" }))).toBeNull();
    expect(relayableDelegationAnswer(delegated(WEATHER, { partialFallback: true }))).toBeNull();
    expect(relayableDelegationAnswer(delegated(WEATHER, { loopEnforced: "tool_loop" }))).toBeNull();
    expect(relayableDelegationAnswer(delegated(WEATHER, { terminalState: "max_iterations" }))).toBeNull();
    expect(relayableDelegationAnswer(delegated(""))).toBeNull();
    // A specialist that itself replied with the marker had nothing of its own.
    expect(relayableDelegationAnswer(delegated(RELAY_MARKER))).toBeNull();
  });

  it("is none when the specialist's record had to mask a figure no tool returned", () => {
    const masked = delegated(WEATHER, { specialistExecutions: { attempted: 1, failed: 0, succeededWithOutput: 1, unobservedFigures: 2 } });
    expect(relayableDelegationAnswer(masked)).toBeNull();
    const backed = delegated(WEATHER, { specialistExecutions: { attempted: 1, failed: 0, succeededWithOutput: 1 } });
    expect(relayableDelegationAnswer(backed)?.answer).toBe(WEATHER);
  });
});

describe("a final reply with the marker", () => {
  it("reads as a relay when it is the marker alone or beside a short lead-in", () => {
    expect(readRelayMarker("<relay/>").kind).toBe("relay");
    expect(readRelayMarker("  <relay />\n").kind).toBe("relay");
    expect(readRelayMarker("<RELAY>").kind).toBe("relay");
    expect(readRelayMarker("Here is the researcher's answer: <relay/>")).toEqual({ kind: "relay", text: "Here is the researcher's answer:" });
  });

  it("keeps an answer of the run's own, without the marker", () => {
    const own = `${"Bremen bleibt heute trocken. ".repeat(10)}<relay/>`;
    expect(readRelayMarker(own)).toEqual({ kind: "own", text: own.replace("<relay/>", "").trim() });
    expect(readRelayMarker(WEATHER)).toEqual({ kind: "none", text: WEATHER });
  });
});

describe("the tool inventory", () => {
  it("carries no relay line: the offer rides on the delegation result instead", () => {
    // As a head line it was not taken up (0 of 8 coordinator runs on the live model).
    expect(buildSubAgentToolInventory(["search_agents", "delegate_to_agent", "parallel_delegate"])).not.toContain(RELAY_MARKER);
    expect(RELAY_OFFER).toContain(RELAY_MARKER);
  });
});

// ── the loop ─────────────────────────────────────────────────────────────────────────────────

interface RecordedCall { messages: Array<{ role: string; content: unknown }> }
const recordedCalls: RecordedCall[] = [];
const responseQueue = vi.fn();
const auditEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];

// The auto-share of a fetched page distils it with a model call of its own (autoShareUsefulFinding):
// answered here, so it does not take the run's next scripted response.
const answer = (messages: unknown) => {
  const list = messages as RecordedCall["messages"];
  if (String(list[0]?.content ?? "").startsWith("You are an evidence-distillation step")) {
    return { content: "Bremen heute: 7 °C, Regenrisiko 0 %.", tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" };
  }
  recordedCalls.push({ messages: list });
  return responseQueue();
};
vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown) { return answer(messages); }
    async completeViaStream(messages: unknown) { return answer(messages); }
  },
}));

vi.mock("../audit/logger.js", async (importActual) => ({
  ...(await importActual<typeof import("../audit/logger.js")>()),
  logAudit: (event: string, payload: Record<string, unknown>) => { auditEvents.push({ event, payload }); },
}));

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({ content: "", tool_calls: [{ id, name, arguments: args }], usage, finishReason: "tool_calls" });
const text = (content: string) => ({ content, tool_calls: [], usage, finishReason: "stop" });
type Fake = (args: Record<string, unknown>, ctx: ToolContext) => ToolResult | Promise<ToolResult>;

async function runProbe(responses: unknown[], options: { agent: string; tools: string[]; fakes: Record<string, Fake>; parentSessionId?: string; maxIterations?: number; task?: string }) {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-sub-agent-relay-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    subAgents: {
      [options.agent]: { description: "Probe agent.", systemPrompt: "Do the task with your tools, then answer.", tools: options.tools, maxIterations: options.maxIterations ?? 10 },
      researcher: { description: "Finds current facts on the web.", systemPrompt: "Research.", tools: ["web_search", "web_fetch"], maxIterations: 6 },
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  vi.resetModules();
  const queue = [...responses];
  responseQueue.mockImplementation(() => queue.shift() ?? text("Fallback answer."));
  const { registerTool, unregisterTool } = await import("../tools/registry.js");
  for (const [name, fake] of Object.entries(options.fakes)) {
    registerTool({ name, description: name, parameters: { type: "object", properties: {} }, async execute(args, ctx) { return await fake(args, ctx); } });
  }
  try {
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    return await runSubAgentWithStats({
      agentName: options.agent,
      task: options.task ?? "Wie wird das Wetter heute Nachmittag in Bremen?",
      parentSessionId: options.parentSessionId ?? "parent-relay",
      workspacePath: tempDir,
    });
  } finally {
    for (const name of Object.keys(options.fakes)) unregisterTool(name);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const userMessages = () => recordedCalls.flatMap((call) => call.messages).filter((message) => message.role === "user").map((message) => String(message.content));
const toolMessages = () => recordedCalls.flatMap((call) => call.messages).filter((message) => message.role === "tool").map((message) => String(message.content));
const audited = (event: string) => auditEvents.filter((entry) => entry.event === event);

describe("a coordinator run", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    recordedCalls.length = 0;
    auditEvents.length = 0;
    responseQueue.mockReset();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
  });

  it("passes its one delegation's answer on when it replies with the marker", async () => {
    const result = await runProbe([
      toolCall("d1", "delegate_to_agent", { agentName: "researcher", task: "Wetter Bremen heute Nachmittag mit Quelle" }),
      text(RELAY_MARKER),
    ], { agent: "relay_coordinator", tools: ["delegate_to_agent"], fakes: { delegate_to_agent: () => delegated(WEATHER) } });

    expect(result.output).toContain("| 12–16 Uhr | sonnig | 7 °C | 0 % |");
    expect(result.output).toContain("wetter-nord.example/bremen/heute");
    expect(result.output).not.toContain(RELAY_MARKER);
    expect(result.output).not.toContain("[researcher]:");
    expect(audited("sub_agent_delegation_relayed")).toHaveLength(1);
    expect(audited("sub_agent_delegation_relayed")[0]!.payload).toMatchObject({ agentName: "relay_coordinator", relayedAgent: "researcher" });
    // Two model calls: the delegation and the marker. Nothing written a second time.
    expect(recordedCalls).toHaveLength(2);
    // The offer was on the delegation's result, where the model read it.
    expect(toolMessages().filter((message) => message.includes(RELAY_OFFER))).toHaveLength(1);
  }, 30_000);

  it("is asked once to write the answer itself when a fan-out came last", async () => {
    const result = await runProbe([
      toolCall("d1", "delegate_to_agent", { agentName: "researcher", task: "Wetter Bremen" }),
      toolCall("p1", "parallel_delegate", { tasks: [{ task: "Wetter Bremen" }, { task: "DAX-Stand" }] }),
      text(RELAY_MARKER),
      text("Bremen: 7 °C, trocken. DAX: 19.482 Punkte. Quellen: wetter-nord.example, boerse-live.example"),
    ], {
      agent: "relay_coordinator",
      tools: ["delegate_to_agent", "parallel_delegate"],
      fakes: {
        delegate_to_agent: () => delegated(WEATHER),
        parallel_delegate: () => ({ success: true, output: `${formatDelegatedOutput("researcher", WEATHER)}\n\n---\n\n${formatDelegatedOutput("researcher", "DAX 19.482 Punkte. Quelle: boerse-live.example")}` }),
      },
    });

    expect(audited("sub_agent_delegation_relayed")).toHaveLength(0);
    expect(audited("sub_agent_relay_refused")).toHaveLength(1);
    expect(userMessages()).toContain(RELAY_UNAVAILABLE_CORRECTION);
    expect(result.output).toContain("19.482");
  }, 30_000);

  it("does not pass on a delegation that failed", async () => {
    const result = await runProbe([
      toolCall("d1", "delegate_to_agent", { agentName: "researcher", task: "Wetter Bremen" }),
      text(RELAY_MARKER),
      text("Das Wetter für Bremen ließ sich nicht ermitteln: die Suche fand keine aktuelle Quelle."),
    ], {
      agent: "relay_coordinator",
      tools: ["delegate_to_agent"],
      fakes: { delegate_to_agent: () => ({ success: false, output: "", error: "researcher: no source found", metadata: { agentName: "researcher", delegationSucceeded: false } }) },
    });

    expect(audited("sub_agent_delegation_relayed")).toHaveLength(0);
    expect(audited("sub_agent_relay_refused")).toHaveLength(1);
    expect(result.output).toContain("ließ sich nicht ermitteln");
    expect(toolMessages().some((message) => message.includes(RELAY_OFFER))).toBe(false);
  }, 30_000);
});

describe("two delegations in one response", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    recordedCalls.length = 0;
    auditEvents.length = 0;
    responseQueue.mockReset();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
  });

  it("are two answers: neither is offered, and the marker is refused", async () => {
    const both = {
      content: "",
      tool_calls: [
        { id: "d1", name: "delegate_to_agent", arguments: { agentName: "researcher", task: "Wetter Bremen" } },
        { id: "d2", name: "delegate_to_agent", arguments: { agentName: "researcher", task: "DAX-Stand" } },
      ],
      usage,
      finishReason: "tool_calls",
    };
    const result = await runProbe([both, text(RELAY_MARKER), text("Bremen: 7 °C. DAX: 19.482 Punkte.")], {
      agent: "relay_coordinator",
      tools: ["delegate_to_agent"],
      fakes: { delegate_to_agent: (args) => delegated(String(args["task"]).includes("DAX") ? "DAX 19.482 Punkte. Quelle: boersenticker24.de" : WEATHER) },
    });

    expect(toolMessages().some((message) => message.includes(RELAY_OFFER))).toBe(false);
    expect(audited("sub_agent_relay_refused")).toHaveLength(1);
    expect(result.output).toContain("19.482");
    expect(result.output).toContain("7 °C");
  }, 30_000);
});

describe("the evidence checkpoint", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    recordedCalls.length = 0;
    auditEvents.length = 0;
    responseQueue.mockReset();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
  });

  // Over the 5,120 characters that make a fetch substantive evidence, in distinct lines as a real
  // page has them (repeated lines would be collapsed before they are counted).
  const page = (url: string): ToolResult => ({
    success: true,
    output: `**Content from:** ${url}\n\nBremen heute: 7 °C, Regenrisiko 0 %.\n${Array.from({ length: 80 }, (_, i) => `Weitere Orte und Themen ${i + 1}: Hamburg, Kiel, Lübeck, Rostock — Übersicht und Archiv.`).join("\n")}`,
  });
  const twoPages = [
    toolCall("f1", "web_fetch", { url: "https://wetter-nord.example/bremen" }),
    toolCall("f2", "web_fetch", { url: "https://klima-portal.example/bremen" }),
    text("Bremen heute Nachmittag: 7 °C, Regenrisiko 0 %. Quellen: wetter-nord.example, klima-portal.example"),
  ];
  const checkpointed = () => toolMessages().some((message) => message.includes("[EVIDENCE CHECKPOINT]"));

  it("is not appended for a run the main assistant delegated, with budget to spare", async () => {
    await runProbe(twoPages, { agent: "fetch_probe", tools: ["web_fetch", "share_finding"], fakes: { web_fetch: (args) => page(String(args["url"])) }, maxIterations: 12 });
    expect(checkpointed()).toBe(false);
  }, 30_000);

  it("is appended for a run under a coordinator, whose siblings read what it shares", async () => {
    await runProbe(twoPages, { agent: "fetch_probe", tools: ["web_fetch", "share_finding"], fakes: { web_fetch: (args) => page(String(args["url"])) }, maxIterations: 12, parentSessionId: "sub:parent-relay:web_task_coordinator:1" });
    expect(checkpointed()).toBe(true);
  }, 30_000);

  it("has a direct run told that its answer is the result, and a run under a coordinator not", async () => {
    const firstUserMessage = () => String(recordedCalls[0]?.messages.find((message) => message.role === "user")?.content ?? "");
    await runProbe([text("Bremen: 7 °C.")], { agent: "fetch_probe", tools: ["web_fetch", "share_finding"], fakes: { web_fetch: (args) => page(String(args["url"])) } });
    expect(firstUserMessage()).toContain(DIRECT_RUN_SHARE_NOTICE);
    recordedCalls.length = 0;
    await runProbe([text("Bremen: 7 °C.")], { agent: "fetch_probe", tools: ["web_fetch", "share_finding"], fakes: { web_fetch: (args) => page(String(args["url"])) }, parentSessionId: "sub:parent-relay:web_task_coordinator:1" });
    expect(firstUserMessage()).not.toContain(DIRECT_RUN_SHARE_NOTICE);
    recordedCalls.length = 0;
    await runProbe([text("Bremen: 7 °C.")], { agent: "fetch_probe", tools: ["web_fetch"], fakes: { web_fetch: (args) => page(String(args["url"])) } });
    expect(firstUserMessage()).not.toContain(DIRECT_RUN_SHARE_NOTICE);
  }, 30_000);

  it("is appended for a run whose iterations are running out", async () => {
    await runProbe(twoPages, { agent: "fetch_probe", tools: ["web_fetch", "share_finding"], fakes: { web_fetch: (args) => page(String(args["url"])) }, maxIterations: 5 });
    expect(checkpointed()).toBe(true);
  }, 30_000);
});
