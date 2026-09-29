import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwarmState, ToolContext } from "../tools/registry.js";

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
 * A SPECIALIST'S FAILED CALLS REACH THE ORCHESTRATOR, RECOVERED OR NOT.
 *
 * Session f4ebf47b: image_creator called generate_image with the engine the user asked for, got a
 * 404, retried on the fast tier, and closed with a text that never mentioned the 404. The
 * orchestrator only had that text, and told the user the requested engine had drawn the picture.
 * The run's failed calls now travel up beside its text, for the frame to list them.
 */
type Message = { role: string; content?: string | null };
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const call = (id: string, name: string, args: Record<string, unknown>) =>
  ({ content: "", tool_calls: [{ id, name, arguments: args }], usage, finishReason: "tool_calls" });
const answer = (content: string) => ({ content, tool_calls: [], usage, finishReason: "stop" });
const toolResultsIn = (messages: Message[]) => messages.filter((m) => m.role === "tool").length;
const systemIncludes = (messages: Message[], marker: string) =>
  messages.some((m) => m.role === "system" && String(m.content ?? "").includes(marker));

const QWEN_404 = 'HTTP 404: no router for requested model "Qwen"';
const DRAW_FAILURE = { agent: "image_creator", tool: "generate_image", error: QWEN_404 };

/** The leaf of f4ebf47b: the requested engine 404s, the fast tier draws the picture. */
function drawLikeF4ebf47b(messages: Message[]) {
  const done = toolResultsIn(messages);
  if (done === 0) return call("g1", "generate_image", { prompt: "harbour at dusk", model: "Qwen" });
  if (done === 1) return call("g2", "generate_image", { prompt: "harbour at dusk", tier: "fast" });
  return answer("The image of the harbour at dusk is ready: generated/harbour.png");
}

describe("failed tool calls inside a delegated run", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-specialist-failures-"));
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      subAgents: {
        image_creator: {
          description: "Draws pictures.",
          systemPrompt: "LEAF-7F2 Draw what you are asked for.",
          tools: ["generate_image"],
          maxIterations: 6,
        },
        researcher: {
          description: "Finds sources on the web.",
          systemPrompt: "Research the question.",
          tools: ["web_fetch", "delete_file"],
          maxIterations: 6,
        },
        art_director: {
          description: "Coordinates picture work.",
          systemPrompt: "COORD-3K9 Hand the drawing to a specialist.",
          tools: ["delegate_to_agent"],
          maxIterations: 4,
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  /** Registered after tools/sub-agent.js, so these handlers are the ones that run. */
  const registerLeafTools = async () => {
    await import("../tools/sub-agent.js");
    const { registerTool } = await import("../tools/registry.js");
    registerTool({
      name: "generate_image",
      description: "Generate an image.",
      parameters: { type: "object", properties: {} },
      async execute(args) {
        if (args["model"] === "Qwen") {
          return { success: false, output: "", error: `${QWEN_404}\n    at ImageBackend.request (image-generation.ts:572)` };
        }
        return {
          success: true,
          output: "Image generated successfully. Saved to generated/harbour.png",
          metadata: { outputPath: "generated/harbour.png", tier: "fast", model: "image" },
        };
      },
    });
    registerTool({
      name: "web_fetch",
      description: "Fetch a page.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: false, output: "", error: "HTTP 403 Forbidden" };
      },
    });
    registerTool({
      name: "delete_file",
      description: "Delete a file.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: "deleted" };
      },
    });
  };

  const freshSwarmState = (): SwarmState => ({
    objective: "test",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: {},
  });

  it("the run hands back the call that failed, though a later call recovered", async () => {
    await registerLeafTools();
    completeMock.mockImplementation(async (messages: Message[]) => drawLikeF4ebf47b(messages));

    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    const result = await runSubAgentWithStats({
      agentName: "image_creator",
      task: "Draw the harbour at dusk with the Qwen model.",
      parentSessionId: "parent-failures-leaf",
      workspacePath: tempDir,
    });

    // The recovery the final text reports is real: the precondition, or this proves nothing.
    expect(result.artifacts?.some((a) => a["outputPath"] === "generated/harbour.png")).toBe(true);
    // Exactly the failed call, with the first line of its error only.
    expect(result.toolFailures).toEqual([DRAW_FAILURE]);
  }, 30_000);

  it("redacts a secret in the error before cutting the line, so no fragment of it survives", async () => {
    // The key starts 220 characters in and runs past the 240-character cut. Cut first, the 20
    // characters left are too short for the key pattern and would travel to the browser as-is.
    // A made-up key, assembled at run time: as one literal it is a secret-scanner hit (GitHub flagged it
    // as an OpenAI API key on 2026-09-29), although the redaction pattern only needs it at run time.
    const key = ["sk", "A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6S7t8U9v0"].join("-");
    const error = `Exit code 22: ${"curl request to the upstream billing service failed ".repeat(4).slice(0, 206)}${key} (401)`;
    expect(error.indexOf(key)).toBeLessThan(240);
    expect(error.indexOf(key) + key.length).toBeGreaterThan(240);
    await registerLeafTools();
    const { registerTool } = await import("../tools/registry.js");
    registerTool({
      name: "web_fetch",
      description: "Fetch a page.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: false, output: "", error };
      },
    });
    completeMock.mockImplementation(async (messages: Message[]) =>
      toolResultsIn(messages) === 0 ? call("f1", "web_fetch", { url: "https://billing.example" }) : answer("Could not fetch it."));

    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    const result = await runSubAgentWithStats({
      agentName: "researcher",
      task: "Fetch the billing page.",
      parentSessionId: "parent-failures-secret",
      workspacePath: tempDir,
    });

    const recorded = result.toolFailures?.[0]?.error ?? "";
    expect(recorded).toContain("Exit code 22");
    expect(recorded).not.toContain(key.slice(0, 12));
  }, 30_000);

  it("leaves out calls answered without running and calls the runtime refused", async () => {
    await registerLeafTools();
    completeMock.mockImplementation(async (messages: Message[]) => {
      const done = toolResultsIn(messages);
      // The same fetch twice: the second is served from the run's cache and never runs.
      if (done < 2) return call(`f${done}`, "web_fetch", { url: "https://example.com/tides" });
      // Approval-gated, and this run has no approval channel: refused before it runs.
      if (done === 2) return call("d1", "delete_file", { path: "notes.txt" });
      return answer("The tide table could not be fetched.");
    });

    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    const result = await runSubAgentWithStats({
      agentName: "researcher",
      task: "Fetch the tide table.",
      parentSessionId: "parent-failures-excluded",
      workspacePath: tempDir,
    });

    expect(toolResultsIn(completeMock.mock.calls.at(-1)![0] as Message[])).toBe(3);
    expect(result.toolFailures).toEqual([{ agent: "researcher", tool: "web_fetch", error: "HTTP 403 Forbidden" }]);
  }, 30_000);

  it("delegate_to_agent carries them in its metadata as specialistToolFailures", async () => {
    await registerLeafTools();
    completeMock.mockImplementation(async (messages: Message[]) => drawLikeF4ebf47b(messages));

    const { getTool } = await import("../tools/registry.js");
    const ctx: ToolContext = { sessionId: "s-failures-delegate", workspacePath: tempDir, swarmState: freshSwarmState() };
    const result = await getTool("delegate_to_agent")!.execute(
      { agentName: "image_creator", task: "Draw the harbour at dusk with the Qwen model." },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.metadata?.["delegationSucceeded"]).toBe(true);
    expect(result.metadata?.["specialistToolFailures"]).toEqual([DRAW_FAILURE]);
  }, 30_000);

  it("records a call the user declined as their choice, and a coordinator passes that on", async () => {
    // A Skip in generate_image's settings step: success:false, so the specialist neither retries nor
    // claims a picture, but not a failure of the render. It was listed as one, by its flag alone.
    const SKIP = "The user skipped this render in the settings step, so nothing was rendered.";
    await registerLeafTools();
    const { registerTool } = await import("../tools/registry.js");
    registerTool({
      name: "generate_image",
      description: "Generate an image.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: false, output: "", error: SKIP, metadata: { settings: { source: "user_skipped" }, declinedByUser: true } };
      },
    });
    completeMock.mockImplementation(async (messages: Message[]) => {
      if (systemIncludes(messages, "LEAF-7F2")) {
        return toolResultsIn(messages) === 0 ? call("g1", "generate_image", { prompt: "harbour at dusk" }) : answer("The user skipped the render.");
      }
      if (toolResultsIn(messages) === 0) {
        return call("dl1", "delegate_to_agent", { agentName: "image_creator", task: "Draw the harbour at dusk." });
      }
      return answer("Nothing was drawn: the user skipped the render.");
    });

    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    const result = await runSubAgentWithStats({
      agentName: "art_director",
      task: "Get a picture of the harbour at dusk drawn.",
      parentSessionId: "parent-failures-declined",
      workspacePath: tempDir,
    });

    expect(result.toolFailures).toEqual([{ agent: "image_creator", tool: "generate_image", error: SKIP, declinedByUser: true }]);
  }, 30_000);

  it("a coordinator passes on the failures of the specialist it delegated to", async () => {
    await registerLeafTools();
    completeMock.mockImplementation(async (messages: Message[]) => {
      if (systemIncludes(messages, "LEAF-7F2")) return drawLikeF4ebf47b(messages);
      if (toolResultsIn(messages) === 0) {
        return call("dl1", "delegate_to_agent", { agentName: "image_creator", task: "Draw the harbour at dusk." });
      }
      return answer("The harbour picture is done: generated/harbour.png");
    });

    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    const result = await runSubAgentWithStats({
      agentName: "art_director",
      task: "Get a picture of the harbour at dusk drawn.",
      parentSessionId: "parent-failures-coordinator",
      workspacePath: tempDir,
    });

    expect(result.toolFailures).toEqual([DRAW_FAILURE]);
  }, 30_000);
});
