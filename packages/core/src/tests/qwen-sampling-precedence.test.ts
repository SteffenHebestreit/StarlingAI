import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "../config/schema.js";
import type { LLMMessage, LLMToolDef } from "../providers/lmstudio.js";

/** Capture the provider's log lines: the refused-pin warning is part of the contract. */
const warnings: Array<{ fields: Record<string, unknown>; msg: string }> = [];
vi.mock("../logger.js", () => {
  const stub: Record<string, unknown> = {};
  for (const level of ["trace", "debug", "info", "error", "fatal"]) stub[level] = () => undefined;
  stub["warn"] = (fields: Record<string, unknown>, msg: string) => { warnings.push({ fields, msg }); };
  stub["child"] = () => stub;
  return { logger: stub, childLogger: () => stub };
});
vi.mock("../audit/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/logger.js")>();
  return { ...actual, logAudit: vi.fn() };
});

const {
  LMStudioProvider,
  resolveSamplingForCall,
  noteRejectedReasoningEffort,
  _resetRejectedReasoningEffortsForTests,
  _resetTemperaturePinWarningsForTests,
} = await import("../providers/lmstudio.js");
const { ModelConfigSchema } = await import("../config/schema.js");

/**
 * AN AGENT'S TEMPERATURE PIN HAS TO MEAN SOMETHING — WITHOUT UNDOING QWEN'S THINKING GUIDANCE.
 *
 * Before this, both provider paths did `effectiveTemp = modelConfig.temperature` and then, whenever
 * topP was unset, replaced it with recommendedQwenSampling's number. ModelConfigSchema defaulted
 * temperature to 0.3, so EVERY agent had one and every one of them was discarded on Qwen:
 * researcher 0.2, mission_coordinator 0.1, content_writer 0.3, paper_author 0.15 and
 * web_task_coordinator 0.1 all reached the wire as 1.0 (thinking) or 0.7 (effort "none"), while
 * 00-platform.jsonc promised "agents that genuinely need a fixed temperature still set it".
 *
 * The rule now, per call, off the controls in force for that call:
 *   Qwen + thinking ON   -> the model card's temperature AND top_p; a pin is refused (Qwen documents
 *                           repetition loops at low temperature with thinking on) and logged once
 *                           per process, per endpoint|model|pin.
 *   Qwen + thinking OFF  -> the pin wins; top_p from the recommendation.
 *   explicit topP        -> nothing is touched.
 *   non-Qwen             -> the pin, else 0.3 (the old schema default, now kept in the provider).
 *
 * "Thinking ON" is read off THE FIELDS THE BODY WILL ACTUALLY CARRY, not off the config: the
 * vetoed pair sends nothing (so the model thinks), and an endpoint that has 400'd on
 * reasoning_effort "none" is sent "low" instead (so the model thinks) — see the ladder test.
 *
 * Every assertion below reads the REQUEST BODY the client stub received, or the warning the
 * provider logged — never a proxy.
 */

const messages: LLMMessage[] = [
  { role: "system", content: "You are a judge." },
  { role: "user", content: "Is water wet? Answer YES or NO." },
];
const tools: LLMToolDef[] = [
  {
    name: "record_verdict",
    description: "Record the verdict",
    parameters: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
  },
];

const QWEN36 = "lmstudio/qwen/qwen3.6-35b-a3b";
const QWEN38 = "lmstudio/qwen/qwen3.8-27b";
const NOT_QWEN = "lmstudio/meta/llama-3.3-70b";

function mockProvider(cfg: Partial<ModelConfig>, baseUrl = "http://localhost:1234/v1") {
  const bodies: Array<Record<string, unknown>> = [];
  const provider = new LMStudioProvider(
    baseUrl,
    "test",
    { contextWindow: 8192, maxTokens: 64, ...cfg } as ModelConfig,
    { maxRetries: 0 },
  );
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          bodies.push(body);
          if (body["stream"]) {
            return (async function* () {
              yield { choices: [{ delta: { content: "YES" }, finish_reason: null }] };
              yield {
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 },
              };
            })();
          }
          return {
            choices: [{ message: { content: "YES", tool_calls: [] }, finish_reason: "stop" }],
            usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 },
          };
        },
      },
    },
  };
  return { provider, bodies };
}

const pinWarnings = () => warnings.filter((w) => w.msg.includes("temperature pin ignored in thinking mode"));

beforeEach(() => {
  warnings.length = 0;
  // Both latches are MODULE-level now (see _warnedTemperaturePins / _rejectedEfforts): without
  // these resets a warning fired in one test would silence the next test that shares the
  // endpoint|model|pin triple.
  _resetTemperaturePinWarningsForTests();
  _resetRejectedReasoningEffortsForTests();
});

describe("the schema no longer invents a pin", () => {
  it("a model block without temperature parses to temperature undefined — not 0.3", () => {
    // With `.default(0.3)` the provider cannot tell a deliberate 0.2 from nothing at all.
    expect(ModelConfigSchema.parse({}).temperature).toBeUndefined();
    expect(ModelConfigSchema.parse({ temperature: 0.2 }).temperature).toBe(0.2);
  });
});

describe("Qwen, thinking OFF: the agent's pin reaches the wire", () => {
  it("effort none + temperature 0.2 → body temperature 0.2, top_p from the recommendation (was 0.7)", async () => {
    const { provider, bodies } = mockProvider({
      primary: QWEN36, temperature: 0.2, enableThinking: false, reasoningEffort: "none",
    });
    await provider.complete(messages, tools);
    await provider.completeViaStream(messages, tools);

    expect(bodies[0]!["temperature"]).toBe(0.2);
    expect(bodies[0]!["top_p"]).toBe(0.8);
    expect(bodies[1]!["stream"]).toBe(true);
    expect(bodies[1]!["temperature"]).toBe(0.2);
    expect(bodies[1]!["top_p"]).toBe(0.8);
    expect(pinWarnings()).toHaveLength(0);
  });

  it("the qwen-effort family too: reasoning_effort none + pin 0.15 → 0.15 / 0.8", async () => {
    const { provider, bodies } = mockProvider({ primary: QWEN38, temperature: 0.15, reasoningEffort: "none" });
    await provider.complete(messages, tools);
    expect(bodies[0]!["reasoning_effort"]).toBe("none");
    expect(bodies[0]!["temperature"]).toBe(0.15);
    expect(bodies[0]!["top_p"]).toBe(0.8);
  });
});

describe("Qwen, thinking ON: the model card wins and the refused pin is logged once per process", () => {
  it("qwen3.8 + pin 0.2 → 1.0 / 0.95 on both paths, ONE warning across the two calls, naming the pin and the model", async () => {
    const { provider, bodies } = mockProvider({ primary: QWEN38, temperature: 0.2, reasoningEffort: "medium" });
    await provider.complete(messages, tools);
    await provider.completeViaStream(messages, tools);

    expect(bodies[0]!["temperature"]).toBe(1.0);
    expect(bodies[0]!["top_p"]).toBe(0.95);
    expect(bodies[1]!["temperature"]).toBe(1.0);
    expect(bodies[1]!["top_p"]).toBe(0.95);

    const warned = pinWarnings();
    expect(warned).toHaveLength(1);
    expect(warned[0]!.fields["pinnedTemperature"]).toBe(0.2);
    expect(warned[0]!.fields["model"]).toBe("qwen/qwen3.8-27b");
  });

  it("qwen3.6 + enableThinking:true + pin 0.2 → 0.6 / 0.95; a DIFFERENT pin still gets its own line", async () => {
    const a = mockProvider({ primary: QWEN36, temperature: 0.2, enableThinking: true });
    const b = mockProvider({ primary: QWEN36, temperature: 0.1, enableThinking: true });
    await a.provider.complete(messages, tools);
    await a.provider.complete(messages, tools);
    await b.provider.complete(messages, tools);

    for (const body of [...a.bodies, ...b.bodies]) {
      expect(body["temperature"]).toBe(0.6);
      expect(body["top_p"]).toBe(0.95);
    }
    // The latch is keyed endpoint|model|pin, so a second refused pin is still reported.
    expect(pinWarnings().map((w) => w.fields["pinnedTemperature"])).toEqual([0.2, 0.1]);
  });

  it("the SAME endpoint|model|pin across separate instances warns ONCE — a provider instance is not a lifetime", async () => {
    // THE LATCH USED TO BE AN INSTANCE FIELD, AND AN INSTANCE IS ONE DELEGATED RUN.
    // sub-agent.ts builds a fresh createChatProvider per run, runtime.ts one per turn under an
    // effort profile, and getChatProviderForTier hands back a fresh instance per call — so
    // "once per instance" was a log line for every thinking-on agent that carries a pin, on
    // every run. Three instances of the same agent shape is exactly that scenario.
    for (let i = 0; i < 3; i++) {
      const { provider, bodies } = mockProvider({ primary: QWEN36, temperature: 0.25, enableThinking: true });
      await provider.complete(messages, tools);
      expect(bodies[0]!["temperature"]).toBe(0.6);
    }
    expect(pinWarnings()).toHaveLength(1);

    // A different ENDPOINT is a different operator-visible fact and still gets a line.
    const other = mockProvider({ primary: QWEN36, temperature: 0.25, enableThinking: true }, "http://10.10.0.2:8080/v1");
    await other.provider.complete(messages, tools);
    expect(pinWarnings()).toHaveLength(2);
  });

  it("the vetoed pair {enableThinking:false, reasoningEffort:'medium'} runs the model's default — thinking — so it gets thinking-mode sampling, not the pin", async () => {
    // researcher and mission_coordinator carry exactly this with temperature 0.2 / 0.1. The veto
    // puts NOTHING on the wire (thinking-controls-wire.test.ts), so the model thinks; honouring
    // the 0.2 here would be the repetition-loop case the rule exists to prevent.
    const { provider, bodies } = mockProvider({
      primary: QWEN36, temperature: 0.2, enableThinking: false, reasoningEffort: "medium",
    });
    await provider.complete(messages, tools);
    expect(bodies[0]!["chat_template_kwargs"]).toBeUndefined();
    expect(bodies[0]!["reasoning_effort"]).toBeUndefined();
    expect(bodies[0]!["temperature"]).toBe(0.6);
    expect(bodies[0]!["top_p"]).toBe(0.95);
    expect(pinWarnings()).toHaveLength(1);
  });
});

describe("no pin: the recommendation, and nothing to warn about", () => {
  it("thinking on → 0.6 / 0.95; thinking off → 0.7 / 0.8", async () => {
    const on = mockProvider({ primary: QWEN36, enableThinking: true });
    const off = mockProvider({ primary: QWEN36, enableThinking: false });
    await on.provider.complete(messages, tools);
    await off.provider.complete(messages, tools);

    expect(on.bodies[0]!["temperature"]).toBe(0.6);
    expect(on.bodies[0]!["top_p"]).toBe(0.95);
    expect(off.bodies[0]!["temperature"]).toBe(0.7);
    expect(off.bodies[0]!["top_p"]).toBe(0.8);
    expect(pinWarnings()).toHaveLength(0);
  });
});

describe("non-Qwen: the pin, else the old default — no recommendation, no top_p", () => {
  it("no pin → 0.3 (the former schema default, now the provider's)", async () => {
    const { provider, bodies } = mockProvider({ primary: NOT_QWEN });
    await provider.complete(messages, tools);
    await provider.completeViaStream(messages, tools);
    expect(bodies[0]!["temperature"]).toBe(0.3);
    expect(bodies[0]!["top_p"]).toBeUndefined();
    expect(bodies[1]!["temperature"]).toBe(0.3);
    expect(bodies[1]!["top_p"]).toBeUndefined();
  });

  it("a pin is sent as-is", async () => {
    const { provider, bodies } = mockProvider({ primary: NOT_QWEN, temperature: 0.05, enableThinking: true });
    await provider.complete(messages, tools);
    expect(bodies[0]!["temperature"]).toBe(0.05);
    expect(pinWarnings()).toHaveLength(0);
  });
});

describe("explicit topP: nothing is overridden", () => {
  it("Qwen thinking on + temperature 0.2 + topP 0.5 → 0.2 / 0.5, no warning", async () => {
    const { provider, bodies } = mockProvider({ primary: QWEN36, temperature: 0.2, topP: 0.5, enableThinking: true });
    await provider.complete(messages, tools);
    await provider.completeViaStream(messages, tools);
    for (const body of bodies) {
      expect(body["temperature"]).toBe(0.2);
      expect(body["top_p"]).toBe(0.5);
    }
    expect(pinWarnings()).toHaveLength(0);
  });

  it("explicit topP without a temperature → 0.3 / the topP", async () => {
    const { provider, bodies } = mockProvider({ primary: QWEN36, topP: 0.5, enableThinking: true });
    await provider.complete(messages, tools);
    expect(bodies[0]!["temperature"]).toBe(0.3);
    expect(bodies[0]!["top_p"]).toBe(0.5);
  });
});

describe("per-call controls pick the branch", () => {
  it("a thinking-on instance with pin 0.2: one call at effort none gets 0.2 / 0.8, the next call is back to 0.6 / 0.95 and warns", async () => {
    const { provider, bodies } = mockProvider({ primary: QWEN36, temperature: 0.2, enableThinking: true });
    await provider.complete(messages, tools, undefined, { controls: { enableThinking: false, reasoningEffort: "none" } });
    await provider.completeViaStream(messages, tools, undefined, { controls: { reasoningEffort: "none" } });
    await provider.complete(messages, tools);

    expect(bodies[0]!["reasoning_effort"]).toBe("none");
    expect(bodies[0]!["temperature"]).toBe(0.2);
    expect(bodies[0]!["top_p"]).toBe(0.8);
    // effort "none" alone, over an instance enableThinking:true — still the off branch.
    expect(bodies[1]!["reasoning_effort"]).toBe("none");
    expect(bodies[1]!["temperature"]).toBe(0.2);
    expect(bodies[1]!["top_p"]).toBe(0.8);

    expect(bodies[2]!["temperature"]).toBe(0.6);
    expect(bodies[2]!["top_p"]).toBe(0.95);
    // The first two calls refused nothing; only the third did.
    expect(pinWarnings()).toHaveLength(1);
  });
});

describe("the endpoint's reasoning_effort ladder cannot desynchronise the sampling", () => {
  it("an endpoint that refused 'none' is sent 'low' — and the body then carries THINKING-ON sampling, not the pin", async () => {
    // THE TWO HALVES USED TO BE RESOLVED APART AND THEY DRIFTED.
    // The sampling read resolveThinkingControls(...).reasoningEffort ("none" → thinking off →
    // honour the pin), while the body carried effortForEndpoint(baseUrl, "none"), whose ladder
    // steps a REFUSED "none" up to "low" — thinking ON. So on an endpoint that had already
    // 400'd on "none" (the older LM Studio build) a thinking-off call went out reasoning at
    // low temperature: exactly the near-greedy-with-thinking pairing the rule exists to refuse.
    const baseUrl = "http://ladder.test:1234/v1";
    noteRejectedReasoningEffort(baseUrl, "none");

    const { provider, bodies } = mockProvider({ primary: QWEN38, temperature: 0.1, reasoningEffort: "none" }, baseUrl);
    await provider.complete(messages, tools);
    await provider.completeViaStream(messages, tools);

    for (const body of bodies) {
      // What actually went out: the stepped-up rung, thinking ON.
      expect(body["reasoning_effort"]).toBe("low");
      // …so the sampling that went out with it is the thinking-mode pair, and the pin is refused.
      expect(body["temperature"]).toBe(1.0);
      expect(body["top_p"]).toBe(0.95);
    }
    expect(pinWarnings().map((w) => w.fields["pinnedTemperature"])).toEqual([0.1]);
  });

  it("the same config on an endpoint that has refused nothing keeps 'none' and keeps the pin", async () => {
    const { provider, bodies } = mockProvider(
      { primary: QWEN38, temperature: 0.1, reasoningEffort: "none" },
      "http://fresh.test:1234/v1",
    );
    await provider.complete(messages, tools);
    expect(bodies[0]!["reasoning_effort"]).toBe("none");
    expect(bodies[0]!["temperature"]).toBe(0.1);
    expect(bodies[0]!["top_p"]).toBe(0.8);
    expect(pinWarnings()).toHaveLength(0);
  });
});

describe("resolveSamplingForCall (the pure rule, for the table)", () => {
  // The second argument is the WIRE VIEW — the reasoning_effort and enable_thinking the body
  // will actually carry — not the config that produced them. `{}` therefore means "nothing
  // thinking-shaped is sent", which for this hybrid family means the model thinks.
  it.each([
    // modelId, wire fields, pinned, expected
    [QWEN38, { reasoningEffort: "none" }, { temperature: 0.2 }, { temperature: 0.2, topP: 0.8 }],
    [QWEN38, { reasoningEffort: "medium" }, { temperature: 0.2 }, { temperature: 1.0, topP: 0.95, ignoredTemperaturePin: 0.2 }],
    // The stepped-up rung an endpoint that refused "none" gets: thinking on, pin refused.
    [QWEN38, { reasoningEffort: "low" }, { temperature: 0.1 }, { temperature: 1.0, topP: 0.95, ignoredTemperaturePin: 0.1 }],
    [QWEN38, {}, {}, { temperature: 1.0, topP: 0.95 }],
    [QWEN36, { enableThinking: true }, {}, { temperature: 0.6, topP: 0.95 }],
    [QWEN36, { enableThinking: false }, { temperature: 0.1 }, { temperature: 0.1, topP: 0.8 }],
    // What the vetoed pair {enableThinking:false, reasoningEffort:"medium"} puts on the wire:
    // nothing at all. The model runs its default — thinking — so the pin is refused.
    [QWEN36, {}, { temperature: 0.2 }, { temperature: 0.6, topP: 0.95, ignoredTemperaturePin: 0.2 }],
    [QWEN36, { enableThinking: true }, { temperature: 0.2, topP: 0.5 }, { temperature: 0.2, topP: 0.5 }],
    [NOT_QWEN, { enableThinking: true }, {}, { temperature: 0.3 }],
    [NOT_QWEN, {}, { temperature: 0.9 }, { temperature: 0.9 }],
  ] as const)("%s wire %j pinned %j", (modelId, wire, pinned, expected) => {
    expect(resolveSamplingForCall(modelId, wire, pinned)).toEqual(expected);
  });
});
