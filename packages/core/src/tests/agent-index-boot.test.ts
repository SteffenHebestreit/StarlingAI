import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 2026-10-23: the gateway was rebuilt while the model host's name did not resolve. Startup built
 * the agent index only after the chat model had answered, so it never built it: for the next hour,
 * with the host long back, routing found no agent and sent every browser task to the researcher,
 * and tool and memory recall ran without embeddings.
 */
const index = vi.hoisted(() => ({ builds: [] as string[][] }));
vi.mock("../providers/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/embeddings.js")>();
  return {
    ...actual,
    buildAgentIndex: async (subAgents: Record<string, unknown>) => { index.builds.push(Object.keys(subAgents)); },
  };
});

const tempDirs: string[] = [];

afterEach(() => {
  index.builds.length = 0;
  vi.unstubAllGlobals();
  delete process.env["SAI_CONFIG_PATH"];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function bootProviders(models: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "sai-agent-index-boot-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    providers: { lmstudio: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "key" } },
    agents: {
      defaults: { model: { primary: "lmstudio/qwen", embeddingModel: "lmstudio/text-embedding-qwen3-embedding-0.6b" } },
    },
    subAgents: { browser_agent: { description: "Drives a web browser", systemPrompt: "s" } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: models }), {
    status: 200, headers: { "Content-Type": "application/json" },
  })));
  const { initProviders } = await import("../providers/index.js");
  await initProviders();
}

describe("startup builds the agent index", () => {
  it("while the chat model is not answering", async () => {
    await bootProviders([]);
    expect(index.builds.some((names) => names.includes("browser_agent"))).toBe(true);
  });
});
