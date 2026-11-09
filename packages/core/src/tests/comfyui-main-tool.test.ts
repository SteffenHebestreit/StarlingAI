import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * The orchestrator answers "what does ComfyUI have" itself, and only where ComfyUI is set up.
 * Without the lookup it read "welche Modelle hat ComfyUI installiert?" as a filesystem question
 * and sent computer_use_agent into a terminal (two lab runs of two).
 */
describe("comfyui_catalog on the orchestrator", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-comfyui-main-"));
  const configPath = join(tempDir, "starlingai.json");
  let tools: typeof import("../agent/default-tools.js");

  const withBaseUrl = async (baseUrl: string) => {
    writeFileSync(configPath, JSON.stringify({ workspacePath: tempDir, multimodal: { comfyui: { baseUrl } } }), "utf8");
    (await import("../config/loader.js")).resetConfigForTests();
  };

  beforeAll(async () => {
    writeFileSync(configPath, JSON.stringify({ workspacePath: tempDir }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await import("../tools/comfyui.js");
    tools = await import("../agent/default-tools.js");
  });

  afterAll(() => {
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("is offered in every tool mode while ComfyUI is configured", async () => {
    await withBaseUrl("http://comfyui:8188");
    expect(tools.getAvailableDirectMainToolNames("orchestration_only")).toContain("comfyui_catalog");
    expect(tools.getAvailableDirectMainToolNames("hybrid")).toContain("comfyui_catalog");
  });

  it("costs an install without ComfyUI nothing", async () => {
    await withBaseUrl("");
    expect(tools.getAvailableDirectMainToolNames("orchestration_only")).not.toContain("comfyui_catalog");
    expect(tools.getAvailableDirectMainToolNames("hybrid")).not.toContain("comfyui_catalog");
  });
});
