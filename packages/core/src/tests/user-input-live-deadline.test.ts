import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

/**
 * Review #14: a delegation clamps its specialist to the turn's deadline, and a human wait moves that
 * deadline the moment it ends. The deadline on the tool context was a static copy refreshed only
 * after a tool call returned, so a delegation started later in the SAME call — execute_plan's next
 * step, a dependent task-graph node — was clamped to the deadline from before the person answered.
 */
const runSubAgentWithStatsMock = vi.fn(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
  output: `${args.agentName}: done`,
  stats: {
    agentName: args.agentName,
    sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
    promptChars: 0,
    userContentChars: 0,
    toolCount: 1,
    toolNames: ["write_file"],
    iterations: 1,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    maxIterations: 5,
    model: "mock",
    capabilities: [],
    terminalState: "completed" as const,
    outcome: "success" as const,
  },
}));

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: vi.fn(async ({ agentName }: SubAgentRunOptions) => `${agentName}: done`),
  runSubAgentWithStats: runSubAgentWithStatsMock,
}));

const tempDirs: string[] = [];

afterEach(async () => {
  runSubAgentWithStatsMock.mockClear();
  delete process.env["SAI_CONFIG_PATH"];
  vi.resetModules();
  (await import("../config/loader.js")).resetConfigForTests();
  await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a delegation reads the turn deadline as it stands now", () => {
  it("clamps the specialist to the credited deadline, not the copy from before the wait", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sai-live-deadline-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      orchestration: { subAgentSynthesisReserveMs: 0 },
      subAgents: {
        web_coder: { description: "Builds pages", systemPrompt: "You build pages.", tools: ["write_file"], maxIterations: 5, turnTimeoutMs: 1_500_000 },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const [{ getTool }] = await Promise.all([import("../tools/registry.js"), import("../tools/sub-agent.js")]);
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      // Step 2 of a plan whose step 1 waited 8 minutes on the person: the static copy still says
      // one minute is left; the turn really has nine.
      await getTool("delegate_to_agent")!.execute(
        { agentName: "web_coder", task: "Build the page with the new hero image" },
        {
          sessionId: "session-live-deadline",
          workspacePath: "/workspace",
          turnTimeoutOverrideMs: 1_800_000,
          _turnDeadlineMs: now + 60_000,
          _liveTurnDeadlineMs: () => now + 540_000,
        },
      );
    } finally {
      nowSpy.mockRestore();
    }
    const args = runSubAgentWithStatsMock.mock.calls[0]![0];
    expect(args._turnDeadlineMs).toBe(now + 540_000);
    expect(args.turnTimeoutOverrideMs).toBe(540_000);
    expect(args.softDeadlineMs).toBeGreaterThan(now + 60_000);
  });
});
