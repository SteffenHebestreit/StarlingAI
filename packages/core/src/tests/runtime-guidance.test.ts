import { describe, expect, it } from "vitest";
import { buildDelegationLoopResponse, buildDynamicTurnGuidance, buildLanguageAndIdentityTurnGuidance, buildLanguageInstructionForTurn, buildModelVisibleToolResult, buildRepeatedOutputFingerprint, buildTemporalContextPrompt, getPerTurnToolCallLimit, shouldDefaultToGermanForMessage } from "../agent/runtime.js";

describe("runtime turn guidance", () => {
  it("adds web-search guidance for freshness-sensitive requests", () => {
    const guidance = buildDynamicTurnGuidance("What are the latest 2026 MCP updates? Cite official sources.", "orchestration_only");

    expect(guidance).not.toBeNull();
    expect(guidance?.freshnessSensitive).toBe(true);
    expect(guidance?.sourceSensitive).toBe(true);
    expect(guidance?.prompt).toContain("Delegate immediately to a suitable specialist agent");
    expect(guidance?.prompt).toContain("Use delegate_to_agent for atomic specialist routing");
    expect(guidance?.prompt).toContain("prefer a coordinator-style agent such as web_task_coordinator");
    expect(guidance?.prompt).toContain("route it through a browser specialist");
    expect(guidance?.prompt).toContain("Do not stop after a browser snapshot");
    expect(guidance?.prompt).toContain("copy the exact value and its associated date from the freshest tool result");
  });

  it("adds web-search guidance for German freshness-sensitive requests", () => {
    const guidance = buildDynamicTurnGuidance("gib mir die aktuellen eurojackpot zahlen", "orchestration_only");

    expect(guidance).not.toBeNull();
    expect(guidance?.freshnessSensitive).toBe(true);
    expect(guidance?.prompt).toContain("Delegate immediately to a suitable specialist agent");
    expect(guidance?.prompt).toContain("copy the exact value and its associated date from the freshest tool result");
  });

  it("treats explicit online-search requests as source-sensitive", () => {
    const guidance = buildDynamicTurnGuidance("suche online nach der genauen entfernung vom flughafen heraklion zum hotel out of the blue", "orchestration_only");

    expect(guidance).not.toBeNull();
    expect(guidance?.sourceSensitive).toBe(true);
    expect(guidance?.prompt).toContain("Delegate immediately to a suitable specialist agent");
    expect(guidance?.prompt).toContain("A tool-free answer is invalid");
  });

  it("routes owned computer access requests away from pentest tools", () => {
    const guidance = buildDynamicTurnGuidance("can you use my computer or access my remote windows pc on 10.10.0.2");

    expect(guidance).not.toBeNull();
    expect(guidance?.computerAccessSensitive).toBe(true);
    expect(guidance?.prompt).toContain("not to run a security assessment");
    expect(guidance?.prompt).toContain("Do not route this request to pentest_set_scope, nmap_scan");
    expect(guidance?.prompt).toContain("You MUST use the delegate_to_agent tool with agentName='computer_use_agent'");
  });

  it("treats short local-desktop requests as computer-use tasks", () => {
    const guidance = buildDynamicTurnGuidance("nutze den localen desktop");

    expect(guidance).not.toBeNull();
    expect(guidance?.computerAccessSensitive).toBe(true);
    expect(guidance?.prompt).toContain("prefer adapter 'remote_node' rather than 'local_vscode'");
  });

  it("routes mail drafting and sending requests to mail_agent", () => {
    const guidance = buildDynamicTurnGuidance("schreibe eine testmail an info@steffen-hebestreit.com und sende sie");

    expect(guidance).not.toBeNull();
    expect(guidance?.mailSensitive).toBe(true);
    expect(guidance?.prompt).toContain("dedicated mail_agent");
    expect(guidance?.prompt).toContain("delegate_to_agent tool with agentName='mail_agent'");
    expect(guidance?.prompt).toContain("mail_send_draft");
    expect(guidance?.prompt).toContain("explicit per-call approval");
  });

  it("routes reminders and timers to productivity_agent", () => {
    const guidance = buildDynamicTurnGuidance("remind me in 10 minutes to call Alex and start a 2 minute timer now");

    expect(guidance).not.toBeNull();
    expect(guidance?.productivitySensitive).toBe(true);
    expect(guidance?.prompt).toContain("dedicated productivity_agent");
    expect(guidance?.prompt).toContain("delegate_to_agent tool with agentName='productivity_agent'");
    expect(guidance?.prompt).toContain("reminder_create");
    expect(guidance?.prompt).toContain("timer_start");
  });

  it("routes travel distance questions to distance_specialist", () => {
    const guidance = buildDynamicTurnGuidance("wie lange brauche ich von worbis nach dresden", "orchestration_only");

    expect(guidance).not.toBeNull();
    expect(guidance?.navigationSensitive).toBe(true);
    expect(guidance?.prompt).toContain("distance_specialist");
    expect(guidance?.prompt).toContain("route distance or travel time between places");
    expect(guidance?.prompt).toContain("Do NOT stop at a generic estimate or a plan to look it up");
  });

  it("does not block pentest guidance when the user explicitly asks for a scan", () => {
    const guidance = buildDynamicTurnGuidance("run a vulnerability scan on my Windows PC with nmap");

    expect(guidance).not.toBeNull();
    expect(guidance?.computerAccessSensitive).toBe(true);
    expect(guidance?.prompt).not.toContain("Do not route this request to pentest_set_scope, nmap_scan");
  });

  it("treats pentest methodology questions as planning requests rather than live engagements", () => {
    const guidance = buildDynamicTurnGuidance("how would you do pentesting of our system, what plan would you follow?", "orchestration_only");

    expect(guidance).not.toBeNull();
    expect(guidance?.pentestSensitive).toBe(true);
    expect(guidance?.pentestMethodologySensitive).toBe(true);
    expect(guidance?.prompt).toContain("This is NOT a request to start a live pentest engagement");
    expect(guidance?.prompt).toContain("Do NOT ask for authorization, target scope");
    expect(guidance?.prompt).toContain("Use delegation to inspect or explain the configured pentest workflow");
    expect(guidance?.prompt).toContain("Do not call pentest_set_scope, nmap_scan");
  });

  it("routes swarm-maintenance requests into repo implementation rather than deployment disclaimers", () => {
    const guidance = buildDynamicTurnGuidance("implement this into our toolset and agents-set and update the main-agent so it can do this in the future", "orchestration_only");

    expect(guidance).not.toBeNull();
    expect(guidance?.swarmMaintenanceSensitive).toBe(true);
    expect(guidance?.prompt).toContain("improve StarlingAI itself");
    expect(guidance?.prompt).toContain("Treat this as swarm maintenance inside the current repository");
    expect(guidance?.prompt).toContain("You MUST use the delegate_to_agent tool with agentName='swarm_maintainer'");
    expect(guidance?.prompt).toContain("Do NOT call search_agents or list_agents first");
    expect(guidance?.prompt).toContain("swarm_maintainer");
    expect(guidance?.prompt).toContain("prompt_optimizer");
    expect(guidance?.prompt).toContain("Do NOT claim that you cannot modify the toolset or agent set");
  });

  it("builds an authoritative temporal context prompt for the current turn", () => {
    const prompt = buildTemporalContextPrompt(new Date("2026-03-26T12:00:00.000Z"));

    expect(prompt).toContain("2026-03-26");
    expect(prompt).toContain("Current year: 2026");
    expect(prompt).toContain("never fall back to older model memory");
  });

  it("defaults short greeting messages to German", () => {
    expect(shouldDefaultToGermanForMessage("hi")).toBe(true);
    expect(shouldDefaultToGermanForMessage("hello")).toBe(true);
    expect(buildLanguageInstructionForTurn("hi")).toContain("Reply in German");
    expect(buildLanguageInstructionForTurn("hello")).toContain("generic greeting");
  });

  it("tells the assistant not to introduce itself for greeting-only openings", () => {
    const guidance = buildLanguageAndIdentityTurnGuidance("hi");

    expect(guidance).toContain("Do not use small talk");
    expect(guidance).toContain("Do not introduce yourself");
    expect(guidance).toContain("Reply in German");
  });

  it("keeps clear longer messages in the user's language", () => {
    expect(shouldDefaultToGermanForMessage("Can you help me debug this issue? ")).toBe(false);
    expect(shouldDefaultToGermanForMessage("Kannst du mir beim Debuggen helfen?")).toBe(false);
    expect(buildLanguageInstructionForTurn("Can you help me debug this issue?")).toContain("Reply in the same language");
  });

  it("enforces the documented per-turn cap for orchestration-heavy tools", () => {
    expect(getPerTurnToolCallLimit("delegate_to_agent")).toBe(3);
    expect(getPerTurnToolCallLimit("search_agents")).toBe(2);
    expect(getPerTurnToolCallLimit("create_ephemeral_agent")).toBe(1);
    expect(getPerTurnToolCallLimit("web_search")).toBeUndefined();
  });

  it("builds a terminal response for repeated delegation loops", () => {
    const response = buildDelegationLoopResponse("[pentest_coordinator]: Please confirm the authorization reference.");

    expect(response).toContain("Delegation loop detected");
    expect(response).toContain("Latest delegated response");
    expect(response).toContain("Please confirm the authorization reference");
  });

  it("builds a compact model-visible context view for delegated agent results", () => {
    const result = buildModelVisibleToolResult(
      "delegate_to_agent",
      "[recon_agent]: ## Authorization Confirmed\n\nPlease confirm the authorization reference again before I proceed.",
      {
        agentName: "recon_agent",
        attemptedAgents: ["recon_agent"],
        routingReason: { confidence: "high" },
      },
    );

    expect(result).toContain("Delegated result from recon_agent");
    expect(result).toContain("Routing confidence: high");
    expect(result).toContain("Observed evidence:");
    expect(result).not.toContain("## Authorization Confirmed");
  });

  it("preserves structured screen evidence for computer-use delegated results", () => {
    const result = buildModelVisibleToolResult(
      "delegate_to_agent",
      [
        "[computer_use_agent]: ## Snapshot Review",
        "",
        "Screen after action: LM Studio window is visible.",
        "The latest snapshot shows a model dropdown, but the selected model text is unreadable.",
        "I cannot confirm the exact model name from this snapshot.",
      ].join("\n"),
      {
        agentName: "computer_use_agent",
        attemptedAgents: ["computer_use_agent"],
        routingReason: { confidence: "high" },
      },
    );

    expect(result).toContain("Delegated result from computer_use_agent");
    expect(result).toContain("TASK COMPLETED SUCCESSFULLY");
    expect(result).toContain("Do NOT delegate again for the same information");
    expect(result).toContain("Observed evidence:");
    expect(result).toContain("Screen after action: LM Studio window is visible.");
    expect(result).toContain("I cannot confirm the exact model name from this snapshot.");
    expect(result).not.toContain("## Snapshot Review");
  });

  it("marks failed computer-use delegation as failed and forbids invented root causes", () => {
    const result = buildModelVisibleToolResult(
      "delegate_to_agent",
      "Error: All candidate agents failed for task 'List loaded LLMs'. Sub-agent 'computer_use_agent' timed out after 312227ms",
      {
        agentName: "computer_use_agent",
        attemptedAgents: ["computer_use_agent"],
        delegationSucceeded: false,
        routingReason: { confidence: "high" },
      },
    );

    expect(result).toContain("Delegated result from computer_use_agent — TASK FAILED.");
    expect(result).toContain("Do NOT claim the task was completed");
    expect(result).toContain("Do NOT invent root causes like connectivity");
    expect(result).toContain("timed out after 312227ms");
  });

  it("marks partial computer-use delegation as partial progress instead of failure", () => {
    const result = buildModelVisibleToolResult(
      "delegate_to_agent",
      [
        "Sub-agent 'computer_use_agent' timed out after 1000ms",
        "Partial progress before interruption:",
        "- Tool calls executed: 3 (computer_list_nodes, computer_session_start, computer_snapshot)",
        "- Iterations completed: 1",
      ].join("\n"),
      {
        agentName: "computer_use_agent",
        attemptedAgents: ["computer_use_agent"],
        delegationSucceeded: true,
        delegationOutcome: "partial",
        terminalState: "timeout",
        routingReason: { confidence: "high" },
      },
    );

    expect(result).toContain("Delegated result from computer_use_agent — PARTIAL PROGRESS.");
    expect(result).toContain("State clearly that the desktop run made progress but was interrupted before full completion");
    expect(result).toContain("Partial progress before interruption:");
    expect(result).not.toContain("TASK FAILED");
  });

  it("marks blocker-style delegated evidence as failed for synthesis", () => {
    const result = buildModelVisibleToolResult(
      "delegate_to_agent",
      "Blocker: Raw temperature data for Dresden, Germany, 2025 is unavailable. Please provide the structured JSON data to proceed.",
      {
        agentName: "researcher",
        attemptedAgents: ["researcher"],
        routingReason: { confidence: "medium" },
      },
    );

    expect(result).toContain("Delegated result from researcher — TASK FAILED.");
    expect(result).toContain("Blocker: Raw temperature data for Dresden, Germany, 2025 is unavailable.");
  });

  it("builds a compact model-visible context view for task-graph results", () => {
    const result = buildModelVisibleToolResult(
      "run_task_graph",
      "Swarm task graph complete.\n- recon [completed] recon_agent\n- report [failed] report_writer_agent",
      {
        completed: ["recon"],
        failed: ["report"],
        blocked: [],
      },
    );

    expect(result).toContain("Task graph finished with incomplete status");
    expect(result).toContain("Nodes completed: 1");
    expect(result).toContain("Failed: 1");
    expect(result).toContain("Observed evidence:");
    expect(result).toContain("recon [completed] recon_agent");
  });

  it("marks search_agents results as routing suggestions rather than executed delegation", () => {
    const result = buildModelVisibleToolResult(
      "search_agents",
      '➡ NEXT ACTION: Call delegate_to_agent(agentName="mission_coordinator", task="<your task>") NOW. Do NOT call search_agents again.\n\nAgents matching "financial data chart etf msci world": **mission_coordinator**',
    );

    expect(result).toContain("Agent routing suggestions only. No delegation has happened yet.");
    expect(result).toContain("do NOT tell the user that work was routed");
    expect(result).toContain("mission_coordinator");
  });

  it("builds an evidence-preserving model-visible context view for parallel delegation results", () => {
    const result = buildModelVisibleToolResult(
      "parallel_delegate",
      "**[researcher]**:\nPrice: 19.99 USD\n\n---\n\n**[summarizer]**:\nStatus: READY",
      {
        succeeded: 2,
        failed: 0,
        taskCount: 2,
      },
    );

    expect(result).toContain("Parallel delegation completed. Successful tasks: 2/2. Failed tasks: 0.");
    expect(result).toContain("Observed evidence:");
    expect(result).toContain("Price: 19.99 USD");
    expect(result).toContain("Status: READY");
  });

  it("builds an evidence-preserving model-visible context view for ephemeral agent results", () => {
    const result = buildModelVisibleToolResult(
      "create_ephemeral_agent",
      "[ephemeral:api_inspector]: Endpoint: /v1/health\nStatus: healthy",
      {
        agentName: "ephemeral:api_inspector",
        rejectedTools: ["shell_exec"],
      },
    );

    expect(result).toContain("Ephemeral agent ephemeral:api_inspector completed.");
    expect(result).toContain("Rejected tools: shell_exec.");
    expect(result).toContain("Observed evidence:");
    expect(result).toContain("Endpoint: /v1/health");
    expect(result).not.toContain("[ephemeral:api_inspector]:");
  });

  it("does not add extra guidance for timeless questions", () => {
    expect(buildDynamicTurnGuidance("Explain how binary search works.")).toBeNull();
  });

  it("distinguishes repeated-output fingerprints when tool arguments differ", () => {
    const first = buildRepeatedOutputFingerprint(
      "web_search",
      { query: "penetration testing methodology 2025 2026 best practices framework", maxResults: 10 },
      "**Web Search Results for:** \"penetration testing methodology 2025 2026 best practices framework\" ...",
    );
    const second = buildRepeatedOutputFingerprint(
      "web_search",
      { query: "PTES penetration testing methodology step by step 2025", maxResults: 10 },
      "**Web Search Results for:** \"penetration testing methodology 2025 2026 best practices framework\" ...",
    );

    expect(first).not.toBe(second);
  });

  it("keeps repeated-output fingerprints identical for the same tool arguments and output", () => {
    const first = buildRepeatedOutputFingerprint(
      "web_fetch",
      { url: "https://securityboulevard.com/2025/08/penetration-testing-methodology-step-by-step-breakdown-for-2025/", maxLength: 8000 },
      "**Content from:** https://securityboulevard.com/2025/08/penetration-testing-methodology-step-by-step-breakdown-for-2025/\n\nPenetration Testing Methodology...",
    );
    const second = buildRepeatedOutputFingerprint(
      "web_fetch",
      { url: "https://securityboulevard.com/2025/08/penetration-testing-methodology-step-by-step-breakdown-for-2025/", maxLength: 8000 },
      "**Content from:** https://securityboulevard.com/2025/08/penetration-testing-methodology-step-by-step-breakdown-for-2025/\n\nPenetration Testing Methodology...",
    );

    expect(first).toBe(second);
  });
});