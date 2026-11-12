import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * The comfyui_* tools against a stand-in for ComfyUI's HTTP API. Each case is a path the live
 * check against a real server (v0.44, RTX 4080) went down; the stand-in answers in the shapes
 * that server sent.
 */

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const CATALOG = {
  UNETLoader: { input: { required: { unet_name: [["qwen_image_2.1_int8_convrot.safetensors"], {}] } }, output: ["MODEL"] },
  CLIPLoader: { input: { required: { clip_name: [["qwen3vl_8b_int8_convrot.safetensors"], {}], type: [["qwen_image"], {}] } }, output: ["CLIP"] },
  CLIPTextEncode: { input: { required: { text: ["STRING", { multiline: true }], clip: ["CLIP", {}] } }, output: ["CONDITIONING"] },
  EmptyLatentImage: { input: { required: { width: ["INT", { default: 1024, min: 16, max: 8192 }], height: ["INT", { default: 1024, min: 16, max: 8192 }], batch_size: ["INT", { default: 1, min: 1, max: 64 }] } }, output: ["LATENT"] },
  KSampler: {
    input: { required: {
      model: ["MODEL", {}], seed: ["INT", { default: 0, min: 0, max: 18446744073709551615, control_after_generate: true }], steps: ["INT", { default: 20, min: 1, max: 10000 }],
      cfg: ["FLOAT", { default: 8, min: 0, max: 100 }], sampler_name: [["euler"], {}], scheduler: [["simple"], {}],
      positive: ["CONDITIONING", {}], negative: ["CONDITIONING", {}], latent_image: ["LATENT", {}], denoise: ["FLOAT", { default: 1, min: 0, max: 1 }],
    } },
    input_order: { required: ["model", "seed", "steps", "cfg", "sampler_name", "scheduler", "positive", "negative", "latent_image", "denoise"] },
    output: ["LATENT"],
  },
  VAELoader: { input: { required: { vae_name: [["qwen_image_2.1_vae_bf16.safetensors"], {}] } }, output: ["VAE"] },
  VAEDecode: { input: { required: { samples: ["LATENT", {}], vae: ["VAE", {}] } }, output: ["IMAGE"] },
  SaveImage: { output_node: true, input: { required: { images: ["IMAGE", {}], filename_prefix: ["STRING", { default: "ComfyUI" }] } }, output: [] },
  LoadImage: { input: { required: { image: [[], { image_upload: true }] } }, output: ["IMAGE", "MASK"] },
  ComfySwitchNode: { input: { required: { switch: ["BOOLEAN", {}] }, optional: { on_false: ["COMFY_MATCHTYPE_V3", {}], on_true: ["COMFY_MATCHTYPE_V3", {}] } }, output: ["COMFY_MATCHTYPE_V3"] },
  PrimitiveStringMultiline: { input: { required: { value: ["STRING", { multiline: true }] } }, output: ["STRING"] },
  UpscaleModelLoader: { input: { required: { model_name: [["RealESRGAN_x4plus.pth"], {}] } }, output: ["UPSCALE_MODEL"] },
  ImageUpscaleWithModel: { input: { required: { upscale_model: ["UPSCALE_MODEL", {}], image: ["IMAGE", {}] } }, output: ["IMAGE"] },
};

/** The official template after conversion: the prompt comes through a switch that is off. */
function templateGraph(): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2.1_int8_convrot.safetensors" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_int8_convrot.safetensors", type: "qwen_image" } },
    "3": { class_type: "ComfySwitchNode", inputs: { switch: false, on_false: "a red fox in snow", on_true: ["11", 0] } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: ["3", 0], clip: ["2", 0] } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] } },
    "6": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
    "7": { class_type: "KSampler", inputs: { model: ["1", 0], seed: 42, steps: 25, cfg: 1, sampler_name: "euler", scheduler: "simple", positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0], denoise: 1 } },
    "8": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["8", 0] } },
    "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "fox" } },
    // The prompt enhancer behind the switch: its model is not installed.
    "11": { class_type: "CLIPTextEncode", inputs: { text: "rewrite", clip: ["12", 0] } },
    "12": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3.5_9b_pe.safetensors", type: "qwen_image" } },
  };
}

interface Server {
  prompts: Array<Record<string, unknown>>;
  library: Map<string, unknown>;
  uploads: string[];
  promptReply: () => Response;
  cancels: number;
}

function stubComfy(server: Server) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const path = decodeURIComponent(url.pathname);
    if (path === "/object_info") return json(CATALOG);
    if (path === "/models") return json(["diffusion_models", "loras"]);
    if (path === "/models/diffusion_models") return json(["qwen_image_2.1_int8_convrot.safetensors"]);
    if (path === "/models/loras") return json([]);
    if (path === "/templates/index.json") {
      return json([{ title: "Image", templates: [
        { name: "image_qwen_image_2_1_t2i", title: "Qwen Image 2.1: Text to Image", description: "One picture from a prompt", models: ["Qwen Image 2.1"], openSource: true },
        { name: "api_partner_t2i", title: "Partner: Text to Image", description: "Paid", models: ["Partner"], openSource: false },
        { name: "image_flux3_klein_t2i", title: "FLUX 3 Image Klein: Text to Image", description: "Fast", models: ["FLUX 3 Image"], openSource: true },
      ] }]);
    }
    if (path === "/templates/image_flux3_klein_t2i.json") {
      return json({ nodes: [{ id: 1, type: "UNETLoader", properties: { models: [{ name: "flux3-image-klein-int8-convrot.safetensors" }] } }], links: [] });
    }
    if (path === "/templates/image_qwen_image_2_1_t2i.json") {
      return json({ nodes: [{ id: 1, type: "UNETLoader", properties: { models: [{ name: "qwen_image_2.1_int8_convrot.safetensors" }] } }], links: [] });
    }
    if (path === "/workflow/convert" && method === "POST") return json(templateGraph());
    if (path === "/prompt" && method === "POST") {
      server.prompts.push(JSON.parse(String(init?.body)));
      return server.promptReply();
    }
    if (path.startsWith("/history/")) {
      return json({ p1: { status: { status_str: "success", completed: true, messages: [] }, outputs: { "10": { images: [{ filename: "fox_00001_.png", subfolder: "", type: "output" }] } } } });
    }
    if (path === "/view") return new Response(PNG_1X1, { status: 200, headers: { "Content-Type": "image/png" } });
    if (path === "/upload/image") {
      const form = init?.body as FormData;
      const file = form.get("image") as File;
      server.uploads.push(`${String(form.get("subfolder"))}/${file.name}`);
      return json({ name: file.name, subfolder: form.get("subfolder"), type: "input" });
    }
    if (path === "/userdata" && method === "GET") return json([...server.library.keys()].map((k) => k.replace(/^workflows\//, "")));
    if (path.startsWith("/userdata/") && method === "POST") {
      const file = path.slice("/userdata/".length);
      if (server.library.has(file) && url.searchParams.get("overwrite") !== "true") return new Response("exists", { status: 409 });
      server.library.set(file, JSON.parse(String(init?.body)));
      return json({});
    }
    if (path.startsWith("/userdata/") && method === "GET") {
      const file = path.slice("/userdata/".length);
      return server.library.has(file) ? json(server.library.get(file)) : new Response("missing", { status: 404 });
    }
    if ((path === "/queue" || path === "/interrupt") && method === "POST") {
      server.cancels += 1;
      return json({});
    }
    return new Response(`unexpected ${method} ${path}`, { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("comfyui tools", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-comfyui-tools-"));
  const configPath = join(tempDir, "starlingai.json");
  let getTool: typeof import("../tools/registry.js").getTool;
  let server: Server;
  let fetchMock: ReturnType<typeof stubComfy>;

  const call = (name: string, args: Record<string, unknown>) =>
    getTool(name)!.execute(args, { sessionId: "comfy-tools", workspacePath: tempDir } as never);

  const writeConfig = async (comfyui: Record<string, unknown>) => {
    writeFileSync(configPath, JSON.stringify({ workspacePath: tempDir, multimodal: { comfyui } }), "utf8");
    (await import("../config/loader.js")).resetConfigForTests();
  };

  beforeAll(async () => {
    writeFileSync(configPath, JSON.stringify({ workspacePath: tempDir, multimodal: { comfyui: { baseUrl: "http://comfyui:8188", editorUrl: "http://localhost:8188" } } }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await import("../tools/comfyui.js");
    ({ getTool } = await import("../tools/registry.js"));
  });

  beforeEach(async () => {
    vi.unstubAllGlobals();
    (await import("../multimodal/comfyui-client.js")).forgetNodeCatalog();
    await writeConfig({ baseUrl: "http://comfyui:8188", editorUrl: "http://localhost:8188", runTimeoutMs: 10_000 });
    server = { prompts: [], library: new Map(), uploads: [], cancels: 0, promptReply: () => new Response(JSON.stringify({ prompt_id: "p1", node_errors: {} }), { status: 200 }) };
    fetchMock = stubComfy(server);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("is off without a base URL, and says so before any request", async () => {
    await writeConfig({ baseUrl: "" });
    const result = await call("comfyui_catalog", { look_up: "templates" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("ComfyUI is not set up here");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists the templates that run here with their models, and every installed model file", async () => {
    const templates = await call("comfyui_catalog", { look_up: "templates" });
    // The category, which says what a template takes (a video template once got an image to upscale).
    expect(templates.output).toContain("template:image_qwen_image_2_1_t2i — Qwen Image 2.1: Text to Image (Image) [ready, its models are installed]");
    expect(templates.output).not.toContain("api_partner_t2i");
    const models = await call("comfyui_catalog", { look_up: "models" });
    expect(models.output).toBe("diffusion_models: qwen_image_2.1_int8_convrot.safetensors");
  });

  it("builds a workflow from a template, changes it, and exports it to the editor", async () => {
    const result = await call("comfyui_workflow", {
      path: "comfyui/fox.json",
      start_from: "template:image_qwen_image_2_1_t2i",
      operations: [{ op: "set", node: "3", inputs: { on_false: "a lighthouse at dusk" } }],
      save_to_editor: "fox",
      editor_file: "comfyui/fox.editor.json",
    });
    expect(result.success).toBe(true);
    const saved = join(tempDir, "generated", "comfyui", "fox.json");
    expect(JSON.parse(readFileSync(saved, "utf8"))["3"].inputs.on_false).toBe("a lighthouse at dusk");
    // The enhancer branch is behind a switch that is off: its missing model is not a problem.
    expect(result.output).toContain("Checks out against this ComfyUI's nodes and model files.");
    expect(result.output).toContain("Saved to the ComfyUI editor at http://localhost:8188 as Workflows → starlingai/fox.json");
    expect(existsSync(join(tempDir, "generated", "comfyui", "fox.editor.json"))).toBe(true);
    expect(server.library.has("workflows/starlingai/fox.json")).toBe(true);
    // The editor's copy is the workflow as it runs: the enhancer branch behind the switch is gone.
    expect(result.output).toContain("The editor copy is the workflow as it runs: switch 3 (off) resolved; 2 node(s) no output uses: 11 CLIPTextEncode, 12 CLIPLoader.");
    const exported = server.library.get("workflows/starlingai/fox.json") as { nodes: Array<{ type: string }> };
    expect(exported.nodes.map((n) => n.type)).not.toContain("ComfySwitchNode");
    expect(result.metadata?.["outputPath"]).toBe("generated/comfyui/fox.json");

    const again = await call("comfyui_workflow", { path: "comfyui/fox.json", save_to_editor: "fox" });
    expect(again.output).toContain('NOT saved to the editor: "starlingai/fox.json" exists there');
  });

  it("refuses a template that cannot run here, naming the ones that can", async () => {
    // Told in a note, the lab's image_creator went on with FLUX 3 Klein and swapped Qwen files into it.
    const result = await call("comfyui_workflow", { path: "comfyui/flux.json", start_from: "template:image_flux3_klein_t2i" });
    expect(result.success).toBe(false);
    expect(result.rejectedBeforeEffect).toBe(true);
    expect(result.error).toContain("template image_flux3_klein_t2i cannot run here: it needs flux3-image-klein-int8-convrot.safetensors, not installed. Templates that run here: template:image_qwen_image_2_1_t2i.");
    expect(result.error).toContain("allow_unready: true");
    expect(existsSync(join(tempDir, "generated/comfyui/flux.json"))).toBe(false);
    const ready = await call("comfyui_workflow", { path: "comfyui/qwen.json", start_from: "template:image_qwen_image_2_1_t2i" });
    expect(ready.success).toBe(true);
    expect(ready.output).not.toContain("cannot run here");
  });

  it("starts from such a template when told to, and still says so first", async () => {
    const result = await call("comfyui_workflow", { path: "comfyui/later.json", start_from: "template:image_flux3_klein_t2i", allow_unready: true });
    expect(result.success).toBe(true);
    expect(result.output.split("\n")[0]).toBe(
      "NOTE: template image_flux3_klein_t2i cannot run here: it needs flux3-image-klein-int8-convrot.safetensors, not installed. Templates that run here: template:image_qwen_image_2_1_t2i.",
    );
    expect(existsSync(join(tempDir, "generated/comfyui/later.json"))).toBe(true);
  });

  it("adds a stage to a template with insert, and what runs has it", async () => {
    const built = await call("comfyui_workflow", {
      path: "comfyui/big.json",
      start_from: "template:image_qwen_image_2_1_t2i",
      operations: [
        { op: "add", class_type: "UpscaleModelLoader" },
        { op: "insert", class_type: "ImageUpscaleWithModel", before: "SaveImage", inputs: { upscale_model: ["UpscaleModelLoader", 0] } },
      ],
    });
    expect(built.success).toBe(true);
    expect(built.output).toContain("inserted 14 ImageUpscaleWithModel before 10.images (image<-9.0)");
    expect(built.output).toContain("Checks out against this ComfyUI's nodes and model files.");
    const ran = await call("comfyui_run", { workflow: "comfyui/big.json", output_name: "big" });
    expect(ran.output).toContain("Saved: generated/comfyui/big.png (1x1).");
    expect(ran.metadata?.["width"]).toBe(1);
    const prompt = (server.prompts[0] as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }).prompt;
    expect(prompt["10"]!.inputs["images"]).toEqual(["14", 0]);
    expect(prompt["14"]!.inputs["image"]).toEqual(["9", 0]);
    expect(prompt["14"]!.inputs["upscale_model"]).toEqual(["13", 0]);
  });

  it("says an added node is connected to nothing instead of that the workflow checks out", async () => {
    // The lab's upscaler went in with nothing reading it: checked as it runs, it was not checked at all.
    const built = await call("comfyui_workflow", {
      path: "comfyui/loose.json",
      start_from: "template:image_qwen_image_2_1_t2i",
      operations: [{ op: "add", class_type: "ImageUpscaleWithModel", node: "up" }],
    });
    expect(built.success).toBe(true);
    expect(built.output).toContain("NOT CONNECTED, will not run: nothing takes the output of up ImageUpscaleWithModel.");
    expect(built.output).not.toContain("Checks out");
    const run = await call("comfyui_run", { workflow: "comfyui/loose.json" });
    expect(run.success).toBe(true);
    expect(run.output).toContain("NOT CONNECTED, did not run: nothing takes the output of up ImageUpscaleWithModel.");
    const fixed = await call("comfyui_workflow", { path: "comfyui/loose.json", operations: [{ op: "set", node: "SaveImage", inputs: { images: ["up", 0] } }] });
    expect(fixed.output).not.toContain("NOT CONNECTED");
    expect(fixed.output).toContain('node up (ImageUpscaleWithModel): required input "upscale_model" is missing (UPSCALE_MODEL; UpscaleModelLoader gives one)');
  });

  it("takes a path for the editor's name and uses the file's name", async () => {
    const saved = await call("comfyui_workflow", { path: "comfyui/named.json", start_from: "template:image_qwen_image_2_1_t2i", save_to_editor: "comfyui/named.json" });
    expect(saved.success).toBe(true);
    expect(saved.output).toContain("Workflows → starlingai/named.json");
  });

  it("says the prompt is unchanged while it is the template's, and stops once it is not", async () => {
    // The lab: a cat on a sofa was asked for, the prompt never reached, and the template's fashion portrait handed over.
    const built = await call("comfyui_workflow", { path: "comfyui/sample.json", start_from: "template:image_qwen_image_2_1_t2i" });
    expect(built.output).toContain('PROMPT UNCHANGED: 3.on_false still holds the template\'s own text ("a red fox in snow"). A run renders that text: give prompt to say what the picture should show.');
    const changed = await call("comfyui_workflow", { path: "comfyui/sample.json", operations: [{ op: "set", node: "3.on_false", inputs: { text: "a cat on a sofa" } }] });
    expect(changed.success).toBe(true);
    expect(changed.output).not.toContain("PROMPT UNCHANGED");
  });

  it("opens a run of the template's own prompt with a note, and a run of another prompt without", async () => {
    await call("comfyui_workflow", { path: "comfyui/sample.json", start_from: "template:image_qwen_image_2_1_t2i" });
    const sample = await call("comfyui_run", { workflow: "comfyui/sample.json" });
    expect(sample.success).toBe(true);
    expect(sample.output.split("\n")[0]).toBe(
      'NOTE: the prompt was the template\'s own text, unchanged (3.on_false: "a red fox in snow"). If the picture should show something else, run again with prompt.',
    );
    const own = await call("comfyui_run", { workflow: "comfyui/sample.json", set: { "3.on_false": "a cat on a sofa" } });
    expect(own.output).not.toContain("template's own text");
    expect(own.output.split("\n")[0]).toMatch(/^Ran /);
    const direct = await call("comfyui_run", { workflow: "template:image_qwen_image_2_1_t2i" });
    expect(direct.output).toContain("NOTE: the prompt was the template's own text, unchanged");
    const directOwn = await call("comfyui_run", { workflow: "template:image_qwen_image_2_1_t2i", set: { "3.on_false": "a cat on a sofa" } });
    expect(directOwn.output).not.toContain("template's own text");
  });

  it("refuses a set on an input the node does not have, in an operation and for a run", async () => {
    await call("comfyui_workflow", { path: "comfyui/sample.json", start_from: "template:image_qwen_image_2_1_t2i" });
    const operation = await call("comfyui_workflow", { path: "comfyui/sample.json", operations: [{ op: "set", node: "4", inputs: { prompt: "a cat" } }] });
    expect(operation.success).toBe(false);
    expect(operation.rejectedBeforeEffect).toBe(true);
    expect(operation.error).toContain('4 (CLIPTextEncode) has no input "prompt". Its inputs: text, clip (link)');
    expect(operation.error).toContain("Where to change it: prompt: 3.on_false");
    const run = await call("comfyui_run", { workflow: "comfyui/sample.json", set: { "4.prompt": "a cat" } });
    expect(run.success).toBe(false);
    expect(run.rejectedBeforeEffect).toBe(true);
    expect(run.error).toContain('set: 4 (CLIPTextEncode) has no input "prompt". Its inputs: text, clip (link)');
    expect(server.prompts).toHaveLength(0);
  });

  it("writes the prompt where the template keeps it, for a workflow and for one run", async () => {
    // The lab: in 7 of 17 runs the prompt was placed by editing the workflow file, guessing at the text to replace.
    const built = await call("comfyui_workflow", { path: "comfyui/prompted.json", start_from: "template:image_qwen_image_2_1_t2i", prompt: "a cat on a sofa" });
    expect(built.success).toBe(true);
    expect(built.output).toContain("prompt written to 3.on_false");
    expect(built.output).not.toContain("PROMPT UNCHANGED");
    const file = JSON.parse(readFileSync(join(tempDir, "generated/comfyui/prompted.json"), "utf8")) as Record<string, { inputs: Record<string, unknown> }>;
    expect(file["3"]!.inputs["on_false"]).toBe("a cat on a sofa");

    const run = await call("comfyui_run", { workflow: "template:image_qwen_image_2_1_t2i", prompt: "a dog in a park" });
    expect(run.success).toBe(true);
    expect(run.output).toContain("For this run: prompt (3.on_false).");
    expect(run.output).not.toContain("template's own text");
    const sent = (server.prompts[0] as { prompt: Record<string, { inputs: Record<string, unknown> }> }).prompt;
    expect(sent["4"]!.inputs["text"]).toBe("a dog in a park");
  });

  it("keeps the prompt when an operation beside it misses, and says so", async () => {
    const missed = await call("comfyui_workflow", { path: "comfyui/kept.json", start_from: "template:image_qwen_image_2_1_t2i", prompt: "a cat on a sofa", operations: [{ op: "set", node: "99", inputs: { steps: 30 } }] });
    expect(missed.success).toBe(false);
    expect(missed.error).toContain("now holds template image_qwen_image_2_1_t2i (converted from the editor format) as loaded, with the prompt written to 3.on_false");
    const file = JSON.parse(readFileSync(join(tempDir, "generated/comfyui/kept.json"), "utf8")) as Record<string, { inputs: Record<string, unknown> }>;
    expect(file["3"]!.inputs["on_false"]).toBe("a cat on a sofa");
    // Without start_from nothing is written, the prompt included.
    const again = await call("comfyui_workflow", { path: "comfyui/kept.json", prompt: "a dog", operations: [{ op: "set", node: "99", inputs: { steps: 30 } }] });
    expect(again.error).toContain("No operation was applied. The prompt was not written either.");
    expect((JSON.parse(readFileSync(join(tempDir, "generated/comfyui/kept.json"), "utf8")) as typeof file)["3"]!.inputs["on_false"]).toBe("a cat on a sofa");
  });

  it("does not guess among several prompt texts", async () => {
    const two = templateGraph();
    two["13"] = { class_type: "CLIPTextEncode", inputs: { text: "second", clip: ["2", 0] } };
    two["7"]!.inputs["positive"] = ["13", 0];
    mkdirSync(join(tempDir, "generated/comfyui"), { recursive: true });
    writeFileSync(join(tempDir, "generated/comfyui/two.json"), JSON.stringify(two), "utf8");
    const run = await call("comfyui_run", { workflow: "comfyui/two.json", prompt: "a cat" });
    expect(run.success).toBe(false);
    expect(run.rejectedBeforeEffect).toBe(true);
    expect(run.error).toContain("prompt: this workflow has several prompt texts (3.on_false, 13.text): write the ones meant with set. Where to change it: prompt: 3.on_false, 13.text;");
    expect(server.prompts).toHaveLength(0);
  });

  it("says where a workflow's inputs are when a run names one that is not there", async () => {
    // A run of a template is often the first the model sees of it: it guessed "5.text", then a loader, then the encoder.
    const noNode = await call("comfyui_run", { workflow: "template:image_qwen_image_2_1_t2i", set: { "99.text": "a cat" } });
    expect(noNode.error).toContain('"99.text" names no node of this workflow (write "<node id>.<input>"). Where to change it: prompt: 3.on_false;');
    const noInput = await call("comfyui_run", { workflow: "template:image_qwen_image_2_1_t2i", set: { "4.prompt": "a cat" } });
    expect(noInput.error).toContain('has no input "prompt". Its inputs: text, clip (link). Where to change it: prompt: 3.on_false;');
  });

  it("takes a choice written in part for a run, and says which it took", async () => {
    const run = await call("comfyui_run", { workflow: "template:image_qwen_image_2_1_t2i", prompt: "a cat", set: { "7.sampler_name": "eul" } });
    expect(run.success).toBe(true);
    expect(run.output).toContain('7.sampler_name: "eul" taken as "euler".');
    const sent = (server.prompts[0] as { prompt: Record<string, { inputs: Record<string, unknown> }> }).prompt;
    expect(sent["7"]!.inputs["sampler_name"]).toBe("euler");
  });

  it("does not write the editor's format over the workflow itself", async () => {
    await call("comfyui_workflow", { path: "comfyui/own.json", start_from: "template:image_qwen_image_2_1_t2i" });
    const before = readFileSync(join(tempDir, "generated/comfyui/own.json"), "utf8");
    const same = await call("comfyui_workflow", { path: "comfyui/own.json", editor_file: "comfyui/own.json" });
    expect(same.success).toBe(false);
    expect(same.rejectedBeforeEffect).toBe(true);
    expect(same.error).toBe("editor_file would overwrite the workflow itself: give it another name, e.g. comfyui/own.editor.json");
    expect(readFileSync(join(tempDir, "generated/comfyui/own.json"), "utf8")).toBe(before);
    const other = await call("comfyui_workflow", { path: "comfyui/own.json", editor_file: "comfyui/own.editor.json" });
    expect(other.success).toBe(true);
  });

  it("does not call a template's own unused node unconnected", async () => {
    const built = await call("comfyui_workflow", { path: "comfyui/plain.json", start_from: "template:image_qwen_image_2_1_t2i" });
    expect(built.output).not.toContain("NOT CONNECTED");
  });

  it("finds model files by a word, and always says what is installed when it finds none", async () => {
    expect((await call("comfyui_catalog", { look_up: "models", query: "qwen" })).output).toBe("diffusion_models: qwen_image_2.1_int8_convrot.safetensors");
    expect((await call("comfyui_catalog", { look_up: "models", query: "diffusion_models" })).output).toBe("qwen_image_2.1_int8_convrot.safetensors");
    const none = await call("comfyui_catalog", { look_up: "models", query: "upscale" });
    expect(none.success).toBe(true);
    expect(none.output).toBe('No model file matches "upscale".\nInstalled:\ndiffusion_models: qwen_image_2.1_int8_convrot.safetensors');
    expect((await call("comfyui_catalog", { look_up: "models", query: "loras" })).output).toBe("No files in loras.\nInstalled:\ndiffusion_models: qwen_image_2.1_int8_convrot.safetensors");
  });

  it("names the closest model file when a workflow asks for one this server lacks", async () => {
    await call("comfyui_workflow", { path: "comfyui/fox.json", start_from: "template:image_qwen_image_2_1_t2i" });
    const result = await call("comfyui_workflow", { path: "comfyui/fox.json", operations: [{ op: "set", node: "1", inputs: { unet_name: "qwen_image_2.1.safetensors" } }] });
    expect(result.output).toContain('node 1 (UNETLoader).unet_name: "qwen_image_2.1.safetensors" is not one of its choices (closest: qwen_image_2.1_int8_convrot.safetensors)');
    expect(result.metadata?.["errors"]).toBe(1);
  });

  it("runs what the switches pick and saves the picture into the workspace", async () => {
    await call("comfyui_workflow", { path: "comfyui/fox.json", start_from: "template:image_qwen_image_2_1_t2i" });
    const result = await call("comfyui_run", { workflow: "comfyui/fox.json", set: { "7.steps": 30 }, output_name: "fox" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Saved: generated/comfyui/fox.png (1x1).");
    expect(readFileSync(join(tempDir, "generated", "comfyui", "fox.png"))).toEqual(PNG_1X1);
    const sent = server.prompts[0]!;
    const graph = sent["prompt"] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    expect(graph["3"]).toBeUndefined();
    expect(graph["4"]!.inputs["text"]).toBe("a red fox in snow");
    expect(graph["11"]).toBeUndefined();
    expect(graph["12"]).toBeUndefined();
    expect(graph["7"]!.inputs["steps"]).toBe(30);
    // The PNG carries the workflow as it ran: no switch the editor would not resolve, no
    // enhancer whose model is missing, the prompt where the switch delivered it.
    const embedded = ((sent["extra_data"] as Record<string, Record<string, Record<string, unknown>>>)["extra_pnginfo"]!["workflow"]!["nodes"]) as Array<{ type: string; widgets_values: unknown[] }>;
    expect(embedded.map((n) => n.type)).not.toContain("ComfySwitchNode");
    expect(embedded.filter((n) => n.type === "CLIPLoader")).toHaveLength(1);
    expect(embedded.filter((n) => n.type === "CLIPTextEncode").map((n) => n.widgets_values[0])).toEqual(["a red fox in snow", ""]);
    expect(result.metadata?.["outputPath"]).toBe("generated/comfyui/fox.png");
  });

  it("keeps the loaded template when an operation misses, and says where things are", async () => {
    // The lab's image_creator guessed ids before it had seen the template.
    const result = await call("comfyui_workflow", {
      path: "comfyui/guess.json",
      start_from: "template:image_qwen_image_2_1_t2i",
      operations: [{ op: "set", node: "5", inputs: { text: "a fox" } }, { op: "set", node: "99", inputs: { steps: 4 } }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("operation 2 (set): there is no node 99. No operation was applied.");
    expect(result.error).toContain("generated/comfyui/guess.json now holds template image_qwen_image_2_1_t2i");
    expect(result.error).toContain("Where to change it: prompt: 3.on_false; negative prompt: 5.text; seed: 7.seed");
    expect(existsSync(join(tempDir, "generated", "comfyui", "guess.json"))).toBe(true);
    const run = await call("comfyui_run", { workflow: "comfyui/guess.json", set: { "KSampler.steps": 9 } });
    expect(run.success).toBe(true);
    expect((server.prompts[0]!["prompt"] as Record<string, { inputs: Record<string, unknown> }>)["7"]!.inputs["steps"]).toBe(9);
  });

  it("rolls the seed only when asked", async () => {
    await call("comfyui_workflow", { path: "comfyui/fox.json", start_from: "template:image_qwen_image_2_1_t2i" });
    await call("comfyui_run", { workflow: "comfyui/fox.json" });
    await call("comfyui_run", { workflow: "comfyui/fox.json", new_seed: true });
    const seeds = server.prompts.map((p) => (p["prompt"] as Record<string, { inputs: Record<string, unknown> }>)["7"]!.inputs["seed"]);
    expect(seeds[0]).toBe(42);
    expect(seeds[1]).not.toBe(42);
  });

  it("sends workspace pictures to LoadImage through ComfyUI's input folder", async () => {
    writeFileSync(join(tempDir, "photo.png"), PNG_1X1);
    server.library.set("workflows/edit.json", {});
    await call("comfyui_workflow", {
      path: "comfyui/edit.json",
      start_from: "template:image_qwen_image_2_1_t2i",
      operations: [{ op: "add", node: "20", class_type: "LoadImage", inputs: { image: "placeholder.png" } }, { op: "add", node: "21", class_type: "SaveImage", inputs: { images: ["20", 0] } }],
    });
    const result = await call("comfyui_run", { workflow: "comfyui/edit.json", images: { "20.image": "photo.png" } });
    expect(result.success).toBe(true);
    expect(server.uploads).toEqual(["starlingai/photo.png"]);
    expect((server.prompts[0]!["prompt"] as Record<string, { inputs: Record<string, unknown> }>)["20"]!.inputs["image"]).toBe("starlingai/photo.png");
  });

  it("finds a picture this tool saved by the name the agent gives it", async () => {
    // comfyui_run names "generated/comfyui/base.png"; the lab's image_creator handed the next run "base.png".
    mkdirSync(join(tempDir, "generated", "comfyui"), { recursive: true });
    writeFileSync(join(tempDir, "generated", "comfyui", "base.png"), PNG_1X1);
    await call("comfyui_workflow", {
      path: "comfyui/edit.json",
      start_from: "template:image_qwen_image_2_1_t2i",
      operations: [{ op: "add", node: "20", class_type: "LoadImage", inputs: { image: "placeholder.png" } }, { op: "add", node: "21", class_type: "SaveImage", inputs: { images: ["20", 0] } }],
    });
    for (const name of ["base.png", "comfyui/base.png", "generated/comfyui/base.png"]) {
      const result = await call("comfyui_run", { workflow: "comfyui/edit.json", images: { "20.image": name } });
      expect(result.success, name).toBe(true);
      expect(result.output).toContain("20.image=generated/comfyui/base.png");
    }
    expect(server.uploads).toEqual(["starlingai/base.png", "starlingai/base.png", "starlingai/base.png"]);
  });

  it("says where pictures are when the one named is not there, and runs nothing", async () => {
    await call("comfyui_workflow", {
      path: "comfyui/edit.json",
      start_from: "template:image_qwen_image_2_1_t2i",
      operations: [{ op: "add", node: "20", class_type: "LoadImage", inputs: { image: "placeholder.png" } }, { op: "add", node: "21", class_type: "SaveImage", inputs: { images: ["20", 0] } }],
    });
    const result = await call("comfyui_run", { workflow: "comfyui/edit.json", images: { "20.image": "missing.png" } });
    expect(result.success).toBe(false);
    expect(result.error).toBe('images: "20.image": there is no picture missing.png in the workspace. comfyui_run saves its pictures under generated/comfyui/ and names each one in its answer');
    expect(server.uploads).toEqual([]);
    expect(server.prompts).toHaveLength(0);
    // A path outside the workspace is refused as that, not reported as a missing picture.
    const outside = await call("comfyui_run", { workflow: "comfyui/edit.json", images: { "20.image": "../../outside.png" } });
    expect(outside.success).toBe(false);
    expect(outside.error).not.toContain("there is no picture");
    expect(outside.error).toMatch(/escapes workspace/i);
  });

  it("refuses a key that names no node, listing the nodes there are", async () => {
    await call("comfyui_workflow", { path: "comfyui/fox.json", start_from: "template:image_qwen_image_2_1_t2i" });
    const result = await call("comfyui_run", { workflow: "comfyui/fox.json", set: { "99.steps": 5 } });
    expect(result.success).toBe(false);
    expect(result.error).toContain('set: "99.steps" names no node of this workflow');
    expect(result.error).toContain("7 KSampler");
    expect(server.prompts).toHaveLength(0);
  });

  it("reports ComfyUI's refusal with the nearest valid choice", async () => {
    await call("comfyui_workflow", { path: "comfyui/fox.json", start_from: "template:image_qwen_image_2_1_t2i", operations: [{ op: "set", node: "1", inputs: { unet_name: "qwen_image.safetensors" } }] });
    server.promptReply = () => new Response(JSON.stringify({
      error: { message: "Prompt outputs failed validation" },
      node_errors: { "1": { class_type: "UNETLoader", errors: [{ message: "Value not in list", details: "unet_name: 'qwen_image.safetensors' not in [...]", extra_info: { input_name: "unet_name" } }] } },
    }), { status: 400 });
    const result = await call("comfyui_run", { workflow: "comfyui/fox.json" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("node 1 (UNETLoader).unet_name: Value not in list");
    expect(result.error).toContain("closest: qwen_image_2.1_int8_convrot.safetensors");
  });

  it("adds what supplies a missing input to ComfyUI's refusal", async () => {
    await call("comfyui_workflow", {
      path: "comfyui/gap.json",
      start_from: "template:image_qwen_image_2_1_t2i",
      operations: [{ op: "insert", class_type: "ImageUpscaleWithModel", node: "up", before: "SaveImage" }],
    });
    server.promptReply = () => new Response(JSON.stringify({
      error: { message: "Prompt outputs failed validation" },
      node_errors: { up: { class_type: "ImageUpscaleWithModel", errors: [{ message: "Required input is missing", details: "upscale_model", extra_info: { input_name: "upscale_model" } }] } },
    }), { status: 400 });
    const result = await call("comfyui_run", { workflow: "comfyui/gap.json" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Hints:");
    expect(result.error).toContain("UpscaleModelLoader gives one");
  });

  it("a refusal ComfyUI answers with 200 fails the run when nothing was saved, and is a note when something was", async () => {
    await call("comfyui_workflow", { path: "comfyui/fox.json", start_from: "template:image_qwen_image_2_1_t2i" });
    const partial = { prompt_id: "p1", node_errors: { "13": { class_type: "ImageCompare", errors: [{ message: "Required input is missing", details: "compare_view", extra_info: { input_name: "compare_view" } }] } } };
    server.promptReply = () => new Response(JSON.stringify(partial), { status: 200 });
    const withFile = await call("comfyui_run", { workflow: "comfyui/fox.json" });
    expect(withFile.success).toBe(true);
    expect(withFile.output).toContain("NOTE: ComfyUI skipped parts it refused");

    vi.unstubAllGlobals();
    const noFiles = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname.startsWith("/history/")) {
        return new Response(JSON.stringify({ p1: { status: { status_str: "success", completed: true, messages: [] }, outputs: {} } }), { status: 200 });
      }
      return fetchMock(input, init);
    });
    vi.stubGlobal("fetch", noFiles);
    const nothing = await call("comfyui_run", { workflow: "comfyui/fox.json" });
    expect(nothing.success).toBe(false);
    expect(nothing.error).toContain("ComfyUI refused part of the workflow and nothing was saved");
  });
});
