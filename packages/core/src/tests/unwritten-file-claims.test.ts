import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolContext } from "../tools/registry.js";

/**
 * A REPLY THAT NAMES, AS SAVED, A FILE THE TURN FAILED TO WRITE.
 *
 * Harness-lab validation 2026-10-19: diagram_designer asked generate_mermaid_diagram for
 * diagramme/abhaengigkeiten.md, the tool refused the name, the agent did not retry, and the reply
 * said the diagram was saved under that name. The request ("show me the dependencies as a
 * diagram") asks for no file, so the false-completion banner, which needs one, never ran.
 */
const audit = vi.hoisted(() => [] as Array<{ type: string; data: Record<string, unknown> }>);
vi.mock("../audit/logger.js", () => ({
  logAudit: (type: string, data: Record<string, unknown>) => { audit.push({ type, data }); },
  subscribeToAudit: () => () => {},
}));

const { failedWriteTarget, namedUnwrittenFiles, turnUnwrittenTargets, unwrittenFilesBanner } = await import("../agent/unwritten-file-claims.js");
const { claimsArtifactWrittenButUnproduced, namesOnlyAsNotDone, classifyDeliverableIntent } = await import("../agent/deliverable-intent.js");
const { applyTerminalResponseGuards } = await import("../agent/turn-finalize-guards.js");
const { AgentSession, resetSessionsForTests } = await import("../agent/session.js");
const { getConfig, resetConfigForTests } = await import("../config/loader.js");

const TARGET = "diagramme/abhaengigkeiten.md";
const REFUSAL = { agent: "diagram_designer", tool: "generate_mermaid_diagram", error: "output_file must use the .mmd extension", target: TARGET };
const REQUEST = "Zeig mir die Abhängigkeiten zwischen Gateway, Core und Web als Diagramm.";
const FALSE_REPLY = "Das Diagramm wurde erfolgreich erstellt und unter diagramme/abhaengigkeiten.md gespeichert. Es zeigt, dass Web und Gateway beide auf Core aufbauen.";
const HONEST_REPLY = "Das Diagramm konnte unter diagramme/abhaengigkeiten.md nicht gespeichert werden; hier ist der Mermaid-Quelltext.";

type Message = Parameters<typeof turnUnwrittenTargets>[0][number];
const user = (content: string, metadata?: Record<string, unknown>): Message => ({ role: "user", content, ...(metadata ? { metadata } : {}) });
const delegation = (id: string): Message => ({ role: "assistant", content: "", tool_calls: [{ id, function: { name: "delegate_to_agent", arguments: "{\"agentName\":\"diagram_designer\"}" } }] });
const delegated = (id: string, failures: unknown[]): Message => ({ role: "tool", tool_call_id: id, content: "Delegated result from diagram_designer — TASK COMPLETED.", metadata: { specialistToolFailures: failures } });

describe("failedWriteTarget", () => {
  it.each([
    ["generate_mermaid_diagram", { output_file: "d.md" }, "d.md"],
    ["generate_pdf", { output_file: " report.pdf " }, "report.pdf"],
    ["write_file", { path: "notes/a.txt" }, "notes/a.txt"],
    ["edit_file", { file_path: "src/x.ts" }, "src/x.ts"],
    ["read_file", { path: "notes/a.txt" }, undefined],
    ["web_fetch", { url: "https://example.com/a.md" }, undefined],
    ["write_file", {}, undefined],
  ])("%s %j → %s", (tool, args, target) => {
    expect(failedWriteTarget(tool, args)).toBe(target);
  });
});

describe("turnUnwrittenTargets", () => {
  it("reads the targets of this turn's delegated failures, not an earlier turn's", () => {
    const history = [
      user("Erstell mir einen Bericht."),
      delegation("d0"),
      delegated("d0", [{ ...REFUSAL, target: "berichte/alt.md" }]),
      { role: "assistant", content: "Fertig." } as Message,
      user(REQUEST),
      delegation("d1"),
      delegated("d1", [REFUSAL, { tool: "web_fetch", error: "HTTP 403" }]),
    ];
    expect(turnUnwrittenTargets(history)).toEqual([TARGET]);
  });

  it("keeps the turn across a mid-turn steering message", () => {
    const history = [user(REQUEST), delegation("d1"), delegated("d1", [REFUSAL]), user("und bitte auf Deutsch", { midTurn: true })];
    expect(turnUnwrittenTargets(history)).toEqual([TARGET]);
  });

  it("leaves out a call the user declined", () => {
    expect(turnUnwrittenTargets([user(REQUEST), delegation("d1"), delegated("d1", [{ ...REFUSAL, declinedByUser: true }])])).toEqual([]);
  });

  it("reads the orchestrator's own failed write, and not its successful one", () => {
    const history: Message[] = [
      user(REQUEST),
      { role: "assistant", content: "", tool_calls: [
        { id: "w1", function: { name: "write_file", arguments: "{\"path\":\"notizen/plan.txt\"}" } },
        { id: "w2", function: { name: "write_file", arguments: "{\"path\":\"notizen/ok.txt\"}" } },
      ] },
      { role: "tool", tool_call_id: "w1", content: "Error: EACCES: permission denied" },
      { role: "tool", tool_call_id: "w2", content: "Wrote notizen/ok.txt" },
    ];
    expect(turnUnwrittenTargets(history)).toEqual(["notizen/plan.txt"]);
  });
});

describe("namedUnwrittenFiles", () => {
  const nothingExists = () => false;

  it("finds the file the false reply names as saved", () => {
    expect(namedUnwrittenFiles(FALSE_REPLY, [TARGET], nothingExists)).toEqual([TARGET]);
  });

  it("finds it by its name alone", () => {
    expect(namedUnwrittenFiles("Gespeichert als abhaengigkeiten.md.", [TARGET], nothingExists)).toEqual([TARGET]);
  });

  it("leaves out a file that exists, as given or under generated/", () => {
    expect(namedUnwrittenFiles(FALSE_REPLY, [TARGET], (ref) => ref === TARGET)).toEqual([]);
    expect(namedUnwrittenFiles(FALSE_REPLY, [TARGET], (ref) => ref === `generated/${TARGET}`)).toEqual([]);
  });

  it("leaves out a file the reply does not name, or names only as not done", () => {
    expect(namedUnwrittenFiles("Das Diagramm ist fertig.", [TARGET], nothingExists)).toEqual([]);
    expect(namedUnwrittenFiles(HONEST_REPLY, [TARGET], nothingExists)).toEqual([]);
    // Another file's real completion does not make the honest mention a claim.
    expect(namedUnwrittenFiles(`Der Bericht wurde als bericht.pdf gespeichert. ${HONEST_REPLY}`, [TARGET], nothingExists)).toEqual([]);
  });

  it("does not match a short bare name inside other words", () => {
    expect(namedUnwrittenFiles("Ich habe a.md gelesen und data.md aktualisiert.", ["x/a.md"], nothingExists)).toEqual([]);
  });
});

describe("namesOnlyAsNotDone", () => {
  it("is true only when every clause naming the file is negated", () => {
    expect(namesOnlyAsNotDone(HONEST_REPLY, TARGET)).toBe(true);
    expect(namesOnlyAsNotDone(FALSE_REPLY, TARGET)).toBe(false);
    expect(namesOnlyAsNotDone(`${HONEST_REPLY} Später habe ich es unter ${TARGET} gespeichert.`, TARGET)).toBe(false);
    expect(namesOnlyAsNotDone("Nichts davon nennt die Datei.", TARGET)).toBe(false);
  });
});

describe("a Mermaid file named as saved", () => {
  it("is a completion claim on its own, without a word for the artifact", () => {
    expect(claimsArtifactWrittenButUnproduced("Gespeichert unter diagramme/abhaengigkeiten.mmd.")).toBe(true);
  });
});

describe("the terminal guards on a turn whose write failed", () => {
  let workspace = "";

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "sai-unwritten-claims-"));
    mkdirSync(join(workspace, "generated"), { recursive: true });
    audit.length = 0;
    getConfig().orchestration.verifyArtifacts = false;
  });

  afterEach(() => {
    resetConfigForTests();
    resetSessionsForTests();
    rmSync(workspace, { recursive: true, force: true });
  });

  const turnCtx = (answer: string, failures: unknown[]) => {
    const session = new AgentSession({ channel: "test", workspacePath: workspace, systemPrompt: "You are a test agent." });
    session.addMessage({ role: "user", content: REQUEST });
    session.addMessage({ role: "assistant", content: "", tool_calls: [{ id: "d1", type: "function", function: { name: "delegate_to_agent", arguments: "{\"agentName\":\"diagram_designer\"}" } }] });
    session.addMessage({ role: "tool", tool_call_id: "d1", content: "Delegated result from diagram_designer — TASK COMPLETED.", metadata: { agentName: "diagram_designer", specialistToolFailures: failures } });
    return {
      signal: new AbortController().signal,
      session,
      provider: {} as never,
      userMessage: REQUEST,
      toolContext: { sessionId: session.id, workspacePath: workspace } as ToolContext,
      deliverableIntent: classifyDeliverableIntent(REQUEST),
      initialDynamicGuidance: null,
      rawResponse: answer,
      iterationCount: 2,
      effectiveToolIterations: 2,
      terminalFinishReason: "stop",
      toolCallsRequested: 1,
      turnStartedAtMs: Date.now() - 30_000,
      currentTurnHasExecutableOrchestration: true,
      forcedSynthesisFired: false,
      consecutiveDelegationFailures: 0,
      turnToolCallCounts: new Map<string, number>([["delegate_to_agent", 1]]),
      turnShareFindingCount: 0,
      turnKnowledgeBaseSourceUrls: new Set<string>(),
      workflowRunCompletedThisTurn: false,
      releasedWithoutResearchEvidence: false,
      autoResearchAnswer: null,
      outputScan: { safe: true, redacted: answer } as never,
      getTurnDelegationCount: () => 1,
      getQaCorrectiveBuildUsed: () => false,
      incrementDelegationCount: () => undefined,
      guardrailEvents: [] as Array<{ type: string; details: string }>,
      finalizeUserFacingAssistantResponse: async (raw: string) => raw,
      forceSynthesis: async () => null,
      collectTurnArtifactAttachments: () => [],
      runQaDeliveryGate: async () => { throw new Error("no plan, so the QA delivery loop must not run"); },
      runDeliverableConsistencyGate: async () => { throw new Error("deliverableConsistencyQa is off"); },
      runCorrectiveBuild: async () => null,
      runCorrectiveReroute: async () => null,
      logWarn: () => undefined,
    };
  };

  it("the request asks for no file, so the false-completion banner does not cover it (the precondition)", () => {
    expect(classifyDeliverableIntent(REQUEST).wantsArtifactMutation).toBe(false);
  });

  it("puts the not-saved banner over the reply of the validation run, and keeps the reply", async () => {
    const ctx = turnCtx(FALSE_REPLY, [REFUSAL]);
    const reply = await applyTerminalResponseGuards(ctx as never);
    expect(reply).toBe(unwrittenFilesBanner([TARGET]) + FALSE_REPLY);
    expect(ctx.guardrailEvents).toContainEqual({ type: "guardrail_flagged", details: "unwritten_file_claimed_bannered" });
    expect(audit.filter((row) => row.data["type"] === "unwritten_file_claimed_bannered").map((row) => row.data["files"])).toEqual([[TARGET]]);
  });

  it("leaves an honest reply alone", async () => {
    const ctx = turnCtx(HONEST_REPLY, [REFUSAL]);
    expect(await applyTerminalResponseGuards(ctx as never)).toBe(HONEST_REPLY);
  });

  it("leaves a reply alone that names the file without saying it was saved", async () => {
    const reply = "Der Mermaid-Quelltext für diagramme/abhaengigkeiten.md folgt unten, zum Einfügen in die Doku.";
    const ctx = turnCtx(reply, [REFUSAL]);
    expect(await applyTerminalResponseGuards(ctx as never)).toBe(reply);
  });

  it("leaves the reply alone when the file exists (a retry wrote it)", async () => {
    mkdirSync(join(workspace, "generated", "diagramme"), { recursive: true });
    writeFileSync(join(workspace, "generated", TARGET), "graph TD; A-->B", "utf8");
    const ctx = turnCtx(FALSE_REPLY, [REFUSAL]);
    expect(await applyTerminalResponseGuards(ctx as never)).toBe(FALSE_REPLY);
  });

  it("leaves the reply alone when no write failed (a file on another host)", async () => {
    const reply = "Ich habe die Datei diagramme/abhaengigkeiten.md auf dem Server aktualisiert.";
    const ctx = turnCtx(reply, [{ tool: "web_fetch", error: "HTTP 403" }]);
    expect(await applyTerminalResponseGuards(ctx as never)).toBe(reply);
  });
});
