import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE WARDEN'S EMERGENCY STOP REACHES A RUNNING SUB-AGENT (W1).
 *
 * A sub-agent logs its tool calls under its own session id (sub:<parent>:<agent>:<ts>), so the
 * warden's tool_storm names the run. Its kill switch only knew the TURN's abort controllers, keyed
 * by the parent id, and matched a stored id that starts with the subject, which a parent id never
 * does. In c297c5ea five session_emergency_stopped alerts on content_writer runs stopped none of
 * them; each ran on for 2-6 minutes.
 *
 * Driven end to end: the real loop logs its calls, the real warden subscription counts them, the
 * real sweep raises the alert, and the run has to end on its next iteration with what it has. The
 * scripted model never stops on its own and every call is new, so neither the loop brake nor the
 * supervisor can be what ends the run.
 */

const completeMock = vi.fn();
const audit = vi.hoisted(() => ({
  rows: [] as Array<{ type: string; data: Record<string, unknown>; sessionId?: string }>,
  subscriber: null as null | ((event: unknown) => void),
}));

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal, options?: unknown) {
      return completeMock(messages, tools, signal, options);
    }
  },
}));

// logAudit is captured AND handed to the warden's subscriber, the way the real logger feeds it.
vi.mock("../audit/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/logger.js")>();
  return {
    ...actual,
    logAudit: vi.fn((type: string, data: Record<string, unknown>, opts?: { sessionId?: string }) => {
      const event = { type, data, ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}) };
      audit.rows.push(event);
      audit.subscriber?.(event);
    }),
    subscribeToAudit: vi.fn((cb: (event: unknown) => void) => {
      audit.subscriber = cb;
      return () => { audit.subscriber = null; };
    }),
  };
});

type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };

const FINAL_TEXT = "Final answer from the evidence gathered.";
let callSeq = 0;
const call = (name: string, args: Record<string, unknown>): ToolCall => {
  callSeq += 1;
  return { id: `call-${callSeq}`, name, arguments: args };
};

/** A model that always wants one more NEW grep, and answers in text under tool_choice "none"
 *  (or, with `silentSynthesis`, answers nothing there, so the run falls back to its evidence). */
function endlessNewGreps(silentSynthesis = false): void {
  completeMock.mockImplementation(async (_messages: unknown, _tools: unknown, _signal: unknown, options?: { toolChoice?: string }) => {
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    if (options?.toolChoice === "none") return { content: silentSynthesis ? "" : FINAL_TEXT, tool_calls: [], usage, finishReason: "stop" };
    return { content: "", tool_calls: [call("grep_files", { pattern: `slide-${callSeq}`, path: "deck.html" })], usage, finishReason: "tool_calls" };
  });
}

const rowsOf = (type: string) => audit.rows.filter((row) => row.type === type);

async function runWithStormAtCall(stormAt: number, agent: Record<string, unknown> = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-warden-stop-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    subAgents: {
      storm_agent: {
        description: "Warden stop test agent",
        systemPrompt: "Do the task with your tools.",
        tools: ["grep_files"],
        maxIterations: 20,
        model: { contextWindow: 131_072 },
        ...agent,
      },
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  vi.resetModules();
  const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
  const { registerTool, unregisterTool } = await import("../tools/registry.js");
  const warden = await import("../agent/warden.js");
  warden.resetWardenForTests();
  warden.startWarden();
  const executed: string[] = [];
  registerTool({
    name: "grep_files",
    description: "Stub grep_files.",
    parameters: { type: "object", properties: {} },
    async execute(args) {
      const pattern = String((args as Record<string, unknown>)["pattern"]);
      executed.push(pattern);
      if (executed.length === stormAt) {
        // The run's own calls, as the warden counts them: logged under its session id.
        const runSession = rowsOf("sub_agent_tool_call").at(-1)!.sessionId!;
        for (let i = 0; i < warden.TOOL_STORM_THRESHOLD; i++) {
          audit.subscriber!({ type: "sub_agent_tool_call", sessionId: runSession, data: { phase: "start" } });
        }
        warden.sweepAnomaliesNow();
      }
      return { success: true, output: `deck.html:12: <section> ${pattern} found` };
    },
  });
  try {
    const result = await runSubAgentWithStats({
      agentName: "storm_agent",
      task: "Check every slide of the deck and report.",
      parentSessionId: `warden-stop-${callSeq}`,
      workspacePath: tempDir,
    });
    return { result, executed, warden };
  } finally {
    warden.stopWarden();
    unregisterTool("grep_files");
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("the warden's emergency stop in the sub-agent loop", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    audit.rows.length = 0;
    audit.subscriber = null;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("a tool_storm on the run ends it on its next iteration, with a synthesis of what it has", async () => {
    endlessNewGreps();
    const { result, executed } = await runWithStormAtCall(3, { turnTimeoutMs: 900_000 });

    // The alert named this run and said it stopped it.
    const alert = rowsOf("warden_alert").find((row) => row.data["alertType"] === "tool_storm");
    expect(alert?.data["action"]).toBe("session_emergency_stopped");
    expect(String(alert?.data["subject"])).toMatch(/^sub:warden-stop-\d+:storm_agent:\d+$/);
    // No call after the one that was running when the stop came.
    expect(executed).toHaveLength(3);
    // Three tool turns and the synthesis; unstopped it ran to 20.
    expect(completeMock.mock.calls.length).toBe(4);
    expect(result.output).toContain(FINAL_TEXT);
    expect(result.wardenStop).toEqual({ alert: "tool_storm" });
    expect(rowsOf("sub_agent_completed").at(-1)?.data["wardenStop"]).toEqual({ alert: "tool_storm" });
  });

  it("a run is registered only while it runs: one that ends on its own leaves no handler behind", async () => {
    // A handler that outlived its run would hold the run's whole closure for the life of the
    // gateway, one per sub-agent run.
    let registeredWhileRunning: boolean | undefined;
    let runSession = "";
    let warden!: typeof import("../agent/warden.js");
    let toolTurns = 0;
    completeMock.mockImplementation(async (_messages: unknown, _tools: unknown, _signal: unknown, options?: { toolChoice?: string }) => {
      const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
      if (options?.toolChoice === "none" || toolTurns++ >= 1) return { content: FINAL_TEXT, tool_calls: [], usage, finishReason: "stop" };
      return { content: "", tool_calls: [call("grep_files", { pattern: "slide", path: "deck.html" })], usage, finishReason: "tool_calls" };
    });
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-warden-dereg-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        storm_agent: { description: "Warden stop test agent", systemPrompt: "Do the task with your tools.", tools: ["grep_files"], maxIterations: 5, model: { contextWindow: 131_072 } },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    warden = await import("../agent/warden.js");
    warden.resetWardenForTests();
    registerTool({
      name: "grep_files",
      description: "Stub grep_files.",
      parameters: { type: "object", properties: {} },
      async execute() {
        runSession = rowsOf("sub_agent_tool_call").at(-1)!.sessionId!;
        registeredWhileRunning = warden.isWardenRunStopRegistered(runSession);
        return { success: true, output: "deck.html:12: <section> slide found" };
      },
    });
    try {
      const result = await runSubAgentWithStats({ agentName: "storm_agent", task: "Check the deck.", parentSessionId: "warden-dereg", workspacePath: tempDir });
      expect(result.output).toContain(FINAL_TEXT);
      expect(runSession).toMatch(/^sub:warden-dereg:storm_agent:\d+$/);
      expect(registeredWhileRunning).toBe(true);
      expect(warden.isWardenRunStopRegistered(runSession)).toBe(false);
    } finally {
      unregisterTool("grep_files");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("when the synthesis yields nothing, it hands back its evidence and says the warden stopped it", async () => {
    endlessNewGreps(true);
    const { result, executed } = await runWithStormAtCall(2);

    expect(executed).toHaveLength(2);
    expect(result.stats.terminalState).toBe("timeout");
    expect(result.output).toContain("was stopped by the warden (tool_storm)");
    // What it had found is in the hand-back, not thrown away.
    expect(result.output).toContain("slide-");
    expect(result.wardenStop).toEqual({ alert: "tool_storm" });
  });
});
