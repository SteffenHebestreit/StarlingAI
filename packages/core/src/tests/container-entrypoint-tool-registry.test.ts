import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE WORKER REGISTERS NO TOOLS, SO IT MUST FAIL LOUD RATHER THAN ANSWER IN PROSE.
 *
 * agent/container-entrypoint.ts imports tools/registry.js for getToolsAsLLMDefs/executeTool
 * but imports no tool MODULE, and a tool only enters the registry as its module's import side
 * effect — so inside the worker the registry is empty. An agent that declares tools would
 * otherwise reach the loop with zero of them wired up and could only answer in prose, which
 * the orchestrator reads as a completed run. The fix: if any declared tool is not registered
 * in this process, end at once with a container-level failure that names the missing tools,
 * before the provider is ever constructed.
 *
 * These tests drive the real entrypoint over stdin/stdout, asserting the result line and that
 * the provider is never touched.
 */

const createChatProviderSpy = vi.fn();
const completeSpy = vi.fn();

vi.mock("../providers/index.js", () => ({
  createChatProvider: (...args: unknown[]) => {
    createChatProviderSpy(...args);
    return {
      async complete(messages: unknown) {
        completeSpy(messages);
        return {
          content: "A prose answer the worker should NEVER have reached.",
          tool_calls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "stop",
        };
      },
    };
  },
}));

interface RunOutcome {
  resultLine: string;
  exitCalled: boolean;
}

/**
 * Pipe `payload` into a freshly imported entrypoint and capture the single JSON result line.
 * Each call resets modules so the registry starts empty (its real state in the worker image);
 * `register` runs after that reset so a test can wire up a tool before the entrypoint reads it.
 */
async function runEntrypoint(payload: unknown, register?: () => Promise<void>): Promise<RunOutcome> {
  vi.resetModules();
  createChatProviderSpy.mockClear();
  completeSpy.mockClear();
  if (register) await register();

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
  let exitCalled = false;
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCalled = true;
    throw new Error(`entrypoint called process.exit(${code})`);
  }) as never);

  try {
    await import("../agent/container-entrypoint.js");
    stdin.push(JSON.stringify(payload));
    stdin.push(null);
    await finished;
    return { resultLine, exitCalled };
  } finally {
    writeSpy.mockRestore();
    exitSpy.mockRestore();
    Object.defineProperty(process, "stdin", realStdin);
  }
}

const baseModelConfig = {
  provider: "lmstudio",
  primary: "lmstudio/probe-model",
  contextWindow: 131_072,
};

describe("container entrypoint refuses an agent whose tools it cannot run", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a failure naming every declared tool and never calls the provider", async () => {
    const payload = {
      agentName: "shell_agent",
      task: "Run the build and read the log.",
      parentSessionId: "parent-missing-tools",
      userId: "u1",
      workspacePath: "/workspace",
      agentConfig: {
        description: "Shell specialist that runs in a container.",
        systemPrompt: "Use your tools.",
        tools: ["shell_exec", "read_file"],
        maxIterations: 5,
      },
      resolvedModelConfig: baseModelConfig,
      providerBaseUrl: "http://127.0.0.1:1234/v1",
      providerApiKey: "",
    };

    // No register() — the registry is empty, exactly as it is in the worker image.
    const { resultLine } = await runEntrypoint(payload);
    const parsed = JSON.parse(resultLine) as { success: boolean; error?: string };

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("shell_agent");
    expect(parsed.error).toContain("shell_exec");
    expect(parsed.error).toContain("read_file");
    // The honest statement: nothing was answered, rather than answered without tools.
    expect(parsed.error).toMatch(/returned no answer rather than answering without/i);
    // The provider was never even constructed, let alone asked to complete.
    expect(createChatProviderSpy).not.toHaveBeenCalled();
    expect(completeSpy).not.toHaveBeenCalled();
  }, 20_000);

  it("still reaches the provider for an agent that declares no tools", async () => {
    const payload = {
      agentName: "prose_agent",
      task: "Summarize the situation.",
      parentSessionId: "parent-no-tools",
      userId: "u1",
      workspacePath: "/workspace",
      agentConfig: {
        description: "A specialist that answers from reasoning alone.",
        systemPrompt: "Answer directly.",
        tools: [],
        maxIterations: 3,
      },
      resolvedModelConfig: baseModelConfig,
      providerBaseUrl: "http://127.0.0.1:1234/v1",
      providerApiKey: "",
    };

    const { resultLine } = await runEntrypoint(payload);
    const parsed = JSON.parse(resultLine) as { success: boolean; result?: string };

    // No declared tools => the missing-tool guard is skipped and the loop runs as before.
    expect(parsed.success).toBe(true);
    expect(parsed.result).toContain("A prose answer");
    expect(createChatProviderSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy).toHaveBeenCalledTimes(1);
  }, 20_000);
});
