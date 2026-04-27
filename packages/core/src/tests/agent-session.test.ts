import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("drops stale transient synthesis system messages before the next user turn", () => {
    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    session.addMessage({ role: "user", content: "wie lange brauche ich von worbis nach dresden" });
    session.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_nav",
          type: "function",
          function: {
            name: "delegate_to_agent",
            arguments: JSON.stringify({ agentName: "distance_specialist", task: "Resolve Worbis to Dresden" }),
          },
        },
      ],
    });
    session.addMessage({
      role: "tool",
      tool_call_id: "call_nav",
      content: "Delegated result from distance_specialist\nObserved evidence:\nMultiple matches were found.",
    });
    session.addMessage({
      role: "system",
      content: "[SYNTHESIS REQUIRED] The orchestration results above contain grounded evidence blocks.",
    });
    session.addMessage({
      role: "system",
      content: "[WARDEN STOP — FORCED SYNTHESIS] Two or more consecutive delegation attempts have failed.",
    });
    session.addMessage({
      role: "system",
      content: "[CONTINUE ORCHESTRATION] The latest delegated evidence identifies a concrete follow-up action.",
    });
    session.addMessage({
      role: "system",
      content: "[USER RESPONSE REQUIRED] The latest delegated evidence requires clarification from the user.",
    });
    session.addMessage({
      role: "system",
      content: "[DELEGATION FAILED] The latest delegated action failed or did not return useful evidence.",
    });
    session.addMessage({
      role: "system",
      content: "[USER INTERACTION OWNERSHIP] Ask the user for clarification.",
    });
    session.addMessage({
      role: "assistant",
      content: "Bitte präzisieren Sie den Start- und Zielort.",
    });
    session.addMessage({ role: "user", content: "worbis bei leinefelde und dresden in sachsen" });

    session.pruneTransientTurnSystemMessages();

    const collapsed = session.getCollapsedHistory();
    const collapsedText = collapsed.map((message) => String(message.content ?? "")).join("\n");

    expect(collapsedText).not.toContain("[SYNTHESIS REQUIRED]");
    expect(collapsedText).not.toContain("[WARDEN STOP — FORCED SYNTHESIS]");
    expect(collapsedText).not.toContain("[CONTINUE ORCHESTRATION]");
    expect(collapsedText).not.toContain("[USER RESPONSE REQUIRED]");
    expect(collapsedText).not.toContain("[DELEGATION FAILED]");
    expect(collapsedText).not.toContain("[USER INTERACTION OWNERSHIP]");
    expect(collapsedText).toContain("Bitte präzisieren Sie den Start- und Zielort.");
    expect(collapsedText).toContain("worbis bei leinefelde und dresden in sachsen");
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
    expect(prompt).toContain("validate it with up-to-date evidence whenever feasible");
    expect(prompt).toContain("parallel_delegate");
    expect(prompt).toContain("Maximum 1 create_ephemeral_agent call per turn");
    expect(prompt).toContain("## Orchestration Strategy");
    expect(prompt).toContain("For workflows with explicit dependencies, use run_task_graph");
    expect(prompt).toContain("After delegation(s) complete, synthesize results into one concise final answer immediately.");
    expect(prompt).toContain("## Agent Discovery");
    expect(
      prompt.includes("Prefer search_agents for discovery and routing")
      || prompt.includes("No specialist agents are configured."),
    ).toBe(true);
    expect(prompt).not.toContain("## Available Sub-Agents");

    if (usesDelegateMode) {
      expect(prompt).toContain("Complex work should flow through cooperating specialists that exchange facts via shared session memory");
      expect(
        prompt.includes("Use delegate_to_agent for every non-trivial action")
        || prompt.includes("Use orchestration tools to route every non-trivial action to specialists"),
      ).toBe(true);
      expect(prompt).toContain("prefer browser_agent directly");
      expect(prompt).toContain("call get_site_credentials first");
      expect(prompt).toContain("Do not ask the user to paste credentials that may already be stored");
    }
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
      systemPrompt: "You are StarlingAI, a pragmatic AI assistant whose primary role is planning, orchestration, and synthesis across specialized sub-agents.\n\nToday's date: Friday, March 21, 2025",
    });

    const prompt = session.getSystemPrompt();

    expect(prompt).toContain("You are the main assistant inside StarlingAI");
    expect(prompt).toContain("computer-use tasks, not pentest tasks");
    expect(prompt).toContain("prefer delegate_to_agent(agentName: \"computer_use_agent\", task: \"...\") first");
    expect(prompt).toContain("Requests asking how the pentest swarm works");
    expect(prompt).toContain("Do not ask for authorization or scope unless the user explicitly switches to running a real assessment");
    expect(prompt).toContain("swarm_maintainer");
    expect(prompt).toContain("do NOT call search_agents or list_agents first");
    expect(prompt).toContain("prefer delegate_to_agent(task: \"...\") without agentName first");
    expect(prompt).toContain("sourced chart, table, or HTML visualization");
    expect(prompt).toContain("You are responsible for all user-facing clarification questions, approval requests, and go/no-go checkpoints");
    expect(prompt).toContain("provide a concise user-facing progress update before triggering the next wave of actions");
    expect(prompt).toContain("Do not waste turns on small talk");
    expect(prompt).toContain("Do not introduce yourself, your role, or the platform unless the user explicitly asks");
  });

  it("includes configured main assistant custom instructions in the managed default prompt", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-main-assistant-prompt-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      agents: {
        mainAssistant: {
          customInstructions: "Keep the chat style crisp and ask before any irreversible workspace changes.",
        },
      },
    }, null, 2), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    try {
      const { AgentSession: FreshAgentSession } = await import("../agent/session.js");
      const session = new FreshAgentSession({
        channel: "test",
        workspacePath: "/workspace",
      });

      const prompt = session.getSystemPrompt();

      expect(prompt).toContain("## Main Assistant Custom Instructions");
      expect(prompt).toContain("Keep the chat style crisp and ask before any irreversible workspace changes.");
    } finally {
      delete process.env["SAI_CONFIG_PATH"];
      vi.resetModules();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("injects the persistent main assistant personality into the managed default prompt", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-main-assistant-personality-"));
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-main-assistant-workspace-"));
    const personalityPath = join(tempDir, "main-assistant-personality.json");

    writeFileSync(personalityPath, JSON.stringify({
      identity: "An exacting but funny engineering partner.",
      tone: ["Measured.", "Slightly sharper than default."],
      style: ["Lead with the decisive constraint."],
      quirks: ["Drops a dry one-liner when it fits."],
      growthNotes: ["The user likes stronger opinions when architecture is involved."],
      revision: 4,
      updatedAt: "2026-04-01T12:00:00.000Z",
      updatedBy: "user",
      reason: "Preference tuning",
    }, null, 2), "utf8");

    process.env["SAI_USER_MEMORY_PATH"] = tempDir;
    vi.resetModules();

    try {
      const { AgentSession: FreshAgentSession } = await import("../agent/session.js");
      const session = new FreshAgentSession({
        channel: "test",
        workspacePath,
      });

      const prompt = session.getSystemPrompt();

      expect(prompt).toContain("## Main Assistant Personality");
      expect(prompt).toContain("An exacting but funny engineering partner.");
      expect(prompt).toContain("Lead with the decisive constraint.");
      expect(prompt).toContain("assistant_personality_update");
    } finally {
      delete process.env["SAI_USER_MEMORY_PATH"];
      vi.resetModules();
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(workspacePath, { recursive: true, force: true });
    }
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

  it("preserves tool metadata in transcript entries for artifact hydration", () => {
    const session = new AgentSession({
      channel: "webchat",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    session.addMessage({ role: "user", content: "Create the report." });
    session.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_report",
          type: "function",
          function: {
            name: "generate_document",
            arguments: JSON.stringify({ title: "Report", format: "html" }),
          },
        },
      ],
    });
    session.addMessage({
      role: "tool",
      tool_call_id: "call_report",
      content: "Document saved to reports/report.html as html.",
      metadata: {
        outputPath: "reports/report.html",
        filename: "report.html",
        contentType: "text/html; charset=utf-8",
        previewMode: "html",
      },
    });

    const transcript = session.toTranscript();
    expect(transcript).toHaveLength(2);
    expect(transcript[1]?.toolCalls?.[0]).toMatchObject({
      name: "generate_document",
      metadata: {
        outputPath: "reports/report.html",
        filename: "report.html",
        contentType: "text/html; charset=utf-8",
        previewMode: "html",
      },
    });
  });

  it("preserves assistant swarm state in transcript entries for reconnect hydration", () => {
    const session = new AgentSession({
      channel: "webchat",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    session.addMessage({ role: "user", content: "Write the report." });
    session.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_delegate",
          type: "function",
          function: {
            name: "delegate_to_agent",
            arguments: JSON.stringify({ agentName: "paper_author", task: "Write the report" }),
          },
        },
      ],
    });
    session.addMessage({
      role: "tool",
      tool_call_id: "call_delegate",
      content: "Delegated result from paper_author — TASK COMPLETED.",
    });
    session.addMessage({
      role: "assistant",
      content: "Here is the finished report.",
      metadata: {
        swarmState: {
          objective: "Write the report",
          startedAt: "2026-04-09T15:28:32.887Z",
          updatedAt: "2026-04-09T15:32:43.490Z",
          tasks: {
            task_1: {
              id: "task_1",
              title: "Write the report",
              status: "completed",
              dependsOn: [],
              selectedAgent: "paper_author",
              attempts: [{
                agentName: "paper_author",
                status: "completed",
                startedAt: "2026-04-09T15:32:04.393Z",
                finishedAt: "2026-04-09T15:32:43.490Z",
                toolCount: 3,
                iterations: 3,
                toolNames: ["read_shared_facts", "read_file", "generate_document"],
              }],
            },
          },
        },
      },
    });

    const transcript = session.toTranscript();

    expect(transcript).toHaveLength(2);
    expect(transcript[1]?.swarmState).toMatchObject({
      objective: "Write the report",
      tasks: {
        task_1: {
          selectedAgent: "paper_author",
          status: "completed",
          attempts: [{
            agentName: "paper_author",
            toolCount: 3,
            iterations: 3,
          }],
        },
      },
    });
  });

  it("merges tool-call assistant turns with the final answer across transient control messages", () => {
    const session = new AgentSession({
      channel: "webchat",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    session.addMessage({ role: "user", content: "Research the latest MCU options." });
    session.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_delegate",
          type: "function",
          function: {
            name: "delegate_to_agent",
            arguments: JSON.stringify({ agentName: "web_task_coordinator", task: "Research current MCU options" }),
          },
        },
      ],
    });
    session.addMessage({
      role: "tool",
      tool_call_id: "call_delegate",
      content: "Delegated result from web_task_coordinator — TASK COMPLETED.\nObserved evidence:\n- ESP32-P4\n- STM32U5",
      metadata: {
        agentName: "web_task_coordinator",
        delegationOutcome: "success",
      },
    });
    session.addMessage({
      role: "system",
      content: "[SYNTHESIS REQUIRED] The orchestration results above contain grounded evidence blocks.",
    });
    session.addMessage({
      role: "system",
      content: "[USER INTERACTION OWNERSHIP] Ask the user yourself in one concise message and stop delegating until they respond.",
    });
    session.addMessage({
      role: "assistant",
      content: "ESP32-P4 and STM32U5 are the strongest current options.",
    });

    const transcript = session.toTranscript();

    expect(transcript).toHaveLength(2);
    expect(transcript[1]?.content).toBe("ESP32-P4 and STM32U5 are the strongest current options.");
    expect(transcript[1]?.toolCalls?.[0]).toMatchObject({
      name: "delegate_to_agent",
      args: {
        agentName: "web_task_coordinator",
        task: "Research current MCU options",
      },
    });
  });

  it("does not persist prompt-collapse tool summaries into stored user messages", () => {
    const session = new AgentSession({
      channel: "webchat",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    session.addMessage({ role: "user", content: "Find current pentest guidance." });
    session.addMessage({
      role: "assistant",
      content: "I'll search for current methodologies.",
      tool_calls: [
        {
          id: "call_search",
          type: "function",
          function: {
            name: "web_search",
            arguments: JSON.stringify({ query: "PTES 2026", maxResults: 5 }),
          },
        },
      ],
    });
    session.addMessage({
      role: "tool",
      tool_call_id: "call_search",
      content: "**Web Search Results for:** PTES 2026",
    });

    const collapsed = session.getCollapsedHistory();
    expect(collapsed[0]?.content).toContain("Find current pentest guidance.");
    expect(collapsed[0]?.content).toContain("[Tool: web_search");

    expect(session.getHistory()[0]?.content).toBe("Find current pentest guidance.");
    expect(session.toTranscript()[0]?.content).toBe("Find current pentest guidance.");
  });

  it("preserves long delegated evidence in collapsed history for synthesis", () => {
    const session = new AgentSession({
      channel: "webchat",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const evidenceTail = "GPU: AMD Radeon(TM) 8060S Graphics | VRAM: 55.8 GB | Model: text-embedding-qwen3-embedding-0.6b";
    const longEvidence = [
      "Delegated result from computer_use_agent - TASK COMPLETED SUCCESSFULLY.",
      "IMPORTANT: Relay ALL specific details from the evidence below.",
      "Observed evidence:",
      "1. qwen3.6-35b-a3b - READY - 22.87 GB",
      "2. zai-org/glm-4.7-flash - READY - 18.13 GB",
      "3. qwen/qwen3.5-4b - READY - 3.92 GB",
      "4. text-embedding-qwen3-embedding-0.6b - READY - 639.15 MB",
      "FILLER ".repeat(180),
      evidenceTail,
    ].join("\n");

    session.addMessage({ role: "user", content: "Liste mir die geladenen Modelle auf." });
    session.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_delegate",
          type: "function",
          function: {
            name: "delegate_to_agent",
            arguments: JSON.stringify({ agentName: "computer_use_agent", task: "List models" }),
          },
        },
      ],
    });
    session.addMessage({
      role: "tool",
      tool_call_id: "call_delegate",
      content: longEvidence,
    });

    const collapsed = session.getCollapsedHistory();

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.content).toContain("delegate_to_agent(agentName: computer_use_agent, task: List models)");
    expect(collapsed[0]?.content).toContain("qwen3.6-35b-a3b - READY - 22.87 GB");
    expect(collapsed[0]?.content).toContain(evidenceTail);
  });

  it("sanitizes previously corrupted user transcript content that leaked tool chatter", () => {
    const session = new AgentSession({
      channel: "webchat",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    session.addMessage({
      role: "user",
      content: [
        "we should look up how to properly do a detailed pentest",
        "",
        "I'll search for current penetration testing methodologies and frameworks, then review and improve our pentest-agent capabilities.",
        "",
        "[Tool: web_search(maxResults: 10, query: PTES penetration testing execution standard 2025 NIST SP 800-115 update) -> results]",
      ].join("\n"),
    });

    const transcript = session.toTranscript();
    expect(transcript[0]?.content).toBe("we should look up how to properly do a detailed pentest");
    expect(session.toSummary().preview).toBe("we should look up how to properly do a detailed pentest");
  });
});