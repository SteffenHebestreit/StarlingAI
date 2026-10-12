import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tools/registry.js";

/**
 * A REPAIR DOES NOT REPLACE THE ANSWER IT WAS NOT ABOUT.
 *
 * E2E 2026-10-12, core-ix-workflow-scene-research-brief (session 5f917059): the scene's agents wrote
 * the research brief and an evidence ledger page. The page check called the ledger broken, the
 * completion gate ran its corrective build, content_writer repaired one function in the page, and
 * the gate then shipped the build's confirmation in place of the answer. The confirmation came back
 * short, so the user got "Die angeforderte Datei wurde erstellt: …" and none of the facts.
 *
 * Driven through applyTerminalResponseGuards with a real workspace: the page on disk is what the
 * gate reads, and the mocked build repairs it (or does not) the way content_writer would.
 */
const audit = vi.hoisted(() => [] as Array<{ type: string; data: Record<string, unknown> }>);
vi.mock("../audit/logger.js", () => ({
  logAudit: (type: string, data: Record<string, unknown>) => { audit.push({ type, data }); },
  subscribeToAudit: () => () => {},
}));

const { applyTerminalResponseGuards, repairedArtifactsNote } = await import("../agent/turn-finalize-guards.js");
const { classifyDeliverableIntent } = await import("../agent/deliverable-intent.js");
const { AgentSession, resetSessionsForTests } = await import("../agent/session.js");
const { getConfig, resetConfigForTests } = await import("../config/loader.js");
const { runWithRequestContext } = await import("../runtime/request-context.js");
const { _resetPageVerdictsForTests } = await import("../tools/page-check.js");

const BRIEF_REQUEST = "Erstelle ein kurzes, faktengeprüftes Briefing über die Nordlicht Werkzeuge GmbH als Markdown-Datei und ein Evidenz-Ledger als HTML-Seite.";
const BRIEF = [
  "## Briefing: Nordlicht Werkzeuge GmbH",
  "",
  "- Gegründet 1987 (Quelle: Über-uns-Seite der Firmenwebsite)",
  "- 146 Mitarbeitende",
  "- Drei Lagerstandorte: Kiel, Lübeck und Flensburg",
  "- Sortiment: 18 Artikel im Online-Katalog",
  "",
  "Offene Frage: Die Website nennt kein Datum für die Mitarbeiterzahl.",
  "",
  "Dateien: generated/briefing_nordlicht_werkzeuge.md, generated/evidence_ledger.html",
].join("\n");
const BUILD_CONFIRMATION = "Die angeforderte Datei wurde erstellt: generated/evidence_ledger.html.\n\n(The requested file was built: generated/evidence_ledger.html.)";

const LEDGER = "generated/evidence_ledger.html";
/** The ledger as the scene left it: one function asks for an element the page does not have. */
const BROKEN_LEDGER = `<!DOCTYPE html><html><body><table id="ledger"></table><span id="total"></span>
<script>
"use strict";
function renderTotal() { document.getElementById("summe").textContent = "4"; }
renderTotal();
</script></body></html>`;
/** content_writer's repair: the function writes to the element the page declares. */
const REPAIRED_LEDGER = BROKEN_LEDGER.replace('getElementById("summe")', 'getElementById("total")');

describe("the completion gate's corrective build, on a turn that answered and left a faulty page", () => {
  let workspace = "";

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "sai-repair-keeps-answer-"));
    mkdirSync(join(workspace, "generated"), { recursive: true });
    audit.length = 0;
    _resetPageVerdictsForTests();
    // Its own probe would run on the attachments the mocks report; this file is about the gate.
    getConfig().orchestration.verifyArtifacts = false;
  });

  afterEach(() => {
    resetConfigForTests();
    resetSessionsForTests();
    rmSync(workspace, { recursive: true, force: true });
  });

  /** The guard context of a turn whose answer is `answer`, built on the workspace above. */
  const turnCtx = (opts: {
    request: string;
    answer: string;
    attachments: () => Array<Record<string, unknown>>;
    build: () => Promise<string | null>;
    buildRan: () => boolean;
  }) => {
    const session = new AgentSession({ channel: "test", workspacePath: workspace, systemPrompt: "You are a test agent." });
    /** What each corrective build was asked for: { confirm: false } when the turn keeps its answer. */
    const buildOptions: unknown[] = [];
    return {
      buildOptions,
      signal: new AbortController().signal,
      session,
      provider: {} as never,
      userMessage: opts.request,
      toolContext: { sessionId: session.id, workspacePath: workspace } as ToolContext,
      deliverableIntent: classifyDeliverableIntent(opts.request),
      initialDynamicGuidance: null,
      rawResponse: opts.answer,
      iterationCount: 3,
      effectiveToolIterations: 3,
      terminalFinishReason: "stop",
      toolCallsRequested: 4,
      // The scene's agents wrote their files during this turn.
      turnStartedAtMs: Date.now() - 60_000,
      currentTurnHasExecutableOrchestration: true,
      forcedSynthesisFired: false,
      consecutiveDelegationFailures: 0,
      turnToolCallCounts: new Map<string, number>([["delegate_to_agent", 4]]),
      turnShareFindingCount: 0,
      turnKnowledgeBaseSourceUrls: new Set<string>(),
      workflowRunCompletedThisTurn: true,
      releasedWithoutResearchEvidence: false,
      autoResearchAnswer: null,
      outputScan: { safe: true, redacted: opts.answer } as never,
      getTurnDelegationCount: () => 4,
      getQaCorrectiveBuildUsed: opts.buildRan,
      incrementDelegationCount: () => undefined,
      guardrailEvents: [] as Array<{ type: string; details: string }>,
      finalizeUserFacingAssistantResponse: async (raw: string) => raw,
      forceSynthesis: async () => null,
      collectTurnArtifactAttachments: opts.attachments,
      runQaDeliveryGate: async () => { throw new Error("no plan, so the QA delivery loop must not run"); },
      runDeliverableConsistencyGate: async () => { throw new Error("deliverableConsistencyQa is off"); },
      runCorrectiveBuild: (_context: string, options?: unknown) => { buildOptions.push(options); return opts.build(); },
      runCorrectiveReroute: async () => null,
      logWarn: () => undefined,
    };
  };

  const sceneFiles = () => [
    { relativePath: "generated/briefing_nordlicht_werkzeuge.md", filename: "briefing_nordlicht_werkzeuge.md" },
    { relativePath: LEDGER, filename: "evidence_ledger.html" },
  ];

  it("keeps the researched answer and adds one line naming the repaired file", async () => {
    writeFileSync(join(workspace, "generated", "briefing_nordlicht_werkzeuge.md"), BRIEF, "utf8");
    writeFileSync(join(workspace, LEDGER), BROKEN_LEDGER, "utf8");
    let buildRan = false;
    const ctx = turnCtx({
      request: BRIEF_REQUEST,
      answer: BRIEF,
      attachments: sceneFiles,
      buildRan: () => buildRan,
      build: async () => {
        buildRan = true;
        writeFileSync(join(workspace, LEDGER), REPAIRED_LEDGER, "utf8");
        return LEDGER;
      },
    });

    const reply = await applyTerminalResponseGuards(ctx as never);

    expect(buildRan).toBe(true);
    // The answer is kept, so the build writes no confirmation of its own.
    expect(ctx.buildOptions).toEqual([{ confirm: false }]);
    // Every fact the scenario checks is still in the reply.
    for (const fact of ["1987", "146", "Kiel", "Lübeck", "Flensburg", "18 Artikel"]) expect(reply).toContain(fact);
    expect(reply.startsWith(BRIEF)).toBe(true);
    expect(reply).not.toContain("Die angeforderte Datei wurde erstellt");
    // One line after it, naming the file the build repaired.
    const added = reply.slice(BRIEF.length).trim();
    expect(added.split("\n")).toHaveLength(1);
    expect(added).toContain(LEDGER);
    expect(added).toMatch(/repariert|repaired/);
    expect(ctx.guardrailEvents).toEqual([{ type: "guardrail_flagged", details: "final_qa_corrective_build_repaired_artifact" }]);
    expect(audit.filter((row) => row.data["type"] === "final_qa_corrective_build_repair_checked").map((row) => row.data))
      .toEqual([expect.objectContaining({ repaired: [LEDGER], unrepaired: [], buildReturned: true })]);
  }, 60_000);

  it("keeps the answer when the build produced nothing, and says the file is still faulty", async () => {
    writeFileSync(join(workspace, LEDGER), BROKEN_LEDGER, "utf8");
    let buildRan = false;
    const ctx = turnCtx({
      request: BRIEF_REQUEST,
      answer: BRIEF,
      attachments: sceneFiles,
      buildRan: () => buildRan,
      build: async () => { buildRan = true; return null; },
    });

    const reply = await applyTerminalResponseGuards(ctx as never);

    expect(buildRan).toBe(true);
    expect(reply.startsWith(BRIEF)).toBe(true);
    const added = reply.slice(BRIEF.length).trim();
    expect(added.split("\n")).toHaveLength(1);
    expect(added).toContain(LEDGER);
    expect(added).not.toMatch(/nachträglich repariert|repaired since/);
    expect(ctx.guardrailEvents).toEqual([]);
  }, 60_000);

  it("keeps the answer unchanged when no build ran (a step whose scope does not allow the builder)", async () => {
    writeFileSync(join(workspace, LEDGER), BROKEN_LEDGER, "utf8");
    const ctx = turnCtx({
      request: BRIEF_REQUEST,
      answer: BRIEF,
      attachments: sceneFiles,
      buildRan: () => false,
      build: async () => null,
    });

    expect(await applyTerminalResponseGuards(ctx as never)).toBe(BRIEF);
  }, 60_000);

  it("ships the build's confirmation when the turn wrote too little to be an answer", async () => {
    writeFileSync(join(workspace, LEDGER), BROKEN_LEDGER, "utf8");
    let buildRan = false;
    const ctx = turnCtx({
      request: BRIEF_REQUEST,
      answer: "Fertig: generated/evidence_ledger.html",
      attachments: sceneFiles,
      buildRan: () => buildRan,
      build: async () => {
        buildRan = true;
        writeFileSync(join(workspace, LEDGER), REPAIRED_LEDGER, "utf8");
        return BUILD_CONFIRMATION;
      },
    });

    expect(await applyTerminalResponseGuards(ctx as never)).toBe(BUILD_CONFIRMATION);
    expect(ctx.buildOptions).toEqual([undefined]);
    expect(ctx.guardrailEvents).toEqual([{ type: "guardrail_flagged", details: "final_qa_corrective_build_normal_path" }]);
  }, 60_000);

  it("still replaces a description with the build's confirmation when the turn described an app instead of building it", async () => {
    const appRequest = "Baue eine WebApp zum Lernen mit einem interaktiven Quiz.";
    const concept = "Hier ist ein Konzept für die WebApp: Tabs für Quiz, Curriculum und Statistiken. "
      + "Das Quiz könnte 38 Fragen aus dem offiziellen Mock-Exam nutzen und clientseitig auswerten.";
    const built = "Die WebApp wurde gebaut und liegt unter generated/quiz/index.html — Quiz, Curriculum und Statistik-Tabs sind enthalten und funktionieren ohne Server.";
    let buildRan = false;
    const ctx = turnCtx({
      request: appRequest,
      answer: concept,
      // Nothing was built until the corrective build wrote the app.
      attachments: () => (buildRan ? [{ relativePath: "generated/quiz/index.html", filename: "index.html" }] : []),
      buildRan: () => buildRan,
      build: async () => {
        buildRan = true;
        mkdirSync(join(workspace, "generated", "quiz"), { recursive: true });
        writeFileSync(join(workspace, "generated", "quiz", "index.html"), "<html><body><div id=\"q\"></div><script>document.getElementById('q').textContent='1';</script></body></html>", "utf8");
        return built;
      },
    });

    expect(await applyTerminalResponseGuards(ctx as never)).toBe(built);
    expect(ctx.buildOptions).toEqual([undefined]);
    expect(ctx.guardrailEvents).toEqual([{ type: "guardrail_flagged", details: "final_qa_corrective_build_normal_path" }]);
  }, 60_000);
});

describe("repairedArtifactsNote", () => {
  it("names the repaired and the unrepaired files in one line, in the language the person wrote in", () => {
    const en = runWithRequestContext({ userMessageLanguage: "English" }, () => repairedArtifactsNote([LEDGER], ["generated/b.html", "generated/c.html"]));
    expect(en).toBe(`Note: ${LEDGER} was incomplete or broken and has been repaired since. generated/b.html, generated/c.html are still incomplete or broken; the automatic repair did not fix them.`);
    const de = runWithRequestContext({ userMessageLanguage: "German" }, () => repairedArtifactsNote([LEDGER], []));
    expect(de).toBe(`Hinweis: ${LEDGER} war unvollständig oder fehlerhaft und wurde nachträglich repariert.`);
    expect(repairedArtifactsNote([], [])).toBeNull();
  });
});
