import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A CHECK RUN AFTER A FIX MUST SEE THE FIX.
 *
 * Both tool caches in the sub-agent loop key on (tool name, arguments) and neither knows
 * the workspace changed underneath them. lastToolCallSig is a Map keyed by tool NAME, so
 * "the previous call" means the previous call OF THAT TOOL no matter what ran in between:
 *
 *   verify_page(x)  -> FAIL, cached under "verify_page"
 *   edit_file(x)    -> fixes the fault
 *   verify_page(x)  -> same name, same args -> replays the FAIL from before the fix
 *
 * Session 88dda7d2 is what that costs. web_coder found the real bug (a German low quote
 * opened a JS string that an ASCII quote closed early), fixed it, re-ran verify_page, and
 * reported: "A subsequent verify_page returned a cached result of the earlier failing run
 * ... so I could not capture a fresh PASS/FAIL line from the harness." The cached-failure
 * note even instructs "Do NOT call it again" -- the loop is trained to stop testing at the
 * exact moment testing would have paid off. The build -> test -> fix loop cannot converge
 * while its test replays a verdict from before the fix.
 */

const completeMock = vi.fn();

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

const call = (id: string, name: string, args: unknown) => ({
  content: null,
  tool_calls: [{ id, type: "function", name, arguments: args }],
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  finishReason: "tool_calls",
});

describe("workspace writes invalidate the tool read caches", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const swarmMemory = await import("../swarm/memory.js");
    await swarmMemory.resetSharedMemoryForTests();
  });

  it("re-reads a file after editing it instead of replaying the pre-edit bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sai-cache-invalidation-"));
    const configPath = join(dir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        fixer: {
          description: "Reads, edits, re-reads.",
          systemPrompt: "Fix the file.",
          tools: ["read_file", "edit_file"],
          maxIterations: 6,
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;

    mkdirSync(join(dir, "generated"), { recursive: true });
    const target = join(dir, "generated", "note.txt");
    writeFileSync(target, "BEFORE_THE_EDIT", "utf8");

    // read -> edit -> read, exactly the shape of checking your own fix.
    const script = [
      () => call("c1", "read_file", { path: "generated/note.txt" }),
      () => call("c2", "edit_file", {
        path: "generated/note.txt",
        old_string: "BEFORE_THE_EDIT",
        new_string: "AFTER_THE_EDIT",
      }),
      () => call("c3", "read_file", { path: "generated/note.txt" }),
      () => ({
        content: "done",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      }),
    ];
    let step = 0;
    completeMock.mockImplementation(async () => (script[Math.min(step++, script.length - 1)]!)());

    try {
      // Registers read_file / edit_file into the tool registry for this module graph.
      await import("../tools/filesystem.js");
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      await runSubAgentWithStats({
        agentName: "fixer",
        task: "Read the note, change it, then read it back to confirm.",
        parentSessionId: "cache-parent",
        workspacePath: dir,
      });

      // The edit really landed on disk...
      expect(readFileSync(target, "utf8")).toContain("AFTER_THE_EDIT");

      // ...and the SECOND read was served the new bytes, not the cache. The tool
      // results are fed back as role:"tool" messages, so the last completion's
      // messages carry what the re-read actually returned.
      const lastMessages = completeMock.mock.calls.at(-1)?.[0] as Array<Record<string, unknown>>;
      const toolMessages = lastMessages.filter((m) => m["role"] === "tool").map((m) => String(m["content"]));
      const reread = toolMessages.at(-1) ?? "";

      expect(reread, "the re-read must show the edited content").toContain("AFTER_THE_EDIT");
      expect(reread, "the re-read must not be a replay of the cached pre-edit result")
        .not.toContain("This is a cached result");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
