import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwarmState, ToolContext } from "../tools/registry.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

/**
 * C5' at the delegation tools (tools/sub-agent.ts), with the specialist runner mocked:
 *  (c) write ownership among the concurrently running siblings of run_task_graph and
 *      parallel_delegate (orchestration.siblingWriteOwnership, default on);
 *  (b) a later run of an agent that looped this turn is told the looped calls
 *      (orchestration.loopAwareDelegation, default off);
 *  and the turn's record of looped runs that (a), (d) and (e) read.
 *
 * The mocked runner does what a specialist's write does: it asks checkSiblingWrite, the function
 * the real sub-agent loop calls before any path-keyed write (sub-agent-sibling-write.test.ts drives
 * that loop). c297c5ea's fan-out is the shape: three builders, three named files, and the paper
 * builder editing the deck.
 */

const flags = vi.hoisted(() => ({ loopAware: false, ownership: true }));
vi.mock("../runtime/effort-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/effort-context.js")>();
  return {
    ...actual,
    effectiveOrchestration: () => ({
      ...actual.effectiveOrchestration(),
      loopAwareDelegation: flags.loopAware,
      siblingWriteOwnership: flags.ownership,
    }),
  };
});

type Behaviour = (args: SubAgentRunOptions) => Promise<Partial<SubAgentRunResult>> | Partial<SubAgentRunResult>;
const behaviour = vi.hoisted(() => ({ run: null as null | Behaviour }));

const statsFor = (args: SubAgentRunOptions, outcome: "success" | "partial" = "success"): SubAgentRunResult["stats"] => ({
  agentName: args.agentName,
  sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
  promptChars: 0,
  userContentChars: String(args.task ?? "").length,
  toolCount: 1,
  toolNames: ["write_file"],
  iterations: 1,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  maxIterations: 5,
  model: "mock",
  capabilities: [],
  terminalState: "completed",
  outcome,
});

const runSubAgentWithStatsMock = vi.fn(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
  const extra = behaviour.run ? await behaviour.run(args) : {};
  return {
    output: `${args.agentName}: wrote the section it was asked for, with the three sources and their URLs listed below the text.`,
    stats: statsFor(args),
    ...extra,
  };
});

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: vi.fn(async (args: SubAgentRunOptions) => (await runSubAgentWithStatsMock(args)).output),
  runSubAgentWithStats: runSubAgentWithStatsMock,
}));

const freshSwarmState = (): SwarmState => ({
  objective: "test",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  tasks: {},
});

/** What each run's writes got back, keyed "<agent or task>:<path>" (null = allowed). */
let writes: Map<string, unknown>;

/**
 * A runner that waits until `expected` runs have started (so they really run at the same time),
 * then tries `plan(args)` writes in order. Runs that start later (dependents) do not wait.
 */
function concurrentWriters(expected: number, plan: (args: SubAgentRunOptions) => { key: string; paths: string[] }): void {
  let started = 0;
  let release!: () => void;
  const allStarted = new Promise<void>((resolve) => { release = resolve; });
  behaviour.run = async (args) => {
    started += 1;
    if (started === expected) release();
    if (started <= expected) await allStarted;
    const { checkSiblingWrite } = await import("../agent/sibling-write-ownership.js");
    const { key, paths } = plan(args);
    for (const path of paths) writes.set(`${key}:${path}`, checkSiblingWrite(path));
    // Stay running until every concurrent sibling has written, so none finishes (and so stops
    // owning) before the others try.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {};
  };
}

describe("C5' at the delegation tools", () => {
  let tempDir = "";
  const ctx = (sessionId: string): ToolContext => ({
    sessionId,
    workspacePath: tempDir,
    swarmState: freshSwarmState(),
  });

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-loop-consequences-"));
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      subAgents: {
        content_writer: { description: "Writes documents and decks.", systemPrompt: "Write.", tools: ["write_file", "edit_file"], maxIterations: 4 },
        researcher: { description: "Finds sources on the web.", systemPrompt: "Research.", tools: ["web_search"], maxIterations: 4 },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    runSubAgentWithStatsMock.mockClear();
    behaviour.run = null;
    flags.loopAware = false;
    flags.ownership = true;
    writes = new Map();
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  const tools = async () => {
    const [{ getTool }] = await Promise.all([import("../tools/registry.js"), import("../tools/sub-agent.js")]);
    return getTool;
  };

  const GRAPH_NODES = [
    { id: "write_paper", agentName: "content_writer", task: "Write the paper to paper.md." },
    { id: "write_presentation", agentName: "content_writer", task: "Build the deck in presentation.html." },
    { id: "write_notes", agentName: "content_writer", task: "Write speaker notes to notes.md." },
  ];
  const nodeOf = (args: SubAgentRunOptions) => GRAPH_NODES.find((node) => node.task === args.task)?.id ?? String(args.task);

  describe("(c) write ownership, run_task_graph", () => {
    it("the paper node's edit of the deck is refused and names the owner; each node's own file goes through", async () => {
      concurrentWriters(3, (args) => {
        const id = nodeOf(args);
        const paths = id === "write_paper" ? ["presentation.html", "paper.md"]
          : id === "write_presentation" ? ["presentation.html"]
            : ["notes.md"];
        return { key: id, paths };
      });
      const getTool = await tools();
      await getTool("run_task_graph")!.execute({ objective: "Paper, deck and notes", nodes: GRAPH_NODES }, ctx("s-graph"));

      expect(runSubAgentWithStatsMock).toHaveBeenCalledTimes(3);
      expect(writes.get("write_paper:presentation.html"))
        .toEqual({ owner: "node 'write_presentation' (content_writer)", kind: "run_task_graph" });
      expect(writes.get("write_paper:paper.md")).toBeNull();
      expect(writes.get("write_presentation:presentation.html")).toBeNull();
      expect(writes.get("write_notes:notes.md")).toBeNull();
    }, 30_000);

    it("a node that depends on the deck may edit it once the deck node finished", async () => {
      const nodes = [
        { id: "deck", agentName: "content_writer", task: "Build the deck in deck.html." },
        { id: "paper", agentName: "content_writer", task: "Write the paper to paper.md." },
        { id: "review", agentName: "content_writer", task: "Fix the typos in the slides.", dependsOn: ["deck"] },
      ];
      concurrentWriters(2, (args) => {
        const id = nodes.find((node) => node.task === args.task)!.id;
        return { key: id, paths: id === "paper" ? ["paper.md"] : ["deck.html"] };
      });
      const getTool = await tools();
      await getTool("run_task_graph")!.execute({ objective: "Deck, paper, review", nodes }, ctx("s-graph-dep"));

      expect(writes.get("deck:deck.html")).toBeNull();
      expect(writes.get("review:deck.html")).toBeNull();
    }, 30_000);

    it("orchestration.siblingWriteOwnership false lets every write through", async () => {
      flags.ownership = false;
      concurrentWriters(3, (args) => ({ key: nodeOf(args), paths: ["presentation.html"] }));
      const getTool = await tools();
      await getTool("run_task_graph")!.execute({ objective: "Paper, deck and notes", nodes: GRAPH_NODES }, ctx("s-graph-off"));
      expect([...writes.values()]).toEqual([null, null, null]);
    }, 30_000);
  });

  describe("(c) write ownership, parallel_delegate", () => {
    const TASKS = [
      { agentName: "content_writer", task: "Write the paper to paper.md." },
      { agentName: "content_writer", task: "Build the deck in deck.html." },
      { agentName: "content_writer", task: "Write the chapter to site/chapter-1.html." },
      { agentName: "content_writer", task: "Write the chapter to site/chapter-2.html." },
    ];
    const sliceOf = (args: SubAgentRunOptions) => `task_${TASKS.findIndex((task) => task.task === args.task) + 1}`;

    it("the same shape through parallel_delegate: refused and named; two files in one directory both pass", async () => {
      concurrentWriters(4, (args) => {
        const slice = sliceOf(args);
        const paths = slice === "task_1" ? ["deck.html", "paper.md"]
          : slice === "task_2" ? ["deck.html"]
            : slice === "task_3" ? ["site/chapter-1.html"] : ["site/chapter-2.html"];
        return { key: slice, paths };
      });
      const getTool = await tools();
      await getTool("parallel_delegate")!.execute({ tasks: TASKS }, ctx("s-parallel"));

      expect(writes.get("task_1:deck.html")).toEqual({ owner: "task 2 (content_writer)", kind: "parallel_delegate" });
      expect(writes.get("task_1:paper.md")).toBeNull();
      expect(writes.get("task_2:deck.html")).toBeNull();
      expect(writes.get("task_3:site/chapter-1.html")).toBeNull();
      expect(writes.get("task_4:site/chapter-2.html")).toBeNull();
    }, 30_000);
  });

  describe("the turn's record of looped runs, and (b)", () => {
    const LOOP = { tool: "grep_files", target: "{\"pattern\":\"Reveal\",\"path\":\"deck.html\"}", repeats: 183, via: "refuse" as const, endedRun: true };

    function loopOnFirstRun(): void {
      let runs = 0;
      behaviour.run = (args) => {
        runs += 1;
        if (runs !== 1) return {};
        return {
          loopEnforced: LOOP,
          artifacts: [{ outputPath: "generated/deck.html", sourceTool: "write_file" }],
          stats: statsFor(args, "partial"),
        };
      };
    }

    it("records the looped run with the files it produced, and passes loopEnforced up in the result", async () => {
      loopOnFirstRun();
      const getTool = await tools();
      const turn = ctx("s-record");
      const first = await getTool("delegate_to_agent")!.execute({ agentName: "content_writer", task: "Build the deck in deck.html." }, turn);

      expect(turn._turnLoopRuns).toEqual([{
        agent: "content_writer",
        coordinator: false,
        loop: LOOP,
        outcome: "partial",
        paths: ["generated/deck.html"],
      }]);
      expect(first.metadata?.["loopEnforced"]).toEqual(LOOP);
    }, 30_000);

    it("hands the turn's own list to the run it starts, so a loop two delegations down lands in it", async () => {
      // c297c5ea's loops ran under a mission_coordinator; a run given no list starts its own,
      // which neither the artifact gate nor the turn oversight ever reads.
      const getTool = await tools();
      const turn = ctx("s-record-nested");
      turn._turnLoopRuns = [];
      await getTool("delegate_to_agent")!.execute({ agentName: "content_writer", task: "Build the deck in deck.html." }, turn);
      expect(runSubAgentWithStatsMock.mock.calls[0]![0]._turnLoopRuns).toBe(turn._turnLoopRuns);
    }, 30_000);

    it("with the flag on, the next run of the SAME agent is told the looped call; another agent is not", async () => {
      flags.loopAware = true;
      loopOnFirstRun();
      const getTool = await tools();
      const turn = ctx("s-prior-loop");
      await getTool("delegate_to_agent")!.execute({ agentName: "content_writer", task: "Build the deck in deck.html." }, turn);
      await getTool("delegate_to_agent")!.execute({ agentName: "content_writer", task: "Fix the slide initializer in the deck." }, turn);
      await getTool("delegate_to_agent")!.execute({ agentName: "researcher", task: "Find the opening hours." }, turn);

      const contexts = runSubAgentWithStatsMock.mock.calls.map(([args]) => String(args.context ?? ""));
      expect(contexts[0]).not.toContain("[PRIOR LOOP THIS TURN]");
      expect(contexts[1]).toContain("[PRIOR LOOP THIS TURN]");
      expect(contexts[1]).toContain(`- grep_files ${LOOP.target} (x183)`);
      expect(contexts[2]).not.toContain("[PRIOR LOOP THIS TURN]");
    }, 30_000);

    it("with the flag off, the next run is dispatched exactly as before", async () => {
      loopOnFirstRun();
      const getTool = await tools();
      const turn = ctx("s-prior-loop-off");
      await getTool("delegate_to_agent")!.execute({ agentName: "content_writer", task: "Build the deck in deck.html." }, turn);
      await getTool("delegate_to_agent")!.execute({ agentName: "content_writer", task: "Fix the slide initializer in the deck." }, turn);

      const contexts = runSubAgentWithStatsMock.mock.calls.map(([args]) => String(args.context ?? ""));
      expect(contexts[1]).not.toContain("[PRIOR LOOP THIS TURN]");
    }, 30_000);
  });
});
