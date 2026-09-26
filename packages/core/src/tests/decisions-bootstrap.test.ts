/**
 * decisions:bootstrap — the incumbents' labels for synthetic messages, as training data for fast_lane and
 * source_sensitive. The labels must be what a turn's incumbent would say, and the rows must never count as the
 * gate's evidence. The routing tier is a fake.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "sai-decisions-bootstrap-"));
const configPath = join(tempDir, "starlingai.json");

beforeAll(async () => {
  writeFileSync(configPath, JSON.stringify({
    workspacePath: tempDir,
    gateway: { jwtSecret: "t".repeat(32) },
    decisions: { ledger: { path: join(tempDir, "decisions", "ledger.jsonl") } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  (await import("../config/loader.js")).resetConfigForTests();
  await (await import("../agent/text-language.js")).warmTextLanguageDetector();
});

afterAll(() => {
  delete process.env["SAI_CONFIG_PATH"];
  rmSync(tempDir, { recursive: true, force: true });
});

function model(reply: string) {
  const complete = vi.fn(async (..._args: unknown[]) => ({ content: reply, tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" }));
  return { complete, provider: { complete } as never };
}

describe("the messages", () => {
  it("takes the strings of a generated JSON array, once each, and nothing else", async () => {
    const { parseGenerated } = await import("../scripts/decisions-bootstrap.js");
    expect(parseGenerated('Here you go:\n["Hallo!", "Was kostet ein Deutschlandticket?", "Hallo!", 42, " ", "x"]')).toEqual(["Hallo!", "Was kostet ein Deutschlandticket?"]);
    expect(parseGenerated("no array here")).toEqual([]);
    expect(parseGenerated("[not json")).toEqual([]);
  });

  it("asks for the kind, the language and the count", async () => {
    const { generationMessages, MESSAGE_KINDS } = await import("../scripts/decisions-bootstrap.js");
    const [system, user] = generationMessages(MESSAGE_KINDS[2]!, "German", 20, 3);
    expect(system!.content).toContain("JSON array of strings");
    expect(user!.content).toContain("20 different messages in German");
    expect(user!.content).toContain(MESSAGE_KINDS[2]!.describe);
  });
});

describe("the labels are the incumbents' own", () => {
  it("source_sensitive: the judge's verdict, and no label from a reply without one", async () => {
    const { labelSourceSensitive } = await import("../scripts/decisions-bootstrap.js");
    const { buildSourceSensitiveQuestionJudgeMessages } = await import("../agent/ungrounded-claim-judge.js");
    const yes = model("VERDICT: yes");
    expect(await labelSourceSensitive(yes.provider, "Was kostet ein Deutschlandticket?")).toBe("yes");
    expect(yes.complete.mock.calls[0]![0]).toEqual(buildSourceSensitiveQuestionJudgeMessages("Was kostet ein Deutschlandticket?"));
    expect(await labelSourceSensitive(model("VERDICT: no").provider, "Erklär mir Rekursion")).toBe("no");
    expect(await labelSourceSensitive(model("hmm, hard to say").provider, "Erklär mir Rekursion")).toBeUndefined();
  });

  it("fast_lane: the receptionist's gate, prompt and escalation rule", async () => {
    const { labelFastLane } = await import("../scripts/decisions-bootstrap.js");
    const { ESCALATE_SENTINEL } = await import("../agent/receptionist.js");
    expect(await labelFastLane(model("Hallo! Wie kann ich helfen?").provider, "hallo")).toBe("small_talk");
    expect(await labelFastLane(model(ESCALATE_SENTINEL).provider, "hallo, wie spät ist es in Tokio?")).toBe("task");
    // A message the front desk never hands its model is not the receptionist's to label — nor Laya's to learn.
    const gated = model("Hallo!");
    expect(await labelFastLane(gated.provider, "Recherchiere die aktuellen Preise für Wärmepumpen in Bayern und vergleiche drei Anbieter mit Quellen und Links")).toBeUndefined();
    expect(gated.complete).not.toHaveBeenCalled();
  });
});

describe("the rows", () => {
  it("are training data in the ledger's format, and never the gate's evidence", async () => {
    const { bootstrapRow } = await import("../scripts/decisions-bootstrap.js");
    const { buildTrainingItems } = await import("../scripts/decisions-export.js");
    const row = bootstrapRow("source_sensitive", "Was kostet ein Deutschlandticket im Monat?", "yes", 900);
    expect(row).toMatchObject({ point: "source_sensitive", language: "de", state: { message: "Was kostet ein Deutschlandticket im Monat?" }, mode: "bootstrap", incumbent: { choice: "yes" }, decidedBy: "incumbent" });
    expect(row.laya, "no Laya answer: nothing to compare, so no evidence").toBeUndefined();
    const [item] = buildTrainingItems([row]);
    expect(item).toMatchObject({ point: "source_sensitive", gold: { source_sensitive: { label: "A" } } });

    // The gate is seeded from the ledger alone, and counts only rows where both answered.
    const decide = await import("../decisions/decide.js");
    const gate = await import("../decisions/gate.js");
    decide.resetDecisionsForTests();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempDir, "decisions"), { recursive: true });
    writeFileSync(join(tempDir, "decisions", "bootstrap-ledger.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
    await decide.seedDecisionGate();
    expect(gate.gateSnapshot({ targetAgreement: 0.9, minSamples: 30 })).toEqual([]);
  });
});
