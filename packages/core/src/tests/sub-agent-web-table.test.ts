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
  metadata: { webTable: { source: "url", urls: [url], finalUrls: [url], pagesRead: 1, aggregates: { "sum(4 Südtal)": value }, computed: [value] } },
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

  it("hands up the figure keys of the aggregates web_table computed, and nothing for a run that computed none", async () => {
    const { result } = await runProbe([toolCall("t1", "web_table", { url: "http://93.184.215.14/lager.html", column: "Südtal", aggregates: ["sum"] }), text("Südtal: 596 Stück.")], {
      maxIterations: 4,
      agentTools: ["web_table"],
      fakes: { web_table: () => computed("596") },
    });
    expect(result.computedAggregateKeys).toEqual(["596"]);

    const plain = await runProbe([toolCall("f1", "web_fetch", { url: "http://93.184.215.14/lager.html" }), text("Südtal: 596 Stück.")], {
      maxIterations: 4,
      agentTools: ["web_fetch"],
      fakes: { web_fetch: () => ({ success: true, output: "Lagerbestand: 18 Artikel, Südtal-Spalte." }) },
    });
    expect(plain.result).not.toHaveProperty("computedAggregateKeys");
  }, 30_000);

  it("hands up no key for a min or a max: they are cell values, which any listing of the rows states", async () => {
    // The coverage check is waived when the reply states one of these keys. Recorded from every
    // aggregate, the max (180, NW-2104's stock) waived it for a 10-row listing that showed that row.
    const url = "http://93.184.215.14/lager.html";
    const { result } = await runProbe([toolCall("t1", "web_table", { url, column: "Südtal" }), text("Südtal: 596 Stück.")], {
      maxIterations: 4,
      agentTools: ["web_table"],
      fakes: {
        web_table: () => ({
          success: true,
          output: "count = 18\nsum(column 4 \"Südtal\") = 596 — all 18 rows",
          metadata: { webTable: { source: "url", urls: [url], aggregates: { count: "18", "sum(4 Südtal)": "596", "min(4 Südtal)": "0", "max(4 Südtal)": "180", "avg(4 Südtal)": "33,11" }, computed: ["18", "596", "33,11"] } },
        }),
      },
    });
    expect(result.computedAggregateKeys).toEqual(["18", "596", "3311"]);
  }, 30_000);

  it("delegate_to_agent passes the computed keys up in its metadata", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-sub-agent-web-table-delegate-"));
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      subAgents: { [AGENT]: { description: "Probe specialist that reads web tables.", systemPrompt: "Read the tables, then answer.", tools: ["web_table"], maxIterations: 4 } },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    const queue = [toolCall("t1", "web_table", { url: "http://93.184.215.14/lager.html", column: "Südtal", aggregates: ["sum"] }), text("Gesamtbestand Südtal: 596 Stück.")];
    responseQueue.mockImplementation(() => queue.shift() ?? text("Fallback answer."));
    await import("../tools/sub-agent.js");
    const { registerTool, getTool } = await import("../tools/registry.js");
    registerTool({ name: "web_table", description: "web_table", parameters: { type: "object", properties: {} }, async execute() { return computed("596"); } });
    try {
      const result = await getTool("delegate_to_agent")!.execute(
        { agentName: AGENT, task: "Wie hoch ist der Gesamtbestand am Standort Südtal?" },
        { sessionId: "s-web-table-delegate", workspacePath: tempDir, swarmState: { objective: "test", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: {} } },
      );
      expect(result.success).toBe(true);
      expect(result.metadata?.["computedAggregateKeys"]).toEqual(["596"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

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

/**
 * E2E 2026-10-22: browser_agent read a three-page catalogue, never called web_table, and answered
 * "7 Artikel unter 50 €" beside a list of eight. A run that saw a table on two or more pages and
 * has not computed over it is asked once, before its answer stands.
 */
describe("a table read on several pages", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    recordedCalls.length = 0;
    auditEvents.length = 0;
    responseQueue.mockReset();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
  });

  const page = (n: number, table = true): ToolResult => ({
    success: true,
    output: [
      "### Page",
      `- Page URL: http://93.184.215.14/katalog/seite-${n}.html`,
      `- Page Title: Katalog ${n}`,
      "### Snapshot",
      "```yaml",
      table ? "- table [ref=e5]:\n  - row \"Artikel Preis\" [ref=e6]\n  - row \"Zange 12,90 €\" [ref=e7]" : "- paragraph [ref=e5]: Kontakt",
      "```",
    ].join("\n"),
  });
  const browse = (secondHasTable = true) => ({
    browser_navigate: () => page(1),
    browser_click: () => page(2, secondHasTable),
  });
  const DRAFT = "Unter 50 € kosten 7 Artikel.";
  const nudges = () => auditEvents.filter((e) => e.event === "sub_agent_table_compute_nudged");
  const lastUserMessage = () => String(recordedCalls.at(-1)!.messages.filter((m) => m.role === "user").at(-1)!.content);

  it("asks once to compute over it, and keeps the answer as written on KEEP", async () => {
    const { result } = await runProbe(
      [toolCall("n1", "browser_navigate", { url: "http://93.184.215.14/katalog/" }), toolCall("c1", "browser_click", { ref: "e9" }), text(DRAFT), text("KEEP")],
      { maxIterations: 8, agentTools: ["browser_navigate", "browser_click", "web_table"], fakes: { ...browse(), web_table: () => computed("8") } },
    );
    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]!.payload["pages"]).toBe(2);
    expect(lastUserMessage()).toContain("http://93.184.215.14/katalog/seite-1.html, http://93.184.215.14/katalog/seite-2.html");
    expect(result.output).toContain(DRAFT);
    expect(result.output).not.toMatch(/KEEP/);
  }, 30_000);

  it("answers with what web_table computed when the model computes", async () => {
    const { result, spies } = await runProbe(
      [
        toolCall("n1", "browser_navigate", { url: "http://93.184.215.14/katalog/" }),
        toolCall("c1", "browser_click", { ref: "e9" }),
        text(DRAFT),
        toolCall("t1", "web_table", { url: ["http://93.184.215.14/katalog/seite-1.html", "http://93.184.215.14/katalog/seite-2.html"], column: "Preis", aggregates: ["count"], where: [{ column: "Preis", op: "<", value: 50 }] }),
        text("Unter 50 € kosten 8 Artikel."),
      ],
      { maxIterations: 8, agentTools: ["browser_navigate", "browser_click", "web_table"], fakes: { ...browse(), web_table: () => computed("8") } },
    );
    expect(spies["web_table"]).toHaveBeenCalledTimes(1);
    expect(result.output).toContain("8 Artikel");
    expect(nudges()).toHaveLength(1);
  }, 30_000);

  // The next run called web_table on its own, for the open tab only (page 3 of 3), and counted the
  // other pages by eye.
  const readOnly = (...urls: string[]): ToolResult => ({
    success: true,
    output: `max(column 2 "Preis") = 79,00 — all 6 rows\nread: ${urls.join(", ")}`,
    metadata: { webTable: { source: "tab", urls, finalUrls: urls, pagesRead: urls.length, computed: [] } },
  });
  const P1 = "http://93.184.215.14/katalog/seite-1.html";
  const P2 = "http://93.184.215.14/katalog/seite-2.html";

  it("asks when web_table read only some of the pages, naming the rest", async () => {
    await runProbe(
      [toolCall("n1", "browser_navigate", { url: "http://93.184.215.14/katalog/" }), toolCall("c1", "browser_click", { ref: "e9" }), toolCall("t1", "web_table", { source: "tab", aggregates: ["max"] }), text(DRAFT), text("KEEP")],
      { maxIterations: 8, agentTools: ["browser_navigate", "browser_click", "web_table"], fakes: { ...browse(), web_table: () => readOnly(P2) } },
    );
    expect(nudges()).toHaveLength(1);
    expect(lastUserMessage()).toContain(`web_table read only 1 of them, not ${P1}.`);
  }, 30_000);

  it("does not ask when web_table read every page the table was seen on", async () => {
    await runProbe(
      [toolCall("n1", "browser_navigate", { url: "http://93.184.215.14/katalog/" }), toolCall("c1", "browser_click", { ref: "e9" }), toolCall("t1", "web_table", { url: [P1, P2], aggregates: ["count"] }), text("Unter 50 € kosten 8 Artikel.")],
      { maxIterations: 8, agentTools: ["browser_navigate", "browser_click", "web_table"], fakes: { ...browse(), web_table: () => readOnly(P1, P2) } },
    );
    expect(nudges()).toEqual([]);
  }, 30_000);

  it("does not ask for a table seen on one page only", async () => {
    await runProbe(
      [toolCall("n1", "browser_navigate", { url: "http://93.184.215.14/katalog/" }), toolCall("c1", "browser_click", { ref: "e9" }), text(DRAFT)],
      { maxIterations: 8, agentTools: ["browser_navigate", "browser_click", "web_table"], fakes: { ...browse(false), web_table: () => computed("8") } },
    );
    expect(nudges()).toEqual([]);
  }, 30_000);

  it("does not ask a run without web_table", async () => {
    await runProbe(
      [toolCall("n1", "browser_navigate", { url: "http://93.184.215.14/katalog/" }), toolCall("c1", "browser_click", { ref: "e9" }), text(DRAFT)],
      { maxIterations: 8, agentTools: ["browser_navigate", "browser_click"], fakes: browse() },
    );
    expect(nudges()).toEqual([]);
  }, 30_000);
});

describe("pageShowingTable", () => {
  it.each([
    ["browser_click", {}, "- Page URL: http://h.test/a/seite-2.html\n```yaml\n- table [ref=e1]:\n  - row", "http://h.test/a/seite-2.html"],
    ["browser_navigate", { url: "http://h.test/a/" }, "- Page URL: http://h.test/a/seite-1.html#top\n- grid [ref=e1]", "http://h.test/a/seite-1.html"],
    ["browser_snapshot", {}, "- Page URL: http://h.test/x\n- list [ref=e1]:\n  - listitem: table of contents", null],
    ["web_fetch", { url: "http://h.test/p" }, "| Artikel | Preis |\n|---|---|\n| Zange | 12,90 |", "http://h.test/p"],
    ["web_fetch", { url: "http://h.test/p" }, "<table><tr><td>1</td></tr></table>", "http://h.test/p"],
    ["web_fetch", { url: "http://h.test/p" }, "Price | per | unit", null],
    ["read_file", { path: "a.md" }, "| a |\n|---|", null],
  ])("%s → %s", async (tool, args, result, expected) => {
    const { pageShowingTable } = await import("../agent/sub-agent.js");
    expect(pageShowingTable(tool, args as Record<string, unknown>, result)).toBe(expected);
  });
});
