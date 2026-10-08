import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwarmState, ToolContext } from "../tools/registry.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

/**
 * A DELEGATION NAMING THE AGENT THE USER DIRECTED THE TURN TO IS SERVED ONLY THAT AGENT'S OWN RESULT.
 *
 * Signature reuse matched an earlier task by its words alone. On a turn directed to code_analyst
 * (`--agent`), an undirected delegation of the user's request had been answered by an ephemeral
 * agent, and the runtime's own dispatch to code_analyst (the same request as its task) was served
 * that answer: code_analyst never ran, the turn stayed directed, and the next dispatch hit the reuse
 * limit until the turn ended in a delegation failure (integration review, 2026-10-08).
 */
const statsFor = (args: SubAgentRunOptions): SubAgentRunResult["stats"] => ({
  agentName: args.agentName,
  sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
  promptChars: 0,
  userContentChars: String(args.task ?? "").length,
  toolCount: 1,
  toolNames: ["read_file"],
  iterations: 1,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  maxIterations: 4,
  model: "mock",
  capabilities: [],
  terminalState: "completed",
  outcome: "success",
});
const runSubAgentWithStatsMock = vi.fn(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => ({
  output: `${args.agentName.toUpperCase()}-FINDING: int() truncates the cent in invoices.py at line 12; round(subtotal + tax, 2) fixes it.`,
  stats: statsFor(args),
}));

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: vi.fn(async (args: SubAgentRunOptions) => (await runSubAgentWithStatsMock(args)).output),
  runSubAgentWithStats: runSubAgentWithStatsMock,
}));

const TASK = "Why does invoices.py undercharge by a cent? def total(subtotal, tax): return int(subtotal + tax)";

const freshSwarmState = (): SwarmState => ({
  objective: "test",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  tasks: {},
});

describe("signature reuse on a turn directed to an agent", () => {
  let tempDir = "";
  /** The agents the runner ran, in call order. */
  const ran = () => runSubAgentWithStatsMock.mock.calls.map((call) => call[0].agentName);

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-directive-reuse-"));
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      subAgents: {
        researcher: { description: "Finds sources on the web.", systemPrompt: "Research.", tools: ["web_search", "web_fetch"], maxIterations: 4 },
        code_analyst: { description: "Analyzes source code and finds bugs.", systemPrompt: "Analyze.", tools: ["read_file"], maxIterations: 4 },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    runSubAgentWithStatsMock.mockClear();
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  const delegate = async () => {
    const [{ getTool }] = await Promise.all([import("../tools/registry.js"), import("../tools/sub-agent.js")]);
    return (args: Record<string, unknown>, ctx: ToolContext) => getTool("delegate_to_agent")!.execute(args, ctx);
  };

  it("runs the directed agent although another agent's result for the same task is at hand", async () => {
    const run = await delegate();
    const ctx: ToolContext = { sessionId: "s-directed", workspacePath: "/workspace", swarmState: freshSwarmState(), directiveAgent: "code_analyst" };

    await run({ agentName: "researcher", task: TASK }, ctx);
    const earlier = Object.values(ctx.swarmState!.tasks)[0]!;
    const result = await run({ agentName: "code_analyst", task: TASK }, ctx);

    expect(ran()).toEqual(["researcher", "code_analyst"]);
    expect(result.success).toBe(true);
    expect(result.metadata?.["reused"]).toBeUndefined();
    expect(result.output).toContain("CODE_ANALYST-FINDING");
    // The researcher's record is its own still: the directed run went under a task of its own.
    expect(earlier.selectedAgent).toBe("researcher");
    expect(earlier.output).toContain("RESEARCHER-FINDING");
  }, 30_000);

  it("serves the directed agent its own result next, and stops at the reuse limit", async () => {
    // The first match by signature is the other agent's task. Taken as the only candidate, a later
    // delegation to the agent would miss the agent's own run behind it and start it again, and the
    // reuse limit would never be reached.
    const run = await delegate();
    const ctx: ToolContext = { sessionId: "s-directed-again", workspacePath: "/workspace", swarmState: freshSwarmState(), directiveAgent: "code_analyst" };

    await run({ agentName: "researcher", task: TASK }, ctx);
    await run({ agentName: "code_analyst", task: TASK }, ctx);
    const served = await run({ agentName: "code_analyst", task: TASK }, ctx);
    const exhausted = await run({ agentName: "code_analyst", task: TASK }, ctx);

    expect(ran()).toEqual(["researcher", "code_analyst"]);
    expect(served.metadata).toMatchObject({ reused: true, agentName: "code_analyst" });
    expect(served.output).toContain("CODE_ANALYST-FINDING");
    expect(exhausted.metadata).toMatchObject({ reused: true, reuseExhausted: true, agentName: "code_analyst" });
  }, 30_000);

  it("still serves the earlier result to a delegation naming no agent, or on a turn no agent was named for", async () => {
    // The controls: reuse by signature alone is unchanged everywhere else.
    const run = await delegate();
    const directed: ToolContext = { sessionId: "s-undirected-call", workspacePath: "/workspace", swarmState: freshSwarmState(), directiveAgent: "code_analyst" };
    await run({ agentName: "researcher", task: TASK }, directed);
    const undirectedCall = await run({ task: TASK }, directed);

    const plain: ToolContext = { sessionId: "s-plain-turn", workspacePath: "/workspace", swarmState: freshSwarmState() };
    await run({ agentName: "researcher", task: TASK }, plain);
    const namedOnPlainTurn = await run({ agentName: "code_analyst", task: TASK }, plain);

    expect(ran()).toEqual(["researcher", "researcher"]);
    expect(undirectedCall.metadata).toMatchObject({ reused: true, agentName: "researcher" });
    expect(namedOnPlainTurn.metadata).toMatchObject({ reused: true, agentName: "researcher" });
  }, 30_000);
});
