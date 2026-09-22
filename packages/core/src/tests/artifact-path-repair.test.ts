import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: () => null,
    createChatProvider: () => provider,
    tierModelDefaults: (tier: string) => (tier === "routing" ? { enableThinking: false, reasoningEffort: "none" } : {}),
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
  moderateToolResultText: vi.fn(async () => null),
}));

vi.mock("../guardrails/output.js", () => ({
  scanOutput: vi.fn((text: string) => ({ safe: true, redacted: text })),
}));

vi.mock("../audit/logger.js", () => ({
  logAudit: vi.fn(),
}));

import {
  collectSessionArtifactPaths,
  repairArtifactPathReferences,
  workspaceFileExists,
} from "../agent/artifact-path-repair.js";
import { AgentSession, resetSessionsForTests } from "../agent/session.js";
import { runTurn } from "../agent/runtime.js";
import { logAudit } from "../audit/logger.js";
import { resetConfigForTests } from "../config/loader.js";
import { registerTool, unregisterTool } from "../tools/registry.js";

// Session f4ebf47b. generate_image wrote these 13-digit names; the local model copied the
// T2 name into its image link with one digit missing, and the specialist's T3 text did the
// same to the _v2 name.
const DIR = "generated/.starlingai/generated";
const T1 = `${DIR}/image-1790107355849.png`;
const T2 = `${DIR}/image-1790107355849_realistic.png`;
const T3 = `${DIR}/image-1790107355849_realistic_v2.png`;
const T2_DROPPED = `${DIR}/image-179010735849_realistic.png`;
const T3_DROPPED = `${DIR}/image-179010735849_realistic_v2.png`;

const T2_ANSWER = [
  "Hier ist die realistischere Version basierend auf der ursprünglichen Komposition:",
  "",
  `![Sonnenuntergang am Strand – realistisch](${T2_DROPPED})`,
  "",
  "Die gleiche Komposition wurde fotorealistisch neu interpretiert — echte Texturen, natürliche Beleuchtung, "
    + `atmosphärischer Nebel, Filmkorn und authentische Lichtbrechung auf dem Wasser. Gespeichert unter **\`${T2}\`**.`,
].join("\n");

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetConfigForTests();
  unregisterTool("delegate_to_agent");
  streamMock.mockReset();
  completeMock.mockClear();
  vi.mocked(logAudit).mockClear();
  resetSessionsForTests();
});

describe("repairArtifactPathReferences", () => {
  it("repairs the T2 image link and leaves the correct bold path in the same answer alone", () => {
    const result = repairArtifactPathReferences(T2_ANSWER, [T1, T2]);
    expect(result.text).toContain(`](${T2})`);
    expect(result.text).not.toContain(T2_DROPPED);
    expect(result.text).toContain(`**\`${T2}\`**`);
    expect(result.repairs).toEqual([{ from: T2_DROPPED, to: T2 }]);
  });

  it("repairs the T3 name to _v2 even though the _realistic sibling is also known", () => {
    const result = repairArtifactPathReferences(`Observed evidence:\n${T3_DROPPED}`, [T1, T2, T3]);
    expect(result.text).toBe(`Observed evidence:\n${T3}`);
    expect(result.repairs).toEqual([{ from: T3_DROPPED, to: T3 }]);
  });

  it("repairs a bare filename and keeps it bare", () => {
    const result = repairArtifactPathReferences("Datei: image-179010735849.png.", [T1]);
    expect(result.text).toBe("Datei: image-1790107355849.png.");
  });

  it("repairs a doubled character, and keeps the token's own folder prefix", () => {
    const result = repairArtifactPathReferences(".starlingai/generated/image-17901073555849.png", [T1]);
    expect(result.text).toBe(".starlingai/generated/image-1790107355849.png");
  });

  it("leaves a reference alone when the file it names exists", () => {
    const workspace = mkdtempSync(join(tmpdir(), "sai-path-repair-"));
    tempDirs.push(workspace);
    mkdirSync(join(workspace, DIR), { recursive: true });
    writeFileSync(join(workspace, T2_DROPPED), "png");
    const result = repairArtifactPathReferences(T2_ANSWER, [T1, T2], workspaceFileExists(workspace));
    expect(result.text).toBe(T2_ANSWER);
    expect(result.repairs).toEqual([]);
  });

  it("never counts a changed character, only dropped or doubled ones", () => {
    const text = "See reports/quarterly-report-2024.pdf";
    expect(repairArtifactPathReferences(text, ["reports/quarterly-report-2025.pdf"]).text).toBe(text);
  });

  it("never changes a short number by a dropped or doubled digit — that is another file", () => {
    // report-2024-11 and report-2024-1 are different reports; 100 and 1000 are different sizes.
    const dropped = "See reports/monthly-report-2024-1.pdf";
    expect(repairArtifactPathReferences(dropped, ["reports/monthly-report-2024-11.pdf"]).text).toBe(dropped);
    const doubled = "Rendered exports/banner-width-1000.png";
    expect(repairArtifactPathReferences(doubled, ["exports/banner-width-100.png"]).text).toBe(doubled);
  });

  it("never treats an added suffix as a doubled character", () => {
    const text = "Next version: charts/sales-chart-overview-2.png";
    expect(repairArtifactPathReferences(text, ["charts/sales-chart-overview.png"]).text).toBe(text);
  });

  it("never moves a reference to a file with another extension", () => {
    const text = "docs/release-notes-2026.md";
    expect(repairArtifactPathReferences(text, ["docs/release-notes-2026.mdx"]).text).toBe(text);
  });

  it("never moves a reference that already names a known file to a near sibling", () => {
    const text = `${DIR}/image-179010735849.png`;
    const known = [`${DIR}/image-1790107355849.png`, `${DIR}/image-179010735849.png`];
    expect(repairArtifactPathReferences(text, known).text).toBe(text);
  });

  it("leaves an ambiguous reference alone when two artifacts are each one drop away", () => {
    const text = `${DIR}/image-179010735584.png`;
    const known = [`${DIR}/image-1790107355849.png`, `${DIR}/image-1790107355842.png`];
    expect(repairArtifactPathReferences(text, known).text).toBe(text);
  });

  it("leaves URLs, short names, other extensions, other folders and version strings alone", () => {
    const known = [T2, "out/a-1234.png", "docs/final-report-v12.docx"];
    const text = [
      `https://example.com/${T2_DROPPED}`,
      "out/a-123.png",
      `${DIR}/image-179010735849_realistic.jpg`,
      "elsewhere/image-179010735849_realistic.png",
      "Version 1.2.3 / example.com",
    ].join("\n");
    const result = repairArtifactPathReferences(text, known);
    expect(result.text).toBe(text);
    expect(result.repairs).toEqual([]);
  });

  it("changes nothing on a second pass", () => {
    const once = repairArtifactPathReferences(T2_ANSWER, [T1, T2]).text;
    const twice = repairArtifactPathReferences(once, [T1, T2]);
    expect(twice.text).toBe(once);
    expect(twice.repairs).toEqual([]);
  });
});

describe("collectSessionArtifactPaths", () => {
  it("reads tool metadata at the top level and in nested artifacts, and earlier answers' attachments", () => {
    const history = [
      { role: "user", content: "T1" },
      { role: "tool", content: "done", metadata: { agentName: "image_creator", artifacts: [{ outputPath: T1, filename: "image-1790107355849.png" }] } },
      { role: "assistant", content: "T1 answer", metadata: { attachments: [{ filename: "image-1790107355849.png", relativePath: T1 }] } },
      { role: "tool", content: "done", metadata: { outputPath: T2, filename: "image-1790107355849_realistic.png" } },
      { role: "assistant", content: "only this survived trimming", metadata: { attachments: [{ filename: "x", relativePath: T3 }] } },
    ];
    expect(collectSessionArtifactPaths(history)).toEqual([T1, T2, T3]);
  });
});

describe("the final answer is repaired where it is saved and where it is returned", () => {
  it("fixes the T2 image link in both the returned response and the saved message", async () => {
    let llmCalls = 0;
    streamMock.mockImplementation(() => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return (async function* () {
          yield { type: "tool_call_start", toolCallId: "t2", toolName: "delegate_to_agent" };
          yield { type: "tool_call_delta", toolCallId: "t2", argumentsDelta: JSON.stringify({ agentName: "image_creator", task: "Mach es viel realer." }) };
          yield { type: "done", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
        })();
      }
      return (async function* () {
        yield { type: "text_delta", content: T2_ANSWER };
        yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      })();
    });
    registerTool({
      name: "delegate_to_agent",
      description: "Delegate to a specialist.",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => ({
        success: true,
        output: [
          "Delegated result from image_creator — TASK COMPLETED.",
          "Observed evidence:",
          "Die realistischere Version des Sonnenuntergangs am Strand wurde generiert und gespeichert unter:",
          "",
          T2,
        ].join("\n"),
        metadata: {
          agentName: "image_creator",
          attemptedAgents: ["image_creator"],
          delegationSucceeded: true,
          delegationOutcome: "success",
          terminalState: "completed",
          artifacts: [{
            sourceAgent: "image_creator",
            sourceTool: "generate_image",
            outputPath: T2,
            filename: "image-1790107355849_realistic.png",
            contentType: "image/png",
          }],
        },
      })),
    });

    // The real files are on disk, as they were live, so the turn's artifact check passes and the
    // answer reaches the user unchanged apart from the repair.
    const workspace = mkdtempSync(join(tmpdir(), "sai-path-repair-turn-"));
    tempDirs.push(workspace);
    mkdirSync(join(workspace, DIR), { recursive: true });
    for (const path of [T1, T2]) writeFileSync(join(workspace, path), ONE_PIXEL_PNG);

    const session = new AgentSession({ channel: "test", workspacePath: workspace, systemPrompt: "You are a test agent." });
    // T1, as it was saved: its tool result and its answer.
    session.addMessage({ role: "user", content: "Erstelle ein Bild von einem Sonnenuntergang am Strand" });
    session.addMessage({ role: "tool", content: `Observed evidence:\n${T1}`, tool_call_id: "t1", metadata: { artifacts: [{ outputPath: T1, filename: "image-1790107355849.png" }] } } as never);
    session.addMessage({ role: "assistant", content: `![Sonnenuntergang](${T1})`, metadata: { attachments: [{ filename: "image-1790107355849.png", relativePath: T1 }] } });

    const result = await runTurn({ session, userMessage: "Mach es viel realer, gleiche Komposition" });

    expect(result.response).toBe(T2_ANSWER.replace(T2_DROPPED, T2));
    const saved = session.getHistory().filter((message) => message.role === "assistant" && message.content).at(-1);
    expect(saved?.content).toBe(result.response);
    expect(vi.mocked(logAudit)).toHaveBeenCalledWith(
      "artifact_path_repaired",
      { surface: "final_answer", from: T2_DROPPED, to: T2 },
      expect.objectContaining({ sessionId: session.id }),
    );
  });
});
