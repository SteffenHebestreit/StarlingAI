import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The audit fixes of waves B and C each have a unit test for their helper; these pin the WIRING —
 * the one call site in the runtime that makes the helper matter. A refactor that drops the call
 * keeps every helper test green and silently undoes the fix; this fails instead.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("wave B/C wiring is in place", () => {
  it("runtime: ownership note once per turn, plan tools on forced iterations, mid-turn markers, relay gate, unattended input, agent grant", () => {
    const runtime = read("agent/runtime.ts");
    expect(count(runtime, 'session.hasTransientNoteThisTurn("[USER INTERACTION OWNERSHIP]")')).toBe(1);
    expect(count(runtime, "filterForcedOrchestrationTools(activeTools, forcedPlanState)")).toBe(1);
    expect(count(runtime, "metadata: { midTurn: true }")).toBe(2);        // steering + oversight redirect
    expect(count(runtime, "runArtifactVerificationGate({")).toBeGreaterThanOrEqual(1);   // the relay path
    expect(count(runtime, "inputCallback: opts.inputCallback ?? (opts.autoApprove ? unattendedInputCallback : undefined)")).toBe(1);
    expect(count(runtime, "allowedAgents: opts.allowedAgents,")).toBeGreaterThanOrEqual(2);  // tool context + prompt assembly
    expect(count(runtime, "startsTurn(")).toBeGreaterThanOrEqual(2);      // this turn's artifacts, the prior-turn window
  });

  it("gateway: sub-agent lifecycle is forwarded as status", () => {
    expect(count(read("gateway/rpc.ts"), "subAgentProgressStatus(event)")).toBe(1);
  });

  it("nested workflow turns forward the user's input channel", () => {
    expect(count(read("tools/workflow-catalog.ts"), "inputCallback: ctx.inputCallback,")).toBe(2);
  });

  it("the semantic index covers promoted agents at every build site, including promotion itself", () => {
    expect(count(read("providers/index.ts"), "withPromotedAgents(")).toBe(1);
    expect(count(read("index.ts"), "withPromotedAgents(")).toBe(1);
    expect(count(read("tools/ephemeral-agent-factory.ts"), "buildAgentIndex(withPromotedAgents(")).toBe(1);
  });

  it("guards skip the one-shot criteria verification when the QA loop will run it", () => {
    expect(count(read("agent/turn-finalize-guards.ts"), "&& !qaLoopWillVerify")).toBe(1);
  });

  it("nested specialists report to the parent's progress sink", () => {
    expect(count(read("agent/sub-agent.ts"), "onSubAgentProgress: opts.onProgress,")).toBe(1);
  });

  it("the evidence backstops and the collapsed history share one turn boundary", () => {
    expect(count(read("agent/interrupted-delegation-evidence.ts"), "currentTurnStartIndex(")).toBe(1);
    expect(count(read("agent/session.ts"), "startsTurn(")).toBeGreaterThanOrEqual(2);
  });
});
