import { beforeEach, describe, expect, it, vi } from "vitest";

// Preserve every real export; only logAudit is spied on so we can assert the
// turn_failed event without touching the audit sink.
vi.mock("../audit/logger.js", async (importActual) => {
  const actual = await importActual<typeof import("../audit/logger.js")>();
  return { ...actual, logAudit: vi.fn() };
});

import { logAudit } from "../audit/logger.js";
import { classifyTurnFailure, recordTurnFailure, turnFailureMarkerText } from "../agent/runtime.js";
import { AgentSession } from "../agent/session.js";

function failedAuditCalls() {
  return vi.mocked(logAudit).mock.calls.filter((c) => c[0] === "turn_failed");
}

describe("classifyTurnFailure", () => {
  it("treats the per-turn timeout abort as a recordable timeout (even if the caller also aborted)", () => {
    expect(classifyTurnFailure({ callerAborted: false, turnTimedOut: true, wardenAborted: false })).toBe("timeout");
    expect(classifyTurnFailure({ callerAborted: true, turnTimedOut: true, wardenAborted: false })).toBe("timeout");
  });

  it("treats a Warden cancel as a recordable warden_abort", () => {
    expect(classifyTurnFailure({ callerAborted: false, turnTimedOut: false, wardenAborted: true })).toBe("warden_abort");
  });

  it("treats a caller-only abort (user stop / superseding turn) as an intentional cancel", () => {
    expect(classifyTurnFailure({ callerAborted: true, turnTimedOut: false, wardenAborted: false })).toBe("cancelled");
  });

  it("treats any other throw as an error", () => {
    expect(classifyTurnFailure({ callerAborted: false, turnTimedOut: false, wardenAborted: false })).toBe("error");
  });
});

describe("turnFailureMarkerText", () => {
  it("names the cause and stays recoverable", () => {
    expect(turnFailureMarkerText("timeout").toLowerCase()).toContain("timed out");
    expect(turnFailureMarkerText("warden_abort").toLowerCase()).toContain("safety");
    expect(turnFailureMarkerText("error").toLowerCase()).toContain("retry");
  });
});

describe("recordTurnFailure", () => {
  beforeEach(() => {
    vi.mocked(logAudit).mockClear();
  });

  it("emits a turn_failed audit event AND persists a recoverable transcript marker for a real failure", () => {
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "x" });
    const before = session.toRecord().history.length;

    const text = recordTurnFailure(session, new Error("LLM call exceeded hard timeout of 600000ms"), "timeout");

    expect(text).not.toBeNull();
    // Audit: exactly one turn_failed event, severity error, carrying the kind + message.
    const calls = failedAuditCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ kind: "timeout", error: expect.stringContaining("hard timeout") });
    expect(calls[0]![2]).toMatchObject({ severity: "error", sessionId: session.id });
    // Transcript: a new assistant message flagged as a failure (no longer a silent gap).
    const history = session.toRecord().history;
    expect(history.length).toBe(before + 1);
    const last = history[history.length - 1]!;
    expect(last.role).toBe("assistant");
    expect(last.content).toBe(text);
    expect((last as { metadata?: Record<string, unknown> }).metadata).toMatchObject({ turnFailed: true, failureKind: "timeout" });
  });

  it("records errors under the error kind", () => {
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "x" });
    recordTurnFailure(session, new Error("boom"), "error");
    expect(failedAuditCalls()[0]![1]).toMatchObject({ kind: "error", error: "boom" });
  });

  it("records nothing for an intentional cancel (no audit, no transcript clutter)", () => {
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "x" });
    const before = session.toRecord().history.length;

    const text = recordTurnFailure(session, new Error("aborted"), "cancelled");

    expect(text).toBeNull();
    expect(failedAuditCalls()).toHaveLength(0);
    expect(session.toRecord().history.length).toBe(before);
  });
});
