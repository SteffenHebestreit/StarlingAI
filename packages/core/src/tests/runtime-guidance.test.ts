import { describe, expect, it } from "vitest";
import { buildDelegationLoopResponse, buildDynamicTurnGuidance, buildModelVisibleToolResult, buildTemporalContextPrompt, getPerTurnToolCallLimit } from "../agent/runtime.js";

describe("runtime turn guidance", () => {
  it("adds web-search guidance for freshness-sensitive requests", () => {
    const guidance = buildDynamicTurnGuidance("What are the latest 2026 MCP updates? Cite official sources.");

    expect(guidance).not.toBeNull();
    expect(guidance?.freshnessSensitive).toBe(true);
    expect(guidance?.sourceSensitive).toBe(true);
    expect(guidance?.prompt).toContain("Use direct web tools before answering");
    expect(guidance?.prompt).toContain("Start with web_search");
    expect(guidance?.prompt).toContain("use browser_navigate and then browser_snapshot or browser_wait_for");
    expect(guidance?.prompt).toContain("Do not claim that a site is unreadable due to JavaScript");
    expect(guidance?.prompt).toContain("copy the exact value and its associated date from the freshest tool result");
  });

  it("adds web-search guidance for German freshness-sensitive requests", () => {
    const guidance = buildDynamicTurnGuidance("gib mir die aktuellen eurojackpot zahlen");

    expect(guidance).not.toBeNull();
    expect(guidance?.freshnessSensitive).toBe(true);
    expect(guidance?.prompt).toContain("Use direct web tools before answering");
    expect(guidance?.prompt).toContain("copy the exact value and its associated date from the freshest tool result");
  });

  it("routes owned computer access requests away from pentest tools", () => {
    const guidance = buildDynamicTurnGuidance("can you use my computer or access my remote windows pc on 10.10.0.2");

    expect(guidance).not.toBeNull();
    expect(guidance?.computerAccessSensitive).toBe(true);
    expect(guidance?.prompt).toContain("not to run a security assessment");
    expect(guidance?.prompt).toContain("Do not route this request to pentest_set_scope, nmap_scan");
    expect(guidance?.prompt).toContain("You MUST use the delegate_to_agent tool with agentName='computer_use_agent'");
  });

  it("treats short local-desktop requests as computer-use tasks", () => {
    const guidance = buildDynamicTurnGuidance("nutze den localen desktop");

    expect(guidance).not.toBeNull();
    expect(guidance?.computerAccessSensitive).toBe(true);
    expect(guidance?.prompt).toContain("prefer adapter 'remote_node' rather than 'local_vscode'");
  });

  it("does not block pentest guidance when the user explicitly asks for a scan", () => {
    const guidance = buildDynamicTurnGuidance("run a vulnerability scan on my Windows PC with nmap");

    expect(guidance).not.toBeNull();
    expect(guidance?.computerAccessSensitive).toBe(true);
    expect(guidance?.prompt).not.toContain("Do not route this request to pentest_set_scope, nmap_scan");
  });

  it("builds an authoritative temporal context prompt for the current turn", () => {
    const prompt = buildTemporalContextPrompt(new Date("2026-03-26T12:00:00.000Z"));

    expect(prompt).toContain("2026-03-26");
    expect(prompt).toContain("Current year: 2026");
    expect(prompt).toContain("never fall back to older model memory");
  });

  it("enforces the documented per-turn cap for orchestration-heavy tools", () => {
    expect(getPerTurnToolCallLimit("delegate_to_agent")).toBe(3);
    expect(getPerTurnToolCallLimit("create_ephemeral_agent")).toBe(1);
    expect(getPerTurnToolCallLimit("web_search")).toBeUndefined();
  });

  it("builds a terminal response for repeated delegation loops", () => {
    const response = buildDelegationLoopResponse("[pentest_coordinator]: Please confirm the authorization reference.");

    expect(response).toContain("Delegation loop detected");
    expect(response).toContain("Latest delegated response");
    expect(response).toContain("Please confirm the authorization reference");
  });

  it("builds a compact model-visible context view for delegated agent results", () => {
    const result = buildModelVisibleToolResult(
      "delegate_to_agent",
      "[recon_agent]: ## Authorization Confirmed\n\nPlease confirm the authorization reference again before I proceed.",
      {
        agentName: "recon_agent",
        attemptedAgents: ["recon_agent"],
        routingReason: { confidence: "high" },
      },
    );

    expect(result).toContain("Delegated result from recon_agent");
    expect(result).toContain("Routing confidence: high");
    expect(result).toContain("Result summary:");
    expect(result).not.toContain("## Authorization Confirmed");
  });

  it("builds a compact model-visible context view for task-graph results", () => {
    const result = buildModelVisibleToolResult(
      "run_task_graph",
      "Swarm task graph complete.\n- recon [completed] recon_agent\n- report [failed] report_writer_agent",
      {
        completed: ["recon"],
        failed: ["report"],
        blocked: [],
      },
    );

    expect(result).toContain("Task graph completed");
    expect(result).toContain("Nodes completed: 1");
    expect(result).toContain("Failed: 1");
  });

  it("does not add extra guidance for timeless questions", () => {
    expect(buildDynamicTurnGuidance("Explain how binary search works.")).toBeNull();
  });
});