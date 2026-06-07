import { afterEach, describe, expect, it } from "vitest";
import {
  deriveNetKey,
  startRecoveryMetrics,
  stopRecoveryMetrics,
  getRecoveryMetricsSnapshot,
  resetRecoveryMetricsForTests,
} from "../observability/recovery-metrics.js";
import { logAudit } from "../audit/logger.js";

describe("deriveNetKey", () => {
  it("keys a recovered tool call by its reason", () => {
    expect(deriveNetKey({ type: "tool_call_recovered", data: { reason: "source_sensitive_original_request_enforced" } }))
      .toBe("tool_call_recovered:source_sensitive_original_request_enforced");
  });

  it("keys a flagged guardrail by its type", () => {
    expect(deriveNetKey({ type: "guardrail_flagged", data: { type: "raw_evidence_backstop_disabled" } }))
      .toBe("guardrail_flagged:raw_evidence_backstop_disabled");
  });

  it("keys a coordinator-recursion block (no sub-discriminator) by type alone", () => {
    expect(deriveNetKey({ type: "delegation_coordinator_recursion_blocked", data: {} }))
      .toBe("delegation_coordinator_recursion_blocked");
  });

  it("counts a sub_agent_tool_call ONLY when it was a recovery rewrite", () => {
    expect(deriveNetKey({ type: "sub_agent_tool_call", data: { phase: "recovered", reason: "source_sensitive_nested_parallel_collapsed" } }))
      .toBe("sub_agent_tool_call:recovered:source_sensitive_nested_parallel_collapsed");
    expect(deriveNetKey({ type: "sub_agent_tool_call", data: { phase: "done", tool: "web_search" } })).toBeNull();
  });

  it("returns null for non-net events (normal tool completions, messages)", () => {
    expect(deriveNetKey({ type: "tool_call_completed", data: { tool: "web_search" } })).toBeNull();
    expect(deriveNetKey({ type: "message_received", data: { length: 10 } })).toBeNull();
  });
});

describe("recovery-metrics aggregation (via the audit stream)", () => {
  afterEach(() => resetRecoveryMetricsForTests());

  it("counts firings per net from real logAudit calls, busiest first", () => {
    startRecoveryMetrics();
    logAudit("tool_call_recovered", { reason: "source_sensitive_original_request_enforced" }, { sessionId: "s1" });
    logAudit("tool_call_recovered", { reason: "source_sensitive_original_request_enforced" }, { sessionId: "s2" });
    logAudit("guardrail_flagged", { type: "raw_evidence_backstop_disabled" }, { sessionId: "s1" });
    logAudit("tool_call_completed", { tool: "web_search" }, { sessionId: "s1" }); // not a net

    const snap = getRecoveryMetricsSnapshot();
    expect(snap.distinctNets).toBe(2);
    expect(snap.totalFirings).toBe(3);
    expect(snap.nets[0]!.key).toBe("tool_call_recovered:source_sensitive_original_request_enforced");
    expect(snap.nets[0]!.count).toBe(2);
    expect(snap.nets[0]!.sessions).toBe(2);
    expect(snap.since).not.toBeNull();
  });

  it("stops counting after stopRecoveryMetrics()", () => {
    startRecoveryMetrics();
    logAudit("tool_call_recovered", { reason: "x" });
    stopRecoveryMetrics();
    logAudit("tool_call_recovered", { reason: "x" });
    expect(getRecoveryMetricsSnapshot().totalFirings).toBe(1);
  });
});
