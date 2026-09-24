import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwarmState, ToolContext } from "../tools/registry.js";
import type { UserInputOutcome } from "../agent/user-input.js";

const completeMock = vi.fn();

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

/**
 * A QUESTION FROM A TOOL FOUR HOPS DOWN STILL REACHES THE PERSON, AND WAITING FOR THEM IS NOT A
 * STALLED RUN.
 *
 * image_creator is a specialist: the orchestrator delegates to it, sometimes through a coordinator.
 * Its tools used to get no channel at all (the sub-agent ToolContext carried approvals and nothing
 * else), and when one did wait on a person, the specialist's own deadline latched mid-wait and the
 * run came back from the answer straight into timeout synthesis. These drive the real runner with a
 * scripted model and a probe tool that asks.
 */
type Message = { role: string; content?: string | null };
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const call = (id: string, name: string, args: Record<string, unknown>) =>
  ({ content: "", tool_calls: [{ id, name, arguments: args }], usage, finishReason: "tool_calls" });
const answer = (content: string) => ({ content, tool_calls: [], usage, finishReason: "stop" });
const toolResultsIn = (messages: Message[]) => messages.filter((m) => m.role === "tool").length;
const systemIncludes = (messages: Message[], marker: string) =>
  messages.some((m) => m.role === "system" && String(m.content ?? "").includes(marker));
const TIMEOUT_SYNTHESIS = "Your execution time budget has expired";

const ROOT = "chat-harbour";
const TURN = "req-harbour";

/** The painter asks once, then reports what it rendered. */
function paint(messages: Message[]) {
  if (toolResultsIn(messages) === 0) return call("paint-1", "generate_image", { prompt: "harbour at dusk" });
  return answer("Rendered the harbour at dusk with the settings the user chose.");
}

describe("structured user input inside delegated runs", () => {
  let tempDir = "";
  let probeOutcome: UserInputOutcome<{ tier: string }> | "no requestUserInput" | undefined;
  let events: Array<{ type: string; data: Record<string, unknown> }> = [];

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-user-input-depth-"));
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      subAgents: {
        painter: {
          description: "Paints pictures.",
          systemPrompt: "LEAF-P41 Paint what you are asked for.",
          tools: ["generate_image"],
          maxIterations: 4,
        },
        slow_painter: {
          description: "Paints pictures, on a short clock.",
          systemPrompt: "LEAF-S19 Paint what you are asked for.",
          tools: ["generate_image"],
          maxIterations: 4,
          turnTimeoutMs: 1000,
        },
        art_director: {
          description: "Coordinates picture work.",
          systemPrompt: "COORD-A77 Hand the painting to a specialist.",
          tools: ["delegate_to_agent"],
          maxIterations: 4,
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    probeOutcome = undefined;
    events = [];
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    (await import("../agent/user-input-broker.js")).userInputBroker.resetForTests();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  /** Registers the probe under generate_image's name (only tier-mapped names register) and opens
   *  the chat turn; the "person" answers after `answerAfterMs`. */
  async function setup(answerAfterMs = 0) {
    await import("../tools/sub-agent.js");
    const [{ registerTool, getTool }, { userInputBroker }, requestContext] = await Promise.all([
      import("../tools/registry.js"),
      import("../agent/user-input-broker.js"),
      import("../runtime/request-context.js"),
    ]);
    registerTool({
      name: "generate_image",
      description: "Ask for render settings, then render.",
      parameters: { type: "object", properties: { prompt: { type: "string" } } },
      async execute(_args, ctx) {
        if (!ctx.requestUserInput) {
          probeOutcome = "no requestUserInput";
          return { success: true, output: "Rendered with the model's own settings." };
        }
        probeOutcome = await ctx.requestUserInput<{ tier: string }>({
          kind: "image_settings",
          title: "Image settings",
          payload: { tiers: ["fast", "quality"] },
          validate: (raw) => {
            const tier = (raw as { tier?: unknown }).tier;
            return tier === "fast" || tier === "quality"
              ? { ok: true, value: { tier }, summary: `tier ${tier}` }
              : { ok: false, errors: [{ field: "tier", message: "unknown tier" }] };
          },
        });
        return { success: true, output: `Rendered with ${JSON.stringify(probeOutcome)}` };
      },
    });
    userInputBroker.openTurn(TURN, ROOT, "alice");
    userInputBroker.attachSink(ROOT, "tab-1", (event) => {
      events.push(event as { type: string; data: Record<string, unknown> });
      if (event.type !== "agent.user_input_needed") return;
      const inputId = String((event.data as Record<string, unknown>)["inputId"]);
      setTimeout(() => {
        void userInputBroker.respond(inputId, { tier: "quality" }, { userId: "alice", isAdmin: false });
      }, answerAfterMs);
    });
    // What runTurn sets for an interactive dashboard turn; everything below inherits it.
    const inTurn = <T>(fn: () => Promise<T>) => requestContext.runWithRequestContext(
      { userId: "alice", sessionId: ROOT, agentName: "main", userInput: { rootSessionId: ROOT, turnId: TURN, mode: "interactive" } },
      fn,
    );
    return { getTool, inTurn };
  }

  const freshSwarmState = (): SwarmState => ({
    objective: "test",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: {},
  });

  it("a specialist's tool asks through delegate_to_agent and gets the person's answer", async () => {
    const { getTool, inTurn } = await setup();
    completeMock.mockImplementation(async (messages: Message[]) => paint(messages));

    const ctx: ToolContext = { sessionId: ROOT, workspacePath: tempDir, swarmState: freshSwarmState() };
    const result = await inTurn(() => getTool("delegate_to_agent")!.execute({ agentName: "painter", task: "Paint the harbour at dusk." }, ctx));

    expect(result.success).toBe(true);
    expect(probeOutcome).toMatchObject({ outcome: "configured", value: { tier: "quality" }, rootSessionId: ROOT });
    // The card lands in the chat the person is looking at, next to the call that asked.
    const needed = events.find((event) => event.type === "agent.user_input_needed")!.data;
    expect(needed).toMatchObject({ requestId: TURN, sessionId: ROOT, kind: "image_settings", sourceAgent: "painter", toolCallId: "paint-1" });
    expect(events.find((event) => event.type === "agent.user_input_resolved")!.data)
      .toMatchObject({ outcome: "configured", summary: "tier quality" });
  }, 30_000);

  it("reaches a specialist two delegations down", async () => {
    const { getTool, inTurn } = await setup();
    completeMock.mockImplementation(async (messages: Message[]) => {
      if (systemIncludes(messages, "LEAF-P41")) return paint(messages);
      if (toolResultsIn(messages) === 0) return call("dl-1", "delegate_to_agent", { agentName: "painter", task: "Paint the harbour at dusk." });
      return answer("The harbour picture is done.");
    });

    const ctx: ToolContext = { sessionId: ROOT, workspacePath: tempDir, swarmState: freshSwarmState() };
    await inTurn(() => getTool("delegate_to_agent")!.execute({ agentName: "art_director", task: "Get the harbour painted." }, ctx));

    expect(probeOutcome).toMatchObject({ outcome: "configured", value: { tier: "quality" } });
    expect(events.find((event) => event.type === "agent.user_input_needed")!.data).toMatchObject({ sourceAgent: "painter" });
  }, 30_000);

  it("a specialist whose tool waits on the person past its own deadline still finishes normally", async () => {
    // 1000 ms budget, and the person answers at 1600 ms. The deadline used to latch during the
    // wait, and the answer led straight into the timeout-synthesis pass: the run "finished" by
    // summarising instead of acting on what the person had just chosen.
    const { getTool, inTurn } = await setup(1600);
    completeMock.mockImplementation(async (messages: Message[]) => paint(messages));

    const ctx: ToolContext = { sessionId: ROOT, workspacePath: tempDir, swarmState: freshSwarmState() };
    const startedAt = Date.now();
    const result = await inTurn(() => getTool("delegate_to_agent")!.execute({ agentName: "slow_painter", task: "Paint the harbour at dusk." }, ctx));

    // The precondition: the wait really outlasted the budget, or this proves nothing.
    expect(Date.now() - startedAt).toBeGreaterThan(1600);
    expect(probeOutcome).toMatchObject({ outcome: "configured", value: { tier: "quality" } });
    const prompts = completeMock.mock.calls.map((args) => (args[0] as Message[]).map((m) => String(m.content ?? "")).join("\n"));
    expect(prompts.some((text) => text.includes(TIMEOUT_SYNTHESIS))).toBe(false);
    expect(result.success).toBe(true);
    expect(result.output).toContain("Rendered the harbour at dusk with the settings the user chose.");
  }, 30_000);

  it("a run with no chat behind it gets auto / no_channel at once, never a hang", async () => {
    const { getTool } = await setup();
    completeMock.mockImplementation(async (messages: Message[]) => paint(messages));

    // Outside any interactive turn: a channel, a scene, federation.
    const ctx: ToolContext = { sessionId: "telegram:42", workspacePath: tempDir, swarmState: freshSwarmState() };
    await getTool("delegate_to_agent")!.execute({ agentName: "painter", task: "Paint the harbour at dusk." }, ctx);

    expect(probeOutcome).toEqual({ outcome: "auto", reason: "no_channel", waitedMs: 0 });
    expect(events).toHaveLength(0);
  }, 30_000);
});
