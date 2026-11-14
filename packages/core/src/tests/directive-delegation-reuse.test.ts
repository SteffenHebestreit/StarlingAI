import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwarmState, ToolContext } from "../tools/registry.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

/**
 * A DELEGATION THAT NAMES ITS AGENT IS SERVED ONLY THAT AGENT'S OWN RESULT.
 *
 * Signature reuse matched an earlier task by its words alone. On a turn directed to code_analyst
 * (`--agent`), an undirected delegation of the user's request had been answered by an ephemeral
 * agent, and the runtime's own dispatch to code_analyst (the same request as its task) was served
 * that answer: code_analyst never ran, the turn stayed directed, and the next dispatch hit the reuse
 * limit until the turn ended in a delegation failure (integration review, 2026-10-08).
 *
 * The same on a turn nobody directed (session 5b77edf9, 2026-11-13): an undirected weather lookup
 * had been run by mail_agent, the coordinator sent the same words to researcher by name, and was
 * handed the mail agent's answer as researcher's.
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

  it("still serves the earlier result to a delegation naming no agent, and to one naming the agent that ran it", async () => {
    // The controls: a caller that names nobody takes whatever ran the task, and one that names the
    // agent that ran it gets that run back — so a loop on one agent stays capped.
    const run = await delegate();
    const directed: ToolContext = { sessionId: "s-undirected-call", workspacePath: "/workspace", swarmState: freshSwarmState(), directiveAgent: "code_analyst" };
    await run({ agentName: "researcher", task: TASK }, directed);
    const undirectedCall = await run({ task: TASK }, directed);

    const plain: ToolContext = { sessionId: "s-plain-turn", workspacePath: "/workspace", swarmState: freshSwarmState() };
    await run({ agentName: "researcher", task: TASK }, plain);
    const sameAgentAgain = await run({ agentName: "researcher", task: TASK }, plain);
    const andAgain = await run({ agentName: "researcher", task: TASK }, plain);

    expect(ran()).toEqual(["researcher", "researcher"]);
    expect(undirectedCall.metadata).toMatchObject({ reused: true, agentName: "researcher" });
    expect(sameAgentAgain.metadata).toMatchObject({ reused: true, agentName: "researcher" });
    expect(andAgain.metadata).toMatchObject({ reused: true, reuseExhausted: true, agentName: "researcher" });
  }, 30_000);

  it("runs a named agent on any turn although another agent's result for the same task is at hand", async () => {
    // Session 5b77edf9: nobody directed the turn. The first run answered the task from the wrong
    // agent; the caller then named the right one, with the same words.
    const run = await delegate();
    const plain: ToolContext = { sessionId: "s-plain-named", workspacePath: "/workspace", swarmState: freshSwarmState() };

    await run({ agentName: "researcher", task: TASK }, plain);
    const named = await run({ agentName: "code_analyst", task: TASK }, plain);

    expect(ran()).toEqual(["researcher", "code_analyst"]);
    expect(named.success).toBe(true);
    expect(named.metadata?.["reused"]).toBeUndefined();
    expect(named.metadata).toMatchObject({ agentName: "code_analyst" });
    expect(named.output).toContain("CODE_ANALYST-FINDING");
    expect(named.output).not.toContain("RESEARCHER-FINDING");
    // Each agent's run is a task of its own, and a caller that names nobody now takes the first.
    expect(Object.values(plain.swarmState!.tasks).map((task) => task.selectedAgent)).toEqual(["researcher", "code_analyst"]);
    const unnamed = await run({ task: TASK }, plain);
    expect(unnamed.metadata).toMatchObject({ reused: true, agentName: "researcher" });
    expect(ran()).toEqual(["researcher", "code_analyst"]);
  }, 30_000);
});
