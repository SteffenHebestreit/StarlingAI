import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext, ToolResult } from "../tools/registry.js";

/**
 * THE PLAN ROUND FOLD (orchestration.planRoundFold, finding 2026-10-05).
 *
 * record_plan used to save the plan and answer "CALL execute_plan", so every planned turn paid a
 * whole orchestrator round — 1-2 s warm, 8-13 s on a cold head — for a call that takes no
 * arguments. A record_plan that was its response's only call now runs the executor itself. These
 * pin what the fold must keep: it runs only when it is safe (alone in its response, a dispatchable
 * plan, approval granted, the executor in reach), and what it ran is reported to the turn exactly as
 * execute_plan's own call would be — the per-turn counts, the delegation tally and the outcomes
 * planDrivenContinuation reads.
 *
 * The real executor runs; only the tools it dispatches are stubbed.
 */
const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];
let respond: (name: string) => ToolResult = () => ({ success: true, output: "step result" });

vi.mock("../tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/registry.js")>();
  return {
    ...actual,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>, ctx: ToolContext) => {
      // The executor itself runs for real, so the fold is exercised end to end.
      if (name === "execute_plan") return actual.executeTool(name, args, ctx);
      dispatched.push({ name, args });
      return respond(name);
    }),
  };
});

const { getTool } = await import("../tools/registry.js");
await import("../tools/turn-plan-tool.js");
// Registered on its own, as register-builtins does: the fold must not be what registers the executor.
await import("../tools/plan-executor.js");
const { loadTurnPlan, clearTurnPlanForSession } = await import("../agent/turn-plan.js");
const { getConfig } = await import("../config/loader.js");
const { readNestedToolCalls, nestedCallContribution, DELEGATION_WAIT_TOOL_NAMES } = await import("../agent/turn-tool-contribution.js");
const { buildModelVisibleToolResult } = await import("../agent/tool-result-format.js");
const { decidePlanContinuation } = await import("../agent/turn-plan.js");

const SESSION = "plan-round-fold";

const PLAN = {
  objective: "compare two recorders",
  steps: [
    { id: "s1", description: "research recorder A", kind: "delegate", agent: "researcher", parallelGroup: 1 },
    { id: "s2", description: "research recorder B", kind: "delegate", agent: "researcher", parallelGroup: 1 },
    { id: "s3", description: "summarise the comparison", kind: "direct", dependsOn: ["s1", "s2"] },
  ],
  acceptanceCriteria: ["names a winner"],
};

const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  sessionId: SESSION,
  workspacePath: "/w",
  responseToolCalls: ["record_plan"],
  ...overrides,
}) as ToolContext;

const record = (args: Record<string, unknown> = PLAN, overrides: Partial<ToolContext> = {}): Promise<ToolResult> =>
  getTool("record_plan")!.execute(args, ctx(overrides));

describe("record_plan folds the plan round", () => {
  const original = { ...getConfig().orchestration };
  beforeEach(async () => {
    dispatched.length = 0;
    respond = () => ({ success: true, output: "step result" });
    await clearTurnPlanForSession(SESSION);
  });
  afterEach(() => {
    Object.assign(getConfig().orchestration, original);
    vi.clearAllMocks();
  });

  it("runs the plan in the same call when record_plan was the response's only call", async () => {
    const result = await record();

    expect(result.success).toBe(true);
    // Both delegate steps went out from inside record_plan — no second orchestrator round.
    expect(dispatched.map((d) => d.name)).toEqual(["delegate_to_agent", "delegate_to_agent"]);
    expect(result.output).toMatch(/EXECUTED in this same call/);
    expect(result.output).toMatch(/do NOT call execute_plan again/);
    expect(result.output).toContain("Plan: 3/3 step(s) completed.");
    expect(result.output).toContain("step result");
    // The outcomes planDrivenContinuation reads were persisted by the folded run.
    const stored = await loadTurnPlan(SESSION);
    expect(stored?.outcomes?.map((o) => o.status)).toEqual(["done", "done", "done"]);
    expect(result.metadata?.["planExecution"]).toBe(true);
    expect(result.metadata?.["planRoundFold"]).toBe(true);
  });

  it("names the steps still owed in the receipt's first line, ahead of every result", async () => {
    let call = 0;
    respond = () => (++call === 2
      ? { success: false, output: "", error: "specialist unavailable" }
      : { success: true, output: `FINDINGS ${"x".repeat(3_000)}` });
    const result = await record();
    const firstLine = result.output.split("\n")[0]!;
    expect(firstLine).toMatch(/still outstanding: s2 \(failed\), s3 \(not run yet\)/);
    expect(firstLine).not.toMatch(/every step has run/);
  });

  it("reports what it ran to the turn as execute_plan would: per-turn counts and the delegation tally", async () => {
    const result = await record();
    const nested = readNestedToolCalls("record_plan", result.metadata);
    // The executor call the turn never saw, then each dispatched step.
    expect(nested.map((c) => c.tool)).toEqual(["execute_plan", "delegate_to_agent", "delegate_to_agent"]);
    const delegations = nested.reduce((sum, call) => sum + nestedCallContribution(call).delegations, 0);
    expect(delegations).toBe(2);
    // Its wall clock is a wait on children, credited back to the turn like execute_plan's.
    expect(DELEGATION_WAIT_TOOL_NAMES.has("record_plan")).toBe(true);
  });

  it("leaves planDrivenContinuation nothing to continue once every step ran", async () => {
    await record();
    const decision = decidePlanContinuation({
      plan: await loadTurnPlan(SESSION),
      executedDelegations: 2,
      delegationCap: 5,
      lastDelegationSucceeded: true,
      enabled: true,
    });
    expect(decision).toMatchObject({ continue: false, done: 3, total: 3 });
  });

  it("gives the folded report the plan report's frame, not a generic tool result's 600 characters", async () => {
    respond = () => ({ success: true, output: `FINDING ${"x".repeat(1_500)} END-OF-STEP` });
    const result = await record();
    const visible = buildModelVisibleToolResult("record_plan", result.output, result.metadata);
    expect(visible).toContain("END-OF-STEP");
    expect(visible.length).toBeGreaterThan(3_000);
  });

  it("keeps the folded report whole in the collapsed history the answering call reads", async () => {
    // The prompt is built from getCollapsedHistory, which clips a generic tool result to 500
    // characters; execute_plan's report is allowed 12K on its own turn. A folded report arrives
    // under record_plan's name, so the allowance has to follow the report, not the name.
    const { AgentSession } = await import("../agent/session.js");
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "test" });
    session.addMessage({ role: "user", content: "compare the two recorders" });
    const callIds = ["call_folded", "call_plain"];
    session.addMessage({
      role: "assistant",
      content: "",
      tool_calls: callIds.map((id) => ({ id, type: "function", function: { name: "record_plan", arguments: "{}" } })),
    });
    const report = `Plan recorded and EXECUTED. ${"evidence ".repeat(150)}FOLDED-END`;
    session.addMessage({ role: "tool", tool_call_id: "call_folded", content: report, metadata: { planExecution: true } });
    // The same length WITHOUT a plan report is still a generic result: the metadata is what decides.
    session.addMessage({ role: "tool", tool_call_id: "call_plain", content: report.replace("FOLDED-END", "PLAIN-END") });
    const collapsed = session.getCollapsedHistory().map((m) => String(m.content)).join("\n");
    expect(collapsed).toContain("FOLDED-END");
    expect(collapsed).not.toContain("PLAIN-END");
  });

  it("does not fold when the response also issued another call — that call may already be the first step", async () => {
    const result = await record(PLAN, { responseToolCalls: ["record_plan", "delegate_to_agent"] });
    expect(dispatched).toEqual([]);
    expect(result.output).toMatch(/CALL execute_plan/);
    expect(result.metadata?.["planExecution"]).toBeUndefined();
  });

  it("does not fold when the caller cannot say what else the response asked for (a sub-agent)", async () => {
    const result = await record(PLAN, { responseToolCalls: undefined });
    expect(dispatched).toEqual([]);
    expect(result.output).toMatch(/CALL execute_plan/);
  });

  it("does not fold while a steering message the user typed is waiting to be read", async () => {
    // Steering is drained at the top of the next iteration. Folded, the whole plan would run
    // before the model saw "actually, compare C instead"; unfolded, the next call reads it first.
    const { turnSteeringManager } = await import("../agent/turn-steering.js");
    turnSteeringManager.armTurn(SESSION, "steer-token");
    try {
      expect(turnSteeringManager.enqueue(SESSION, "actually, compare recorder C instead").queued).toBe(true);
      const result = await record();
      expect(dispatched).toEqual([]);
      expect(result.output).toMatch(/CALL execute_plan/);
    } finally {
      turnSteeringManager.closeTurn(SESSION, "steer-token");
    }
    // The control: the same turn with nothing waiting folds.
    turnSteeringManager.armTurn(SESSION, "steer-token-2");
    try {
      await record();
      expect(dispatched.map((d) => d.name)).toEqual(["delegate_to_agent", "delegate_to_agent"]);
    } finally {
      turnSteeringManager.closeTurn(SESSION, "steer-token-2");
    }
  });

  it("restores the two-round shape when orchestration.planRoundFold is off", async () => {
    getConfig().orchestration.planRoundFold = false;
    const result = await record();
    expect(dispatched).toEqual([]);
    expect(result.output).toMatch(/CALL execute_plan/);
  });

  it("does not fold a plan with nothing to dispatch", async () => {
    const result = await record({
      objective: "think it through",
      steps: [{ id: "s1", description: "decide the framing", kind: "direct" }],
    });
    expect(dispatched).toEqual([]);
    expect(result.metadata?.["planExecution"]).toBeUndefined();
  });

  it("does not reach past the caller's grant for the executor", async () => {
    const result = await record(PLAN, { allowedTools: ["record_plan", "delegate_to_agent"] });
    expect(dispatched).toEqual([]);
    expect(result.metadata?.["planExecution"]).toBeUndefined();
  });

  it("does not fold past execute_plan's per-turn cap", async () => {
    getConfig().orchestration.perTurnCaps = { ...(getConfig().orchestration.perTurnCaps ?? {}), execute_plan: 1 };
    const result = await record(PLAN, { getTurnToolCallCount: (tool) => (tool === "execute_plan" ? 1 : 0) });
    expect(dispatched).toEqual([]);
    expect(result.metadata?.["planExecution"]).toBeUndefined();
  });

  it("waits for plan approval, and runs nothing when the operator declines", async () => {
    getConfig().orchestration.planApproval = true;
    const denied = await record({ ...PLAN, riskTier: "high" }, { approvalCallback: async () => false });
    expect(dispatched).toEqual([]);
    expect(denied.output).toMatch(/NOT executed/);
    expect(denied.metadata?.["approved"]).toBe(false);

    const approved = await record({ ...PLAN, riskTier: "high" }, { approvalCallback: async () => true });
    expect(dispatched.map((d) => d.name)).toEqual(["delegate_to_agent", "delegate_to_agent"]);
    expect(approved.metadata?.["planExecution"]).toBe(true);
  });

  it("leaves a doomed low-effort plan to the orchestrator: the budget note asks it to decide first", async () => {
    // D4: three high-risk delegate steps cannot finish inside the low-effort budget, and the note
    // tells the orchestrator to offer a re-run instead. Folding would decide for it and start the run.
    const { runWithEffortContext } = await import("../runtime/effort-context.js");
    const doomed = {
      objective: "survey three vendors",
      riskTier: "high",
      steps: ["a", "b", "c"].map((id) => ({ id, description: `vendor ${id}`, kind: "delegate", agent: "researcher" })),
    };
    const result = await runWithEffortContext("low", () => record(doomed));
    expect(dispatched).toEqual([]);
    expect(result.output).toMatch(/BUDGET NOTE/);
    expect(result.metadata?.["planExecution"]).toBeUndefined();
  });

  it("says why the plan did not run when the executor refuses it", async () => {
    const result = await record({
      objective: "loop",
      steps: [
        { id: "a", description: "a", kind: "delegate", dependsOn: ["b"] },
        { id: "b", description: "b", kind: "delegate", dependsOn: ["a"] },
      ],
    });
    expect(dispatched).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/did not start — .*cycle/);
    expect(result.metadata?.["planExecution"]).toBeUndefined();
  });
});
