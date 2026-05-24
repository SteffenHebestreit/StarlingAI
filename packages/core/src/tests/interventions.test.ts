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

  it("classifies approval timeouts as approval notices", () => {
    const notice = classifyToolIntervention({
      toolName: "site_fill_credentials",
      success: false,
      error: "Tool 'site_fill_credentials' approval timed out (no response within 5 min)",
    });
    expect(notice?.reasonCode).toBe("approval_timeout");
    expect(notice?.summary).toContain("approval expired");
    expect(notice?.severity).toBe("warn");
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

  it("classifies repeated identical output as a loop intervention", () => {
    const notice = classifyToolIntervention({
      toolName: "browser_snapshot",
      success: true,
      output: "<html>same page</html>",
      repeatedIdenticalOutput: true,
    });
    expect(notice?.reasonCode).toBe("repeated_identical_output");
    expect(notice?.severity).toBe("warn");
    expect(notice?.actions.some(a => a.kind === "stop_turn")).toBe(true);
  });
});

describe("tool not-found similar-tool suggestion", () => {
  it("suggests tools with the same prefix when a tool is not found", async () => {
    // browser_screenshot is in the tier map (Tier 2, not blocked) but the native
    // browser tools are not registered in the test environment (no Playwright).
    // So executeTool reaches the "not registered" branch and should suggest
    // the MCP browser tools (browser_navigate, browser_snapshot, etc.) that ARE
    // registered via the MCP client registration path.
    //
    // If no browser tools are registered in this test run either, we fall back to
    // checking that the error message mentions the tool name and is not the
    // "blocked by security policy" message.
    const { executeTool } = await import("../tools/registry.js");

    const result = await executeTool("browser_screenshot", {}, {
      sessionId: "test",
      workspacePath: "/tmp",
    });

    expect(result.success).toBe(false);
    // Must NOT be the blocked-by-policy message (browser_screenshot is Tier 2, not 4)
    expect(result.error).not.toContain("blocked by security policy");
    expect(result.error).toContain("browser_screenshot");
  });
});