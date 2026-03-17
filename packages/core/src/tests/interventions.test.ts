import { describe, expect, it } from "vitest";
import { classifyToolIntervention } from "../agent/interventions.js";

describe("tool intervention classification", () => {
  it("classifies timeouts as process-like intervention notices", () => {
    const notice = classifyToolIntervention({
      toolName: "web_fetch",
      success: false,
      error: "Fetch failed: request timed out after 15000ms",
    });
    expect(notice?.reasonCode).toBe("tool_timeout");
    expect(notice?.actions.some(action => action.kind === "request_approval")).toBe(true);
  });

  it("classifies empty successful results as suspicious returns", () => {
    const notice = classifyToolIntervention({
      toolName: "web_search",
      success: true,
      output: "   ",
    });
    expect(notice?.reasonCode).toBe("empty_output");
    expect(notice?.summary).toContain("no usable output");
  });

  it("does not flag normal successful output", () => {
    const notice = classifyToolIntervention({
      toolName: "web_search",
      success: true,
      output: "Search results here",
    });
    expect(notice).toBeNull();
  });
});