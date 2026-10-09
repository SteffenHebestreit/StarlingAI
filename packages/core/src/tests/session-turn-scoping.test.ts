import { describe, expect, it } from "vitest";
import { AgentSession } from "../agent/session.js";

const makeSession = () => new AgentSession({
  channel: "test",
  workspacePath: "/workspace",
  systemPrompt: "You are a test agent.",
});

function addPlanRound(session: AgentSession, id: string, result: string): void {
  session.addMessage({
    role: "assistant",
    content: "",
    tool_calls: [{ id, type: "function", function: { name: "execute_plan", arguments: "{}" } }],
  } as never);
  session.addMessage({ role: "tool", content: result, tool_call_id: id } as never);
}

describe("session history is scoped to the turn", () => {
  it("keeps the 12K plan report only for the turn that is answering from it", () => {
    const session = makeSession();
    const report = "STEP s1 result: " + "x".repeat(6_000);
    session.addMessage({ role: "user", content: "first request" });
    addPlanRound(session, "call-1", report);
    session.addMessage({ role: "assistant", content: "answer one" });

    const during = session.getCollapsedHistory().map((m) => String(m.content)).join("\n");
    expect(during).toContain("x".repeat(5_000));   // the whole report, on the turn that reads it

    session.addMessage({ role: "user", content: "second request" });
    const later = session.getCollapsedHistory().map((m) => String(m.content)).join("\n");
    expect(later).not.toContain("x".repeat(5_000)); // the delegation cap, once the turn is over
    expect(later).toContain("snippet summarized for prior-turn history");
  });

  it("knows whether a transient note is already on the current turn", () => {
    const session = makeSession();
    session.addMessage({ role: "user", content: "do the thing" });
    expect(session.hasTransientNoteThisTurn("[USER INTERACTION OWNERSHIP]")).toBe(false);
    session.addMessage({ role: "system", content: "[USER INTERACTION OWNERSHIP] The main assistant owns all user-facing interaction." });
    expect(session.hasTransientNoteThisTurn("[USER INTERACTION OWNERSHIP]")).toBe(true);
    session.addMessage({ role: "user", content: "next turn" });
    expect(session.hasTransientNoteThisTurn("[USER INTERACTION OWNERSHIP]")).toBe(false);
  });

  it("prunes the plan-continuation directive with the other per-turn notes", () => {
    const session = makeSession();
    session.addMessage({ role: "user", content: "plan something" });
    session.addMessage({ role: "system", content: "[CONTINUE PLAN] You recorded a 3-step plan and have completed 1 of them this turn." });
    session.addMessage({ role: "assistant", content: "working on it" });
    session.addMessage({ role: "user", content: "new question" });
    session.pruneTransientTurnSystemMessages();
    expect(session.getHistory().some((m) => String(m.content).startsWith("[CONTINUE PLAN]"))).toBe(false);
  });
});
