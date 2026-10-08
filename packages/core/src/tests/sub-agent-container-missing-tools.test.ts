import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE GATEWAY REFUSES A CONTAINER START THAT CANNOT SUCCEED, AS A FAILURE — NOT A FALLBACK.
 *
 * The agent-worker registers none of the tools a containerized agent declares (its registry is
 * empty — see agent/container-tool-support.ts), so the gateway can tell statically that the run
 * would reach an empty registry and answer only in prose. It refuses before spawning, with the
 * same honest failure the worker writes for itself, and the run must surface as a FAILED
 * delegation (outcome=failure / terminalState=error) so the retry/fallback cascade and the honest
 * reporting act — never a silent in-process downgrade.
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

describe("gateway static refusal when the worker cannot run the agent's tools", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const swarmMemory = await import("../swarm/memory.js");
    await swarmMemory.resetSharedMemoryForTests();
  });

  it("turns the unrunnable containerized agent into a failed delegation without spawning", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-container-missing-tools-"));
    const configPath = join(tempDir, "starlingai.json");

    // defaultContainerized is forced OFF in the test harness env (vitest.config.ts) so mock-LLM
    // tests stay in-process; turn it back ON here so this agent actually takes the container path.
    writeFileSync(configPath, JSON.stringify({
      agents: {
        defaultContainerized: true,
        defaults: {
          model: { primary: "lmstudio/probe-model", temperature: 0.1, maxTokens: 1024 },
        },
      },
      subAgents: {
        worker_specialist: {
          description: "A worker-eligible specialist whose tools the worker image does not register.",
          systemPrompt: "Use your tools.",
          // shell_exec/read_file are neither orchestration nor gateway-bound, so the agent is
          // container-eligible — and neither is registered in the worker, so it cannot run there.
          tools: ["shell_exec", "read_file"],
          maxIterations: 2,
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    // If the container runner is reached at all, the static refusal did not fire. The mock lets
    // the test prove the spawn was skipped AND that no "success" leaked out of the runner.
    const runSubAgentInContainerMock = vi.fn(async () => ({
      output: "container path should never run for an agent the worker cannot serve",
      metrics: { containerRuntimeMs: 1, heartbeatSupported: true },
    }));
    vi.doMock("../agent/container-runner.js", () => ({
      runSubAgentInContainer: runSubAgentInContainerMock,
    }));

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "worker_specialist",
        task: "Run the build and read the log.",
        parentSessionId: "parent-container-missing-tools",
        workspacePath: tempDir,
      });

      // Refused statically — the container was never spawned and the provider never called.
      expect(runSubAgentInContainerMock).not.toHaveBeenCalled();
      expect(completeMock).not.toHaveBeenCalled();

      // Surfaced as a failure, not a success.
      expect(result.stats.outcome).toBe("failure");
      expect(result.stats.terminalState).toBe("error");

      // The honest message names the agent and its tools and states nothing was answered.
      expect(result.output).toContain("container error:");
      expect(result.output).toContain("worker_specialist");
      expect(result.output).toContain("shell_exec");
      expect(result.output).toContain("read_file");
      expect(result.output).toMatch(/returned no answer rather than answering without/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 20_000);
});
