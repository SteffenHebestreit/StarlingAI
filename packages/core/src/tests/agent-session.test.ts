import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, createSession, getSessionTranscript, resetSessionsForTests } from "../agent/session.js";

afterEach(() => {
  vi.useRealTimers();
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
    const usesDirectMode = prompt.includes("Use direct tools first");
    const usesDelegateMode = prompt.includes("Use specialist agents as the default execution path");

    expect(prompt).toContain("## Swarm Rules");
    expect(usesDirectMode || usesDelegateMode).toBe(true);
    expect(prompt).toContain("ask one concise clarifying question instead of guessing");
    expect(prompt).toContain("parallel_delegate");
    expect(prompt).toContain("Maximum 1 create_ephemeral_agent call per turn");
    expect(prompt).toContain("## Orchestration Strategy");
    expect(prompt).toContain("For workflows with explicit dependencies, use run_task_graph");
    expect(prompt).toContain("After delegation(s) complete, synthesize results into one concise final answer immediately.");

    if (usesDelegateMode) {
      expect(prompt).toContain("Use delegate_to_agent for every non-trivial action");
      expect(prompt).toContain("Complex work should flow through cooperating specialists that exchange facts via shared session memory");
    }

    expect(prompt.includes("## Available Sub-Agents") || prompt.includes("No specialist agents are configured.")).toBe(true);
  });

  it("refreshes stale embedded date lines in persisted system prompts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-26T12:00:00.000Z"));

    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "Custom system prompt.\n\nToday's date: Friday, March 21, 2025",
    });

    const prompt = session.getSystemPrompt();

    expect(prompt).toContain("Today's date: Thursday, March 26, 2026");
    expect(prompt).not.toContain("2025");
  });

  it("refreshes managed default prompts for persisted sessions", () => {
    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are StarlingAI, a pragmatic AI assistant that can work directly with built-in tools and coordinate specialized sub-agents when needed.\n\nToday's date: Friday, March 21, 2025",
    });

    const prompt = session.getSystemPrompt();

    expect(prompt).toContain("computer-use tasks, not pentest tasks");
    expect(prompt).toContain("prefer delegate_to_agent(agentName: \"computer_use_agent\", task: \"...\") first");
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