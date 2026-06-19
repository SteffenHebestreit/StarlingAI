import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, resetSessionsForTests } from "../agent/session.js";
import { buildTimeoutDeliveryMessage } from "../agent/runtime.js";

afterEach(() => {
  vi.useRealTimers();
  resetSessionsForTests();
});

/**
 * Fix B (audit b6f8336e, 0dc158ad turn 2): when the gateway turn watchdog fires it
 * used to ship status:error with no text → an empty bubble. buildTimeoutDeliveryMessage
 * recovers a useful, honest answer from the session so the turn never dead-ends.
 */
function freshSession(): AgentSession {
  return new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "test" });
}

describe("buildTimeoutDeliveryMessage", () => {
  it("relays substantial assistant text already produced THIS turn, with a stopped note", () => {
    const session = freshSession();
    session.addMessage({ role: "user", content: "Design a portable recorder and explain the parts." });
    const partial = "## Recorder design\n\nESP32-S3 with PSRAM, a five-mic array, and an SD card. " +
      "Here are the sections gathered before the cut-off, with the wiring and the BOM laid out in detail.";
    session.addMessage({ role: "assistant", content: partial });

    const out = buildTimeoutDeliveryMessage(session, { effortTier: "low", timeoutMs: 120_000 });
    expect(out.recoveredAssistantText).toBe(true);
    expect(out.response).toContain("ESP32-S3 with PSRAM"); // the real work is preserved
    expect(out.response).toContain("stopped at its 2 min time budget");
    expect(out.response).toContain("effort: low");
  });

  it("falls back to an honest time-budget notice when nothing was produced this turn", () => {
    const session = freshSession();
    session.addMessage({ role: "user", content: "Build a full tutorial website now." });
    // No assistant content this turn (a build delegation was aborted mid-flight).

    const out = buildTimeoutDeliveryMessage(session, { effortTier: "low", timeoutMs: 120_000 });
    expect(out.recoveredAssistantText).toBe(false);
    expect(out.response).toContain("hit its 2 min time budget");
    expect(out.response.toLowerCase()).toContain("nothing was lost");
    expect(out.response).toMatch(/higher effort tier|--timeout/);
    // Never empty — the whole point of the fix.
    expect(out.response.trim().length).toBeGreaterThan(40);
  });

  it("does NOT relay a SHORT assistant scrap (below the substance floor) as the answer", () => {
    const session = freshSession();
    session.addMessage({ role: "user", content: "Build the site." });
    session.addMessage({ role: "assistant", content: "ok" }); // 2 chars — not a real deliverable

    const out = buildTimeoutDeliveryMessage(session, { effortTier: "low", timeoutMs: 120_000 });
    expect(out.recoveredAssistantText).toBe(false); // fell through to the honest notice
    expect(out.response).toContain("time budget");
  });

  it("ignores a prior turn's answer (only THIS turn's assistant text is recovered)", () => {
    const session = freshSession();
    // Prior, completed turn.
    session.addMessage({ role: "user", content: "First request." });
    session.addMessage({ role: "assistant", content: "A complete prior answer that is long enough to be substantial and detailed." });
    // Current turn — a build that timed out with no output.
    session.addMessage({ role: "user", content: "Now build the website." });

    const out = buildTimeoutDeliveryMessage(session, { effortTier: "medium", timeoutMs: 600_000 });
    expect(out.recoveredAssistantText).toBe(false); // must NOT resurface the prior answer
    expect(out.response).not.toContain("complete prior answer");
    expect(out.response).toContain("10 min time budget");
    expect(out.response).not.toContain("effort:"); // medium is baseline → no tier note
  });
});
