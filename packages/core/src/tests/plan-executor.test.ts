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

  it("runs a `direct` step's own tool, chaining tools with agents in one plan", async () => {
    // The third leg. `agent` makes a delegate step dispatchable and `workflow` makes a reuse step
    // dispatchable; without this a plan could not run a plain tool call in its own order, and the
    // orchestrator had to hand-carry them between the delegations.
    await persistTurnPlan(SESSION, basePlan([
      { id: "s1", description: "look it up", kind: "direct", tool: "web_search", toolArgs: { query: "rfc 9110" } },
      { id: "s2", description: "write it up", kind: "delegate", agent: "content_writer", dependsOn: ["s1"] },
    ]));

    const result = await run();
    expect(result.success).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(["web_search", "delegate_to_agent"]);
    expect(calls[0]?.args).toEqual({ query: "rfc 9110" });   // literal args, not a prose task
  });

  it("refuses a plan that lists itself as one of its own steps", async () => {
    // The round limit is per-call, so it does not survive nesting: this would re-enter with the
    // same plan and the same pending step until the stack or the turn gave out.
    await persistTurnPlan(SESSION, basePlan([
      { id: "s1", description: "run the plan", kind: "direct", tool: "execute_plan" },
    ]));

    const result = await run();
    expect(calls).toHaveLength(0);
    expect(result.output).toMatch(/cannot run itself/);
  });

  it("will not reach outside the caller's granted tools", async () => {
    // ToolContext.allowedTools is a stated contract on tools that fan out to other tools. This one
    // dispatches a tool name the MODEL wrote into a plan, so the check is what stops a step from
    // naming anything the tier gate happens to permit.
    await persistTurnPlan(SESSION, basePlan([
      { id: "s1", description: "read the config", kind: "direct", tool: "read_file", toolArgs: { path: "x" } },
    ]));

    const result = await getTool("execute_plan")!.execute(
      {},
      { sessionId: SESSION, workspacePath: "/w", allowedTools: ["web_search"] } as never,
    );
    expect(calls).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/not in this agent's allowed tool set/);
  });

  it("keeps fan-out out of a `direct` step, where the plan would not account for it", async () => {
    await persistTurnPlan(SESSION, basePlan([
      { id: "s1", description: "spread the work", kind: "direct", tool: "parallel_delegate", toolArgs: {} },
    ]));

    const result = await run();
    expect(calls).toHaveLength(0);
    expect(result.output).toMatch(/make it a delegate or reuse step/);
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

  it("hands each step's result back — the report is what the final answer gets written from", async () => {
    // The tool told the orchestrator "synthesize the final answer from their results" and returned
    // the roll-call without them. A `direct` or `reuse` step's output reaches the model through no
    // other channel at all, so the instruction was to write up work it could not see.
    respond = (name) => ({ success: true, output: name === "web_search" ? "PRICE LIST: widget A = 12.50 EUR" : "done" });
    await persistTurnPlan(SESSION, basePlan([
      { id: "s1", description: "look up the prices", kind: "direct", tool: "web_search", toolArgs: { query: "prices" } },
    ]));

    const result = await run();
    expect(result.output).toContain("PRICE LIST: widget A = 12.50 EUR");
    expect(result.output).toMatch(/RESULTS/);
  });

  it("keeps a step's result across calls, so a resumed plan has not lost it", async () => {
    respond = () => ({ success: true, output: "THE FINDING: rfc-9110 section 9" });
    await persistTurnPlan(SESSION, basePlan([
      { id: "s1", description: "research", kind: "delegate" },
      { id: "s2", description: "decide the framing", kind: "direct" },
    ]));
    await run();

    const stored = await loadTurnPlan(SESSION);
    expect(stored?.outcomes?.find((o) => o.id === "s1")?.result).toContain("THE FINDING");
    // ...and a second call still reports it rather than announcing a step whose output is gone.
    const second = await run();
    expect(second.output).toContain("THE FINDING: rfc-9110 section 9");
  });

  it("discharges a manual step through `completed`, and then runs what was waiting on it", async () => {
    // Without this the advertised resume is a no-op forever: `manual` is not `pending` so it is
    // never re-offered, and it never settles, so its dependents are blocked for good.
    await persistTurnPlan(SESSION, basePlan([
      { id: "s1", description: "decide the framing", kind: "direct" },
      { id: "s2", description: "write it up", kind: "delegate", dependsOn: ["s1"] },
    ]));
    const first = await run();
    expect(calls).toHaveLength(0);
    expect(first.output).toMatch(/YOURS TO DO/);

    const second = await getTool("execute_plan")!.execute({ completed: ["s1"] }, ctx());
    expect(calls.map((c) => c.name)).toEqual(["delegate_to_agent"]);
    expect(second.output).toMatch(/Marked done: s1/);
    expect(second.output).toMatch(/Synthesize the final answer/);
  });

  it("retries a failed step when asked, instead of stranding it", async () => {
    let attempt = 0;
    respond = () => (++attempt === 1
      ? { success: false, output: "", error: "specialist unavailable" }
      : { success: true, output: "second time lucky" });
    await persistTurnPlan(SESSION, basePlan([{ id: "s1", description: "research", kind: "delegate" }]));

    const first = await run();
    expect(first.success).toBe(false);
    const second = await getTool("execute_plan")!.execute({ retry: ["s1"] }, ctx());
    expect(second.success).toBe(true);
    expect(second.output).toContain("second time lucky");
  });

  it("calls a plan malformed rather than finished when a dependency names an id it never defines", async () => {
    // normalizeTurnPlan mints ids s1..sN but copies dependsOn verbatim, so a model that writes
    // dependsOn:["research vendor A"] produces exactly this. Nothing read dependsOn before, so the
    // mismatch was harmless; the executor made it load-bearing, and reported 0 steps run as success.
    await persistTurnPlan(SESSION, basePlan([
      { id: "s1", description: "write it up", kind: "delegate", dependsOn: ["research vendor A"] },
    ]));

    const result = await run();
    expect(calls).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/MALFORMED/);
    expect(result.output).not.toMatch(/Synthesize the final answer/);
  });

  it("propagates a step's artifacts, so what a plan built is still downloadable", async () => {
    // collectTurnArtifactAttachments walks the metadata of the turn's TOOL MESSAGES, and a step's
    // result is not one — it is a nested call inside this tool. Dropped, the user is told the deck
    // was built and gets no link, and the auto-build can re-fire for work already done.
    respond = () => ({ success: true, output: "built", metadata: { artifacts: [{ path: "deck.html" }] } });
    await persistTurnPlan(SESSION, basePlan([{ id: "s1", description: "build the deck", kind: "delegate" }]));

    const result = await run();
    expect(result.metadata?.["artifacts"]).toEqual([{ path: "deck.html" }]);
  });

  it("stops at the per-turn delegate cap instead of fanning out past it", async () => {
    // The executor delegates from inside ONE tool call, so the turn loop's cap never sees those
    // dispatches. Unbounded, a 12-step plan fans out 12 times in a turn that allows 5.
    await persistTurnPlan(SESSION, basePlan(
      Array.from({ length: 7 }, (_, i) => ({ id: `s${i + 1}`, description: `job ${i}`, kind: "delegate" as const, parallelGroup: 1 })),
    ));

    const result = await run();
    expect(calls).toHaveLength(5);
    expect(result.output).toMatch(/DELEGATE BUDGET REACHED/);
    expect(result.output).toMatch(/Do NOT write the final answer/);
  });

  it("reports only real delegations, so a plain tool step is not counted as orchestration", async () => {
    // The turn adds this to its delegation total, and that signal gates the honesty chain: a step
    // that merely called a tool is not orchestration and must not read as it.
    await persistTurnPlan(SESSION, basePlan([
      { id: "s1", description: "look it up", kind: "direct", tool: "web_search", toolArgs: {} },
      { id: "s2", description: "write it up", kind: "delegate" },
    ]));

    const result = await run();
    expect(result.metadata?.["executed"]).toEqual(["s1", "s2"]);
    expect(result.metadata?.["delegated"]).toBe(1);
  });

  it("fails a reuse step whose workflow does not exist, instead of recording it done", async () => {
    // run_workflow deliberately reports a routing miss as SUCCESS (audit bd3d60dc), flagged
    // workflowNotFound. Taken at face value the step was counted in "N/N completed" and its
    // "no saved workflow matches…" prose was carried into the dependent step as the research.
    respond = (name) => (name === "run_workflow"
      ? { success: true, output: 'No saved workflow matches "research pack" — this is NOT an error.', metadata: { workflowNotFound: true } }
      : { success: true, output: "ok" });
    await persistTurnPlan(SESSION, basePlan([
      { id: "s1", description: "gather", kind: "reuse", workflow: "research pack" },
      { id: "s2", description: "write", kind: "delegate", dependsOn: ["s1"] },
    ]));

    const result = await run();
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/no workflow named "research pack" exists/);
    expect(calls.map((c) => c.name)).toEqual(["run_workflow"]);   // s2 never got the miss as input
  });

  it("reports a step stranded two hops back, instead of leaving it out of every section", async () => {
    await persistTurnPlan(SESSION, basePlan([
      { id: "s1", description: "decide the framing", kind: "direct" },
      { id: "s2", description: "write it up", kind: "delegate", dependsOn: ["s1"] },
      { id: "s3", description: "review it", kind: "delegate", dependsOn: ["s2"] },
    ]));

    const result = await run();
    expect(result.output).toMatch(/YOURS TO DO[\s\S]*s1/);
    expect(result.output).toMatch(/WAITING[\s\S]*s2/);
    expect(result.output).toMatch(/NOT RUN[\s\S]*s3/);   // s3 appeared nowhere at all
  });

  it("says so when the plan normalized down to no steps", async () => {
    await persistTurnPlan(SESSION, basePlan([]));
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no steps/);
    expect(result.output).not.toMatch(/Synthesize the final answer/);
  });

  it("stops dispatching when the turn is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await persistTurnPlan(SESSION, basePlan([{ id: "s1", description: "research", kind: "delegate" }]));

    await getTool("execute_plan")!.execute({}, { sessionId: SESSION, workspacePath: "/w", signal: controller.signal } as never);
    expect(calls).toHaveLength(0);
  });

  it("marks a carried result as truncated, so a fragment is not read as the whole finding", async () => {
    const long = "F".repeat(3_000);
    respond = (name) => ({ success: true, output: name === "web_search" ? long : "ok" });
    await persistTurnPlan(SESSION, basePlan([
      { id: "s1", description: "research", kind: "direct", tool: "web_search", toolArgs: {} },
      { id: "s2", description: "write", kind: "delegate", dependsOn: ["s1"] },
    ]));

    await run();
    const task = String(calls[1]?.args["task"] ?? "");
    expect(task).toMatch(/truncated/);
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
