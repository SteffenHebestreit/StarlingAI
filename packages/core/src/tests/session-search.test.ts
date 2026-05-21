import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, resetSessionsForTests } from "../agent/session.js";
import { searchSessions, summarizeSession } from "../agent/session-search.js";

function seedSession(id: string, channel: string, exchanges: Array<[string, string]>): void {
  const session = createSession({
    sessionId: id,
    channel,
    userId: "tester",
    workspacePath: mkdtempSync(join(tmpdir(), "starlingai-sess-")),
  });
  for (const [user, assistant] of exchanges) {
    session.addMessage({ role: "user", content: user });
    session.addMessage({ role: "assistant", content: assistant });
  }
}

describe("session search", () => {
  beforeEach(() => {
    resetSessionsForTests();
  });

  it("finds a past session by keyword and returns a snippet", () => {
    seedSession("sess-research", "web", [
      ["Build a cited zorptquux research report on widget protocols", "Done — produced a source-backed zorptquux report with citations."],
    ]);
    seedSession("sess-backup", "telegram", [
      ["Set up the nightly database backup job", "Configured the nightly backup with checksum verification."],
    ]);

    const results = searchSessions("zorptquux research report");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.id).toBe("sess-research");
    expect(results[0]?.matchedTerms).toContain("zorptquux");
    expect(results[0]?.snippet.toLowerCase()).toContain("zorptquux");
  });

  it("excludes the current session", () => {
    seedSession("sess-current", "web", [["unique marker flibberjab here", "ack flibberjab"]]);
    seedSession("sess-other", "web", [["another flibberjab discussion", "ack flibberjab again"]]);

    const results = searchSessions("flibberjab", { excludeSessionId: "sess-current" });
    expect(results.some((r) => r.id === "sess-current")).toBe(false);
    expect(results.some((r) => r.id === "sess-other")).toBe(true);
  });

  it("ignores sessions below the minimum message count", () => {
    const session = createSession({
      sessionId: "sess-tiny",
      channel: "web",
      userId: "tester",
      workspacePath: mkdtempSync(join(tmpdir(), "starlingai-sess-")),
    });
    session.addMessage({ role: "user", content: "lonely splonktreble message" });

    const results = searchSessions("splonktreble", { minMessages: 2 });
    expect(results.some((r) => r.id === "sess-tiny")).toBe(false);
  });

  it("summarizes a session via the LLM when provided, else extractively", async () => {
    seedSession("sess-sum", "web", [
      ["Help me draft a launch email for the new feature", "Here is a polished launch email covering the new feature and a clear call to action."],
    ]);

    const llmSummary = await summarizeSession("sess-sum", async () => "User wanted a launch email; a polished draft was produced.");
    expect(llmSummary).toContain("launch email");

    const extractive = await summarizeSession("sess-sum");
    expect(extractive).toContain("Asked:");
    expect(extractive).toContain("Outcome:");
  });
});
