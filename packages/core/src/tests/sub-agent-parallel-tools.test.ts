import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE NETWORK READS OF ONE RESPONSE RUN SIDE BY SIDE.
 *
 * The sub-agent's tool loop ran a response's calls one by one, each after the last one's result was
 * processed: a researcher's three searches took the sum of their times (session e2b53b6f: 3
 * searches 2.4 s, 2 fetches 23.5 s, 3 fetches 3.9 s, all in sequence). Its web_search, web_fetch and
 * url_inspect calls now start together (agent/sub-agent.ts prefetchParallelToolCalls), and the loop
 * takes each result in the response's order, through the same guards. Nothing else runs early: not
 * a tool outside that set, not a call the agent may not make.
 */

interface ToolRun { tool: string; query: string; startedAt: number; endedAt: number }

const runs: ToolRun[] = [];
const responseQueue = vi.fn();
const auditEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
/** The tool messages each worker call carried, in order. */
const toolMessagesPerCall: Array<Array<{ tool_call_id?: string; content: string }>> = [];

function text(content: string) {
  return { content, tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" };
}

function calls(...entries: Array<[string, string, Record<string, unknown>]>) {
  return {
    content: "",
    tool_calls: entries.map(([id, name, args]) => ({ id, name, arguments: args })),
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "tool_calls",
  };
}

function record(messages: unknown) {
  const msgs = messages as Array<{ role: string; content: unknown; tool_call_id?: string }>;
  // The evidence distillation shares the provider; it finds nothing here.
  if (msgs.some((m) => m.role === "system" && /evidence-distillation step/i.test(String(m.content)))) return Promise.resolve(text("NONE"));
  toolMessagesPerCall.push(msgs.filter((m) => m.role === "tool").map((m) => ({ tool_call_id: m.tool_call_id, content: String(m.content) })));
  return responseQueue();
}

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown) { return record(messages); }
    async completeViaStream(messages: unknown) { return record(messages); }
  },
}));

vi.mock("../audit/logger.js", async (importActual) => ({
  ...(await importActual<typeof import("../audit/logger.js")>()),
  logAudit: (event: string, payload: Record<string, unknown>) => { auditEvents.push({ event, payload }); },
}));

const tempDir = mkdtempSync(join(tmpdir(), "starlingai-sub-agent-parallel-tools-"));
const configPath = join(tempDir, "starlingai.json");
process.env["SAI_CONFIG_PATH"] = configPath;
writeFileSync(configPath, "{}", "utf8");
const { runSubAgentWithStats, prefetchParallelToolCalls, prefetchedResultFor, PARALLEL_SAFE_TOOL_NAMES } = await import("../agent/sub-agent.js");
const { resetConfigForTests } = await import("../config/loader.js");
const { resetSharedMemoryForTests } = await import("../swarm/memory.js");
const { registerTool, unregisterTool } = await import("../tools/registry.js");

const AGENT = "parallel_tools_probe";
const TOOL_DELAY_MS = 150;

function writeTempConfig(tools: string[]): void {
  writeFileSync(configPath, JSON.stringify({
    workspacePath: tempDir,
    agents: { defaultContainerized: false },
    subAgents: {
      [AGENT]: {
        description: "Probe specialist that exercises side-by-side network reads.",
        systemPrompt: "Gather evidence with the tools, then answer.",
        tools,
        maxIterations: 3,
      },
    },
  }), "utf8");
  resetConfigForTests();
}

/** A fake tool that takes TOOL_DELAY_MS and records when it ran. */
function registerFake(name: string): () => void {
  registerTool({
    name,
    description: `Fake ${name}.`,
    parameters: { type: "object", properties: { query: { type: "string" }, url: { type: "string" }, note: { type: "string" } } },
    async execute(args) {
      const query = String(args["query"] ?? args["url"] ?? args["note"] ?? "");
      const startedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, TOOL_DELAY_MS));
      runs.push({ tool: name, query, startedAt, endedAt: Date.now() });
      return { success: true, output: `${name} result for ${query}` } as never;
    },
  });
  return () => unregisterTool(name);
}

async function runProbe(tools: string[], responses: unknown[]) {
  writeTempConfig(tools);
  const queue = [...responses];
  responseQueue.mockImplementation(() => Promise.resolve(queue.shift() ?? text("Fallback answer.")));
  return runSubAgentWithStats({
    agentName: AGENT,
    task: "Find out what is new about the release.",
    parentSessionId: `parent-parallel-tools-${Math.random().toString(36).slice(2)}`,
    workspacePath: tempDir,
  });
}

const doneRows = () => auditEvents
  .filter((row) => row.event === "sub_agent_tool_call" && row.payload["phase"] === "done")
  .map((row) => row.payload);

describe("a response's network reads run side by side", () => {
  const cleanups: Array<() => void> = [];

  afterAll(() => {
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    runs.length = 0;
    auditEvents.length = 0;
    toolMessagesPerCall.length = 0;
    responseQueue.mockReset();
    resetConfigForTests();
    await resetSharedMemoryForTests();
  });

  it("starts three searches together, and hands their results back in the response's order", async () => {
    cleanups.push(registerFake("web_search"));

    await runProbe(["web_search"], [
      calls(["s1", "web_search", { query: "alpha" }], ["s2", "web_search", { query: "beta" }], ["s3", "web_search", { query: "gamma" }]),
      text("Final answer."),
    ]);

    expect(runs.map((run) => run.query).sort()).toEqual(["alpha", "beta", "gamma"]);
    // Every search started before the first one ended: side by side, not one after another.
    const lastStart = Math.max(...runs.map((run) => run.startedAt));
    const firstEnd = Math.min(...runs.map((run) => run.endedAt));
    expect(lastStart).toBeLessThan(firstEnd);
    // The next model call reads the results in the order the model asked for them.
    const handedBack = toolMessagesPerCall[1] ?? [];
    expect(handedBack.map((message) => message.tool_call_id)).toEqual(["s1", "s2", "s3"]);
    expect(handedBack.map((message) => message.content.includes(`result for ${["alpha", "beta", "gamma"][handedBack.indexOf(message)]}`))).toEqual([true, true, true]);
    expect(doneRows().filter((row) => row["tool"] === "web_search").map((row) => row["ranAlongside"])).toEqual([true, true, true]);
  });

  it("runs a lone search as before, and a tool outside the set only after the reads before it", async () => {
    cleanups.push(registerFake("web_search"), registerFake("research_note"));

    await runProbe(["web_search", "research_note"], [
      calls(["s1", "web_search", { query: "alpha" }]),
      calls(["s2", "web_search", { query: "beta" }], ["n1", "research_note", { note: "keep" }], ["s3", "web_search", { query: "gamma" }]),
      text("Final answer."),
    ]);

    const byQuery = Object.fromEntries(runs.map((run) => [run.query, run]));
    // The lone search of the first response ran as before.
    expect(doneRows().find((row) => row["toolCallId"] === "s1")?.["ranAlongside"]).toBeUndefined();
    // The note is not a network read: it ran in its turn, after the search before it had ended.
    expect(byQuery["keep"]!.startedAt).toBeGreaterThanOrEqual(byQuery["beta"]!.endedAt);
    // The two searches of the second response still ran side by side.
    expect(byQuery["gamma"]!.startedAt).toBeLessThan(byQuery["beta"]!.endedAt);
    expect(doneRows().find((row) => row["toolCallId"] === "n1")?.["ranAlongside"]).toBeUndefined();
  });

  it("never starts a call the agent may not make", async () => {
    cleanups.push(registerFake("web_search"), registerFake("web_fetch"));

    // The agent has web_search only: its web_fetch calls are refused by the loop, and never run.
    await runProbe(["web_search"], [
      calls(["s1", "web_search", { query: "alpha" }], ["f1", "web_fetch", { url: "https://a.example/" }], ["f2", "web_fetch", { url: "https://b.example/" }]),
      text("Final answer."),
    ]);

    expect(runs.filter((run) => run.tool === "web_fetch")).toEqual([]);
    expect(runs.map((run) => run.query)).toEqual(["alpha"]);
  });
});

describe("prefetchParallelToolCalls and prefetchedResultFor", () => {
  const ok = (output: string) => Promise.resolve({ success: true, output });

  it("starts only the parallel-safe calls the run allows, and only when there are two or more", async () => {
    const started: string[] = [];
    const run = (call: { id?: string; name: string }) => { started.push(call.id ?? ""); return ok(call.name); };

    const lone = prefetchParallelToolCalls([{ id: "a", name: "web_search", arguments: {} }, { id: "b", name: "read_file", arguments: {} }], () => true, run);
    expect(lone.size).toBe(0);

    const map = prefetchParallelToolCalls([
      { id: "a", name: "web_search", arguments: { query: "x" } },
      { id: "b", name: "web_fetch", arguments: { url: "https://x.example/" } },
      { id: "c", name: "write_file", arguments: { path: "x" } },
      { id: "d", name: "url_inspect", arguments: { url: "https://y.example/" } },
      { id: "e", name: "web_search", arguments: { query: "blocked" } },
      { name: "web_search", arguments: { query: "no id" } },
    ], (call) => call.arguments["query"] !== "blocked", run);

    expect([...map.keys()]).toEqual(["a", "b", "d"]);
    expect(started).toEqual(["a", "b", "d"]);
    expect([...PARALLEL_SAFE_TOOL_NAMES].sort()).toEqual(["url_inspect", "web_fetch", "web_search"]);
  });

  it("hands a started result only to the same call with the same name and arguments, and forgets it either way", async () => {
    const map = prefetchParallelToolCalls([
      { id: "a", name: "web_search", arguments: { query: "x" } },
      { id: "b", name: "web_search", arguments: { query: "y" } },
      { id: "c", name: "web_fetch", arguments: { url: "https://z.example/" } },
    ], () => true, (call) => ok(String(call.arguments["query"] ?? call.arguments["url"])));

    expect(await prefetchedResultFor(map, { id: "a", name: "web_search" }, { query: "x" })).toEqual({ success: true, output: "x" });
    // Arguments changed on the way (a rewrite in the loop): not this result.
    expect(prefetchedResultFor(map, { id: "b", name: "web_search" }, { query: "y2" })).toBeUndefined();
    // A rerouted call (another tool name): not this result.
    expect(prefetchedResultFor(map, { id: "c", name: "web_search" }, { url: "https://z.example/" })).toBeUndefined();
    expect(map.size).toBe(0);
    expect(prefetchedResultFor(map, { id: "a", name: "web_search" }, { query: "x" })).toBeUndefined();
  });

  it("holds a started call's rejection until the loop takes it, and leaves none unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const map = prefetchParallelToolCalls([
        { id: "a", name: "web_fetch", arguments: { url: "https://a.example/" } },
        { id: "b", name: "web_fetch", arguments: { url: "https://b.example/" } },
      ], () => true, () => Promise.reject(new Error("reset")));
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(prefetchedResultFor(map, { id: "a", name: "web_fetch" }, { url: "https://a.example/" })).rejects.toThrow("reset");
      // "b" is never taken, as a call the loop answered another way.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
