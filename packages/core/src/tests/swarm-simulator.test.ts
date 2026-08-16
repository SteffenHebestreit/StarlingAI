/**
 * Swarm simulator — end-to-end pathology harness (Wave 2 of the philosophy-hardening plan).
 *
 * Unit tests validate each recovery net in isolation; the LIVE failures have all come from
 * net INTERACTIONS on the slow local model (two-autopilot conflicts, guards rewriting each
 * other's output). This harness drives the REAL `runTurn` loop with a scripted provider
 * that emits the documented slow-35B pathologies and asserts the END-TO-END outcome: what
 * the user receives, which artifacts exist, and which nets fired — so a future guard change
 * that breaks an interaction fails HERE instead of in the next live audit.
 *
 * Scenarios (each reproduces a real audited failure):
 *  S1 audit 13523d73 — zero-tool turn FABRICATES a completed build ("…erstellt", no tools)
 *     → fabrication guard must trigger a REAL corrective build, ship the built artifact,
 *     and strip any giant code fence from the confirmation (audit ce8e2128).
 *  S2 audit 9ad34ef9  — explicit app-build request answered with a CONCEPT (stop, no tools)
 *     → normal-path completion QA gate must build the actual app via web_coder.
 *  S3 honesty floor   — when the corrective build produces NOTHING, the turn must NOT claim
 *     success: the concept ships as-is, with no fabricated file path or completion banner.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn(async () => ({
  content: "synthesized",
  tool_calls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
})));

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: (...args: Parameters<typeof completeMock>) => completeMock(...args),
    stream: (...args: Parameters<typeof streamMock>) => streamMock(...args),
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    // Identity: no model preset is active in tests, so the turn's context window
    // stays the one the config declares.
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: () => null,
  };
});

vi.mock("../guardrails/rate-limiter.js", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("../guardrails/input.js", () => ({
  checkInput: vi.fn(() => ({ allowed: true, detectedPatterns: [] })),
  checkToolOutput: vi.fn(() => ({ allowed: true })),
}));

vi.mock("../guardrails/moderation.js", () => ({
  moderateInputText: vi.fn(async () => null),
  moderateTextOutput: vi.fn(async () => null),
  moderateToolResultText: vi.fn(async () => null),
}));

vi.mock("../guardrails/output.js", () => ({
  scanOutput: vi.fn((text: string) => ({ safe: true, redacted: text })),
}));

import { AgentSession, resetSessionsForTests } from "../agent/session.js";
import { runTurn } from "../agent/runtime.js";
import { resetConfigForTests } from "../config/loader.js";
import { registerTool, unregisterTool } from "../tools/registry.js";

const tempConfigDirs: string[] = [];

/** Pin hybrid tool mode so the orchestration-only enforcement nets stay out of the
 * scenario under test — these scenarios target the FINALIZATION gates. */
function pinHybridConfig(extra: Record<string, unknown> = {}): void {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-swarm-sim-"));
  tempConfigDirs.push(tempDir);
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    agents: { mainAssistant: { toolMode: "hybrid" } },
    ...extra,
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  resetConfigForTests();
}

function textStream(text: string) {
  return (async function* () {
    yield { type: "text_delta", content: text };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  })();
}

function makeSession(): AgentSession {
  return new AgentSession({
    channel: "test",
    workspacePath: "/workspace",
    systemPrompt: "You are a test agent.",
  });
}

/** A delegate_to_agent stub that "builds" a real artifact (the success path). */
function registerBuildingDelegate(calls: Array<Record<string, unknown>>): void {
  registerTool({
    name: "delegate_to_agent",
    description: "Delegate to a specialist.",
    parameters: { type: "object", properties: {} },
    execute: vi.fn(async (args: Record<string, unknown>) => {
      calls.push(args);
      return {
        success: true,
        output: "File written: generated/cpsa-prep/index.html (9000 chars)",
        metadata: {
          agentName: args["agentName"],
          attemptedAgents: [args["agentName"]],
          delegationOutcome: "success",
          artifacts: [{
            sourceAgent: args["agentName"],
            sourceTool: "write_file",
            filename: "index.html",
            outputPath: "generated/cpsa-prep/index.html",
            contentType: "text/html; charset=utf-8",
            size: 9000,
          }],
        },
      };
    }),
  });
}

/** A delegate_to_agent stub that returns prose but NO artifact (the failed-build path). */
function registerArtifactlessDelegate(calls: Array<Record<string, unknown>>): void {
  registerTool({
    name: "delegate_to_agent",
    description: "Delegate to a specialist.",
    parameters: { type: "object", properties: {} },
    execute: vi.fn(async (args: Record<string, unknown>) => {
      calls.push(args);
      return {
        success: true,
        output: "I ran out of time before writing any file. Here is what I planned to build: a quiz app with tabs.",
        metadata: { agentName: args["agentName"], attemptedAgents: [args["agentName"]], delegationOutcome: "success" },
      };
    }),
  });
}

afterEach(() => {
  for (const dir of tempConfigDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env["SAI_CONFIG_PATH"];
  resetConfigForTests();
  unregisterTool("delegate_to_agent");
  unregisterTool("write_file");
  streamMock.mockReset();
  completeMock.mockReset();
  completeMock.mockImplementation(async () => ({
    content: "synthesized",
    tool_calls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    finishReason: "stop",
  }));
  resetSessionsForTests();
});

describe("swarm simulator — fabricated zero-work completion (S1, audits 13523d73 + ce8e2128)", () => {
  it("a zero-tool fabricated 'erstellt' claim triggers a REAL build, ships the artifact, and strips giant code fences", async () => {
    pinHybridConfig();
    // Pathology: the model answers a build-shaped request with a COMPLETED-build claim,
    // zero tool calls (the exact 13523d73 shape — need-phrased request, no create verb).
    streamMock.mockImplementation(() => textStream(
      "Ich habe die Lernplattform gebaut und als index.html gespeichert. Die App enthält ein Quiz mit 38 Fragen. Viel Erfolg!",
    ));
    // The corrective-build confirmation synthesis ALSO misbehaves: it pastes a multi-KB
    // code block (ce8e2128) — the harness asserts it gets stripped.
    const giantFence = "```html\n" + "<div>fence-spam</div>\n".repeat(150) + "```";
    completeMock.mockImplementation(async () => ({
      content: `Die Datei wurde erstellt: generated/cpsa-prep/index.html — eine Lern-App mit Quiz und Fragenkatalog.\n\n${giantFence}\n\nViel Erfolg bei der Prüfung!`,
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));
    const delegateCalls: Array<Record<string, unknown>> = [];
    registerBuildingDelegate(delegateCalls);

    const result = await runTurn({
      session: makeSession(),
      userMessage: "Ich brauche eine Lernplattform als WebApp mit Fragekatalog und Multiple-Choice-Antworten zum Üben.",
    });

    // The fabrication was detected …
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ details: "fabricated_zero_work_delivery_suppressed" }),
    ]));
    // … and answered with a REAL build (not just a denial): web_coder, once.
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ details: "fabricated_zero_work_corrective_build" }),
    ]));
    expect(delegateCalls).toHaveLength(1);
    expect(delegateCalls[0]!["agentName"]).toBe("web_coder");
    // The user gets the built file's path — and NOT the fabricated original claim.
    expect(result.response).toContain("generated/cpsa-prep/index.html");
    // The giant fence was stripped from the confirmation; the prose around it survived.
    expect(result.response).not.toContain("fence-spam");
    expect(result.response).toContain("Viel Erfolg");
  });
});

describe("swarm simulator — concept instead of app (S2, audit 9ad34ef9)", () => {
  it("an explicit app-build request answered by a concept gets the app actually built", async () => {
    pinHybridConfig();
    streamMock.mockImplementation(() => textStream(
      "Hier ist ein Konzept für die WebApp: Tabs für Quiz, Curriculum und Statistiken. "
      + "Das Quiz könnte 38 Fragen aus dem offiziellen Mock-Exam nutzen und clientseitig auswerten.",
    ));
    completeMock.mockImplementation(async () => ({
      content: "Die WebApp wurde gebaut und liegt unter generated/cpsa-prep/index.html — Quiz, Curriculum und Statistik-Tabs sind enthalten und funktionieren ohne Server.",
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));
    const delegateCalls: Array<Record<string, unknown>> = [];
    registerBuildingDelegate(delegateCalls);

    const result = await runTurn({
      session: makeSession(),
      userMessage: "Baue eine WebApp zum Lernen mit einem interaktiven Quiz.",
    });

    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ details: "final_qa_corrective_build_normal_path" }),
    ]));
    expect(delegateCalls).toHaveLength(1);
    expect(delegateCalls[0]!["agentName"]).toBe("web_coder");
    expect(String(delegateCalls[0]!["task"])).toContain("SINGLE self-contained index.html");
    expect(result.response).toContain("generated/cpsa-prep/index.html");
  });
});

describe("swarm simulator — honesty floor when the build fails (S3)", () => {
  it("a corrective build that produces no artifact must not fabricate success", async () => {
    pinHybridConfig();
    const concept =
      "Hier ist ein Konzept für die WebApp: Tabs für Quiz und Curriculum. "
      + "Die Fragen würden clientseitig ausgewertet, ein Fortschrittsbalken zeigt den Lernstand.";
    streamMock.mockImplementation(() => textStream(concept));
    const delegateCalls: Array<Record<string, unknown>> = [];
    registerArtifactlessDelegate(delegateCalls);

    const result = await runTurn({
      session: makeSession(),
      userMessage: "Baue eine WebApp zum Lernen mit einem interaktiven Quiz.",
    });

    // The build was attempted once …
    expect(delegateCalls).toHaveLength(1);
    // … produced nothing, so the turn ships the honest concept — no invented file path,
    // no "wurde erstellt" completion claim anywhere in the final answer.
    expect(result.response).toContain("Konzept");
    expect(result.response).not.toMatch(/generated\//);
    expect(result.response).not.toMatch(/wurde (erstellt|gebaut|gespeichert)/i);
  });
});

describe("swarm simulator — truncated inline app dump (S4, audit 3b7d59a8)", () => {
  it("a zero-tool turn that hand-writes the app as inline HTML (cut off by the token cap) gets a REAL build instead", async () => {
    pinHybridConfig();
    // Pathology: the model answers the need-phrased app request by inlining the whole
    // app as a fenced HTML document and dies at the completion cap mid-CSS — no
    // completion claim, no fabricated link, just an unrunnable truncated wall.
    const truncatedInlineApp =
      "## iSAQB CPSA-F — Lernplattform\n\nKopiere den Code unten in eine Datei:\n\n"
      + "```html\n<!DOCTYPE html>\n<html lang=\"de\">\n<head><title>Lernplattform</title>\n<style>\n"
      + ".quiz-card { padding: 30px; }\n".repeat(80)
      + ".pagination {\n  display: flex;\n  justify-content: center"; // cut mid-rule, fence never closes
    streamMock.mockImplementation(() => textStream(truncatedInlineApp));
    completeMock.mockImplementation(async () => ({
      content: "Die Lern-App wurde als echte Datei gebaut: generated/cpsa-prep/index.html — Quiz mit Multiple-Choice-Fragen, läuft ohne Server direkt im Browser.",
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));
    const delegateCalls: Array<Record<string, unknown>> = [];
    registerBuildingDelegate(delegateCalls);

    const result = await runTurn({
      session: makeSession(),
      userMessage: "Ich brauche eine Lernplattform mit Fragekatalog und Multiple-Choice-Antworten für die Prüfung.",
    });

    // The inline dump was recognized and rerouted into ONE real web_coder build.
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ details: "fabricated_zero_work_delivery_suppressed" }),
      expect.objectContaining({ details: "fabricated_zero_work_corrective_build" }),
    ]));
    expect(delegateCalls).toHaveLength(1);
    expect(delegateCalls[0]!["agentName"]).toBe("web_coder");
    // The user gets the built file, not the truncated wall.
    expect(result.response).toContain("generated/cpsa-prep/index.html");
    expect(result.response).not.toContain(".pagination");
  });
});

describe("swarm simulator — discarded build spec is rescued into the corrective build (S5, audit c2f76a00)", () => {
  it("a surplus builder delegation's spec survives the filter and reaches the corrective build as the blueprint", async () => {
    pinHybridConfig();
    const builderSpec =
      "Erstelle eine vollständige, interaktive WebApp als einzelne HTML-Datei zum Lernen. "
      + "Mindestens 100 realistische Multiple-Choice-Fragen mit 4 Optionen, sofortiges Feedback mit Erklärung, "
      + "Themenblock-Auswahl, Fortschrittsverfolgung lokal im Browser via localStorage, responsives modernes UI.";
    // Iteration 1: the model emits TWO direct delegations in one response — research plus a
    // detailed builder spec. The surplus-delegation filter keeps the first and drops the
    // builder one; the stash must preserve its task text.
    streamMock.mockImplementationOnce(() => (async function* () {
      yield { type: "tool_call_start", toolCallId: "c1", toolName: "delegate_to_agent" };
      yield { type: "tool_call_delta", toolCallId: "c1", argumentsDelta: JSON.stringify({ agentName: "researcher", task: "Recherchiere die offiziellen Themenbereiche der Prüfung und sammle Quellen für den Fragenkatalog." }) };
      yield { type: "tool_call_start", toolCallId: "c2", toolName: "delegate_to_agent" };
      yield { type: "tool_call_delta", toolCallId: "c2", argumentsDelta: JSON.stringify({ agentName: "content_writer", task: builderSpec }) };
      yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    })());
    // Iteration 2: the model ships a concept (stop, no artifact) → normal-path QA gate builds.
    streamMock.mockImplementation(() => textStream(
      "Hier ist das Konzept für die Lern-WebApp: Themenblöcke, Quizfragen und eine Fortschrittsanzeige.",
    ));
    completeMock.mockImplementation(async () => ({
      content: "Die WebApp wurde gebaut: generated/cpsa-prep/index.html — interaktives Quiz mit Multiple-Choice-Fragen, läuft lokal im Browser ohne Server.",
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));

    const delegateCalls: Array<Record<string, unknown>> = [];
    registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async (args: Record<string, unknown>) => {
        delegateCalls.push(args);
        if (delegateCalls.length === 1) {
          // The surviving research delegation: prose evidence, NO artifact.
          return {
            success: true,
            output: "Recherche-Ergebnis: Die Prüfung umfasst ca. 40 Lernziele (Quelle: offizielle Curriculum-Seite).",
            metadata: { agentName: args["agentName"], attemptedAgents: [args["agentName"]], delegationOutcome: "success" },
          };
        }
        // The corrective build: returns a real artifact.
        return {
          success: true,
          output: "File written: generated/cpsa-prep/index.html (9000 chars)",
          metadata: {
            agentName: args["agentName"],
            attemptedAgents: [args["agentName"]],
            delegationOutcome: "success",
            artifacts: [{
              sourceAgent: args["agentName"],
              sourceTool: "write_file",
              filename: "index.html",
              outputPath: "generated/cpsa-prep/index.html",
              contentType: "text/html; charset=utf-8",
              size: 9000,
            }],
          },
        };
      }),
    });

    const result = await runTurn({
      session: makeSession(),
      userMessage: "Baue eine WebApp zum Lernen mit einem interaktiven Quiz.",
    });

    // The corrective build ran as the SECOND delegation, routed to web_coder…
    expect(delegateCalls).toHaveLength(2);
    expect(delegateCalls[1]!["agentName"]).toBe("web_coder");
    // …and its context carries the rescued blueprint verbatim.
    const buildContext = String(delegateCalls[1]!["context"] ?? "");
    expect(buildContext).toContain("BUILD SPEC");
    expect(buildContext).toContain("localStorage");
    expect(buildContext).toContain("100 realistische Multiple-Choice-Fragen");
    // The build task mandates incremental chunked writes, never one giant call.
    expect(String(delegateCalls[1]!["task"])).toContain("mode:\"append\"");
    expect(result.response).toContain("generated/cpsa-prep/index.html");
  });
});

describe("swarm simulator — model's own builder delegation survives the synthesis-required gate (S7, audit a438ef4a)", () => {
  it("after research, the model's content_writer build is ALLOWED through instead of being rejected and re-done by the corrective net", async () => {
    pinHybridConfig();
    // Iteration 1: the model delegates research; the result carries grounded evidence,
    // which arms the [SYNTHESIS REQUIRED] gate (the relay is suppressed because the
    // app is unbuilt).
    streamMock.mockImplementationOnce(() => (async function* () {
      yield { type: "tool_call_start", toolCallId: "s7c1", toolName: "delegate_to_agent" };
      yield { type: "tool_call_delta", toolCallId: "s7c1", argumentsDelta: JSON.stringify({ agentName: "researcher", task: "Recherchiere die offiziellen Prüfungsfakten." }) };
      yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    })());
    // Iteration 2: the model does EXACTLY what the user asked — it delegates the BUILD
    // to content_writer with its own spec. Before the fix this was rejected as
    // "tool_calls_after_synthesis_required" and the corrective net re-built minutes later.
    streamMock.mockImplementationOnce(() => (async function* () {
      yield { type: "tool_call_start", toolCallId: "s7c2", toolName: "delegate_to_agent" };
      yield { type: "tool_call_delta", toolCallId: "s7c2", argumentsDelta: JSON.stringify({ agentName: "content_writer", task: "Baue die Lern-WebApp als einzelne index.html mit Quiz und Fortschrittsanzeige." }) };
      yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    })());
    // Iteration 3: with the artifact built, the model confirms.
    streamMock.mockImplementation(() => textStream(
      "Die WebApp wurde gebaut: generated/cpsa-prep/index.html — interaktives Quiz, läuft lokal im Browser.",
    ));
    completeMock.mockImplementation(async () => ({
      content: "Die WebApp wurde gebaut: generated/cpsa-prep/index.html — interaktives Quiz, läuft lokal im Browser.",
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));

    const delegateCalls: Array<Record<string, unknown>> = [];
    registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async (args: Record<string, unknown>) => {
        delegateCalls.push(args);
        if (delegateCalls.length === 1) {
          return {
            success: true,
            output: "Delegated result from researcher — completed.\nObserved evidence:\nDie Prüfung umfasst ca. 40 Multiple-Choice-Fragen, 75 Minuten, Bestehensgrenze 60% (Quelle: https://www.isaqb.org/certifications/cpsa-exams/foundation-level-exam/).",
            metadata: { agentName: "researcher", attemptedAgents: ["researcher"], delegationSucceeded: true, delegationOutcome: "success", terminalState: "completed" },
          };
        }
        return {
          success: true,
          output: "File written: generated/cpsa-prep/index.html (9000 chars)",
          metadata: {
            agentName: args["agentName"],
            attemptedAgents: [args["agentName"]],
            delegationOutcome: "success",
            terminalState: "completed",
            artifacts: [{
              sourceAgent: args["agentName"],
              sourceTool: "write_file",
              filename: "index.html",
              outputPath: "generated/cpsa-prep/index.html",
              contentType: "text/html; charset=utf-8",
              size: 9000,
            }],
          },
        };
      }),
    });

    const result = await runTurn({
      session: makeSession(),
      userMessage: "Baue eine WebApp zum Lernen mit einem interaktiven Quiz.",
    });

    // The model's own build went through the gate…
    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "synthesis_required", details: "builder_build_allowed" }),
    ]));
    // …exactly TWO delegations ran (research + the model's build) — the corrective
    // net did NOT have to re-build a third time.
    expect(delegateCalls).toHaveLength(2);
    expect(delegateCalls[1]!["agentName"]).toBe("content_writer");
    expect(result.response).toContain("generated/cpsa-prep/index.html");
  });
});

describe("swarm simulator — inline-app harvest when the builder writes no file (S6, audit 0ac7d3fc)", () => {
  it("a builder result that pastes the complete app with ZERO artifacts gets harvested into a real file", async () => {
    pinHybridConfig();
    // Pathology: the corrective builder "succeeds" but never wrote a file — its timeout
    // synthesis pasted the entire app document into the RESULT text instead.
    const inlineApp = "<!DOCTYPE html>\n<html lang=\"de\">\n<head><style>.q{padding:2px}</style></head>\n<body>"
      + "<div class=\"q\">Frage zur Prüfung</div>\n".repeat(60)
      + "<script>let idx=0;</script>\n</body>\n</html>";
    streamMock.mockImplementation(() => textStream(
      "Hier ist das Konzept für die Lern-WebApp: Quizfragen mit sofortigem Feedback.",
    ));
    completeMock.mockImplementation(async () => ({
      content: "Die Datei wurde erstellt: generated/app/index.html — interaktives Quiz, läuft lokal im Browser.",
      tool_calls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }));

    const delegateCalls: Array<Record<string, unknown>> = [];
    registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async (args: Record<string, unknown>) => {
        delegateCalls.push(args);
        return {
          success: true,
          output: `Ich konnte write_file nicht erfolgreich ausführen. Hier ist die vollständige App:\n\n\`\`\`html\n${inlineApp}\n\`\`\``,
          metadata: { agentName: args["agentName"], attemptedAgents: [args["agentName"]], delegationOutcome: "success" },
        };
      }),
    });
    const writeCalls: Array<Record<string, unknown>> = [];
    registerTool({
      name: "write_file",
      description: "Write a file.",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async (args: Record<string, unknown>) => {
        writeCalls.push(args);
        const content = String(args["content"] ?? "");
        return {
          success: true,
          output: `File written: generated/app/index.html (${content.length} chars)`,
          metadata: {
            artifactKind: "workspace_file",
            outputPath: "generated/app/index.html",
            filename: "index.html",
            contentType: "text/html; charset=utf-8",
            size: content.length,
          },
        };
      }),
    });

    const result = await runTurn({
      session: makeSession(),
      userMessage: "Baue eine WebApp zum Lernen mit einem interaktiven Quiz.",
    });

    // The build ran once, produced no artifact, and the runtime harvested the inline
    // document itself: ONE deterministic write_file with the extracted app.
    expect(delegateCalls).toHaveLength(1);
    expect(writeCalls).toHaveLength(1);
    const harvested = String(writeCalls[0]!["content"] ?? "");
    expect(harvested.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(harvested.endsWith("</html>")).toBe(true);
    expect(harvested).not.toContain("```");
    // The user gets the real file path, not a failed turn.
    expect(result.response).toContain("generated/app/index.html");
  });
});

describe("swarm simulator — non-artifact question is never dragged into the build pipeline (S7, session 24826c33)", () => {
  // Live failure: "Schau mal ob ich neue Emails habe" was answered with zero tools; the
  // fabrication guard misread the answer's own wording as a delivery claim, suppressed it,
  // launched a BUILD TASK (redirected to researcher), and shipped the canned bilingual
  // "Der Bau der angeforderten Datei ist fehlgeschlagen" reply — to an email question.
  const EMAIL_QUESTION = "Schau mal ob ich neue Emails habe";

  it("an honest 'öffne die E-Mail-App im Browser' advice answer ships as-is (heuristic fix)", async () => {
    pinHybridConfig();
    const honestAdvice =
      "Ich habe keinen Zugriff auf dein E-Mail-Konto. Öffne die E-Mail-App in deinem Browser "
      + "oder dein E-Mail-Programm, um neue Nachrichten zu prüfen.";
    streamMock.mockImplementation(() => textStream(honestAdvice));
    const delegateCalls: Array<Record<string, unknown>> = [];
    registerArtifactlessDelegate(delegateCalls);

    const result = await runTurn({ session: makeSession(), userMessage: EMAIL_QUESTION });

    expect(result.guardrailEvents ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ details: "fabricated_zero_work_delivery_suppressed" }),
    ]));
    expect(delegateCalls).toHaveLength(0);
    expect(result.response).toContain("E-Mail");
    expect(result.response).not.toMatch(/Bau der angeforderten Datei/);
  });

  it("a claim-shaped zero-tool answer to a NON-artifact question is not suppressed (request scoping)", async () => {
    pinHybridConfig();
    // The answer pairs a claim verb with an artifact noun ("Bericht erstellt") — on an
    // artifact turn that would be a flagged false completion, but THIS request names no
    // artifact, so the answer must ship instead of being rerouted into a build.
    streamMock.mockImplementation(() => textStream(
      "Ich habe eine Übersicht als Bericht erstellt: keine neuen E-Mails seit heute Morgen.",
    ));
    const delegateCalls: Array<Record<string, unknown>> = [];
    registerArtifactlessDelegate(delegateCalls);

    const result = await runTurn({ session: makeSession(), userMessage: EMAIL_QUESTION });

    expect(result.guardrailEvents ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ details: "fabricated_zero_work_delivery_suppressed" }),
    ]));
    expect(delegateCalls).toHaveLength(0);
    expect(result.response).toContain("E-Mails");
    expect(result.response).not.toMatch(/Bau der angeforderten Datei/);
  });

  it("a fabricated tool link on a non-artifact question is REROUTED to a specialist, not built", async () => {
    pinHybridConfig();
    // The conclusive zero-work signal (a tool-minted link) still fires on any turn — but
    // the recovery must re-dispatch the ORIGINAL request via autonomous delegation
    // (no agentName), not delegate a BUILD TASK nobody asked for.
    streamMock.mockImplementation(() => textStream(
      "Deine neuen E-Mails stehen hier zum Download bereit: /api/workspace/file?path=emails.html",
    ));
    const delegateCalls: Array<Record<string, unknown>> = [];
    registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async (args: Record<string, unknown>) => {
        delegateCalls.push(args);
        return {
          success: true,
          output: "Delegated result from mail_agent — TASK COMPLETED.\nObserved evidence:\n"
            + "Sie haben 2 ungelesene E-Mails:\n- Betreff A (heute 16:24)\n- Betreff B (heute 13:18)",
          metadata: { agentName: "mail_agent", attemptedAgents: ["mail_agent"], delegationOutcome: "success" },
        };
      }),
    });

    const result = await runTurn({ session: makeSession(), userMessage: EMAIL_QUESTION });

    expect(result.guardrailEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ details: "fabricated_zero_work_delivery_suppressed" }),
      expect.objectContaining({ details: "fabricated_zero_work_corrective_reroute" }),
    ]));
    // Exactly ONE delegation: the original request, routed autonomously — no BUILD TASK.
    expect(delegateCalls).toHaveLength(1);
    expect(delegateCalls[0]!["agentName"]).toBeUndefined();
    expect(String(delegateCalls[0]!["task"])).toContain("Emails");
    expect(String(delegateCalls[0]!["task"])).not.toContain("BUILD TASK");
    // The user gets the specialist's answer — not the invented link, not a build banner.
    expect(result.response).toContain("ungelesene E-Mails");
    expect(result.response).not.toContain("/api/workspace/file");
    expect(result.response).not.toMatch(/Bau der angeforderten Datei/);
  });
});
