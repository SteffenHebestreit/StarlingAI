import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutcomeEntry } from "../agent/outcomes.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";
import type { SwarmState, ToolContext } from "../tools/registry.js";
import { PRODUCT } from "../product/index.js";

/**
 * The outcome a collapsed parallel_delegate records carries the account it ran for (found in review,
 * 2026-10-08).
 *
 * When every slice of a fan-out is the same task, parallel_delegate runs it once and records a
 * "partial" outcome for the coordinator whose task is that slice's. The ledger is one file for the
 * whole deployment, and under multi-user auth a reader shows an entry's task only to the account it
 * was recorded for, so this entry has to carry that account too.
 */

const runSubAgentWithStatsMock = vi.fn(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
  output: `${args.agentName}: checked the ferry times and listed the three departures with their sources.`,
  stats: {
    agentName: args.agentName,
    sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
    promptChars: 0,
    userContentChars: String(args.task ?? "").length,
    toolCount: 1,
    toolNames: ["web_search"],
    iterations: 1,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    maxIterations: 5,
    model: "mock",
    capabilities: [],
    terminalState: "completed",
    outcome: "success",
  },
}));

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: vi.fn(async (args: SubAgentRunOptions) => (await runSubAgentWithStatsMock(args)).output),
  runSubAgentWithStats: runSubAgentWithStatsMock,
}));

/** Long enough for the duplicate check, which leaves bodies under 120 characters alone. */
const SLICE = "Check the Hamburg harbour ferry departures for Monday morning between Landungsbruecken and Finkenwerder, "
  + "list each departure with its line number, and cite the operator's timetable page for every time.";

describe("a collapsed parallel_delegate and the account it ran for", () => {
  let dir = "";

  /** A deployment with one researcher, multi-user auth on or off. */
  async function deployment(authEnabled: boolean): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), "collapse-account-"));
    writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
      workspacePath: dir,
      ...(authEnabled ? { auth: { enabled: true } } : {}),
      subAgents: { researcher: { description: "Finds sources on the web.", systemPrompt: "Research.", tools: ["web_search"], maxIterations: 4 } },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  }

  /** Two identical slices, delegated by the mission coordinator in the request of `userId`. */
  async function collapseAs(userId: string | undefined): Promise<OutcomeEntry | undefined> {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    const { runWithRequestContext } = await import("../runtime/request-context.js");
    const swarmState: SwarmState = { objective: "ferries", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: {} };
    const ctx: ToolContext = { sessionId: "collapse-session", workspacePath: dir, swarmState, currentAgentName: "mission_coordinator", ...(userId ? { userId } : {}) };
    await runWithRequestContext(userId ? { userId } : {}, () => getTool("parallel_delegate")!.execute({
      tasks: [{ agentName: "researcher", task: SLICE }, { agentName: "researcher", task: SLICE }],
    }, ctx));
    const file = join(dir, PRODUCT.stateDirName, "agent_outcomes.ndjson");
    if (!existsSync(file)) return undefined;
    return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as OutcomeEntry)
      .find((entry) => entry.agent === "mission_coordinator");
  }

  beforeEach(() => { runSubAgentWithStatsMock.mockClear(); });
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("under multi-user auth, records the user-scope segment of the account the delegation is for", async () => {
    await deployment(true);

    const entry = await collapseAs("bob");

    const { safeUserSegment } = await import("../runtime/user-scope.js");
    expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(1);
    expect(entry).toMatchObject({ outcome: "partial", task: SLICE, account: safeUserSegment("bob") });
  });

  it("with one operator, records the entry without an account, as before", async () => {
    await deployment(false);

    const entry = await collapseAs("bob");

    expect(entry).toMatchObject({ outcome: "partial", task: SLICE });
    expect(entry).not.toHaveProperty("account");
  });
});
