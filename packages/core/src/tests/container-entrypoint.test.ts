import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE CONTAINERIZED RUNNER CARRIES THE SAME HISTORY BOUND AS THE IN-PROCESS ONE.
 *
 * `agents.defaultContainerized` defaults true and 22 workspace agents declare no container
 * flag, so this entrypoint — not agent/sub-agent.ts — is where most delegated runs actually
 * execute. It composed `[{role:"system"}, ...history]` and called provider.complete directly,
 * so neither the batched digest nor the overflow drop/clamp ever ran there: a 25,929-char
 * read_file result slid under MAX_TOOL_RESULT_CHARS untouched and was re-sent verbatim for
 * the rest of the run (run 3959f3ac, 13 completions, 238,357 cumulative prompt tokens).
 *
 * The assertion is on the WIRE: what the provider stub received on each call.
 */

interface RecordedCall {
  messages: Array<{ role: string; content: unknown }>;
}

const recordedCalls: RecordedCall[] = [];
const responseQueue: unknown[] = [];

vi.mock("../providers/index.js", () => ({
  createChatProvider: () => ({
    async complete(messages: unknown) {
      // Deep copy: trimSubAgentHistory rewrites the SAME message objects in place, so a
      // shallow record would show every earlier call already carrying the digest.
      recordedCalls.push({ messages: JSON.parse(JSON.stringify(messages)) as RecordedCall["messages"] });
      return responseQueue.shift();
    },
  }),
}));

const BIG_READ_CHARS = 45_000;
/** One stale read result big enough to cross DIGEST_BATCH_MIN_CHARS (40_000) on its own. */
const bigReadResult = "// line of a big source file that the agent has already acted on.\n"
  .repeat(Math.ceil(BIG_READ_CHARS / 66)).slice(0, BIG_READ_CHARS);

function toolCallResponse(id: string, path: string) {
  return {
    content: null,
    tool_calls: [{ id, name: "read_file", arguments: { path } }],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "tool_calls",
  };
}

describe("container entrypoint applies the sub-agent history bound", () => {
  afterEach(async () => {
    recordedCalls.length = 0;
    responseQueue.length = 0;
    delete process.env["SAI_CONFIG_PATH"];
    vi.restoreAllMocks();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("digests a stale oversized tool result once the batch threshold is crossed", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-container-entrypoint-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({ workspacePath: tempDir }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    const readSpy = vi.fn((path: string) => ({
      success: true,
      output: path === "src/big.ts" ? bigReadResult : `contents of ${path}`,
    }));
    registerTool({
      name: "read_file",
      description: "Read a file.",
      parameters: { type: "object", properties: {} },
      async execute(args) {
        return readSpy(String(args["path"] ?? "")) as never;
      },
    });

    // Three tool-calling turns, then the answer. FRESH_TOOL_TURNS is 2, so the first turn's
    // result only goes stale in front of the FOURTH call — which is where the digest belongs.
    responseQueue.push(
      toolCallResponse("t1", "src/big.ts"),
      toolCallResponse("t2", "src/small_a.ts"),
      toolCallResponse("t3", "src/small_b.ts"),
      {
        content: "Final answer built from what was read.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      },
    );

    const payload = {
      agentName: "containerized_probe",
      task: "Read the sources and answer.",
      parentSessionId: "parent-container-entrypoint",
      userId: "u1",
      workspacePath: tempDir,
      agentConfig: {
        description: "Probe specialist that runs in a container.",
        systemPrompt: "Read what you need, then answer.",
        tools: ["read_file"],
        maxIterations: 6,
      },
      resolvedModelConfig: {
        provider: "lmstudio",
        primary: "lmstudio/probe-model",
        contextWindow: 131_072,
      },
      providerBaseUrl: "http://127.0.0.1:1234/v1",
      providerApiKey: "",
    };

    const stdin = new Readable({ read() { /* pushed below */ } });
    const realStdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
    Object.defineProperty(process, "stdin", { value: stdin, configurable: true });

    let resultLine = "";
    let resolveResult: () => void = () => {};
    const finished = new Promise<void>((resolve) => { resolveResult = resolve; });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      resultLine += chunk;
      resolveResult();
      return true;
    }) as never);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`entrypoint called process.exit(${code})`);
    }) as never);

    try {
      await import("../agent/container-entrypoint.js");
      stdin.push(JSON.stringify(payload));
      stdin.push(null);
      await finished;

      expect(JSON.parse(resultLine)).toMatchObject({ success: true, result: "Final answer built from what was read." });
      expect(readSpy).toHaveBeenCalledTimes(3);
      expect(recordedCalls).toHaveLength(4);

      const bigOn = (call: RecordedCall) =>
        call.messages.find((m) => m.role === "tool" && String(m.content).startsWith("// line of a big source file"));

      // Calls 2 and 3: the read is still inside the fresh window — verbatim, untouched.
      expect(String(bigOn(recordedCalls[1]!)!.content)).toHaveLength(BIG_READ_CHARS);
      expect(String(bigOn(recordedCalls[2]!)!.content)).toHaveLength(BIG_READ_CHARS);

      // Call 4: two tool turns on, the agent has acted on it. Head+tail digest, on the wire.
      const digested = String(bigOn(recordedCalls[3]!)!.content);
      expect(digested.length).toBeLessThan(2_000);
      expect(digested).toContain("chars elided");
      expect(digested).toContain("Re-read the source");
      // The fresh window is what the agent is working from and is never rewritten.
      const freshResults = recordedCalls[3]!.messages.filter((m) => m.role === "tool" && String(m.content).startsWith("contents of"));
      expect(freshResults.map((m) => String(m.content))).toEqual(["contents of src/small_a.ts", "contents of src/small_b.ts"]);
      // The head is still the system prompt, and the task statement is still pinned at history[0].
      expect(recordedCalls[3]!.messages[0]).toEqual({ role: "system", content: expect.stringContaining("Read what you need, then answer.") });
      expect(String(recordedCalls[3]!.messages[1]!.content)).toContain("Read the sources and answer.");
      expect(exitSpy).not.toHaveBeenCalled();
      expect(writeSpy).toHaveBeenCalledTimes(1);
    } finally {
      unregisterTool("read_file");
      Object.defineProperty(process, "stdin", realStdin);
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 20_000);
});
