import { describe, it, expect } from "vitest";
import { isMcpOperator, mcpSubAgentFailed } from "../mcp/server.js";
import type { SubAgentRunResult } from "../agent/sub-agent.js";

/**
 * Round 8 (July 2026 review): the MCP path ignored the caller's role (viewers could
 * invoke mutating tools / sub-agents / scenes — MCPS-2) and reported failed / timed-out
 * sub-agent+scene runs to the client as isError:false (MCPS-3).
 */
describe("isMcpOperator — MCP RBAC gate (MCPS-2)", () => {
  it("treats operators (and trusted local defaults) as operators", () => {
    expect(isMcpOperator({ caller: "root", role: "operator" })).toBe(true);
    expect(isMcpOperator({ caller: "stdio", role: "operator" })).toBe(true);
  });
  it("denies viewers", () => {
    expect(isMcpOperator({ caller: "readonly", role: "viewer" })).toBe(false);
  });
});

describe("mcpSubAgentFailed — surface non-clean runs as errors (MCPS-3)", () => {
  const run = (outcome: string, terminalState?: string): SubAgentRunResult =>
    ({ stats: { outcome, terminalState } } as unknown as SubAgentRunResult);

  it("is false only for a clean success", () => {
    expect(mcpSubAgentFailed(run("success", "completed"))).toBe(false);
    expect(mcpSubAgentFailed(run("success"))).toBe(false);
  });
  it("is true for failure or a non-completed terminal state", () => {
    expect(mcpSubAgentFailed(run("failure", "error"))).toBe(true);
    expect(mcpSubAgentFailed(run("success", "timeout"))).toBe(true);
    expect(mcpSubAgentFailed(run("success", "max_iterations"))).toBe(true);
  });
});
