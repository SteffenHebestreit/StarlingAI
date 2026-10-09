import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolContext, ToolResult } from "../tools/registry.js";

const execFileAsyncMock = vi.fn();

vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  (execFile as unknown as Record<PropertyKey, unknown>)[promisify.custom] = execFileAsyncMock;
  return { execFile };
});

vi.mock("../tools/workspace-mount.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/workspace-mount.js")>()),
  resolveDockerWorkspaceBind: vi.fn(() => "/srv/workspace:/workspace"),
}));

/**
 * WHAT A SANDBOX RUN PRINTED, BESIDE WHETHER IT SUCCEEDED (E2E 2026-10-07).
 *
 * The docker-socket proxy swallowed every byte the programs wrote. Three runs "succeeded" with the
 * placeholder "(no output)", the failed ones carried only the docker command line, and a timeout
 * carried no metadata at all, so nothing downstream could tell that no run had printed a result.
 * Each tool now reports programOutputChars once the program ran, whatever its exit.
 */
type Case = { tool: string; args: Record<string, unknown> };
const CASES: Case[] = [
  { tool: "shell_exec", args: { command: "node primes.js" } },
  { tool: "run_script", args: { path: "primes.js" } },
  { tool: "run_test_suite", args: { suite: "vitest" } },
];

const execError = (fields: Record<string, unknown>) => Object.assign(new Error("Command failed: docker run ..."), fields);

describe.each(CASES)("$tool", ({ tool, args }) => {
  let workspacePath = "";
  let run: (toolArgs?: Record<string, unknown>) => Promise<ToolResult>;

  beforeAll(async () => {
    workspacePath = mkdtempSync(join(tmpdir(), "sai-sandbox-shape-"));
    await import("../tools/shell.js");
    await import("../tools/run-test-suite.js");
    const { getTool } = await import("../tools/registry.js");
    const ctx: ToolContext = { sessionId: `session-shape-${tool}`, workspacePath };
    run = (toolArgs = args) => getTool(tool)!.execute(toolArgs, ctx);
  });

  afterAll(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  afterEach(() => {
    execFileAsyncMock.mockReset();
  });

  it("a run that printed nothing succeeds with the placeholder and counts zero printed characters", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });
    const result = await run();
    expect(result.success).toBe(true);
    expect(result.output).toBe("(no output)");
    expect(result.metadata?.["programOutputChars"]).toBe(0);
    expect(result.metadata?.["sandboxed"]).toBe(true);
  });

  it("whitespace alone is nothing printed", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "\n", stderr: "" });
    const result = await run();
    expect(result.success).toBe(true);
    expect(result.metadata?.["programOutputChars"]).toBe(0);
  });

  it("counts what the program printed", async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: "8392\n", stderr: "" });
    const result = await run();
    expect(result.output).toContain("8392");
    expect(result.metadata?.["programOutputChars"]).toBe(4);
  });

  it("a non-zero exit keeps its exit code and what the program printed", async () => {
    execFileAsyncMock.mockRejectedValue(execError({ code: 2, stdout: "", stderr: "node: not found" }));
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.metadata?.["exitCode"]).toBe(2);
    expect(result.metadata?.["programOutputChars"]).toBe("node: not found".length);
    expect(result.metadata?.["sandboxed"]).toBe(true);
  });

  it("a killed run is a timeout, in the sandbox, with what it printed before", async () => {
    execFileAsyncMock.mockRejectedValue(execError({ killed: true, signal: "SIGTERM", stdout: "partial", stderr: "" }));
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/);
    expect(result.metadata?.["timedOut"]).toBe(true);
    expect(result.metadata?.["sandboxed"]).toBe(true);
    expect(result.metadata?.["programOutputChars"]).toBe("partial".length);
  });
});

describe("a call refused before the program runs", () => {
  it("carries no programOutputChars, so it is never counted as an execution", async () => {
    await import("../tools/shell.js");
    const { getTool } = await import("../tools/registry.js");
    const ctx: ToolContext = { sessionId: "session-shape-refused", workspacePath: tmpdir() };
    const refusals = [
      await getTool("shell_exec")!.execute({ command: "   " }, ctx),
      await getTool("run_script")!.execute({ path: "notes.txt" }, ctx),
    ];
    for (const refusal of refusals) {
      expect(refusal.success).toBe(false);
      expect(refusal.metadata?.["programOutputChars"]).toBeUndefined();
    }
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });
});
