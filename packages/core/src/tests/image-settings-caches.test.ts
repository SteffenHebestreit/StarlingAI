import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserInputRequest } from "../agent/user-input.js";

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
 * Two things that would each make the settings step silently disappear.
 *
 * The identical-arguments caches: "make another one" repeats generate_image verbatim, and a replay
 * hands back the previous picture as a new one — no card, no render. And the payload: building the
 * form reads and thumbnails up to six pictures, which must not happen for a chat set to Auto or a
 * run with nobody to ask.
 */

const call = (id: string, name: string, args: unknown) => ({
  content: null,
  tool_calls: [{ id, type: "function", name, arguments: args }],
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  finishReason: "tool_calls",
});

describe("generate_image is never served from a cache", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
  });

  it("the turn loop exempts it from the identical-arguments cache", async () => {
    const { STATE_DEPENDENT_TOOL_NAMES } = await import("../agent/turn-tool-contribution.js");
    expect(STATE_DEPENDENT_TOOL_NAMES.has("generate_image")).toBe(true);
  });

  it("a specialist asking twice with the same arguments renders twice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sai-render-twice-"));
    const configPath = join(dir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        painter: { description: "Paints.", systemPrompt: "Paint.", tools: ["generate_image"], maxIterations: 5 },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    let renders = 0;
    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "generate_image",
      description: "Render a picture.",
      parameters: { type: "object", properties: { prompt: { type: "string" } } },
      async execute() {
        renders += 1;
        return { success: true, output: `Image generated. Saved to generated/cat-${renders}.png` };
      },
    });
    const script = [
      () => call("r1", "generate_image", { prompt: "a cat" }),
      () => call("r2", "generate_image", { prompt: "a cat" }),
      () => ({ content: "Two cats.", tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" }),
    ];
    let step = 0;
    completeMock.mockImplementation(async () => script[Math.min(step++, script.length - 1)]!());

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      await runSubAgentWithStats({ agentName: "painter", task: "A cat, then another one.", parentSessionId: "render-twice", workspacePath: dir });

      expect(renders).toBe(2);
      const lastMessages = completeMock.mock.calls.at(-1)?.[0] as Array<Record<string, unknown>>;
      const results = lastMessages.filter((message) => message["role"] === "tool").map((message) => String(message["content"]));
      expect(results.at(-1)).toContain("cat-2.png");
      expect(results.at(-1)).not.toContain("cached result");
    } finally {
      unregisterTool("generate_image");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("the settings form is built only for someone who will see it", () => {
  afterEach(async () => {
    const [{ userInputBroker }, session] = await Promise.all([
      import("../agent/user-input-broker.js"),
      import("../agent/session.js"),
    ]);
    userInputBroker.resetForTests();
    for (const active of session.getAllSessions()) session.endSession(active.id);
  });

  async function setup() {
    const [{ userInputBroker }, session] = await Promise.all([
      import("../agent/user-input-broker.js"),
      import("../agent/session.js"),
    ]);
    const chat = session.createSession({ channel: "webchat" });
    const turnId = "req-lazy";
    userInputBroker.openTurn(turnId, chat.id);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    userInputBroker.attachSink(chat.id, "tab", (event) => events.push(event as { type: string; data: Record<string, unknown> }));
    const build = vi.fn(async () => ({ baseCandidates: [{ id: "c1" }] }));
    const request = (overrides: Partial<UserInputRequest<null>> = {}): UserInputRequest<null> => ({
      kind: "image_settings",
      title: "Image settings",
      payload: build,
      validate: () => ({ ok: true, value: null }),
      autoIf: (settings) => settings.imageSettingsPrompt === "auto",
      ...overrides,
    });
    const meta = { requesterSessionId: `sub:${chat.id}:image_creator:1` };
    const channel = { rootSessionId: chat.id, turnId, mode: "interactive" as const };
    return { broker: userInputBroker, chat, events, build, request, meta, channel };
  }

  it("is not built where nobody can be asked, or for a chat set to Auto", async () => {
    const { broker, chat, events, build, request, meta, channel } = await setup();

    await expect(broker.request(undefined, request(), meta)).resolves.toMatchObject({ outcome: "auto", reason: "no_channel" });
    chat.setSettings({ imageSettingsPrompt: "auto" });
    await expect(broker.request(channel, request(), meta)).resolves.toMatchObject({ outcome: "auto", reason: "session_preference" });

    expect(build).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("is built once someone will see it, and a form that cannot be built asks nobody", async () => {
    const { broker, events, build, request, meta, channel } = await setup();

    const outcome = broker.request(channel, request(), meta);
    await vi.waitFor(() => expect(events.find((event) => event.type === "agent.user_input_needed")).toBeDefined());
    expect(build).toHaveBeenCalledTimes(1);
    const needed = events.find((event) => event.type === "agent.user_input_needed")!.data;
    expect(needed["payload"]).toEqual({ baseCandidates: [{ id: "c1" }] });
    await broker.respond(String(needed["inputId"]), { choice: "configure" }, { isAdmin: true });
    await expect(outcome).resolves.toMatchObject({ outcome: "configured" });

    const broken = await broker.request(channel, request({ payload: async () => { throw new Error("disk gone"); } }), meta);
    expect(broken).toMatchObject({ outcome: "auto", reason: "no_channel" });
    expect(events.filter((event) => event.type === "agent.user_input_needed")).toHaveLength(1);
  });

  it("a turn that ended while the form was being built asks nobody", async () => {
    const { broker, events, request, meta, channel } = await setup();
    let release!: () => void;
    // (A request opened anyway would only end at its own deadline, which is kept short here.)
    const slow = request({ timeoutMs: 10_000, payload: () => new Promise((resolve) => { release = () => resolve({}); }) });

    const outcome = broker.request(channel, slow, meta);
    await vi.waitFor(() => expect(release).toBeDefined());
    broker.closeTurn(channel.turnId);
    release();

    await expect(outcome).resolves.toMatchObject({ outcome: "cancelled", reason: "turn_aborted" });
    expect(events.filter((event) => event.type === "agent.user_input_needed")).toHaveLength(0);
  });
});
