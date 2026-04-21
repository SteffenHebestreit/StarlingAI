import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub logAudit before importing the warden so we can track alert emissions
// without writing to the real audit file.
vi.mock("../audit/logger.js", () => ({
  logAudit: vi.fn(),
  subscribeToAudit: vi.fn((cb: (e: unknown) => void) => {
    // store the subscriber so tests can fire events through it
    _subscriberRef = cb;
    return () => { _subscriberRef = null; };
  }),
}));

let _subscriberRef: ((e: unknown) => void) | null = null;

import {
  sweepAnomaliesNow,
  resetWardenForTests,
  getWardenStats,
  isAgentMessagingSuppressed,
  isSessionDegraded,
  markSessionDegraded,
  clearSessionDegraded,
  startWarden,
  stopWarden,
} from "../agent/warden.js";
import { logAudit } from "../audit/logger.js";

// Helper to fire a fake audit event through the subscriber
function fireEvent(event: Record<string, unknown>): void {
  _subscriberRef?.(event);
}

describe("Warden — tool storm detection", () => {
  beforeEach(() => {
    resetWardenForTests();
    vi.mocked(logAudit).mockClear();
    startWarden();
  });

  afterEach(() => {
    stopWarden();
  });

  it("does not alert below threshold", () => {
    for (let i = 0; i < 14; i++) {
      fireEvent({ type: "sub_agent_tool_call", sessionId: "sess-1", data: {} });
    }
    const alerts = sweepAnomaliesNow();
    expect(alerts.filter(a => a.type === "tool_storm")).toHaveLength(0);
  });

  it("fires tool_storm when threshold is reached", () => {
    for (let i = 0; i < 15; i++) {
      fireEvent({ type: "sub_agent_tool_call", sessionId: "sess-1", data: {} });
    }
    const alerts = sweepAnomaliesNow();
    expect(alerts.some(a => a.type === "tool_storm" && a.subject === "sess-1")).toBe(true);
    expect(vi.mocked(logAudit)).toHaveBeenCalledWith(
      "warden_alert",
      expect.objectContaining({ alertType: "tool_storm" }),
      expect.objectContaining({ severity: "warn" }),
    );
  });

  it("ignores done-phase sub-agent tool events for tool storm counting", () => {
    for (let i = 0; i < 15; i++) {
      fireEvent({ type: "sub_agent_tool_call", sessionId: "sess-done", data: { phase: "done", success: true } });
    }
    const alerts = sweepAnomaliesNow();
    expect(alerts.filter(a => a.type === "tool_storm")).toHaveLength(0);
  });

  it("resets window after firing so it does not re-alert on the same burst", () => {
    for (let i = 0; i < 15; i++) {
      fireEvent({ type: "sub_agent_tool_call", sessionId: "sess-2", data: {} });
    }
    sweepAnomaliesNow();
    vi.mocked(logAudit).mockClear();
    // No new events — second sweep should not fire
    const alerts2 = sweepAnomaliesNow();
    expect(alerts2.filter(a => a.type === "tool_storm")).toHaveLength(0);
  });

  it("E19: fires tool_storm_imminent when short-window velocity is elevated", () => {
    // 8 calls in <60s — below hard threshold (15/5min) but meets predict bar.
    for (let i = 0; i < 8; i++) {
      fireEvent({ type: "sub_agent_tool_call", sessionId: "sess-imm", data: {} });
    }
    const alerts = sweepAnomaliesNow();
    expect(alerts.some(a => a.type === "tool_storm_imminent" && a.subject === "sess-imm")).toBe(true);
    expect(alerts.some(a => a.type === "tool_storm")).toBe(false);
  });

  it("E19: imminent alert does not re-fire during cooldown", () => {
    for (let i = 0; i < 8; i++) {
      fireEvent({ type: "sub_agent_tool_call", sessionId: "sess-cool", data: {} });
    }
    sweepAnomaliesNow();
    vi.mocked(logAudit).mockClear();
    // Add one more call and sweep again — should NOT re-fire imminent.
    fireEvent({ type: "sub_agent_tool_call", sessionId: "sess-cool", data: {} });
    const alerts2 = sweepAnomaliesNow();
    expect(alerts2.filter(a => a.type === "tool_storm_imminent")).toHaveLength(0);
  });

  it("graceful-degradation: tool_storm_imminent marks session as degraded", () => {
    // Subject must match extractSessionIdFromSubject's pattern — use a
    // UUID-like session ID so the warden recognises it as a session subject.
    const sid = "abcdef0123456789";
    for (let i = 0; i < 8; i++) {
      fireEvent({ type: "sub_agent_tool_call", sessionId: sid, data: {} });
    }
    sweepAnomaliesNow();
    expect(isSessionDegraded(sid)).toBe(true);
  });

  it("graceful-degradation: non-imminent sessions stay non-degraded", () => {
    const sid = "fedcba9876543210";
    for (let i = 0; i < 3; i++) {
      fireEvent({ type: "sub_agent_tool_call", sessionId: sid, data: {} });
    }
    sweepAnomaliesNow();
    expect(isSessionDegraded(sid)).toBe(false);
  });

  it("graceful-degradation: clearSessionDegraded lifts the flag", () => {
    markSessionDegraded("sess-degrade-3");
    expect(isSessionDegraded("sess-degrade-3")).toBe(true);
    clearSessionDegraded("sess-degrade-3");
    expect(isSessionDegraded("sess-degrade-3")).toBe(false);
  });

});

describe("Warden — repeated failures detection", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-warden-"));
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    resetWardenForTests();
    vi.mocked(logAudit).mockClear();
    startWarden();
  });

  afterEach(() => {
    stopWarden();
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not alert with fewer than threshold failures", () => {
    for (let i = 0; i < 2; i++) {
      fireEvent({ type: "sub_agent_max_iterations", sessionId: "s", data: { agentName: "fragile_agent" } });
    }
    const alerts = sweepAnomaliesNow();
    expect(alerts.filter(a => a.type === "repeated_failures")).toHaveLength(0);
  });

  it("fires repeated_failures and reinforces circuit breaker", () => {
    for (let i = 0; i < 3; i++) {
      fireEvent({ type: "sub_agent_max_iterations", sessionId: "s", data: { agentName: "fragile_agent" } });
    }
    const alerts = sweepAnomaliesNow();
    const hit = alerts.find(a => a.type === "repeated_failures");
    expect(hit).toBeDefined();
    expect(hit?.action).toBe("circuit_tripped");
    expect(hit?.severity).toBe("error");
  });

  it("clears the agent entry after acting so it won't double-fire", () => {
    for (let i = 0; i < 3; i++) {
      fireEvent({ type: "sub_agent_max_iterations", sessionId: "s", data: { agentName: "fragile_agent" } });
    }
    sweepAnomaliesNow();
    vi.mocked(logAudit).mockClear();
    const alerts2 = sweepAnomaliesNow();
    expect(alerts2.filter(a => a.type === "repeated_failures")).toHaveLength(0);
  });
});

describe("Warden — tool escape attempt detection", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-warden-esc-"));
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    resetWardenForTests();
    vi.mocked(logAudit).mockClear();
    startWarden();
  });

  afterEach(() => {
    stopWarden();
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not alert below escape threshold", () => {
    for (let i = 0; i < 2; i++) {
      fireEvent({ type: "sub_agent_tool_blocked", sessionId: "sub:s:escape_agent:1", data: { agentName: "escape_agent" } });
    }
    const alerts = sweepAnomaliesNow();
    expect(alerts.filter(a => a.type === "tool_escape_attempt")).toHaveLength(0);
  });

  it("fires tool_escape_attempt at threshold", () => {
    for (let i = 0; i < 3; i++) {
      fireEvent({ type: "sub_agent_tool_blocked", sessionId: "sub:s:escape_agent:1", data: { agentName: "escape_agent" } });
    }
    const alerts = sweepAnomaliesNow();
    const hit = alerts.find(a => a.type === "tool_escape_attempt");
    expect(hit).toBeDefined();
    expect(hit?.action).toBe("circuit_tripped");
    expect(hit?.severity).toBe("error");
  });
});

describe("Warden — rate limit flood detection", () => {
  beforeEach(() => {
    resetWardenForTests();
    vi.mocked(logAudit).mockClear();
    startWarden();
  });

  afterEach(() => {
    stopWarden();
  });

  it("does not alert below flood threshold", () => {
    for (let i = 0; i < 4; i++) {
      fireEvent({ type: "rate_limited", sessionId: undefined, data: { scope: "channel_ingress", channel: "whatsapp", senderId: "123" } });
    }
    const alerts = sweepAnomaliesNow();
    expect(alerts.filter(a => a.type === "rate_limit_flood")).toHaveLength(0);
  });

  it("fires rate_limit_flood when sender exceeds threshold", () => {
    for (let i = 0; i < 5; i++) {
      fireEvent({ type: "rate_limited", sessionId: undefined, data: { scope: "channel_ingress", channel: "whatsapp", senderId: "spammer" } });
    }
    const alerts = sweepAnomaliesNow();
    const hit = alerts.find(a => a.type === "rate_limit_flood");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("warn");
    expect(hit?.subject).toBe("whatsapp:spammer");
  });
});

describe("Warden — direct agent message flood detection", () => {
  beforeEach(() => {
    resetWardenForTests();
    vi.mocked(logAudit).mockClear();
    startWarden();
  });

  afterEach(() => {
    stopWarden();
  });

  it("suppresses direct messaging when an agent floods messages", () => {
    for (let i = 0; i < 20; i++) {
      fireEvent({ type: "agent_message_sent", sessionId: "sub:parent", data: { fromAgent: "planner", recipientCount: 1 } });
    }

    const alerts = sweepAnomaliesNow();
    const hit = alerts.find(a => a.type === "agent_message_flood");
    expect(hit).toBeDefined();
    expect(hit?.action).toBe("message_suppressed");
    expect(isAgentMessagingSuppressed("sub:parent", "planner")).toBe(true);
  });
});

describe("Warden — turn SLO breach detection", () => {
  beforeEach(() => {
    resetWardenForTests();
    vi.mocked(logAudit).mockClear();
    startWarden();
  });

  afterEach(() => {
    stopWarden();
  });

  it("does not alert when turn duration is within SLO", () => {
    // Default orchestratorTurnSloMs = 120_000 ms; send a turn well under budget
    fireEvent({ type: "turn_performance", sessionId: "orch-1", data: { turnDurationMs: 5_000, firstModelResponseMs: 2_000 } });
    expect(vi.mocked(logAudit).mock.calls.some(([type]) => type === "warden_alert")).toBe(false);
  });

  it("fires turn_slo_breach for orchestrator turn exceeding budget", () => {
    // Default orchestratorTurnSloMs = 120_000; send 150_000 ms
    fireEvent({ type: "turn_performance", sessionId: "orch-slow", data: { turnDurationMs: 150_000, firstModelResponseMs: 5_000 } });
    const calls = vi.mocked(logAudit).mock.calls.filter(([type]) => type === "warden_alert");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.[1]).toMatchObject({ alertType: "turn_slo_breach" });
    expect(getWardenStats().alertsEmitted).toBeGreaterThanOrEqual(1);
  });

  it("fires turn_slo_breach for sub-agent first-token latency exceeding budget", () => {
    // Default firstTokenSloMs = 30_000; send 45_000 ms first token — sub-agent session ("sub:...")
    fireEvent({ type: "turn_performance", sessionId: "sub:sess:agent:1", data: { turnDurationMs: 50_000, firstModelResponseMs: 45_000 } });
    const calls = vi.mocked(logAudit).mock.calls.filter(([type]) => type === "warden_alert");
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it("fires tool_failure_spike when suspicious tool failures accumulate", () => {
    fireEvent({ type: "tool_call_failed", sessionId: "orch-tools", data: { tool: "web_fetch", issueCode: "network_failure" } });
    fireEvent({ type: "tool_output_blocked", sessionId: "orch-tools", data: { tool: "web_fetch", issueCode: "tool_output_blocked" } });
    fireEvent({ type: "tool_call_completed", sessionId: "orch-tools", data: { tool: "web_search", issueCode: "empty_output", suspiciousReturn: true } });
    const alerts = sweepAnomaliesNow();
    const hit = alerts.find(a => a.type === "tool_failure_spike");
    expect(hit).toBeDefined();
    expect(hit?.intervention?.actions.some(action => action.kind === "stop_turn")).toBe(true);
    const calls = vi.mocked(logAudit).mock.calls.filter(([type]) => type === "warden_alert");
    expect(calls.some(([, data]) => (data as Record<string, unknown>)["alertType"] === "tool_failure_spike")).toBe(true);
  });

  it("fires repeated_identical_output immediately when runtime flags a loop", () => {
    // The runtime emits a tool_call_completed event with repeatedIdenticalOutput: true
    // when the same tool returns identical output ≥3 times in a row.
    fireEvent({
      type: "tool_call_completed",
      sessionId: "sess-loop",
      data: {
        tool: "browser_snapshot",
        success: true,
        suspiciousReturn: true,
        repeatedIdenticalOutput: true,
        issueCode: "repeated_identical_output",
      },
    });
    // Alert fires immediately (not on sweep)
    const calls = vi.mocked(logAudit).mock.calls.filter(([type]) => type === "warden_alert");
    expect(calls.some(([, data]) => (data as Record<string, unknown>)["alertType"] === "repeated_identical_output")).toBe(true);
    const alert = calls.find(([, data]) => (data as Record<string, unknown>)["alertType"] === "repeated_identical_output");
    expect(alert).toBeDefined();
    expect((alert![1] as Record<string, unknown>)["subject"]).toContain("browser_snapshot");
  });

  it("does not fire repeated_identical_output for a normal tool completion", () => {
    fireEvent({
      type: "tool_call_completed",
      sessionId: "sess-ok",
      data: { tool: "web_search", success: true, suspiciousReturn: false },
    });
    const calls = vi.mocked(logAudit).mock.calls.filter(([type]) => type === "warden_alert");
    expect(calls.some(([, data]) => (data as Record<string, unknown>)["alertType"] === "repeated_identical_output")).toBe(false);
  });
});

describe("Warden — stats and lifecycle", () => {
  beforeEach(() => {
    resetWardenForTests();
  });

  it("starts and stops cleanly", () => {
    expect(getWardenStats().running).toBe(false);
    startWarden();
    expect(getWardenStats().running).toBe(true);
    stopWarden();
    expect(getWardenStats().running).toBe(false);
  });

  it("tracks total alerts emitted across sweeps", () => {
    startWarden();
    for (let i = 0; i < 15; i++) {
      fireEvent({ type: "sub_agent_tool_call", sessionId: "sess-x", data: {} });
    }
    sweepAnomaliesNow();
    expect(getWardenStats().alertsEmitted).toBeGreaterThanOrEqual(1);
    stopWarden();
  });

  it("is idempotent — starting twice does not double-register", () => {
    startWarden();
    startWarden();
    for (let i = 0; i < 15; i++) {
      fireEvent({ type: "sub_agent_tool_call", sessionId: "sess-y", data: {} });
    }
    vi.mocked(logAudit).mockClear();
    sweepAnomaliesNow();
    const stormCalls = vi.mocked(logAudit).mock.calls.filter(
      ([type]) => type === "warden_alert",
    );
    // Only one alert per anomaly — not doubled
    expect(stormCalls).toHaveLength(1);
    stopWarden();
  });
});

describe("Warden — docker daemon unreachable detection", () => {
  beforeEach(() => {
    resetWardenForTests();
    vi.mocked(logAudit).mockClear();
    startWarden();
  });

  afterEach(() => {
    stopWarden();
  });

  it("fires an alert immediately when container-runner reports the daemon unreachable", () => {
    fireEvent({
      type: "docker_daemon_unreachable",
      sessionId: "sess-infra-1",
      data: {
        agentName: "researcher",
        source: "stderr",
        errorMessage: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      },
    });
    const calls = vi.mocked(logAudit).mock.calls.filter(([type]) => type === "warden_alert");
    expect(calls).toHaveLength(1);
    const [, data, opts] = calls[0]!;
    expect(data).toMatchObject({ alertType: "docker_daemon_unreachable" });
    expect(opts).toMatchObject({ severity: "error" });
  });

  it("includes the agent name and session prefix in the subject", () => {
    fireEvent({
      type: "docker_daemon_unreachable",
      sessionId: "sess-infra-subject",
      data: { agentName: "pentest_scanner", source: "spawn_error", errorMessage: "ENOENT" },
    });
    const calls = vi.mocked(logAudit).mock.calls.filter(([type]) => type === "warden_alert");
    const payload = calls[0]?.[1] as Record<string, unknown>;
    expect(String(payload["subject"])).toMatch(/^pentest_scanner@sess-infra-subject/);
  });

  it("attaches an intervention notice guiding operators to check Docker", () => {
    fireEvent({
      type: "docker_daemon_unreachable",
      sessionId: "sess-infra-2",
      data: { agentName: "researcher", source: "stderr", errorMessage: "cannot connect to the docker daemon" },
    });
    const calls = vi.mocked(logAudit).mock.calls.filter(([type]) => type === "warden_alert");
    const payload = calls[0]?.[1] as Record<string, unknown>;
    const intervention = payload["intervention"] as Record<string, unknown>;
    expect(intervention).toBeDefined();
    expect(intervention["reasonCode"]).toBe("docker_daemon_unreachable");
    expect(String(intervention["detail"])).toMatch(/Docker Desktop|dockerd|defaultContainerized/);
  });
});
