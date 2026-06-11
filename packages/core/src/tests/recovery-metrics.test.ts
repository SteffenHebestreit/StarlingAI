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

/**
 * Persistence round-trip: retiring a net needs "hasn't fired in N weeks" evidence
 * that SURVIVES gateway restarts — in-memory-only counters reset the clock on every
 * redeploy, so nothing could ever be retired with confidence. Opt-in via
 * startRecoveryMetrics({persist:true}); unit tests and the scene worker stay in-memory.
 */
describe("recovery-metrics persistence across restarts", () => {
  afterEach(() => {
    resetRecoveryMetricsForTests();
    delete process.env["SAI_RECOVERY_NET_STATS"];
  });

  it("restores counts, firstFiredAt, and session totals after a restart", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const statsPath = join(mkdtempSync(join(tmpdir(), "sai-recovery-")), "recovery-net-stats.json");
    process.env["SAI_RECOVERY_NET_STATS"] = statsPath;

    startRecoveryMetrics({ persist: true });
    logAudit("tool_call_recovered", { reason: "wrapper_x" }, { sessionId: "s1" });
    logAudit("tool_call_recovered", { reason: "wrapper_x" }, { sessionId: "s2" });
    const firstSnap = getRecoveryMetricsSnapshot();
    resetRecoveryMetricsForTests(); // stop() flushes to disk, then clears memory

    expect(getRecoveryMetricsSnapshot().totalFirings).toBe(0); // memory really cleared

    startRecoveryMetrics({ persist: true }); // "restart"
    const snap = getRecoveryMetricsSnapshot();
    expect(snap.totalFirings).toBe(2);
    expect(snap.nets[0]!.key).toBe("tool_call_recovered:wrapper_x");
    expect(snap.nets[0]!.count).toBe(2);
    expect(snap.nets[0]!.sessions).toBe(2);
    expect(snap.nets[0]!.firstFiredAt).toBe(firstSnap.nets[0]!.firstFiredAt);
    expect(snap.persistedSince).not.toBeNull();

    // New firings after the restart accumulate on top of the restored baseline.
    logAudit("tool_call_recovered", { reason: "wrapper_x" }, { sessionId: "s3" });
    const after = getRecoveryMetricsSnapshot();
    expect(after.nets[0]!.count).toBe(3);
    expect(after.nets[0]!.sessions).toBe(3);
  });

  it("without persist, nothing is written and a restart starts from zero", () => {
    startRecoveryMetrics();
    logAudit("tool_call_recovered", { reason: "ephemeral_y" });
    resetRecoveryMetricsForTests();
    startRecoveryMetrics();
    expect(getRecoveryMetricsSnapshot().totalFirings).toBe(0);
  });
});

/**
 * Retirement-candidate report: a net whose last firing is older than the window is
 * removable scaffolding (anti-accretion discipline). Window coverage matters — a
 * fresh install must not mark every net "stale" before counting has spanned the window.
 */
describe("getStaleNetsReport", () => {
  afterEach(() => {
    resetRecoveryMetricsForTests();
    delete process.env["SAI_RECOVERY_NET_STATS"];
  });

  it("a fresh subscriber never reports stale nets (window not yet covered)", async () => {
    const { getStaleNetsReport } = await import("../observability/recovery-metrics.js");
    startRecoveryMetrics();
    logAudit("tool_call_recovered", { reason: "fresh_net" });
    const report = getStaleNetsReport(30);
    expect(report.windowCovered).toBe(false);
    expect(report.staleNets).toEqual([]);
    expect(report.activeNets).toBe(1);
  });

  it("flags a net restored from history whose last firing predates the window", async () => {
    const { getStaleNetsReport } = await import("../observability/recovery-metrics.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const statsPath = join(mkdtempSync(join(tmpdir(), "sai-stale-")), "recovery-net-stats.json");
    const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(statsPath, JSON.stringify({
      version: 1,
      since: daysAgo(120),
      savedAt: daysAgo(1),
      nets: {
        "guardrail_flagged:long_dead_net": { count: 7, firstFiredAt: daysAgo(120), lastFiredAt: daysAgo(90), sessions: 3 },
        "guardrail_flagged:busy_net": { count: 40, firstFiredAt: daysAgo(120), lastFiredAt: daysAgo(2), sessions: 9 },
      },
    }), "utf-8");
    process.env["SAI_RECOVERY_NET_STATS"] = statsPath;

    startRecoveryMetrics({ persist: true });
    const report = getStaleNetsReport(30);
    expect(report.windowCovered).toBe(true); // counting since 120d ago > 30d window
    expect(report.staleNets.map((n) => n.key)).toEqual(["guardrail_flagged:long_dead_net"]);
    expect(report.staleNets[0]!.count).toBe(7);
    expect(report.activeNets).toBe(1);
  });
});
