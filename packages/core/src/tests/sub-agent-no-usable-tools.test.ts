import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tools/registry.js";

/**
 * A DELEGATION THAT NAMES AN AGENT WITH NO USABLE TOOL FAILS; IT DOES NOT RUN THE AGENT ON THE
 * BOOKKEEPING PAIR AND REPORT SUCCESS.
 *
 * E2E 2026-10-08 (guards-list-files-on-a-file): the processmem MCP server was unreachable, so none of
 * process_memory_keeper's ten mcp__processmem__ tools was registered. A sub-agent run keeps only the
 * registered tools without saying so; the agent ran with read_shared_facts and share_finding and was
 * counted a success. Routing now leaves such an agent out, but a delegation can still name it.
 */
const completeMock = vi.hoisted(() => vi.fn());
vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));
// Every connect fails, as processmem's did (getaddrinfo ENOTFOUND).
vi.mock("../mcp/client.js", () => ({
  connectMcpServer: async (name: string) => { throw new Error(`getaddrinfo ENOTFOUND ${name}`); },
  cleanupConfiguredDockerMcpContainers: async () => undefined,
}));

/** process_memory_keeper's declared tools, verbatim from the local 60-processmem shard. */
const PROCESSMEM_TOOLS = [
  "mcp__processmem__open_process", "mcp__processmem__transition_process", "mcp__processmem__attach_subprocess",
  "mcp__processmem__record_entry", "mcp__processmem__attach_entry", "mcp__processmem__find_processes",
  "mcp__processmem__define_aspect", "mcp__processmem__note_aspect_mention", "mcp__processmem__link_entries",
  "mcp__processmem__ingest_message", "read_shared_facts", "share_finding",
];

const TASK = "Schreibe die Textdatei generated/e2e-guards/inventur.txt mit dem Inhalt 'Hammer 12'.";

describe("a delegation naming an agent with no usable tool", () => {
  let tempDir = "";

  /** A process that connected MCP (as the gateway does at startup) with processmem down, and the delegation tool. */
  const setUp = async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-no-usable-tools-"));
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      workspacePath: tempDir,
      agents: { defaults: { model: { primary: "lmstudio/qwen" } } },
      subAgents: {
        process_memory_keeper: {
          description: "Keeps long-running matters in ProcessMem.", systemPrompt: "Use ProcessMem.", tools: PROCESSMEM_TOOLS, maxIterations: 4,
        },
        file_writer: {
          description: "Writes text files in the workspace.", systemPrompt: "Write files.", tools: ["write_file", "read_shared_facts", "share_finding"], maxIterations: 4,
        },
      },
      mcp: { servers: { processmem: { transport: "http", url: "http://processmem:8080/mcp" } } },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    // What the model answers with nothing but the bookkeeping tools: a claim of success.
    completeMock.mockResolvedValue({
      content: "Die Datei wurde geschrieben.", tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop",
    });
    await (await import("../mcp/registry.js")).syncMcpServers();
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    const ctx: ToolContext = {
      sessionId: "s-no-tools",
      workspacePath: tempDir,
      swarmState: { objective: "t", startedAt: "", updatedAt: "", tasks: {} },
    };
    return { delegate: (args: Record<string, unknown>) => getTool("delegate_to_agent")!.execute(args, ctx) };
  };

  afterEach(async () => {
    completeMock.mockReset();
    vi.unstubAllGlobals();
    delete process.env["SAI_CONFIG_PATH"];
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
    vi.resetModules();
  });

  it("fails before any model call, names the missing tools, and records no outcome", async () => {
    const { delegate } = await setUp();

    const result = await delegate({ agentName: "process_memory_keeper", task: TASK });

    expect(completeMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.metadata?.["delegationSucceeded"]).toBe(false);
    expect(result.error).toContain("cannot run: none of the tools it works with is available in this process");
    expect(result.error).toContain("mcp__processmem__open_process");
    expect(result.error).toContain("(+2 more)");
    const { readRecentOutcomes } = await import("../agent/outcomes.js");
    expect(readRecentOutcomes(tempDir, 50).filter((row) => row.agent === "process_memory_keeper")).toEqual([]);
  }, 30_000);

  it("leaves the delegation free to run its fallback agent", async () => {
    const { delegate } = await setUp();

    const result = await delegate({ agentName: "process_memory_keeper", fallbackAgents: ["file_writer"], task: TASK });

    // Not an infrastructure failure, which would end the cascade: the fallback agent is run (whatever
    // its own result), and it is the only run that reaches the model.
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(result.metadata?.["attemptedAgents"]).toEqual(["process_memory_keeper", "file_writer"]);
  }, 30_000);
});
