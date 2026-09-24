import { describe, expect, it, vi } from "vitest";
import { NO_ANSWER_OUTPUT, unattendedInputCallback } from "../tools/ask-user.js";
import { getTool } from "../tools/registry.js";
import { DELEGATION_WAIT_TOOL_NAMES, STATE_DEPENDENT_TOOL_NAMES } from "../agent/turn-tool-contribution.js";
import { trackHumanWaits } from "../agent/user-input-broker.js";

describe("ask_user — a question is not a pure function of its arguments", () => {
  it("names the no-answer condition instead of returning an empty output", async () => {
    // The gateway resolves a timed-out prompt with "".
    const result = await getTool("ask_user")!.execute({ question: "Which region?" }, { inputCallback: async () => "" } as never);
    expect(result.success).toBe(true);
    expect(result.output).toBe(NO_ANSWER_OUTPUT);
    expect(result.output.length).toBeGreaterThan(40);
  });

  it("returns the user's answer untouched when one arrives", async () => {
    const result = await getTool("ask_user")!.execute({ question: "Which region?" }, { inputCallback: async () => "Bavaria" } as never);
    expect(result.output).toBe("Bavaria");
  });

  it("answers itself when the run is unattended", async () => {
    expect((await unattendedInputCallback()).length).toBeGreaterThan(40);
  });

  it("holds the model's wait between 10 s and 15 min, and holds the run clocks while the person answers", async () => {
    const tracker = trackHumanWaits("sess-ask");
    const seen: Array<{ timeoutMs?: number; waiting: boolean }> = [];
    const inputCallback = async (_question: string, _choices?: string[], timeoutMs?: number) => {
      seen.push({ timeoutMs, waiting: tracker.isWaiting() });
      return "yes";
    };
    await getTool("ask_user")!.execute({ question: "Go?", timeoutMs: 5 }, { sessionId: "sess-ask", inputCallback } as never);
    await getTool("ask_user")!.execute({ question: "Go?", timeoutMs: 7_200_000 }, { sessionId: "sess-ask", inputCallback } as never);
    expect(seen).toEqual([{ timeoutMs: 10_000, waiting: true }, { timeoutMs: 900_000, waiting: true }]);
    expect(tracker.isWaiting()).toBe(false);
    tracker.dispose();
  });

  it("stops holding the run clocks the moment the turn is stopped, though the question may linger", async () => {
    // Review #17: a question left open by a stopped turn held — and was then credited to — the
    // clocks of the next turn on the same chat.
    const tracker = trackHumanWaits("sess-ask-stop");
    const stop = new AbortController();
    let answer!: (text: string) => void;
    const inputCallback = () => new Promise<string>((resolve) => { answer = resolve; });
    const asked = getTool("ask_user")!.execute({ question: "Go?" }, { sessionId: "sess-ask-stop", inputCallback, signal: stop.signal } as never);
    expect(tracker.isWaiting()).toBe(true);
    stop.abort();
    expect(tracker.isWaiting()).toBe(false);
    answer("");
    await asked;
    tracker.dispose();
  });

  it("holds request_human_assist's model-chosen wait to the same bounds, since every clock holds for it", async () => {
    // Review #29: any positive number went through, and a page the browser agent read could ask
    // for days of held clocks.
    await import("../tools/browser-assist.js");
    const { browserSessionManager } = await import("../agent/browser-session.js");
    const seen: Array<number | undefined> = [];
    const enabled = vi.spyOn(browserSessionManager, "isEnabled").mockReturnValue(true);
    const assist = vi.spyOn(browserSessionManager, "requestAssist").mockImplementation(async (_id, _reason, opts) => {
      seen.push(opts?.timeoutMs);
      return "resolved";
    });
    try {
      for (const timeoutMs of [2_000_000_000, 5, undefined]) {
        await getTool("request_human_assist")!.execute(
          { reason: "Solve the reCAPTCHA on the login form.", ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
          { sessionId: "sub:sess-assist:browser_agent:1" } as never,
        );
      }
    } finally {
      assist.mockRestore();
      enabled.mockRestore();
    }
    expect(seen).toEqual([900_000, 10_000, 900_000]);
  });

  it("is exempt from the identical-arguments cache and from the turn budget while it waits", () => {
    expect(STATE_DEPENDENT_TOOL_NAMES.has("ask_user")).toBe(true);
    expect(DELEGATION_WAIT_TOOL_NAMES.has("ask_user")).toBe(true);
    expect(STATE_DEPENDENT_TOOL_NAMES.has("request_human_assist")).toBe(true);
    expect(DELEGATION_WAIT_TOOL_NAMES.has("request_human_assist")).toBe(true);
  });
});
