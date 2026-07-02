import { describe, expect, it } from "vitest";
import {
  createToolDevSession,
  getToolDevSession,
  getActiveSessionCount,
  getAllActiveSessions,
  heartbeatSession,
  recordActivity,
  recordContainerSpawn,
  updateCode,
  recordTestResults,
  allTestsPassing,
  markAwaitingApproval,
  markApproved,
  markRejected,
  terminateSession,
  markStuck,
} from "../agent/tool-dev-session.js";

// In-memory tool-dev-session registry. Persistence (ephemeralPut) and event emits fail gracefully,
// so the lifecycle is safe to walk directly.
describe("tool dev session lifecycle", () => {
  it("creates, tracks, and drives a session through develop → test → approve", () => {
    const s = createToolDevSession({
      toolName: "cov_tool",
      description: "coverage tool",
      parametersSchema: { type: "object" },
      sessionId: "sess-cov-1",
      starterCode: "export const x = 1;",
      plannedTestCases: [{ input: {} }],
    });
    expect(getToolDevSession(s.id)).toBe(s);
    expect(getActiveSessionCount()).toBeGreaterThanOrEqual(1);
    expect(getAllActiveSessions().some((a) => a.id === s.id)).toBe(true);

    heartbeatSession(s.id);
    recordContainerSpawn(s.id);
    expect(getToolDevSession(s.id)!.containerSpawns).toBe(1);
    recordActivity(s.id);
    expect(getToolDevSession(s.id)!.iterations).toBeGreaterThanOrEqual(1);

    updateCode(s.id, "export const x = 2;");
    expect(getToolDevSession(s.id)!.code).toBe("export const x = 2;");
    expect(getToolDevSession(s.id)!.status).toBe("developing");

    // A repeated identical failure bumps the stuck-detection counter.
    const fail = [{ input: {}, actualOutput: "err", passed: false, error: "boom", durationMs: 1 }];
    recordTestResults(s.id, fail);
    expect(allTestsPassing(s.id)).toBe(false);
    recordTestResults(s.id, fail);
    expect(getToolDevSession(s.id)!.identicalFailureCount).toBe(2);
    // A passing run clears it.
    recordTestResults(s.id, [{ input: {}, actualOutput: "ok", passed: true, durationMs: 1 }]);
    expect(allTestsPassing(s.id)).toBe(true);

    markAwaitingApproval(s.id, "approval-1");
    expect(getToolDevSession(s.id)!.status).toBe("awaiting_approval");
    expect(getToolDevSession(s.id)!.approvalId).toBe("approval-1");
    markApproved(s.id);
    expect(getToolDevSession(s.id)!.status).toBe("approved");
  });

  it("supports reject / terminate / stuck transitions and no-ops on unknown ids", () => {
    const a = createToolDevSession({ toolName: "t_a", description: "d", parametersSchema: {}, sessionId: "sess-a" });
    markRejected(a.id);
    expect(getToolDevSession(a.id)!.status).toBe("rejected");

    const b = createToolDevSession({ toolName: "t_b", description: "d", parametersSchema: {}, sessionId: "sess-b" });
    terminateSession(b.id, "manual stop");
    expect(getToolDevSession(b.id)!.status).toBe("terminated");
    // Already-terminal sessions are not re-terminated.
    terminateSession(b.id, "again");
    expect(getToolDevSession(b.id)!.status).toBe("terminated");

    const c = createToolDevSession({ toolName: "t_c", description: "d", parametersSchema: {}, sessionId: "sess-c" });
    markStuck(c.id, "no progress");
    expect(getToolDevSession(c.id)!.status).toBe("stuck");

    // Unknown ids: every mutator is a safe no-op.
    heartbeatSession("nope");
    recordActivity("nope");
    recordContainerSpawn("nope");
    updateCode("nope", "x");
    markAwaitingApproval("nope", "a");
    markApproved("nope");
    markRejected("nope");
    markStuck("nope", "r");
    terminateSession("nope", "r");
    expect(getToolDevSession("nope")).toBeUndefined();
    expect(allTestsPassing("nope")).toBe(false);
  });
});
