import { describe, expect, it } from "vitest";
import { AgentSession } from "../agent/session.js";
import { findRecentDelegateEvidence } from "../agent/interrupted-delegation-evidence.js";
import { collectTurnArtifactAttachments } from "../agent/runtime.js";
import { currentTurnStartIndex, startsTurn } from "../agent/turn-boundary.js";

/**
 * Mid-turn steering and the oversight redirect are injected as `role: "user"` messages so the
 * model treats them as the user's words — but they arrive INSIDE a turn. Every reader that keyed
 * "the current turn" on the last user-role message cut the turn there: the plan report was clipped
 * on the very turn answering from it, the recovery backstops dropped this turn's pre-steering
 * evidence, and the turn's own artifacts went missing from the verification gate. Those messages
 * now carry `metadata.midTurn`; a turn starts at a user message without it.
 */
const STEERING = {
  role: "user" as const,
  content: "[USER STEERING — sent mid-turn] Also cover Slovenia.",
  metadata: { midTurn: true },
};
const UNMARKED_STEERING = { role: "user" as const, content: STEERING.content };

const makeSession = () => new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });

describe("mid-turn user messages do not end the turn", () => {
  it("startsTurn / currentTurnStartIndex read the marker", () => {
    expect(startsTurn({ role: "user" })).toBe(true);
    expect(startsTurn(STEERING)).toBe(false);
    expect(startsTurn({ role: "assistant" })).toBe(false);
    expect(currentTurnStartIndex([{ role: "user" }, { role: "assistant" }, STEERING])).toBe(0);
    expect(currentTurnStartIndex([{ role: "user" }, { role: "assistant" }, UNMARKED_STEERING])).toBe(2);
  });

  it("keeps the 12K plan report on the turn that is answering from it after a steering message", () => {
    const build = (steering: typeof STEERING | typeof UNMARKED_STEERING) => {
      const session = makeSession();
      session.addMessage({ role: "user", content: "compare the regions" });
      session.addMessage({
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "execute_plan", arguments: "{}" } }],
      } as never);
      session.addMessage({ role: "tool", content: "STEP s1 result: " + "x".repeat(6_000), tool_call_id: "call-1" } as never);
      session.addMessage(steering);
      return session.getCollapsedHistory().map((m) => String(m.content)).join("\n");
    };
    expect(build(STEERING)).toContain("x".repeat(5_000));          // still this turn: the whole report
    expect(build(UNMARKED_STEERING)).not.toContain("x".repeat(5_000)); // the control: an unmarked user message ends it
  });

  it("keeps a transient note visible across a steering message", () => {
    const session = makeSession();
    session.addMessage({ role: "user", content: "do the thing" });
    session.addMessage({ role: "system", content: "[USER INTERACTION OWNERSHIP] The main assistant owns all user-facing interaction." });
    session.addMessage(STEERING);
    expect(session.hasTransientNoteThisTurn("[USER INTERACTION OWNERSHIP]")).toBe(true);
  });

  it("the current-turn evidence backstop still sees this turn's pre-steering delegated evidence", () => {
    // Above the backstop's 400-character floor for a completed delegation, and structured enough
    // to score — this is what a real research result looks like.
    const evidence = "Delegated result from researcher — TASK COMPLETED.\nObserved evidence:\n"
      + "- The Vršič pass reaches 1,611 m and is open from early May to late October.\n"
      + "- The Soča valley has 14 registered campsites; the largest holds 320 pitches.\n"
      + "- Bled charges 6 EUR per day for lakeside parking, 3 EUR after 18:00.\n"
      + "- The Triglav park hut network lists 21 huts with 1,300 beds in total.\n"
      + "- The Kranjska Gora chairlifts run until 18:00 in summer, 16:00 in September.\n"
      + "- Rail from Ljubljana to Bled takes 40 minutes and runs hourly until 21:00.\n";
    const history = (steering: typeof STEERING | typeof UNMARKED_STEERING) => [
      { role: "user", content: "plan the trip" },
      { role: "tool", content: evidence, metadata: { agentName: "researcher", delegationSucceeded: true, delegationOutcome: "success" } },
      steering,
    ];
    expect(findRecentDelegateEvidence(history(STEERING), { scopeToCurrentTurn: true })).not.toBeNull();
    expect(findRecentDelegateEvidence(history(UNMARKED_STEERING), { scopeToCurrentTurn: true })).toBeNull();
  });

  it("this turn's artifacts are still this turn's after a steering message", () => {
    const build = (steering: typeof STEERING | typeof UNMARKED_STEERING) => {
      const session = makeSession();
      session.addMessage({ role: "user", content: "build the report" });
      session.addMessage({ role: "tool", content: "written", tool_call_id: "call-1", metadata: { filename: "report.pdf", outputPath: "out/report.pdf" } } as never);
      session.addMessage(steering);
      return collectTurnArtifactAttachments(session);
    };
    expect(build(STEERING)).toHaveLength(1);
    expect(build(UNMARKED_STEERING)).toHaveLength(0);
  });
});
