import { afterEach, describe, expect, it } from "vitest";
import { AgentSession, createSession, getSessionTranscript, resetSessionsForTests } from "../agent/session.js";

afterEach(() => {
  resetSessionsForTests();
});

describe("AgentSession collapsed history", () => {
  it("keeps tool results on the active user turn", () => {
    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    session.addMessage({ role: "user", content: "schau mal ob es projecte zum bewerben gibt" });
    session.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "search_agents",
            arguments: JSON.stringify({ query: "projecte bewerben freelance jobs suchen" }),
          },
        },
      ],
    });
    session.addMessage({
      role: "tool",
      tool_call_id: "call_1",
      content: "**job_finder**\n  Finds freelance projects.\n  Confidence: medium",
    });

    const collapsed = session.getCollapsedHistory();

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toMatchObject({ role: "user" });
    expect(collapsed[0]?.content).toContain("schau mal ob es projecte zum bewerben gibt");
    expect(collapsed[0]?.content).toContain("[Tool: search_agents(query: projecte bewerben freelance jobs suchen)");
    expect(collapsed[0]?.content).toContain("**job_finder**");
  });

  it("includes swarm orchestration guidance in the default system prompt", () => {
    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
    });

    const prompt = session.getSystemPrompt();

    expect(prompt).toContain("## Swarm Rules");
    expect(prompt).toContain("Use direct tools first");
    expect(prompt).toContain("ask one concise clarifying question instead of guessing");
    expect(prompt).toContain("For mixed tasks, do the direct-tool portion first");
    expect(prompt).toContain("For simple login or form tasks, prefer get_site_credentials plus the browser_* tools yourself");
    expect(prompt).toContain("For file or image attachments, prefer extract_file_content or analyze_image first");
    expect(prompt).toContain("Use these only when direct tools are not enough");
    expect(prompt).toContain("parallel_delegate");
    expect(prompt).toContain("Maximum 1 create_ephemeral_agent call per turn");
    expect(prompt).toContain("Use application_pipeline only for its specific end-to-end browser workflow");
  });

  it("supports paged transcript retrieval for stored sessions", () => {
    const session = createSession({
      channel: "webchat",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    session.addMessage({ role: "user", content: "first" });
    session.addMessage({ role: "assistant", content: "reply one" });
    session.addMessage({ role: "user", content: "second" });
    session.addMessage({ role: "assistant", content: "reply two" });
    session.addMessage({ role: "user", content: "third" });

    const latestPage = getSessionTranscript(session.id, { limit: 2 });
    expect(latestPage?.totalMessages).toBe(5);
    expect(latestPage?.transcript).toHaveLength(2);
    expect(latestPage?.transcript.map((message) => message.content)).toEqual(["reply two", "third"]);
    expect(latestPage?.nextBeforeMessageId).toBe(latestPage?.transcript[0]?.id);

    const olderPage = getSessionTranscript(session.id, {
      limit: 2,
      beforeMessageId: latestPage?.nextBeforeMessageId,
    });
    expect(olderPage?.transcript.map((message) => message.content)).toEqual(["reply one", "second"]);
    expect(olderPage?.nextBeforeMessageId).toBe(olderPage?.transcript[0]?.id);

    const oldestPage = getSessionTranscript(session.id, {
      limit: 2,
      beforeMessageId: olderPage?.nextBeforeMessageId,
    });
    expect(oldestPage?.transcript.map((message) => message.content)).toEqual(["first"]);
    expect(oldestPage?.nextBeforeMessageId).toBeUndefined();
  });
});