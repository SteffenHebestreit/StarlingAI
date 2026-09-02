import { describe, expect, it } from "vitest";
import { buildModelVisibleToolResult } from "../agent/tool-result-format.js";

// A finished deliverable whose prose mentions a failed attempt along the way.
const REPORT = "The first attempt failed to reach the vendor site, so I used the cached datasheet. "
  + "Findings: the sensor draws 12 mA at 3.3 V; the interface is I2C; the datasheet revision is 1.4.";

describe("delegation outcome — the runtime's verdict beats the prose sniff", () => {
  it("frames a reported success as completed even when the text mentions a failed attempt", () => {
    const framed = buildModelVisibleToolResult("delegate_to_agent", REPORT, {
      agentName: "researcher",
      delegationOutcome: "success",
      delegationSucceeded: true,
    });
    expect(framed).toMatch(/TASK COMPLETED/);
    expect(framed).not.toMatch(/TASK FAILED/);
  });

  it("does not let a reported success cover a structural failure the runtime cannot see", () => {
    // The verdict was minted by the same run that produced the placeholder / the container error.
    for (const text of ["Sub-agent produced no final response.", "Sub-agent 'coder' container error: unknown"]) {
      const framed = buildModelVisibleToolResult("delegate_to_agent", text, {
        agentName: "coder",
        delegationOutcome: "success",
        delegationSucceeded: true,
      });
      expect(framed).toMatch(/TASK FAILED/);
    }
  });

  it("still lets the sniff decide when the result carries no verdict", () => {
    const framed = buildModelVisibleToolResult("delegate_to_agent", REPORT, { agentName: "researcher" });
    expect(framed).toMatch(/TASK FAILED/);
  });
});
