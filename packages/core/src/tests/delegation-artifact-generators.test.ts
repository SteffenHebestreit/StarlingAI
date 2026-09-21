/**
 * A generator that writes a file into the workspace HAS produced a deliverable.
 *
 * Session 2c6bdb30 is the proof that this was not obvious enough. image_creator was asked
 * for a sunset, called `generate_image`, saved a 1.5 MB PNG and recorded the artifact — and
 * the delegation was classified a FAILURE. `ARTIFACT_PRODUCING_TOOLS` held
 * `generate_document`, `generate_website`, `generate_pdf` and `fetch_image`, but not
 * `generate_image`, so `looksLikeArtifactDeliverableMiss` saw an agent that owned artifact
 * tools, was asked for a deliverable, and appeared to have called none of them.
 *
 * Only the best-partial fallback rescued the turn, so the user still got their picture — but
 * every image delegation came back `partialFallback: true`, tripped the
 * source_sensitive_failed_delegation_evidence_backstop, and told the orchestrator its
 * specialist had failed at the thing it had just done.
 *
 * The gap was general rather than about images: ten workspace-writing tools were absent, so
 * audio, charts, diagrams, spreadsheets, pentest reports and PDF form-filling were all
 * misjudged the same way. These tests are written per capability so that adding a generator
 * without adding it here shows up as a named failure.
 */
import { describe, expect, it } from "vitest";

import {
  ARTIFACT_PRODUCING_TOOLS,
  classifyDelegationResult,
  looksLikeArtifactDeliverableMiss,
} from "../tools/delegation-artifact-classification.js";

type Cfg = import("../config/schema.js").SubAgentConfig;
const agent = (tools: string[]): Cfg => ({ tools } as unknown as Cfg);

const DELIVERABLE_TASK = "Erstelle ein Bild eines Sonnenuntergangs am Strand.";

describe("generators that write into the workspace", () => {
  it("counts every workspace-writing generator as artifact-producing", () => {
    // Named individually: a set membership assertion that loops over the set itself would be
    // tautological, and this is the list whose absence caused the misclassification.
    for (const tool of [
      "generate_image", "transform_image", "generate_svg", "generate_qr_code",
      "synthesize_speech", "generate_chart_html", "generate_mermaid_diagram",
      "spreadsheet_write", "pdf_fill", "pentest_report", "export_evidence_ledger",
    ]) {
      expect(ARTIFACT_PRODUCING_TOOLS.has(tool), `${tool} must count as producing an artifact`).toBe(true);
    }
  });

  it("does NOT treat a read-only tool as artifact-producing — the control", () => {
    // Without this, a set that had simply been filled with every tool name would pass the
    // case above while making the miss-detector unable to detect anything at all.
    for (const tool of ["read_file", "list_files", "analyze_image", "read_shared_facts", "web_search"]) {
      expect(ARTIFACT_PRODUCING_TOOLS.has(tool), `${tool} must not count`).toBe(false);
    }
  });

  it("no longer calls a successful image generation a deliverable MISS", () => {
    const stats = { toolCount: 1, toolNames: ["generate_image"], terminalState: "completed", outcome: "success" };
    expect(looksLikeArtifactDeliverableMiss(DELIVERABLE_TASK, stats, agent(["generate_image", "write_file"]))).toBe(false);
  });

  it("still catches an agent that narrated and called NOTHING — the control that matters", () => {
    // This is the behaviour the set exists for, and widening it must not blunt it.
    const stats = { toolCount: 0, toolNames: [], terminalState: "completed", outcome: "success" };
    expect(looksLikeArtifactDeliverableMiss(DELIVERABLE_TASK, stats, agent(["generate_image", "write_file"]))).toBe(true);
  });

  it("still catches an agent that only READ when asked to produce", () => {
    const stats = { toolCount: 2, toolNames: ["read_file", "analyze_image"], terminalState: "completed", outcome: "success" };
    expect(looksLikeArtifactDeliverableMiss(DELIVERABLE_TASK, stats, agent(["generate_image", "read_file", "analyze_image"]))).toBe(true);
  });

  it("classifies the session-2c6bdb30 delegation as SUCCESS, not failure", () => {
    // The real shape, from the audit: one tool call, terminalState completed, artifact
    // recorded with its path and byte count.
    const output = "Das Bild eines Sonnenuntergangs am Strand wurde erfolgreich generiert und gespeichert unter:"
      + " generated/.starlingai/generated/image-1790026186413.png";
    const stats = { toolCount: 1, toolNames: ["generate_image"], terminalState: "completed", outcome: "success" };
    const artifacts = [{
      sourceAgent: "image_creator", sourceTool: "generate_image",
      outputPath: "generated/.starlingai/generated/image-1790026186413.png",
      bytes: 1565883, contentType: "image/png",
    }];

    const verdict = classifyDelegationResult(
      output, "success", stats, agent(["generate_image", "analyze_image", "write_file"]),
      "image_creator", "Generiere ein Bild eines Sonnenuntergangs am Strand.", artifacts,
    );

    expect(verdict).toBe("success");
  });

  it("does the same for the other capabilities that were misjudged", () => {
    const cases: Array<[string, string, string]> = [
      ["synthesize_speech", "Erstelle eine Sprachaufnahme des Textes.", "audio_agent"],
      ["generate_chart_html", "Erstelle ein Diagramm der Umsatzzahlen.", "chart_designer"],
      ["generate_mermaid_diagram", "Erstelle ein Architekturdiagramm.", "diagram_designer"],
      ["spreadsheet_write", "Erstelle eine Excel-Datei mit den Daten.", "sql_specialist"],
    ];
    for (const [tool, task, name] of cases) {
      const stats = { toolCount: 1, toolNames: [tool], terminalState: "completed", outcome: "success" };
      const verdict = classifyDelegationResult(
        `Fertig, gespeichert unter generated/out-${tool}.bin`, "success", stats,
        agent([tool, "write_file"]), name, task, [{ sourceTool: tool, outputPath: "generated/out.bin" }],
      );
      expect(verdict, `${tool} should classify as success`).toBe("success");
    }
  });
});
