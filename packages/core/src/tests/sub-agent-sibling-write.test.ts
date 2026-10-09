import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * C5' (c) in the real sub-agent loop: a write to a file a running sibling owns is refused BEFORE
 * the tool runs, the refusal names the owner, and the run's own file still goes through.
 * c297c5ea: the write_paper builder edited the deck twice while write_presentation built it.
 * (The rule is in sibling-write-ownership.test.ts, the fan-out wiring in
 * delegation-loop-consequences.test.ts.)
 */

const completeMock = vi.fn();
const audit = vi.hoisted(() => ({ rows: [] as Array<{ type: string; data: Record<string, unknown> }> }));

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal, options?: unknown) {
      return completeMock(messages, tools, signal, options);
    }
  },
}));

vi.mock("../audit/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/logger.js")>();
  return {
    ...actual,
    logAudit: vi.fn((type: string, data: Record<string, unknown>) => { audit.rows.push({ type, data }); }),
  };
});

type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
type Message = { role: string; content?: string | null; tool_call_id?: string };

let callSeq = 0;
const call = (name: string, args: Record<string, unknown>): ToolCall => {
  callSeq += 1;
  return { id: `call-${callSeq}`, name, arguments: args };
};

function scriptModel(script: Array<ToolCall[] | "text">): void {
  const queue = [...script];
  completeMock.mockImplementation(async (_messages: unknown, _tools: unknown, _signal: unknown, options?: { toolChoice?: string }) => {
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    const next = options?.toolChoice === "none" ? "text" : (queue.shift() ?? "text");
    return next === "text"
      ? { content: "The paper is written.", tool_calls: [], usage, finishReason: "stop" }
      : { content: "", tool_calls: next, usage, finishReason: "tool_calls" };
  });
}

describe("a sibling's file in the sub-agent loop", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    audit.rows.length = 0;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("is refused before the tool runs, naming the owner, and the run's own file is written", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-sibling-write-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        paper_writer: { description: "Writes the paper", systemPrompt: "Write.", tools: ["edit_file", "write_file"], maxIterations: 10 },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    const { SiblingWriteGroup, runAsWriteSibling } = await import("../agent/sibling-write-ownership.js");
    const executed: string[] = [];
    for (const name of ["edit_file", "write_file"]) {
      registerTool({
        name,
        description: `Stub ${name}.`,
        parameters: { type: "object", properties: {} },
        async execute(args) {
          const path = String((args as Record<string, unknown>)["path"]);
          executed.push(`${name}:${path}`);
          return { success: true, output: `${name} ${path} done.`, metadata: { outputPath: path } };
        },
      });
    }
    scriptModel([
      [call("edit_file", { path: "deck.html", old_string: "<h1>Old</h1>", new_string: "<h1>New</h1>" })],
      [call("write_file", { path: "paper.md", content: "# Paper\n\nThe body." })],
      "text",
    ]);

    const group = new SiblingWriteGroup("run_task_graph", tempDir);
    let siblingFinishes!: () => void;
    const sibling = runAsWriteSibling(group, "write_presentation", "node 'write_presentation' (content_writer)",
      "Build the deck in deck.html.", () => new Promise<void>((resolve) => { siblingFinishes = resolve; }));
    try {
      const result = await runAsWriteSibling(group, "write_paper", "node 'write_paper' (paper_writer)", "Write the paper to paper.md.",
        () => runSubAgentWithStats({ agentName: "paper_writer", task: "Write the paper to paper.md.", parentSessionId: "sibling-write", workspacePath: tempDir }));

      expect(executed).toEqual(["write_file:paper.md"]);
      const messages = completeMock.mock.calls.at(-1)![0] as Message[];
      const refusal = messages.find((m) => m.role === "tool" && String(m.content).startsWith("Refused: 'edit_file' on 'deck.html'"));
      expect(refusal?.content).toContain("belongs to node 'write_presentation' (content_writer)");
      const skipped = audit.rows.find((row) => row.type === "sub_agent_tool_call" && row.data["skippedReason"] === "sibling_write_owned");
      expect(skipped?.data["tool"]).toBe("edit_file");
      expect(result.stats.terminalState).toBe("completed");
    } finally {
      siblingFinishes();
      await sibling;
      for (const name of ["edit_file", "write_file"]) unregisterTool(name);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // export_workspace_artifact sits in the loop's path-keyed set for its per-path cap, but it only
  // reads a finished file into a download card. Checked as a write, it was refused on the owner's
  // file, and an export of an unnamed file claimed it away from the sibling actually writing it.
  it("lets an export through, on a sibling's file too, and an export claims nothing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-sibling-export-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        paper_writer: { description: "Writes the paper", systemPrompt: "Write.", tools: ["export_workspace_artifact", "write_file"], maxIterations: 10 },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    const { SiblingWriteGroup, runAsWriteSibling, checkSiblingWrite } = await import("../agent/sibling-write-ownership.js");
    const executed: string[] = [];
    let exported!: () => void;
    const exportsDone = new Promise<void>((resolve) => { exported = resolve; });
    let siblingChecked!: () => void;
    const checkDone = new Promise<void>((resolve) => { siblingChecked = resolve; });
    for (const name of ["export_workspace_artifact", "write_file"]) {
      registerTool({
        name,
        description: `Stub ${name}.`,
        parameters: { type: "object", properties: {} },
        async execute(args) {
          const path = String((args as Record<string, unknown>)["path"]);
          executed.push(`${name}:${path}`);
          if (name === "export_workspace_artifact" && path === "chart.png") exported();
          // The sibling writes the exported file while this run is still running.
          if (name === "write_file") await checkDone;
          return { success: true, output: `${name} ${path} done.`, metadata: { outputPath: path } };
        },
      });
    }
    scriptModel([
      [call("export_workspace_artifact", { path: "deck.html" }), call("export_workspace_artifact", { path: "chart.png" })],
      [call("write_file", { path: "paper.md", content: "# Paper\n\nThe body." })],
      "text",
    ]);

    const group = new SiblingWriteGroup("run_task_graph", tempDir);
    let siblingFinishes!: () => void;
    const finish = new Promise<void>((resolve) => { siblingFinishes = resolve; });
    let siblingWrite: ReturnType<typeof checkSiblingWrite> | undefined;
    const sibling = runAsWriteSibling(group, "write_presentation", "node 'write_presentation' (content_writer)",
      "Build the deck in deck.html.", async () => {
        await exportsDone;
        siblingWrite = checkSiblingWrite("chart.png");
        siblingChecked();
        await finish;
      });
    try {
      await runAsWriteSibling(group, "write_paper", "node 'write_paper' (paper_writer)", "Write the paper to paper.md.",
        () => runSubAgentWithStats({ agentName: "paper_writer", task: "Write the paper to paper.md.", parentSessionId: "sibling-export", workspacePath: tempDir }));

      expect(executed).toEqual(["export_workspace_artifact:deck.html", "export_workspace_artifact:chart.png", "write_file:paper.md"]);
      expect(audit.rows.some((row) => row.type === "sub_agent_tool_call" && row.data["skippedReason"] === "sibling_write_owned")).toBe(false);
      expect(siblingWrite).toBeNull();
    } finally {
      exported();
      siblingFinishes();
      await sibling;
      for (const name of ["export_workspace_artifact", "write_file"]) unregisterTool(name);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
