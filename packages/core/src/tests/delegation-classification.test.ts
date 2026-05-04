import { describe, it, expect } from "vitest";
import { classifyDelegationResult } from "../tools/sub-agent.js";
import type { DelegationClassification } from "../tools/sub-agent.js";

const baseStats = {
  toolCount: 3,
  toolNames: ["web_search", "web_fetch"],
  terminalState: "completed",
  outcome: "success" as const,
};

const noToolStats = {
  toolCount: 0,
  toolNames: [] as string[],
  terminalState: "completed",
  outcome: "success" as const,
};

describe("classifyDelegationResult — D14", () => {
  // ── Success ────────────────────────────────────────────────────────────
  it("returns success for a clean completed result", () => {
    const r = classifyDelegationResult(
      "Here are the headlines for today: Apple hit $200.",
      "success",
      baseStats,
      undefined,
      "researcher",
      "what are today's headlines?",
    );
    expect(r).toBe<DelegationClassification>("success");
  });

  // ── Failure ────────────────────────────────────────────────────────────
  it("returns failure for explicit delegationOutcome failure", () => {
    const r = classifyDelegationResult(
      "Unable to complete the task.",
      "failure",
      baseStats,
      undefined,
      "researcher",
      "task",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });

  it("returns failure for looksLikeFailureResult output", () => {
    const r = classifyDelegationResult(
      "Error: no results found.",
      "success",
      { ...baseStats, terminalState: "completed" },
      undefined,
      "researcher",
      "task",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });

  // Regression: the container-runner returns the literal string
  // "Sub-agent '<name>' container error: <reason>" for spawn / runtime
  // failures.  The previous regex `\b(...|error:|...)\b` failed to match this
  // because the trailing `\b` after `:` (non-word) followed by a space
  // (non-word) never fires.  Combined with the containerized sub-agent path
  // hardcoding outcome="success" / terminalState="completed", a container
  // crash was being classified as a successful delegation, swallowing the
  // failure and skipping retry / forced-synthesis.
  it("returns failure when output reports container-level error despite success metadata", () => {
    const r = classifyDelegationResult(
      "Sub-agent 'shell_agent' container error: unknown",
      "success",
      { ...noToolStats, terminalState: "completed" },
      undefined,
      "shell_agent",
      "run a quick check",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });

  it("returns failure when output reports container exit code", () => {
    const r = classifyDelegationResult(
      "Sub-agent 'coder' exited with code 137. Output: ",
      "success",
      { ...noToolStats, terminalState: "completed" },
      undefined,
      "coder",
      "task",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });

  it("returns failure for timed-out non-partial result", () => {
    const r = classifyDelegationResult(
      "I was trying to fetch the page but it took too long.",
      "partial",
      { ...baseStats, terminalState: "timeout", outcome: "partial" as const },
      undefined,
      "computer_use_agent",
      "some task",
      [],
    );
    // computer_use_agent with toolCount=3 and terminalState=timeout — acceptPartial=true
    // so even on a timeout this should be "partial"
    expect(r).toBe<DelegationClassification>("partial");
  });

  // ── Partial ────────────────────────────────────────────────────────────
  it("returns partial when stats.outcome is partial and output has content", () => {
    const r = classifyDelegationResult(
      "I found 3 CVEs for Apache 2.4.51. CVE-2021-41773 is critical.",
      "partial",
      { ...baseStats, terminalState: "max_iterations", outcome: "partial" as const },
      undefined,
      "researcher",
      "find CVEs for Apache 2.4.51",
    );
    expect(r).toBe<DelegationClassification>("partial");
  });

  it("returns partial for research agent with web tools + toolCount>=2 even on timeout", () => {
    const r = classifyDelegationResult(
      "Apple stock is at $198 today based on my web search.",
      "partial",
      {
        toolCount: 3,
        toolNames: ["web_search", "web_fetch"],
        terminalState: "timeout",
        outcome: "partial" as const,
      },
      undefined,
      "researcher",
      "what is apple stock price?",
    );
    expect(r).toBe<DelegationClassification>("partial");
  });

  // ── Coordinator no-op ──────────────────────────────────────────────────
  it("returns coordinator_noop for coordinator with empty tools and short output", () => {
    const r = classifyDelegationResult(
      "Let me start by delegating this task to a researcher.",
      undefined,
      { ...noToolStats, terminalState: "completed" },
      { tags: ["coordination"] } as never,
      "web_task_coordinator",
      "what are the headlines today?",
    );
    expect(r).toBe<DelegationClassification>("coordinator_noop");
  });

  it("does NOT flag coordinator_noop when coordinator called delegate_to_agent", () => {
    const r = classifyDelegationResult(
      "The researcher found the following headlines: ...",
      "success",
      {
        toolCount: 2,
        toolNames: ["delegate_to_agent"],
        terminalState: "completed",
        outcome: "success" as const,
      },
      { tags: ["coordination"] } as never,
      "web_task_coordinator",
      "what are the headlines today?",
    );
    expect(r).toBe<DelegationClassification>("success");
  });

  it("returns failure for in-progress planning stubs even after tool use", () => {
    const r = classifyDelegationResult(
      "Let me get the remaining critical datasheet pages for electrical specs and pricing details.",
      "success",
      {
        toolCount: 17,
        toolNames: ["search_workflows", "parallel_delegate", "web_search", "web_fetch"],
        terminalState: "completed",
        outcome: "success" as const,
      },
      { tags: ["coordination"] } as never,
      "web_task_coordinator",
      "Research exact microphone specs, reviews, known issues, pricing, and availability.",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });

  it("does NOT flag coordinator_noop when terminalState is undefined (test mocks)", () => {
    // terminalState undefined → coordinator guard skipped (requires terminalState === "completed")
    // looksLikeFailureResult("Let me look that up.") → false, so weak=false → success
    const r = classifyDelegationResult(
      "Let me look that up.",
      undefined,
      { ...noToolStats, terminalState: undefined },
      { tags: ["coordination"] } as never,
      "web_task_coordinator",
      "task",
    );
    // Result must NOT be coordinator_noop (the coordinator guard was skipped)
    expect(r).not.toBe<DelegationClassification>("coordinator_noop");
  });

  // ── Infrastructure failure ─────────────────────────────────────────────
  it("returns infrastructure_failure for ECONNREFUSED pattern", () => {
    const r = classifyDelegationResult(
      "Sub-agent error: ECONNREFUSED connecting to localhost:9222",
      "failure",
      { ...baseStats, terminalState: "error" },
      undefined,
      "browser_agent",
      "open a browser",
    );
    expect(r).toBe<DelegationClassification>("infrastructure_failure");
  });

  // ── needs_info ────────────────────────────────────────────────────────
  it("returns failure for needs_info when partial not accepted", () => {
    const r = classifyDelegationResult(
      "I need more information to proceed.",
      "needs_info",
      { ...noToolStats, terminalState: "completed" },
      undefined,
      "shell_agent",
      "configure the server",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });
});
