import { afterEach, describe, expect, it, vi } from "vitest";
import type { CorrectiveContext } from "../agent/turn-corrective.js";
import type { ToolContext } from "../tools/registry.js";

// A scene or job step's turn may delegate only to the step's allowedAgents. The final-QA corrective
// build picked content_writer from the request's wording and delegated to it all the same, and the
// scene refused it: "Agent 'content_writer' is not permitted in this scene" (E2E 2026-10-09,
// source_grounded_paper_packet).

const delegations: Array<Record<string, unknown>> = [];
const auditRows: Array<Record<string, unknown>> = [];
/** The tool context each delegate_to_agent call ran with. */
const delegationContexts: ToolContext[] = [];

vi.mock("../tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/registry.js")>();
  return {
    ...actual,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>, context: ToolContext) => {
      if (name === "delegate_to_agent") {
        delegations.push(args);
        delegationContexts.push(context);
      }
      return { success: true, output: "The brief, as text.", metadata: {} };
    }),
  };
});

vi.mock("../audit/logger.js", () => ({
  logAudit: vi.fn((_event: string, details: Record<string, unknown>) => { auditRows.push(details); }),
}));

const { runCorrectiveBuild, runCorrectiveReroute } = await import("../agent/turn-corrective.js");
const { classifyDeliverableIntent } = await import("../agent/deliverable-intent.js");

const REQUEST = "Write a sourced report on the company as a document.";

function correctiveContext(allowedAgents: string[] | undefined) {
  let latch = false;
  let rerouteLatch = false;
  const ctx: CorrectiveContext = {
    signal: new AbortController().signal,
    session: { id: "corrective-scope", channel: "scene", addMessage: () => undefined } as unknown as CorrectiveContext["session"],
    userMessage: REQUEST,
    deliverableIntent: classifyDeliverableIntent(REQUEST),
    toolContext: { sessionId: "corrective-scope", workspacePath: "/workspace", ...(allowedAgents ? { allowedAgents } : {}) } as ToolContext,
    getIterationCount: () => 3,
    getProvider: () => { throw new Error("no synthesis expected"); },
    getStashedBuilderTaskSpec: () => null,
    getQaCorrectiveBuildUsed: () => latch,
    setQaCorrectiveBuildUsed: (value) => { latch = value; },
    getCorrectiveRerouteUsed: () => rerouteLatch,
    setCorrectiveRerouteUsed: (value) => { rerouteLatch = value; },
    incrementDelegationCount: () => undefined,
    forceSynthesis: async () => null,
    selectCorrectiveResumeTarget: () => null,
    collectTurnArtifactAttachments: () => [],
    extractArtifactsFromMetadata: () => undefined,
    logWarn: () => undefined,
  };
  return { ctx, latch: () => latch };
}

afterEach(() => {
  delegations.length = 0;
  delegationContexts.length = 0;
  auditRows.length = 0;
});

describe("the final-QA corrective build in a turn scoped to allowedAgents", () => {
  it("is not delegated to a builder outside the scope, and leaves the latch unset", async () => {
    const { ctx, latch } = correctiveContext(["researcher", "evidence_analyst", "paper_author", "summarizer"]);
    expect(ctx.deliverableIntent.builder).toBe("content_writer");

    expect(await runCorrectiveBuild("Founded 1987, 146 employees.", ctx)).toBeNull();

    expect(delegations).toEqual([]);
    expect(latch()).toBe(false);
    expect(auditRows).toContainEqual(expect.objectContaining({ type: "final_qa_corrective_build_out_of_scope", builderAgent: "content_writer" }));
    expect(auditRows).not.toContainEqual(expect.objectContaining({ type: "final_qa_corrective_build_delegated" }));
  });

  it("control: a scope that allows the builder, and a turn with no scope, delegate to it as before", async () => {
    for (const allowedAgents of [["researcher", "content_writer"], undefined]) {
      delegations.length = 0;
      const { ctx, latch } = correctiveContext(allowedAgents);

      await runCorrectiveBuild("Founded 1987, 146 employees.", ctx);

      expect(delegations.map((args) => args["agentName"])).toEqual(["content_writer"]);
      expect(latch()).toBe(true);
    }
  });
});

// The loop-brake reroute (agent/runtime.ts) and the zero-work fabrication guard
// (turn-finalize-guards.ts) both re-dispatch the request through runCorrectiveReroute. They share
// one latch: the request goes out a second time in no turn.
describe("the corrective reroute", () => {
  it("re-dispatches the request once a turn, whichever guard asks", async () => {
    const { ctx } = correctiveContext(undefined);

    expect(await runCorrectiveReroute(ctx, "loop_brake", { brake: "tool_streak_across_iterations" })).toBe("The brief, as text.");
    expect(await runCorrectiveReroute(ctx)).toBeNull();

    expect(delegations).toEqual([{ task: REQUEST }]);
    expect(auditRows).toContainEqual(expect.objectContaining({ type: "loop_brake_reroute_delegated", brake: "tool_streak_across_iterations" }));
    expect(auditRows).not.toContainEqual(expect.objectContaining({ type: "fabricated_zero_work_reroute_delegated" }));
  });

  // allowDelegationAfterOperatorStop clears the operator's Stop latch (tools/sub-agent.ts), and the
  // loop-brake reroute's semantic routing can pick a coordinator that delegates on.
  it("lifts an operator Stop for the zero-work guard only, as before, and not at a loop brake", async () => {
    await runCorrectiveReroute(correctiveContext(undefined).ctx, "loop_brake", { brake: "all_tool_calls_blocked" });
    await runCorrectiveReroute(correctiveContext(undefined).ctx);

    expect(delegationContexts.map((context) => context.allowDelegationAfterOperatorStop === true)).toEqual([false, true]);
  });
});
