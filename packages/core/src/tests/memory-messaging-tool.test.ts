import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../audit/logger.js", async () => {
  const actual = await vi.importActual<typeof import("../audit/logger.js")>("../audit/logger.js");
  return {
    ...actual,
    logAudit: vi.fn(),
  };
});

describe("send_agent_message tool", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const memory = await import("../swarm/memory.js");
    await memory.resetSharedMemoryForTests();
  });

  it("broadcasts to matching domain/tag agents", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-msg-tool-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      workspacePath: tempDir,
      subAgents: {
        browser_agent: { description: "Browser", tools: ["web_search"], domain: "browser", tags: ["browser", "research"], capabilities: ["forms"] },
        vision_browser_analyst: { description: "Vision browser", tools: ["analyze_image"], domain: "browser", tags: ["browser", "vision"], capabilities: ["forms", "screenshots"] },
        coder: { description: "Coder", tools: ["read_file"], domain: "coding", tags: ["code"], capabilities: ["typescript"] },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;

    const registry = await import("../tools/registry.js");
    const swarmMemory = await import("../swarm/memory.js");
    await import("../tools/memory.js");

    try {
      const tool = registry.getTool("send_agent_message");
      expect(tool).toBeDefined();

      const result = await tool!.execute({
        domain: "browser",
        tags: ["forms"],
        message: "Please verify the login flow.",
      }, {
        sessionId: "sub:parent-session:planner:1",
        workspacePath: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("2 agents");

      const browserMessages = await swarmMemory.consumeAgentMessages("parent-session", "browser_agent");
      const visionMessages = await swarmMemory.consumeAgentMessages("parent-session", "vision_browser_analyst");
      const coderMessages = await swarmMemory.consumeAgentMessages("parent-session", "coder");

      expect(browserMessages).toHaveLength(1);
      expect(visionMessages).toHaveLength(1);
      expect(coderMessages).toHaveLength(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});