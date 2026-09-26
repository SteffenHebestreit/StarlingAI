/**
 * The incumbent read by its logits where decisions.readout says so (decisions/incumbent-readout.ts),
 * and at every call site that wires it: off it is never asked; in shadow the parsed call decides
 * and is not held up, and both answers are recorded under the parsed incumbent's version; on, the
 * readout decides, except where only the parsed call can produce the value or the readout has no
 * answer. A recorded provider stands in for the model: no LLM is called.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CompletionCallOptions, LLMMessage, LLMResponse } from "../providers/lmstudio.js";
import type { AuditEvent } from "../audit/schema.js";

const tier = vi.hoisted(() => ({ provider: null as unknown }));
vi.mock("../providers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/index.js")>();
  return { ...actual, getChatProviderForTier: () => tier.provider };
});

const tempDir = mkdtempSync(join(tmpdir(), "sai-readout-"));
const configPath = join(tempDir, "starlingai.json");
const readoutLedger = join(tempDir, "readout-ledger.jsonl");

/** `extra.decisions`: Laya's own settings beside the readout's; `extra.config`: other top-level sections. */
async function writeConfig(readout: Record<string, unknown>, extra: { decisions?: Record<string, unknown>; config?: Record<string, unknown> } = {}): Promise<void> {
  writeFileSync(configPath, JSON.stringify({
    workspacePath: tempDir,
    gateway: { jwtSecret: "t".repeat(32) },
    ...extra.config,
    decisions: { ledger: { path: join(tempDir, "ledger.jsonl") }, ...extra.decisions, readout },
  }), "utf8");
  (await import("../config/loader.js")).resetConfigForTests();
}

const audit: AuditEvent[] = [];
beforeAll(async () => {
  process.env["SAI_CONFIG_PATH"] = configPath;
  await writeConfig({});
  await (await import("../agent/text-language.js")).warmTextLanguageDetector();
  (await import("../audit/logger.js")).subscribeToAudit((event) => {
    if (event.type === "decision_readout") audit.push(event);
  });
});

beforeEach(async () => {
  (await import("../decisions/decide.js")).resetDecisionsForTests();
  // A test that failed before reading its rows leaves a write queued: let it land before the file goes.
  await (await import("../decisions/ledger.js")).flushLedgerForTests();
  rmSync(readoutLedger, { force: true });
  rmSync(join(tempDir, "ledger.jsonl"), { force: true });
  audit.length = 0;
  tier.provider = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  delete process.env["SAI_CONFIG_PATH"];
  rmSync(tempDir, { recursive: true, force: true });
});

const response = (extra: Partial<LLMResponse>): LLMResponse => ({
  content: "", tool_calls: [], usage: { promptTokens: 300, completionTokens: 1, totalTokens: 301 }, finishReason: "stop", ...extra,
});

/** The top list of a model that answers `letter` with probability p, the other of two letters with the rest but a sliver. */
function lettersAnswering(letter: "A" | "B", p = 0.9) {
  const other = letter === "A" ? "B" : "A";
  return [{ token: letter, logprob: Math.log(p) }, { token: other, logprob: Math.log(1 - p - 0.01) }, { token: "The", logprob: Math.log(0.01) }];
}

/**
 * A model that answers a readout (a call asking for logprobs) with `letter`, and any other call
 * with `reply`. `hold` keeps readouts waiting until released.
 */
function recordedModel(letter: "A" | "B" | null, reply = "", opts: { hold?: boolean; top?: Array<{ token: string; logprob: number }> } = {}) {
  const calls: Array<{ options: CompletionCallOptions | undefined; messages: LLMMessage[]; signal: AbortSignal | undefined }> = [];
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const complete = vi.fn(async (messages: LLMMessage[], _tools: unknown, signal?: AbortSignal, options?: CompletionCallOptions): Promise<LLMResponse> => {
    calls.push({ options, messages, signal });
    if (!options?.logprobs) return response({ content: reply });
    if (opts.hold) await held;
    if (signal?.aborted) throw new Error("aborted");
    if (letter === null) return response({ content: "A", finishReason: "length" });
    const top = opts.top ?? lettersAnswering(letter);
    return response({ content: letter, finishReason: "length", logprobs: [{ token: top[0]!.token, logprob: top[0]!.logprob, topLogprobs: top }] });
  });
  return {
    calls,
    provider: { complete } as never,
    readouts: () => calls.filter((call) => call.options?.logprobs === true),
    parsedCalls: () => calls.filter((call) => !call.options?.logprobs),
    release: () => release(),
  };
}

type Row = Record<string, unknown> & { readout: Record<string, unknown>; parsed?: { choice: string | null; ms: number } };

async function readoutRows(): Promise<Row[]> {
  await (await import("../decisions/ledger.js")).flushLedgerForTests();
  if (!existsSync(readoutLedger)) return [];
  return readFileSync(readoutLedger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
}

const ENGLISH = "How much does a monthly Deutschlandticket cost right now?";
const GERMAN = "Was kostet ein Deutschlandticket im Monat gerade?";

async function sourceSensitive(message: string, model: ReturnType<typeof recordedModel>, parsed: () => Promise<boolean | undefined>) {
  const { decideWithReadout } = await import("../decisions/incumbent-readout.js");
  const { SOURCE_SENSITIVE } = await import("../decisions/points.js");
  return decideWithReadout<boolean>({
    point: SOURCE_SENSITIVE,
    state: { message },
    languageOf: message,
    sessionId: "s-readout",
    incumbent: () => parsed(),
    toKey: (yes) => (yes ? "yes" : "no"),
    fromKey: (key) => key === "yes",
    readout: { provider: model.provider, agentName: "source_sensitivity_judge" },
  });
}

describe("the readout beside or instead of the parsed call", () => {
  it("is never asked while off, the default: the parsed call decides alone, as before", async () => {
    await writeConfig({});
    const model = recordedModel("B");
    const parsed = vi.fn(async () => true);
    const outcome = await sourceSensitive(ENGLISH, model, parsed);
    expect(outcome.value).toBe(true);
    expect(parsed).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(0);
    expect(await readoutRows()).toEqual([]);
  });

  it("in shadow, lets the parsed answer decide without waiting for the readout, then records both", async () => {
    await writeConfig({ points: { source_sensitive: "shadow" } });
    const model = recordedModel("B", "", { hold: true });
    const outcome = await sourceSensitive(ENGLISH, model, async () => true);
    // Decided while the readout is still held.
    expect(outcome.value).toBe(true);
    expect(model.readouts()).toHaveLength(1);
    expect(await readoutRows()).toEqual([]);
    model.release();
    await vi.waitFor(async () => expect(await readoutRows()).toHaveLength(1));
    const [row] = await readoutRows();
    expect(row).toMatchObject({
      point: "source_sensitive", language: "en", mode: "shadow", incumbentVersion: "parsed", readoutVersion: "readout-v1", decidedBy: "parsed",
      parsed: { choice: "yes" }, agree: false, sessionId: "s-readout", state: { message: ENGLISH },
    });
    expect(row!.readout).toMatchObject({ choice: "no", temperature: 1 });
    await vi.waitFor(() => expect(audit).toHaveLength(1));
    expect(audit[0]!.data).toMatchObject({ point: "source_sensitive", mode: "shadow", incumbentVersion: "parsed", readoutVersion: "readout-v1", agree: false });
    expect(JSON.stringify(audit[0]!.data), "the audit row carries no case text").not.toContain("Deutschlandticket");
  });

  it("on, decides by the readout without the parsed call, and records its probabilities under its own version", async () => {
    await writeConfig({ points: { source_sensitive: "on" } });
    const model = recordedModel("A");
    const parsed = vi.fn(async () => false);
    const outcome = await sourceSensitive(ENGLISH, model, parsed);
    expect(outcome.value).toBe(true);
    expect(parsed).not.toHaveBeenCalled();
    const [row] = await readoutRows();
    expect(row).toMatchObject({ mode: "on", incumbentVersion: "readout-v1", decidedBy: "readout" });
    expect(row!.parsed).toBeUndefined();
    const probabilities = row!.readout["probabilities"] as Record<string, number>;
    expect(probabilities["yes"]).toBeCloseTo(0.9 / 0.99, 12);
    expect((row!.readout["logScores"] as Record<string, number>)["no"]).toBeCloseTo(Math.log(0.09), 12);
  });

  it("on, still runs the parsed call for an answer only it can act on, and counts the pair", async () => {
    await writeConfig({ points: { fast_lane: "on" } });
    const { decideWithReadout } = await import("../decisions/incumbent-readout.js");
    const { FAST_LANE } = await import("../decisions/points.js");
    const model = recordedModel("A");
    const parsed = vi.fn(async () => "Hallo!");
    const outcome = await decideWithReadout<string>({
      point: FAST_LANE, state: { message: "hi" }, languageOf: "hi",
      incumbent: () => parsed(), toKey: (reply) => (reply.includes("<ESCALATE>") ? "task" : "small_talk"), fromKey: () => "<ESCALATE>",
      readout: { provider: model.provider, parsedFor: ["small_talk"] },
    });
    expect(outcome.value).toBe("Hallo!");
    expect(parsed).toHaveBeenCalledTimes(1);
    const [row] = await readoutRows();
    expect(row).toMatchObject({ mode: "on", decidedBy: "parsed", incumbentVersion: "parsed", parsed: { choice: "small_talk" }, agree: true });
  });

  it("on, hands the decision back to the parsed call when the readout has no answer", async () => {
    await writeConfig({ points: { source_sensitive: "on" } });
    const noList = recordedModel(null);
    expect((await sourceSensitive(ENGLISH, noList, async () => false)).value).toBe(false);
    const thinking = recordedModel("A", "", { top: [{ token: "<think>", logprob: -0.05 }, { token: "A", logprob: -3.5 }] });
    expect((await sourceSensitive(ENGLISH, thinking, async () => false)).value).toBe(false);
    const rows = await readoutRows();
    expect(rows.map((row) => row.readout["miss"])).toEqual(["no_logprobs", "control_token"]);
    expect(rows.every((row) => row["decidedBy"] === "parsed" && row.parsed?.choice === "no")).toBe(true);
  });

  it("applies the temperature configured for the point and the case's language", async () => {
    await writeConfig({ points: { source_sensitive: "on" }, temperatures: { source_sensitive: { en: 3 } } });
    await sourceSensitive(ENGLISH, recordedModel("A"), async () => undefined);
    await sourceSensitive(GERMAN, recordedModel("A"), async () => undefined);
    const [english, german] = await readoutRows();
    const z = [Math.log(0.9), Math.log(0.09)];
    const softened = Math.exp(z[0]! / 3) / (Math.exp(z[0]! / 3) + Math.exp(z[1]! / 3));
    expect((english!.readout["probabilities"] as Record<string, number>)["yes"]).toBeCloseTo(softened, 12);
    expect(english!.readout["temperature"]).toBe(3);
    expect(german!.readout["temperature"]).toBe(1);
    expect((german!.readout["probabilities"] as Record<string, number>)["yes"]).toBeCloseTo(0.9 / 0.99, 12);
  });

  it("cancels the readout when decide() aborts the incumbent: Laya's answer was taken", async () => {
    await writeConfig({ points: { source_sensitive: "shadow" } });
    const { incumbentWithReadout } = await import("../decisions/incumbent-readout.js");
    const { SOURCE_SENSITIVE } = await import("../decisions/points.js");
    const model = recordedModel("A", "", { hold: true });
    const controller = new AbortController();
    const run = incumbentWithReadout<boolean>({
      point: SOURCE_SENSITIVE, state: { message: ENGLISH }, languageOf: ENGLISH,
      incumbent: (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
      toKey: (yes) => (yes ? "yes" : "no"), fromKey: (key) => key === "yes",
    }, { provider: model.provider })(controller.signal);
    controller.abort();
    await expect(run).rejects.toThrow("aborted");
    expect(model.readouts()[0]!.signal?.aborted).toBe(true);
    model.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await readoutRows(), "an aborted pair is no sample").toEqual([]);
  });

  it("on, sends no parsed call once decide() has taken Laya's answer while the readout ran", async () => {
    await writeConfig({ points: { source_sensitive: "on" } });
    const { incumbentWithReadout } = await import("../decisions/incumbent-readout.js");
    const { SOURCE_SENSITIVE } = await import("../decisions/points.js");
    const model = recordedModel("A", "", { hold: true });
    const parsed = vi.fn(async () => true);
    const decision = new AbortController();
    const run = incumbentWithReadout<boolean>({
      point: SOURCE_SENSITIVE, state: { message: ENGLISH }, languageOf: ENGLISH,
      incumbent: () => parsed(), toKey: (yes) => (yes ? "yes" : "no"), fromKey: (key) => key === "yes",
    }, { provider: model.provider })(decision.signal);
    await vi.waitFor(() => expect(model.readouts()).toHaveLength(1));
    decision.abort();
    model.release();
    expect(await run).toBeUndefined();
    expect(parsed, "a parsed call after the abort only occupies the model").not.toHaveBeenCalled();
  });

  it("cancels the readout with the caller's own signal too, as the speculative source judge's abort()", async () => {
    await writeConfig({ points: { source_sensitive: "shadow" } });
    const { incumbentWithReadout } = await import("../decisions/incumbent-readout.js");
    const { SOURCE_SENSITIVE } = await import("../decisions/points.js");
    const model = recordedModel("A", "", { hold: true });
    const caller = new AbortController();
    const run = incumbentWithReadout<boolean>({
      point: SOURCE_SENSITIVE, state: { message: ENGLISH }, languageOf: ENGLISH, signal: caller.signal,
      incumbent: async () => true, toKey: (yes) => (yes ? "yes" : "no"), fromKey: (key) => key === "yes",
    }, { provider: model.provider })(new AbortController().signal);
    expect(await run).toBe(true);
    caller.abort();
    expect(model.readouts()[0]!.signal?.aborted, "the readout kept the shared model busy after the caller gave up").toBe(true);
    model.release();
  });

  it("asks as many alternatives, and wants as much of the mass on the letters, as configured", async () => {
    await writeConfig({ points: { source_sensitive: "on" }, topLogprobs: 5, minLetterMass: 0.95 });
    // The letters hold 0.9: an answer at the default 0.5, a miss at 0.95 — the parsed call decides.
    const model = recordedModel("A", "", { top: [{ token: "A", logprob: Math.log(0.6) }, { token: "B", logprob: Math.log(0.3) }, { token: "The", logprob: Math.log(0.1) }] });
    const outcome = await sourceSensitive(ENGLISH, model, async () => false);
    expect(model.readouts()[0]!.options?.topLogprobs).toBe(5);
    expect(outcome.value).toBe(false);
    expect((await readoutRows())[0]!.readout["miss"]).toBe("low_mass");
  });

  it("on runs as shadow where Laya learns from the incumbent: no readout answer enters the decision ledger as the parsed call's", async () => {
    // Laya configured and the point in Laya's shadow: decide() writes the incumbent's answer to the
    // decision ledger (the fine-tuning labels) and the gate's counts, with no incumbent version.
    await writeConfig({ points: { source_sensitive: "on" } }, { decisions: { baseUrl: "http://laya:8080", points: { source_sensitive: { mode: "shadow" } } } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const parsed = vi.fn(async () => false);
    const outcome = await sourceSensitive(ENGLISH, recordedModel("A"), parsed);
    expect(outcome.value, "the parsed call decides").toBe(false);
    expect(parsed).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect(await readoutRows()).toHaveLength(1));
    expect((await readoutRows())[0]).toMatchObject({ mode: "shadow", incumbentVersion: "parsed", decidedBy: "parsed", agree: false });
    const decisionLedger = join(tempDir, "ledger.jsonl");
    await vi.waitFor(async () => {
      await (await import("../decisions/ledger.js")).flushLedgerForTests();
      expect(existsSync(decisionLedger)).toBe(true);
    });
    const rows = readFileSync(decisionLedger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { incumbent?: { choice: string } });
    expect(rows.map((row) => row.incumbent?.choice), "the teacher Laya learns from is still the parsed call").toEqual(["no"]);

    // The point's own Laya mode off: nothing learns from its incumbent, and the readout decides.
    await writeConfig({ points: { source_sensitive: "on" } }, { decisions: { baseUrl: "http://laya:8080", points: { source_sensitive: { mode: "off" } } } });
    expect((await sourceSensitive(ENGLISH, recordedModel("A"), parsed)).value).toBe(true);
    expect(parsed).toHaveBeenCalledTimes(1);
  });
});

describe("where each point asks it (decisions.readout on everywhere)", () => {
  beforeEach(async () => {
    await writeConfig({ defaultMode: "on" });
  });

  it("the receptionist: a readout 'task' escalates without the micro-call; 'small talk' still gets the model's reply", async () => {
    const { runReceptionist } = await import("../agent/receptionist.js");
    const task = recordedModel("B");
    const complete = vi.fn(async () => "Hallo! Wie kann ich helfen?");
    expect(await runReceptionist("hi", { complete, readout: { provider: task.provider } })).toMatchObject({ handled: false });
    expect(complete).not.toHaveBeenCalled();
    expect(task.readouts()).toHaveLength(1);
    const smallTalk = recordedModel("A");
    expect(await runReceptionist("hi", { complete, readout: { provider: smallTalk.provider } })).toEqual({ handled: true, response: "Hallo! Wie kann ich helfen?" });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("the receptionist as a turn reaches it: the fast lane hands its routing tier to the readout, labelled as its own call", async () => {
    await writeConfig({ defaultMode: "on" }, { config: { receptionist: { enabled: true } } });
    const model = recordedModel("B", "Hallo!");
    const { currentCallAttribution } = await import("../runtime/request-context.js");
    const labels: unknown[] = [];
    const recorded = model.provider as unknown as { complete: (...args: unknown[]) => Promise<LLMResponse> };
    tier.provider = { complete: (...args: unknown[]) => { labels.push({ ...currentCallAttribution().data }); return recorded.complete(...args); } };
    const { tryReceptionistFastLaneDetailed } = await import("../agent/receptionist.js");
    expect(await tryReceptionistFastLaneDetailed("hi")).toMatchObject({ handled: false });
    expect(model.readouts()).toHaveLength(1);
    expect(model.parsedCalls(), "a readout 'task' needs no micro-call").toHaveLength(0);
    expect(labels).toEqual([{ callSite: "routing_tier", agentName: "receptionist_readout" }]);
  });

  it("the parallel-slice disagreement check", async () => {
    const model = recordedModel("B", "AGREE");
    tier.provider = model.provider;
    const { checkSubAgentDisagreement } = await import("../agent/sub-agent-disagreement.js");
    const marker = await checkSubAgentDisagreement([{ label: "a", text: "The fee is 25 cents." }, { label: "b", text: "The fee is 15 cents." }]);
    expect(marker).toContain("[SUB-AGENT DISAGREEMENT");
    expect(model.parsedCalls()).toHaveLength(0);
  });

  it("the goal-met oversight", async () => {
    const model = recordedModel("A", "CONTINUE");
    tier.provider = model.provider;
    const { assessOversightGoalMet } = await import("../agent/sub-agent.js");
    expect(await assessOversightGoalMet(["Name the fee"], "The fee is 25 cents (source: pant.dk).")).toBe(true);
    expect(model.parsedCalls()).toHaveLength(0);
  });

  it("the semantic progress judge", async () => {
    const model = recordedModel("B", "{\"verdict\":\"on_track\",\"reason\":\"fine\"}");
    const { assessRunProgress } = await import("../agent/sub-agent.js");
    const verdict = await assessRunProgress({ objective: "Compare two deposit schemes", recentActivity: "Recent tool calls: edit_file, edit_file", provider: model.provider });
    expect(verdict.verdict).toBe("drifting");
    expect(model.parsedCalls()).toHaveLength(0);
  });

  it("the shared-fact distillation: 'nothing relevant' skips the extraction, 'relevant' still runs it", async () => {
    const { distillFindingForSharedFacts } = await import("../agent/sub-agent.js");
    const finding = { objective: "What is the deposit on a can in Denmark?", toolName: "web_fetch", rawEvidence: "Accept all cookies. Menu. ".repeat(20) };
    const irrelevant = recordedModel("B", "- Deposit: 1 DKK");
    expect(await distillFindingForSharedFacts({ ...finding, provider: irrelevant.provider })).toBe("");
    expect(irrelevant.parsedCalls()).toHaveLength(0);
    const relevant = recordedModel("A", "- Deposit: 1 DKK (pant.dk)");
    expect(await distillFindingForSharedFacts({ ...finding, provider: relevant.provider })).toBe("- Deposit: 1 DKK (pant.dk)");
    expect(relevant.parsedCalls()).toHaveLength(1);
  });
});
