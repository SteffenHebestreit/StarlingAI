import { describe, expect, it } from "vitest";
import { buildModelVisibleToolResult, isExplicitDelegationSuccess } from "../agent/tool-result-format.js";
import { classifyPostOrchestrationDisposition } from "../agent/runtime.js";

// A specialist that ended its loop normally while asking for data it never got.
const NEEDS_DATA = "Task cannot be completed: the workspace holds no Q3 revenue source data. "
  + "Please provide the structured JSON data to proceed, or point me at the file.";
// A finished deliverable whose prose mentions a failed attempt along the way.
const REPORT = "The first attempt failed to reach the vendor site, so I used the cached datasheet. "
  + "Findings: the sensor draws 12 mA at 3.3 V; the interface is I2C; the datasheet revision is 1.4.";

/** What tools/sub-agent.ts mints on every normally-ending delegation — a default, not a verdict. */
const HEURISTIC = {
  agentName: "researcher",
  delegationSucceeded: true,
  delegationOutcome: "success",
  delegationVerdict: "heuristic",
  terminalState: "completed",
};
/** The sub-agent closed with `<final_answer status="success">`. */
const EXPLICIT = { ...HEURISTIC, delegationVerdict: "explicit" };

const disposition = (content: string, metadata: Record<string, unknown>) =>
  classifyPostOrchestrationDisposition([{ role: "tool", tool_call_id: "call_1", content, metadata }] as never);

describe("delegation verdicts — only an explicit one beats the prose sniff", () => {
  it("a heuristic 'success' does not silence the needs-data / blocker signatures", () => {
    // The default verdict is a five-phrase regex over the first 300 characters; it says nothing
    // about whether the task was done. Trusting it reframed this as TASK COMPLETED.
    const framed = buildModelVisibleToolResult("delegate_to_agent", NEEDS_DATA, HEURISTIC);
    expect(framed).toMatch(/TASK FAILED/);
    expect(disposition(framed, HEURISTIC)).toBe("failure");
  });

  it("an explicit success verdict is trusted over a mention of a failed attempt", () => {
    const framed = buildModelVisibleToolResult("delegate_to_agent", REPORT, EXPLICIT);
    expect(framed).toMatch(/TASK COMPLETED/);
    expect(framed).not.toMatch(/TASK FAILED/);
    expect(disposition(framed, EXPLICIT)).not.toBe("failure");
  });

  it("the frame and the post-orchestration classifier apply the same rule", () => {
    for (const metadata of [HEURISTIC, EXPLICIT, { agentName: "researcher", delegationSucceeded: true }]) {
      const framed = buildModelVisibleToolResult("delegate_to_agent", REPORT, metadata);
      expect(disposition(framed, metadata) === "failure").toBe(/TASK FAILED/.test(framed));
    }
  });

  it("does not let an explicit success cover a structural failure the runtime cannot see", () => {
    // The verdict was minted by the same run that produced the placeholder / the container error.
    for (const text of ["Sub-agent produced no final response.", "Sub-agent 'coder' container error: unknown"]) {
      expect(buildModelVisibleToolResult("delegate_to_agent", text, { ...EXPLICIT, agentName: "coder" })).toMatch(/TASK FAILED/);
    }
  });

  it("reads the verdict's source, not the defaulted outcome", () => {
    expect(isExplicitDelegationSuccess(HEURISTIC)).toBe(false);
    expect(isExplicitDelegationSuccess(EXPLICIT)).toBe(true);
    expect(isExplicitDelegationSuccess({ ...EXPLICIT, delegationOutcome: "partial" })).toBe(false);
    expect(isExplicitDelegationSuccess(undefined)).toBe(false);
  });
});
