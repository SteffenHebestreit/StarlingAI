import { describe, expect, it } from "vitest";
import { buildDelegationLoopResponse, buildModelVisibleToolResult, buildRepeatedOutputFingerprint, buildTemporalContextPrompt, classifyPostOrchestrationDisposition, getPerTurnToolCallLimit } from "../agent/runtime.js";
import { AgentSession } from "../agent/session.js";
import { buildDynamicTurnGuidance, buildLanguageInstructionForTurn, toSoftRoutingHint, looksMultiDomainResearch } from "../agent/intent-classifier.js";
import { computeTurnEnforcementSignals } from "../agent/turn-setup.js";

describe("looksMultiDomainResearch", () => {
  it("treats short lookups/validations as single-domain", () => {
    expect(looksMultiDomainResearch("search online and validate your response")).toBe(false);
    expect(looksMultiDomainResearch("research the best llm for 3d printing")).toBe(false);
  });

  it("flags a multi-area hardware build spec as multi-domain", () => {
    const spec = [
      "I want to build a portable battery-powered recorder.",
      "I need a flat high-quality microphone module or an array.",
      "Connect it to an ESP32 to sync recordings over OTA.",
      "I need two buttons and a battery as well as a USB-C charging module.",
      "What else do I need and how do I put it together?",
      "What improvements would you add for the best transcription quality?",
      "Also make it waterproof.",
    ].join("\n");
    expect(looksMultiDomainResearch(spec)).toBe(true);
  });
});

describe("toSoftRoutingHint", () => {
  it("reframes hard imperatives as advisory hints", () => {
    const hard = "You MUST delegate to swarm_maintainer this turn. Do NOT call search_agents first.";
    const soft = toSoftRoutingHint(hard);
    expect(soft).toContain("Routing hint (advisory");
    expect(soft).not.toContain("You MUST");
    expect(soft).not.toContain("Do NOT");
    expect(soft).not.toMatch(/\bthis turn\b/);
    expect(soft).toContain("swarm_maintainer");
  });

  it("softens standalone MUST / NEVER / STOP markers", () => {
    const soft = toSoftRoutingHint("You MUST stop. NEVER retry. STOP discovery. This MUST happen.");
    expect(soft).not.toMatch(/\bMUST\b/);
    expect(soft).not.toContain("NEVER");
    expect(soft).not.toContain("STOP");
  });

  it("returns blank input unchanged", () => {
    expect(toSoftRoutingHint("")).toBe("");
    expect(toSoftRoutingHint("   ")).toBe("   ");
  });
});

describe("trustModelRouting enforcement", () => {
  const signalsFor = (guidance: { sourceSensitive: boolean; freshnessSensitive: boolean }, trustModelRouting: boolean) =>
    computeTurnEnforcementSignals({
      effectiveToolMode: "orchestration_only",
      initialDynamicGuidance: { prompt: "test", ...guidance },
      channel: "webchat",
      allowedToolNameSet: new Set<string>(),
      userMessage: "test",
      recentWorkflowAuthoringMaintenanceContext: false,
      trustModelRouting,
    });

  it("keeps freshness-only routing advisory when the model is trusted", () => {
    expect(signalsFor({ sourceSensitive: false, freshnessSensitive: true }, true).requiresDelegatedResearch).toBe(false);
  });

  it("restores the strict freshness gate when model routing is not trusted", () => {
    expect(signalsFor({ sourceSensitive: false, freshnessSensitive: true }, false).requiresDelegatedResearch).toBe(true);
  });

  it("keeps source-sensitive work hard-gated regardless of the freshness policy", () => {
    expect(signalsFor({ sourceSensitive: true, freshnessSensitive: false }, true).requiresDelegatedResearch).toBe(true);
    expect(signalsFor({ sourceSensitive: true, freshnessSensitive: false }, false).requiresDelegatedResearch).toBe(true);
  });
});

describe("runtime turn guidance", () => {
  it("does not treat an incidental mention of research as a research command", () => {
    const guidance = buildDynamicTurnGuidance("yesterday I did some research on cats and want a haiku about it", "orchestration_only");
    // No source/research command, no product recommendation → not source-sensitive.
    expect(guidance?.sourceSensitive ?? false).toBe(false);
  });

  it("does NOT treat a self-capability availability question as source-sensitive", () => {
    // "are you available" is a meta question about the assistant, not a web lookup.
    const guidance = buildDynamicTurnGuidance("are you available to help me right now?", "orchestration_only");
    expect(guidance?.sourceSensitive ?? false).toBe(false);
  });

  it("does not flag a plain message without a URL or web hint", () => {
    // Guard against over-firing: no URL, no web/source/artifact term → null guidance,
    // so a plain chat turn still answers directly.
    expect(buildDynamicTurnGuidance("write me a short haiku about the sea", "orchestration_only")?.sourceSensitive ?? false).toBe(false);
  });

  it("keeps the structural actionable-URL signal (a URL must be FETCHED, language-independent)", () => {
    // containsActionableUrl is one of the FEW signals the de-lexicalization explicitly KEPT:
    // a URL is a language-independent structural marker (fetch it, don't ask the user to paste).
    // Regression fence for the deleted keyword URL tests — asserts the STRUCTURAL signal, not
    // the removed sourceSensitive flag.
    const guidance = buildDynamicTurnGuidance("take a look at this and summarize it https://example.com/report", "orchestration_only");
    expect(guidance).not.toBeNull();
    expect(guidance?.prompt).toContain("A URL is present in the request");
  });

  it("treats assistant naming as a durable personality change to persist this turn", () => {
    // Observed live: "dein Name ist ab jetzt Luna" was acknowledged but not
    // stored until the user separately said to remember it. Naming the
    // assistant must trigger assistant_personality_update in the same turn.
    for (const phrase of [
      "Dein Name ist ab jetzt Luna",
      "du heißt jetzt Luna",
      "ich nenne dich Luna",
      "your name is now Luna",
      "I'll call you Luna from now on",
    ]) {
      const guidance = buildDynamicTurnGuidance(phrase, "orchestration_only");
      expect(guidance?.assistantNamingSensitive, `phrase: ${phrase}`).toBe(true);
      expect(guidance?.durableMemorySensitive, `phrase: ${phrase}`).toBe(true);
      expect(guidance?.prompt, `phrase: ${phrase}`).toContain("assistant_personality_update");
      expect(guidance?.prompt, `phrase: ${phrase}`).toContain("Do NOT wait for the user to say 'remember this'");
    }
  });

  it("treats a name QUESTION as fast-lane-eligible, not a durable naming change (audit acdd6cda)", () => {
    // "wie heißt du?" matches the `heißt du` naming pattern but is a QUESTION —
    // no name is being assigned, so it must NOT produce dynamic guidance (which
    // would skip the receptionist fast lane and drag a trivial "what's your name"
    // onto the 27KB full-prompt path → 21.8s). null guidance ⇒ the fast lane
    // handles it from its capsule (which already carries the assistant name).
    for (const phrase of [
      "wie heißt du?",
      "Hi; wie heißt du?",
      "Wie ist dein Name?",
      "what's your name?",
      "heißt du wirklich so?",
      // "du bist"/"bist du" non-naming uses must also stay fast-lane-eligible
      // (the rename booleans are gated by extractAssistantName, which needs a quote).
      "wie bist du drauf?",
      "du bist echt hilfreich",
    ]) {
      expect(buildDynamicTurnGuidance(phrase, "orchestration_only"), `phrase: ${phrase}`).toBeNull();
    }
  });

  it("treats standing preferences as durable memory to persist without an explicit 'remember'", () => {
    for (const phrase of [
      "Ab sofort antworte bitte immer auf Englisch",
      "From now on, keep all summaries under five bullet points",
      "ich bevorzuge kurze Antworten",
    ]) {
      const guidance = buildDynamicTurnGuidance(phrase, "orchestration_only");
      expect(guidance?.durableMemorySensitive, `phrase: ${phrase}`).toBe(true);
      expect(guidance?.assistantNamingSensitive ?? false, `phrase: ${phrase}`).toBe(false);
      expect(guidance?.prompt, `phrase: ${phrase}`).toContain("memory_store");
    }
  });

  it("does not flag ordinary task messages as durable memory", () => {
    for (const phrase of [
      "wie gehts?",
      "Schau mal ob ich neue Emails habe",
      "fix the failing build in ci",
    ]) {
      const guidance = buildDynamicTurnGuidance(phrase, "orchestration_only");
      expect(guidance?.durableMemorySensitive ?? false, `phrase: ${phrase}`).toBe(false);
    }
  });

  it("does not treat self-referential capability questions as freshness-sensitive", () => {
    // Regression: "jetzt" (now) is a weak temporal word. Inside a meta question
    // about the assistant's own skills it must NOT flip freshnessSensitive —
    // doing so forced delegated research and dead-ended the turn into an empty
    // answer ("kannst du jetzt eigene skills erlernen?" → blank reply).
    const guidance = buildDynamicTurnGuidance("kannst du jetzt eigene skills erlernen?", "orchestration_only");
    expect(guidance?.freshnessSensitive ?? false).toBe(false);
  });

  it("does not flag freshness from mid-word substrings like 'know' or 'delivery'", () => {
    // "now" must not match "know"/"known"; "live" must not match "delivery".
    expect(buildDynamicTurnGuidance("do you know how this feature works?", "orchestration_only")?.freshnessSensitive ?? false).toBe(false);
    expect(buildDynamicTurnGuidance("what is the delivery process for our orders?", "orchestration_only")?.freshnessSensitive ?? false).toBe(false);
  });

  it("extracts the assistant name from explicit naming commands (audit b71523fb)", async () => {
    const { extractAssistantName } = await import("../agent/intent-classifier.js");
    expect(extractAssistantName("Ab jetzt heißt du Luna")).toBe("Luna");
    expect(extractAssistantName('Ab jetzt heißt du "Luna"')).toBe("Luna");
    expect(extractAssistantName("du heißt jetzt Luna")).toBe("Luna");
    expect(extractAssistantName("dein Name ist ab jetzt Orion")).toBe("Orion");
    expect(extractAssistantName("your name is now Nova")).toBe("Nova");
    expect(extractAssistantName("I'll call you Sky")).toBe("Sky");
    expect(extractAssistantName("ich nenne dich Pip")).toBe("Pip");
    // "du bist [name]" rename form — QUOTE REQUIRED (audit a6668324:
    // `ab jetzt bist du "Luna"` was acknowledged but never persisted).
    expect(extractAssistantName('ab jetzt bist du "Luna"')).toBe("Luna");
    expect(extractAssistantName('du bist jetzt "Nova"')).toBe("Nova");
    expect(extractAssistantName('Du bist "Orion"')).toBe("Orion");
    // Guards: questions / filler words must NOT be read as a name.
    expect(extractAssistantName("wie heißt du?")).toBeUndefined();
    expect(extractAssistantName("heißt du wirklich so?")).toBeUndefined();
    expect(extractAssistantName("what is your name?")).toBeUndefined();
    // German noun-capitalization trap: an UNQUOTED "du bist X" is NOT a rename
    // (every German noun is capitalized, so capitalization alone can't signal it).
    expect(extractAssistantName("du bist Entwickler")).toBeUndefined();
    expect(extractAssistantName("du bist hilfreich")).toBeUndefined();
    expect(extractAssistantName("wie bist du drauf?")).toBeUndefined();
  });

  it("fires inline-analytical for pasted code with explanation request", () => {
    const guidance = buildDynamicTurnGuidance(`Hier ist mein Python-Skript:\n\n\`\`\`python\ndef process(items):\n    result = []\n    for item in items:\n        if item.value > threshold:\n            result.append(transform(item))\n    return sorted(result, key=lambda x: x.priority)\n\nclass Processor:\n    def __init__(self, config):\n        self.config = config\n\`\`\`\n\nWas macht dieser Code und wie kann ich ihn verbessern?`);

    // De-lexicalized: inlineAnalyticalContent is now pure STRUCTURAL/FORMAT
    // detection (substantial pasted technical content), with no analytical-
    // keyword half and no verification-suppression. A fenced code block with a
    // real body over the length floor trips it regardless of topic/language.
    expect(guidance).not.toBeNull();
    expect(guidance?.inlineAnalyticalContent).toBe(true);
    expect(guidance?.prompt).toContain("pasted substantial technical content");
    expect(guidance?.prompt).toContain("answer directly from it");
  });

  it("does NOT fire inline-analytical for short snippets without analytical request", () => {
    // Short snippet (< 400 chars) — likely a quoted identifier, not pasted state.
    const guidance = buildDynamicTurnGuidance(`The error was: TypeError: cannot read property 'foo' of undefined`);
    expect(guidance?.inlineAnalyticalContent ?? false).toBe(false);
  });

  it("builds an authoritative temporal context prompt for the current turn", () => {
    const prompt = buildTemporalContextPrompt(new Date("2026-03-26T12:00:00.000Z"));

    expect(prompt).toContain("2026-03-26");
    expect(prompt).toContain("Current year: 2026");
    expect(prompt).toContain("never fall back to older model memory");
  });

  it("instructs the model to reply in the user's own language (no German default)", () => {
    // De-lex: the German-default guesser was deleted; language is decided by the LLM from
    // the user's latest message. The per-turn instruction just echoes that rule.
    expect(buildLanguageInstructionForTurn("Can you help me debug this issue?")).toContain("Reply in the same language");
    expect(buildLanguageInstructionForTurn("Kannst du mir beim Debuggen helfen?")).toContain("Reply in the same language");
  });

  it("enforces the documented per-turn cap for orchestration-heavy tools", () => {
    expect(getPerTurnToolCallLimit("delegate_to_agent")).toBe(5);
    expect(getPerTurnToolCallLimit("search_agents")).toBe(4);
    expect(getPerTurnToolCallLimit("create_ephemeral_agent")).toBe(1);
    expect(getPerTurnToolCallLimit("web_search")).toBeUndefined();
  });

  it("builds a terminal response for repeated delegation loops", () => {
    const session = new AgentSession({
      channel: "test",
      workspacePath: "/workspace",
      systemPrompt: "You are a test agent.",
    });

    const response = buildDelegationLoopResponse(
      session,
      "[pentest_coordinator]: Please confirm the authorization reference.",
    );

    expect(response).toContain("Delegation loop detected");
    expect(response).toContain("best grounded result collected so far");
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

  it("classifies partial delegated evidence for synthesis instead of failure", () => {
    const disposition = classifyPostOrchestrationDisposition([
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [
          "Delegated result from computer_use_agent — PARTIAL PROGRESS.",
          "Observed evidence:",
          "Sub-agent 'computer_use_agent' timed out after 1000ms",
          "Partial progress before interruption:",
          "- Tool calls executed: 3 (computer_list_nodes, computer_session_start, computer_snapshot)",
        ].join("\n"),
        metadata: {
          agentName: "computer_use_agent",
          delegationSucceeded: true,
          delegationOutcome: "partial",
          terminalState: "timeout",
        },
      },
    ]);

    expect(disposition).toBe("synthesize");
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

  it("marks placeholder no-response delegated evidence as failed for synthesis", () => {
    const result = buildModelVisibleToolResult(
      "delegate_to_agent",
      "Sub-agent produced no final response.",
      {
        agentName: "researcher",
        attemptedAgents: ["swarm_maintainer", "researcher"],
        delegationSucceeded: true,
        routingReason: { confidence: "medium" },
      },
    );

    expect(result).toContain("Delegated result from researcher — TASK FAILED.");
    expect(result).toContain("Sub-agent produced no final response.");
    expect(result).not.toContain("TASK COMPLETED");
  });

  it("marks delegated container errors as failed instead of completed", () => {
    const result = buildModelVisibleToolResult(
      "delegate_to_agent",
      "Sub-agent 'coder' container error: unknown",
      {
        agentName: "coder",
        attemptedAgents: ["coder"],
        delegationSucceeded: true,
        delegationOutcome: "success",
        terminalState: "completed",
      },
    );

    expect(result).toContain("Delegated result from coder — TASK FAILED.");
    expect(result).toContain("container error: unknown");
    expect(result).not.toContain("TASK COMPLETED");
  });

  it("classifies delegated container errors as failures for post-orchestration handling", () => {
    const disposition = classifyPostOrchestrationDisposition([
      {
        role: "tool",
        tool_call_id: "call_container_failure",
        content: [
          "Delegated result from coder — TASK FAILED.",
          "Observed evidence:",
          "Sub-agent 'coder' container error: unknown",
        ].join("\n"),
        metadata: {
          agentName: "coder",
          delegationSucceeded: true,
          delegationOutcome: "success",
          terminalState: "completed",
        },
      },
    ]);

    expect(disposition).toBe("failure");
  });

  it("classifies a fully executed workflow as synthesize even though the preamble says 'incomplete' (audit 802d4791)", () => {
    // The completed-workflow instruction preamble contains "marks as incomplete",
    // which the failure-keyword sniff used to read as failure evidence — branding
    // a 100% successful sourced_presentation run "[DELEGATION FAILED]" and
    // triggering a full duplicate re-run of the 10-minute job.
    const disposition = classifyPostOrchestrationDisposition([
      {
        role: "tool",
        tool_call_id: "call_workflow_ok",
        content: [
          "Workflow sourced_presentation [job] completed. Executed steps: 4/4.",
          "IMPORTANT: The workflow's deliverables were SAVED AS FILES and are attached to this message — do NOT paste their contents into your answer. Write a SHORT final summary in the user's language: state what was completed, list EVERY artifact path below with a one-line description, and note anything the evidence marks as incomplete. Do NOT start fresh ad hoc delegation or rerun research for the same request.",
          "Artifact files (already attached):",
          "- generated/presentation/paper.md",
          "- generated/presentation/notes.md",
          "Observed evidence:",
          "Workflow sourced_presentation [job] completed.",
          "Forschungsergebnisse: Dresdner Architektur und der Zwinger — verifizierte Fakten und Quellen.",
        ].join("\n"),
        metadata: {
          workflowName: "sourced_presentation",
          workflowType: "job",
          blocked: false,
          stepCount: 4,
          executedSteps: 4,
          artifacts: [
            { outputPath: "generated/presentation/paper.md" },
            { outputPath: "generated/presentation/notes.md" },
          ],
        },
      },
    ]);

    expect(disposition).toBe("synthesize");
  });

  it("classifies a blocked workflow as failure", () => {
    const disposition = classifyPostOrchestrationDisposition([
      {
        role: "tool",
        tool_call_id: "call_workflow_blocked",
        content: [
          "Workflow sourced_presentation [job] blocked. Executed steps: 1/4.",
          "IMPORTANT: This workflow did not complete. Treat the evidence below as a failure report, not as completed research.",
          "Observed evidence:",
          "Step 2 was blocked by a guardrail.",
        ].join("\n"),
        metadata: {
          workflowName: "sourced_presentation",
          workflowType: "job",
          blocked: true,
          stepCount: 4,
          executedSteps: 1,
          artifacts: [],
        },
      },
    ]);

    expect(disposition).toBe("failure");
  });

  it("still classifies a partially executed workflow with failing evidence as failure", () => {
    const disposition = classifyPostOrchestrationDisposition([
      {
        role: "tool",
        tool_call_id: "call_workflow_partial",
        content: [
          "Workflow sourced_presentation [job] completed. Executed steps: 2/4.",
          "Observed evidence:",
          "Sub-agent 'researcher' timed out after 240000ms",
        ].join("\n"),
        metadata: {
          workflowName: "sourced_presentation",
          workflowType: "job",
          blocked: false,
          stepCount: 4,
          executedSteps: 2,
          artifacts: [],
        },
      },
    ]);

    expect(disposition).toBe("failure");
  });

  it("reroutes partial delegated results that only echo a provider HTTP error to the failure branch", () => {
    const result = buildModelVisibleToolResult(
      "delegate_to_agent",
      [
        "Sub-agent error: Error: OpenAI-compatible request failed (model: qwen3.6-35b-a3b): 500 <!DOCTYPE html>",
        "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Error</title></head><body><pre>Internal Server Error</pre></body></html>",
      ].join(" "),
      {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        delegationOutcome: "partial",
        terminalState: "completed",
      },
    );

    expect(result).toContain("Delegated result from mission_coordinator — TASK FAILED.");
    expect(result).not.toContain("TASK COMPLETED");
    expect(result).not.toContain("PARTIAL");
  });

  it("reroutes task-title-only partials with provider errors to failure instead of synthesis", () => {
    const result = buildModelVisibleToolResult(
      "delegate_to_agent",
      [
        "Sub-agent 'mission_coordinator' produced no final response after substantive work.",
        "Partial progress before interruption:",
        "- parallel_1 [partial] Gather current external source evidence for the requested multi-section report.",
        "",
        "Sub-agent error: Error: OpenAI-compatible request failed (model: qwen3.6-35b-a3b): 500 <!DOCTYPE html>",
        "<html lang=\"en\"><head><title>Error</title></head><body><pre>Internal Server Error</pre></body></html>",
      ].join("\n"),
      {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        delegationOutcome: "partial",
        terminalState: "completed",
      },
    );

    expect(result).toContain("Delegated result from mission_coordinator — TASK FAILED.");
    expect(result).not.toContain("TASK COMPLETED (PARTIAL");

    const disposition = classifyPostOrchestrationDisposition([
      {
        role: "tool",
        tool_call_id: "call_provider_scaffold_partial",
        content: result,
        metadata: {
          agentName: "mission_coordinator",
          delegationSucceeded: true,
          delegationOutcome: "partial",
          terminalState: "completed",
        },
      },
    ]);
    expect(disposition).toBe("failure");
  });

  it("reroutes discovery-only timed-out partial delegations to failure instead of synthesis", () => {
    const result = buildModelVisibleToolResult(
      "delegate_to_agent",
      [
        "Sub-agent 'mission_coordinator' timed out after 300000ms",
        "Partial progress before interruption:",
        "- search_workflows [partial] No workflows matched \"multi-section sourced report evidence merge draft review\" strongly enough. Fall back to search_agents or direct coordinator planning for this request shape.",
        "- search_agents [partial] No agents matched \"research report documentation source evidence validation\" (also tried shortened query \"research report documentation\" — also 0 matches). Do not call search_agents again for this turn.",
      ].join("\n"),
      {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        delegationOutcome: "partial",
        terminalState: "timeout",
      },
    );

    expect(result).toContain("Delegated result from mission_coordinator — TASK FAILED.");
    expect(result).not.toContain("TASK COMPLETED (PARTIAL");
  });

  it("reroutes duplicate in-flight delegation status to failure instead of synthesis", () => {
    const result = buildModelVisibleToolResult(
      "delegate_to_agent",
      "The user's original request below is the only canon...' is already running via mission_coordinator.",
      {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        delegationOutcome: "partial",
        terminalState: "completed",
        inFlight: true,
        reused: true,
      },
    );

    expect(result).toContain("Delegated result from mission_coordinator — TASK FAILED.");
    expect(result).toContain("already running via mission_coordinator");
    expect(result).not.toContain("PARTIAL PROGRESS");
    expect(result).not.toContain("grounded evidence");

    const disposition = classifyPostOrchestrationDisposition([
      {
        role: "tool",
        tool_call_id: "call_duplicate_running_partial",
        content: result,
        metadata: {
          agentName: "mission_coordinator",
          delegationSucceeded: true,
          delegationOutcome: "partial",
          terminalState: "completed",
          inFlight: true,
        },
      },
    ]);
    expect(disposition).toBe("failure");
  });

  it("does not treat nested timed-out sub-agent task descriptions as usable partial evidence", () => {
    const result = buildModelVisibleToolResult(
      "delegate_to_agent",
      [
        "Sub-agent 'mission_coordinator' timed out after 300000ms",
        "Partial progress before interruption:",
        "- parallel_1 [partial] Research exact source evidence for component ZX-9000 via researcher | Sub-agent 'researcher' produced no final response after substantive work. Partial progress before interruption: - parallel_1 [partial] Research component ZX-9000 as VendorX USB-C-only hardware with 5000mAh battery requirements",
        "- Tool calls executed: 3",
        "- Iterations completed: 4",
      ].join("\n"),
      {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        delegationOutcome: "partial",
        terminalState: "timeout",
      },
    );

    expect(result).toContain("Delegated result from mission_coordinator — TASK FAILED.");
    expect(result).not.toContain("PARTIAL PROGRESS");
    expect(result).not.toContain("TASK COMPLETED");

    const disposition = classifyPostOrchestrationDisposition([
      {
        role: "tool",
        tool_call_id: "call_nested_scaffold_partial",
        content: result,
        metadata: {
          agentName: "mission_coordinator",
          delegationSucceeded: true,
          delegationOutcome: "partial",
          terminalState: "timeout",
        },
      },
    ]);
    expect(disposition).toBe("failure");
  });

  it("classifies discovery-only timed-out partial delegations as failures", () => {
    const disposition = classifyPostOrchestrationDisposition([
      {
        role: "tool",
        tool_call_id: "call_discovery_only_partial",
        content: [
          "Delegated result from mission_coordinator — TASK FAILED.",
          "Observed evidence:",
          "Sub-agent 'mission_coordinator' timed out after 300000ms",
          "Partial progress before interruption:",
          "- search_workflows [partial] No workflows matched \"multi-section sourced report evidence merge draft review\" strongly enough. Fall back to search_agents or direct coordinator planning for this request shape.",
          "- search_agents [partial] No agents matched \"research report documentation source evidence validation\" (also tried shortened query \"research report documentation\" — also 0 matches). Do not call search_agents again for this turn.",
        ].join("\n"),
        metadata: {
          agentName: "mission_coordinator",
          delegationSucceeded: true,
          delegationOutcome: "partial",
          terminalState: "timeout",
        },
      },
    ]);

    expect(disposition).toBe("failure");
  });

  it("passes long delegated deliverables verbatim instead of truncating to 1600 chars", () => {
    const paperBody = [
      "# KI-Protokolle: MCP, A2A und AG-UI im Vergleich",
      "",
      "## 1. Einleitung",
      "placeholder section ".repeat(40),
      "",
      "## 2. MCP (Model Context Protocol)",
      "Anthropic-Standard für KI-Tool-Integration. ".repeat(40),
      "",
      "## 3. A2A (Agent-to-Agent)",
      "Google-Protokoll für Agentenkommunikation. ".repeat(40),
      "",
      "## 4. AG-UI",
      "Frontend-Streaming-Standard für KI-Agenten. ".repeat(40),
      "",
      "## 5. Fazit",
      "Vergleich der drei führenden KI-Protokolle. ".repeat(20),
    ].join("\n");
    // Wrap as run_workflow output, as produced by the workflow tool
    const workflowOutput = `Workflow protocol_comparison_paper [scene] completed via mission_coordinator bootstrap.\n\n${paperBody}`;

    const result = buildModelVisibleToolResult(
      "delegate_to_agent",
      workflowOutput,
      {
        agentName: "mission_coordinator",
        attemptedAgents: ["mission_coordinator"],
        delegationSucceeded: true,
        delegationOutcome: "success",
        terminalState: "completed",
      },
    );

    expect(result).toContain("Delegated result from mission_coordinator — TASK COMPLETED.");
    expect(result).toContain("VERBATIM");
    expect(result).not.toContain("Do NOT paraphrase with different numbers or names.");
    // Workflow preamble stripped
    expect(result).not.toContain("Workflow protocol_comparison_paper [scene] completed");
    // Paper body present in full (key sections not truncated)
    expect(result).toContain("## 1. Einleitung");
    expect(result).toContain("## 5. Fazit");
    // Not truncated at 1600 chars — should be much longer
    const evidenceStart = result.indexOf("Observed evidence:\n");
    const evidenceContent = result.slice(evidenceStart + "Observed evidence:\n".length);
    expect(evidenceContent.length).toBeGreaterThan(2500);
  });

  // Regression (audit b5107ae4): a runtime-authored research slice returns
  // EVIDENCE, never the user-facing deliverable. The VERBATIM instruction made
  // the orchestrator paste a TP4056 component spec dump as the entire answer
  // to a device DESIGN request — and the single-deliverable relay shortcut
  // (which keys on the VERBATIM string) skipped synthesis completely.
  it("instructs synthesis instead of verbatim relay for research-slice results", () => {
    const longResearchReport = [
      "## TP4056 Li-Ion Battery Charger IC — Complete Confirmed Specifications",
      "- Float voltage: 4.2 V ±1.5% (Source: https://example.com/tp4056)",
      "- Input range: 4.5–5.5 V (Source: https://example.com/tp4056)",
      "Details und Quellenlage. ".repeat(150),
    ].join("\n");

    const result = buildModelVisibleToolResult(
      "delegate_to_agent",
      longResearchReport,
      {
        agentName: "researcher",
        attemptedAgents: ["researcher"],
        delegationSucceeded: true,
        delegationOutcome: "success",
        terminalState: "completed",
        researchSlice: true,
      },
    );

    expect(result).toContain("Delegated result from researcher — TASK COMPLETED.");
    expect(result).not.toContain("VERBATIM");
    expect(result).toContain("research EVIDENCE, not the final deliverable");
    expect(result).toContain("user's ORIGINAL request");
    // Full evidence still passed through for synthesis (not 1600-char truncated)
    const evidenceStart = result.indexOf("Observed evidence:\n");
    const evidenceContent = result.slice(evidenceStart + "Observed evidence:\n".length);
    expect(evidenceContent.length).toBeGreaterThan(2500);
  });

  it("treats blocked workflow evidence as failed research rather than completed drafting input", () => {
    const result = buildModelVisibleToolResult(
      "run_workflow",
      "Workflow deep_research_dossier [scene] blocked via mission_coordinator bootstrap.\n\nAll candidate agents failed for task 'Decide whether the request needs independent source gathering'.\nSub-agent produced no final response.",
      {
        workflowName: "deep_research_dossier",
        workflowType: "scene",
        blocked: true,
        stepCount: 1,
        executedSteps: 1,
        bootstrapAgent: "mission_coordinator",
      },
    );

    expect(result).toContain("Workflow deep_research_dossier [scene] blocked.");
    expect(result).toContain("did not complete");
    expect(result).toContain("Do NOT jump straight to drafting-only agents like paper_author or summarizer");
    expect(result).toContain("Sub-agent produced no final response.");
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

  it("marks failed ephemeral-agent results as failed instead of completed", () => {
    const result = buildModelVisibleToolResult(
      "create_ephemeral_agent",
      "Sub-agent 'ephemeral:blog_writer' timed out after 60000ms",
      {
        agentName: "ephemeral:blog_writer",
      },
    );

    expect(result).toContain("Ephemeral agent ephemeral:blog_writer failed.");
    expect(result).toContain("Do NOT claim the task was completed or delegated successfully.");
    expect(result).toContain("timed out after 60000ms");
    expect(result).not.toContain("completed.");
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

  it("classifies consecutive delegation failures so the warden escalation can trigger", () => {
    // Both calls must return "failure" so the _consecutiveDelegationFailures counter
    // can reach 2 inside _runTurn() and inject the WARDEN STOP message.
    const failureResult = [
      {
        role: "tool" as const,
        tool_call_id: "call_f1",
        content: "Delegated result from researcher — TASK FAILED.\nObserved evidence:\nAll candidate agents failed.",
        metadata: {
          agentName: "researcher",
          delegationSucceeded: false,
          delegationOutcome: "failure",
          terminalState: "completed",
        },
      },
    ];

    const d1 = classifyPostOrchestrationDisposition(failureResult);
    const d2 = classifyPostOrchestrationDisposition(failureResult);
    expect(d1).toBe("failure");
    expect(d2).toBe("failure");
  });
});

describe("buildModelVisibleToolResult — execute_plan", () => {
  // What the tool RETURNS is not what the model sees. Without a branch, execute_plan's report fell
  // through to the 600-char fallback, which also collapses newlines: the orchestrator got the
  // roll-call plus a fragment of the first step and was told to write the answer from results it
  // could not see. A direct or reuse step's output has no other channel — those run as nested calls
  // inside the tool and never become tool messages of their own.
  const report = [
    "Plan: 2/2 step(s) completed.",
    "COMPLETED:\n  - s1 (direct) look up the prices\n  - s2 (delegate) write it up",
    `RESULTS — write the final answer from these:\n\n[s1] look up the prices\n${"PRICE ".repeat(200)}\n\n[s2] write it up\n${"DRAFT ".repeat(200)}`,
    "Every step has run. Synthesize the final answer from the results above, against the acceptance criteria.",
  ].join("\n\n");

  it("keeps both steps' results and the closing instruction", () => {
    const visible = buildModelVisibleToolResult("execute_plan", report, { planExecution: true });
    expect(visible).toContain("PRICE");
    expect(visible).toContain("DRAFT");
    expect(visible).toContain("Synthesize the final answer");
    expect(visible).toContain("\n");          // the fallback collapses every newline
  });
});

describe("collapsed history — what the answer-writing iteration can still see", () => {
  // The prompt for the iteration that writes the answer is built from getCollapsedHistory(), which
  // replaces each tool result with a snippet. At the default 500 chars execute_plan's report lost
  // every step's evidence AND the instruction to synthesize from it — so fixing the model-visible
  // formatting alone changed nothing for the iteration that actually matters.
  it("keeps a plan's report long enough to answer from", async () => {
    const { AgentSession } = await import("../agent/session.js");
    const session = new AgentSession({ sessionId: "collapsed-history-test", channel: "test" });
    const report = `Plan: 2/2 step(s) completed.\n\nRESULTS — write the final answer from these:\n\n[s1] ${"PRICE ".repeat(300)}\n\n[s2] ${"DRAFT ".repeat(300)}\n\nEvery step has run. Synthesize the final answer from the results above.`;
    session.addMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "execute_plan", arguments: "{}" } }],
    } as never);
    session.addMessage({ role: "tool", tool_call_id: "c1", content: report } as never);

    const collapsed = JSON.stringify(session.getCollapsedHistory());
    expect(collapsed).toContain("DRAFT");                        // the LAST step's evidence
    expect(collapsed).toContain("Synthesize the final answer");  // and the instruction
  });
});

describe("classifyPostOrchestrationDisposition — a plan that executed", () => {
  // execute_plan dispatches the delegations and workflows whose result shapes this classifier
  // recognizes, one level down, so its OWN result carries none of their markers. Unrecognized, an
  // iteration whose only call was execute_plan classified as "none" — skipping the entire
  // post-orchestration block, including the plan-driven continuation written for that very path.
  const planResult = (metadata: Record<string, unknown>) => ([{
    role: "tool" as const,
    content: "Plan: 2/2 step(s) completed.",
    tool_call_id: "t1",
    metadata: { planExecution: true, ...metadata },
  }]);

  it("is orchestration, not nothing", () => {
    expect(classifyPostOrchestrationDisposition(planResult({ failed: 0, manual: 0, pending: 0 })))
      .toBe("synthesize");
  });

  it("is a failure when a step failed, so the honesty backstop arms", () => {
    expect(classifyPostOrchestrationDisposition(planResult({ failed: 1, manual: 0, pending: 0 })))
      .toBe("failure");
  });

  it("is not hijacked by a step result that happens to say \"please confirm\"", () => {
    // The report embeds every step's output verbatim, and the ask_user cue is a text sniff over the
    // whole tool result — so a researcher writing "please confirm the figures with the vendor" would
    // have turned the entire turn into a clarification request. A genuine mid-plan question blocks
    // in the ask_user tool itself.
    const withCue = [{
      role: "tool" as const,
      content: `Plan: 1/1 step(s) completed.

RESULTS:
[s1] Which one did you mean? Please confirm.`,
      tool_call_id: "t1",
      metadata: { planExecution: true, failed: 0, manual: 0, pending: 0 },
    }];
    expect(classifyPostOrchestrationDisposition(withCue)).toBe("synthesize");
  });

  it("continues while the orchestrator still owes a step", () => {
    expect(classifyPostOrchestrationDisposition(planResult({ failed: 0, manual: 1, pending: 1 })))
      .toBe("continue");
  });
});
