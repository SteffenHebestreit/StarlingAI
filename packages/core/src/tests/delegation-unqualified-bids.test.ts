import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tools/registry.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

/**
 * A BID STANDS ON ITS OWN SCORE, FOR AN AGENT THE DELEGATION MAY USE.
 *
 * Session 5b77edf9 (2026-11-13), a German question about the afternoon's weather: the main
 * assistant delegated to web_task_coordinator, which delegated the lookup on without naming an
 * agent. The router ranked nobody (researcher 0.716, under its 0.72 floor), so the bids decided:
 * the coordinator's own at 0.77, and one for mail_agent at 0.17 from a bidder that counted word
 * fragments. The queue took every bid because the best one cleared the threshold; the
 * coordinator's was passed over as the caller, and mail_agent ran the weather lookup — found no
 * mail about the weather and estimated one "from typical November data".
 */
const runner = vi.hoisted(() => vi.fn());
const audit = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  ranking: [] as Array<{ name: string; score: number }>,
  near: [] as Array<{ name: string; score: number }>,
  bids: [] as Array<{ agentName: string; score: number; confidence: "high" | "medium" | "low" }>,
  announcements: [] as Array<Record<string, unknown>>,
}));

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: vi.fn(async () => "no spec"),
  runSubAgentWithStats: runner,
}));
vi.mock("../audit/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/logger.js")>();
  return {
    ...actual,
    logAudit: (...args: Parameters<typeof actual.logAudit>) => { audit(...args); return actual.logAudit(...args); },
  };
});
vi.mock("../tools/agent-routing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/agent-routing.js")>();
  return {
    ...actual,
    resolveAgentRouting: async (query: string, opts?: { minConfidence?: "high" | "medium" | "low"; excludeAgents?: string[] }) => {
      const open = (entry: { name: string }) => !(opts?.excludeAgents ?? []).includes(entry.name);
      const results = state.ranking.filter(open);
      return {
        query, minConfidence: opts?.minConfidence ?? "medium", mode: "hybrid" as const,
        results: results.map((entry) => ({
          name: entry.name, description: `${entry.name} test agent`, model: "mock", confidence: "high" as const,
          score: entry.score, matchedTerms: [], capabilities: [], tags: [],
        })),
        weakCandidates: [], gated: false, trippedAgents: [], allLowConfidence: false,
        nearMisses: results.length > 0 ? [] : state.near.filter(open),
      };
    },
  };
});
vi.mock("../swarm/bidding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../swarm/bidding.js")>();
  return {
    ...actual,
    isAutonomousBiddingStarted: () => true,
    clearTaskBids: () => undefined,
    collectTaskBids: async (taskId: string) => state.bids.map((bid) => ({
      taskId, ...bid, matchedTerms: [], bidderInstance: "test", ts: new Date().toISOString(),
    })),
  };
});
vi.mock("../swarm/bus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../swarm/bus.js")>();
  return {
    ...actual,
    emitSwarmEvent: (type: string, payload: Record<string, unknown>) => {
      if (type === "task_announced") state.announcements.push(payload);
      return actual.emitSwarmEvent(type as never, payload as never);
    },
  };
});

const ranAgents = () => runner.mock.calls.map((call) => (call[0] as SubAgentRunOptions).agentName);
const rows = (type: string) => audit.mock.calls.filter((call) => call[0] === type).map((call) => call[1] as Record<string, unknown>);

const TASK = "Ermittle das aktuelle Wetter für Bremen, Deutschland für heute Nachmittag (ca. 12–18 Uhr am 13. November 2026). "
  + "Suche nach aktuellen Wettervorhersagen von mindestens zwei unabhängigen Quellen. Zitiere die Quellen mit genauen URLs.";

describe("the bids for an undirected delegation", () => {
  let tempDir = "";
  const writeConfig = async (orchestration: Record<string, unknown> = {}) => {
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      workspacePath: tempDir,
      agents: {
        defaults: { model: { primary: "mock-model" } },
        // Off, so that a delegation nobody takes ends where the test can read it.
        ephemeralGeneration: { enabled: false, skillMatchThreshold: 0.75 },
      },
      orchestration,
      subAgents: {
        web_task_coordinator: { description: "Coordinates live lookups.", systemPrompt: "Test.", tools: ["search_agents", "delegate_to_agent", "parallel_delegate"], maxIterations: 4 },
        researcher: { description: "Finds sources on the web.", systemPrompt: "Test.", tools: ["web_search", "web_fetch"], maxIterations: 4 },
        browser_agent: { description: "Opens pages in a browser.", systemPrompt: "Test.", tools: ["web_fetch", "mcp__playwright__browser_navigate"], maxIterations: 4 },
        mail_agent: { description: "Reads and writes mail.", systemPrompt: "Test.", tools: ["mail_search", "mail_read"], maxIterations: 4 },
        calendar_agent: { description: "Reads the calendar.", systemPrompt: "Test.", tools: ["calendar_list"], maxIterations: 4 },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  };
  /** A delegation by the coordinator, as its own tool call makes it. */
  const delegate = async (args: Record<string, unknown>, ctx: ToolContext) => {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/sub-agent.js");
    return getTool("delegate_to_agent")!.execute({ task: TASK, deliverable: "answer", ...args }, ctx);
  };
  const coordinatorCtx = (sessionId: string): ToolContext =>
    ({ sessionId, workspacePath: tempDir, currentAgentName: "web_task_coordinator" } as ToolContext);

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-unqualified-bids-"));
    state.ranking = [];
    state.near = [{ name: "researcher", score: 0.7164 }, { name: "browser_agent", score: 0.7053 }];
    // As on the day: the coordinator's own bid, and two from the bidder that counted word fragments.
    state.bids = [
      { agentName: "web_task_coordinator", score: 0.7737, confidence: "high" },
      { agentName: "mail_agent", score: 0.1695, confidence: "low" },
      { agentName: "calendar_agent", score: 0.1356, confidence: "low" },
    ];
    state.announcements = [];
    runner.mockImplementation(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
      output: `${args.agentName}: 8 °C, teils sonnig, Quelle https://wetter.example/bremen`,
      stats: {
        agentName: args.agentName, sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`, promptChars: 0, userContentChars: 0,
        toolCount: 1, toolNames: ["web_fetch"], iterations: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: 4, model: "mock", capabilities: [], terminalState: "completed", outcome: "success",
      },
    }));
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env["SAI_CONFIG_PATH"];
    runner.mockReset();
    audit.mockReset();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
  });

  it("does not run an agent whose bid is under the threshold behind a bid that is passed over", async () => {
    await writeConfig();
    const result = await delegate({}, coordinatorCtx("bids-incident"));

    // The mail agent ran here, with the weather lookup as its task.
    expect(ranAgents()).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.metadata).toMatchObject({ delegationSucceeded: false, attemptedAgents: [] });
    expect(rows("delegation_bidding_filtered_unqualified")).toEqual([
      expect.objectContaining({
        skillMatchThreshold: 0.75,
        droppedAgents: [
          { agent: "web_task_coordinator", score: 0.774, reason: "barred" },
          { agent: "mail_agent", score: 0.17, reason: "under_threshold" },
          { agent: "calendar_agent", score: 0.136, reason: "under_threshold" },
        ],
      }),
    ]);
    // The caller's own bid never reaches the queue, so it is not a coordinator passed over in it.
    expect(rows("delegation_coordinator_recursion_blocked")).toEqual([]);
  }, 30_000);

  it("announces the task with its caller left out, as its own routing leaves it out", async () => {
    await writeConfig();
    await delegate({}, coordinatorCtx("bids-announcement"));

    expect(state.announcements).toHaveLength(1);
    expect((state.announcements[0]!["data"] as Record<string, unknown>)["excludeAgents"]).toEqual(["web_task_coordinator"]);
  }, 30_000);

  it("runs the agent whose bid clears the threshold, and only that one", async () => {
    await writeConfig();
    state.bids = [
      { agentName: "browser_agent", score: 0.81, confidence: "high" },
      { agentName: "mail_agent", score: 0.1695, confidence: "low" },
    ];
    // It fails: what is left in the queue behind it decides whether the mail agent is next.
    runner.mockImplementation(async (args: SubAgentRunOptions) => { throw new Error(`${args.agentName} could not open the page`); });
    const result = await delegate({}, coordinatorCtx("bids-qualified"));

    expect(ranAgents()).toEqual(["browser_agent"]);
    expect(result.success).toBe(false);
    expect(rows("delegation_bidding_filtered_unqualified")[0]).toMatchObject({
      droppedAgents: [{ agent: "mail_agent", score: 0.17, reason: "under_threshold" }],
    });
  }, 30_000);

  it("leaves the queue as it was when every bid clears the threshold", async () => {
    await writeConfig();
    state.bids = [
      { agentName: "browser_agent", score: 0.81, confidence: "high" },
      { agentName: "researcher", score: 0.78, confidence: "high" },
    ];
    const result = await delegate({}, coordinatorCtx("bids-all-qualified"));

    expect(ranAgents()).toEqual(["browser_agent"]);
    expect(result.success).toBe(true);
    expect(rows("delegation_bidding_filtered_unqualified")).toEqual([]);
  }, 30_000);

  it("names the router's nearest agents when nobody was tried, where near misses are surfaced", async () => {
    await writeConfig({ surfaceRoutingNearMisses: true });
    const surfaced = await delegate({}, coordinatorCtx("bids-hint-on"));
    expect(surfaced.error).toContain("No agent was tried.");
    expect(surfaced.error).toContain("researcher (0.716), browser_agent (0.705)");
    expect(surfaced.error).toContain("delegate to it by name");

    await writeConfig();
    const silent = await delegate({}, coordinatorCtx("bids-hint-off"));
    expect(silent.error).not.toContain("Closest matches");
    expect(silent.error).toContain("No suitable agent completed the task.");
  }, 30_000);

  it("then runs the agent the caller names for the same words", async () => {
    // What the coordinator did next: the same task, to researcher by name. It was handed the mail
    // agent's answer; here nothing ran before, and researcher runs.
    await writeConfig();
    const ctx = coordinatorCtx("bids-then-named");
    await delegate({}, ctx);
    const named = await delegate({ agentName: "researcher" }, ctx);

    expect(ranAgents()).toEqual(["researcher"]);
    expect(named.success).toBe(true);
    expect(named.metadata?.["reused"]).toBeUndefined();
    expect(named.output).toContain("researcher: 8 °C");
  }, 30_000);
});
