import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, ToolResult } from "../tools/registry.js";

/**
 * web_table inside a sub-agent run: its per-run call cap, the dead-fetch streak it feeds only
 * through fetchFailed, the rule that lets it compute (and only compute) after the evidence strip,
 * and the consecutive-duplicate cache, which may not replay a read of the browser tab. The tools
 * are fakes; what is asserted is what the loop let them run and what it told the model.
 */

interface RecordedCall {
  messages: Array<{ role: string; content: unknown }>;
}

const recordedCalls: RecordedCall[] = [];
const responseQueue = vi.fn();
const auditEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown) {
      recordedCalls.push({ messages: messages as RecordedCall["messages"] });
      return responseQueue();
    }
    async completeViaStream(messages: unknown) {
      recordedCalls.push({ messages: messages as RecordedCall["messages"] });
      return responseQueue();
    }
  },
}));

vi.mock("../audit/logger.js", async (importActual) => ({
  ...(await importActual<typeof import("../audit/logger.js")>()),
  logAudit: (event: string, payload: Record<string, unknown>) => { auditEvents.push({ event, payload }); },
}));

const AGENT = "table_probe";

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    content: "",
    tool_calls: [{ id, name, arguments: args }],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "tool_calls",
  };
}

function text(content: string) {
  return { content, tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" };
}

type Fake = (args: Record<string, unknown>, ctx: ToolContext) => ToolResult | Promise<ToolResult>;

async function runProbe(responses: unknown[], options: { maxIterations: number; agentTools: string[]; fakes: Record<string, Fake>; orchestration?: Record<string, unknown> }) {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-sub-agent-web-table-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    ...(options.orchestration ? { orchestration: options.orchestration } : {}),
    subAgents: {
      [AGENT]: {
        description: "Probe specialist that reads web tables.",
        systemPrompt: "Read the tables with the tools, then answer.",
        tools: options.agentTools,
        maxIterations: options.maxIterations,
      },
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  vi.resetModules();
  const queue = [...responses];
  responseQueue.mockImplementation(() => queue.shift() ?? text("Fallback answer."));
  const { registerTool, unregisterTool } = await import("../tools/registry.js");
  const spies: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const [name, fake] of Object.entries(options.fakes)) {
    const spy = vi.fn(fake);
    spies[name] = spy;
    registerTool({ name, description: name, parameters: { type: "object", properties: {} }, async execute(args, ctx) { return await spy(args, ctx); } });
  }
  try {
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    const result = await runSubAgentWithStats({ agentName: AGENT, task: "Compute the total from the table.", parentSessionId: "parent-web-table", workspacePath: tempDir });
    return { result, spies };
  } finally {
    for (const name of Object.keys(options.fakes)) unregisterTool(name);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const computed = (value: string, url = "http://93.184.215.14/lager.html"): ToolResult => ({
  success: true,
  output: `sum(column 4 "Südtal") = ${value} — all 18 rows, 18 numeric of 18 (whole numbers)\nread: ${url}, table 1, 18 rows × 6 columns`,
  metadata: { webTable: { source: "url", urls: [url], finalUrls: [url], pagesRead: 1, aggregates: { "sum(4 Südtal)": value } } },
});
const fetchFailed = (status: number): ToolResult => ({
  success: false,
  output: "",
  error: `HTTP ${status} from http://93.184.215.14/weg.html; nothing was computed`,
  metadata: { webTable: { source: "url", urls: ["http://93.184.215.14/weg.html"], fetchFailed: true } },
});
const argumentError = (): ToolResult => ({ success: false, output: "", error: "aggregates may hold sum, count, min, max, avg; \"median\" is none of them", rejectedBeforeEffect: true });

const toolMessages = () => recordedCalls.flatMap((call) => call.messages).filter((message) => message.role === "tool").map((message) => String(message.content));
const plateauRows = () => auditEvents.filter((e) => e.event === "sub_agent_synthesis_forced" && e.payload["reason"] === "non_productive_fetch_plateau");

describe("web_table in a sub-agent run", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    recordedCalls.length = 0;
    auditEvents.length = 0;
    responseQueue.mockReset();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
  });

  it("runs web_table at most 8 times per run, and answers the 9th call with the cap", async () => {
    const calls = Array.from({ length: 9 }, (_, i) => toolCall(`t${i}`, "web_table", { url: `http://93.184.215.14/p${i}.html`, aggregates: ["count"] }));
    const { spies } = await runProbe([...calls, text("Done.")], {
      maxIterations: 14,
      agentTools: ["web_table"],
      fakes: { web_table: (args) => computed(String(args["url"]).length.toString()) },
    });
    expect(spies["web_table"]).toHaveBeenCalledTimes(8);
    expect(toolMessages()).toContain("Tool 'web_table' has been called 8 times this run (limit: 8). You must proceed without calling it again. Work with the results you already have.");
  }, 30_000);

  it("counts four web_table calls that reached no page as a dead-fetch streak", async () => {
    const calls = Array.from({ length: 4 }, (_, i) => toolCall(`t${i}`, "web_table", { url: `http://93.184.215.14/weg${i}.html`, aggregates: ["count"] }));
    await runProbe([...calls, text("Done.")], {
      maxIterations: 10,
      agentTools: ["web_table"],
      fakes: { web_table: () => fetchFailed(404) },
    });
    expect(plateauRows()).toHaveLength(1);
    expect(plateauRows()[0]!.payload["nonProductiveFetches"]).toBe(4);
  }, 30_000);

  it("does not count argument errors, and a computed 429 resets the streak instead of extending it", async () => {
    const args = (i: number) => ({ url: `http://93.184.215.14/p${i}.html`, aggregates: ["count"] });
    await runProbe([...Array.from({ length: 4 }, (_, i) => toolCall(`a${i}`, "web_table", args(i))), text("Done.")], {
      maxIterations: 10,
      agentTools: ["web_table"],
      fakes: { web_table: argumentError },
    });
    expect(plateauRows()).toHaveLength(0);

    auditEvents.length = 0;
    recordedCalls.length = 0;
    const answers = [fetchFailed(503), fetchFailed(503), fetchFailed(503), computed("429"), fetchFailed(503)];
    await runProbe([...Array.from({ length: 5 }, (_, i) => toolCall(`b${i}`, "web_table", args(i))), text("Done.")], {
      maxIterations: 12,
      agentTools: ["web_table"],
      fakes: { web_table: () => answers.shift()! },
    });
    expect(plateauRows()).toHaveLength(0);
  }, 30_000);

  it("after the evidence strip, lets web_table compute over pages the run read and refuses anything else", async () => {
    // The strip, reached as sub-agent-tool-list-stability.test.ts reaches it: ten rich pages
    // through web_fetch, distillation off, an empty bounded synthesis.
    const page = (index: number): ToolResult => ({
      success: true,
      output: [
        `Report ${index}: the ${2020 + index} unit shipped 1${index}4,000 pieces at EUR ${index}9.90 each.`,
        `Section ${index}A records a peak throughput of ${index}12 MB/s sustained over 48 hours of testing.`,
        `Section ${index}B lists supplier ${index} with lead time ${index * 3 + 5} days and a defect rate of 0.${index}4 %.`,
        `Section ${index}C: revenue rose ${index * 2 + 3} % year on year to EUR ${index}.7 million in the same period.`,
        `Section ${index}D notes the certification number CE-${index}0${index}1-${index}9 issued on 12 March ${2020 + index}.`,
        `Section ${index}E measures idle draw at ${index}.8 W and peak draw at ${index * 4 + 11} W under full load.`,
        `Section ${index}F gives the housing as ${index}4 x ${index}2 x 1${index} mm weighing ${index}80 g without the bracket.`,
        `Section ${index}G cites warranty terms of ${index + 2} years and a mean time between failures of ${index}5,000 hours.`,
      ].join("\n"),
    });
    const read = "https://example.test/report-3";
    const { spies } = await runProbe([
      ...Array.from({ length: 10 }, (_, i) => toolCall(`f${i}`, "web_fetch", { url: `https://example.test/report-${i}` })),
      text(""),
      {
        content: "",
        tool_calls: [
          { id: "t-extract", name: "web_table", arguments: { url: read } },
          { id: "t-compute", name: "web_table", arguments: { url: `${read}#tabelle`, column: "Bestand", aggregates: ["sum"] } },
          { id: "t-new", name: "web_table", arguments: { url: "https://example.test/report-after-strip", column: "Bestand", aggregates: ["sum"] } },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      },
      text("Final answer from the collected evidence."),
    ], {
      maxIterations: 16,
      agentTools: ["web_search", "web_fetch", "share_finding", "web_table"],
      orchestration: { distillSharedFacts: false },
      fakes: {
        web_search: () => ({ success: true, output: "search result" }),
        web_fetch: (args) => page(Number(/(\d+)$/.exec(String(args["url"]))?.[1] ?? "0")),
        web_table: (args) => computed("596", String(args["url"])),
      },
    });
    expect(auditEvents.filter((e) => e.event === "sub_agent_synthesis_forced" && e.payload["reason"] === "sufficient_evidence_tools_stripped")).toHaveLength(1);
    expect(spies["web_table"]).toHaveBeenCalledTimes(1);
    expect(spies["web_table"]!.mock.calls[0]![0]).toEqual({ url: `${read}#tabelle`, column: "Bestand", aggregates: ["sum"] });
    const refusals = toolMessages().filter((message) => message.startsWith("Tool 'web_table' has been disabled"));
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toContain("web_table may still compute (aggregates, where, group_by) over pages this run has already read.");
    expect(auditEvents.filter((e) => e.event === "sub_agent_tool_blocked")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ tool: "web_table", reason: "evidence_cap_enforced" }) }),
      expect.objectContaining({ payload: expect.objectContaining({ tool: "web_table", reason: "evidence_cap_enforced" }) }),
    ]);
  }, 60_000);

  it("forgets the run's web_table page count when the run ends", async () => {
    let session = "";
    const budget = { used: -1 };
    await runProbe([toolCall("t1", "web_table", { url: "http://93.184.215.14/lager.html", aggregates: ["count"] }), text("Done.")], {
      maxIterations: 4,
      agentTools: ["web_table"],
      fakes: {
        // Charges the call's session as the real tool does: the run's own sub-session id.
        web_table: async (_args, ctx) => {
          const { chargeWebTablePages, webTablePagesUsed } = await import("../tools/web-table-budget.js");
          session = ctx.sessionId;
          chargeWebTablePages(session, 3);
          budget.used = webTablePagesUsed(session);
          return computed("18");
        },
      },
    });
    expect(session).toMatch(/^sub:/);
    expect(budget.used).toBe(3);
    const { webTablePagesUsed } = await import("../tools/web-table-budget.js");
    expect(webTablePagesUsed(session)).toBe(0);
  }, 30_000);

  it("never answers a second read of the browser tab from the cache, and still caches a repeated URL read", async () => {
    let tabReads = 0;
    const { spies } = await runProbe([
      toolCall("t1", "web_table", { source: "tab", aggregates: ["count"] }),
      toolCall("n1", "browser_navigate", { url: "http://93.184.215.14/produkte/seite-2.html" }),
      toolCall("t2", "web_table", { source: "tab", aggregates: ["count"] }),
      toolCall("u1", "web_table", { url: "http://93.184.215.14/lager.html", aggregates: ["count"] }),
      toolCall("n2", "browser_navigate", { url: "http://93.184.215.14/produkte/seite-3.html" }),
      toolCall("u2", "web_table", { url: "http://93.184.215.14/lager.html", aggregates: ["count"] }),
      text("Done."),
    ], {
      maxIterations: 12,
      agentTools: ["web_table", "browser_navigate"],
      fakes: {
        web_table: (args) => args["source"] === "tab" ? computed(String(6 + 2 * tabReads++)) : computed("18"),
        browser_navigate: (args) => ({ success: true, output: `### Page\n- Page URL: ${String(args["url"])}` }),
      },
    });
    const calls = spies["web_table"]!.mock.calls.map(([args]) => (args as Record<string, unknown>)["source"] ?? "url");
    expect(calls).toEqual(["tab", "tab", "url"]);
    expect(toolMessages().some((message) => message.startsWith("sum(column 4 \"Südtal\") = 8 "))).toBe(true);
  }, 30_000);
});
