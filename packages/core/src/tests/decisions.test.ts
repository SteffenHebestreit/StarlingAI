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

/** An incumbent that answers `value` after `ms`, and remembers when it was sent and whether it was aborted. */
function incumbentAnswering(value: boolean | undefined, ms = 20) {
  const seen = { calls: 0, aborted: false, sentAt: [] as number[] };
  const run = (signal: AbortSignal) => new Promise<boolean | undefined>((resolve, reject) => {
    seen.calls += 1;
    seen.sentAt.push(Date.now());
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
    // Confident "yes" answers agree; unsure ones do not. 240: a level above the lowest is tested once it holds 200.
    for (let i = 0; i < 240; i += 1) gate.recordAgreementSample("source_sensitive", "de", "yes", 0.95, true);
    for (let i = 0; i < 160; i += 1) gate.recordAgreementSample("source_sensitive", "de", "yes", 0.6, false);
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

  it("does not let an answer qualify on precision while it misses the protected answer", () => {
    const settings = { targetAgreement: 0.9, minSamples: 30 };
    // The incumbent says "no" 200 times and "yes" 5 times; Laya says "no" every time.
    for (let i = 0; i < 200; i += 1) gate.recordAgreementSample("source_sensitive", "de", "no", 0.95, true, "m", "no");
    for (let i = 0; i < 5; i += 1) gate.recordAgreementSample("source_sensitive", "de", "no", 0.95, false, "m", "yes");
    expect(gate.qualifiedLevel("source_sensitive", "de", "no", settings, "m"), "precision alone: 200 of 205").toBe(0.5);
    expect(gate.qualifiedLevel("source_sensitive", "de", "no", settings, "m", "yes"), "5 protected cases, all missed").toBeNull();
    // Laya does find the "yes" cases it is shown — but the 5 misses still sink the recall's lower bound.
    for (let i = 0; i < 40; i += 1) gate.recordAgreementSample("source_sensitive", "de", "yes", 0.95, true, "m", "yes");
    expect(gate.qualifiedLevel("source_sensitive", "de", "no", settings, "m", "yes"), "40 of 45 found").toBeNull();
    for (let i = 0; i < 100; i += 1) gate.recordAgreementSample("source_sensitive", "de", "yes", 0.95, true, "m", "yes");
    expect(gate.qualifiedLevel("source_sensitive", "de", "no", settings, "m", "yes"), "140 of 145 found").toBe(0.5);
    // The protected answer itself is never held back by its own recall.
    expect(gate.qualifiedLevel("source_sensitive", "de", "yes", settings, "m", "yes")).toBe(0.5);
  });

  it("never qualifies with fewer cases than minSamples, and opens only once it also did without its newest cases", () => {
    const settings = { targetAgreement: 0.5, minSamples: 30 };
    for (let i = 0; i < 29; i += 1) gate.recordAgreementSample("goal_met", "en", "done", 0.99, true);
    expect(gate.qualifiedLevel("goal_met", "en", "done", settings)).toBeNull();
    // 30 would pass on its own; the confirmation asks the same of the 30 before the newest CONFIRM_SAMPLES.
    for (let n = 30; n < 30 + gate.CONFIRM_SAMPLES; n += 1) {
      gate.recordAgreementSample("goal_met", "en", "done", 0.99, true);
      expect(gate.qualifiedLevel("goal_met", "en", "done", settings), `${n} cases`).toBeNull();
    }
    gate.recordAgreementSample("goal_met", "en", "done", 0.99, true);
    expect(gate.qualifiedLevel("goal_met", "en", "done", settings)).toBe(0.5);
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
      // The version that answered: the gate's evidence is rebuilt per version from these rows.
      laya: { choice: "yes", top: 0.97, model: "laya-test" }, incumbent: { choice: "no" }, sessionId: "s-test",
    });
  });

  it("laya: takes Laya's answer at the threshold without sending the incumbent, below it waits for the incumbent", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", points: { source_sensitive: { mode: "laya", threshold: 0.9 } } });
    layaAnswers("yes", 0.93);
    const slow = incumbentAnswering(false, 5_000);
    const started = Date.now();
    const taken = await sourceSensitive(GERMAN, slow.run);
    expect(taken.value).toBe(true);
    expect(taken.decidedBy).toBe("laya");
    expect(Date.now() - started, "waited for the incumbent Laya had replaced").toBeLessThan(1_000);
    expect(slow.seen.calls, "the incumbent Laya replaced was sent anyway").toBe(0);

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
    // Evidence about another checkpoint proves nothing about this one.
    for (let i = 0; i < 40; i += 1) gate.recordAgreementSample("source_sensitive", "de", "yes", 0.96, true, "an-older-checkpoint");
    expect((await sourceSensitive(GERMAN, incumbentAnswering(true).run)).decidedBy).toBe("incumbent");
    for (let i = 0; i < 40; i += 1) gate.recordAgreementSample("source_sensitive", "de", "yes", 0.96, true, "laya-test");

    const slow = incumbentAnswering(true, 5_000);
    const proven = await sourceSensitive(GERMAN, slow.run);
    expect(proven.decidedBy).toBe("laya");
    expect(proven.value).toBe(true);
    expect(slow.seen.calls, "the incumbent Laya replaced was sent anyway").toBe(0);

    // German evidence does not hand Laya English cases.
    const english = await sourceSensitive(ENGLISH, incumbentAnswering(true).run);
    expect(english.decidedBy).toBe("incumbent");
  });

  it("adaptive: Laya's common answer waits for the incumbent until Laya has shown it finds the rare one", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", defaultMode: "adaptive", adaptive: { targetAgreement: 0.9, minSamples: 30, auditRate: 0 } });
    // "No" agrees with the incumbent 60 times out of 60 — but no "yes" case has been seen yet.
    for (let i = 0; i < 60; i += 1) gate.recordAgreementSample("source_sensitive", "de", "no", 0.96, true, "laya-test", "no");
    layaAnswers("no", 0.96);
    const slow = incumbentAnswering(false, 300);
    expect((await sourceSensitive(GERMAN, slow.run)).decidedBy, "an unseen rare answer: the incumbent decides").toBe("incumbent");
    // Laya recorded the incumbent's answer to that case as well.
    for (let i = 0; i < 40; i += 1) gate.recordAgreementSample("source_sensitive", "de", "yes", 0.96, true, "laya-test", "yes");
    expect((await sourceSensitive(GERMAN, incumbentAnswering(false, 5_000).run)).decidedBy, "and once it has shown it").toBe("laya");
  });

  it("adaptive: misses of the rare answer that surface later withdraw the handover", async () => {
    // Every case audited, so the incumbent answers each one and every miss is recorded.
    await writeConfig({ baseUrl: "http://laya:8080", defaultMode: "adaptive", adaptive: { targetAgreement: 0.9, minSamples: 30, auditRate: 1 } });
    for (let i = 0; i < 300; i += 1) gate.recordAgreementSample("source_sensitive", "de", "no", 0.96, true, "laya-test", "no");
    for (let i = 0; i < 40; i += 1) gate.recordAgreementSample("source_sensitive", "de", "yes", 0.96, true, "laya-test", "yes");
    const settings = { targetAgreement: 0.9, minSamples: 30 };
    expect(gate.qualifiedLevel("source_sensitive", "de", "no", settings, "laya-test", "yes")).toBe(0.5);
    // Five research questions Laya calls "no" and the judge calls "yes". Its "no" stays precise (300 of
    // 305): only the misses of "yes" — 40 of 45 found — may withdraw it.
    layaAnswers("no", 0.96);
    for (let i = 0; i < 5; i += 1) await sourceSensitive(GERMAN, incumbentAnswering(true).run);
    expect(gate.qualifiedLevel("source_sensitive", "de", "no", settings, "laya-test")).toBe(0.5);
    expect(gate.qualifiedLevel("source_sensitive", "de", "no", settings, "laya-test", "yes"), "40 of 45 found").toBeNull();
  });

  it("adaptive: an audited case still goes to the incumbent and keeps measuring", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", defaultMode: "adaptive", adaptive: { targetAgreement: 0.9, minSamples: 30, auditRate: 1 } });
    for (let i = 0; i < 40; i += 1) gate.recordAgreementSample("source_sensitive", "de", "yes", 0.96, true, "laya-test");
    layaAnswers("yes", 0.96);
    const incumbent = incumbentAnswering(false);
    const outcome = await sourceSensitive(GERMAN, incumbent.run);
    expect(outcome.decidedBy).toBe("incumbent");
    expect(outcome.value).toBe(false);
    // The disagreement is counted: 40 of 41 now.
    expect(gate.gateSnapshot({ targetAgreement: 0.9, minSamples: 30 }).find((row) => row.language === "de" && row.model === "laya-test")?.samples).toBe(41);
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

describe("Laya first, where its answer could be taken", () => {
  // Adoption plan 2026-09-26, C6: an incumbent aborted right after it was sent made the next call on the same model
  // 952 ms slower (E5). Where Laya's answer may be taken, the incumbent waits for it; elsewhere nothing changes.
  const ADAPTIVE = { baseUrl: "http://laya:8080", defaultMode: "adaptive", adaptive: { targetAgreement: 0.9, minSamples: 30, auditRate: 0 } };

  /** Laya answering "yes" at `top` after `ms`; remembers when it answered. */
  function layaAfter(ms: number, top = 0.96) {
    const seen = { answeredAt: 0 };
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      seen.answeredAt = Date.now();
      return new Response(JSON.stringify({
        answers: { source_sensitive: { choice: "yes", probabilities: { yes: top, no: 1 - top } } },
        model: "laya-test",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, seen };
  }

  /** Evidence that qualifies German "yes" for laya-test (38 flawless cases are needed at 0.9). */
  function qualifyYes() {
    for (let i = 0; i < 40; i += 1) gate.recordAgreementSample("source_sensitive", "de", "yes", 0.96, true, "laya-test", "yes");
  }

  it("(a) never sends the incumbent when Laya's qualified answer is taken", async () => {
    await writeConfig(ADAPTIVE);
    qualifyYes();
    layaAfter(5);
    const incumbent = incumbentAnswering(false, 5_000);
    const outcome = await sourceSensitive(GERMAN, incumbent.run);
    expect(outcome).toMatchObject({ value: true, decidedBy: "laya" });
    expect(incumbent.seen.calls, "an incumbent Laya replaced was sent (and aborted)").toBe(0);
  });

  it("(b) starts the incumbent at once where nothing is qualified, without waiting for Laya", async () => {
    await writeConfig(ADAPTIVE);
    const laya = layaAfter(80);
    const incumbent = incumbentAnswering(false, 5);
    const started = Date.now();
    const outcome = await sourceSensitive(GERMAN, incumbent.run);
    expect(outcome.decidedBy).toBe("incumbent");
    expect(incumbent.seen.calls).toBe(1);
    expect(incumbent.seen.sentAt[0]! - started, "the incumbent waited for Laya").toBeLessThan(40);
    expect(incumbent.seen.sentAt[0]!).toBeLessThan(laya.seen.answeredAt);
  });

  it("(b2) fails the decision, not the process, when the incumbent fails while Laya is still answering", async () => {
    await writeConfig(ADAPTIVE);
    layaAfter(30);
    // The gateway logs every unhandled rejection as an error (index.ts): an incumbent that fails before decide() has
    // looked at Laya's answer must reach the caller, and only the caller.
    const stray: unknown[] = [];
    const onStray = (reason: unknown) => { stray.push(reason); };
    process.on("unhandledRejection", onStray);
    try {
      await expect(sourceSensitive(GERMAN, async () => { throw new Error("incumbent down"); })).rejects.toThrow("incumbent down");
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onStray);
    }
    expect(stray, "the incumbent's failure went unhandled while decide() waited on Laya").toEqual([]);
  });

  it("(c) sends an audited case to the incumbent once Laya has answered", async () => {
    await writeConfig({ ...ADAPTIVE, adaptive: { ...ADAPTIVE.adaptive, auditRate: 1 } });
    qualifyYes();
    const laya = layaAfter(20);
    const incumbent = incumbentAnswering(false, 5);
    const outcome = await sourceSensitive(GERMAN, incumbent.run);
    expect(outcome.decidedBy).toBe("incumbent");
    expect(incumbent.seen.calls).toBe(1);
    expect(incumbent.seen.sentAt[0]!).toBeGreaterThanOrEqual(laya.seen.answeredAt);
  });

  it("(d) shadow: starts both at once, however qualified Laya is", async () => {
    await writeConfig({ ...ADAPTIVE, defaultMode: "shadow" });
    qualifyYes();
    const laya = layaAfter(80);
    const incumbent = incumbentAnswering(false, 5);
    const started = Date.now();
    expect((await sourceSensitive(GERMAN, incumbent.run)).decidedBy).toBe("incumbent");
    expect(incumbent.seen.sentAt[0]! - started).toBeLessThan(40);
    await vi.waitFor(() => expect(laya.seen.answeredAt).toBeGreaterThan(incumbent.seen.sentAt[0]!));
  });

  it("(e) starts the incumbent at once while the breaker is open, however long the head start", async () => {
    await writeConfig({ ...ADAPTIVE, layaFirstMs: 1_000 });
    const failing = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", failing);
    for (let i = 0; i < 3; i += 1) await sourceSensitive(GERMAN, incumbentAnswering(false, 1).run);
    qualifyYes();
    const incumbent = incumbentAnswering(true, 5);
    const started = Date.now();
    const pending = sourceSensitive(GERMAN, incumbent.run);
    // Sent before decide() first yields: the breaker is read up front, not learnt from Laya's null answer.
    expect(incumbent.seen.calls, "the incumbent waited on a sidecar the breaker will not ask").toBe(1);
    expect((await pending).decidedBy).toBe("incumbent");
    expect(failing, "the open breaker was asked").toHaveBeenCalledTimes(3);
    expect(incumbent.seen.sentAt[0]! - started).toBeLessThan(40);
  });

  it("(f) starts the incumbent when Laya overruns its head start, and still takes Laya's answer if it comes in time", async () => {
    await writeConfig({ ...ADAPTIVE, layaFirstMs: 40 });
    qualifyYes();
    layaAfter(250);
    const incumbent = incumbentAnswering(false, 5_000);
    const started = Date.now();
    const outcome = await sourceSensitive(GERMAN, incumbent.run);
    const waited = incumbent.seen.sentAt[0]! - started;
    expect(waited, "sent before the head start was over").toBeGreaterThanOrEqual(35);
    expect(waited, "waited for Laya past the head start").toBeLessThan(200);
    expect(outcome.decidedBy).toBe("laya");
    expect(incumbent.seen.aborted, "as when both start at once").toBe(true);
  });

  it("keeps the old order with layaFirstMs 0", async () => {
    await writeConfig({ ...ADAPTIVE, layaFirstMs: 0 });
    qualifyYes();
    layaAfter(30);
    const incumbent = incumbentAnswering(false, 5_000);
    const pending = sourceSensitive(GERMAN, incumbent.run);
    // Both at once, as before: sent before decide() first yields, not after a zero-length head start.
    expect(incumbent.seen.calls, "sent after a head start of 0 ms instead of at once").toBe(1);
    expect((await pending).decidedBy).toBe("laya");
    expect(incumbent.seen.calls).toBe(1);
    expect(incumbent.seen.aborted).toBe(true);
  });

  it("(g) waits only on the version that answers: a checkpoint no longer served does not hold the incumbent back", async () => {
    await writeConfig(ADAPTIVE);
    // Evidence for a checkpoint the sidecar served before; it now answers as laya-test, which has none.
    for (let i = 0; i < 40; i += 1) gate.recordAgreementSample("source_sensitive", "de", "yes", 0.96, true, "laya-previous", "yes");
    const laya = layaAfter(20);
    // Before any answer of this process, any version with evidence may be the one that answers: one wait.
    const first = incumbentAnswering(false, 5);
    expect((await sourceSensitive(GERMAN, first.run)).decidedBy).toBe("incumbent");
    expect(first.seen.sentAt[0]!, "the first case did not wait to learn the version").toBeGreaterThanOrEqual(laya.seen.answeredAt);
    // From then on the version that answered decides, and it has qualified nothing: both at once.
    const next = incumbentAnswering(false, 5);
    const pending = sourceSensitive(GERMAN, next.run);
    expect(next.seen.calls, "the incumbent waited on the previous checkpoint's evidence").toBe(1);
    expect((await pending).decidedBy).toBe("incumbent");
  });

  it("(h) waits only where an answer Laya may take has qualified, not any answer of the point", async () => {
    await writeConfig(ADAPTIVE);
    // "yes" has qualified; the caller lets Laya take "no" alone (as the receptionist lets it take "task" only).
    qualifyYes();
    layaAfter(20);
    const incumbent = incumbentAnswering(false, 5);
    const pending = decisions.decide<boolean>({
      point: decisions.SOURCE_SENSITIVE,
      state: { message: GERMAN },
      languageOf: GERMAN,
      layaMayTake: ["no"],
      incumbent: incumbent.run,
      toKey: (value) => (value ? "yes" : "no"),
      fromKey: (key) => key === "yes",
    });
    expect(incumbent.seen.calls, "the incumbent waited for an answer Laya may not take").toBe(1);
    expect((await pending).decidedBy).toBe("incumbent");
  });
});

describe("a point read through its own window", () => {
  /** A sidecar answering finding_relevant "irrelevant" at `top`, reporting `extra` in the answer. */
  function sidecar(extra: Record<string, unknown>, top = 0.96) {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      answers: { finding_relevant: { choice: "irrelevant", probabilities: { relevant: 1 - top, irrelevant: top }, ...extra } },
      model: "laya-test",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function relevance(incumbent: (signal: AbortSignal) => Promise<string | undefined>) {
    return decisions.decide<string>({
      point: decisions.FINDING_RELEVANT,
      state: { objective: ENGLISH, content: "Menu. Cookies." },
      languageOf: ENGLISH,
      layaMayTake: ["irrelevant"],
      incumbent,
      toKey: (distilled) => (distilled ? "relevant" : "irrelevant"),
      fromKey: () => "",
    });
  }

  it("asks for its window, and keeps its evidence apart from the default window's", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", defaultMode: "adaptive", adaptive: { targetAgreement: 0.9, minSamples: 30, auditRate: 0 } });
    expect(decisions.FINDING_RELEVANT.maxLen).toBe(4096);
    // Evidence earned while Laya read the first 2,400 characters through the checkpoint's own window.
    for (let i = 0; i < 60; i += 1) gate.recordAgreementSample("finding_relevant", "en", "irrelevant", 0.96, true, "laya-test", "irrelevant");
    for (let i = 0; i < 60; i += 1) gate.recordAgreementSample("finding_relevant", "en", "relevant", 0.96, true, "laya-test", "relevant");
    const fetchMock = sidecar({ maxLen: 4096, truncatedTokens: 7 });
    const outcome = await relevance(async () => "");
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { questions: Array<Record<string, unknown>> };
    expect(sent.questions[0]!["max_len"]).toBe(4096);
    expect(outcome.laya?.model).toBe("laya-test;max_len=4096");
    expect(outcome.laya?.truncatedTokens).toBe(7);
    expect(outcome.decidedBy, "the default window's evidence vouched for the wider one").toBe("incumbent");
    await vi.waitFor(async () => {
      await ledger.flushLedgerForTests();
      expect(existsSync(ledgerPath)).toBe(true);
    });
    const row = JSON.parse(readFileSync(ledgerPath, "utf8").trim().split("\n").at(-1)!) as Record<string, unknown>;
    expect(row["laya"]).toMatchObject({ model: "laya-test;max_len=4096", truncatedTokens: 7 });
  });

  it("files an answer from a sidecar that does not confirm the window apart from both", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", defaultMode: "shadow" });
    sidecar({});
    const outcome = await relevance(async () => "");
    expect(outcome.decidedBy).toBe("incumbent");
    await vi.waitFor(async () => {
      await ledger.flushLedgerForTests();
      expect(existsSync(ledgerPath)).toBe(true);
    });
    const row = JSON.parse(readFileSync(ledgerPath, "utf8").trim().split("\n").at(-1)!) as { laya: { model: string; truncatedTokens?: number } };
    expect(row.laya.model).toBe("laya-test;max_len=unconfirmed");
    expect(row.laya.truncatedTokens).toBeUndefined();
  });

  it("leaves the version of a point without its own window as the sidecar names it", async () => {
    await writeConfig({ baseUrl: "http://laya:8080", defaultMode: "shadow" });
    const fetchMock = layaAnswers("yes", 0.97);
    await sourceSensitive(GERMAN, incumbentAnswering(false).run);
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { questions: Array<Record<string, unknown>> };
    expect(sent.questions[0]).not.toHaveProperty("max_len");
    await vi.waitFor(async () => {
      await ledger.flushLedgerForTests();
      expect(existsSync(ledgerPath)).toBe(true);
    });
    expect(JSON.parse(readFileSync(ledgerPath, "utf8").trim()).laya.model).toBe("laya-test");
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
        laya: { choice: "yes", top: 0.97, probabilities: { yes: 0.97, no: 0.03 }, ms: 12, model: "laya-test" }, incumbent: { choice: "yes", ms: 1500 }, decidedBy: "incumbent",
      }));
    }
    // A case another checkpoint answered counts for that checkpoint only.
    rows.push(JSON.stringify({
      ts: new Date().toISOString(), point: "source_sensitive", language: "de", state: { message: GERMAN }, mode: "shadow",
      laya: { choice: "yes", top: 0.97, probabilities: { yes: 0.97, no: 0.03 }, ms: 12, model: "an-older-checkpoint" }, incumbent: { choice: "no", ms: 1500 }, decidedBy: "incumbent",
    }));
    // A torn last line is skipped.
    writeFileSync(ledgerPath, `${rows.join("\n")}\n{"torn":`, "utf8");

    await decideModule.seedDecisionGate();
    expect(gate.qualifiedLevel("source_sensitive", "de", "yes", { targetAgreement: 0.9, minSamples: 30 }, "laya-test")).toBe(0.5);
    const snapshot = gate.gateSnapshot({ targetAgreement: 0.9, minSamples: 30 });
    expect(snapshot).toEqual([
      { point: "source_sensitive", language: "de", answer: "yes", model: "an-older-checkpoint", samples: 1, agreement: 0, qualifiedLevel: null },
      { point: "source_sensitive", language: "de", answer: "yes", model: "laya-test", samples: 40, agreement: 1, qualifiedLevel: 0.5 },
    ]);
  });
});
