import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE SUB-AGENT'S SYNTHESIS AND DISTILLATION DO NOT RUN WITH THE WORKER'S THINKING.
 *
 * Audit log 12 Sept 2026, researcher: the end-of-run facts-first synthesis — a fresh 2-message
 * prompt, no tools — wrote 7,677 tokens in 291.2 s for a 7,460-char answer (~1.9K tokens) and
 * 7,045 tokens in 127.9 s for a 5,554-char one; with the three history-bearing synthesis calls
 * of the same shape, 824 s across five calls, ~20 % of it answer. Mechanism: no synthesis tier
 * is configured, and `getChatProviderForTier("synthesis") ?? provider` fell back to the WORKER
 * with its own controls. The same `?? provider` served the per-finding distillation (193 s for
 * one call with thinking on, about a second thinking-off).
 *
 * Every assertion here is about the ModelConfig the PROVIDER INSTANCE that served a call was
 * constructed with, or the arguments the tier ladder / factory received — not about the text
 * produced.
 * The worker pins {enableThinking:false, reasoningEffort:"medium"} (what researcher and
 * mission_coordinator declare): on the enable_thinking family that pin vetoes the off-switch,
 * so the synthesis override has to put an explicit "none" past it.
 */

interface RecordedCall {
  method: "complete" | "completeViaStream";
  modelConfig: Record<string, unknown>;
  toolNames: string[];
  options: { toolChoice?: string; controls?: Record<string, unknown> } | undefined;
  messages: Array<{ role: string; content: unknown }>;
}

const state = vi.hoisted(() => ({
  calls: [] as RecordedCall[],
  tierCalls: [] as unknown[][],
  createCalls: [] as unknown[][],
  responseQueue: vi.fn(),
}));

function isDistillPrompt(messages: RecordedCall["messages"]): boolean {
  return messages.some((m) => m.role === "system" && /evidence-distillation step/i.test(String(m.content)));
}

function record(
  method: RecordedCall["method"],
  modelConfig: Record<string, unknown>,
  messages: unknown,
  tools: unknown,
  options: unknown,
) {
  const msgs = messages as RecordedCall["messages"];
  state.calls.push({
    method,
    modelConfig,
    toolNames: (tools as Array<{ name: string }>).map((tool) => tool.name),
    options: options as RecordedCall["options"],
    messages: msgs,
  });
  if (isDistillPrompt(msgs)) return text(distillAnswer);
  return state.responseQueue();
}

/** Short by default, so the curated findings stay under SYNTH_FACTS_MIN_CHARS (400) and the
 *  end-of-run synthesis takes the HISTORY-bearing branch. A test that wants the facts-first
 *  branch sets a long one. */
const SHORT_DISTILLATION = "- IM73A135V01: 73 dB(A) SNR, IP57 (Source: infineon.com)";
const LONG_DISTILLATION = [
  "- IM73A135V01: signal-to-noise ratio 73 dB(A) (Source: https://www.infineon.com/im73a135v01)",
  "- IM73A135V01: sensitivity -38 dBV/Pa, acoustic overload point 135 dB SPL (Source: https://www.infineon.com/im73a135v01)",
  "- IM73A135V01: IP57 dust and water protection, supply voltage 1.62 V to 3.6 V (Source: https://www.infineon.com/im73a135v01)",
  "- IM73A135V01: 170 uA normal / 45 uA low-power, 20 Hz to 20 kHz, 3.5 x 2.65 x 0.98 mm (Source: https://www.infineon.com/im73a135v01)",
].join("\n");
let distillAnswer = SHORT_DISTILLATION;

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    private readonly cfg: Record<string, unknown>;
    constructor(_baseUrl: string, _apiKey: string, modelConfig: Record<string, unknown>) {
      this.cfg = modelConfig;
    }
    async complete(messages: unknown, tools: unknown, _signal?: AbortSignal, options?: unknown) {
      return record("complete", this.cfg, messages, tools, options);
    }
    async completeViaStream(messages: unknown, tools: unknown, _signal?: AbortSignal, options?: unknown) {
      return record("completeViaStream", this.cfg, messages, tools, options);
    }
  },
}));

// Partial: the real ladder and factory run, so what reaches the (mocked) provider constructor
// is what production builds; only the ARGUMENTS are recorded here.
vi.mock("../providers/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../providers/index.js")>();
  return {
    ...original,
    getChatProviderForTier: (...args: unknown[]) => {
      state.tierCalls.push(args);
      return (original.getChatProviderForTier as (...a: unknown[]) => unknown)(...args);
    },
    createChatProvider: (...args: unknown[]) => {
      state.createCalls.push(args);
      return (original.createChatProvider as (...a: unknown[]) => unknown)(...args);
    },
  };
});

// One module registry for the whole file, on purpose: the partial index.js mock keeps its
// importOriginal() module, whose getConfig() is bound to the loader instance of the FIRST
// evaluation. Under vi.resetModules() that instance goes stale (it cached the default config
// the moment something read it with SAI_CONFIG_PATH unset) and the tier ladder then reads
// yesterday's tiers. So: no resetModules; the loader binds its config PATH at import, so one
// path is fixed here before the first import and every test rewrites that file and calls
// resetConfigForTests().
const tempDir = mkdtempSync(join(tmpdir(), "starlingai-sub-agent-synthesis-controls-"));
const configPath = join(tempDir, "starlingai.json");
process.env["SAI_CONFIG_PATH"] = configPath;
writeFileSync(configPath, "{}", "utf8");
const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
const { resetConfigForTests } = await import("../config/loader.js");
const { resetSharedMemoryForTests } = await import("../swarm/memory.js");
const { registerTool, unregisterTool } = await import("../tools/registry.js");
const { resolveThinkingControls } = await import("../providers/lmstudio.js");

const AGENT = "synthesis_controls_probe";
const WORKER_PIN = { enableThinking: false, reasoningEffort: "medium" } as const;

function writeTempConfig(tiers?: { routing?: string; synthesis?: string }, maxIterations = 1): void {
  writeFileSync(configPath, JSON.stringify({
    agents: {
      defaultContainerized: false,
      defaults: { model: { ...(tiers ? { tiers } : {}) } },
    },
    subAgents: {
      [AGENT]: {
        description: "Probe specialist that exercises synthesis-pass thinking controls.",
        systemPrompt: "Gather evidence with the tools, then answer.",
        tools: ["web_fetch"],
        maxIterations,
        // The researcher's pin: the graded effort vetoes the off-switch on the worker.
        model: { ...WORKER_PIN },
      },
    },
  }), "utf8");
  resetConfigForTests();
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    content: "",
    tool_calls: [{ id, name, arguments: args }],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "tool_calls",
  };
}

function text(content: string) {
  return {
    content,
    tool_calls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "stop",
  };
}

/** Long enough (>= distillSharedFactsMinChars 200 after extraction) to reach the distillation call. */
const FETCHED_PAGE = [
  "IM73A135V01 — Infineon analog MEMS microphone. Signal-to-noise ratio 73 dB(A), sensitivity -38 dBV/Pa,",
  "acoustic overload point 135 dB SPL, IP57 dust and water protection, supply voltage 1.62 V to 3.6 V,",
  "current consumption 170 uA in normal mode and 45 uA in low-power mode, frequency response 20 Hz to 20 kHz,",
  "package 3.5 x 2.65 x 0.98 mm, operating temperature -40 C to +85 C. Source: https://www.infineon.com/im73a135v01",
].join(" ");

function registerFakeFetch() {
  registerTool({
    name: "web_fetch",
    description: "Fetch a web page.",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { success: true, output: FETCHED_PAGE } as never;
    },
  });
  return () => unregisterTool("web_fetch");
}

/** One tool call uses up maxIterations=1, so the run ends in the max-iterations synthesis pass.
 *  `extra` overrides that script: a larger iteration budget plus a worker response queue. */
async function runProbe(
  tiers?: { routing?: string; synthesis?: string },
  extra: { maxIterations?: number; responses?: unknown[]; tag?: string } = {},
) {
  writeTempConfig(tiers, extra.maxIterations ?? 1);
  const queue: unknown[] = extra.responses ?? [
    toolCall("f1", "web_fetch", { url: "https://www.infineon.com/im73a135v01" }),
    text("Final answer written from the curated findings."),
  ];
  state.responseQueue.mockImplementation(() => queue.shift() ?? text("Fallback answer."));
  const cleanup = registerFakeFetch();
  try {
    return await runSubAgentWithStats({
      agentName: AGENT,
      task: "Verify the IM73A135V01 microphone specs.",
      parentSessionId: `parent-synthesis-controls-${extra.tag ?? (tiers ? "tiered" : "untiered")}`,
      workspacePath: tempDir,
    });
  } finally {
    cleanup();
  }
}

const workerCall = () => state.calls.find((c) => c.options?.toolChoice === "auto");
const synthesisCall = () => state.calls.find((c) => c.options?.toolChoice === "none" && !isDistillPrompt(c.messages));
const distillCall = () => state.calls.find((c) => isDistillPrompt(c.messages));

describe("sub-agent synthesis and distillation run thinking-off", () => {
  afterAll(() => {
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    state.calls.length = 0;
    state.tierCalls.length = 0;
    state.createCalls.length = 0;
    state.responseQueue.mockReset();
    distillAnswer = SHORT_DISTILLATION;
    resetConfigForTests();
    await resetSharedMemoryForTests();
  });

  it("no synthesis tier: the synthesis pass runs on the worker's model and endpoint with thinking off", async () => {
    await runProbe();

    const worker = workerCall();
    const synth = synthesisCall();
    expect(worker).toBeDefined();
    expect(synth).toBeDefined();
    // The worker itself kept its pin — the override is scoped to the synthesis instance.
    expect(worker!.modelConfig).toMatchObject(WORKER_PIN);
    // Same model, same endpoint as the worker...
    expect(synth!.modelConfig["primary"]).toBe(worker!.modelConfig["primary"]);
    expect(synth!.modelConfig["baseUrl"]).toBe(worker!.modelConfig["baseUrl"]);
    // ...and the OFF-switch both ways, past the graded pin.
    expect(synth!.modelConfig).toMatchObject({ enableThinking: false, reasoningEffort: "none" });
    // Both fallbacks (synthesis, distillation) were built by the factory from the worker's
    // own config — the same endpoint object the worker was built with — not by the tier ladder.
    const thinkingOffCreates = state.createCalls.filter((args) =>
      (args[0] as Record<string, unknown>)["reasoningEffort"] === "none");
    const workerCreate = state.createCalls.find((args) =>
      (args[0] as Record<string, unknown>)["reasoningEffort"] === "medium");
    expect(workerCreate).toBeDefined();
    expect(thinkingOffCreates).toHaveLength(2);
    for (const create of thinkingOffCreates) {
      expect((create[0] as Record<string, unknown>)["primary"]).toBe((workerCreate![0] as Record<string, unknown>)["primary"]);
      expect(create[1]).toBe(workerCreate![1]);
    }
    expect(state.tierCalls.filter((args) => args[0] === "synthesis")).toEqual([
      ["synthesis", { enableThinking: false, reasoningEffort: "none" }],
    ]);

    // What the merged config puts on the wire for this model family: "none", where the
    // worker's own pin put nothing (the model's default, which is deliberation).
    const model = String(worker!.modelConfig["primary"]);
    expect(resolveThinkingControls(model, synth!.modelConfig as never).reasoningEffort).toBe("none");
    expect(resolveThinkingControls(model, worker!.modelConfig as never).reasoningEffort).toBeUndefined();
  });

  it("with a synthesis tier: the tier call carries the synthesis controls and the tier model serves the pass", async () => {
    await runProbe({ synthesis: "lmstudio/qwen-small" });

    expect(state.tierCalls.filter((args) => args[0] === "synthesis")).toEqual([
      ["synthesis", { enableThinking: false, reasoningEffort: "none" }],
    ]);
    const synth = synthesisCall();
    expect(synth).toBeDefined();
    expect(synth!.modelConfig["primary"]).toBe("lmstudio/qwen-small");
    expect(synth!.modelConfig).toMatchObject({ enableThinking: false, reasoningEffort: "none" });
    // The worker did not move to the tier model.
    expect(workerCall()!.modelConfig["primary"]).not.toBe("lmstudio/qwen-small");
  });

  it("the empty-response rescue runs on the synthesis provider, not under the worker's thinking pin", async () => {
    // The rescues are the same prose-from-history forced-answer shape as the three synthesis
    // passes — and until now the only ones still issued against `provider`, i.e. with the
    // worker's thinking on (824 s across five such calls, ~20 % of it answer).
    await runProbe(undefined, {
      maxIterations: 5,
      tag: "rescue",
      responses: [
        toolCall("f1", "web_fetch", { url: "https://www.infineon.com/im73a135v01" }),
        text(""),
        text("Rescued answer built from the fetched page."),
      ],
    });

    const worker = workerCall();
    const rescue = synthesisCall();
    expect(worker).toBeDefined();
    expect(rescue).toBeDefined();
    // Same model + endpoint (the prompt replays this run's head, so the prefix stays warm)...
    expect(rescue!.modelConfig["primary"]).toBe(worker!.modelConfig["primary"]);
    expect(rescue!.modelConfig["baseUrl"]).toBe(worker!.modelConfig["baseUrl"]);
    expect(rescue!.messages[0]).toEqual(worker!.messages[0]);
    expect(String(rescue!.messages[rescue!.messages.length - 1]!.content))
      .toContain("You returned an empty response");
    // ...with the off-switch past the graded pin, which the worker itself still carries.
    expect(rescue!.modelConfig).toMatchObject({ enableThinking: false, reasoningEffort: "none" });
    expect(worker!.modelConfig["reasoningEffort"]).toBe("medium");
  });

  it("a forced-final iteration carries the synthesis controls per call; a tool-using one carries none", async () => {
    // tool_choice "none" on the main loop has exactly three producers (final iteration,
    // time-critical, loop-stop) and all three are "answer from what you gathered" — nothing
    // left to deliberate about. The controls travel PER CALL here because the loop keeps
    // using the worker instance (its warm prefix is the whole point).
    await runProbe(undefined, {
      maxIterations: 2,
      tag: "finaliter",
      responses: [
        toolCall("f1", "web_fetch", { url: "https://www.infineon.com/im73a135v01" }),
        text("Final answer on the last iteration."),
      ],
    });

    const loopCalls = state.calls.filter((c) => !isDistillPrompt(c.messages));
    expect(loopCalls).toHaveLength(2);
    const [gather, forced] = loopCalls as [RecordedCall, RecordedCall];
    // A normal tool-using iteration states no opinion — the worker's own pin stands.
    expect(gather.options?.toolChoice).toBe("auto");
    expect(gather.options?.controls).toBeUndefined();
    // The forced-final one is thinking-off, on the same (worker) provider instance.
    expect(forced.options?.toolChoice).toBe("none");
    expect(forced.options?.controls).toEqual({ enableThinking: false, reasoningEffort: "none" });
    expect(forced.modelConfig).toBe(gather.modelConfig);
    expect(forced.modelConfig["reasoningEffort"]).toBe("medium");
  });

  it("the facts-first synthesis prompt goes out with NO tool list; the history-bearing one keeps the run's", async () => {
    // completeWithoutTools attaches the run's wire list because that keeps the prefix warm for
    // a prompt that replays this run's head. The facts-first prompt is 2 messages with a head
    // that is NOT this run's systemPrompt — nothing can match the cache, so the 18 schemas are
    // ~2,911 tokens of pure cold prefill (7,027 processed / 7.28 s on the 7K probe).
    distillAnswer = LONG_DISTILLATION;
    await runProbe(undefined, { tag: "factsfirst" });

    const worker = workerCall();
    const factsFirst = synthesisCall();
    expect(factsFirst).toBeDefined();
    expect(factsFirst!.messages).toHaveLength(2);
    expect(String(factsFirst!.messages[0]!.content)).toContain("CURATED FINDINGS");
    expect(String(factsFirst!.messages[0]!.content)).not.toContain("Gather evidence with the tools");
    expect(factsFirst!.toolNames).toEqual([]);
    // The run's own calls still carry the list.
    expect(worker!.toolNames).toEqual(["web_fetch"]);

    // Same run shape, short distillation: curated findings stay under SYNTH_FACTS_MIN_CHARS,
    // the synthesis replays the run's head, and the list rides along with it.
    state.calls.length = 0;
    distillAnswer = SHORT_DISTILLATION;
    await resetSharedMemoryForTests();
    await runProbe(undefined, { tag: "historybearing" });

    const worker2 = workerCall();
    const history = synthesisCall();
    expect(history).toBeDefined();
    expect(history!.messages[0]).toEqual(worker2!.messages[0]);
    expect(history!.messages.some((m) => m.role === "tool")).toBe(true);
    expect(history!.toolNames).toEqual(worker2!.toolNames);
    expect(history!.toolNames).toEqual(["web_fetch"]);
  });

  it("no routing tier: per-finding distillation runs on the worker's model under the routing controls", async () => {
    await runProbe();

    const worker = workerCall();
    const distill = distillCall();
    expect(worker).toBeDefined();
    expect(distill).toBeDefined();
    expect(distill!.method).toBe("complete");
    expect(distill!.toolNames).toEqual([]);
    expect(distill!.modelConfig["primary"]).toBe(worker!.modelConfig["primary"]);
    expect(distill!.modelConfig["baseUrl"]).toBe(worker!.modelConfig["baseUrl"]);
    // tierModelDefaults("routing"): thinking off, expressed both ways.
    expect(distill!.modelConfig).toMatchObject({ enableThinking: false, reasoningEffort: "none" });
    // Not the worker instance: that one still carries the graded pin.
    expect(distill!.modelConfig).not.toBe(worker!.modelConfig);
    expect(worker!.modelConfig["reasoningEffort"]).toBe("medium");
  });
});
