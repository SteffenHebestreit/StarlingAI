import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE FACT EXTRACTION OF SHARED FINDINGS CAN RUN ON A MODEL OF ITS OWN.
 *
 * Each tool result a specialist reads is distilled into the facts it shares, by a model call beside
 * the specialist's own. On the routing tier, which is often the specialist's own model, those calls
 * competed with it for the GPU and evicted its cached prompt: in session e2b53b6f a researcher
 * waited 76 s of a 271 s run for them. agents.defaults.model.tiers.distillation now names the model
 * they run on; unset, they run on the routing tier as before.
 */

/** The model each provider instance was built for, and which of them served the distillation. */
const servedBy: Array<{ model: string; distill: boolean }> = [];
const responseQueue = vi.fn();

function text(content: string) {
  return { content, tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" };
}

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    private readonly model: string;
    // (baseUrl, apiKey, modelConfig): the model is the config's primary, provider prefix and all.
    constructor(_baseUrl: string, _apiKey: string, modelConfig: { primary?: string }) { this.model = String(modelConfig?.primary ?? ""); }
    private answer(messages: unknown) {
      const msgs = messages as Array<{ role: string; content: unknown }>;
      const distill = msgs.some((m) => m.role === "system" && /evidence-distillation step/i.test(String(m.content)));
      servedBy.push({ model: this.model, distill });
      return distill ? Promise.resolve(text("- The release is out (Source: https://example.test/release)")) : responseQueue();
    }
    async complete(messages: unknown) { return this.answer(messages); }
    async completeViaStream(messages: unknown) { return this.answer(messages); }
  },
}));

vi.mock("../audit/logger.js", async (importActual) => ({
  ...(await importActual<typeof import("../audit/logger.js")>()),
  logAudit: () => {},
}));

const tempDir = mkdtempSync(join(tmpdir(), "starlingai-distillation-tier-"));
const configPath = join(tempDir, "starlingai.json");
process.env["SAI_CONFIG_PATH"] = configPath;
writeFileSync(configPath, "{}", "utf8");
const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
const { resetConfigForTests } = await import("../config/loader.js");
const { resetSharedMemoryForTests } = await import("../swarm/memory.js");
const { registerTool, unregisterTool } = await import("../tools/registry.js");

const AGENT = "distillation_tier_probe";
/** A search result long enough to be distilled (past distillSharedFactsMinChars). */
const SEARCH_RESULT = [
  "**Web Search Results for:** release",
  "",
  ...Array.from({ length: 8 }, (_, i) => [
    `**Result ${i + 1}: The release notes, page ${i + 1}**`,
    `https://www.example${i + 1}.test/release`,
    `The release ships three variants, a one-million-token context and an Apache 2.0 licence; page ${i + 1} repeats the headline figures of the announcement.`,
    "",
  ].join("\n")),
].join("\n");

function writeTempConfig(tiers: Record<string, string>): void {
  writeFileSync(configPath, JSON.stringify({
    workspacePath: tempDir,
    agents: { defaultContainerized: false, defaults: { model: { primary: "lmstudio/worker-model", tiers } } },
    subAgents: {
      [AGENT]: {
        description: "Probe specialist whose findings are distilled.",
        systemPrompt: "Gather evidence with the tools, then answer.",
        tools: ["web_search"],
        maxIterations: 3,
      },
    },
  }), "utf8");
  resetConfigForTests();
}

async function runProbe(tiers: Record<string, string>): Promise<void> {
  writeTempConfig(tiers);
  const queue = [
    { content: "", tool_calls: [{ id: "s1", name: "web_search", arguments: { query: "release" } }], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "tool_calls" },
    text("Final answer."),
  ];
  responseQueue.mockImplementation(() => Promise.resolve(queue.shift() ?? text("Fallback answer.")));
  registerTool({
    name: "web_search",
    description: "Search the web.",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    async execute() { return { success: true, output: SEARCH_RESULT } as never; },
  });
  try {
    await runSubAgentWithStats({ agentName: AGENT, task: "What is new about the release?", parentSessionId: `parent-distill-tier-${Math.random().toString(36).slice(2)}`, workspacePath: tempDir });
  } finally {
    unregisterTool("web_search");
  }
}

describe("agents.defaults.model.tiers.distillation", () => {
  afterAll(() => {
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    servedBy.length = 0;
    responseQueue.mockReset();
    resetConfigForTests();
    await resetSharedMemoryForTests();
  });

  it("runs the extraction on the distillation tier's model, and the specialist on its own", async () => {
    await runProbe({ routing: "lmstudio/routing-model", distillation: "lmstudio/small-distiller" });

    const distills = servedBy.filter((call) => call.distill);
    expect(distills.length).toBeGreaterThan(0);
    expect(distills.every((call) => call.model.endsWith("small-distiller"))).toBe(true);
    expect(servedBy.filter((call) => !call.distill).every((call) => call.model.endsWith("worker-model"))).toBe(true);
  });

  it("without one, runs the extraction on the routing tier, as before", async () => {
    await runProbe({ routing: "lmstudio/routing-model" });

    const distills = servedBy.filter((call) => call.distill);
    expect(distills.length).toBeGreaterThan(0);
    expect(distills.every((call) => call.model.endsWith("routing-model"))).toBe(true);
  });
});
