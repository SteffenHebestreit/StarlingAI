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
    let sent = false;
    const complete = (_messages: unknown, _signal?: AbortSignal) => new Promise<string>((resolve) => {
      sent = true;
      setTimeout(() => resolve("Gern!"), 5_000);
    });
    const started = Date.now();
    const result = await runReceptionist("buch mir einen Flug nach Rom", { complete });
    expect(result).toEqual({ handled: false, escalateReason: "laya-task" });
    expect(Date.now() - started).toBeLessThan(1_000);
    // Laya is asked first where its answer may be taken: the micro-call it replaces is never sent (decide.ts).
    expect(sent, "the micro-call Laya replaced was sent anyway").toBe(false);
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

/** A model answering `reply` after `ms`; remembers whether it was called and aborted. */
function modelAnswering(reply: string, ms = 20) {
  const seen = { calls: 0, aborted: false };
  const provider = {
    complete: (_messages: unknown, _tools: unknown, signal?: AbortSignal) => new Promise((resolve, reject) => {
      seen.calls += 1;
      const timer = setTimeout(() => resolve({ content: reply, tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" }), ms);
      signal?.addEventListener("abort", () => {
        seen.aborted = true;
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    }),
  };
  return { seen, provider: provider as never };
}

describe("shared-fact distillation", () => {
  const finding = { objective: "What is the deposit on a can in Denmark?", toolName: "web_fetch", rawEvidence: "Accept all cookies. Log in. Menu. Newsletter. " .repeat(20) };

  it("drops a page Laya is sure holds nothing relevant, without waiting for the model", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", points: { finding_relevant: { mode: "laya", threshold: 0.8 } } });
    laya("irrelevant", 0.95);
    const model = modelAnswering("- Deposit: 1 DKK", 5_000);
    const { distillFindingForSharedFacts } = await import("../agent/sub-agent.js");
    const started = Date.now();
    expect(await distillFindingForSharedFacts({ ...finding, provider: model.provider })).toBe("");
    expect(Date.now() - started, "waited for the extraction Laya made unnecessary").toBeLessThan(1_000);
    expect(model.seen.calls, "the extraction Laya made unnecessary was sent anyway").toBe(0);
  });

  it("still has the model extract what Laya calls relevant — only the model can", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", points: { finding_relevant: { mode: "laya", threshold: 0.5 } } });
    laya("relevant", 0.99);
    const { distillFindingForSharedFacts } = await import("../agent/sub-agent.js");
    expect(await distillFindingForSharedFacts({ ...finding, provider: modelAnswering("- Deposit: 1 DKK (pant.dk)").provider })).toBe("- Deposit: 1 DKK (pant.dk)");
  });

  it("shows Laya the 6,000 characters the extraction reads, through its own window, and counts it as another version", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", points: { finding_relevant: { mode: "shadow" } } });
    // The only relevant sentence sits past character 2,400: the old cut would have shown Laya chrome only.
    const rawEvidence = `${"Menu. Cookies. Login. ".repeat(130)}The deposit on a can is 1 DKK (pant.dk). ${"Footer. ".repeat(600)}`;
    expect(rawEvidence.indexOf("1 DKK")).toBeGreaterThan(2_400);
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: Array<Record<string, unknown>> };
      sent.push(body.questions[0]!);
      return new Response(JSON.stringify({
        answers: { finding_relevant: { choice: "relevant", probabilities: { relevant: 0.9, irrelevant: 0.1 }, maxLen: 4096, truncatedTokens: 0 } },
        model: "laya-test",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const { distillFindingForSharedFacts } = await import("../agent/sub-agent.js");
    await distillFindingForSharedFacts({ ...finding, rawEvidence, provider: modelAnswering("- Deposit: 1 DKK (pant.dk)").provider });
    const state = sent[0]!["state"] as { content: string };
    expect(state.content).toHaveLength(6_000);
    expect(state.content).toContain("1 DKK");
    expect(sent[0]!["max_len"]).toBe(4096);
    const { flushLedgerForTests, readLedgerRows } = await import("../decisions/ledger.js");
    await vi.waitFor(async () => {
      await flushLedgerForTests();
      expect((await readLedgerRows()).some((r) => r.point === "finding_relevant" && r.laya?.model === "laya-test;max_len=4096")).toBe(true);
    });
    const row = (await readLedgerRows()).filter((r) => r.point === "finding_relevant").at(-1)!;
    expect(row.laya).toMatchObject({ model: "laya-test;max_len=4096", truncatedTokens: 0 });
  });

  it("labels the extraction's provider row as a routing-tier call of its own, not the researcher's", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", points: { finding_relevant: { mode: "off" } } });
    const { currentAgentName, currentCallSite, runWithCallAttribution } = await import("../runtime/request-context.js");
    const labels: Array<[string | undefined, string | undefined]> = [];
    const provider = {
      complete: async () => {
        labels.push([currentCallSite(), currentAgentName()]);
        return { content: "- Deposit: 1 DKK", tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" };
      },
    };
    const { distillFindingForSharedFacts } = await import("../agent/sub-agent.js");
    // Inside a researcher's run, whose own calls are labelled sub_agent.
    await runWithCallAttribution({ callSite: "sub_agent", agentName: "researcher" }, () =>
      distillFindingForSharedFacts({ ...finding, provider: provider as never }));
    expect(labels).toEqual([["routing_tier", "finding_distill"]]);
  });

  it("behaves as before with the layer off: the model decides, NONE is nothing", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", points: { finding_relevant: { mode: "off" } } });
    const fetchMock = laya("relevant", 0.99);
    const { distillFindingForSharedFacts } = await import("../agent/sub-agent.js");
    expect(await distillFindingForSharedFacts({ ...finding, provider: modelAnswering("NONE").provider })).toBe("");
    expect(await distillFindingForSharedFacts({ ...finding, provider: modelAnswering("- Deposit: 1 DKK").provider })).toBe("- Deposit: 1 DKK");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the semantic progress judge", () => {
  const run = { objective: "Compare the deposit schemes of Denmark and Germany", recentActivity: "Latest output:\nFetched pant.dk\n\nRecent tool calls: web_fetch, web_search" };

  it("lets Laya say the run is on track without waiting for the routing tier", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", points: { run_drifting: { mode: "laya", threshold: 0.8 } } });
    laya("on_track", 0.95);
    const model = modelAnswering("{\"verdict\":\"drifting\",\"reason\":\"x\"}", 5_000);
    const { assessRunProgress } = await import("../agent/sub-agent.js");
    const started = Date.now();
    expect((await assessRunProgress({ ...run, provider: model.provider })).verdict).toBe("on_track");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(model.seen.calls, "the verdict Laya made unnecessary was asked for anyway").toBe(0);
  });

  it("never lets Laya alone wind a run down: its 'drifting' waits for the routing tier's verdict", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", points: { run_drifting: { mode: "laya", threshold: 0.5 } } });
    laya("drifting", 0.99);
    const { assessRunProgress } = await import("../agent/sub-agent.js");
    const verdict = await assessRunProgress({ ...run, provider: modelAnswering("{\"verdict\":\"on_track\",\"reason\":\"still researching\"}").provider });
    expect(verdict).toEqual({ verdict: "on_track", reason: "still researching" });
    const drifting = await assessRunProgress({ ...run, provider: modelAnswering("{\"verdict\":\"drifting\",\"reason\":\"writing a poem\"}").provider });
    expect(drifting).toEqual({ verdict: "drifting", reason: "writing a poem" });
  });

  it("fails open: an unreadable verdict is on track, and is not counted as the routing tier's answer", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", defaultMode: "shadow" });
    laya("drifting", 0.9);
    const { assessRunProgress } = await import("../agent/sub-agent.js");
    expect((await assessRunProgress({ ...run, provider: modelAnswering("I think it is fine").provider })).verdict).toBe("on_track");
    const { flushLedgerForTests, readLedgerRows } = await import("../decisions/ledger.js");
    // This test's row: the ledger file is shared with the tests before it.
    const shadowRow = async () => (await readLedgerRows()).filter((r) => r.point === "run_drifting" && r.mode === "shadow").at(-1);
    await vi.waitFor(async () => {
      await flushLedgerForTests();
      expect(await shadowRow()).toBeDefined();
    });
    const row = (await shadowRow())!;
    expect(row.laya?.choice).toBe("drifting");
    expect(row.incumbent, "a parse failure is not a verdict").toBeUndefined();
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
    // 200: a level above the lowest is tested only once it holds that many at a target of 0.9 (gate.ts levelSampleFloor).
    const rows = [
      ...Array.from({ length: 200 }, () => row("yes", 0.95, "yes")),
      ...Array.from({ length: 100 }, () => row("yes", 0.6, "no")),
      row("no", 0.7, undefined),
    ];
    const [report] = buildDecisionReport(rows, 0.9, 30);
    expect(report).toMatchObject({ point: "source_sensitive", language: "de", rows: 301, bothAnswered: 300, layaMedianMs: 18, incumbentMedianMs: 1500 });
    expect(report!.agreement).toBeCloseTo(200 / 300, 5);
    expect(report!.answers).toHaveLength(1);
    expect(report!.answers[0]!.qualifiedLevel).toBe(0.7);
  });

  it("reports the level the gate itself holds, not one it would have taken from every row", async () => {
    const { buildDecisionReport } = await import("../scripts/decisions-report.js");
    const gate = await import("../decisions/gate.js");
    // A stream that agreed and then stopped agreeing: the per-level rows still average above the target, but the gate
    // has closed on the newest cases' drift — and the report says what the gate says.
    const rows = [
      ...Array.from({ length: 1_000 }, () => row("yes", 0.97, "yes")),
      ...Array.from({ length: 60 }, (_, i) => row("yes", 0.97, i % 5 === 0 ? "yes" : "no")),
    ];
    const [report] = buildDecisionReport(rows, 0.9, 30);
    const yes = report!.answers[0]!;
    expect(yes.levels[0]!.lowerBound, "all rows together still pass").toBeGreaterThan(0.9);
    gate.resetGateForTests();
    for (const r of rows) gate.recordAgreementSample(r.point, r.language, r.laya!.choice, r.laya!.top, r.laya!.choice === r.incumbent!.choice, "", r.incumbent!.choice);
    expect(yes.qualifiedLevel).toBe(gate.qualifiedLevel("source_sensitive", "de", "yes", { targetAgreement: 0.9, minSamples: 30 }, "", "yes"));
    expect(yes.qualifiedLevel).toBeNull();
    gate.resetGateForTests();
  });

  it("does not report a common answer as qualified while its recall of the protected answer is unproven", async () => {
    const { buildDecisionReport } = await import("../scripts/decisions-report.js");
    // "no" agrees 200 times; the 5 cases the judge called "yes" Laya called "no".
    const rows = [...Array.from({ length: 200 }, () => row("no", 0.95, "no")), ...Array.from({ length: 5 }, () => row("no", 0.95, "yes"))];
    const [report] = buildDecisionReport(rows, 0.9, 30);
    const no = report!.answers.find((answer) => answer.answer === "no")!;
    expect(no.levels[0]!.lowerBound, "precision alone would qualify it").toBeGreaterThan(0.9);
    expect(no.levels[0]!.protectedRecallLowerBound).toBe(0);
    expect(no.qualifiedLevel).toBeNull();
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
