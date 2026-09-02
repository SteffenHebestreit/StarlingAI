import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnPlan } from "../agent/turn-plan.js";

const calls: string[] = [];

vi.mock("../tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/registry.js")>();
  return {
    ...actual,
    executeTool: vi.fn(async (name: string) => {
      calls.push(name);
      return { success: true, output: `${name} done: three findings` };
    }),
  };
});

const { getTool } = await import("../tools/registry.js");
await import("../tools/plan-executor.js");
const { persistTurnPlan } = await import("../agent/turn-plan.js");

const SESSION = "plan-reasoning-leaf";
const plan = (steps: TurnPlan["steps"]): TurnPlan => ({
  objective: "answer the question",
  steps,
  acceptanceCriteria: [],
  stopConditions: [],
  riskTier: "low",
  wide: false,
  createdAt: new Date(0).toISOString(),
});
const run = () => getTool("execute_plan")!.execute({}, { sessionId: SESSION, workspacePath: "/w" } as never);

/**
 * A tool-less `direct` step that nothing depends on is the plan describing the reply the
 * orchestrator writes next. Reported as YOURS TO DO it demanded another execute_plan({completed})
 * round trip for work that IS the reply.
 */
describe("execute_plan — a trailing reasoning step is the answer, not a blocker", () => {
  beforeEach(() => { calls.length = 0; });
  afterEach(() => { vi.clearAllMocks(); });

  it("reports a tool-less direct step nothing depends on as done", async () => {
    await persistTurnPlan(SESSION, plan([
      { id: "s1", description: "gather the facts", kind: "delegate", agent: "researcher" },
      { id: "s2", description: "summarize the findings for the user", kind: "direct", dependsOn: ["s1"] },
    ]));
    const result = await run();
    expect(calls).toEqual(["delegate_to_agent"]);
    expect(result.metadata?.["done"]).toBe(2);
    expect(result.metadata?.["manual"]).toBe(0);
    expect(result.output).not.toMatch(/YOURS TO DO/);
  });

  it("keeps a standalone tool-less step as the orchestrator's own work", async () => {
    // No dependsOn: it consumes nothing, so it is not the synthesis of anything — "decide the
    // framing" is work the orchestrator does and reports, not the reply.
    await persistTurnPlan(SESSION, plan([
      { id: "s1", description: "gather the facts", kind: "delegate", agent: "researcher" },
      { id: "s2", description: "decide the framing", kind: "direct" },
    ]));
    const result = await run();
    expect(result.metadata?.["manual"]).toBe(1);
    expect(result.output).toMatch(/YOURS TO DO[\s\S]*s2/);
  });

  it("still hands over a tool-less direct step that other steps wait on", async () => {
    await persistTurnPlan(SESSION, plan([
      { id: "s1", description: "decide the outline", kind: "direct" },
      { id: "s2", description: "write it up", kind: "delegate", agent: "content_writer", dependsOn: ["s1"] },
    ]));
    const result = await run();
    expect(calls).toEqual([]);
    expect(result.metadata?.["manual"]).toBe(1);
    expect(result.output).toMatch(/YOURS TO DO/);
  });
});
