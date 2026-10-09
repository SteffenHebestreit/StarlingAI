import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * A NAMED ENGINE REACHES ITS TIER, OR IS REFUSED BEFORE ANYTHING RENDERS.
 *
 * Session f4ebf47b, turn 4: the user said "nimm das qwen model". image_creator sent
 * `{model: "Qwen", tier: "fast"}`, the router answered 404 "no router for requested model",
 * and the agent's only recovery was to drop the name — which rendered on the FAST engine.
 * The picture was then reported as Qwen's. Nothing the agent could read said that the
 * quality tier IS the Qwen engine, the refusal listed nothing, and the success output did
 * not say which engine had rendered.
 */

// A real 1x1 PNG, so the tool's encoder has genuine bytes to handle.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const IMAGE_CONFIG = {
  baseUrl: "http://cluster.local:8080/v1",
  api: "openai-compatible",
  model: "image",
  qualityModel: "image-quality",
  fixedSizeModels: ["image"],
  qualityDefaults: { steps: 20, guidanceScale: 1 },
  tierLabels: { fast: "Segmind Vega", quality: "Qwen-Image 2.1" },
};

type Body = Record<string, unknown>;

function stubCluster() {
  const posts: Body[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!init?.method || init.method === "GET") {
      return new Response(JSON.stringify({ data: [{ id: "image" }, { id: "image-quality" }] }), { status: 200 });
    }
    const body = JSON.parse(String(init.body)) as Body;
    posts.push(body);
    if (body["model"] !== "image" && body["model"] !== "image-quality") {
      return new Response(JSON.stringify({ error: { message: "no router for requested model" } }), { status: 404, headers: { "Content-Type": "application/json" } });
    }
    expect(url).toMatch(/\/images\/generations$/);
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_1X1 }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, posts };
}

describe("generate_image: engines are named, checked and reported", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-image-engines-"));
  const configPath = join(tempDir, "starlingai.json");
  let getTool: typeof import("../tools/registry.js").getTool;
  let getToolsAsLLMDefs: typeof import("../tools/registry.js").getToolsAsLLMDefs;

  const writeConfig = async (imageGeneration: Record<string, unknown>) => {
    writeFileSync(configPath, JSON.stringify({ workspacePath: tempDir, multimodal: { imageGeneration } }), "utf8");
    (await import("../config/loader.js")).resetConfigForTests();
  };

  const run = (args: Record<string, unknown>) =>
    getTool("generate_image")!.execute(args, { sessionId: "engine-names", workspacePath: tempDir } as never);

  beforeAll(async () => {
    writeFileSync(configPath, JSON.stringify({ workspacePath: tempDir, multimodal: { imageGeneration: IMAGE_CONFIG } }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await import("../tools/multimodal.js");
    ({ getTool, getToolsAsLLMDefs } = await import("../tools/registry.js"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await writeConfig(IMAGE_CONFIG);
  });

  afterAll(() => {
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("refuses the live turn-4 call before touching the backend, and says which tier is Qwen", async () => {
    const { fetchMock } = stubCluster();

    const result = await run({ prompt: "a beach at sunset", model: "Qwen", tier: "fast" });

    expect(result.success).toBe(false);
    // Nothing was spent: no health probe, no render, no 404 to recover from.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.error).toContain("Qwen-Image 2.1");
    expect(result.error).toContain("`quality`");
    expect(result.error).toMatch(/Nothing was rendered/);
  });

  it("accepts an engine by its configured name or model id, and renders on THAT tier", async () => {
    const byLabel = stubCluster();
    const labelled = await run({ prompt: "a beach at sunset", model: "qwen-image 2.1", tier: "fast" });
    expect(labelled.success, String(labelled.error)).toBe(true);
    // The name beat the contradictory stated tier, and carried the quality tier's defaults.
    expect(byLabel.posts[0]).toMatchObject({ model: "image-quality", guidance_scale: 1 });
    vi.unstubAllGlobals();

    const byId = stubCluster();
    const named = await run({ prompt: "a beach at sunset", model: "image-quality" });
    expect(named.success, String(named.error)).toBe(true);
    expect(byId.posts[0]).toMatchObject({ model: "image-quality" });
  });

  it("names the engines in the description the agent reads", () => {
    const [def] = getToolsAsLLMDefs(["generate_image"]);
    const description = def!.description;
    expect(description).toContain("Qwen-Image 2.1");
    expect(description).toContain("image-quality");
    expect(description).toContain("Segmind Vega");
  });

  it("describes model ids alone when no labels are configured, and never prints undefined", async () => {
    const { tierLabels: _labels, ...unlabelled } = IMAGE_CONFIG;
    await writeConfig(unlabelled);

    const [def] = getToolsAsLLMDefs(["generate_image"]);
    const description = def!.description;
    expect(description).toContain('model "image-quality"');
    expect(description).not.toContain("undefined");
  });

  it("says in its OUTPUT which engine rendered and how long it took", async () => {
    stubCluster();

    const result = await run({ prompt: "a beach at sunset" });

    expect(result.success, String(result.error)).toBe(true);
    // The specialist reads the output, not the metadata — this is what it would have needed
    // to see that its retry had landed on the other engine.
    expect(result.output).toMatch(/^Image generated on the fast tier \(Segmind Vega\) in \d+\.\d s\. Saved to /);
    expect(result.metadata).toMatchObject({ tier: "fast", engine: "Segmind Vega" });
  });

  it("refuses a tier it does not know instead of quietly rendering on the fast one", async () => {
    const { fetchMock } = stubCluster();

    const unknown = await run({ prompt: "a beach at sunset", tier: "qwen" });
    expect(unknown.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unknown.error).toContain("Qwen-Image 2.1");

    // Case is not a reason to refuse: "Quality" is the quality tier.
    const cased = await run({ prompt: "a beach at sunset", tier: "Quality" });
    expect(cased.success, String(cased.error)).toBe(true);
    expect(cased.output).toContain("quality tier (Qwen-Image 2.1)");
  });
});
