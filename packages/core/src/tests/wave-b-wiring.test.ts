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
    expect(count(runtime, "[MID_TURN_USER_MESSAGE_METADATA]: true")).toBe(2);   // steering + oversight redirect
    expect(count(runtime, "runArtifactVerificationGate({")).toBeGreaterThanOrEqual(1);   // the relay path
    expect(count(runtime, "inputCallback: opts.inputCallback ?? (opts.autoApprove ? unattendedInputCallback : undefined)")).toBe(1);
    expect(count(runtime, "allowedAgents: opts.allowedAgents,")).toBeGreaterThanOrEqual(2);  // tool context + prompt assembly
    expect(count(runtime, "startsTurn(")).toBeGreaterThanOrEqual(2);      // this turn's artifacts, the prior-turn window
  });

  it("gateway: sub-agent lifecycle is forwarded as status", () => {
    expect(count(read("gateway/rpc.ts"), "subAgentProgressStatus(event)")).toBe(1);
  });

  // Status UX wave (2026-10-15): a specialist's heartbeat reaches its row, a settled approval closes
  // the page's banner, and a delegation the runtime makes itself gets a step like any other.
  it("gateway: sub-agent heartbeats and settled approvals reach the page", () => {
    const rpc = read("gateway/rpc.ts");
    expect(count(rpc, "subAgentHeartbeat(event)")).toBe(1);
    expect(count(rpc, 'type: "agent.heartbeat"')).toBe(1);
    expect(count(rpc, 'type: "agent.approval_resolved"')).toBe(2);   // answered, timed out
  });

  it("runtime: delegations the runtime makes itself are announced as steps", () => {
    for (const file of ["agent/runtime.ts", "agent/turn-corrective.ts", "agent/turn-finalize-guards.ts"]) {
      expect(count(read(file), 'executeTool("delegate_to_agent"'), file).toBe(0);
    }
    expect(count(read("agent/turn-corrective.ts"), "executeVisibleTool(ctx.toolSteps,")).toBe(2);   // build, reroute
    expect(count(read("agent/turn-finalize-guards.ts"), "executeVisibleTool(ctx.toolSteps,")).toBe(1);   // escalation
    expect(count(read("agent/runtime.ts"), "executeVisibleTool(opts,")).toBe(1);   // auto-research
    expect(count(read("agent/runtime.ts"), "toolSteps: opts,")).toBe(2);   // corrective + terminal-guard contexts
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
