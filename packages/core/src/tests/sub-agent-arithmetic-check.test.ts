import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../tools/registry.js";

const completeMock = vi.fn();

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

/**
 * orchestration.subAgentArithmeticCheck in the sub-agent loop. The answer is the one browser_agent
 * gave on 2026-10-09: 18 stock values that come to 604, stated as 609. "shadow" (the default) only
 * writes an audit row; "nudge" sends the run back once, holds the first answer, and returns it on
 * any exit other than a real corrected answer.
 */
type Message = { role: string; content?: string | null };

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const call = (id: string, name: string, args: Record<string, unknown>) =>
  ({ content: "", tool_calls: [{ id, name, arguments: args }], usage, finishReason: "tool_calls" });
const answer = (content: string) => ({ content, tool_calls: [], usage, finishReason: "stop" });

const CHAIN = "**Rechnung:** 17 + 9 + 1 + 38 + 22 + 0 + 19 + 30 + 5 + 0 + 4 + 2 + 95 + 180 + 36 + 44 + 29 + 73 = **609**";
const WRONG = `Lagerbestand am Standort Südtal laut Tabelle:\n\n${CHAIN}\n\nGesamtbestand Südtal: 609 Stück.`;
const RIGHT = "Gesamtbestand am Standort Südtal: 596 Stück, berechnet über alle 18 Zeilen der Tabelle.";
const WRONG_AGAIN = "Gesamtbestand am Standort Südtal neu gerechnet:\n\nSumme: 17 + 9 + 1 + 38 = 66";
const PAGE: ToolResult = { success: true, output: "Lagerbestand: 18 Artikel in drei Lagern. Südtal-Spalte siehe Tabelle; Stand 30.09.2026." };

describe("the arithmetic check on a sub-agent's final answer", () => {
  let tempDir = "";

  const writeConfig = (mode?: "off" | "shadow" | "nudge") => {
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      workspacePath: tempDir,
      ...(mode ? { orchestration: { subAgentArithmeticCheck: mode } } : {}),
      subAgents: {
        counter: { description: "Reads a page and totals a column.", systemPrompt: "Read the page, then answer.", tools: ["web_fetch", "share_finding"], maxIterations: 6 },
        table_counter: { description: "Reads a page and totals a column with web_table.", systemPrompt: "Read the page, then answer.", tools: ["web_fetch", "web_table"], maxIterations: 6 },
        tight_table_counter: { description: "Totals a column, briefly.", systemPrompt: "Answer.", tools: ["web_table"], maxIterations: 2 },
        one_shot_counter: { description: "Totals a column in one go.", systemPrompt: "Answer.", tools: ["web_fetch"], maxIterations: 1 },
        slow_counter: { description: "Totals a column against a short deadline.", systemPrompt: "Read the page, then answer.", tools: ["web_fetch"], maxIterations: 6, turnTimeoutMs: 5000 },
        coder: { description: "Runs code in the sandbox.", systemPrompt: "Run the script in the sandbox and report what it printed.", tools: ["shell_exec"], maxIterations: 6 },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
  };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-arithmetic-check-"));
    writeConfig();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  async function useMode(mode: "off" | "shadow" | "nudge") {
    writeConfig(mode);
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  }

  const registerTools = async (handlers: Record<string, (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>>) => {
    const { registerTool } = await import("../tools/registry.js");
    for (const [name, execute] of Object.entries(handlers)) {
      registerTool({ name, description: `Fake ${name}.`, parameters: { type: "object", properties: {} }, async execute(args) { return execute(args); } });
    }
  };

  /** The model's replies in call order; a function entry answers from the messages and signal. */
  const script = (replies: Array<unknown | ((messages: Message[], signal?: AbortSignal) => unknown)>) => {
    let made = 0;
    completeMock.mockImplementation(async (messages: Message[], _tools: unknown, signal?: AbortSignal) => {
      const reply = replies[Math.min(made, replies.length - 1)];
      made += 1;
      return typeof reply === "function" ? (reply as (m: Message[], s?: AbortSignal) => unknown)(messages, signal) : reply;
    });
  };

  const captureAudit = async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const { subscribeToAudit } = await import("../audit/logger.js");
    const unsubscribe = subscribeToAudit((event) => events.push({ type: event.type, data: event.data as Record<string, unknown> }));
    return { events, unsubscribe, rows: (type: string) => events.filter((e) => e.type === "guardrail_flagged" && e.data["type"] === type).map((e) => e.data) };
  };

  const run = async (agentName: string) => {
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    return runSubAgentWithStats({ agentName, task: "Wie hoch ist der Gesamtbestand am Standort Südtal?", parentSessionId: `parent-${agentName}`, workspacePath: tempDir, approvalCallback: async () => true });
  };

  const lastUserMessage = (messages: Message[]) => [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  it("shadow, the default: one audit row, and the run's output and calls are those of \"off\"", async () => {
    await registerTools({ web_fetch: () => PAGE });
    script([call("c1", "web_fetch", { url: "http://shop.test/lager.html" }), answer(WRONG)]);
    const audit = await captureAudit();
    const shadow = await run("counter");
    audit.unsubscribe();
    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(audit.rows("sub_agent_arithmetic_mismatch")).toEqual([expect.objectContaining({
      mode: "shadow", nudged: false, skipReason: "shadow", stated: "609", computed: "604", terms: 18, holdsWebTable: false,
    })]);

    await useMode("off");
    completeMock.mockReset();
    await registerTools({ web_fetch: () => PAGE });
    script([call("c1", "web_fetch", { url: "http://shop.test/lager.html" }), answer(WRONG)]);
    const offAudit = await captureAudit();
    const off = await run("counter");
    offAudit.unsubscribe();
    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(off.output).toBe(shadow.output);
    expect(off.output).toContain("= **609**");
    expect(offAudit.rows("sub_agent_arithmetic_mismatch")).toEqual([]);
  }, 30_000);

  it("nudge with web_table: the second call is told to take the total from web_table, without the in-head sum", async () => {
    await useMode("nudge");
    await registerTools({ web_fetch: () => PAGE, web_table: () => ({ success: true, output: "sum(column 4 \"Südtal\") = 596" }) });
    script([call("c1", "web_fetch", { url: "http://shop.test/lager.html" }), answer(WRONG), answer(RIGHT)]);
    const audit = await captureAudit();
    const result = await run("table_counter");
    audit.unsubscribe();
    expect(completeMock).toHaveBeenCalledTimes(3);
    const nudge = String(lastUserMessage(completeMock.mock.calls[2]![0] as Message[]));
    expect(nudge).toBe("ARITHMETIC CHECK: in your answer, 17 + 9 + … + 73 (18 terms) does not come to 609. Take that total from web_table over the page instead of adding it yourself, then give your complete final answer again.");
    expect(nudge).not.toContain("604");
    expect(result.output).toBe(RIGHT);
    expect(audit.rows("sub_agent_arithmetic_mismatch")).toEqual([expect.objectContaining({ mode: "nudge", nudged: true, holdsWebTable: true })]);
    expect(audit.rows("sub_agent_arithmetic_hold_returned")).toEqual([]);
  }, 30_000);

  it("nudge without web_table: the second call is given the sum of the written terms", async () => {
    await useMode("nudge");
    await registerTools({ web_fetch: () => PAGE });
    script([call("c1", "web_fetch", { url: "http://shop.test/lager.html" }), answer(WRONG), answer(RIGHT)]);
    const result = await run("counter");
    const nudge = String(lastUserMessage(completeMock.mock.calls[2]![0] as Message[]));
    expect(nudge).toBe("ARITHMETIC CHECK: in your answer, 17 + 9 + … + 73 (18 terms) does not come to 609; those terms add up to 604. Check each term against your sources, then give your complete final answer again with the corrected figures.");
    expect(result.output).toBe(RIGHT);
  }, 30_000);

  it("nudge: a second wrong answer is returned as it is, once per run", async () => {
    await useMode("nudge");
    await registerTools({ web_fetch: () => PAGE });
    script([call("c1", "web_fetch", { url: "http://shop.test/lager.html" }), answer(WRONG), answer(WRONG_AGAIN)]);
    const audit = await captureAudit();
    const result = await run("counter");
    audit.unsubscribe();
    expect(completeMock).toHaveBeenCalledTimes(3);
    expect(result.output).toBe(WRONG_AGAIN);
    expect(audit.rows("sub_agent_arithmetic_mismatch")).toEqual([
      expect.objectContaining({ nudged: true }),
      expect.objectContaining({ nudged: false, skipReason: "already_nudged", secondMismatch: true, stated: "66", computed: "65" }),
    ]);
  }, 30_000);

  it("nudge: an answer whose sums are right is returned after one call, as it was", async () => {
    await useMode("nudge");
    await registerTools({ web_fetch: () => PAGE });
    script([call("c1", "web_fetch", { url: "http://shop.test/lager.html" }), answer(RIGHT)]);
    const audit = await captureAudit();
    const result = await run("counter");
    audit.unsubscribe();
    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(result.output).toBe(RIGHT);
    expect(audit.rows("sub_agent_arithmetic_mismatch")).toEqual([]);
  }, 30_000);

  it("nudge: no corrective iteration when the time budget is critical at the answer", async () => {
    await useMode("nudge");
    await registerTools({ web_fetch: async () => { await new Promise((resolve) => setTimeout(resolve, 2_500)); return PAGE; } });
    script([call("c1", "web_fetch", { url: "http://shop.test/lager.html" }), answer(WRONG)]);
    const audit = await captureAudit();
    const result = await run("slow_counter");
    audit.unsubscribe();
    expect(result.output).toBe(WRONG);
    expect(audit.rows("sub_agent_arithmetic_mismatch")).toEqual([expect.objectContaining({ nudged: false, skipReason: "time_critical" })]);
  }, 30_000);

  it("nudge: variant B when web_table has no room for a call and an answer, none on the last iteration", async () => {
    await useMode("nudge");
    await registerTools({ web_table: () => ({ success: true, output: "sum = 596" }), web_fetch: () => PAGE });
    script([answer(WRONG), answer(RIGHT)]);
    const tight = await run("tight_table_counter");
    expect(String(lastUserMessage(completeMock.mock.calls[1]![0] as Message[]))).toContain("those terms add up to 604");
    expect(tight.output).toBe(RIGHT);

    completeMock.mockReset();
    script([answer(WRONG)]);
    const audit = await captureAudit();
    const last = await run("one_shot_counter");
    audit.unsubscribe();
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(last.output).toBe(WRONG);
    expect(audit.rows("sub_agent_arithmetic_mismatch")).toEqual([expect.objectContaining({ nudged: false, skipReason: "no_iterations" })]);
  }, 30_000);

  it("nudge: the deadline firing during the corrective call returns the first answer", async () => {
    await useMode("nudge");
    await registerTools({ web_fetch: () => PAGE });
    const hang = (_messages: Message[], signal?: AbortSignal) => new Promise((_, reject) => {
      if (signal?.aborted) reject(new Error("aborted"));
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    script([call("c1", "web_fetch", { url: "http://shop.test/lager.html" }), answer(WRONG), hang]);
    const audit = await captureAudit();
    const result = await run("slow_counter");
    audit.unsubscribe();
    expect(result.output).toBe(WRONG);
    expect(audit.rows("sub_agent_arithmetic_hold_returned")).toHaveLength(1);
    expect(result.stats.iterations).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("nudge: a provider error on the corrective call returns the first answer", async () => {
    await useMode("nudge");
    await registerTools({ web_fetch: () => PAGE });
    script([call("c1", "web_fetch", { url: "http://shop.test/lager.html" }), answer(WRONG), () => { throw new Error("HTTP 500 from the model server"); }]);
    const audit = await captureAudit();
    const result = await run("counter");
    audit.unsubscribe();
    expect(result.output).toBe(WRONG);
    expect(audit.rows("sub_agent_arithmetic_hold_returned")).toHaveLength(1);
  }, 30_000);

  it("nudge: a failure thrown out of the corrective iteration returns the first answer", async () => {
    // The caller's progress listener throws on the corrective call's "thinking" event; nothing in
    // the loop catches it, so only the wrapper's hold can still return the answer the run had.
    await useMode("nudge");
    await registerTools({ web_fetch: () => PAGE });
    script([call("c1", "web_fetch", { url: "http://shop.test/lager.html" }), answer(WRONG), answer(RIGHT)]);
    const onProgress = (event: { kind: string; iteration: number }) => {
      if (event.kind === "thinking" && event.iteration >= 3) throw new Error("progress listener failed");
    };
    const audit = await captureAudit();
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    const result = await runSubAgentWithStats({ agentName: "counter", task: "Wie hoch ist der Gesamtbestand am Standort Südtal?", parentSessionId: "parent-counter", workspacePath: tempDir, approvalCallback: async () => true, onProgress });
    audit.unsubscribe();
    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(result.output).toBe(WRONG);
    expect(audit.rows("sub_agent_arithmetic_hold_returned")).toEqual([expect.objectContaining({ exitTerminalState: "error", error: "progress listener failed" })]);
  }, 30_000);

  it("nudge: no corrective iteration for a run stopped while it wrote its answer", async () => {
    await useMode("nudge");
    await registerTools({ web_fetch: () => PAGE });
    const controller = new AbortController();
    script([call("c1", "web_fetch", { url: "http://shop.test/lager.html" }), () => { controller.abort(); return answer(WRONG); }, answer(RIGHT)]);
    const audit = await captureAudit();
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    const result = await runSubAgentWithStats({ agentName: "counter", task: "Wie hoch ist der Gesamtbestand am Standort Südtal?", parentSessionId: "parent-counter", workspacePath: tempDir, approvalCallback: async () => true, signal: controller.signal });
    audit.unsubscribe();
    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(result.output).toBe(WRONG);
    expect(audit.rows("sub_agent_arithmetic_mismatch")).toEqual([expect.objectContaining({ nudged: false, skipReason: "stopped" })]);
  }, 30_000);

  it("nudge: an empty corrective answer returns the first answer", async () => {
    await useMode("nudge");
    await registerTools({ web_fetch: () => PAGE });
    script([call("c1", "web_fetch", { url: "http://shop.test/lager.html" }), answer(WRONG), answer("")]);
    const audit = await captureAudit();
    const result = await run("counter");
    audit.unsubscribe();
    expect(result.output).toBe(WRONG);
    expect(audit.rows("sub_agent_arithmetic_hold_returned")).toHaveLength(1);
  }, 30_000);

  it("nudge: no nudge for a run whose figures the provenance mask checks, and its unobserved figures stay masked", async () => {
    await useMode("nudge");
    await registerTools({
      shell_exec: () => ({ success: false, output: "", error: "Exit code 1: Command failed", metadata: { sandboxed: true, exitCode: 1, programOutputChars: 0 } }),
    });
    // Every figure of the chain is in the task, so the mask leaves it; 33,44 is in nothing the run received.
    const task = `Prüfe diese Rechnung: ${CHAIN.replace(/\*\*/g, "")}`;
    script([call("c1", "shell_exec", { command: "node sum.js" }), answer(`${CHAIN}\n\nDurchschnitt: 33,44 Stück.`)]);
    const audit = await captureAudit();
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    const result = await runSubAgentWithStats({ agentName: "coder", task, parentSessionId: "parent-coder", workspacePath: tempDir, approvalCallback: async () => true });
    audit.unsubscribe();
    expect(completeMock).toHaveBeenCalledTimes(2);
    expect(audit.rows("sub_agent_arithmetic_mismatch")).toEqual([expect.objectContaining({ nudged: false, skipReason: "figures_unverified" })]);
    expect(result.output).toContain("[not observed]");
    expect(result.output).not.toContain("33,44");
  }, 30_000);
});
