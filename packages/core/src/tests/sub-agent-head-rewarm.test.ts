import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LLMMessage, LLMResponse, LLMToolDef } from "../providers/lmstudio.js";

/**
 * THE SUB-AGENT HEAD RE-WARM (agents.performance.subAgentHeadRewarm, agent/sub-agent-head-rewarm.ts).
 *
 * Live probe E8: a new dispatch on a sub-agent head starts cold when the previous run on it grew
 * past ~4x the head (warm after 3x, cold after 6x), and ONE finished head-only request as that run
 * ends makes the next dispatches warm. Probe E6: a prewarm still in flight when the real call starts
 * costs +5.1 s, so a new dispatch on the same head waits for it.
 *
 * The runs here are the real runner (runSubAgentWithStats) against a recorded provider. A run is
 * grown the way E8 grows one: tool results appended until its prompt reaches a multiple of its
 * head, both in the provider's estimator (the ratio's unit), so the multiple is exact whatever the
 * head's size. Every provider call is recorded with the request context it ran in, which is how
 * the re-warm (callSite cache_warm) is told apart from the loop (callSite sub_agent).
 */

interface RecordedCall {
  provider: "lmstudio" | "anthropic";
  messages: LLMMessage[];
  tools: LLMToolDef[];
  signal?: AbortSignal;
  options?: Record<string, unknown>;
  callSite?: string;
  agentName?: string;
  sessionId?: string;
}

const completeMock = vi.hoisted(() => vi.fn());
const auditMock = vi.hoisted(() => vi.fn());

vi.mock("../providers/lmstudio.js", async (importActual) => {
  const actual = await importActual<typeof import("../providers/lmstudio.js")>();
  const requestContext = await import("../runtime/request-context.js");
  return {
    ...actual,
    LMStudioProvider: class {
      async complete(messages: LLMMessage[], tools: LLMToolDef[], signal?: AbortSignal, options?: Record<string, unknown>) {
        const ctx = requestContext.currentRequestContext();
        return completeMock({ provider: "lmstudio", messages, tools, signal, options, callSite: ctx?.callSite, agentName: ctx?.agentName, sessionId: ctx?.sessionId });
      }
    },
  };
});
vi.mock("../providers/anthropic.js", async (importActual) => {
  const actual = await importActual<typeof import("../providers/anthropic.js")>();
  const requestContext = await import("../runtime/request-context.js");
  return {
    ...actual,
    AnthropicProvider: class {
      async complete(messages: LLMMessage[], tools: LLMToolDef[], signal?: AbortSignal, options?: Record<string, unknown>) {
        const ctx = requestContext.currentRequestContext();
        return completeMock({ provider: "anthropic", messages, tools, signal, options, callSite: ctx?.callSite, agentName: ctx?.agentName, sessionId: ctx?.sessionId });
      }
    },
  };
});
vi.mock("../audit/logger.js", async (importActual) => ({
  ...(await importActual<typeof import("../audit/logger.js")>()),
  logAudit: (...args: unknown[]) => auditMock(...args),
}));

const AGENT = "writer_agent";
const OTHER_AGENT = "notes_agent";
const WARM_THINKING_OFF = { enableThinking: false, reasoningEffort: "none" };

let dir = "";
let configPath = "";
let estimate: (messages: readonly LLMMessage[], tools?: readonly LLMToolDef[]) => number;
let subAgent: typeof import("../agent/sub-agent.js");
let rewarm: typeof import("../agent/sub-agent-head-rewarm.js");
let resetConfig: () => void;

const calls: RecordedCall[] = [];
/** The order things happened in, for the join test. */
const events: string[] = [];
/** Per parent session: the multiple of its head a run grows to before it answers. */
const growTo = new Map<string, number>();
/** Per parent session: abort the turn (and fail the call) once the run reaches its multiple. */
const abortAtTarget = new Map<string, AbortController>();
/** How the re-warm call answers; the default answers at once. */
let rewarmAnswer: (call: RecordedCall) => Promise<LLMResponse> = async () => answer("", 8_044);
/**
 * When armed, the run whose loop call reaches the provider next is held at its loop call number `at`
 * (0 = its first) until `release`; its session is recorded, and `held` says the call is waiting.
 */
let holdLoopCall: { at: number; seen: number; held: boolean; gate: Promise<void>; release: () => void; sessionId?: string } | null = null;
/** Per parent session: the provider fails the first loop call of the next run in it. */
const failFirstCall = new Set<string>();

function armHold(at: number): NonNullable<typeof holdLoopCall> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  holdLoopCall = { at, seen: 0, held: false, gate, release };
  return holdLoopCall;
}
let pageChars = 3_000;

function answer(content: string, promptTokens = 1): LLMResponse {
  return { content, tool_calls: [], usage: { promptTokens, completionTokens: 1, totalTokens: promptTokens + 1 }, finishReason: "stop" };
}

function parentOf(sessionId: string | undefined): string | undefined {
  return [...growTo.keys()].find((parent) => sessionId?.startsWith(`sub:${parent}:`));
}

/** Varied text, so no repetition guard reads a page as a loop. */
function pageText(page: number, chars: number): string {
  const lines: string[] = [];
  let length = 0;
  for (let i = 0; length < chars; i += 1) {
    const line = `Page ${page}, paragraph ${i}: the section describes item ${page * 1_000 + i} and its measured value ${(i * 37) % 101}.`;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n");
}

function writeConfig(opts: { rewarm: boolean; primary?: string; promptCache?: boolean }): void {
  const model: Record<string, unknown> = { primary: opts.primary ?? "lmstudio/qwen" };
  if (opts.promptCache !== false) model["promptCache"] = true;
  const agentConfig = (description: string) => ({
    description,
    // A head of a few thousand tokens, so the run's growth is its pages rather than the loop's
    // per-iteration notes (a production head is ~8k: content_writer's 8,041 in E8).
    systemPrompt: Array.from({ length: 60 }, (_, i) => `Rule ${i}: write the page you are asked for from the sources you read, section ${i} first.`).join("\n"),
    tools: ["read_file"],
    maxIterations: 30,
    turnTimeoutMs: 60_000,
  });
  writeFileSync(configPath, JSON.stringify({
    agents: {
      defaults: { model },
      performance: { subAgentHeadRewarm: opts.rewarm },
    },
    subAgents: {
      [AGENT]: agentConfig("Writes long pages from the sources it fetches."),
      [OTHER_AGENT]: agentConfig("Keeps notes on the sources it fetches."),
    },
    workspacePath: dir,
  }), "utf8");
  resetConfig();
}

async function runAgent(params: { parent: string; multiple: number; agent?: string; signal?: AbortSignal }) {
  growTo.set(params.parent, params.multiple);
  return subAgent.runSubAgentWithStats({
    agentName: params.agent ?? AGENT,
    task: "Write the overview page from the fetched sources.",
    parentSessionId: params.parent,
    workspacePath: dir,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

const loopCalls = (parent?: string) => calls.filter((c) => c.callSite === "sub_agent" && (!parent || parentOf(c.sessionId) === parent));
const rewarmCalls = () => calls.filter((c) => c.callSite === "cache_warm");
/** The run's last loop call over its head, in the estimator's unit (the rule's). */
const lastRatio = (parent: string): number => {
  const last = loopCalls(parent).at(-1)!;
  return estimate(last.messages, last.tools) / estimate([last.messages[0]!], last.tools);
};
const auditRows = (type: string) => auditMock.mock.calls
  .filter((args) => args[0] === type)
  .map((args) => ({ data: args[1] as Record<string, unknown>, sessionId: (args[2] as { sessionId?: string } | undefined)?.sessionId }));

async function until(predicate: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sai-head-rewarm-"));
  configPath = join(dir, "starlingai.json");
  writeFileSync(configPath, "{}", "utf8");
  // Before the first import of the loader: its config source is resolved at module load.
  process.env["SAI_CONFIG_PATH"] = configPath;
  resetConfig = (await import("../config/loader.js")).resetConfigForTests;
  estimate = (await import("../providers/lmstudio.js")).estimatePromptTokensForRequest;
  subAgent = await import("../agent/sub-agent.js");
  rewarm = await import("../agent/sub-agent-head-rewarm.js");
  const { registerTool } = await import("../tools/registry.js");
  registerTool({
    name: "read_file",
    description: "Read one numbered page of the sources.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    async execute(args) {
      const page = Number(/page-(\d+)/.exec(String(args["path"] ?? ""))?.[1] ?? 0);
      return { success: true, output: pageText(page, pageChars) };
    },
  });

  completeMock.mockImplementation(async (call: RecordedCall) => {
    calls.push(call);
    if (call.callSite === "cache_warm") {
      events.push("rewarm_sent");
      return rewarmAnswer(call);
    }
    if (call.callSite !== "sub_agent") return answer("OK");
    events.push(`loop:${call.sessionId}`);
    const hold = holdLoopCall;
    if (hold) {
      hold.sessionId ??= call.sessionId;
      if (hold.sessionId === call.sessionId && hold.seen++ === hold.at) {
        hold.held = true;
        await hold.gate;
      }
    }
    const failing = parentOf(call.sessionId);
    if (failing && failFirstCall.has(failing)) {
      failFirstCall.delete(failing);
      throw new Error("503 Service Unavailable");
    }
    const parent = parentOf(call.sessionId);
    const multiple = parent ? growTo.get(parent) ?? 1 : 1;
    const head = estimate([call.messages[0]!], call.tools);
    if (estimate(call.messages, call.tools) < multiple * head) {
      // About half a head per page, so a run lands just past its multiple.
      pageChars = Math.ceil(head * 3 * 0.5);
      const page = loopCalls(parent).length;
      return {
        content: "",
        tool_calls: [{ id: `fetch-${page}`, name: "read_file", arguments: { path: `sources/page-${page}.md` } }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      };
    }
    const abort = parent ? abortAtTarget.get(parent) : undefined;
    if (abort) {
      abort.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    return answer("The overview page is written from the fetched sources.", 23_456);
  });
});

afterEach(async () => {
  await rewarm.settleSubAgentHeadRewarms();
  rewarm.resetSubAgentHeadRewarmForTests();
  calls.length = 0;
  events.length = 0;
  growTo.clear();
  abortAtTarget.clear();
  auditMock.mockClear();
  rewarmAnswer = async () => answer("", 8_044);
  holdLoopCall?.release();
  holdLoopCall = null;
  failFirstCall.clear();
});

afterAll(async () => {
  const { unregisterTool } = await import("../tools/registry.js");
  unregisterTool("read_file");
  delete process.env["SAI_CONFIG_PATH"];
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe("a run that outgrew its head re-warms it as it ends", () => {
  it("(a) sends exactly one re-warm with the first loop call's system text and tool array, max_tokens 1, thinking off", async () => {
    writeConfig({ rewarm: true });
    await runAgent({ parent: "conv-grow", multiple: 5 });
    await rewarm.settleSubAgentHeadRewarms();

    const sent = rewarmCalls();
    expect(sent).toHaveLength(1);
    const first = loopCalls("conv-grow")[0]!;
    const warm = sent[0]!;
    // The head, byte for byte, and nothing else but the one-character user turn.
    expect(warm.messages).toHaveLength(2);
    expect(JSON.stringify(warm.messages[0])).toBe(JSON.stringify(first.messages[0]));
    expect(warm.messages[0]!.role).toBe("system");
    expect(warm.messages[1]).toEqual({ role: "user", content: "." });
    expect(warm.tools).toBe(first.tools);
    expect(JSON.stringify(warm.tools)).toBe(JSON.stringify(first.tools));
    expect(warm.tools.map((t) => t.name)).toContain("read_file");
    expect(warm.options).toEqual({ maxTokens: 1, controls: WARM_THINKING_OFF });
    // Attributed as a warm-up, to the run it follows.
    expect(warm.callSite).toBe("cache_warm");
    expect(warm.agentName).toBe(`${AGENT}_head_rewarm`);
    expect(warm.sessionId).toBe(first.sessionId);
    // It went out after the run's last loop call.
    expect(calls.indexOf(warm)).toBeGreaterThan(calls.indexOf(loopCalls("conv-grow").at(-1)!));
  }, 60_000);

  it("(b) a run that stayed under 4x its head (3x, which E8 found warm) sends none", async () => {
    writeConfig({ rewarm: true });
    await runAgent({ parent: "conv-short", multiple: 3 });
    await rewarm.settleSubAgentHeadRewarms();
    const ratio = lastRatio("conv-short");
    expect(ratio).toBeGreaterThanOrEqual(3);
    expect(ratio).toBeLessThan(4);
    expect(rewarmCalls()).toHaveLength(0);
    expect(auditRows("sub_agent_head_rewarm")).toHaveLength(0);
  }, 60_000);

  it("(c) with the flag off, a run past 4x sends none", async () => {
    writeConfig({ rewarm: false });
    await runAgent({ parent: "conv-off", multiple: 5 });
    await rewarm.settleSubAgentHeadRewarms();
    expect(lastRatio("conv-off")).toBeGreaterThan(4);
    expect(rewarmCalls()).toHaveLength(0);
    expect(auditRows("sub_agent_head_rewarm")).toHaveLength(0);
  }, 60_000);

  it("(e) an Anthropic-provider run sends none, prompt caching on or not", async () => {
    writeConfig({ rewarm: true, primary: "anthropic/claude-sonnet-4-5" });
    await runAgent({ parent: "conv-anthropic", multiple: 5 });
    await rewarm.settleSubAgentHeadRewarms();
    const loop = loopCalls("conv-anthropic");
    expect(lastRatio("conv-anthropic")).toBeGreaterThan(4);
    expect(loop.every((c) => c.provider === "anthropic")).toBe(true);
    expect(rewarmCalls()).toHaveLength(0);
  }, 60_000);

  it("(e) an OpenAI-compatible provider without prompt caching declared sends none", async () => {
    writeConfig({ rewarm: true, promptCache: false });
    await runAgent({ parent: "conv-nocache", multiple: 5 });
    await rewarm.settleSubAgentHeadRewarms();
    expect(lastRatio("conv-nocache")).toBeGreaterThan(4);
    expect(rewarmCalls()).toHaveLength(0);
  }, 60_000);

  it("(g) writes a sub_agent_head_rewarm row that names the head of the sub_agent_head row", async () => {
    writeConfig({ rewarm: true });
    await runAgent({ parent: "conv-row", multiple: 5 });
    await rewarm.settleSubAgentHeadRewarms();
    const [head] = auditRows("sub_agent_head");
    const rows = auditRows("sub_agent_head_rewarm");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const last = loopCalls("conv-row").at(-1)!;
    expect(row.sessionId).toBe(last.sessionId);
    expect(row.data).toMatchObject({
      agentName: AGENT,
      headHash: head!.data["headHash"],
      headTokens: head!.data["headTokensEst"],
      runPromptTokens: estimate(last.messages, last.tools),
      reportedPromptTokens: 23_456,
      ok: true,
    });
    expect(row.data["ratio"]).toBeGreaterThan(4);
    expect(row.data["ratio"]).toBeCloseTo((row.data["runPromptTokens"] as number) / (row.data["headTokens"] as number), 2);
    expect(row.data["ms"]).toBeGreaterThanOrEqual(0);
    expect(row.data).not.toHaveProperty("joinedByDispatch");
    expect(row.data).not.toHaveProperty("aborted");
  }, 60_000);
});

describe("a re-warm never races the dispatch it is for", () => {
  it("(d) a second dispatch of the same agent waits for the in-flight re-warm before its first call", async () => {
    writeConfig({ rewarm: true });
    let release!: () => void;
    rewarmAnswer = () => new Promise<LLMResponse>((resolve) => {
      release = () => { events.push("rewarm_done"); resolve(answer("", 8_044)); };
    });
    await runAgent({ parent: "conv-join", multiple: 5 });
    await until(() => rewarmCalls().length === 1, "the re-warm to go out");
    const firstRun = loopCalls("conv-join")[0]!.sessionId!;

    const second = runAgent({ parent: "conv-join", multiple: 1 });
    // The second run has built its head (its sub_agent_head row) and is now at the join.
    await until(() => auditRows("sub_agent_head").some((r) => r.sessionId !== firstRun), "the second run's head");
    const secondRun = auditRows("sub_agent_head").find((r) => r.sessionId !== firstRun)!.sessionId!;
    // Long enough for the rest of its pre-loop work (shared facts, peer messages) to finish had it
    // not stopped at the join, and well short of the join's 8 s bound.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(events.filter((e) => e === `loop:${secondRun}`)).toHaveLength(0);

    release();
    await second;
    const done = events.indexOf("rewarm_done");
    const secondFirstCall = events.indexOf(`loop:${secondRun}`);
    expect(done).toBeGreaterThanOrEqual(0);
    expect(secondFirstCall).toBeGreaterThan(done);
    await rewarm.settleSubAgentHeadRewarms();
    const rows = auditRows("sub_agent_head_rewarm");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toMatchObject({ ok: true, joinedByDispatch: true });
  }, 60_000);

  it("(d) a dispatch by the main turn waits for the re-warm of a run the conversation's workflow started", async () => {
    writeConfig({ rewarm: true });
    let release!: () => void;
    rewarmAnswer = () => new Promise<LLMResponse>((resolve) => {
      release = () => { events.push("rewarm_done"); resolve(answer("", 8_044)); };
    });
    // A scene's run: its session is workflow:<conversation>:<scene>:<uuid> (tools/workflow-catalog.ts).
    await runAgent({ parent: "workflow:conv-scene:sourced_presentation:0f3c", multiple: 5 });
    await until(() => rewarmCalls().length === 1, "the re-warm to go out");
    const firstRun = loopCalls("workflow:conv-scene:sourced_presentation:0f3c")[0]!.sessionId!;

    const second = runAgent({ parent: "conv-scene", multiple: 1 });
    await until(() => auditRows("sub_agent_head").some((r) => r.sessionId !== firstRun), "the second run's head");
    const secondRun = auditRows("sub_agent_head").find((r) => r.sessionId !== firstRun)!.sessionId!;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(events.filter((e) => e === `loop:${secondRun}`)).toHaveLength(0);

    release();
    await second;
    expect(events.indexOf(`loop:${secondRun}`)).toBeGreaterThan(events.indexOf("rewarm_done"));
    await rewarm.settleSubAgentHeadRewarms();
    expect(auditRows("sub_agent_head_rewarm")[0]!.data).toMatchObject({ ok: true, joinedByDispatch: true });
  }, 60_000);

  it("(d) a dispatch in another conversation does not wait for it", async () => {
    writeConfig({ rewarm: true });
    let release!: () => void;
    rewarmAnswer = () => new Promise<LLMResponse>((resolve) => { release = () => resolve(answer("", 8_044)); });
    await runAgent({ parent: "conv-held", multiple: 5 });
    await until(() => rewarmCalls().length === 1, "the re-warm to go out");

    // Same agent, same head text, another conversation: nothing of its own is in flight. It must
    // finish while the re-warm is still held — well inside the 8 s a join could wait.
    const other = runAgent({ parent: "conv-elsewhere", multiple: 1 });
    const outcome = await Promise.race([
      other.then(() => "finished"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waited"), 4_000)),
    ]);
    expect(outcome).toBe("finished");
    expect(loopCalls("conv-elsewhere").length).toBeGreaterThan(0);
    release();
    await rewarm.settleSubAgentHeadRewarms();
    expect(auditRows("sub_agent_head_rewarm")[0]!.data).not.toHaveProperty("joinedByDispatch");
  }, 60_000);

  it("(d) a run that ends while a sibling dispatch of its head waits on its first call sends none then; the sibling's own end does", async () => {
    // Parallel slices / a task graph's staggered nodes: the sibling joined (nothing in flight) and its
    // first call is on the wire when the long run ends. A re-warm now would be the prewarm E6 found
    // in flight beside a cold real call (+5.1 s), and that first call caches the head by itself.
    writeConfig({ rewarm: true });
    const hold = armHold(0);
    const sibling = runAgent({ parent: "conv-sibling", multiple: 5 });
    await until(() => hold.held, "the sibling's first call");
    const siblingRun = hold.sessionId!;

    // The long run, same conversation, same head, grows past 4x and ends while the sibling's first
    // call is still out.
    await runAgent({ parent: "conv-sibling", multiple: 5 });
    await rewarm.settleSubAgentHeadRewarms();
    const longRun = loopCalls("conv-sibling").find((c) => c.sessionId !== siblingRun)!.sessionId!;
    expect(lastRatio("conv-sibling")).toBeGreaterThan(4);
    expect(rewarmCalls()).toHaveLength(0);

    // The sibling goes on, grows past 4x too, and re-warms as IT ends: nothing sent for this head
    // since, and nothing in flight.
    hold.release();
    await sibling;
    await rewarm.settleSubAgentHeadRewarms();
    const sent = rewarmCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sessionId).toBe(siblingRun);
    expect(sent[0]!.sessionId).not.toBe(longRun);
  }, 60_000);

  it("(d) a sibling whose first call has come back does not hold the re-warm back", async () => {
    // Its head is cached by that call; from there on it is a run like any other, and the long run's
    // re-warm serves the next dispatch.
    writeConfig({ rewarm: true });
    const hold = armHold(1);
    const sibling = runAgent({ parent: "conv-sibling-2", multiple: 5 });
    await until(() => hold.held, "the sibling's second call");
    const siblingRun = hold.sessionId!;

    await runAgent({ parent: "conv-sibling-2", multiple: 5 });
    await rewarm.settleSubAgentHeadRewarms();
    const sent = rewarmCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sessionId).not.toBe(siblingRun);

    // The sibling was under way before that re-warm went out: it sends none of its own (the dedupe).
    hold.release();
    await sibling;
    await rewarm.settleSubAgentHeadRewarms();
    expect(rewarmCalls()).toHaveLength(1);
  }, 60_000);

  it("(d) a dispatch that ended without a model call coming back holds no later re-warm back", async () => {
    // Its first call failed (the server answered 503): it counted as on its way to that call from its
    // join, and must stop counting as it ends, or the head never re-warms again in this conversation.
    writeConfig({ rewarm: true });
    failFirstCall.add("conv-failed-first");
    const failed = await runAgent({ parent: "conv-failed-first", multiple: 1 });
    expect(failed.stats.terminalState).not.toBe("completed");
    expect(calls.filter((c) => c.callSite === "sub_agent")).toHaveLength(1);

    await runAgent({ parent: "conv-failed-first", multiple: 5 });
    await rewarm.settleSubAgentHeadRewarms();
    expect(lastRatio("conv-failed-first")).toBeGreaterThan(4);
    expect(rewarmCalls()).toHaveLength(1);
  }, 60_000);

  it("(f) aborting the turn aborts the re-warm in flight", async () => {
    writeConfig({ rewarm: true });
    const turn = new AbortController();
    let settle!: () => void;
    rewarmAnswer = (call) => new Promise<LLMResponse>((resolve, reject) => {
      // As the real provider does: an abort of its signal rejects the request.
      call.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      settle = () => resolve(answer("", 8_044));
    });
    await runAgent({ parent: "conv-abort", multiple: 5, signal: turn.signal });
    await until(() => rewarmCalls().length === 1, "the re-warm to go out");
    const warm = rewarmCalls()[0]!;
    expect(warm.signal?.aborted).toBe(false);

    turn.abort();
    expect(warm.signal?.aborted).toBe(true);
    settle(); // no-op once rejected; ends the wait if the abort did not reach the call
    await rewarm.settleSubAgentHeadRewarms();
    const rows = auditRows("sub_agent_head_rewarm");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toMatchObject({ ok: false, aborted: true });
  }, 60_000);

  it("(f) a run whose turn was stopped sends no re-warm", async () => {
    writeConfig({ rewarm: true });
    const turn = new AbortController();
    abortAtTarget.set("conv-stopped", turn);
    const result = await runAgent({ parent: "conv-stopped", multiple: 5, signal: turn.signal });
    await rewarm.settleSubAgentHeadRewarms();
    expect(turn.signal.aborted).toBe(true);
    expect(result.stats.terminalState).toBe("cancelled");
    expect(rewarmCalls()).toHaveLength(0);
  }, 60_000);
});

describe("the re-warm rule", () => {
  const T = 1_000_000;
  const base = { inFlight: false, recent: undefined, runStartedAt: T, now: T + 60_000 };

  it("sends only past 4x the head", () => {
    expect(rewarm.decideSubAgentHeadRewarm({ ...base, ratio: 4 })).toBe("under_ratio");
    expect(rewarm.decideSubAgentHeadRewarm({ ...base, ratio: 3.99 })).toBe("under_ratio");
    expect(rewarm.decideSubAgentHeadRewarm({ ...base, ratio: 4.01 })).toBe("send");
    expect(rewarm.decideSubAgentHeadRewarm({ ...base, ratio: Number.NaN })).toBe("under_ratio");
  });

  it("keeps one in flight per key", () => {
    expect(rewarm.decideSubAgentHeadRewarm({ ...base, ratio: 6, inFlight: true })).toBe("in_flight");
  });

  it("sends none while another dispatch of the head is on its way to its first call", () => {
    expect(rewarm.decideSubAgentHeadRewarm({ ...base, ratio: 6, dispatchStarting: true })).toBe("dispatch_starting");
    expect(rewarm.decideSubAgentHeadRewarm({ ...base, ratio: 3, dispatchStarting: true })).toBe("under_ratio");
    expect(rewarm.decideSubAgentHeadRewarm({ ...base, ratio: 6, dispatchStarting: false })).toBe("send");
  });

  it("skips a run that was under way before the key's last re-warm went out, inside the window", () => {
    const recent = { startedAt: T + 10_000, finishedAt: T + 11_000, ok: true };
    // A sibling that started before the re-warm: its growth is not news.
    expect(rewarm.decideSubAgentHeadRewarm({ ...base, ratio: 6, recent, runStartedAt: T })).toBe("recent");
    // A run that started after it and grew past 4x again: a longer run happened since.
    expect(rewarm.decideSubAgentHeadRewarm({ ...base, ratio: 6, recent, runStartedAt: T + 10_500 })).toBe("send");
    // The last re-warm failed: nothing to rely on.
    expect(rewarm.decideSubAgentHeadRewarm({ ...base, ratio: 6, recent: { ...recent, ok: false }, runStartedAt: T })).toBe("send");
    // Outside the window.
    expect(rewarm.decideSubAgentHeadRewarm({
      ...base, ratio: 6, recent, runStartedAt: T, now: T + 11_000 + rewarm.SUB_AGENT_HEAD_REWARM_DEDUPE_MS,
    })).toBe("send");
  });

  it("a join waits at most its bound for a re-warm that does not come back, and not at all once the dispatch is aborted", async () => {
    writeConfig({ rewarm: true });
    const system: LLMMessage = { role: "system", content: "Head. ".repeat(200) };
    const tools: LLMToolDef[] = [{ name: "read_file", description: "Fetch a page.", parameters: { type: "object", properties: {} } }];
    const hung = { complete: () => new Promise<LLMResponse>(() => {}) };
    const params = {
      agentName: AGENT,
      rootConversation: "conv-bound",
      subSessionId: "sub:conv-bound:writer_agent:1",
      runStartedAt: Date.now(),
      headHash: "h1",
      headTokens: estimate([system], tools),
      tools,
      provider: hung as unknown as import("../providers/lmstudio.js").ChatProvider,
      providerId: "lmstudio",
      promptCache: true,
      modelPrimary: "lmstudio/qwen",
    };
    const run = rewarm.createSubAgentHeadRewarm(params)!;
    run.noteLoopCall([system, { role: "user", content: "x".repeat(estimate([system], tools) * 3 * 5) }], tools, 1);
    run.runEnded({});

    const t0 = Date.now();
    expect(await rewarm.joinInFlightSubAgentHeadRewarm(run.key, { maxWaitMs: 150 })).toBe(true);
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(140);
    expect(waited).toBeLessThan(2_000);

    const aborted = new AbortController();
    aborted.abort();
    const t1 = Date.now();
    expect(await rewarm.joinInFlightSubAgentHeadRewarm(run.key, { signal: aborted.signal, maxWaitMs: 5_000 })).toBe(false);
    expect(Date.now() - t1).toBeLessThan(100);
    // A different key has nothing in flight.
    expect(await rewarm.joinInFlightSubAgentHeadRewarm(rewarm.subAgentHeadRewarmKey("conv-bound", OTHER_AGENT, "h1"))).toBe(false);

    // Once it has been out longer than the bound it is stuck, and a later dispatch does not wait at
    // all: the provider's request timeout is 10 minutes, and each dispatch of the head in that time
    // would otherwise pay the full bound again.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const t2 = Date.now();
    expect(await rewarm.joinInFlightSubAgentHeadRewarm(run.key, { maxWaitMs: 150 })).toBe(false);
    expect(Date.now() - t2).toBeLessThan(50);
    // The hung call never settles; drop it so afterEach does not wait on it.
    rewarm.resetSubAgentHeadRewarmForTests();
  });

  it("the default join bound is 8 s", () => {
    expect(rewarm.SUB_AGENT_HEAD_REWARM_JOIN_MS).toBe(8_000);
    expect(rewarm.SUB_AGENT_HEAD_REWARM_RATIO).toBe(4);
  });
});
