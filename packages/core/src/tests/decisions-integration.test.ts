/**
 * The Laya decision layer where it decides: the receptionist's micro-call, the parallel-slice disagreement check and
 * the sub-agent's goal-met check — plus the report and export built from the ledger, and how the gateway finds the
 * sidecar. Each point must behave exactly as before while its mode is off, and never wait for an incumbent whose
 * answer Laya was allowed to give.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LedgerRow } from "../decisions/ledger.js";

const tempDir = mkdtempSync(join(tmpdir(), "sai-decisions-integration-"));
const configPath = join(tempDir, "starlingai.json");

async function writeConfig(decisions: Record<string, unknown>): Promise<void> {
  writeFileSync(configPath, JSON.stringify({
    workspacePath: tempDir,
    gateway: { jwtSecret: "t".repeat(32) },
    decisions: { ledger: { path: join(tempDir, "ledger.jsonl") }, ...decisions },
  }), "utf8");
  (await import("../config/loader.js")).resetConfigForTests();
}

beforeAll(async () => {
  process.env["SAI_CONFIG_PATH"] = configPath;
  await writeConfig({});
});

beforeEach(async () => {
  (await import("../decisions/decide.js")).resetDecisionsForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env["SAI_LAYA_URL"];
});

afterAll(() => {
  delete process.env["SAI_CONFIG_PATH"];
  rmSync(tempDir, { recursive: true, force: true });
});

/** Laya answering every point with `choice` at probability `top`. */
function laya(choice: string, top: number) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { questions: Array<{ id: string; options: Record<string, string> }> };
    const answers = Object.fromEntries(body.questions.map((q) => {
      const keys = Object.keys(q.options);
      const rest = (1 - top) / (keys.length - 1);
      return [q.id, { choice, probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? top : rest])) }];
    }));
    return new Response(JSON.stringify({ answers }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("the receptionist", () => {
  it("hands a message Laya calls a task straight on, without waiting for the micro-call", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", points: { fast_lane: { mode: "laya", threshold: 0.8 } } });
    laya("task", 0.95);
    const { runReceptionist } = await import("../agent/receptionist.js");
    let aborted = false;
    const complete = (_messages: unknown, signal?: AbortSignal) => new Promise<string>((resolve) => {
      signal?.addEventListener("abort", () => { aborted = true; });
      setTimeout(() => resolve("Gern!"), 5_000);
    });
    const started = Date.now();
    const result = await runReceptionist("buch mir einen Flug nach Rom", { complete });
    expect(result).toEqual({ handled: false, escalateReason: "laya-task" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(aborted, "the micro-call Laya replaced kept running").toBe(true);
  });

  it("still lets the model write the reply when Laya calls it small talk — only the model can", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", points: { fast_lane: { mode: "laya", threshold: 0.5 } } });
    laya("small_talk", 0.99);
    const { runReceptionist } = await import("../agent/receptionist.js");
    const result = await runReceptionist("hi", { complete: async () => "Hallo! Wie kann ich helfen?" });
    expect(result).toEqual({ handled: true, response: "Hallo! Wie kann ich helfen?" });
  });

  it("behaves as before with the layer off: the micro-call decides", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", points: { fast_lane: { mode: "off" } } });
    const fetchMock = laya("task", 0.99);
    const { runReceptionist, ESCALATE_SENTINEL } = await import("../agent/receptionist.js");
    expect(await runReceptionist("hi", { complete: async () => "Hallo!" })).toEqual({ handled: true, response: "Hallo!" });
    expect(await runReceptionist("hi", { complete: async () => ESCALATE_SENTINEL })).toMatchObject({ handled: false, escalateReason: "model-escalated" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the parallel-slice disagreement check", () => {
  const outputs = [{ label: "researcher", text: "The fee is 25 cents." }, { label: "analyst", text: "The fee is 15 cents." }];

  it("marks a conflict Laya is sure of, even with no routing tier to ask", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", points: { slices_disagree: { mode: "laya", threshold: 0.8 } } });
    laya("disagree", 0.9);
    const { checkSubAgentDisagreement } = await import("../agent/sub-agent-disagreement.js");
    const marker = await checkSubAgentDisagreement(outputs, undefined, "s1");
    expect(marker).toContain("[SUB-AGENT DISAGREEMENT — the parallel slices produced conflicting results.");
  });

  it("marks nothing while switched off and without a routing tier, as before", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", points: { slices_disagree: { mode: "off" } } });
    const fetchMock = laya("disagree", 0.99);
    const { checkSubAgentDisagreement } = await import("../agent/sub-agent-disagreement.js");
    expect(await checkSubAgentDisagreement(outputs)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the sub-agent's goal-met check", () => {
  it("stops gathering when Laya is sure the criteria are met", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", points: { goal_met: { mode: "laya", threshold: 0.8 } } });
    laya("done", 0.93);
    const { assessOversightGoalMet } = await import("../agent/sub-agent.js");
    expect(await assessOversightGoalMet(["Name the fee"], "The fee is 25 cents (source: pant.dk).")).toBe(true);
    laya("continue", 0.93);
    expect(await assessOversightGoalMet(["Name the fee"], "Nothing yet.")).toBe(false);
  });
});

describe("the ledger's report and export", () => {
  const row = (choice: string, top: number, incumbent: string | undefined, language = "de"): LedgerRow => ({
    ts: "2026-09-25T20:00:00Z", point: "source_sensitive", language: language as LedgerRow["language"], state: { message: `m${top}${choice}${incumbent}` }, mode: "shadow",
    laya: { choice, top, probabilities: { yes: choice === "yes" ? top : 1 - top, no: choice === "no" ? top : 1 - top }, ms: 18 },
    ...(incumbent ? { incumbent: { choice: incumbent, ms: 1500 } } : {}),
    decidedBy: "incumbent",
  });

  it("reports agreement per answer and confidence, and the level the gate would qualify", async () => {
    const { buildDecisionReport } = await import("../scripts/decisions-report.js");
    const rows = [
      ...Array.from({ length: 40 }, () => row("yes", 0.95, "yes")),
      ...Array.from({ length: 20 }, () => row("yes", 0.6, "no")),
      row("no", 0.7, undefined),
    ];
    const [report] = buildDecisionReport(rows, 0.9, 30);
    expect(report).toMatchObject({ point: "source_sensitive", language: "de", rows: 61, bothAnswered: 60, layaMedianMs: 18, incumbentMedianMs: 1500 });
    expect(report!.agreement).toBeCloseTo(40 / 60, 5);
    expect(report!.answers).toHaveLength(1);
    expect(report!.answers[0]!.qualifiedLevel).toBe(0.7);
  });

  it("exports the incumbent's answers as training items, asked exactly as the sidecar asks", async () => {
    const { buildTrainingItems } = await import("../scripts/decisions-export.js");
    const { SOURCE_SENSITIVE } = await import("../decisions/points.js");
    const items = buildTrainingItems([row("yes", 0.9, "no"), row("yes", 0.9, "no"), row("no", 0.8, undefined)]);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      point: "source_sensitive",
      language: "de",
      state: JSON.stringify({ message: "m0.9yesno" }),
      questions: { source_sensitive: { type: "choice", instructions: SOURCE_SENSITIVE.question, criteria: { A: SOURCE_SENSITIVE.options["yes"], B: SOURCE_SENSITIVE.options["no"] } } },
      gold: { source_sensitive: { label: "B", probabilities: { A: 0, B: 1 } } },
    });
  });
});

describe("finding the sidecar", () => {
  it("takes the address `sai start --laya` sets, unless the config names one", async () => {
    process.env["SAI_LAYA_URL"] = "http://laya:8080";
    await writeConfig({});
    const { getConfig } = await import("../config/loader.js");
    const { layaConfigured } = await import("../decisions/laya-client.js");
    expect(getConfig().decisions.baseUrl).toBe("http://laya:8080");
    expect(layaConfigured()).toBe(true);
    await writeConfig({ baseUrl: "http://elsewhere:9000" });
    expect(getConfig().decisions.baseUrl).toBe("http://elsewhere:9000");
    delete process.env["SAI_LAYA_URL"];
    await writeConfig({});
    expect(layaConfigured()).toBe(false);
  });
});
