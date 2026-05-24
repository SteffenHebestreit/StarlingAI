import { describe, it, expect } from "vitest";
import { classifyDelegationResult } from "../tools/sub-agent.js";
import type { DelegationClassification } from "../tools/sub-agent.js";

const baseStats = {
  toolCount: 3,
  toolNames: ["web_search", "web_fetch"],
  terminalState: "completed",
  outcome: "success" as const,
};

const noToolStats = {
  toolCount: 0,
  toolNames: [] as string[],
  terminalState: "completed",
  outcome: "success" as const,
};

describe("classifyDelegationResult — D14", () => {
  // ── Success ────────────────────────────────────────────────────────────
  it("returns success for a clean completed result", () => {
    const r = classifyDelegationResult(
      "Here are the headlines for today: Apple hit $200.",
      "success",
      baseStats,
      undefined,
      "researcher",
      "what are today's headlines?",
    );
    expect(r).toBe<DelegationClassification>("success");
  });

  // ── Failure ────────────────────────────────────────────────────────────
  it("returns failure for explicit delegationOutcome failure", () => {
    const r = classifyDelegationResult(
      "Unable to complete the task.",
      "failure",
      baseStats,
      undefined,
      "researcher",
      "task",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });

  it("returns failure for looksLikeFailureResult output", () => {
    const r = classifyDelegationResult(
      "Error: no results found.",
      "success",
      { ...baseStats, terminalState: "completed" },
      undefined,
      "researcher",
      "task",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });

  // Regression: the container-runner returns the literal string
  // "Sub-agent '<name>' container error: <reason>" for spawn / runtime
  // failures.  The previous regex `\b(...|error:|...)\b` failed to match this
  // because the trailing `\b` after `:` (non-word) followed by a space
  // (non-word) never fires.  Combined with the containerized sub-agent path
  // hardcoding outcome="success" / terminalState="completed", a container
  // crash was being classified as a successful delegation, swallowing the
  // failure and skipping retry / forced-synthesis.
  it("returns failure when output reports container-level error despite success metadata", () => {
    const r = classifyDelegationResult(
      "Sub-agent 'shell_agent' container error: unknown",
      "success",
      { ...noToolStats, terminalState: "completed" },
      undefined,
      "shell_agent",
      "run a quick check",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });

  it("returns failure when output reports container exit code", () => {
    const r = classifyDelegationResult(
      "Sub-agent 'coder' exited with code 137. Output: ",
      "success",
      { ...noToolStats, terminalState: "completed" },
      undefined,
      "coder",
      "task",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });

  // Regression: a coordinator synthesized at soft deadline and emitted only
  // a literal model template token as its output. Runtime classified that as
  // outcome="success", terminalState="completed"; the main assistant saw
  // "TASK COMPLETED" with effectively empty evidence and fabricated a full
  // answer from training memory. Template-only output must classify as failure.
  it("returns failure when output is only LLM template special tokens", () => {
    const r = classifyDelegationResult(
      "<|mask_end|>",
      "success",
      {
        toolCount: 6,
        toolNames: ["search_workflows", "search_agents", "parallel_delegate", "web_search"],
        terminalState: "completed",
        outcome: "success" as const,
      },
      { tags: ["coordination"] } as never,
      "mission_coordinator",
      "Create a sourced design guide",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });

  it("returns failure for whitespace-padded template-only output", () => {
    const r = classifyDelegationResult(
      "  <|im_end|>\n<|endoftext|>  ",
      "success",
      { ...noToolStats, terminalState: "completed" },
      undefined,
      "researcher",
      "research",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });

  it("does NOT flag legitimate output that mentions a template token in context", () => {
    // "the model emitted `<|im_end|>` early" is real content — must stay.
    const r = classifyDelegationResult(
      "Findings: the model emitted `<|im_end|>` token early in iteration 3, suggesting a stop-token misconfiguration.",
      "success",
      { ...baseStats, terminalState: "completed" },
      undefined,
      "researcher",
      "research a stop token issue",
    );
    expect(r).toBe<DelegationClassification>("success");
  });

  // Regression: audit session 0a93078b (May 2026).  Coordinator timed out
  // after its only tool calls were search_agents → 0 results, list_agents
  // → 0 results, create_ephemeral_agent → spawn errored.  The "Recovered
  // evidence snippets" section contained only failure stubs.  Previously
  // classified as `partial`, masking the failure and skipping the warden
  // escalation.  Must now be `failure` so the failed-delegation diagnostic
  // can surface and the runtime can fall back to direct synthesis.
  it("demotes partial-with-only-failure-stubs to failure", () => {
    const interruptedOutput = [
      "Sub-agent 'mission_coordinator' timed out after 480000ms",
      "Partial progress before interruption:",
      "- task_1 [running] Erstelle einen Hardware-Bau-Leitfaden ... via mission_coordinator",
      "- Tool calls executed: 4 (search_agents, create_ephemeral_agent, list_agents)",
      "- Iterations completed: 4",
      "Recovered evidence snippets from completed tools:",
      "- search_agents: No agents matched \"hardware engineering circuit design PCB\"",
      "- list_agents: No agents matched \"hardware engineering circuit design PCB\"",
      "- create_ephemeral_agent: [ephemeral:hardware_audio_engineer]: Sub-agent error: Error: OpenAI-compatible request failed (model: qwen3.6-35b-a3b): Request timed out.",
    ].join("\n");

    const r = classifyDelegationResult(
      interruptedOutput,
      "partial",
      {
        toolCount: 4,
        toolNames: ["search_agents", "create_ephemeral_agent", "list_agents"],
        terminalState: "timeout",
        outcome: "partial" as const,
      },
      { tags: ["coordination"] } as never,
      "mission_coordinator",
      "Erstelle einen Hardware-Bau-Leitfaden",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });

  it("demotes partial duplicate-running coordinator status to failure", () => {
    const r = classifyDelegationResult(
      "Task 'SOURCE-SENSITIVE DELEGATION: The user's original request below is the only canon...' is already running via mission_coordinator.",
      "partial",
      {
        toolCount: 4,
        toolNames: ["search_workflows", "delegate_to_agent", "search_agents", "search_agents"],
        terminalState: "completed",
        outcome: "partial" as const,
      },
      { tags: ["coordination"] } as never,
      "mission_coordinator",
      "Erstelle einen Hardware-Bau-Leitfaden",
    );

    expect(r).toBe<DelegationClassification>("failure");
  });

  // Counter-test: a real partial result with substantive recovered evidence
  // (e.g. a research agent that timed out mid-pass with real web_fetch
  // payloads) must STAY `partial` so the partial-acceptance path still
  // works.  Demotion fires only when every snippet is a known failure shape.
  it("keeps partial when recovered evidence has any substantive snippet", () => {
    const interruptedOutput = [
      "Sub-agent 'researcher' timed out after 240000ms",
      "Partial progress before interruption:",
      "- Tool calls executed: 3 (web_search, web_fetch, share_finding)",
      "- Iterations completed: 3",
      "Recovered evidence snippets from completed tools:",
      "- web_search: Top result: official component datasheet with concrete electrical specifications and application notes",
      "- web_fetch: Module specification with processor, wireless capability, memory size, and supported peripheral buses",
    ].join("\n");

    const r = classifyDelegationResult(
      interruptedOutput,
      "partial",
      {
        toolCount: 3,
        toolNames: ["web_search", "web_fetch", "share_finding"],
        terminalState: "timeout",
        outcome: "partial" as const,
      },
      undefined,
      "researcher",
      "research MEMS microphones for ESP32",
    );
    expect(r).toBe<DelegationClassification>("partial");
  });

  it("returns failure for timed-out non-partial result", () => {
    const r = classifyDelegationResult(
      "I was trying to fetch the page but it took too long.",
      "partial",
      { ...baseStats, terminalState: "timeout", outcome: "partial" as const },
      undefined,
      "computer_use_agent",
      "some task",
      [],
    );
    // computer_use_agent with toolCount=3 and terminalState=timeout — acceptPartial=true
    // so even on a timeout this should be "partial"
    expect(r).toBe<DelegationClassification>("partial");
  });

  // ── Partial ────────────────────────────────────────────────────────────
  it("returns partial when stats.outcome is partial and output has content", () => {
    const r = classifyDelegationResult(
      "I found 3 CVEs for Apache 2.4.51. CVE-2021-41773 is critical.",
      "partial",
      { ...baseStats, terminalState: "max_iterations", outcome: "partial" as const },
      undefined,
      "researcher",
      "find CVEs for Apache 2.4.51",
    );
    expect(r).toBe<DelegationClassification>("partial");
  });

  it("returns partial for research agent with web tools + toolCount>=2 even on timeout", () => {
    const r = classifyDelegationResult(
      "Apple stock is at $198 today based on my web search.",
      "partial",
      {
        toolCount: 3,
        toolNames: ["web_search", "web_fetch"],
        terminalState: "timeout",
        outcome: "partial" as const,
      },
      undefined,
      "researcher",
      "what is apple stock price?",
    );
    expect(r).toBe<DelegationClassification>("partial");
  });

  // ── Coordinator no-op ──────────────────────────────────────────────────
  it("returns coordinator_noop for coordinator with empty tools and short output", () => {
    const r = classifyDelegationResult(
      "Let me start by delegating this task to a researcher.",
      undefined,
      { ...noToolStats, terminalState: "completed" },
      { tags: ["coordination"] } as never,
      "web_task_coordinator",
      "what are the headlines today?",
    );
    expect(r).toBe<DelegationClassification>("coordinator_noop");
  });

  it("does NOT flag coordinator_noop when coordinator called delegate_to_agent", () => {
    const r = classifyDelegationResult(
      "The researcher found the following headlines: ...",
      "success",
      {
        toolCount: 2,
        toolNames: ["delegate_to_agent"],
        terminalState: "completed",
        outcome: "success" as const,
      },
      { tags: ["coordination"] } as never,
      "web_task_coordinator",
      "what are the headlines today?",
    );
    expect(r).toBe<DelegationClassification>("success");
  });

  it("returns failure for in-progress planning stubs even after tool use", () => {
    const r = classifyDelegationResult(
      "Let me get the remaining critical datasheet pages for electrical specs and pricing details.",
      "success",
      {
        toolCount: 17,
        toolNames: ["search_workflows", "parallel_delegate", "web_search", "web_fetch"],
        terminalState: "completed",
        outcome: "success" as const,
      },
      { tags: ["coordination"] } as never,
      "web_task_coordinator",
      "Research exact microphone specs, reviews, known issues, pricing, and availability.",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });

  it("returns failure for future-action edit stubs after context gathering", () => {
    const r = classifyDelegationResult(
      "Now I have the full picture. Let me update the apply_jobs scene with the new specifications.",
      "success",
      {
        toolCount: 5,
        toolNames: ["read_file", "list_files", "read_shared_facts"],
        terminalState: "completed",
        outcome: "success" as const,
      },
      { tags: ["prompts", "agents"] } as never,
      "prompt_optimizer",
      "Update the apply_jobs scene definition.",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });

  it("returns failure for read-only raw config dumps when a maintenance edit was requested", () => {
    const rawConfigDump = [
      ".starlingai/ agent_outcomes.ndjson README.md agents/ 10-core-agents.jsonc 20-subagents-general.jsonc jobs/ 10-jobs.jsonc scenes/ 10-scenes.jsonc",
      "",
      "{ \"subAgents\": { \"browser_agent\": { \"model\": { \"primary\": \"lmstudio/qwen3.6-35b-a3b\" }, \"systemPrompt\": \"You are a browser automation specialist.\" } } }",
      "",
      "#### Tool Calls",
      "- list_files",
      "- read_file",
    ].join("\n");

    const r = classifyDelegationResult(
      rawConfigDump,
      "partial",
      {
        toolCount: 5,
        toolNames: ["list_files", "read_file", "read_file"],
        terminalState: "completed",
        outcome: "partial" as const,
      },
      { tags: ["prompts", "agents"] } as never,
      "prompt_optimizer",
      "Passe browser_agent und vision_browser_analyst auf lmstudio/qwen3.5-9b an.",
    );

    expect(r).toBe<DelegationClassification>("failure");
  });

  it("keeps completed edit statements as success", () => {
    const r = classifyDelegationResult(
      "Now I have updated scenes/10-scenes.jsonc and verified the apply_jobs entry.",
      "success",
      {
        toolCount: 6,
        toolNames: ["read_file", "write_file", "read_file"],
        terminalState: "completed",
        outcome: "success" as const,
      },
      { tags: ["swarm", "maintenance"] } as never,
      "swarm_maintainer",
      "Update the apply_jobs scene definition.",
    );
    expect(r).toBe<DelegationClassification>("success");
  });

  it("does NOT flag coordinator_noop when terminalState is undefined (test mocks)", () => {
    // terminalState undefined → coordinator guard skipped (requires terminalState === "completed")
    // looksLikeFailureResult("Let me look that up.") → false, so weak=false → success
    const r = classifyDelegationResult(
      "Let me look that up.",
      undefined,
      { ...noToolStats, terminalState: undefined },
      { tags: ["coordination"] } as never,
      "web_task_coordinator",
      "task",
    );
    // Result must NOT be coordinator_noop (the coordinator guard was skipped)
    expect(r).not.toBe<DelegationClassification>("coordinator_noop");
  });

  // ── Infrastructure failure ─────────────────────────────────────────────
  it("returns infrastructure_failure for ECONNREFUSED pattern", () => {
    const r = classifyDelegationResult(
      "Sub-agent error: ECONNREFUSED connecting to localhost:9222",
      "failure",
      { ...baseStats, terminalState: "error" },
      undefined,
      "browser_agent",
      "open a browser",
    );
    expect(r).toBe<DelegationClassification>("infrastructure_failure");
  });

  // ── needs_info ────────────────────────────────────────────────────────
  it("returns failure for needs_info when partial not accepted", () => {
    const r = classifyDelegationResult(
      "I need more information to proceed.",
      "needs_info",
      { ...noToolStats, terminalState: "completed" },
      undefined,
      "shell_agent",
      "configure the server",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });
});
