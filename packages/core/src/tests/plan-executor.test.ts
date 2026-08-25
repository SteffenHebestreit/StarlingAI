import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolResult } from "../tools/registry.js";
import type { TurnPlan } from "../agent/turn-plan.js";

/**
 * THE WIRING, not the scheduler (that is plan-frontier.test.ts).
 *
 * execute_plan deliberately dispatches through the REGISTERED tools rather than reimplementing
 * delegation or workflow execution, so each step inherits their tier gating, per-turn caps,
 * approval callbacks, swarm state and audit. These prove the dispatch actually goes there, with
 * the right tool per kind and the upstream results carried into the task — which is the thing a
 * one-line step description cannot supply on its own.
 */
const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
let respond: (name: string, args: Record<string, unknown>) => ToolResult;
/** Highest number of dispatches in flight at once — how concurrency is observed below. */
let inFlight = 0;
let maxInFlight = 0;

vi.mock("../tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/registry.js")>();
  return {
    ...actual,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // A real tick, so two dispatches issued together actually overlap here rather than
      // resolving in issue order — otherwise this observes nothing.
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return respond(name, args);
    }),
  };
});

const { getTool } = await import("../tools/registry.js");
await import("../tools/plan-executor.js");
const { persistTurnPlan, loadTurnPlan } = await import("../agent/turn-plan.js");

const SESSION = "plan-exec-session";

const basePlan = (steps: TurnPlan["steps"]): TurnPlan => ({
  objective: "produce the report",
  steps,
  acceptanceCriteria: ["cites its sources"],
  stopConditions: [],
  riskTier: "low",
  wide: false,
  createdAt: new Date(0).toISOString(),
});

const ctx = () => ({ sessionId: SESSION, workspacePath: "/w" }) as never;
const run = async (): Promise<ToolResult> => getTool("execute_plan")!.execute({}, ctx());

describe("execute_plan dispatches each step to the tool that runs that kind", () => {
  beforeEach(() => {
    calls.length = 0;
    inFlight = 0;
    maxInFlight = 0;
    respond = () => ({ success: true, output: "ok" });
  });
  afterEach(() => { vi.clearAllMocks(); });

  it("sends a delegate step to delegate_to_agent and a reuse step to run_workflow", async () => {
    await persistTurnPlan(SESSION, basePlan([
      { id: "s1", description: "gather sources", kind: "reuse", workflow: "research_pack" },
      { id: "s2", description: "write it up", kind: "delegate", agent: "content_writer", dependsOn: ["s1"] },
    ]));

    const result = await run();
    expect(result.success).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(["run_workflow", "delegate_to_agent"]);
    expect(calls[0]?.args["name"]).toBe("research_pack");
    expect(calls[1]?.args["agentName"]).toBe("content_writer");
  });

  it("carries an upstream step's result into the step that depended on it", async () => {
    // Run e95eec63: a task that REFERS to material it does not carry produced an invented
    // answer, because the specialist could not see the conversation. dependsOn already asserts
    // the downstream step needs that material, so the dispatch supplies it.
    respond = (name) => ({ success: true, output: name === "run_workflow" ? "SOURCE: rfc-9110 section 9" : "done" });
    await persistTurnPlan(SESSION, basePlan([
      { id: "s1", description: "gather sources", kind: "reuse", workflow: "research_pack" },
      { id: "s2", description: "write it up", kind: "delegate", dependsOn: ["s1"] },
    ]));

    await run();
    const task = String(calls[1]?.args["task"] ?? "");
    expect(task).toContain("SOURCE: rfc-9110 section 9");
    expect(task).toContain("produce the report");     // the objective it serves
    expect(task).toContain("cites its sources");      // what the turn must satisfy
  });

  it("runs a parallelGroup concurrently and a plain sequence one at a time", async () => {
    // THE DISCRIMINATOR is the overlap, not the call count — both plans dispatch two steps.
    // Parallelism is the plan's decision: a shared parallelGroup means "independent and may run
    // concurrently", while two steps with no declared edge are not known to be independent.
    await persistTurnPlan(SESSION, basePlan([
      { id: "a", description: "a", kind: "delegate", parallelGroup: 1 },
      { id: "b", description: "b", kind: "delegate", parallelGroup: 1 },
    ]));
    await run();
    expect(calls).toHaveLength(2);
    expect(maxInFlight).toBe(2);

    calls.length = 0;
    inFlight = 0;
    maxInFlight = 0;
    await persistTurnPlan(SESSION, basePlan([
      { id: "a", description: "a", kind: "delegate" },
      { id: "b", description: "b", kind: "delegate" },
    ]));
    await run();
    expect(calls).toHaveLength(2);   // both still run — across rounds
    expect(maxInFlight).toBe(1);     // ...but never at the same time
  });

  it("hands a `direct` step back and reports what is waiting on it", async () => {
    await persistTurnPlan(SESSION, basePlan([
      { id: "s1", description: "decide the framing", kind: "direct" },
      { id: "s2", description: "write it up", kind: "delegate", dependsOn: ["s1"] },
    ]));

    const result = await run();
    expect(calls).toHaveLength(0);                       // nothing to dispatch
    expect(result.output).toMatch(/YOURS TO DO/);
    expect(result.output).toMatch(/WAITING/);
    expect(result.output).toMatch(/Do NOT write the final answer/);
  });

  it("is resumable: a second call continues from the recorded outcomes", async () => {
    await persistTurnPlan(SESSION, basePlan([
      { id: "s1", description: "decide the framing", kind: "direct" },
      { id: "s2", description: "write it up", kind: "delegate" },
    ]));
    await run();
    expect(calls.map((c) => c.name)).toEqual(["delegate_to_agent"]);

    // s2 already ran; a second call must not run it again.
    calls.length = 0;
    await run();
    expect(calls).toHaveLength(0);
    const stored = await loadTurnPlan(SESSION);
    expect(stored?.outcomes?.find((o) => o.id === "s2")?.status).toBe("done");
    expect(stored?.outcomes?.find((o) => o.id === "s1")?.status).toBe("manual");
  });

  it("reports a failed step instead of pressing on into its dependents", async () => {
    respond = (name) => name === "delegate_to_agent"
      ? { success: false, output: "", error: "specialist unavailable" }
      : { success: true, output: "ok" };
    await persistTurnPlan(SESSION, basePlan([
      { id: "s1", description: "gather", kind: "delegate" },
      { id: "s2", description: "write", kind: "delegate", dependsOn: ["s1"] },
    ]));

    const result = await run();
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/FAILED/);
    expect(result.output).toMatch(/specialist unavailable/);
    expect(calls).toHaveLength(1);                        // s2 was never dispatched
  });

  it("refuses a plan whose dependencies form a cycle", async () => {
    await persistTurnPlan(SESSION, basePlan([
      { id: "a", description: "a", kind: "delegate", dependsOn: ["b"] },
      { id: "b", description: "b", kind: "delegate", dependsOn: ["a"] },
    ]));
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cycle/);
    expect(calls).toHaveLength(0);
  });

  it("says so when there is no plan, rather than doing nothing quietly", async () => {
    const { clearTurnPlanForSession } = await import("../agent/turn-plan.js");
    await clearTurnPlanForSession(SESSION);
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/record_plan/);
  });
});
