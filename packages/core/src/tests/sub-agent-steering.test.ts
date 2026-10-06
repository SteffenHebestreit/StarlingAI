import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const completeMock = vi.fn();

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(structuredClone(messages), tools, signal);
    }
  },
}));

type Message = { role: string; content: unknown };

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    content: "",
    tool_calls: [{ id, name, arguments: args }],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "tool_calls",
  };
}

const DONE = {
  content: "Found three listings in Berlin.",
  tool_calls: [],
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  finishReason: "stop",
};

const textOf = (messages: Message[]): string => messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");

/**
 * A MESSAGE THE USER ADDS MID-TURN REACHES THE RUN DOING THE WORK (session ffe08297, 2026-10-06).
 *
 * The orchestrator folds steering in at its own next iteration, and that iteration waits for the
 * delegation to return: the user's message reached the orchestrator five minutes later and never
 * the browser run it was about.
 */
describe("mid-turn steering reaches a running specialist", () => {
  const ROOT = "root-steer-session";

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    const { turnSteeringManager } = await import("../agent/turn-steering.js");
    turnSteeringManager.resetForTests();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  async function setup() {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-sub-agent-steering-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        listing_scout: {
          description: "Finds listings on job boards.",
          systemPrompt: "Find listings.",
          tools: ["web_search"],
          maxIterations: 6,
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    const [{ turnSteeringManager }, registry, subAgent] = await Promise.all([
      import("../agent/turn-steering.js"),
      import("../tools/registry.js"),
      import("../agent/sub-agent.js"),
    ]);
    return { tempDir, turnSteeringManager, registry, subAgent };
  }

  it("folds a message sent during the run into its next model call, once", async () => {
    const { tempDir, turnSteeringManager, registry, subAgent } = await setup();
    turnSteeringManager.markTurnActive(ROOT);
    const responses = [toolCall("s1", "web_search", { query: "freelance listings" }), DONE, DONE];
    completeMock.mockImplementation(async () => responses.shift() ?? DONE);
    registry.registerTool({
      name: "web_search", description: "Search the web.",
      parameters: { type: "object", properties: {} },
      async execute() {
        // The user types while the specialist's tool call is running.
        turnSteeringManager.enqueue(ROOT, "Nur Angebote aus Berlin, bitte.");
        return { success: true, output: "12 listings across Germany." };
      },
    });

    try {
      await subAgent.runSubAgentWithStats({
        agentName: "listing_scout",
        task: "Find freelance listings.",
        parentSessionId: ROOT,
        workspacePath: tempDir,
      });
      const calls = completeMock.mock.calls.map(([messages]) => messages as Message[]);
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(textOf(calls[0]!)).not.toContain("Nur Angebote aus Berlin");
      expect(textOf(calls[1]!)).toContain("Nur Angebote aus Berlin, bitte.");
      expect(textOf(calls[1]!)).toContain("[USER STEERING");
      // Folded once: a later call carries it in history, never as a second note.
      for (const messages of calls.slice(1)) {
        expect(textOf(messages).split("Nur Angebote aus Berlin, bitte.").length - 1).toBe(1);
      }
      // The orchestrator's own queue is untouched: it still folds the message in when it resumes.
      expect(turnSteeringManager.hasPending(ROOT)).toBe(true);
    } finally {
      registry.unregisterTool("web_search");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips what the orchestrator had already taken, and never puts two user turns in a row", async () => {
    const { tempDir, turnSteeringManager, registry, subAgent } = await setup();
    turnSteeringManager.markTurnActive(ROOT);
    // Taken before the run: it reached the run through its prompt (turnUserWords), not here.
    turnSteeringManager.enqueue(ROOT, "Erste Ergänzung");
    turnSteeringManager.drain(ROOT);
    // Queued before the run and not taken yet: the run has to see it at its first call.
    turnSteeringManager.enqueue(ROOT, "Zweite Ergänzung");
    completeMock.mockImplementation(async () => DONE);
    registry.registerTool({
      name: "web_search", description: "Search the web.",
      parameters: { type: "object", properties: {} },
      async execute() { return { success: true, output: "none" }; },
    });

    try {
      await subAgent.runSubAgentWithStats({
        agentName: "listing_scout",
        task: "Find freelance listings.",
        parentSessionId: ROOT,
        workspacePath: tempDir,
      });
      const first = completeMock.mock.calls[0]![0] as Message[];
      expect(textOf(first)).toContain("Zweite Ergänzung");
      expect(textOf(first)).not.toContain("Erste Ergänzung");
      for (let i = 1; i < first.length; i++) {
        expect(first[i - 1]!.role === "user" && first[i]!.role === "user", `user turns ${i - 1} and ${i} in a row`).toBe(false);
      }
    } finally {
      registry.unregisterTool("web_search");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
