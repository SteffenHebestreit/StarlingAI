import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const completeMock = vi.fn();

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  // Spread the real module: sub-agent.ts and its helpers import value exports
  // (computePromptTokenBudget, DeadlineAbort, ...) from here, and a mock that
  // replaced the whole module broke every time production code grew an export.
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

/**
 * audit 5fec8427: a coordinator that could not emit a large deliverable spread the same
 * failure across artifact tools — generate_document ×2 ("content is required") + write_file ×3
 * ("path is required") — each staying under its own per-tool cap, so only max_iterations
 * stopped it (~6 min wasted, zero artifacts). The cross-tool thrash guard blocks the family
 * once failures span >=2 distinct artifact tools (and >=3 total) and tells the agent to deliver
 * the content inline. A SINGLE artifact tool recovering from arg rejections (audit 2daf5f54) is
 * untouched — that is covered by sub-agent-tool-caps.test.ts.
 */
describe("artifact-persistence cross-tool thrash guard", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const swarmMemory = await import("../swarm/memory.js");
    await swarmMemory.resetSharedMemoryForTests();
  });

  it("blocks the family once failures thrash across two artifact tools and nudges inline", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sai-artifact-cap-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      subAgents: {
        writer: { description: "Writer", systemPrompt: "Persist the deliverable.", tools: ["generate_document", "write_file"], maxIterations: 10 },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    await import("../tools/sub-agent.js");

    // Mirror audit 5fec8427: the slow model emits generate_document (no content → "content is
    // required") twice, then write_file (empty path → "path is required"), each with distinct
    // args so the consecutive-dedup cache does not mask them. After the failure spans both
    // tools (>=2 distinct, >=3 total) the guard trips and blocks further artifact writes.
    const toolResultContents: string[] = [];
    let n = 0;
    completeMock.mockImplementation((messages: Array<{ role: string; content?: string }>) => {
      for (const m of messages) {
        if (m.role === "tool" && typeof m.content === "string") toolResultContents.push(m.content);
      }
      n += 1;
      const call = n <= 2
        ? { id: `d-${n}`, name: "generate_document", arguments: { title: `Guide ${n}`, format: "markdown" } }
        : { id: `w-${n}`, name: "write_file", arguments: { path: "", content: `draft chunk ${n}` } };
      return Promise.resolve({
        content: "",
        tool_calls: [call],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      });
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      const result = await runSubAgentWithStats({
        agentName: "writer",
        task: "Persist the design guide.",
        parentSessionId: "parent-artifact-cap",
        workspacePath: tempDir,
      });

      expect(result).toBeTruthy();
      const realArtifactFailures = toolResultContents.filter((c) => /content is required|path is required/i.test(c)).length;
      const capBlocks = toolResultContents.filter((c) => /Do NOT try to write or generate a file again/i.test(c)).length;
      // At most 3 real failures reached the tools (2x generate_document + 1x write_file) before
      // the cross-tool guard tripped; then the family was blocked with the inline-delivery nudge.
      expect(realArtifactFailures).toBeLessThanOrEqual(3);
      expect(capBlocks).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15000);
});
