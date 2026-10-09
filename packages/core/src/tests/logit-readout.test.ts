/**
 * The incumbent read by its logits (decisions/logit-readout.ts): the question as the model reads it,
 * the letters read off one token's top list, the temperature, the fallbacks that hand the decision
 * back to the parsed call, and the temperature fit. Pure logic and a recorded provider only — no
 * model is called.
 */
import { describe, expect, it, vi } from "vitest";

import {
  applyTemperature,
  askReadout,
  buildReadoutMessages,
  expectedCalibrationError,
  fitTemperature,
  isControlToken,
  LETTERS,
  letterOfToken,
  parseLetterReadout,
  renderReadoutState,
  scoreLetters,
  type TemperatureSample,
  type TopLogprob,
} from "../decisions/logit-readout.js";
import { FAST_LANE, RUN_DRIFTING, SOURCE_SENSITIVE } from "../decisions/points.js";
import { servedQuestion } from "../scripts/decisions-export.js";
import type { CompletionCallOptions, LLMMessage, LLMResponse } from "../providers/lmstudio.js";

/** The top list the production llama-server sent for a one-token readout, 2026-09-26 (the letters, then the tail). */
const MEASURED: TopLogprob[] = [
  { token: "A", logprob: -0.185 },
  { token: "B", logprob: -2.487 },
  { token: " A", logprob: -2.589 },
  { token: " B", logprob: -4.542 },
  { token: "a", logprob: -8.99 },
  { token: "The", logprob: -9.6 },
  { token: "<think>", logprob: -10.92 },
];

describe("the question as the model reads it", () => {
  it("letters the options exactly as the sidecar and the fine-tuning export do", () => {
    const { messages, keys } = buildReadoutMessages(SOURCE_SENSITIVE, { message: "Was kostet ein Deutschlandticket?" });
    const { keys: served, criteria } = servedQuestion(SOURCE_SENSITIVE);
    expect(keys).toEqual(served);
    for (const [letter, description] of Object.entries(criteria)) {
      expect(messages[0]!.content).toContain(`${letter}: ${description}`);
    }
    expect(messages[0]!.content).toContain(SOURCE_SENSITIVE.question);
    expect(messages[1]!.content).toContain("Was kostet ein Deutschlandticket?");
  });

  it("keeps everything fixed for a point in the system message, so two cases share the prefix", () => {
    const one = buildReadoutMessages(RUN_DRIFTING, { objective: "Compare two schemes", activity: "web_fetch" });
    const two = buildReadoutMessages(RUN_DRIFTING, { objective: "Write a poem", activity: "edit_file" });
    expect(one.messages[0]).toEqual(two.messages[0]);
    expect(one.messages[1]).not.toEqual(two.messages[1]);
  });

  it("reorders the options when asked, for the position-bias measurement, and refuses a wrong order", () => {
    const { messages, keys } = buildReadoutMessages(FAST_LANE, { message: "hi" }, ["task", "small_talk"]);
    expect(keys).toEqual(["task", "small_talk"]);
    expect(messages[0]!.content).toContain(`A: ${FAST_LANE.options["task"]}`);
    expect(() => buildReadoutMessages(FAST_LANE, { message: "hi" }, ["task"])).toThrow(RangeError);
    expect(() => buildReadoutMessages(FAST_LANE, { message: "hi" }, ["task", "task"])).toThrow(RangeError);
    expect(() => buildReadoutMessages(FAST_LANE, { message: "hi" }, ["task", "other"])).toThrow(RangeError);
  });

  it("renders text fields as they are and anything else as JSON", () => {
    expect(renderReadoutState({ message: "line 1\nline 2", criteria: ["a", "b"] })).toBe("message:\nline 1\nline 2\n\ncriteria:\n[\n  \"a\",\n  \"b\"\n]");
  });
});

describe("reading the letters off the top list", () => {
  it("sums a letter's spellings — 'A' and ' A' are one answer — and leaves lowercase words out", () => {
    const read = parseLetterReadout(MEASURED, 2)!;
    const a = Math.exp(-0.185) + Math.exp(-2.589);
    const b = Math.exp(-2.487) + Math.exp(-4.542);
    expect(read.logScores[0]).toBeCloseTo(Math.log(a), 12);
    expect(read.logScores[1]).toBeCloseTo(Math.log(b), 12);
    expect(read.mass).toBeCloseTo(a + b, 12);
    expect(read.topToken).toBe("A");
  });

  it("renormalises over the option letters", () => {
    const read = parseLetterReadout(MEASURED, 2)!;
    const p = applyTemperature(read.logScores, 1);
    const a = Math.exp(-0.185) + Math.exp(-2.589);
    const b = Math.exp(-2.487) + Math.exp(-4.542);
    expect(p[0]).toBeCloseTo(a / (a + b), 12);
    expect(p[0]! + p[1]!).toBeCloseTo(1, 12);
  });

  it("reads a letter as a list writes it, and nothing that only starts with one", () => {
    expect(letterOfToken("A", 2)).toBe("A");
    expect(letterOfToken(" B", 2)).toBe("B");
    expect(letterOfToken("\nA", 2)).toBe("A");
    expect(letterOfToken("A.", 2)).toBe("A");
    expect(letterOfToken("B)", 2)).toBe("B");
    expect(letterOfToken("a", 2)).toBeUndefined();
    expect(letterOfToken("C", 2), "a letter past the options is no option").toBeUndefined();
    expect(letterOfToken("An", 2)).toBeUndefined();
    expect(letterOfToken("AB", 2)).toBeUndefined();
  });

  it("gives a letter missing from the list the list's last entry as a ceiling, never zero", () => {
    const read = parseLetterReadout([{ token: "A", logprob: -0.01 }, { token: "The", logprob: -6 }, { token: "Yes", logprob: -9 }], 2)!;
    expect(read.logScores[1]).toBe(-9);
    const p = applyTemperature(read.logScores, 1);
    expect(p[1]).toBeGreaterThan(0);
    expect(p[0]).toBeLessThan(1);
  });

  it("scores several options by their own letters", () => {
    const top = [{ token: "C", logprob: -0.2 }, { token: " C", logprob: -2 }, { token: "A", logprob: -3 }, { token: "D", logprob: -4 }, { token: "x", logprob: -12 }];
    const read = parseLetterReadout(top, 4)!;
    expect(read.logScores[2]).toBeCloseTo(Math.log(Math.exp(-0.2) + Math.exp(-2)), 12);
    expect(read.logScores[1]).toBe(-12);
  });
});

describe("the fallbacks: no readout, and the parsed call decides", () => {
  it("when no option letter is on the list", () => {
    const top = [{ token: "Yes", logprob: -0.1 }, { token: "No", logprob: -2.4 }];
    expect(parseLetterReadout(top, 2)).toBeUndefined();
    expect(scoreLetters(top, 2)).toMatchObject({ ok: false, reason: "no_letter" });
  });

  it("when the most likely token is <think> or a tool call, letters or not", () => {
    const thinking = [{ token: "<think>", logprob: -0.9 }, { token: "A", logprob: -1.0 }, { token: "B", logprob: -2.0 }];
    expect(parseLetterReadout(thinking, 2)).toBeUndefined();
    expect(scoreLetters(thinking, 2)).toMatchObject({ ok: false, reason: "control_token", topToken: "<think>" });
    expect(parseLetterReadout([{ token: "<tool_call>", logprob: -0.3 }, { token: "A", logprob: -1.5 }], 2)).toBeUndefined();
    expect(parseLetterReadout([{ token: "<|im_end|>", logprob: -0.3 }, { token: "A", logprob: -1.5 }], 2)).toBeUndefined();
    // Lower down it is only a tail token: the measured answer still reads.
    expect(parseLetterReadout(MEASURED, 2)).toBeDefined();
  });

  it("when the letters hold too little of the probability: the model was about to write something else", () => {
    const prose = [{ token: "The", logprob: Math.log(0.7) }, { token: "A", logprob: Math.log(0.2) }, { token: "B", logprob: Math.log(0.05) }];
    expect(parseLetterReadout(prose, 2)).toBeUndefined();
    expect(scoreLetters(prose, 2)).toMatchObject({ ok: false, reason: "low_mass" });
    expect(parseLetterReadout(prose, 2, 0.2)).toBeDefined();
    // Less than the least mass asked for is a miss; exactly that much is an answer.
    const letters = [{ token: "The", logprob: Math.log(0.5) }, { token: "A", logprob: Math.log(0.3) }, { token: "B", logprob: Math.log(0.2) }];
    expect(parseLetterReadout(letters, 2, Math.exp(Math.log(0.3)) + Math.exp(Math.log(0.2)))).toBeDefined();
  });

  it("when there is no top list to read", () => {
    expect(parseLetterReadout([], 2)).toBeUndefined();
    expect(parseLetterReadout([{ token: "A", logprob: -0.1 }], 2), "the chosen token alone says nothing about the others").toBeUndefined();
  });

  it("knows a control token from text", () => {
    expect(isControlToken("<think>")).toBe(true);
    expect(isControlToken("</think>")).toBe(true);
    expect(isControlToken("<tool_call>")).toBe(true);
    expect(isControlToken("<|im_end|>")).toBe(true);
    expect(isControlToken("A")).toBe(false);
    expect(isControlToken("<")).toBe(false);
    expect(isControlToken("a < b")).toBe(false);
  });
});

describe("the temperature", () => {
  it("is softmax(z / T) over the letters", () => {
    const z = [Math.log(0.8), Math.log(0.15), Math.log(0.05)];
    for (const t of [0.5, 1, 2.5]) {
      const expected = z.map((v) => Math.exp(v / t));
      const sum = expected.reduce((a, b) => a + b, 0);
      const p = applyTemperature(z, t);
      expected.forEach((value, i) => expect(p[i]).toBeCloseTo(value / sum, 12));
    }
    // T > 1 flattens, T < 1 sharpens.
    expect(applyTemperature(z, 2.5)[0]).toBeLessThan(applyTemperature(z, 1)[0]!);
    expect(applyTemperature(z, 0.5)[0]).toBeGreaterThan(applyTemperature(z, 1)[0]!);
  });

  it("falls back to T = 1 for a temperature that is no temperature", () => {
    const z = [-0.1, -2.5];
    expect(applyTemperature(z, 0)).toEqual(applyTemperature(z, 1));
    expect(applyTemperature(z, Number.NaN)).toEqual(applyTemperature(z, 1));
  });
});

/** Deterministic pseudo-random numbers (mulberry32): the fit is tested on the same draw every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Samples whose labels are drawn from softmax(z / trueT): a readout miscalibrated by exactly trueT. */
function miscalibrated(trueT: number, n: number, options: number, seed: number): TemperatureSample[] {
  const random = prng(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  return Array.from({ length: n }, () => {
    const logScores = Array.from({ length: options }, () => 2 * normal());
    const p = applyTemperature(logScores, trueT);
    let u = random();
    let label = options - 1;
    for (let i = 0; i < options; i += 1) {
      u -= p[i]!;
      if (u < 0) {
        label = i;
        break;
      }
    }
    return { logScores, label };
  });
}

describe("the temperature fit", () => {
  it.each([
    [0.5, 2],
    [1.8, 2],
    [2.5, 4],
  ])("recovers T = %s within 5%% (%s options)", (trueT, options) => {
    const fit = fitTemperature(miscalibrated(trueT, 6_000, options, 7 + options));
    expect(Math.abs(fit.temperature - trueT) / trueT).toBeLessThan(0.05);
    expect(fit.clamped).toBe(false);
    expect(fit.nll).toBeLessThanOrEqual(fit.nllAtOne + 1e-12);
  });

  it("says so when the optimum lies beyond its range", () => {
    // Every label the least likely option: no temperature in range explains it.
    const fit = fitTemperature(Array.from({ length: 50 }, () => ({ logScores: [0, -3], label: 1 })));
    expect(fit.clamped).toBe(true);
  });

  it("leaves T at 1 with nothing to fit on, and skips samples whose label is not an option", () => {
    expect(fitTemperature([])).toMatchObject({ temperature: 1, samples: 0 });
    expect(fitTemperature([{ logScores: [0, -1], label: 5 }]).samples).toBe(0);
  });
});

describe("the calibration error", () => {
  it("is the confidence-weighted gap between how sure and how right", () => {
    // Always 90% sure, right half the time: 0.4 off.
    const over = Array.from({ length: 100 }, (_, i) => ({ confidence: 0.9, correct: i % 2 === 0 }));
    expect(expectedCalibrationError(over)).toBeCloseTo(0.4, 12);
    // 70% sure and right 7 in 10: calibrated.
    const calibrated = Array.from({ length: 100 }, (_, i) => ({ confidence: 0.7, correct: i % 10 < 7 }));
    expect(expectedCalibrationError(calibrated)).toBeCloseTo(0, 12);
    expect(expectedCalibrationError([])).toBeNull();
  });
});

/** A provider that records what it was asked and answers with a fixed top list. */
function recordedProvider(answer: Partial<LLMResponse> | Error) {
  const calls: Array<{ messages: LLMMessage[]; options: CompletionCallOptions | undefined; signal: AbortSignal | undefined }> = [];
  const complete = vi.fn(async (messages: LLMMessage[], _tools: unknown, signal?: AbortSignal, options?: CompletionCallOptions): Promise<LLMResponse> => {
    calls.push({ messages, options, signal });
    if (answer instanceof Error) throw answer;
    return { content: "A", tool_calls: [], usage: { promptTokens: 300, completionTokens: 1, totalTokens: 301 }, finishReason: "length", ...answer };
  });
  return { calls, provider: { complete } };
}

describe("asking", () => {
  it("asks for one token with thinking off and the top 20, and reads the answer", async () => {
    const { calls, provider } = recordedProvider({ logprobs: [{ token: "A", logprob: -0.185, topLogprobs: MEASURED }] });
    const result = await askReadout(provider, SOURCE_SENSITIVE, { message: "Was kostet ein Deutschlandticket?" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toEqual({ controls: { enableThinking: false, reasoningEffort: "none" }, maxTokens: 1, logprobs: true, topLogprobs: 20 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answer.choice).toBe("yes");
    const a = Math.exp(-0.185) + Math.exp(-2.589);
    const b = Math.exp(-2.487) + Math.exp(-4.542);
    expect(result.answer.probabilities["yes"]).toBeCloseTo(a / (a + b), 12);
    expect(result.answer.logScores["no"]).toBeCloseTo(Math.log(b), 12);
    expect(result.answer.temperature).toBe(1);
  });

  it("keys the answer by option whatever order the letters were given in", async () => {
    const { provider } = recordedProvider({ logprobs: [{ token: "A", logprob: -0.185, topLogprobs: MEASURED }] });
    const result = await askReadout(provider, SOURCE_SENSITIVE, { message: "x" }, { order: ["no", "yes"], temperature: 2 });
    expect(result.ok && result.answer.choice).toBe("no");
    expect(result.ok && result.answer.temperature).toBe(2);
  });

  it("caps the alternatives at 20 however many are asked for", async () => {
    const { calls, provider } = recordedProvider({ logprobs: [{ token: "A", logprob: -0.185, topLogprobs: MEASURED }] });
    await askReadout(provider, SOURCE_SENSITIVE, { message: "x" }, { topLogprobs: 50 });
    expect(calls[0]!.options?.topLogprobs).toBe(20);
  });

  it("is a miss, never an answer, when the server sends no top list, thinks, fails or is cancelled", async () => {
    expect(await askReadout(recordedProvider({}).provider, SOURCE_SENSITIVE, { message: "x" })).toMatchObject({ ok: false, reason: "no_logprobs" });
    const thinking = recordedProvider({ logprobs: [{ token: "<think>", logprob: -0.01, topLogprobs: [{ token: "<think>", logprob: -0.01 }, { token: "A", logprob: -5 }] }] });
    expect(await askReadout(thinking.provider, SOURCE_SENSITIVE, { message: "x" })).toMatchObject({ ok: false, reason: "control_token", topToken: "<think>" });
    expect(await askReadout(recordedProvider(new Error("HTTP 500")).provider, SOURCE_SENSITIVE, { message: "x" })).toMatchObject({ ok: false, reason: "error" });
    const controller = new AbortController();
    controller.abort();
    expect(await askReadout(recordedProvider(new Error("aborted")).provider, SOURCE_SENSITIVE, { message: "x" }, { signal: controller.signal })).toMatchObject({ ok: false, reason: "aborted" });
  });

  it("uses the sidecar's letters", () => {
    expect(LETTERS.slice(0, 3)).toBe("ABC");
  });
});
