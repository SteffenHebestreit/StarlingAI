import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// buildRequiredResearchFallbackRoute is the route the runtime uses to push a
// stalled source-sensitive turn into a research delegation. Inside a scoped
// scene/job STEP the session restricts which agents may run, so the route MUST
// target an agent that is actually allowed — otherwise the rewrite hard-fails with
// "not permitted in this scene" (audit 158f1435: every deck_* step failed because
// the route picked mission_coordinator/researcher outside the step's allowedAgents).

let tempDir: string | null = null;

function writeTempConfig(): void {
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-route-scope-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    agents: { defaults: { model: { primary: "lmstudio/qwen/qwen3.5-9b" } } },
    subAgents: {
      researcher: { description: "web research", tools: ["web_search"] },
      source_verifier: { description: "verify", tools: ["web_search"] },
      image_sourcer: { description: "images", tools: ["fetch_image"] },
      content_writer: { description: "writer", tools: ["generate_presentation"] },
      mission_coordinator: { description: "coordinator", tools: ["delegate_to_agent"] },
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
}

beforeEach(() => {
  vi.resetModules();
  writeTempConfig();
});

afterEach(() => {
  delete process.env["SAI_CONFIG_PATH"];
  if (tempDir) { rmSync(tempDir, { recursive: true, force: true }); tempDir = null; }
  vi.restoreAllMocks();
});

async function load() {
  const mod = await import("../agent/runtime.js");
  return mod.buildRequiredResearchFallbackRoute;
}

const TOOLS = new Set(["delegate_to_agent"]);
const SRC = { sourceSensitive: true } as never;

describe("buildRequiredResearchFallbackRoute — scoped allowedAgents", () => {
  it("routes to mission_coordinator/researcher on an UNRESTRICTED turn (unchanged)", async () => {
    const build = await load();
    const route = build("research the Dresden Zwinger architecture and its collections", SRC, TOOLS);
    expect(route).not.toBeNull();
    // multi-domain-ish phrasing may pick the coordinator; either default research agent is fine.
    expect(["mission_coordinator", "researcher"]).toContain(route!.label);
  });

  it("routes to the researcher when the step only allows researcher (not mission_coordinator)", async () => {
    const build = await load();
    const route = build("gather and cite the facts for the deck", SRC, TOOLS, ["researcher"]);
    expect(route).not.toBeNull();
    expect(route!.label).toBe("researcher");
    expect(route!.args["agentName"]).toBe("researcher");
  });

  it("routes to the step's OWN agent when no default research agent is allowed (image step)", async () => {
    const build = await load();
    const route = build("source verified images for the deck", SRC, TOOLS, ["image_sourcer"]);
    expect(route).not.toBeNull();
    expect(route!.label).toBe("image_sourcer");
    expect(route!.args["agentName"]).toBe("image_sourcer");
  });

  it("routes to content_writer for a build-only step", async () => {
    const build = await load();
    const route = build("build the deck and paper from verified facts", SRC, TOOLS, ["content_writer"]);
    expect(route!.label).toBe("content_writer");
  });

  it("excludes the disallowed coordinator from fallbackAgents", async () => {
    const build = await load();
    const route = build("gather the facts", SRC, TOOLS, ["researcher"]);
    const fallbacks = (route!.args["fallbackAgents"] as string[]) ?? [];
    expect(fallbacks).not.toContain("mission_coordinator");
  });
});
