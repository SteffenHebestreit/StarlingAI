/**
 * The Laya decision layer: who decides each case, in each mode, and why.
 *
 * The incumbent — the LLM call or rule that decides a point today — must stay in charge until the
 * ledger has shown Laya agrees with it, per point, language and answer; Laya must never make a
 * decision slower than the incumbent alone; and every case Laya was asked about must be recorded,
 * because those records are both the gate's evidence and the fine-tuning data.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "sai-decisions-"));
const configPath = join(tempDir, "starlingai.json");
const ledgerPath = join(tempDir, "ledger.jsonl");

async function writeConfig(decisions: Record<string, unknown>): Promise<void> {
  writeFileSync(configPath, JSON.stringify({
    workspacePath: tempDir,
    gateway: { jwtSecret: "t".repeat(32) },
    decisions: { ledger: { path: ledgerPath }, ...decisions },
  }), "utf8");
  (await import("../config/loader.js")).resetConfigForTests();
}

type Decisions = typeof import("../decisions/index.js");
type DecideModule = typeof import("../decisions/decide.js");
type Gate = typeof import("../decisions/gate.js");
type Ledger = typeof import("../decisions/ledger.js");
let decisions: Decisions;
let decideModule: DecideModule;
let gate: Gate;
let ledger: Ledger;

beforeAll(async () => {
  process.env["SAI_CONFIG_PATH"] = configPath;
  await writeConfig({});
  decisions = await import("../decisions/index.js");
  decideModule = await import("../decisions/decide.js");
  gate = await import("../decisions/gate.js");
  ledger = await import("../decisions/ledger.js");
  await (await import("../agent/text-language.js")).warmTextLanguageDetector();
});

beforeEach(() => {
  decideModule.resetDecisionsForTests();
  rmSync(ledgerPath, { force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  delete process.env["SAI_CONFIG_PATH"];
  rmSync(tempDir, { recursive: true, force: true });
});

const GERMAN = "Wie funktioniert das Pfandsystem in Deutschland und wer betreibt es eigentlich?";
const ENGLISH = "How does the deposit return scheme in Germany work and who runs it?";

/** Laya answering `choice` with probability `top` for the source_sensitive point; counts its calls. */
function layaAnswers(choice: "yes" | "no", top: number) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    answers: { source_sensitive: { choice, probabilities: choice === "yes" ? { yes: top, no: 1 - top } : { yes: 1 - top, no: top } } },
    model: "laya-test",
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** An incumbent that answers `value` after `ms`, and remembers whether it was aborted. */
function incumbentAnswering(value: boolean | undefined, ms = 20) {
  const seen = { calls: 0, aborted: false };
  const run = (signal: AbortSignal) => new Promise<boolean | undefined>((resolve, reject) => {
    seen.calls += 1;
    const timer = setTimeout(() => resolve(value), ms);
    signal.addEventListener("abort", () => {
      seen.aborted = true;
      clearTimeout(timer);
      reject(new Error("aborted"));
    });
  });
  return { run, seen };
}

function sourceSensitive(message: string, incumbent: (signal: AbortSignal) => Promise<boolean | undefined>) {
  return decisions.decide<boolean>({
    point: decisions.SOURCE_SENSITIVE,
    state: { message },
    languageOf: message,
    incumbent,
    toKey: (value) => (value ? "yes" : "no"),
    fromKey: (key) => key === "yes",
    sessionId: "s-test",
  });
}

describe("the gate's statistics", () => {
  it("uses the Wilson lower bound, so 10 of 10 is not proof and 290 of 300 is", () => {
    expect(decisions.wilsonLowerBound(10, 10)).toBeLessThan(0.75);
    expect(decisions.wilsonLowerBound(290, 300)).toBeGreaterThan(0.93);
    expect(decisions.wilsonLowerBound(0, 0)).toBe(0);
  });

  it("qualifies the lowest confidence whose cases agree well enough, per answer and language", () => {
    const settings = { targetAgreement: 0.9, minSamples: 30 };
    // Confident "yes" answers agree; unsure ones do not.
    for (let i = 0; i < 60; i += 1) gate.recordAgreementSample("source_sensitive", "de", "yes", 0.95, true);
    for (let i = 0; i < 40; i += 1) gate.recordAgreementSample("source_sensitive", "de", "yes", 0.6, false);
    expect(gate.qualifiedLevel("source_sensitive", "de", "yes", settings)).toBe(0.7);
    expect(gate.layaMayDecide("source_sensitive", "de", "yes", 0.96, settings)).toBe(true);
    expect(gate.layaMayDecide("source_sensitive", "de", "yes", 0.65, settings)).toBe(false);
    // Nothing is known about "no", or about English: neither is vouched for by German "yes".
    expect(gate.qualifiedLevel("source_sensitive", "de", "no", settings)).toBeNull();
    expect(gate.qualifiedLevel("source_sensitive", "en", "yes", settings)).toBeNull();
  });

  it("judges a level by the lower bound, not the plain rate: 29 of 31 (93.5%) is not yet proof of 90%", () => {
    for (let i = 0; i < 29; i += 1) gate.recordAgreementSample("ungrounded_draft", "de", "no", 0.9, true);
    for (let i = 0; i < 2; i += 1) gate.recordAgreementSample("ungrounded_draft", "de", "no", 0.9, false);
    expect(decisions.wilsonLowerBound(29, 31)).toBeLessThan(0.9);
    expect(gate.qualifiedLevel("ungrounded_draft", "de", "no", { targetAgreement: 0.9, minSamples: 30 })).toBeNull();
  });

  it("never qualifies with fewer cases than minSamples, however well they agree", () => {
    for (let i = 0; i < 29; i += 1) gate.recordAgreementSample("goal_met", "en", "done", 0.99, true);
    expect(gate.qualifiedLevel("goal_met", "en", "done", { targetAgreement: 0.5, minSamples: 30 })).toBeNull();
    gate.recordAgreementSample("goal_met", "en", "done", 0.99, true);
    expect(gate.qualifiedLevel("goal_met", "en", "done", { targetAgreement: 0.5, minSamples: 30 })).toBe(0.5);
  });
});

describe("who decides", () => {
  it("leaves every point to its incumbent by default: no sidecar, no question to Laya", async () => {
    await writeConfig({});
    const fetchMock = layaAnswers("yes", 0.99);
    const incumbent = incumbentAnswering(false);
    const outcome = await sourceSensitive(GERMAN, incumbent.run);
    expect(outcome).toEqual({ value: false, decidedBy: "incumbent" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it("does not ask Laya about a point switched off, even with a sidecar", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", defaultMode: "shadow", points: { source_sensitive: { mode: "off" } } });
    const fetchMock = layaAnswers("yes", 0.99);
    const outcome = await sourceSensitive(GERMAN, incumbentAnswering(false).run);
    expect(outcome.decidedBy).toBe("incumbent");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shadow: the incumbent decides, Laya is asked alongside, and both go to the ledger", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", defaultMode: "shadow" });
    const fetchMock = layaAnswers("yes", 0.97);
    const incumbent = incumbentAnswering(false);
    const outcome = await sourceSensitive(GERMAN, incumbent.run);
    expect(outcome).toEqual({ value: false, decidedBy: "incumbent" });
    expect(incumbent.seen.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { questions: Array<Record<string, unknown>> };
    expect(sent.questions[0]).toMatchObject({ id: "source_sensitive", options: decisions.SOURCE_SENSITIVE.options, state: { message: GERMAN } });

    await vi.waitFor(async () => {
      await ledger.flushLedgerForTests();
      expect(existsSync(ledgerPath)).toBe(true);
    });
    const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      point: "source_sensitive", language: "de", mode: "shadow", decidedBy: "incumbent",
      laya: { choice: "yes", top: 0.97 }, incumbent: { choice: "no" }, sessionId: "s-test",
    });
  });

  it("laya: takes Laya's answer at the threshold and aborts the incumbent, below it waits for the incumbent", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", points: { source_sensitive: { mode: "laya", threshold: 0.9 } } });
    layaAnswers("yes", 0.93);
    const slow = incumbentAnswering(false, 5_000);
    const started = Date.now();
    const taken = await sourceSensitive(GERMAN, slow.run);
    expect(taken.value).toBe(true);
    expect(taken.decidedBy).toBe("laya");
    expect(Date.now() - started, "waited for the incumbent Laya had replaced").toBeLessThan(1_000);
    expect(slow.seen.aborted).toBe(true);

    layaAnswers("yes", 0.8);
    const kept = await sourceSensitive(GERMAN, incumbentAnswering(false).run);
    expect(kept.value).toBe(false);
    expect(kept.decidedBy).toBe("incumbent");
    expect(kept.laya?.top).toBe(0.8);
  });

  it("adaptive: the incumbent decides until the ledger proves Laya, then Laya decides — per language", async () => {
    await writeConfig({
      baseUrl: "http://laya:8080",
      defaultMode: "adaptive",
      adaptive: { targetAgreement: 0.9, minSamples: 30, auditRate: 0 },
    });
    layaAnswers("yes", 0.96);
    // No evidence yet: the incumbent decides, and each case becomes evidence.
    const first = await sourceSensitive(GERMAN, incumbentAnswering(true).run);
    expect(first.decidedBy).toBe("incumbent");
    for (let i = 0; i < 40; i += 1) gate.recordAgreementSample("source_sensitive", "de", "yes", 0.96, true);

    const slow = incumbentAnswering(true, 5_000);
    const proven = await sourceSensitive(GERMAN, slow.run);
    expect(proven.decidedBy).toBe("laya");
    expect(proven.value).toBe(true);
    expect(slow.seen.aborted).toBe(true);

    // German evidence does not hand Laya English cases.
    const english = await sourceSensitive(ENGLISH, incumbentAnswering(true).run);
    expect(english.decidedBy).toBe("incumbent");
  });

  it("adaptive: an audited case still goes to the incumbent and keeps measuring", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", defaultMode: "adaptive", adaptive: { targetAgreement: 0.9, minSamples: 30, auditRate: 1 } });
    for (let i = 0; i < 40; i += 1) gate.recordAgreementSample("source_sensitive", "de", "yes", 0.96, true);
    layaAnswers("yes", 0.96);
    const incumbent = incumbentAnswering(false);
    const outcome = await sourceSensitive(GERMAN, incumbent.run);
    expect(outcome.decidedBy).toBe("incumbent");
    expect(outcome.value).toBe(false);
    // The disagreement is counted: 40 of 41 now.
    expect(gate.gateSnapshot({ targetAgreement: 0.9, minSamples: 30 }).find((row) => row.language === "de")?.samples).toBe(41);
  });

  it("falls back to the incumbent when Laya fails, and stops asking a sidecar that keeps failing", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", points: { source_sensitive: { mode: "laya", threshold: 0.5 } } });
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    for (let i = 0; i < 4; i += 1) {
      const outcome = await sourceSensitive(GERMAN, incumbentAnswering(true).run);
      expect(outcome).toEqual({ value: true, decidedBy: "incumbent" });
    }
    expect(fetchMock, "a sidecar that failed three times is still asked").toHaveBeenCalledTimes(3);
  });

  it("rejects an answer that does not fit the options instead of misreading it", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", points: { source_sensitive: { mode: "laya", threshold: 0.5 } } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      answers: { source_sensitive: { choice: "maybe", probabilities: { yes: 0.2, no: 0.1, maybe: 0.7 } } },
    }), { status: 200 })));
    expect((await sourceSensitive(GERMAN, incumbentAnswering(false).run)).decidedBy).toBe("incumbent");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      answers: { source_sensitive: { choice: "no", probabilities: { yes: 0.8, no: 0.2 } } },
    }), { status: 200 })));
    const notArgmax = await sourceSensitive(GERMAN, incumbentAnswering(false).run);
    expect(notArgmax.decidedBy).toBe("incumbent");
    expect(notArgmax.laya, "a choice that is not the argmax was read as Laya's answer").toBeUndefined();
  });

  it("passes an incumbent's failure through in shadow mode, as it would without Laya", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", defaultMode: "shadow" });
    layaAnswers("no", 0.9);
    await expect(sourceSensitive(GERMAN, async () => { throw new Error("routing tier down"); })).rejects.toThrow("routing tier down");
  });
});

describe("the ledger", () => {
  it("rebuilds the gate's evidence at start, from cases where both answered", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", defaultMode: "adaptive", adaptive: { targetAgreement: 0.9, minSamples: 30, auditRate: 0 } });
    // A case Laya decided has no incumbent answer and proves nothing — first, so misreading it
    // would lose the whole rebuild rather than hide behind the rows before it.
    const rows = [JSON.stringify({ ts: "x", point: "source_sensitive", language: "de", state: {}, mode: "adaptive", laya: { choice: "yes", top: 0.97, probabilities: {}, ms: 1 }, decidedBy: "laya" })];
    for (let i = 0; i < 40; i += 1) {
      rows.push(JSON.stringify({
        ts: new Date().toISOString(), point: "source_sensitive", language: "de", state: { message: GERMAN }, mode: "shadow",
        laya: { choice: "yes", top: 0.97, probabilities: { yes: 0.97, no: 0.03 }, ms: 12 }, incumbent: { choice: "yes", ms: 1500 }, decidedBy: "incumbent",
      }));
    }
    // A torn last line is skipped.
    writeFileSync(ledgerPath, `${rows.join("\n")}\n{"torn":`, "utf8");

    await decideModule.seedDecisionGate();
    expect(gate.qualifiedLevel("source_sensitive", "de", "yes", { targetAgreement: 0.9, minSamples: 30 })).toBe(0.5);
    const snapshot = gate.gateSnapshot({ targetAgreement: 0.9, minSamples: 30 });
    expect(snapshot).toEqual([{ point: "source_sensitive", language: "de", answer: "yes", samples: 40, agreement: 1, qualifiedLevel: 0.5 }]);
  });
});
