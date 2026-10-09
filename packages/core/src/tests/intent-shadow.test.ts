/**
 * The intent readout's post-turn shadow (agent/intent-shadow.ts): it is asked only after the turn
 * has delivered, never with the flag off, never while a turn runs, in both option orders one call
 * after the other; any turn start aborts it, whichever call is on the wire; the row sets the readout
 * beside what the turn did, read from the turn's own audit rows, says per facet whether the two
 * orders agreed, and holds no user text. Recorded providers only — no model is called.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompletionCallOptions, LLMMessage, LLMResponse, LLMTokenLogprob } from "../providers/lmstudio.js";

const configState = vi.hoisted(() => ({
  mode: "shadow" as "off" | "shadow",
  split: true,
}));

vi.mock("../config/loader.js", () => ({
  getConfig: () => ({
    orchestration: { intentReadout: configState.mode },
    agents: { performance: { splitOrchestrationPrompt: configState.split } },
    subAgents: {
      researcher: { description: "Finds and verifies sources on the web" },
      web_coder: { description: "Builds websites and web apps" },
    },
  }),
}));

type AuditArgs = [string, Record<string, unknown>, { sessionId?: string } | undefined];
const audit = vi.hoisted(() => ({
  rows: [] as AuditArgs[],
  subscribers: new Set<(event: { type: string; sessionId?: string; data: Record<string, unknown> }) => void>(),
  subscribeCalls: 0,
}));

vi.mock("../audit/logger.js", () => ({
  logAudit: (type: string, data: Record<string, unknown>, opts?: { sessionId?: string }) => {
    audit.rows.push([type, data, opts]);
    for (const subscriber of audit.subscribers) subscriber({ type, sessionId: opts?.sessionId, data });
  },
  subscribeToAudit: (fn: (event: { type: string; sessionId?: string; data: Record<string, unknown> }) => void) => {
    audit.subscribeCalls += 1;
    audit.subscribers.add(fn);
    return () => audit.subscribers.delete(fn);
  },
}));

type Complete = (messages: LLMMessage[], tools: unknown, signal?: AbortSignal, options?: CompletionCallOptions) => Promise<LLMResponse>;
const providerState = vi.hoisted(() => ({
  complete: null as unknown as (...args: unknown[]) => Promise<unknown>,
  /** The routing tier's model id, as routingTierModelId resolves it. */
  modelId: "lmstudio/qwen",
}));

vi.mock("../agent/routing-tier-provider.js", () => ({
  resolveRoutingTierProvider: () => ({ complete: (...args: unknown[]) => providerState.complete(...args) }),
  routingTierModelId: () => providerState.modelId,
}));

import {
  buildIntentShadowRowData,
  foldIntentShadowEvent,
  intentShadowStateForTests,
  intentShadowTurnEnded,
  intentShadowTurnStarted,
  noteIntentShadowCapsule,
  resetIntentShadowForTests,
  settleIntentShadowForTests,
  type IntentShadowFacts,
  type IntentShadowTurnInput,
} from "../agent/intent-shadow.js";
import { logAudit } from "../audit/logger.js";
import { OrchestrationSchema } from "../config/schemas/orchestration.js";
import {
  buildIntentReadoutSystemPrompt,
  INTENT_FACETS,
  INTENT_READOUT_BOTH_ORDERS_VERSION,
  INTENT_READOUT_GRAMMAR,
  INTENT_READOUT_SYSTEM_PROMPT,
  INTENT_READOUT_VERSION,
  reversedFacets,
} from "../decisions/intent-readout.js";
import { LETTERS } from "../decisions/logit-readout.js";
import { currentRequestContext, runWithRequestContext } from "../runtime/request-context.js";
import { warmTextLanguageDetector } from "../agent/text-language.js";
import type { TurnOutput } from "../agent/turn-types.js";

// ── A recorded routing tier ──────────────────────────────────────────────────────────────────────

type Top = Array<[string, number]>;

function tok(token: string, top: Top = [[token, -0.01], ["\n", -6]]): LLMTokenLogprob {
  const own = top.find(([t]) => t === token)?.[1] ?? -0.01;
  return { token, logprob: own, topLogprobs: top.map(([t, logprob]) => ({ token: t, logprob })) };
}

/** The prefix of the both-orders readout's second call: every facet's options reversed. */
const REVERSED_PREFIX = buildIntentReadoutSystemPrompt(reversedFacets());

function isReversed(messages: readonly LLMMessage[]): boolean {
  return messages[0]?.content === REVERSED_PREFIX;
}

/**
 * The measured token shape (decisions/intent-readout.ts): label, ":", " <letter>", newline; the
 * restatement last. `letters` are the served order's; asked with the options reversed, the reply
 * writes the letter each option has there, so both orders read the same options — unless
 * `reversedLetters` says otherwise for a facet, or `reversedMisses` puts a control token on its slot.
 */
function intentReply(
  letters: Partial<Record<string, string>>,
  query: string,
  reversed = false,
  opts: { reversedLetters?: Partial<Record<string, string>>; reversedMisses?: readonly string[] } = {},
): LLMResponse {
  const tokens: LLMTokenLogprob[] = [];
  for (const definition of INTENT_FACETS) {
    const served = letters[definition.name] ?? "A";
    const letter = !reversed ? served : opts.reversedLetters?.[definition.name] ?? LETTERS[definition.keys.length - 1 - LETTERS.indexOf(served)]!;
    const top: Array<[string, number]> = reversed && opts.reversedMisses?.includes(definition.name)
      ? [["<|im_end|>", -0.05], [` ${letter}`, -3.5]]
      : [[` ${letter}`, -0.05], [letter === "A" ? " B" : " A", -3.5], ["\n", -7]];
    if (tokens.length > 0) tokens.push(tok("\n"));
    tokens.push(tok(definition.name), tok(":"), tok(` ${letter}`, top));
  }
  tokens.push(tok("\n"), tok("query_en"), tok(":"), tok(` ${query}`));
  return {
    content: tokens.map((entry) => entry.token).join(""),
    tool_calls: [],
    usage: { promptTokens: 0, completionTokens: tokens.length, totalTokens: tokens.length },
    finishReason: "stop",
    logprobs: tokens,
  } as unknown as LLMResponse;
}

/** A one-token letter readout (askReadout): `letter` on top. */
function letterReply(letter: string): LLMResponse {
  return {
    content: letter,
    tool_calls: [],
    usage: { promptTokens: 0, completionTokens: 1, totalTokens: 1 },
    finishReason: "stop",
    logprobs: [tok(letter, [[letter, -0.02], [letter === "A" ? "B" : "A", -4.2], ["C", -6]])],
  } as unknown as LLMResponse;
}

interface Call {
  kind: "intent" | "pre_route";
  /** An intent call on the reversed prefix: the both-orders readout's second call. */
  reversed: boolean;
  messages: LLMMessage[];
  signal: AbortSignal | undefined;
  options: CompletionCallOptions | undefined;
  context: ReturnType<typeof currentRequestContext>;
}

const calls: Call[] = [];
const order: string[] = [];

function recordCall(messages: LLMMessage[], signal: AbortSignal | undefined, options: CompletionCallOptions | undefined): Call {
  const call: Call = { kind: options?.grammar ? "intent" : "pre_route", reversed: isReversed(messages), messages, signal, options, context: currentRequestContext() };
  calls.push(call);
  return call;
}

/** The default routing tier: answers every question at once, records what it was asked and under which attribution. */
function recordingProvider(opts: {
  query?: string;
  letters?: Partial<Record<string, string>>;
  reversedLetters?: Partial<Record<string, string>>;
  reversedMisses?: readonly string[];
  preRoute?: string;
} = {}): Complete {
  return async (messages, _tools, signal, options) => {
    const call = recordCall(messages, signal, options);
    order.push(call.kind);
    return call.kind === "intent"
      ? intentReply(opts.letters ?? { mode: "C", decision: "C" }, opts.query ?? "Restated request.", call.reversed, opts)
      : letterReply(opts.preRoute ?? "A");
  };
}

/** A routing tier that answers after `ms`, or rejects the moment its signal aborts (as fetch does). */
function slowProvider(ms: number, honourAbort = true): Complete {
  return (messages, _tools, signal, options) => {
    const call = recordCall(messages, signal, options);
    return new Promise<LLMResponse>((resolve, reject) => {
      const timer = setTimeout(() => resolve(intentReply({}, "Restated.", call.reversed)), ms);
      if (honourAbort) {
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }
    });
  };
}

function useProvider(complete: Complete): void {
  providerState.complete = complete as unknown as (...args: unknown[]) => Promise<unknown>;
}

// ── Turns ────────────────────────────────────────────────────────────────────────────────────────

function turnInput(overrides: Partial<IntentShadowTurnInput> = {}): IntentShadowTurnInput {
  return {
    sessionId: "sess-1",
    turnId: "turn-1",
    channel: "web",
    userMessage: "Please build me a small landing page for the bakery",
    priorTurnDigest: () => undefined,
    nested: false,
    ...overrides,
  };
}

function output(overrides: Partial<TurnOutput> = {}): TurnOutput {
  return {
    response: "Here it is.",
    toolCallsExecuted: 0,
    guardrailEvents: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    blocked: false,
    ...overrides,
  };
}

function shadowRows(): Array<Record<string, unknown>> {
  return audit.rows.filter(([type]) => type === "intent_readout_shadow").map(([, data]) => data);
}

function onlyRow(): Record<string, unknown> & { actual: Record<string, unknown>; preRoute: Record<string, unknown>; readout: Record<string, unknown> | null } {
  const rows = shadowRows();
  expect(rows).toHaveLength(1);
  return rows[0] as never;
}

beforeAll(async () => {
  await warmTextLanguageDetector();
});

beforeEach(() => {
  resetIntentShadowForTests();
  configState.mode = "shadow";
  configState.split = true;
  audit.rows.length = 0;
  audit.subscribers.clear();
  audit.subscribeCalls = 0;
  calls.length = 0;
  order.length = 0;
  providerState.modelId = "lmstudio/qwen";
  useProvider(recordingProvider());
});

afterEach(async () => {
  await settleIntentShadowForTests();
});

// ── When it runs ─────────────────────────────────────────────────────────────────────────────────

describe("when the shadow runs", () => {
  it("is off unless a config turns it on: a call per turn, and a warm head at stake", () => {
    expect(OrchestrationSchema.parse({}).intentReadout).toBe("off");
  });

  it("with the flag off: no tap, no call, no row", async () => {
    configState.mode = "off";
    const handle = intentShadowTurnStarted(turnInput());
    intentShadowTurnEnded(handle, output());
    await settleIntentShadowForTests();
    expect(handle.collecting).toBeNull();
    expect(audit.subscribeCalls).toBe(0);
    expect(calls).toHaveLength(0);
    expect(shadowRows()).toHaveLength(0);
  });

  it("with the flag turned off between the turn's end and the launch: no call", async () => {
    const handle = intentShadowTurnStarted(turnInput());
    intentShadowTurnEnded(handle, output());
    configState.mode = "off";
    await settleIntentShadowForTests();
    expect(calls).toHaveLength(0);
  });

  it("only after the turn's own continuation (where the gateway sends the reply), never before", async () => {
    const handle = intentShadowTurnStarted(turnInput());
    expect(calls).toHaveLength(0);
    intentShadowTurnEnded(handle, output());
    // The gateway sends the reply in the continuation of runTurn's promise, queued after runTurn's
    // `finally` has run: the same position as this microtask.
    void Promise.resolve().then(() => order.push("delivered"));
    expect(calls).toHaveLength(0);
    await Promise.resolve();
    expect(calls).toHaveLength(0);
    await settleIntentShadowForTests();
    // The readout in both orders, one call after the other.
    expect(order).toEqual(["delivered", "intent", "intent"]);
    expect(onlyRow().status).toBe("ok");
  });

  it("asks the readout in both option orders, grammar-bound and greedy, one call after the other, attributed to its own call site on the turn's session", async () => {
    // Each call answers after a few milliseconds; a second one sent before the first returned counts as overlap.
    let open = 0;
    let maxOpen = 0;
    const answer = recordingProvider();
    useProvider(async (messages, tools, signal, options) => {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await answer(messages, tools, signal, options);
      } finally {
        open -= 1;
      }
    });
    const handle = intentShadowTurnStarted(turnInput({ userId: "alice" }));
    noteIntentShadowCapsule("sess-1", { status: "ok", agents: ["researcher", "web_coder"] });
    intentShadowTurnEnded(handle, output());
    await settleIntentShadowForTests();
    const intent = calls.filter((call) => call.kind === "intent");
    expect(intent).toHaveLength(2);
    expect(maxOpen).toBe(1);
    // The served order first, then every facet's options reversed, on the same grammar and case.
    expect(intent.map((call) => call.messages[0]!.content)).toEqual([INTENT_READOUT_SYSTEM_PROMPT, REVERSED_PREFIX]);
    expect(intent[1]!.messages[1]).toEqual(intent[0]!.messages[1]);
    for (const call of intent) {
      expect(call.options?.grammar).toBe(INTENT_READOUT_GRAMMAR);
      expect(call.options?.temperature).toBe(0);
      expect(call.context).toMatchObject({ callSite: "intent_shadow", agentName: "intent_readout", sessionId: "sess-1", turnId: "turn-1", userId: "alice" });
    }
    expect(intent[1]!.signal).toBe(intent[0]!.signal);
    const pre = calls.filter((call) => call.kind === "pre_route");
    expect(pre).toHaveLength(1);
    expect(pre[0]!.context).toMatchObject({ callSite: "intent_shadow", agentName: "pre_router_readout", sessionId: "sess-1" });
    // The pre-router's options are the capsule the turn had, "none" last.
    const question = pre[0]!.messages.map((message) => String(message.content)).join("\n");
    expect(question.indexOf("researcher")).toBeGreaterThan(-1);
    expect(question.indexOf("researcher")).toBeLessThan(question.indexOf("web_coder"));
    expect(question.indexOf("web_coder")).toBeLessThan(question.lastIndexOf("none"));
  });

  it("is aborted by a turn of ANY session starting, and asks nothing more", async () => {
    useProvider(slowProvider(200));
    const handle = intentShadowTurnStarted(turnInput());
    noteIntentShadowCapsule("sess-1", { status: "ok", agents: ["researcher"] });
    intentShadowTurnEnded(handle, output());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal?.aborted).toBe(false);
    const other = intentShadowTurnStarted(turnInput({ sessionId: "sess-2", turnId: "turn-2" }));
    expect(calls[0]!.signal?.aborted).toBe(true);
    await settleIntentShadowForTests();
    const row = onlyRow();
    expect(row.status).toBe("aborted");
    expect(row.reason).toBe("new_turn");
    expect(row.readout).toBeNull();
    // Neither the reversed order's call nor the pre-route question after the abort.
    expect(calls).toHaveLength(1);
    intentShadowTurnEnded(other, undefined);
  });

  it("is aborted during the reversed order's call too: that call sees the abort, and the row is no half reading", async () => {
    // The served order answers at once; the reversed call hangs until its signal aborts.
    const answer = recordingProvider();
    useProvider((messages, tools, signal, options) => {
      if (!isReversed(messages)) return answer(messages, tools, signal, options);
      recordCall(messages, signal, options);
      return new Promise<LLMResponse>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    const handle = intentShadowTurnStarted(turnInput());
    noteIntentShadowCapsule("sess-1", { status: "ok", agents: ["researcher"] });
    intentShadowTurnEnded(handle, output());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.map((call) => call.reversed)).toEqual([false, true]);
    expect(calls[1]!.signal?.aborted).toBe(false);
    const other = intentShadowTurnStarted(turnInput({ sessionId: "sess-2", turnId: "turn-2" }));
    expect(calls[1]!.signal?.aborted).toBe(true);
    await settleIntentShadowForTests();
    expect(onlyRow()).toMatchObject({ status: "aborted", reason: "new_turn", readout: null, readoutFailure: "aborted" });
    // No pre-route question after the abort.
    expect(calls).toHaveLength(2);
    intentShadowTurnEnded(other, undefined);
  });

  it("is skipped while another turn runs", async () => {
    const first = intentShadowTurnStarted(turnInput());
    const second = intentShadowTurnStarted(turnInput({ sessionId: "sess-2", turnId: "turn-2" }));
    intentShadowTurnEnded(first, output());
    await settleIntentShadowForTests();
    expect(calls).toHaveLength(0);
    expect(onlyRow()).toMatchObject({ status: "skipped", reason: "busy", readout: null });
    intentShadowTurnEnded(second, output());
    await settleIntentShadowForTests();
    // The second turn's readout, in both orders.
    expect(calls.filter((call) => call.kind === "intent")).toHaveLength(2);
    expect(shadowRows().map((row) => row["status"])).toEqual(["skipped", "ok"]);
  });

  it("is skipped when a turn started after it was scheduled, even one that has already ended", async () => {
    const first = intentShadowTurnStarted(turnInput());
    intentShadowTurnEnded(first, output());
    // Before the macrotask: a whole short turn of another session comes and goes.
    const second = intentShadowTurnStarted(turnInput({ sessionId: "sess-2", turnId: "turn-2" }));
    intentShadowTurnEnded(second, output());
    await settleIntentShadowForTests();
    const rows = shadowRows();
    expect(rows.map((row) => [row["turnId"], row["status"], row["reason"]])).toEqual([
      ["turn-1", "skipped", "superseded"],
      ["turn-2", "ok", null],
    ]);
  });

  it("is skipped while an earlier shadow's request is still open, however its abort went", async () => {
    // A provider that ignores the abort: the request stays open, and so must the slot. Every
    // request it holds is released at once, so a second one sent by mistake fails the count
    // below instead of hanging the suite.
    const held: Array<() => void> = [];
    let released = false;
    const release = () => {
      released = true;
      for (const resolve of held.splice(0)) resolve();
    };
    useProvider((messages, _tools, signal, options) => {
      const call = recordCall(messages, signal, options);
      // After the release every request answers at once, so a later one cannot hang the suite either.
      if (released) return Promise.resolve(intentReply({}, "Restated.", call.reversed));
      return new Promise<LLMResponse>((resolve) => { held.push(() => resolve(intentReply({}, "Restated.", call.reversed))); });
    });
    const first = intentShadowTurnStarted(turnInput());
    intentShadowTurnEnded(first, output());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const callsBeforeSecond = calls.length;
    const second = intentShadowTurnStarted(turnInput({ sessionId: "sess-2", turnId: "turn-2" }));
    intentShadowTurnEnded(second, output());
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Observed while held, asserted after the release, so a failure never leaves a request open.
    const inFlightWhileHeld = intentShadowStateForTests().inFlight;
    const callsWhileHeld = calls.length;
    release();
    await settleIntentShadowForTests();
    expect(callsBeforeSecond).toBe(1);
    expect(inFlightWhileHeld).toBe(true);
    expect(callsWhileHeld).toBe(1);
    expect(intentShadowStateForTests().inFlight).toBe(false);
    const byTurn = Object.fromEntries(shadowRows().map((row) => [row["turnId"], row]));
    expect(byTurn["turn-2"]).toMatchObject({ status: "skipped", reason: "in_flight" });
  });

  it("does not shadow a nested turn, a scene step, a blocked turn or a turn that threw", async () => {
    for (const input of [turnInput({ nested: true }), turnInput({ channel: "scene" })]) {
      const handle = intentShadowTurnStarted(input);
      expect(handle.collecting).toBeNull();
      intentShadowTurnEnded(handle, output());
    }
    const blocked = intentShadowTurnStarted(turnInput());
    intentShadowTurnEnded(blocked, output({ blocked: true }));
    const threw = intentShadowTurnStarted(turnInput());
    intentShadowTurnEnded(threw, undefined);
    await settleIntentShadowForTests();
    expect(calls).toHaveLength(0);
    expect(shadowRows()).toHaveLength(0);
    expect(intentShadowStateForTests()).toEqual({ activeTurns: 0, inFlight: false, collecting: 0 });
  });

  it("is not asked of an Anthropic routing tier (a Claude preset): no logprobs, and a paid call", async () => {
    providerState.modelId = "anthropic/claude-sonnet-4-5";
    const handle = intentShadowTurnStarted(turnInput());
    noteIntentShadowCapsule("sess-1", { status: "ok", agents: ["researcher"] });
    intentShadowTurnEnded(handle, output());
    await settleIntentShadowForTests();
    expect(calls).toHaveLength(0);
    expect(onlyRow()).toMatchObject({ status: "skipped", reason: "no_logprobs_provider", readout: null });
  });

  it("never fails the turn: a prior-turn digest that throws leaves it unshadowed and still counted", async () => {
    const handle = intentShadowTurnStarted(turnInput({ priorTurnDigest: () => { throw new Error("history unavailable"); } }));
    expect(handle.collecting).toBeNull();
    expect(intentShadowStateForTests()).toMatchObject({ activeTurns: 1, collecting: 0 });
    intentShadowTurnEnded(handle, output());
    await settleIntentShadowForTests();
    expect(intentShadowStateForTests().activeTurns).toBe(0);
    expect(calls).toHaveLength(0);
    expect(shadowRows()).toHaveLength(0);
  });

  it("keeps what a superseded turn of the same session writes while it unwinds out of the turn that replaced it", async () => {
    // gateway/rpc.ts aborts the running turn and starts the new one at once; the old one is still in
    // its first prompt assembly, waiting on its capsule.
    const old = intentShadowTurnStarted(turnInput({ turnId: "turn-old" }));
    const next = intentShadowTurnStarted(turnInput({ turnId: "turn-new" }));
    runWithRequestContext({ sessionId: "sess-1", turnId: "turn-old", agentName: "main", callSite: "main_turn" }, () => {
      noteIntentShadowCapsule("sess-1", { status: "ok", agents: ["researcher"] });
      logAudit("prompt_section_sizes", { orchestrationModule: 13_000 }, { sessionId: "sess-1" });
      logAudit("message_received", { fastLane: false, escalateReason: "micro-call-error" }, { sessionId: "sess-1" });
    });
    // A specialist the old turn had already dispatched logs its start under the same session prefix.
    runWithRequestContext({ turnId: "turn-old", agentName: "researcher", callSite: "sub_agent" }, () => {
      logAudit("sub_agent_started", { agentName: "researcher" }, { sessionId: "sub:sess-1:researcher:1" });
    });
    intentShadowTurnEnded(old, output({ blocked: true }));
    runWithRequestContext({ sessionId: "sess-1", turnId: "turn-new", agentName: "main", callSite: "main_turn" }, () => {
      noteIntentShadowCapsule("sess-1", { status: "ok", agents: ["web_coder"] });
      logAudit("prompt_section_sizes", { orchestrationModule: 0 }, { sessionId: "sess-1" });
    });
    runWithRequestContext({ turnId: "turn-new", agentName: "web_coder", callSite: "sub_agent" }, () => {
      logAudit("sub_agent_started", { agentName: "web_coder" }, { sessionId: "sub:sess-1:web_coder:2" });
    });
    intentShadowTurnEnded(next, output());
    await settleIntentShadowForTests();
    const row = onlyRow();
    expect(row["turnId"]).toBe("turn-new");
    expect(row.actual).toMatchObject({
      fastLane: "not_offered",
      capsule: { status: "ok", agents: ["web_coder"], trimmed: false },
      moduleChars: 0,
      subAgentRuns: 1,
      firstAgent: "web_coder",
    });
    // The pre-router was offered the new turn's capsule.
    const question = calls.filter((call) => call.kind === "pre_route").map((call) => call.messages.map((message) => String(message.content)).join("\n")).join("\n");
    expect(question).toContain("web_coder");
    expect(question).not.toContain("researcher");
  });

  it("does not uncount another turn when a turn ends that was never counted", () => {
    const running = intentShadowTurnStarted(turnInput());
    // runTurn's finally with no handle: the turn threw before it reached the start hook.
    intentShadowTurnEnded(undefined, undefined);
    expect(intentShadowStateForTests().activeTurns).toBe(1);
    intentShadowTurnEnded(running, undefined);
    expect(intentShadowStateForTests().activeTurns).toBe(0);
  });

  it("still asks the pre-route question over a capsule the prompt budget trimmed, and says so", async () => {
    const handle = intentShadowTurnStarted(turnInput());
    noteIntentShadowCapsule("sess-1", { status: "ok", agents: ["researcher"] });
    logAudit("prompt_budget_exceeded", { droppedSections: ["memory", "discoveryCapsule"] }, { sessionId: "sess-1" });
    intentShadowTurnEnded(handle, output());
    await settleIntentShadowForTests();
    expect(calls.filter((call) => call.kind === "pre_route")).toHaveLength(1);
    expect(onlyRow().actual["capsule"]).toEqual({ status: "ok", agents: ["researcher"], trimmed: true });
  });

  it("does not ask the pre-route question without a capsule, or with one that came too late", async () => {
    const none = intentShadowTurnStarted(turnInput());
    intentShadowTurnEnded(none, output());
    await settleIntentShadowForTests();
    const late = intentShadowTurnStarted(turnInput({ turnId: "turn-2" }));
    noteIntentShadowCapsule("sess-1", { status: "timeout" });
    // A second note (a later iteration, a stray call) does not overwrite the first.
    noteIntentShadowCapsule("sess-1", { status: "ok", agents: ["researcher"] });
    intentShadowTurnEnded(late, output());
    await settleIntentShadowForTests();
    expect(calls.filter((call) => call.kind === "pre_route")).toHaveLength(0);
    const rows = shadowRows() as Array<{ preRoute: { status: string }; actual: { capsule: { status: string } } }>;
    expect(rows.map((row) => [row.actual.capsule.status, row.preRoute.status])).toEqual([["not_run", "no_candidates"], ["timeout", "no_candidates"]]);
  });
});

// ── What the turn did ────────────────────────────────────────────────────────────────────────────

function facts(): IntentShadowFacts {
  return {
    fastLane: "not_offered",
    fastLaneReason: null,
    judge: { status: "not_run", verdict: null, decidedBy: null },
    capsule: { status: "not_run", agents: [], trimmed: false },
    subAgentRuns: [],
    workflowRuns: 0,
    moduleChars: null,
    triage: null,
  };
}

describe("the turn's outcomes, read from its own audit rows", () => {
  it("reads the front desk, the judge, the module, the specialists, the workflows and the triage", () => {
    const f = facts();
    const fold = (type: string, sessionId: string, data: Record<string, unknown>) => foldIntentShadowEvent(f, "S", { type: type as never, sessionId, data });
    fold("message_received", "S", { length: 12 });
    expect(f.fastLane).toBe("not_offered");
    fold("message_received", "S", { fastLane: false, escalateReason: "task-intent" });
    fold("guardrail_flagged", "S", { type: "upfront_source_sensitive_detected", answered: true });
    fold("prompt_section_sizes", "S", { orchestrationModule: 13_000 });
    fold("prompt_section_sizes", "S", { orchestrationModule: 0 });
    // Direct delegations only: a sub-agent's own and a workflow step's are one level down.
    fold("sub_agent_started", "sub:S:researcher:1", { agentName: "researcher" });
    fold("sub_agent_started", "sub:sub:S:researcher:1:web_coder:2", { agentName: "web_coder" });
    fold("sub_agent_started", "sub:workflow:S:paper:u1:writer:3", { agentName: "writer" });
    fold("sub_agent_started", "S", { agentName: "researcher", stage: "discovery_fallback_strip" });
    // The same stage row for a specialist's OWN delegation is logged under that specialist's session.
    fold("sub_agent_started", "sub:S:researcher:1", { agentName: "fact_checker", stage: "discovery_fallback_strip" });
    fold("sub_agent_started", "sub:S2:other:4", { agentName: "other" });
    fold("sub_agent_started", "sub:S:web_coder:5", { agentName: "web_coder" });
    // A workflow that ran, one a plan step ran, a routing miss, a cached replay, and a failed one.
    fold("tool_call_completed", "S", { tool: "run_workflow", success: true, metadata: {} });
    fold("tool_call_completed", "S", { tool: "execute_plan", success: true, metadata: { nestedCalls: [{ tool: "run_workflow", success: true }, { tool: "delegate_to_agent", success: true }] } });
    fold("tool_call_completed", "S", { tool: "run_workflow", success: true, metadata: { workflowNotFound: true } });
    fold("tool_call_completed", "S", { tool: "run_workflow", success: true, cachedResult: true, metadata: {} });
    fold("tool_call_completed", "S", { tool: "run_workflow", success: false, repeatedIdenticalOutput: true });
    fold("tool_call_completed", "S2", { tool: "run_workflow", success: true, metadata: {} });
    fold("routing_triage_decided", "S", { verdict: { mode: "PRODUCE", domain: ["software"], deliverable: "website", decision: "single_agent", multi: false, alone: true, sourceSensitive: false } });
    expect(f).toEqual({
      fastLane: "declined",
      fastLaneReason: "task-intent",
      judge: { status: "answered", verdict: true, decidedBy: "incumbent" },
      capsule: { status: "not_run", agents: [], trimmed: false },
      subAgentRuns: ["researcher", "web_coder"],
      workflowRuns: 2,
      moduleChars: 13_000,
      triage: { mode: "PRODUCE", domain: "software", deliverable: "website", multi: "no", alone: "yes", source_sensitive: "no", decision: "single_agent" },
    });
  });

  it("does not count a successful workflow twice when the loop detector logs a second row for the same call", () => {
    const f = facts();
    // runtime.ts logs the call's own row, then — on an identical-output loop — another for the same call.
    foldIntentShadowEvent(f, "S", { type: "tool_call_completed", sessionId: "S", data: { tool: "run_workflow", success: true, metadata: {} } });
    foldIntentShadowEvent(f, "S", { type: "tool_call_completed", sessionId: "S", data: { tool: "run_workflow", success: true, repeatedIdenticalOutput: true, suspiciousReturn: true } });
    expect(f.workflowRuns).toBe(1);
  });

  it("records an ephemeral agent as 'ephemeral': its name is written from the task and can carry the user's words", async () => {
    const f = facts();
    foldIntentShadowEvent(f, "S", { type: "sub_agent_started", sessionId: "sub:S:architect:1", data: { agentName: "architect" } });
    foldIntentShadowEvent(f, "S", { type: "sub_agent_started", sessionId: "sub:S:ephemeral:quarkstrudel_bakery_writer:2", data: { agentName: "ephemeral:quarkstrudel_bakery_writer" } });
    expect(f.subAgentRuns).toEqual(["architect", "ephemeral"]);
    const handle = intentShadowTurnStarted(turnInput());
    logAudit("sub_agent_started", { agentName: "ephemeral:quarkstrudel_bakery_writer" }, { sessionId: "sub:sess-1:ephemeral:quarkstrudel_bakery_writer:3" });
    intentShadowTurnEnded(handle, output());
    await settleIntentShadowForTests();
    const row = onlyRow();
    expect(row.actual).toMatchObject({ firstAgent: "ephemeral", agents: ["ephemeral"], subAgentRuns: 1 });
    expect(JSON.stringify(row)).not.toContain("quarkstrudel");
  });

  it("tells a judge that answered 'clear' from one that gave no answer, and from no routing tier", () => {
    const clear = facts();
    foldIntentShadowEvent(clear, "S", { type: "guardrail_flagged", sessionId: "S", data: { type: "upfront_source_sensitive_clear", answered: true, decidedBy: "laya" } });
    expect(clear.judge).toEqual({ status: "answered", verdict: false, decidedBy: "laya" });
    const empty = facts();
    foldIntentShadowEvent(empty, "S", { type: "guardrail_flagged", sessionId: "S", data: { type: "upfront_source_sensitive_clear", answered: false } });
    expect(empty.judge).toEqual({ status: "no_answer", verdict: null, decidedBy: "incumbent" });
    const tierless = facts();
    foldIntentShadowEvent(tierless, "S", { type: "guardrail_flagged", sessionId: "S", data: { type: "upfront_source_sensitive_no_routing_tier" } });
    expect(tierless.judge.status).toBe("no_routing_tier");
  });

  it("puts what the turn logged while it ran on the row, and the threshold's workflow pressure from its guardrail events", async () => {
    const handle = intentShadowTurnStarted(turnInput());
    logAudit("message_received", { fastLane: false, escalateReason: "task-intent" }, { sessionId: "sess-1" });
    logAudit("guardrail_flagged", { type: "upfront_source_sensitive_clear", answered: true }, { sessionId: "sess-1" });
    logAudit("prompt_section_sizes", { orchestrationModule: 0 }, { sessionId: "sess-1" });
    logAudit("sub_agent_started", { agentName: "web_coder" }, { sessionId: "sub:sess-1:web_coder:1" });
    // Another session's turn running beside it.
    logAudit("sub_agent_started", { agentName: "researcher" }, { sessionId: "sub:sess-9:researcher:1" });
    intentShadowTurnEnded(handle, output({
      guardrailEvents: [
        { type: "workflow_required", details: "workflow_run_released_after_search" },
        { type: "workflow_required", details: "workflow_run_forced_after_search" },
        { type: "input", details: "free text never copied" },
      ],
    }));
    // After the turn: not its rows, and the tap is gone.
    expect(audit.subscribers.size).toBe(0);
    logAudit("sub_agent_started", { agentName: "researcher" }, { sessionId: "sub:sess-1:researcher:2" });
    await settleIntentShadowForTests();
    expect(onlyRow().actual).toMatchObject({
      fastLane: "declined",
      fastLaneReason: "task-intent",
      judge: { status: "answered", verdict: false },
      subAgentRuns: 1,
      firstAgent: "web_coder",
      agents: ["web_coder"],
      workflowForced: true,
      workflowPressure: ["workflow_run_released_after_search", "workflow_run_forced_after_search"],
      moduleSplit: true,
      moduleChars: 0,
      moduleIncluded: false,
    });
  });

  it("reports the module's inclusion as unknown when the prompt is not split", async () => {
    configState.split = false;
    const handle = intentShadowTurnStarted(turnInput());
    logAudit("prompt_section_sizes", { orchestrationModule: 0 }, { sessionId: "sess-1" });
    intentShadowTurnEnded(handle, output());
    await settleIntentShadowForTests();
    expect(onlyRow().actual).toMatchObject({ moduleSplit: false, moduleIncluded: null });
  });

  it("counts no pressure from the release alone", async () => {
    const handle = intentShadowTurnStarted(turnInput());
    intentShadowTurnEnded(handle, output({ guardrailEvents: [{ type: "workflow_required", details: "workflow_run_released_after_search" }] }));
    await settleIntentShadowForTests();
    expect(onlyRow().actual["workflowForced"]).toBe(false);
  });
});

// ── The row ──────────────────────────────────────────────────────────────────────────────────────

describe("the row", () => {
  it("maps each facet's letter to its option, with top, margin and the pre-router's pick", async () => {
    useProvider(recordingProvider({ letters: { mode: "C", domain: "B", deliverable: "D", decision: "B" }, preRoute: "B" }));
    const handle = intentShadowTurnStarted(turnInput());
    noteIntentShadowCapsule("sess-1", { status: "ok", agents: ["researcher", "web_coder"] });
    intentShadowTurnEnded(handle, output());
    await settleIntentShadowForTests();
    const row = onlyRow();
    const facets = row.readout!["facets"] as Record<string, { choice: string; top: number; margin: number }>;
    expect(facets["mode"]!.choice).toBe("PRODUCE");
    expect(facets["domain"]!.choice).toBe("software");
    expect(facets["deliverable"]!.choice).toBe("website");
    expect(facets["decision"]!.choice).toBe("single_agent");
    expect(facets["mode"]!.top).toBeGreaterThan(0.9);
    expect(facets["mode"]!.margin).toBeGreaterThan(0.8);
    expect(row.preRoute).toMatchObject({ status: "ok", choice: "web_coder", none: false, accepted: "web_coder" });
    expect(row.actual["capsule"]).toEqual({ status: "ok", agents: ["researcher", "web_coder"], trimmed: false });
    expect(row["language"]).toBe("en");
  });

  it("says per facet whether the two orders agreed, and carries the both-orders version, never one order's", async () => {
    // alone: yes served (A), and with the options reversed ([no, yes]) A again — "no". multi: the
    // reversed reply has a control token on its slot, so only the served order read it.
    useProvider(recordingProvider({ reversedLetters: { alone: "A" }, reversedMisses: ["multi"] }));
    const handle = intentShadowTurnStarted(turnInput());
    intentShadowTurnEnded(handle, output());
    await settleIntentShadowForTests();
    const row = onlyRow();
    expect(row["version"]).toBe(INTENT_READOUT_BOTH_ORDERS_VERSION);
    expect(row["version"]).not.toBe(INTENT_READOUT_VERSION);
    const facets = row.readout!["facets"] as Record<string, Record<string, unknown>>;
    expect(facets["mode"]).toMatchObject({ choice: "PRODUCE", orderAgreed: true });
    expect(facets["mode"]).not.toHaveProperty("singlePass");
    expect(facets["alone"]).toMatchObject({ orderAgreed: false });
    expect(facets["multi"]).toMatchObject({ choice: "yes", orderAgreed: null, singlePass: "served" });
    const reversed = row.readout!["reversed"] as { ms: number; tokens: number; failure: string | null };
    expect(reversed.failure).toBeNull();
    expect(reversed.tokens).toBeGreaterThan(0);
    expect(typeof reversed.ms).toBe("number");
    // A row the shadow could not read still names the readout it asks.
    const skipped = buildIntentShadowRowData(
      { turnId: "t", userMessage: "x", priorTurnDigest: undefined },
      { ...facts(), wallMs: 5, workflowPressure: [], workflowForced: false, moduleSplit: false },
      "other",
      { status: "skipped", reason: "busy", intent: null, preRoute: null },
    );
    expect(skipped["version"]).toBe(INTENT_READOUT_BOTH_ORDERS_VERSION);
  });

  it("holds no user text: not the message, not the digest, not the English restatement", async () => {
    const canaryMessage = "Kanarienvogel Zwitscherbaum Quarkstrudel bitte recherchieren";
    const canaryDigest = "User asked: Flederhausmaus Wolkenkuckucksheim";
    const canaryQuery = "Research the Pfefferminzkobold situation in detail";
    useProvider(recordingProvider({ query: canaryQuery, preRoute: "A" }));
    const handle = intentShadowTurnStarted(turnInput({ userMessage: canaryMessage, priorTurnDigest: () => canaryDigest }));
    noteIntentShadowCapsule("sess-1", { status: "ok", agents: ["researcher"] });
    logAudit("message_received", { fastLane: false, escalateReason: canaryMessage }, { sessionId: "sess-1" });
    intentShadowTurnEnded(handle, output({ guardrailEvents: [{ type: "workflow_required", details: canaryMessage }] }));
    await settleIntentShadowForTests();
    // The call itself did carry them: the model is the one place they go.
    expect(calls[0]!.messages.map((message) => String(message.content)).join("\n")).toContain("Flederhausmaus");
    const text = JSON.stringify(onlyRow());
    for (const word of ["Kanarienvogel", "Zwitscherbaum", "Quarkstrudel", "Flederhausmaus", "Wolkenkuckucksheim", "Pfefferminzkobold"]) {
      expect(text).not.toContain(word);
    }
    const row = onlyRow();
    expect(row["messageChars"]).toBe(canaryMessage.length);
    expect(row["priorDigest"]).toBe(true);
    expect((row.readout as { queryEnChars: number }).queryEnChars).toBe(` ${canaryQuery}`.trim().length);
  });

  it("copies no agent name or status that is not an identifier", () => {
    const data = buildIntentShadowRowData(
      { turnId: "turn 1 with spaces", userMessage: "x", priorTurnDigest: undefined },
      {
        ...facts(),
        subAgentRuns: ["(other)"],
        wallMs: 5,
        workflowPressure: [],
        workflowForced: false,
        moduleSplit: false,
      },
      "other",
      { status: "failed", reason: "error", intent: { ok: false, reason: "error", ms: 3, error: "provider said: Quarkstrudel" }, preRoute: null },
    );
    const text = JSON.stringify(data);
    expect(text).not.toContain("Quarkstrudel");
    expect(text).not.toContain("turn 1 with spaces");
    expect(data).toMatchObject({ status: "failed", reason: "error", readout: null, readoutFailure: "error" });
  });
});
