import { describe, expect, it } from "vitest";
import { lastAssistantMessage, turnOutcome, type OutcomeMessage } from "./turnOutcome";

const user = (id: string): OutcomeMessage => ({ id, role: "user", content: "Frage" });
const answer = (id: string, extra: Partial<OutcomeMessage> = {}): OutcomeMessage => ({ id, role: "assistant", content: "Antwort", ...extra });

describe("turnOutcome", () => {
  it("reads the turn's own answer", () => {
    const messages = [user("u1"), answer("a1"), user("u2"), answer("a2")];
    expect(turnOutcome(messages, "a1")).toEqual({ kind: "answer", message: messages[3] });
  });

  // Stop leaves a blocked note; the newest *answer* was then the last turn's, and it was read aloud.
  it("says nothing after a Stop, and never reads the answer before it", () => {
    const stopped = [user("u1"), answer("a1"), user("u2"), answer("n2", { blocked: true, stopped: true, content: "⚠️ Turn cancelled by user." })];
    expect(turnOutcome(stopped, "a1")).toEqual({ kind: "silent" });
    const nothingNew = [user("u1"), answer("a1"), user("u2")];
    expect(turnOutcome(nothingNew, "a1")).toEqual({ kind: "silent" });
  });

  it("reports a failed turn, and ignores the live bubble", () => {
    expect(turnOutcome([answer("a1"), answer("e2", { blocked: true })], "a1")).toEqual({ kind: "failed" });
    expect(turnOutcome([answer("a1"), answer("streaming")], "a1")).toEqual({ kind: "silent" });
    expect(lastAssistantMessage([answer("a1"), user("u2"), answer("streaming")])?.id).toBe("a1");
  });

  it("reads the first answer of a chat, and nothing for an empty one", () => {
    expect(turnOutcome([user("u1"), answer("a1")], null).kind).toBe("answer");
    expect(turnOutcome([user("u1"), answer("a1", { content: "  " })], null)).toEqual({ kind: "silent" });
  });
});
