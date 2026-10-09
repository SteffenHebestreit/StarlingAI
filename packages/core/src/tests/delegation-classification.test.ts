import { describe, it, expect } from "vitest";
import { classifyDelegationResult, isNarrativeOnlyDeliverableFailure } from "../tools/sub-agent.js";
import { loadWorkspaceAgents } from "./support/workspace-shards.js";
import type { DelegationClassification } from "../tools/sub-agent.js";
import {
  carriesConcreteEvidence,
  inferCompletedRunOutcome,
  isWorkToolName,
  looksLikePlanningOnlyResult,
  parseFinalAnswerTag,
  readDelegationDeliverable,
  taxonomyDefaultDeliverable,
} from "../tools/delegation-artifact-classification.js";

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
      [],
      // The build request, as the delegation declares it (DelegationDeliverable).
      { deliverable: "file" },
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
    const classify = (run: { deliverable?: "file" | "answer" }) => classifyDelegationResult(
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
      [],
      run,
    );
    // The build request, as the delegation declares it: a missed deliverable.
    expect(classify({ deliverable: "file" })).toBe<DelegationClassification>("failure");
    // Undeclared, the miss check does not fire, and a coordinator that called no tool at all
    // is a no-op (audit 3a0fd176) — still never a success.
    expect(classify({})).toBe<DelegationClassification>("coordinator_noop");
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
      [],
      // Declared by the delegation the slice was cut from: the slice is still a gather.
      { deliverable: "file" },
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
      [],
      { deliverable: "file" },
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
      [],
      { deliverable: "file" },
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
      [],
      { deliverable: "file" },
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
      [],
      { deliverable: "file" },
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

// Verified 2026-10-05: three delegation results were judged by their PROSE alone, against what the
// run itself left behind. Structure first now: the run's explicit <final_answer status>, its
// artifacts, the concrete evidence in its text, whether every one of its tool calls failed. Prose
// only breaks the tie, and never discards evidence.
describe("classifyDelegationResult — structure before prose (2026-10-05)", () => {
  const researchStats = {
    toolCount: 2,
    toolNames: ["web_search", "web_fetch"],
    terminalState: "completed",
    outcome: "success" as const,
  };

  it("a German recommendation is a conclusion, not a planning loop", () => {
    // "Aufgrund …" opens a conclusion as often as a plan; it announced no intent. Before, the
    // opener + an action stem ("nutzt", "verwende") + no terminal marker = planning-only = failure,
    // and the result was discarded (bestPartialResult skips planning-only text too).
    const recommendation =
      "Aufgrund der Datenblätter empfehle ich den ESP32-S3: Er hat zwei I2S-Schnittstellen, nutzt im Deep-Sleep "
      + "weniger Strom und wird von ESP-IDF direkt unterstützt. Für das Mikrofon verwende den ICS-43434.";
    expect(carriesConcreteEvidence(recommendation)).toBe(false); // only the opener fix can save it
    expect(looksLikePlanningOnlyResult(recommendation)).toBe(false);
    expect(classifyDelegationResult(
      recommendation, "success", researchStats, undefined, "researcher", "Welcher Mikrocontroller passt für das Aufnahmegerät?",
    )).toBe<DelegationClassification>("success");
    // A fronted clause that DOES announce intent is still a planning opener.
    expect(looksLikePlanningOnlyResult(
      "Da es sich um eine große Datei handelt, werde ich sie in mehreren Teilen mit write_file schreiben.",
    )).toBe(true);
  });

  // Reversed by the adversarial review the same day: an evidence veto on the planning verdict let
  // stubs that QUOTE figures pass as success (HEAD failed them). A plan with figures is a plan.
  it("a planning stub stays planning-only even when it quotes figures or a URL", () => {
    const stub = "I'll compare the ESP32-S3 (240 MHz, 512 KB SRAM) with the RP2040 (133 MHz). Let me search for their datasheets next.";
    expect(looksLikePlanningOnlyResult(stub)).toBe(true);
    expect(classifyDelegationResult(
      stub, "success", { toolCount: 0, toolNames: [], terminalState: "completed", outcome: "success" as const },
      undefined, "researcher", "Compare ESP32-S3 vs RP2040",
    )).toBe<DelegationClassification>("failure");
    expect(looksLikePlanningOnlyResult("Let me fetch the datasheet from https://www.espressif.com/esp32-s3.pdf next.")).toBe(true);
  });

  it("figures echoed from the task are not evidence", () => {
    const task = "Find a 2 A / 5 V USB charger";
    const echo = "No results found for the 2 A / 5 V charger query.";
    expect(carriesConcreteEvidence(echo)).toBe(true); // what the text alone suggests …
    expect(carriesConcreteEvidence(echo, task)).toBe(false); // … but the figures came from the task
    expect(classifyDelegationResult(echo, "success", researchStats, undefined, "researcher", task)).toBe<DelegationClassification>("failure");
  });

  it("a planning opener with a produced artifact is not a narrative-only failure", () => {
    const opener = "Let me summarize the comparison: use the cheaper board; the table is in the attached file.";
    expect(looksLikePlanningOnlyResult(opener)).toBe(true); // the text alone reads as a stub …
    expect(classifyDelegationResult(
      opener,
      "success",
      { toolCount: 3, toolNames: ["web_search", "write_file"], terminalState: "completed", outcome: "success" as const },
      undefined,
      "researcher",
      "Compare the two boards.",
      [{ outputPath: "generated/compare.md", sourceTool: "write_file" }],
    )).not.toBe<DelegationClassification>("failure");
  });

  it("an explicit success verdict outranks a failure word in the answer", () => {
    const explanation =
      "The HTTP 404 not found response means the server cannot find the requested resource; unlike 410 Gone "
      + "it does not say the removal is permanent.";
    expect(classifyDelegationResult(
      explanation, "success", researchStats, undefined, "researcher", "What does an HTTP 404 mean?", [], { explicitVerdict: true },
    )).toBe<DelegationClassification>("success");
    // Without any structural verdict the prose still breaks the tie: the run's heuristic "partial"
    // keeps the text as partial evidence instead of a success — never discarded.
    expect(classifyDelegationResult(
      explanation, "partial", { ...researchStats, outcome: "partial" as const }, undefined, "researcher", "What does an HTTP 404 mean?",
    )).toBe<DelegationClassification>("partial");
  });

  it("concrete evidence outranks a failure phrase when no verdict was written", () => {
    expect(classifyDelegationResult(
      "The first attempt failed to reach the vendor site, so I used the cached datasheet: the sensor draws 12 mA at 3.3 V.",
      "success", researchStats, undefined, "researcher", "What does the sensor draw?",
    )).toBe<DelegationClassification>("success");
  });

  // Every WORK call failed (review 2026-10-05): a failure when the answer reports one — figures do
  // not rescue it, they may be echoed or remembered — else a PARTIAL: a correct knowledge answer
  // after a failed search is kept and flagged instead of being discarded as a failure (which marks
  // the agent degraded, re-dispatches, drops short answers and demotes it in routing).
  it("every work call failed: failure when the answer reports one, partial (kept) otherwise", () => {
    const classify = (output: string, failures: number, extra: Record<string, unknown> = {}) => classifyDelegationResult(
      output, "success", researchStats, undefined, "researcher", "Compare ESP32-S3 vs RP2040", [], { toolFailureCount: failures, ...extra },
    );
    expect(classify("Unable to fetch https://vendor.com/pricing (HTTP 403). The search snippet mentioned $49 but I could not verify it.", 2))
      .toBe<DelegationClassification>("failure");
    expect(classify("Error: The page returned 503. Retry budget 100% used; 0 B received.", 2))
      .toBe<DelegationClassification>("failure");
    expect(["failure", "infrastructure_failure"]).toContain(
      classify("Failed to retrieve the datasheet: timed out after 30 s. Disk usage on the worker was 100% and memory 95%.", 2),
    );
    expect(classify("The capital of Australia is Canberra.", 2)).toBe<DelegationClassification>("partial");
    // Before 2026-10-05 this was a success; the English failure phrases cannot read it, the failed
    // calls can — and it is kept as partial rather than discarded.
    expect(classify("Keine Ergebnisse gefunden; Quelle nicht erreichbar.", 2)).toBe<DelegationClassification>("partial");
    // One failed fetch among working calls is not a failed run.
    expect(classify("Keine Ergebnisse gefunden; Quelle nicht erreichbar.", 1)).toBe<DelegationClassification>("success");
    // The run's own explicit success outranks its tool failures.
    expect(classify("Keine Ergebnisse gefunden; Quelle nicht erreichbar.", 2, { explicitVerdict: true })).toBe<DelegationClassification>("success");
  });

  it("failed bookkeeping calls (share_finding, memory_*, notes) are not failed work", () => {
    const bookkeeping = ["share_finding", "share_finding", "memory_store"];
    expect(classifyDelegationResult(
      "Here's the summary of the meeting notes: the team agreed to ship on Friday.",
      "success",
      { toolCount: 3, toolNames: bookkeeping, terminalState: "completed", outcome: "success" as const },
      undefined, "summarizer", "Summarize the meeting notes.", [], { failedToolNames: bookkeeping },
    )).toBe<DelegationClassification>("success");
    expect(isWorkToolName("web_fetch")).toBe(true);
    expect(isWorkToolName("research_notes_read")).toBe(false);
  });
});

describe("inferCompletedRunOutcome — a normally-ended run's outcome (2026-10-05)", () => {
  const run = { toolCount: 2, toolFailureCount: 0, artifactCount: 0 };

  it("reads the run's own <final_answer status> first", () => {
    const tagged = '<final_answer status="success">The HTTP 404 not found response means the resource is missing.</final_answer>';
    expect(inferCompletedRunOutcome(tagged, run)).toBe("success");
    expect(inferCompletedRunOutcome('<final_answer status="needs_info">Which board?</final_answer>', run)).toBe("partial");
    expect(inferCompletedRunOutcome('<final_answer status="failure">Nothing found.</final_answer>', run)).toBe("failure");
  });

  it("every work call failed: failure when the answer reports one, partial otherwise", () => {
    const failed = { ...run, toolFailureCount: 2 };
    expect(inferCompletedRunOutcome("No results found for the 2 A / 5 V charger query.", failed)).toBe("failure");
    expect(inferCompletedRunOutcome("Failed to retrieve the datasheet: timed out after 30 s. Memory was at 95% and disk at 100%.", failed)).toBe("failure");
    expect(inferCompletedRunOutcome("The capital of Australia is Canberra.", failed)).toBe("partial");
    expect(inferCompletedRunOutcome("Keine Ergebnisse gefunden; Quelle nicht erreichbar.", failed)).toBe("partial");
    // Bookkeeping failures do not count as failed work.
    expect(inferCompletedRunOutcome("The team agreed to ship on Friday.", {
      toolCount: 2, toolNames: ["share_finding", "memory_store"], failedToolNames: ["share_finding", "memory_store"], artifactCount: 0,
    })).toBe("success");
  });

  it("the final_answer tag needs its closing tag — one parser for every reader", () => {
    expect(parseFinalAnswerTag('<final_answer status="Success"> done </final_answer>')).toEqual({ status: "success", data: "done" });
    expect(parseFinalAnswerTag('<final_answer status="success">The answer, never closed')).toBeNull();
    expect(inferCompletedRunOutcome('<final_answer status="failure">Nothing found but the run went on', { ...run, artifactCount: 1 })).toBe("success");
  });

  it("evidence or artifacts outrank the failure phrases; the phrases still break a tie", () => {
    expect(inferCompletedRunOutcome("The first fetch failed to load, but the cached sheet says 12 mA at 3.3 V.", run)).toBe("success");
    expect(inferCompletedRunOutcome("Unable to fetch one image; the deck is written.", { ...run, artifactCount: 1 })).toBe("success");
    expect(inferCompletedRunOutcome("No results for the exact part number.", run)).toBe("partial");
    expect(inferCompletedRunOutcome("The tide table for Hamburg is attached below.", run)).toBe("success");
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
      "file",
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
      "file",
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
      "file",
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
        "file",
      ),
    ).toBe(false);
  });
});

// E2E 2026-10-09, core-build-code-twin-bug, session 7c4cbb28. The user pasted two Python files and
// asked only for a diagnosis. The orchestrator delegated "Statische Code-Analyse (kein Ausführen,
// kein Ändern): …" with the code to code_analyst, which answered in prose with zero tool calls —
// correct, the code was in the task. The verb table WORKSPACE_MUTATION_TASK_RE found a verb in the
// task ("add 20% tax" in the pasted docstring; in English, the negated "do not change"), code_analyst
// holds write_file, so the run was "narrative-only", every candidate failed and the user got an
// error. Whether a file was wanted is now what the delegation DECLARES (DelegationDeliverable).
describe("classifyDelegationResult — a file is missed only when the delegation asked for one (7c4cbb28)", () => {
  // code_analyst's tools in the shipped roster (workspace/agents/10-core-agents.jsonc).
  const codeAnalyst = {
    tags: ["code-analysis", "static-review", "bug-diagnosis"],
    tools: [
      "read_file", "list_files", "workspace_search", "glob_files", "grep_files", "write_file", "edit_file",
      "regex_test", "text_diff", "read_shared_facts", "share_finding",
    ],
  } as never;
  const zeroTools = { toolCount: 0, toolNames: [] as string[], terminalState: "completed", outcome: "success" as const };
  const pastedCode = [
    "# invoices.py",
    "```python",
    "def invoice_total(line_items):",
    "    \"\"\"Sum the line items and add 20% tax, returning the amount in whole units.\"\"\"",
    "    subtotal = sum(item[\"price\"] * item[\"qty\"] for item in line_items)",
    "    return int(subtotal + subtotal * 0.2)",
    "```",
  ].join("\n");
  const germanTask = "Statische Code-Analyse (kein Ausführen, kein Ändern): Identifiziere das fehlerhafte Konstrukt in "
    + "invoice_total (invoices.py) und nenne jede weitere Stelle im Code, an der derselbe Fehler steckt.\n\n" + pastedCode;
  const englishTask = "Static code analysis — do not run anything and do not change anything: name the faulty construct "
    + "in invoice_total (invoices.py) and every other place the same defect occurs.\n\n" + pastedCode;
  const diagnosis = "Das fehlerhafte Konstrukt ist int(subtotal + tax) in invoice_total (invoices.py): int() schneidet die "
    + "Nachkommastellen ab, statt zu runden, deshalb fällt die Summe um bis zu einen Cent zu niedrig aus. Dieselbe "
    + "Stelle steckt in receipt_total in receipts.py.";

  it("a prose diagnosis from an agent that holds write_file is a success when no file was asked for", () => {
    for (const task of [germanTask, englishTask]) {
      // Undeclared, or declared an answer: either way the reply is the deliverable.
      for (const run of [{}, { deliverable: "answer" as const }]) {
        const classification = classifyDelegationResult(diagnosis, "success", zeroTools, codeAnalyst, "code_analyst", task, [], run);
        expect(classification, `${task.slice(0, 40)} ${JSON.stringify(run)}`).toBe<DelegationClassification>("success");
        expect(isNarrativeOnlyDeliverableFailure(
          "failure", diagnosis, task, zeroTools, codeAnalyst, run.deliverable,
        )).toBe(false);
      }
    }
  });

  it("a real build request answered with narration is still a missed deliverable (25f55376 shape)", () => {
    const narration = "This is a substantial single-file deliverable with a quiz, a dark theme and seven sections. "
      + "Given the size (~15KB+), I'll write it in one go.";
    const builder = { tools: ["write_file", "edit_file", "generate_website", "read_shared_facts"] } as never;
    const task = "Erstelle eine vollständige Single-Page Lernwebsite als HTML-Datei zur Vorbereitung auf CPSA-F.";
    expect(looksLikePlanningOnlyResult(narration)).toBe(false); // only the declared-file check can catch it
    expect(classifyDelegationResult(
      narration, "success", zeroTools, builder, "content_writer", task, [], { deliverable: "file" },
    )).toBe<DelegationClassification>("failure");
    expect(isNarrativeOnlyDeliverableFailure("failure", narration, task, zeroTools, builder, "file")).toBe(true);
    // Declared an answer, the same run is taken at its word.
    expect(classifyDelegationResult(
      narration, "success", zeroTools, builder, "content_writer", task, [], { deliverable: "answer" },
    )).toBe<DelegationClassification>("success");
  });

  it("a read-only review of the agent config is not a missed edit when no change was asked for", () => {
    // looksLikeReadOnlyMutationMiss read a mutation verb ("change") plus a workspace word ("agent",
    // "config") or a maintenance agent's tags. A review that read the files and answered was a failure.
    const reviewStats = { toolCount: 3, toolNames: ["list_files", "read_file", "read_file"], terminalState: "completed", outcome: "success" as const };
    const review = "browser_agent and vision_browser_analyst both run on the 35B model; vision_browser_analyst sets no "
      + "fallback, so a model outage leaves it without one. Nothing else in the two definitions conflicts.";
    const task = "Review the browser_agent and vision_browser_analyst agent config. Do not change anything.";
    // A reviewer with the tags the old heuristic read, and no routing label (that default is tested
    // below, with the shipped roster).
    const reviewer = { tags: ["prompts", "agents"] } as never;
    expect(classifyDelegationResult(review, "success", reviewStats, reviewer, "prompt_optimizer", task))
      .toBe<DelegationClassification>("success");
    // Declared a change, the same read-only run missed it.
    expect(classifyDelegationResult(review, "success", reviewStats, reviewer, "prompt_optimizer", task, [], { deliverable: "file" }))
      .toBe<DelegationClassification>("failure");
  });

  it("reads the declaration from loosely typed tool arguments", () => {
    expect(readDelegationDeliverable("file")).toBe("file");
    expect(readDelegationDeliverable(" Answer ")).toBe("answer");
    for (const value of ["files", "document", "", undefined, null, 1, true, ["file"]]) {
      expect(readDelegationDeliverable(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});

// A delegation that declares nothing takes its AGENT's deliverable kind from the routing taxonomy
// (workspace/agents/59-routing.generated.jsonc, resolveRoutingTaxonomy). A builder still fails
// when it only narrates, as it did before the declaration existed; an evidence agent's prose
// answer (7c4cbb28) is still its deliverable. An explicit declaration always wins; an agent with
// no taxonomy (ephemeral, promoted, unknown) keeps "undeclared means no miss".
describe("an undeclared delegation takes its agent's deliverable kind from the routing taxonomy", () => {
  // The shipped roster, merged the way the config builder merges the shards: tools from the agent
  // shards, the routing label from the generated one.
  const roster = loadWorkspaceAgents<Record<string, unknown>>();
  const shipped = (name: string) => {
    const agent = roster[name];
    expect(agent, `${name} is in the shipped roster`).toBeDefined();
    return agent as never;
  };
  const zeroTools = { toolCount: 0, toolNames: [] as string[], terminalState: "completed", outcome: "success" as const };
  const narration = "This is a substantial single-page deliverable with a quiz, a dark theme and seven sections. "
    + "Given the size (~15KB+), I'll write it in one go.";
  const buildTask = "Build the CPSA-F learning page from the shared facts.";

  it("an undeclared web_coder that only narrates is a failure, as before the declaration", () => {
    expect(taxonomyDefaultDeliverable(shipped("web_coder"))).toBe("file");
    expect(classifyDelegationResult(narration, "success", zeroTools, shipped("web_coder"), "web_coder", buildTask))
      .toBe<DelegationClassification>("failure");
    expect(isNarrativeOnlyDeliverableFailure("failure", narration, buildTask, zeroTools, shipped("web_coder"), undefined)).toBe(true);
  });

  it("an undeclared code_analyst answering in prose is a success (the incident)", () => {
    const task = [
      "Statische Code-Analyse (kein Ausführen, kein Ändern): Identifiziere das fehlerhafte Konstrukt.",
      "```python",
      "def invoice_total(items):",
      "    \"\"\"Sum the items and add 20% tax.\"\"\"",
      "    return int(sum(items) * 1.2)",
      "```",
    ].join("\n");
    const diagnosis = "int(subtotal + tax) schneidet die Nachkommastellen ab, statt zu runden; dieselbe Stelle steckt in receipt_total.";
    expect(taxonomyDefaultDeliverable(shipped("code_analyst"))).toBe("answer");
    expect(classifyDelegationResult(diagnosis, "success", zeroTools, shipped("code_analyst"), "code_analyst", task))
      .toBe<DelegationClassification>("success");
  });

  it("an explicit declaration wins over the agent's kind", () => {
    expect(classifyDelegationResult(
      narration, "success", zeroTools, shipped("web_coder"), "web_coder", buildTask, [], { deliverable: "answer" },
    )).toBe<DelegationClassification>("success");
    const readOnly = { toolCount: 2, toolNames: ["read_file", "grep_files"], terminalState: "completed", outcome: "success" as const };
    expect(classifyDelegationResult(
      "Here is what the module does.", "success", readOnly, shipped("code_analyst"), "code_analyst", "Fix the rounding in invoices.py.", [], { deliverable: "file" },
    )).toBe<DelegationClassification>("failure");
  });

  it("maps the shipped roster's kinds: file builders, answer agents, coordinators and unlabelled agents", () => {
    // A kind whose product is a file; a document builder (prose_doc with a tool that renders it); a
    // change to the swarm's own config.
    for (const name of [
      "web_coder", "backend_coder", "coder", "tool_developer", "diagram_designer", "chart_designer", "image_creator",
      "image_sourcer", "content_writer", "paper_author", "report_writer_agent", "meeting_briefing_agent", "swarm_maintainer",
    ]) {
      expect(taxonomyDefaultDeliverable(shipped(name)), name).toBe("file");
    }
    // Findings, verdicts, plans, messages, tables, inline prose (summarizer: the same prose_doc
    // label as content_writer, no rendering tool), and changes that land outside the workspace.
    for (const name of [
      "code_analyst", "researcher", "evidence_analyst", "quality_supervisor", "prompt_optimizer", "project_planner",
      "mail_agent", "data_analyst", "document_intake", "sql_specialist", "summarizer", "git_developer",
      "infrastructure_agent", "calendar_agent", "web_task_coordinator",
    ]) {
      expect(taxonomyDefaultDeliverable(shipped(name)), name).toBe("answer");
    }
    // A coordinator delivers its specialists' work ("none"); an ephemeral or unknown agent has no label.
    for (const name of ["mission_coordinator", "pentest_coordinator", "devops_coordinator"]) {
      expect(taxonomyDefaultDeliverable(shipped(name)), name).toBeUndefined();
    }
    expect(taxonomyDefaultDeliverable({ tools: ["write_file", "generate_website"] } as never)).toBeUndefined();
    expect(taxonomyDefaultDeliverable(undefined)).toBeUndefined();
  });

  it("an undeclared builder without a label keeps the previous rule: no miss", () => {
    const ephemeralBuilder = { tools: ["write_file", "generate_website"] } as never;
    expect(classifyDelegationResult(narration, "success", zeroTools, ephemeralBuilder, "ephemeral:site_builder", buildTask))
      .toBe<DelegationClassification>("success");
  });

  it("25f55376 on the shipped mission_coordinator: a zero-tool narration is never a success", () => {
    for (const run of [{}, { deliverable: "file" as const }]) {
      expect(classifyDelegationResult(narration, "success", zeroTools, shipped("mission_coordinator"), "mission_coordinator", buildTask, [], run), JSON.stringify(run))
        .toBe<DelegationClassification>("coordinator_noop");
    }
  });

  it("a builder that checked or served what it built worked on the deliverable; it did not narrate", () => {
    // A builder is judged by its own kind without a declaration, so its "is the page working?" and
    // "restart the app" delegations reach the miss check too. verify_page / verify_app / serve_app
    // write no file, and the run that called them is not one that narrated instead of building.
    const checked = { toolCount: 2, toolNames: ["read_file", "verify_page"], terminalState: "completed", outcome: "success" as const };
    expect(classifyDelegationResult(
      "verify_page: PASS — index.html renders, the quiz answers register, no console errors.", "success", checked,
      shipped("web_coder"), "web_coder", "Check whether generated/quiz/index.html works.",
    )).toBe<DelegationClassification>("success");
    const served = { toolCount: 1, toolNames: ["serve_app"], terminalState: "completed", outcome: "success" as const };
    expect(classifyDelegationResult(
      "The app is running again at /api/app/12/.", "success", served,
      shipped("backend_coder"), "backend_coder", "Restart the inventory app.",
    )).toBe<DelegationClassification>("success");
  });

  it("c903b401 on the shipped mission_coordinator: asked for a file, it neither built nor delegated", () => {
    // The shipped mission_coordinator holds no file-writing tool, so the miss check used to stop at
    // "no artifact tool to call" and a coordinator that only read context and narrated "Let me build
    // this…" passed. Its way to produce a file is to delegate it; asked for one, not delegating is
    // the miss. A coordinator has no default ("none"), so this needs the declaration.
    const contextOnly = { toolCount: 2, toolNames: ["read_shared_facts", "memory_search"], terminalState: "completed", outcome: "success" as const };
    const c903 = "This is a substantial multi-section deliverable (full interactive learning website with 5 major topic areas, "
      + "quiz functionality, dark/light mode). Let me build this as a complete single-file HTML application.";
    const coordinator = shipped("mission_coordinator");
    expect(classifyDelegationResult(c903, "success", contextOnly, coordinator, "mission_coordinator", buildTask, [], { deliverable: "file" }))
      .toBe<DelegationClassification>("failure");
    expect(isNarrativeOnlyDeliverableFailure("failure", c903, buildTask, contextOnly, coordinator, "file")).toBe(true);
    const delegated = { ...contextOnly, toolNames: ["read_shared_facts", "delegate_to_agent"] };
    expect(classifyDelegationResult(c903, "success", delegated, coordinator, "mission_coordinator", buildTask, [], { deliverable: "file" }))
      .toBe<DelegationClassification>("success");
  });

  it("an undeclared swarm_maintainer that only read is a missed edit again; a reviewer is not", () => {
    const readOnly = { toolCount: 3, toolNames: ["list_files", "read_file", "read_file"], terminalState: "completed", outcome: "success" as const };
    const report = "browser_agent and vision_browser_analyst both run on the 35B model; the second sets no fallback.";
    expect(classifyDelegationResult(report, "success", readOnly, shipped("swarm_maintainer"), "swarm_maintainer", "Switch browser_agent to the 9B model."))
      .toBe<DelegationClassification>("failure");
    expect(classifyDelegationResult(report, "success", readOnly, shipped("prompt_optimizer"), "prompt_optimizer", "Review the browser_agent config. Do not change anything."))
      .toBe<DelegationClassification>("success");
  });
});
