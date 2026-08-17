import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const completeViaStreamMock = vi.fn();
const auditEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  // Spread the real module — sub-agent.ts and its helpers import value exports from
  // here, and a wholesale replacement breaks whenever production code grows one.
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async completeViaStream(messages: unknown, tools: unknown, signal?: AbortSignal, options?: unknown) {
      return completeViaStreamMock(messages, tools, signal, options);
    }
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeViaStreamMock(messages, tools, signal, undefined);
    }
  },
}));

vi.mock("../audit/logger.js", async (importActual) => ({
  ...(await importActual<typeof import("../audit/logger.js")>()),
  logAudit: (event: string, payload: Record<string, unknown>) => { auditEvents.push({ event, payload }); },
}));

/**
 * WIRING for the mid-stream burn abort, on the sub-agent side.
 *
 * The provider can now stop a burning generation while it streams (see
 * provider-mid-stream-reasoning-burn.test.ts). That is only half the fix: the salvaged
 * response comes back with ZERO tool calls, so the loop's "no tool calls = final
 * answer" branch would hand a 45,000-character monologue to the coordinator AS THE
 * AGENT'S ANSWER — the same silent-wrong-result shape the measured run produced, just
 * five minutes sooner.
 *
 * So this drives the real runSubAgent loop and asserts the run's own account of why it
 * ended, plus the audit record an operator would look for. The control run is the
 * discriminator: byte-identical response, `truncatedBy` absent, and it must be treated
 * as an ordinary (empty) answer with no wind-down.
 */

const SUPERVISOR_WIND_DOWN = "wound down by the progress supervisor";
/** The budget the provider aborts at, salvaged and handed back. */
const SALVAGED_REASONING_CHARS = 45_000;

function writeTempConfig(agentName: string): { tempDir: string; configPath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-mid-stream-burn-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    subAgents: {
      [agentName]: {
        description: "Mid-stream burn fixture",
        systemPrompt: "Work the task.",
        tools: ["read_file"],
        maxIterations: 6,
        turnTimeoutMs: 600_000,
      },
    },
  }), "utf8");
  return { tempDir, configPath };
}

/** The provider's salvaged partial after it aborted a burning generation. */
function burnSalvage(truncatedBy: "reasoning_burn" | undefined) {
  return {
    content: null,
    reasoning: "r".repeat(SALVAGED_REASONING_CHARS),
    tool_calls: [],
    usage: { promptTokens: 6845, completionTokens: 15_000, totalTokens: 21_845, estimated: true },
    finishReason: "length",
    ...(truncatedBy ? { truncatedBy } : {}),
  };
}

async function runFixture(agentName: string, truncatedBy: "reasoning_burn" | undefined) {
  const { tempDir, configPath } = writeTempConfig(agentName);
  process.env["SAI_CONFIG_PATH"] = configPath;
  vi.resetModules();
  completeViaStreamMock.mockImplementation(() => Promise.resolve(burnSalvage(truncatedBy)));

  const { runSubAgent } = await import("../agent/sub-agent.js");
  const output = String(await runSubAgent({
    agentName,
    task: "Do something useful.",
    parentSessionId: `mid-stream-burn-${agentName}`,
    workspacePath: tempDir,
  }));
  rmSync(tempDir, { recursive: true, force: true });
  return { output, calls: completeViaStreamMock.mock.calls.length };
}

describe("sub-agent — a provider-aborted burn winds the run down", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env["SAI_CONFIG_PATH"];
    completeViaStreamMock.mockReset();
    auditEvents.length = 0;
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const swarmMemory = await import("../swarm/memory.js");
    await swarmMemory.resetSharedMemoryForTests();
  });

  it("winds down, SAYS the supervisor did it, and never re-issues the completion", async () => {
    const { output, calls } = await runFixture("burn_agent", "reasoning_burn");

    expect(output).toContain(SUPERVISOR_WIND_DOWN);
    // The monologue is NOT presented as the answer.
    expect(output).not.toContain("r".repeat(200));
    // One call. A burning generation must not be retried — that is how a 20-minute
    // failure becomes a 40-minute one.
    expect(calls).toBe(1);

    const intervened = auditEvents.filter((e) => e.event === "progress_verifier_intervened");
    expect(intervened).toHaveLength(1);
    expect(intervened[0]!.payload["trigger"]).toBe("mid_stream");
    expect(intervened[0]!.payload["verdict"]).toBe("burning");
  });

  it("hands the operator's unbounded grant to the provider, as a live callback", async () => {
    await runFixture("grant_agent", "reasoning_burn");

    // Requirement 4 end-to-end: the option survives whatever wrapper chain
    // (boundary proxy, failover) the provider was built behind.
    const options = completeViaStreamMock.mock.calls[0]![3] as { isUnbounded?: unknown } | undefined;
    expect(typeof options?.isUnbounded).toBe("function");
    expect((options!.isUnbounded as () => boolean)()).toBe(false);
  });

  it("does NOT wind down the same response when the provider did not flag a burn", async () => {
    // THE DISCRIMINATOR. Identical content, identical reasoning volume, identical zero
    // tool calls — only `truncatedBy` differs. If this also wound down, the branch would
    // be reacting to "empty answer", not to the provider's decision.
    const { output } = await runFixture("control_agent", undefined);

    expect(output).not.toContain(SUPERVISOR_WIND_DOWN);
    expect(auditEvents.filter((e) => e.event === "progress_verifier_intervened")).toHaveLength(0);
  });
});
