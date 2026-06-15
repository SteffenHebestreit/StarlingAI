import { describe, it, expect } from "vitest";
import { classifyDelegationResult, isNarrativeOnlyDeliverableFailure } from "../tools/sub-agent.js";
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

  it("returns coordinator_noop for a LONG zero-tool refusal (audit 3a0fd176)", () => {
    // web_task_coordinator wrote a 767-char "I have no web tools, but here are
    // some news sites" answer with zero tool calls. The old <80-char guard let
    // it pass as success so the researcher fallback never ran. Zero tool calls
    // is the structural tell regardless of output length.
    const longRefusal =
      "Ich kann keine aktuellen Nachrichten von heute abrufen, da ich über keine Tools für " +
      "Live-News-Recherchen verfüge. Meine Fähigkeiten beschränken sich auf Browser-Automatisierung, " +
      "Code-Ausführung und Datenanalyse — nicht auf News-Suche oder -Aggregation. Was stattdessen " +
      "möglich wäre: Wenn Sie eine spezifische Nachrichten-URL haben, kann ich die Seite mit Playwright " +
      "rendern und den Inhalt extrahieren. Ich kann Ihnen empfehlen, direkt auf Nachrichtenportalen wie " +
      "tagesschau.de, heise.de, Handelsblatt oder Reuters nachzuschauen.";
    const r = classifyDelegationResult(
      longRefusal,
      "success",
      { ...noToolStats, terminalState: "completed" },
      { tags: ["coordination"] } as never,
      "web_task_coordinator",
      "kannst du mir die aktuellen news von heute zusammenfassen?",
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

  // Regression: session c903b401 (2026-05-28) showed the worst variant of
  // the planning-but-never-execute failure: the model opened its message
  // with a NON-planning sentence ("This is a substantial multi-section
  // deliverable...") and only THEN said "Let me build this..." — the
  // anchored opener regex missed it entirely, classification returned
  // "success", and the orchestrator hallucinated that the website file had
  // been created. The fix doesn't rely on language patterns at all: when
  // the agent had artifact-producing tools (write_file / generate_*) AND
  // the task asks for a deliverable AND the agent didn't call any of them
  // (or delegate, for coordinator-shaped agents), it's a failure.
  it("returns failure when an agent with artifact tools narrates without producing", () => {
    // The output opens with a NON-planning sentence ("This is a substantial…")
    // so the language-pattern detector misses it. Only the tool-usage based
    // detector can fire here: the agent had write_file + generate_document
    // available, called only context tools, and didn't delegate.
    const mockCoordinatorOutput =
      "This is a substantial multi-section deliverable (full interactive learning website with 5 major topic areas, quiz functionality, dark/light mode, search, progress tracking). Let me build this as a complete single-file HTML application.";
    const r = classifyDelegationResult(
      mockCoordinatorOutput,
      "success",
      {
        // Mirror the production audit: real sub-agents always call at
        // least read_shared_facts at startup, so toolCount > 0 with only
        // context tools is the genuine narrative-only signal.
        toolCount: 2,
        toolNames: ["read_shared_facts", "memory_search"],
        terminalState: "completed",
        outcome: "success" as const,
      },
      {
        tags: ["coordination"],
        tools: [
          "write_file", "generate_document", "delegate_to_agent",
          "parallel_delegate", "memory_search", "read_shared_facts",
        ],
      } as never,
      "mission_coordinator",
      "Erstelle eine vollständige, interaktive Lernwebsite für die iSAQB CPSA-F Zertifizierung.",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });

  // Regression: session 25f55376 (2026-05-28) had mission_coordinator
  // generate 4096 tokens of "I'll write it in one go" narrative with
  // toolCount: 0, toolNames: [], iterations: 0 and got marked success.
  // The earlier "treat empty stats as a mock signal" shortcut let it
  // through. A real agent with artifact tools that calls ZERO tools on a
  // workspace-mutation task is the strongest narrative-only signal — must
  // be a failure.
  it("returns failure when an artifact-capable agent calls zero tools on a mutation task", () => {
    const r = classifyDelegationResult(
      "This is a substantial single-file deliverable with 7+ content sections, interactive quiz, dark/light theme, and accessibility features. I'll orchestrate this directly.\n\nLet me build the complete CPSA-F learning website. Given the size (~15KB+), I'll write it in one go.",
      "success",
      {
        toolCount: 0,
        toolNames: [],
        terminalState: "completed",
        outcome: "success" as const,
      },
      {
        tags: ["coordination"],
        tools: [
          "write_file", "generate_document", "delegate_to_agent",
          "parallel_delegate", "read_shared_facts", "share_finding",
        ],
      } as never,
      "mission_coordinator",
      "Erstelle eine vollständige Single-Page Lernwebsite als HTML-Datei zur Vorbereitung auf die iSAQB CPSA-F Zertifizierung.",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });

  // Regression (audit b5107ae4): the runtime's source-sensitive rewrite wraps
  // the ORIGINAL user request ("ich möchte ein Aufnahmegerät bauen ... layout")
  // in the canonical WEB RESEARCH TASK template. The researcher (which has
  // write_file for notes) returned a successful 8.8KB sourced report without
  // writing files — and the embedded build verb made artifact-deliverable-miss
  // brand it a failure, discarding the evidence and cascading into a
  // narrowly-scoped ephemeral re-research. A research slice's deliverable is
  // prose evidence by construction.
  it("does NOT flag a research slice against the embedded original request's build verbs", () => {
    const researchSliceTask = [
      "WEB RESEARCH TASK — gather fresh sourced evidence from official primary sources.",
      "Research the request below: use web_search and web_fetch to open the most authoritative primary or official sources.",
      "SOURCE-SENSITIVE DELEGATION:",
      "Original user request:",
      "ich möchte ein sehr portables, batterie powered aufnahmegerät bauen — can you give me product suggestions as well as a layout how to connect everything together",
    ].join("\n");
    const r = classifyDelegationResult(
      "## IM73A135V01 — Confirmed Specifications\n\n- Interface: analog differential (Source: https://www.infineon.com/...)\n- SNR: 73 dB(A) (Source: https://datasheet4u.com/...)\n\n## ESP32-S3 Audio\n\n- I2S: 2 controllers (Source: https://www.espressif.com/...)\n\nSome PDF datasheets could not be text-extracted; those values are marked unverified.",
      "success",
      {
        toolCount: 20,
        toolNames: ["read_shared_facts", "web_search", "web_fetch"],
        terminalState: "completed",
        outcome: "success" as const,
      },
      {
        tags: ["research"],
        tools: ["web_search", "web_fetch", "read_shared_facts", "share_finding", "write_file", "read_file"],
      } as never,
      "researcher",
      researchSliceTask,
    );
    expect(r).toBe<DelegationClassification>("success");
  });

  // Control for the research-slice exemption: the SAME bare build request
  // without the runtime's research-slice header must still be flagged.
  it("still flags an artifact-capable agent that researched instead of building (no slice header)", () => {
    const r = classifyDelegationResult(
      "Here is everything you need to know about the components for the device.",
      "success",
      {
        toolCount: 5,
        toolNames: ["read_shared_facts", "web_search", "web_fetch"],
        terminalState: "completed",
        outcome: "success" as const,
      },
      {
        tags: ["research"],
        tools: ["web_search", "web_fetch", "read_shared_facts", "write_file"],
      } as never,
      "researcher",
      "Erstelle eine vollständige Bauanleitung als Markdown-Datei und speichere sie im Workspace.",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });

  // The same agent shape, but it DID delegate (e.g. to content_writer):
  // don't flag it. The work might legitimately be happening downstream.
  it("does NOT flag a coordinator that delegated but didn't write directly", () => {
    const r = classifyDelegationResult(
      "I delegated the learning website build to content_writer. The output is being prepared.",
      "success",
      {
        toolCount: 2,
        toolNames: ["read_shared_facts", "delegate_to_agent"],
        terminalState: "completed",
        outcome: "success" as const,
      },
      {
        tags: ["coordination"],
        tools: [
          "write_file", "generate_document", "delegate_to_agent",
          "parallel_delegate", "memory_search", "read_shared_facts",
        ],
      } as never,
      "mission_coordinator",
      "Erstelle eine vollständige Lernwebsite für die CPSA-F Zertifizierung.",
    );
    expect(r).toBe<DelegationClassification>("success");
  });

  // Regression: session 6b3f2123 (2026-05-28) produced a 3 KB German
  // planning loop ("Ich werde…", "Lass mich einen anderen Ansatz wählen",
  // "Stattdessen…", "Letztendlich…") that never called write_file. The
  // English-only opener regex missed it entirely, so the orchestrator got
  // the raw narrative as the failure body and tried the same approach
  // again. Keep this case green so the German openers stay covered.
  it("returns failure for a long German planning loop that never executes", () => {
    const germanNarrative = [
      "Ich werde die vollständige CPSA-F Lernwebsite als einzelne HTML-Datei erstellen.",
      "Aufgrund der enormen Größe des Inhalts erstelle ich die Datei in mehreren write_file-Aufrufen.",
      "Lass mich einen anderen Ansatz wählen: Ich verwende stattdessen generate_document.",
      "Stattdessen erstelle ich die HTML-Datei als mehrere Dateien.",
      "Letztendlich werde ich die gesamte Website als eine einzige HTML-Datei mit write_file erstellen.",
    ].join("\n\n");
    const r = classifyDelegationResult(
      germanNarrative,
      "success",
      {
        toolCount: 3,
        toolNames: ["read_shared_facts"],
        terminalState: "completed",
        outcome: "success" as const,
      },
      { tags: ["content"] } as never,
      "content_writer",
      "Erstelle eine vollständige Lernwebsite für die iSAQB CPSA-F Zertifizierung.",
    );
    expect(r).toBe<DelegationClassification>("failure");
  });

  it("returns failure for read-only raw config dumps when a maintenance edit was requested", () => {
    const rawConfigDump = [
      ".starlingai/ agent_outcomes.ndjson README.md agents/ 10-core-agents.jsonc 21-orchestration.jsonc jobs/ 10-jobs.jsonc scenes/ 10-scenes.jsonc",
      "",
      "{ \"subAgents\": { \"browser_agent\": { \"model\": { \"primary\": \"lmstudio/qwen/qwen3.6-35b-a3b\" }, \"systemPrompt\": \"You are a browser automation specialist.\" } } }",
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
      "Passe browser_agent und vision_browser_analyst auf lmstudio/qwen/qwen3.5-9b an.",
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

// Regression: audit fa1b88b3 (2026-06-08). `coder` ran containerized for the
// CPSA-F learning-platform build, could not reach the host model / gateway-bound
// code_sandbox MCP, and died with "container error: unknown" (0 tokens, 0 tools).
// classifyDelegationResult correctly returns "failure" (so the node is retryable
// on another agent), but the run_task_graph node error was then labeled
// "narrative-only — restate the task as a single direct instruction", which sent
// the orchestrator in circles against the same broken container instead of
// surfacing the real error. A container/host-level crash must NOT be reported as
// narrative-only.
describe("isNarrativeOnlyDeliverableFailure — container crashes are not 'narrative-only'", () => {
  const coderCfg = {
    tools: ["mcp__code_sandbox__run_js", "write_file", "list_files", "read_shared_facts", "share_finding"],
  } as never;

  it("does NOT flag a container crash as narrative-only even though 0 work tools ran", () => {
    const flagged = isNarrativeOnlyDeliverableFailure(
      "failure",
      "Sub-agent 'coder' container error: unknown",
      "Erstelle die Projektstruktur für die CPSA-F Lernplattform und schreibe package.json.",
      { toolCount: 0, toolNames: [] },
      coderCfg,
    );
    expect(flagged).toBe(false);
  });

  it("does NOT flag a sub-agent timeout crash as narrative-only", () => {
    const flagged = isNarrativeOnlyDeliverableFailure(
      "failure",
      "Sub-agent 'coder' timed out after 240000ms",
      "Erstelle das Frontend public/index.html für die Lernplattform.",
      { toolCount: 0, toolNames: [] },
      coderCfg,
    );
    expect(flagged).toBe(false);
  });

  it("STILL flags a genuine narrative-only miss (artifact tools, narrated, never wrote)", () => {
    const flagged = isNarrativeOnlyDeliverableFailure(
      "failure",
      "This is a substantial deliverable. Let me build the complete single-file HTML application now.",
      "Erstelle eine vollständige Single-Page Lernwebsite als HTML-Datei.",
      { toolCount: 2, toolNames: ["read_shared_facts", "memory_search"] },
      coderCfg,
    );
    expect(flagged).toBe(true);
  });

  it("returns false when the classification is not a failure", () => {
    expect(
      isNarrativeOnlyDeliverableFailure(
        "success",
        "Sub-agent 'coder' container error: unknown",
        "Erstelle package.json.",
        { toolCount: 0, toolNames: [] },
        coderCfg,
      ),
    ).toBe(false);
  });
});
