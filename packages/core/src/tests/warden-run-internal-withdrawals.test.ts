import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same stubs as warden.test.ts: appendOutcome would otherwise write
// packages/core/workspace/.starlingai/agent_outcomes.ndjson into the source tree, and here
// the mock is also the assertion surface — the synthetic failure outcome the escape sweep
// appends is what biases outcome-weighted routing away from the agent.
vi.mock("../agent/outcomes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/outcomes.js")>()),
  appendOutcome: vi.fn(),
}));

vi.mock("../audit/logger.js", () => ({
  logAudit: vi.fn(),
  subscribeToAudit: vi.fn((cb: (e: unknown) => void) => {
    _subscriberRef = cb;
    return () => { _subscriberRef = null; };
  }),
}));

let _subscriberRef: ((e: unknown) => void) | null = null;

import { sweepAnomaliesNow, resetWardenForTests, startWarden, stopWarden } from "../agent/warden.js";
import { RUN_INTERNAL_WITHDRAWAL_REASONS } from "../agent/run-blocked-tool-reasons.js";
import { appendOutcome } from "../agent/outcomes.js";
import { logAudit } from "../audit/logger.js";

function fireBlocked(reason: string | undefined, agentName = "researcher"): void {
  _subscriberRef?.({
    type: "sub_agent_tool_blocked",
    sessionId: `sub:s:${agentName}:1`,
    data: { agentName, tool: "web_search", ...(reason ? { reason } : {}) },
  });
}

/** The escape sweep fires at ESCAPE_THRESHOLD = 3 blocked calls in one sub-session. */
const ESCAPE_THRESHOLD = 3;

describe("Warden — run-internal tool withdrawals are not escape attempts", () => {
  beforeEach(() => {
    resetWardenForTests();
    vi.mocked(logAudit).mockClear();
    vi.mocked(appendOutcome).mockClear();
    startWarden();
  });

  afterEach(() => {
    stopWarden();
  });

  // The withdrawn tool deliberately stays on the wire (dropping it re-prefills the whole
  // prompt), so the model can and does retry it — three retries of a tool the runtime
  // itself took away must not read as probing for a tool the agent was never granted.
  for (const reason of RUN_INTERNAL_WITHDRAWAL_REASONS) {
    it(`ignores ${reason} blocks entirely`, () => {
      for (let i = 0; i < ESCAPE_THRESHOLD; i++) fireBlocked(reason);
      const alerts = sweepAnomaliesNow();

      expect(alerts.filter(a => a.type === "tool_escape_attempt")).toHaveLength(0);
      expect(vi.mocked(logAudit)).not.toHaveBeenCalledWith(
        "warden_alert",
        expect.objectContaining({ alertType: "tool_escape_attempt" }),
        expect.anything(),
      );
      // No fabricated failure row against a healthy agent.
      expect(vi.mocked(appendOutcome)).not.toHaveBeenCalled();
    });
  }

  it("still fires tool_escape_attempt for not_in_agent_tools and appends the failure outcome", () => {
    for (let i = 0; i < ESCAPE_THRESHOLD; i++) fireBlocked("not_in_agent_tools");
    const alerts = sweepAnomaliesNow();

    const hit = alerts.find(a => a.type === "tool_escape_attempt");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("error");
    expect(hit?.action).toBe("circuit_tripped");
    expect(vi.mocked(appendOutcome)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agent: "researcher",
        task: "warden:tool_escape_attempt",
        outcome: "failure",
      }),
    );
  });

  // The loop above iterates the set, so it cannot catch a reason MISSING from it. These pin
  // the intended contents against the reason strings sub-agent.ts actually emits.
  it("exempts every mid-run withdrawal reason the runtime emits, and only those", () => {
    expect([...RUN_INTERNAL_WITHDRAWAL_REASONS].sort()).toEqual([
      "approval_gate_unresolved",
      // The infra-family block (agent/infra-failure.ts) predates the prefix-stability wave
      // and behaves identically: the schemas stay on the wire and the call is refused at the
      // call site, so a model retrying an unreachable backend three times was tripping the
      // escape circuit on a withdrawal the runtime itself performed.
      "backend_unreachable",
      "delegation_cascade_failed",
      "evidence_cap_enforced",
      "search_backend_degraded",
    ]);
    expect(RUN_INTERNAL_WITHDRAWAL_REASONS.has("not_in_agent_tools")).toBe(false);
  });

  it("ignores the infra-family block a model keeps retrying", () => {
    for (let i = 0; i < ESCAPE_THRESHOLD; i++) fireBlocked("backend_unreachable");
    expect(sweepAnomaliesNow().filter(a => a.type === "tool_escape_attempt")).toHaveLength(0);
    expect(vi.mocked(appendOutcome)).not.toHaveBeenCalled();
  });

  it("counts a blocked row with no reason at all (pre-wave rows stay counted)", () => {
    for (let i = 0; i < ESCAPE_THRESHOLD; i++) fireBlocked(undefined);
    expect(sweepAnomaliesNow().some(a => a.type === "tool_escape_attempt")).toBe(true);
  });

  it("does not let withdrawal blocks pad the count toward the threshold", () => {
    // Two genuine escapes plus three withdrawals is still below the bar: if withdrawals
    // were merely discounted rather than ignored, this session would trip.
    fireBlocked("not_in_agent_tools");
    fireBlocked("search_backend_degraded");
    fireBlocked("delegation_cascade_failed");
    fireBlocked("evidence_cap_enforced");
    fireBlocked("backend_unreachable");
    fireBlocked("not_in_agent_tools");

    expect(sweepAnomaliesNow().filter(a => a.type === "tool_escape_attempt")).toHaveLength(0);
    expect(vi.mocked(appendOutcome)).not.toHaveBeenCalled();

    // …and the third genuine escape trips it, proving the counter is live, not disabled.
    fireBlocked("not_in_agent_tools");
    expect(sweepAnomaliesNow().some(a => a.type === "tool_escape_attempt")).toBe(true);
  });
});
