import { describe, expect, it } from "vitest";
import {
  GraphOperationError,
  applyOperations,
  checkGraph,
  danglingNodes,
  keyInputs,
  markSamplePrompts,
  resolveInputRef,
  resolveNodeRef,
  searchNodes,
  setPrompt,
  unchangedSamplePrompts,
  type ApiGraph,
  type NodeCatalog,
} from "../multimodal/comfyui-graph.js";

/**
 * Adding a stage to a workflow that exists. Each case comes from the lab's image_creator trying
 * "a picture, then four times the size" on the official Qwen-Image template.
 */

const catalog: NodeCatalog = {
  UNETLoader: { input: { required: { unet_name: [["qwen.safetensors"], {}] } }, output: ["MODEL"] },
  LoraLoaderModelOnly: { input: { required: { model: ["MODEL", {}], lora_name: [["a.safetensors", "b.safetensors"], {}], strength_model: ["FLOAT", { default: 1 }] } }, output: ["MODEL"] },
  ConditioningZeroOut: { input: { required: { conditioning: ["CONDITIONING", {}] } }, output: ["CONDITIONING"] },
  Prompt: { input: { required: { text: ["STRING", {}] } }, output: ["CONDITIONING"] },
  KSampler: { input: { required: { model: ["MODEL", {}], positive: ["CONDITIONING", {}], negative: ["CONDITIONING", {}], seed: ["INT", { default: 0 }] } }, output: ["LATENT"] },
  VAEDecode: { input: { required: { samples: ["LATENT", {}] } }, output: ["IMAGE"] },
  SaveImageAdvanced: { output_node: true, input: { required: { images: ["IMAGE", {}], filename_prefix: ["STRING", { default: "x" }] } }, output: [] },
  PreviewAny: { output_node: true, input: { required: { source: ["COMFY_MATCHTYPE_V3", {}] } }, output: [] },
  ComfySwitchNode: { input: { required: { switch: ["BOOLEAN", {}] }, optional: { on_false: ["COMFY_MATCHTYPE_V3", {}], on_true: ["COMFY_MATCHTYPE_V3", {}] } }, output: ["COMFY_MATCHTYPE_V3"] },
  Merge: { output_node: true, input: { required: { images: ["IMAGE", {}], extra: ["COMFY_MATCHTYPE_V3", {}] } }, output: [] },
  UpscaleModelLoader: { category: "loaders", input: { required: { model_name: [["RealESRGAN_x4plus.pth"], {}] } }, output: ["UPSCALE_MODEL"] },
  ImageUpscaleWithModel: { display_name: "Upscale Image (using Model)", category: "image/upscaling", input: { required: { upscale_model: ["UPSCALE_MODEL", {}], image: ["IMAGE", {}] } }, output: ["IMAGE"] },
  ImageScale: { display_name: "Upscale Image", category: "image/upscaling", input: { required: { image: ["IMAGE", {}], width: ["INT", { default: 512 }] } }, output: ["IMAGE"] },
  ImageBlend: { input: { required: { image1: ["IMAGE", {}], image2: ["IMAGE", {}] } }, output: ["IMAGE"] },
  ImageStats: { output_node: true, input: { required: { image: ["IMAGE", {}] } }, output: ["STRING"] },
};

function workflow(): ApiGraph {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen.safetensors" } },
    "2": { class_type: "Prompt", inputs: { text: "a fox" } },
    "3": { class_type: "Prompt", inputs: { text: "" } },
    "459:7": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], negative: ["3", 0], seed: 1 } },
    "459:8": { class_type: "VAEDecode", inputs: { samples: ["459:7", 0] } },
    "9": { class_type: "SaveImageAdvanced", inputs: { images: ["459:8", 0], filename_prefix: "fox" }, _meta: { title: "Save Image (Advanced)" } },
  };
}

describe("insert", () => {
  it("puts the new node on the connection and hands the old one to it", () => {
    const { graph, notes } = applyOperations(
      workflow(),
      [
        { op: "add", class_type: "UpscaleModelLoader" },
        { op: "insert", class_type: "ImageUpscaleWithModel", before: "9", inputs: { upscale_model: ["UpscaleModelLoader", 0] } },
      ],
      catalog,
    );
    expect(graph["11"]!.inputs).toEqual({ upscale_model: ["10", 0], image: ["459:8", 0] });
    expect(graph["9"]!.inputs["images"]).toEqual(["11", 0]);
    expect(notes[1]).toBe("inserted 11 ImageUpscaleWithModel before 9.images (image<-459:8.0)");
    expect(checkGraph(graph, catalog).errors).toEqual([]);
    expect(danglingNodes(graph, catalog)).toEqual([]);
  });

  it("finds the receiving node by part of its name, as a model writes it", () => {
    const { graph } = applyOperations(workflow(), [{ op: "insert", class_type: "ImageScale", before: "SaveImage" }], catalog);
    const id = (graph["9"]!.inputs["images"] as [string, number])[0];
    expect(graph[id]!.class_type).toBe("ImageScale");
    expect(graph[id]!.inputs["image"]).toEqual(["459:8", 0]);
    expect(graph[id]!.inputs["width"]).toBe(512);
  });

  it("takes the one input whose type fits, and only that one", () => {
    const { graph } = applyOperations(workflow(), [{ op: "insert", class_type: "LoraLoaderModelOnly", before: "KSampler", inputs: { lora_name: "b.safetensors" } }], catalog);
    const sampler = graph["459:7"]!;
    const id = (sampler.inputs["model"] as [string, number])[0];
    expect(graph[id]!.class_type).toBe("LoraLoaderModelOnly");
    expect(graph[id]!.inputs["model"]).toEqual(["1", 0]);
    expect(sampler.inputs["positive"]).toEqual(["2", 0]);
    expect(sampler.inputs["negative"]).toEqual(["3", 0]);
  });

  it("asks which input when two fit, and takes the one named", () => {
    expect(() => applyOperations(workflow(), [{ op: "insert", class_type: "ConditioningZeroOut", before: "KSampler" }], catalog))
      .toThrow(/fits several inputs of 459:7 \(KSampler\): positive, negative. Write before as "459:7.<input>"/);
    const { graph } = applyOperations(workflow(), [{ op: "insert", class_type: "ConditioningZeroOut", before: "KSampler.negative" }], catalog);
    const sampler = graph["459:7"]!;
    expect(sampler.inputs["positive"]).toEqual(["2", 0]);
    const id = (sampler.inputs["negative"] as [string, number])[0];
    expect(graph[id]!.inputs["conditioning"]).toEqual(["3", 0]);
  });

  it("prefers a typed connection over one that carries anything", () => {
    const graph: ApiGraph = {
      "1": { class_type: "VAEDecode", inputs: { samples: ["2", 0] } },
      "2": { class_type: "KSampler", inputs: {} },
      "3": { class_type: "ComfySwitchNode", inputs: { switch: true, on_true: "x" } },
      "4": { class_type: "Merge", inputs: { images: ["1", 0], extra: ["3", 0] } },
    };
    const { graph: next } = applyOperations(graph, [{ op: "insert", class_type: "ImageScale", before: "4" }], catalog);
    expect(next["4"]!.inputs["extra"]).toEqual(["3", 0]);
    expect(next[(next["4"]!.inputs["images"] as [string, number])[0]]!.class_type).toBe("ImageScale");
  });

  it("refuses what fits nowhere and changes nothing", () => {
    const original = workflow();
    expect(() => applyOperations(original, [{ op: "insert", class_type: "ImageScale", before: "KSampler" }], catalog)).toThrow(GraphOperationError);
    expect(() => applyOperations(original, [{ op: "insert", class_type: "ImageScale", before: "KSampler" }], catalog)).toThrow(/fits no link into 459:7 \(KSampler\). Its links: model, positive, negative/);
    expect(() => applyOperations(original, [{ op: "insert", class_type: "ImageScale", before: "9.filename_prefix" }], catalog)).toThrow(/fits no link into 9.filename_prefix/);
    expect(original).toEqual(workflow());
  });

  it("goes in front of the output when no node is named", () => {
    const { graph, notes } = applyOperations(workflow(), [{ op: "insert", class_type: "ImageScale", node: "up" }], catalog);
    expect(graph["9"]!.inputs["images"]).toEqual(["up", 0]);
    expect(graph["up"]!.inputs["image"]).toEqual(["459:8", 0]);
    expect(notes[0]).toContain("before 9.images");
  });

  it("takes the output with the typed connection over one that shows anything", () => {
    // The official Qwen-Image template also ends in a PreviewAny showing the prompt.
    const graph = workflow();
    graph["2b"] = { class_type: "ComfySwitchNode", inputs: { switch: false, on_false: "x" } };
    graph["p"] = { class_type: "PreviewAny", inputs: { source: ["2b", 0] } };
    const { graph: next } = applyOperations(graph, [{ op: "insert", class_type: "ImageScale", node: "up" }], catalog);
    expect(next["9"]!.inputs["images"]).toEqual(["up", 0]);
    expect(next["p"]!.inputs["source"]).toEqual(["2b", 0]);
  });

  it("is never put on a connection where neither side says what flows", () => {
    // As in the official Qwen-Image template: the prompt text goes through a switch into a preview of any type.
    const graph = workflow();
    graph["sw"] = { class_type: "ComfySwitchNode", inputs: { switch: false, on_false: "a fox" } };
    graph["p"] = { class_type: "PreviewAny", inputs: { source: ["sw", 0] } };
    expect(() => applyOperations(graph, [{ op: "insert", class_type: "VAEDecode" }], catalog)).toThrow(/VAEDecode fits in front of no output of this workflow, which has VAEDecode 459:8 already: before must name/);
    expect(() => applyOperations(graph, [{ op: "insert", class_type: "ImageScale", before: "p" }], catalog))
      .toThrow("ImageScale fits no link into p (PreviewAny). Its links: source. It fits before 9.images");
    const { graph: next } = applyOperations(graph, [{ op: "insert", class_type: "ImageScale", node: "up" }], catalog);
    expect(next["p"]!.inputs["source"]).toEqual(["sw", 0]);
    expect(next["9"]!.inputs["images"]).toEqual(["up", 0]);
  });

  it("asks which output when two fit", () => {
    const graph = workflow();
    graph["10"] = { class_type: "SaveImageAdvanced", inputs: { images: ["459:8", 0], filename_prefix: "small" } };
    expect(() => applyOperations(graph, [{ op: "insert", class_type: "ImageScale" }], catalog))
      .toThrow('could go before several outputs: before: "9" (SaveImageAdvanced) or before: "10" (SaveImageAdvanced)');
  });

  it("says before is needed for a stage no output can take", () => {
    expect(() => applyOperations(workflow(), [{ op: "insert", class_type: "LoraLoaderModelOnly" }], catalog))
      .toThrow(/LoraLoaderModelOnly fits in front of no output of this workflow: before must name/);
  });

  it("reads what a switch carries from the input it feeds", () => {
    // A V3 switch's output is of any type: taken at face value, the first socket (the model's) would get the picture.
    const graph: ApiGraph = {
      "1": { class_type: "VAEDecode", inputs: { samples: ["2", 0] } },
      "2": { class_type: "KSampler", inputs: {} },
      "3": { class_type: "ComfySwitchNode", inputs: { switch: true, on_true: ["1", 0] } },
      "4": { class_type: "SaveImageAdvanced", inputs: { images: ["3", 0], filename_prefix: "x" } },
    };
    const { graph: next } = applyOperations(graph, [{ op: "insert", class_type: "ImageUpscaleWithModel", node: "up", before: "4" }], catalog);
    expect(next["up"]!.inputs).toEqual({ image: ["3", 0] });
  });

  it("keeps an input it was given, when another socket takes the same type", () => {
    const graph = workflow();
    graph["5"] = { class_type: "VAEDecode", inputs: { samples: ["459:7", 0] } };
    const { graph: next } = applyOperations(graph, [{ op: "insert", class_type: "ImageBlend", node: "b", before: "9", inputs: { image1: ["5", 0] } }], catalog);
    expect(next["b"]!.inputs).toEqual({ image1: ["5", 0], image2: ["459:8", 0] });
  });

  it("takes the connection the caller wired itself, and moves only the output", () => {
    const { graph, notes } = applyOperations(workflow(), [{ op: "insert", class_type: "ImageScale", node: "up", before: "9.images", inputs: { image: ["VAEDecode", 0] } }], catalog);
    expect(graph["up"]!.inputs["image"]).toEqual(["459:8", 0]);
    expect(graph["9"]!.inputs["images"]).toEqual(["up", 0]);
    expect(notes[0]).toBe("inserted up ImageScale before 9.images (defaults for width)");
  });

  it("keeps the connection the caller wired when it differs from the old one", () => {
    const graph = workflow();
    graph["5"] = { class_type: "VAEDecode", inputs: { samples: ["459:7", 0] } };
    const { graph: next } = applyOperations(graph, [{ op: "insert", class_type: "ImageScale", node: "up", before: "9", inputs: { image: ["5", 0] } }], catalog);
    expect(next["up"]!.inputs["image"]).toEqual(["5", 0]);
    expect(next["9"]!.inputs["images"]).toEqual(["up", 0]);
  });

  it("does so in front of the output too", () => {
    const { graph } = applyOperations(workflow(), [{ op: "insert", class_type: "ImageScale", node: "up", inputs: { image: ["VAEDecode", 0] } }], catalog);
    expect(graph["9"]!.inputs["images"]).toEqual(["up", 0]);
  });

  it("does not count a plain value in that socket as wiring it", () => {
    expect(() => applyOperations(workflow(), [{ op: "insert", class_type: "ImageScale", before: "9.images", inputs: { image: "photo.png" } }], catalog)).toThrow(/fits no link into 9.images/);
  });

  it("leaves other readers of the same output alone", () => {
    const graph = workflow();
    graph["10"] = { class_type: "SaveImageAdvanced", inputs: { images: ["459:8", 0], filename_prefix: "small" } };
    const { graph: next } = applyOperations(graph, [{ op: "insert", class_type: "ImageScale", before: "9" }], catalog);
    expect(next["10"]!.inputs["images"]).toEqual(["459:8", 0]);
  });
});

describe("what a model writes after reading the tool's own output", () => {
  it("takes <node>.<input> in set, the way the tool names an input", () => {
    const { graph, notes } = applyOperations(workflow(), [{ op: "set", node: "9.filename_prefix", inputs: { text: "renamed" } }], catalog);
    expect(graph["9"]!.inputs["filename_prefix"]).toBe("renamed");
    expect(graph["9"]!.inputs["text"]).toBeUndefined();
    expect(notes[0]).toBe("set 9: filename_prefix");
  });

  it("keeps the input names given when they say more than the reference", () => {
    const named = applyOperations(workflow(), [{ op: "set", node: "9.filename_prefix", inputs: { filename_prefix: "a" } }], catalog).graph;
    expect(named["9"]!.inputs["filename_prefix"]).toBe("a");
    const two = applyOperations(workflow(), [{ op: "set", node: "9.images", inputs: { filename_prefix: "b", images: ["459:8", 0] } }], catalog).graph;
    expect(two["9"]!.inputs["filename_prefix"]).toBe("b");
    expect(two["9"]!.inputs["images"]).toEqual(["459:8", 0]);
  });

  it("does not guess a node from a reference that names none", () => {
    expect(() => applyOperations(workflow(), [{ op: "set", node: "7.text", inputs: { text: "x" } }], catalog)).toThrow(/there is no node 7.text/);
  });

  it("reads a link written as the node listing prints it", () => {
    const set = (images: unknown) => applyOperations(workflow(), [{ op: "set", node: "9", inputs: { images } }], catalog).graph["9"]!.inputs["images"];
    expect(set(["459:8.0"])).toEqual(["459:8", 0]);
    expect(set("459:8.0")).toEqual(["459:8", 0]);
    expect(set("<-459:8.0")).toEqual(["459:8", 0]);
    expect(set(["VAEDecode.0"])).toEqual(["459:8", 0]);
  });

  it("leaves the same string alone on an input that takes text", () => {
    const { graph } = applyOperations(workflow(), [{ op: "set", node: "9", inputs: { filename_prefix: "459:8.0" } }], catalog);
    expect(graph["9"]!.inputs["filename_prefix"]).toBe("459:8.0");
  });

  it("reads those links on add and insert too", () => {
    const { graph } = applyOperations(workflow(), [
      { op: "add", class_type: "ImageScale", node: "a", inputs: { image: "459:8.0" } },
      { op: "insert", class_type: "ImageScale", node: "b", before: "9", inputs: { image: ["459:8.0"] } },
      { op: "insert", class_type: "ImageScale", node: "c", before: "9", inputs: { image: "b.0" } },
    ], catalog);
    expect(graph["a"]!.inputs["image"]).toEqual(["459:8", 0]);
    expect(graph["b"]!.inputs["image"]).toEqual(["459:8", 0]);
    expect(graph["c"]!.inputs["image"]).toEqual(["b", 0]);
    expect(graph["9"]!.inputs["images"]).toEqual(["c", 0]);
  });

  it("adds a node that takes no connection when asked to insert it", () => {
    const { graph, notes } = applyOperations(workflow(), [{ op: "insert", class_type: "UpscaleModelLoader", node: "m", inputs: { model_name: "RealESRGAN_x4plus.pth" } }], catalog);
    expect(notes[0]).toBe("added m UpscaleModelLoader");
    expect(graph["m"]!._meta?.added).toBe(true);
    expect(graph["9"]!.inputs["images"]).toEqual(["459:8", 0]);
  });
});

describe("danglingNodes", () => {
  it("names an added node nothing reads, until something does", () => {
    const { graph } = applyOperations(workflow(), [{ op: "add", class_type: "ImageScale", node: "up", inputs: { image: ["459:8", 0] } }], catalog);
    expect(danglingNodes(graph, catalog)).toEqual(["up"]);
    const { graph: wired } = applyOperations(graph, [{ op: "set", node: "9", inputs: { images: ["up", 0] } }], catalog);
    expect(danglingNodes(wired, catalog)).toEqual([]);
  });

  it("names an inserted node once it is bypassed", () => {
    const { graph } = applyOperations(workflow(), [{ op: "insert", class_type: "ImageScale", node: "up", before: "9" }], catalog);
    expect(danglingNodes(graph, catalog)).toEqual([]);
    const { graph: bypassed } = applyOperations(graph, [{ op: "set", node: "9", inputs: { images: ["459:8", 0] } }], catalog);
    expect(danglingNodes(bypassed, catalog)).toEqual(["up"]);
  });

  it("leaves a workflow author's own unused nodes alone", () => {
    const graph = workflow();
    graph["20"] = { class_type: "ImageScale", inputs: { image: ["459:8", 0], width: 8 } };
    expect(danglingNodes(graph, catalog)).toEqual([]);
  });

  it("does not count an added output node, even one that also gives something", () => {
    const { graph } = applyOperations(workflow(), [
      { op: "add", class_type: "SaveImageAdvanced", node: "s", inputs: { images: ["459:8", 0] } },
      { op: "add", class_type: "ImageStats", node: "t", inputs: { image: ["459:8", 0] } },
    ], catalog);
    expect(danglingNodes(graph, catalog)).toEqual([]);
  });
});

describe("searchNodes", () => {
  it("shows what a node needs and gives, with short choice lists spelled out", () => {
    const [line] = searchNodes(catalog, "UpscaleModelLoader");
    expect(line).toBe('UpscaleModelLoader — loaders (model_name: RealESRGAN_x4plus.pth) -> UPSCALE_MODEL');
    expect(searchNodes(catalog, "ImageUpscaleWithModel")[0]).toBe('ImageUpscaleWithModel ("Upscale Image (using Model)") — image/upscaling (upscale_model: UPSCALE_MODEL, image: IMAGE) -> IMAGE');
  });

  it("reads a guessed type name as its words", () => {
    const hits = searchNodes(catalog, "UpscaleImage");
    expect(hits.some((hit) => hit.startsWith("ImageUpscaleWithModel"))).toBe(true);
    expect(hits.some((hit) => hit.startsWith("ImageScale"))).toBe(true);
  });

  it("falls back to the types matching the most words when none has them all", () => {
    const hits = searchNodes(catalog, "upscale model teleport");
    expect(hits[0]).toMatch(/^(ImageUpscaleWithModel|UpscaleModelLoader)/);
    expect(hits.every((hit) => !hit.startsWith("KSampler"))).toBe(true);
  });

  it("finds nothing when no word matches", () => {
    expect(searchNodes(catalog, "teleport")).toEqual([]);
  });

  it("keeps signatures to the best hits", () => {
    const many: NodeCatalog = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`Thing${String(i).padStart(2, "0")}`, { category: "c", input: {}, output: ["X"] }]));
    const hits = searchNodes(many, "thing");
    expect(hits).toHaveLength(20);
    expect(hits[11]).toContain("-> X");
    expect(hits[12]).not.toContain("-> X");
  });
});

describe("a missing input says what supplies it", () => {
  const check = (graph: ApiGraph) => checkGraph(graph, catalog).errors.join("\n");

  it("names the loader for a type only a loader gives", () => {
    const graph = workflow();
    graph["11"] = { class_type: "ImageUpscaleWithModel", inputs: { image: ["459:8", 0] } };
    expect(check(graph)).toContain('node 11 (ImageUpscaleWithModel): required input "upscale_model" is missing (UPSCALE_MODEL; UpscaleModelLoader gives one)');
  });

  it("points at a node already in the workflow first", () => {
    const graph = workflow();
    graph["10"] = { class_type: "UpscaleModelLoader", inputs: { model_name: "RealESRGAN_x4plus.pth" } };
    graph["11"] = { class_type: "ImageUpscaleWithModel", inputs: { image: ["459:8", 0] } };
    expect(check(graph)).toContain('required input "upscale_model" is missing (UPSCALE_MODEL; in this workflow ["10", 0] gives one)');
  });

  it("names only the type where many nodes could give it", () => {
    const graph: ApiGraph = { "1": { class_type: "SaveImageAdvanced", inputs: { filename_prefix: "x" } } };
    const crowded: NodeCatalog = { ...catalog, A: { input: {}, output: ["IMAGE"] }, B: { input: {}, output: ["IMAGE"] }, C: { input: {}, output: ["IMAGE"] }, D: { input: {}, output: ["IMAGE"] } };
    expect(checkGraph(graph, crowded).errors).toContain('node 1 (SaveImageAdvanced): required input "images" is missing (IMAGE)');
  });

  it("adds nothing to a missing plain value", () => {
    const graph: ApiGraph = { "1": { class_type: "SaveImageAdvanced", inputs: { images: ["2", 0] } }, "2": { class_type: "VAEDecode", inputs: { samples: ["3", 0] } }, "3": { class_type: "KSampler", inputs: {} } };
    expect(checkGraph(graph, catalog).errors).toContain('node 1 (SaveImageAdvanced): required input "filename_prefix" is missing');
  });
});

describe("a link to a node that is not there", () => {
  it("is the link to the one node that gives what the input takes", () => {
    // The lab: ["KSampler.outputs", 0] for the decoded picture, ["459:801", 0] for the loader just added.
    const { graph, notes } = applyOperations(workflow(), [{ op: "add", class_type: "ImageScale", node: "s", inputs: { image: ["KSampler.outputs", 0] } }], catalog);
    expect(graph["s"]!.inputs["image"]).toEqual(["459:8", 0]);
    expect(notes[0]).toBe("image<-459:8.0 (there is no node KSampler.outputs; 459:8 is the one node giving IMAGE)");
    const loader = applyOperations(workflow(), [
      { op: "add", class_type: "UpscaleModelLoader" },
      { op: "insert", class_type: "ImageUpscaleWithModel", node: "up", inputs: { upscale_model: ["459:801", 0] } },
    ], catalog).graph;
    expect(loader["up"]!.inputs["upscale_model"]).toEqual(["10", 0]);
  });

  it("is left to the connection a stage is inserted on, when several nodes could be meant", () => {
    // The official template's save node gives its picture on, so two nodes give IMAGE there.
    const graph = workflow();
    graph["5"] = { class_type: "VAEDecode", inputs: { samples: ["459:7", 0] } };
    const { graph: next, notes } = applyOperations(graph, [{ op: "insert", class_type: "ImageScale", node: "s", inputs: { image: ["KSampler.outputs", 0] } }], catalog);
    expect(next["s"]!.inputs["image"]).toEqual(["459:8", 0]);
    expect(next["9"]!.inputs["images"]).toEqual(["s", 0]);
    expect(notes[0]).toBe("image: there is no node KSampler.outputs; left to the connection the node is put on");
    // Added, not inserted, there is no connection to leave it to.
    expect(() => applyOperations(graph, [{ op: "add", class_type: "ImageScale", inputs: { image: ["KSampler.outputs", 0] } }], catalog))
      .toThrow('there is no node KSampler.outputs (IMAGE; in this workflow ["459:8", 0] or ["5", 0] gives one)');
  });

  it("names the nodes that could be meant when there are several, and what would give it when there is none", () => {
    expect(() => applyOperations(workflow(), [{ op: "set", node: "KSampler", inputs: { positive: ["nope", 0] } }], catalog))
      .toThrow('input positive: there is no node nope (CONDITIONING; in this workflow ["2", 0] or ["3", 0] gives one)');
    expect(() => applyOperations(workflow(), [{ op: "add", class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["459:801", 0] } }], catalog))
      .toThrow("input upscale_model: there is no node 459:801 (UPSCALE_MODEL; UpscaleModelLoader gives one)");
  });

  it("is never the node's own output", () => {
    const graph = applyOperations(workflow(), [{ op: "add", class_type: "ImageScale", node: "s", inputs: { image: ["459:8", 0] } }], catalog).graph;
    const { graph: next } = applyOperations(graph, [{ op: "set", node: "s", inputs: { image: ["nope", 0] } }], catalog);
    expect(next["s"]!.inputs["image"]).toEqual(["459:8", 0]);
  });

  it("stays an error on an input that takes a plain value", () => {
    expect(() => applyOperations(workflow(), [{ op: "set", node: "9", inputs: { filename_prefix: ["nope", 0] } }], catalog)).toThrow(/there is no node nope$/);
  });
});

describe("a stage that fits nowhere it was put", () => {
  it("is told where it fits", () => {
    expect(() => applyOperations(workflow(), [{ op: "insert", class_type: "ImageScale", before: "KSampler" }], catalog))
      .toThrow("ImageScale fits no link into 459:7 (KSampler). Its links: model, positive, negative. It fits before 9.images");
  });

  it("is told only the places whose type it takes, not one that shows anything", () => {
    const graph = workflow();
    graph["sw"] = { class_type: "ComfySwitchNode", inputs: { switch: true, on_true: "x" } };
    graph["p"] = { class_type: "PreviewAny", inputs: { source: ["sw", 0] } };
    expect(() => applyOperations(graph, [{ op: "insert", class_type: "ImageScale", before: "KSampler" }], catalog))
      .toThrow(/\. It fits before 9\.images$/);
  });

  it("is told nothing more where it fits nowhere", () => {
    const graph: ApiGraph = { "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen.safetensors" } }, "2": { class_type: "KSampler", inputs: { model: ["1", 0] } } };
    expect(() => applyOperations(graph, [{ op: "insert", class_type: "ImageScale", before: "2" }], catalog)).toThrow(/Its links: model$/);
  });
});

describe("a choice written in part", () => {
  const choices: NodeCatalog = {
    ...catalog,
    Ratio: { input: { required: { aspect_ratio: [["1:1 (Square)", "3:2 (Photo)", "2:3 (Portrait Photo)"], {}], flip: [["x-axis: vertically", "y-axis: horizontally"], {}] } }, output: ["FLOAT"] },
    Flip: { input: { required: { image: ["IMAGE", {}], flip_method: [["x-axis: vertically", "y-axis: horizontally"], {}] } }, output: ["IMAGE"] },
    Sampler2: { input: { required: { sampler: [["Euler", "euler_ancestral"], {}] } }, output: ["FLOAT"] },
  };
  const ratio = (inputs: Record<string, unknown>) => applyOperations(workflow(), [{ op: "add", class_type: "Ratio", node: "r", inputs }], choices);

  it("is the one choice it starts, equals but for case, or is found in", () => {
    // The lab: "3:2" for "3:2 (Photo)" cost a refused run three times, "y-axis" a hand edit of the file.
    const { graph, notes } = ratio({ aspect_ratio: "3:2", flip: "horizontal" });
    expect(graph["r"]!.inputs).toEqual({ aspect_ratio: "3:2 (Photo)", flip: "y-axis: horizontally" });
    expect(notes).toEqual(["added r Ratio", 'r.aspect_ratio: "3:2" taken as "3:2 (Photo)"', 'r.flip: "horizontal" taken as "y-axis: horizontally"']);
    expect(ratio({ aspect_ratio: "3:2 (photo)", flip: "y-axis" }).graph["r"]!.inputs).toEqual({ aspect_ratio: "3:2 (Photo)", flip: "y-axis: horizontally" });
  });

  it("is the choice it equals but for case, even where another choice starts with it", () => {
    const { graph } = applyOperations(workflow(), [{ op: "add", class_type: "Sampler2", node: "s", inputs: { sampler: "euler" } }], choices);
    expect(graph["s"]!.inputs["sampler"]).toBe("Euler");
  });

  it("is left alone where more than one choice fits, or none", () => {
    const { graph, notes } = ratio({ aspect_ratio: "16:9", flip: "axis" });
    expect(graph["r"]!.inputs).toEqual({ aspect_ratio: "16:9", flip: "axis" });
    expect(notes).toEqual(["added r Ratio"]);
  });

  it("is not looked for inside a choice when it is two letters", () => {
    expect(ratio({ aspect_ratio: "1:1 (Square)", flip: "ho" }).graph["r"]!.inputs["flip"]).toBe("ho");
  });

  it("does not turn the start of several into the one that holds it elsewhere", () => {
    // "2" starts "2:3 (Portrait Photo)" alone; "3" starts "3:2 (Photo)" alone although "2:3" holds a 3.
    expect(ratio({ aspect_ratio: "3", flip: "x" }).graph["r"]!.inputs).toEqual({ aspect_ratio: "3:2 (Photo)", flip: "x-axis: vertically" });
  });

  it("says nothing about a choice written in full", () => {
    expect(ratio({ aspect_ratio: "2:3 (Portrait Photo)", flip: "x-axis: vertically" }).notes).toEqual(["added r Ratio"]);
  });

  it("is taken in set and insert as in add", () => {
    const added = ratio({ aspect_ratio: "1:1 (Square)", flip: "x-axis: vertically" }).graph;
    const set = applyOperations(added, [{ op: "set", node: "r", inputs: { aspect_ratio: "2:3" } }], choices);
    expect(set.graph["r"]!.inputs["aspect_ratio"]).toBe("2:3 (Portrait Photo)");
    expect(set.notes).toEqual(["set r: aspect_ratio", 'r.aspect_ratio: "2:3" taken as "2:3 (Portrait Photo)"']);
    const inserted = applyOperations(workflow(), [{ op: "insert", class_type: "Flip", node: "f", inputs: { flip_method: "y-axis" } }], choices);
    expect(inserted.graph["f"]!.inputs["flip_method"]).toBe("y-axis: horizontally");
    expect(inserted.notes[1]).toBe('f.flip_method: "y-axis" taken as "y-axis: horizontally"');
  });
});

describe("set on an input the node does not have", () => {
  const v3: NodeCatalog = {
    ...catalog,
    Saver: {
      output_node: true,
      input: { required: { images: ["IMAGE", {}], format: ["COMFY_DYNAMICCOMBO_V3", { options: [
        { key: "png", inputs: { required: { bit_depth: ["COMBO", { default: "8-bit", options: ["8-bit", "16-bit"] }] } } },
        { key: "webp", inputs: { required: { quality: ["INT", { default: 90 }] } } },
      ] }] } },
      output: [],
    },
    Grouped: { output_node: true, input: { required: { images: ["IMAGE", {}], extras: ["COMFY_DYNAMICGROUP_V3", {}] } }, output: [] },
  };

  it("is refused with the node's inputs, and changes nothing", () => {
    // The lab: the prompt went to `text` on a node whose input is `prompt`; ComfyUI ignored it and rendered the template's sample.
    const original = workflow();
    expect(() => applyOperations(original, [{ op: "set", node: "KSampler", inputs: { text: "a fox" } }], catalog))
      .toThrow('operation 1 (set): 459:7 (KSampler) has no input "text". Its inputs: model (link), positive (link), negative (link), seed');
    expect(original).toEqual(workflow());
  });

  it("still removes such an input", () => {
    const graph = workflow();
    graph["9"]!.inputs["legacy"] = 1;
    const { graph: next } = applyOperations(graph, [{ op: "set", node: "9", inputs: { legacy: null } }], catalog);
    expect("legacy" in next["9"]!.inputs).toBe(false);
    expect(() => applyOperations(workflow(), [{ op: "set", node: "9", inputs: { never_there: null } }], catalog)).not.toThrow();
  });

  it("changes an input the workflow already carries, declared or not", () => {
    const graph = workflow();
    graph["9"]!.inputs["legacy"] = 1;
    expect(applyOperations(graph, [{ op: "set", node: "9", inputs: { legacy: 2 } }], catalog).graph["9"]!.inputs["legacy"]).toBe(2);
  });

  it("takes a choice together with the inputs that choice brings", () => {
    const graph: ApiGraph = { ...workflow(), s: { class_type: "Saver", inputs: { images: ["459:8", 0], format: "png", "format.bit_depth": "8-bit" } } };
    const { graph: next } = applyOperations(graph, [{ op: "set", node: "s", inputs: { "format.quality": 80, format: "webp" } }], v3);
    expect(next["s"]!.inputs["format.quality"]).toBe(80);
    expect(() => applyOperations(graph, [{ op: "set", node: "s", inputs: { "format.quality": 80 } }], v3)).toThrow(/has no input "format.quality"/);
  });

  it("takes what a node accepts without declaring it", () => {
    const graph: ApiGraph = { ...workflow(), g: { class_type: "Grouped", inputs: { images: ["459:8", 0] } } };
    expect(applyOperations(graph, [{ op: "set", node: "g", inputs: { "extras.anything": 1 } }], v3).graph["g"]!.inputs["extras.anything"]).toBe(1);
  });
});

describe("a template's sample prompt", () => {
  const texts: NodeCatalog = {
    Text: { input: { required: { value: ["STRING", { multiline: true }] } }, output: ["STRING"] },
    Encode: { input: { required: { prompt: ["STRING", { multiline: true }], negative_prompt: ["STRING", { multiline: true }] } }, output: ["CONDITIONING"] },
    ComfySwitchNode: catalog["ComfySwitchNode"]!,
    Save: { output_node: true, input: { required: { cond: ["CONDITIONING", {}] } }, output: [] },
  };
  /** As the official template arrives: the prompt on a switch's branch, a text of its own behind the other branch. */
  const template = (): ApiGraph => ({
    "1": { class_type: "ComfySwitchNode", inputs: { switch: false, on_false: "Greyscale fashion portrait", on_true: ["4", 0] } },
    "2": { class_type: "Encode", inputs: { prompt: ["1", 0], negative_prompt: "blurry" } },
    "3": { class_type: "Save", inputs: { cond: ["2", 0] } },
    "4": { class_type: "Text", inputs: { value: "rewrite the prompt" } },
    "5": { class_type: "Encode", inputs: { prompt: "", negative_prompt: "" } },
    "6": { class_type: "Save", inputs: { cond: ["5", 0] } },
  });
  const marked = (): ApiGraph => {
    const graph = template();
    markSamplePrompts(graph, texts);
    return graph;
  };

  it("is marked where the workflow's prompt is, and nowhere else", () => {
    const graph = marked();
    expect(Object.keys(graph["1"]!._meta?.sample ?? {})).toEqual(["on_false"]);
    for (const id of ["2", "4", "5"]) expect(graph[id]!._meta).toBeUndefined();
    expect(unchangedSamplePrompts(graph, texts)).toEqual([{ address: "1.on_false", text: "Greyscale fashion portrait" }]);
  });

  it("is never reported on a workflow that came from no template", () => {
    expect(unchangedSamplePrompts(template(), texts)).toEqual([]);
  });

  it("is gone once the prompt is changed, however that is done", () => {
    const byOperation = applyOperations(marked(), [{ op: "set", node: "1.on_false", inputs: { text: "a cat on a sofa" } }], texts).graph;
    expect(unchangedSamplePrompts(byOperation, texts)).toEqual([]);
    const byHand = JSON.parse(JSON.stringify(marked()).replace("Greyscale fashion portrait", "a cat on a sofa")) as ApiGraph;
    expect(unchangedSamplePrompts(byHand, texts)).toEqual([]);
  });

  it("comes back with the text", () => {
    const graph = applyOperations(marked(), [{ op: "set", node: "1.on_false", inputs: { text: "a cat" } }], texts).graph;
    const back = applyOperations(graph, [{ op: "set", node: "1.on_false", inputs: { text: "Greyscale fashion portrait" } }], texts).graph;
    expect(unchangedSamplePrompts(back, texts)).toHaveLength(1);
  });

  it("survives the file", () => {
    expect(unchangedSamplePrompts(JSON.parse(JSON.stringify(marked())) as ApiGraph, texts)).toHaveLength(1);
  });

  it("is not reported when the prompt was written somewhere else", () => {
    // Straight onto the text encoder: the template's switch keeps its sample, and nothing uses it.
    const graph = applyOperations(marked(), [{ op: "set", node: "2", inputs: { prompt: "a cat on a sofa" } }], texts).graph;
    expect(unchangedSamplePrompts(graph, texts)).toEqual([]);
  });

  /** A classic template: one encoder type for both prompts, and texts that are no prompt at all. */
  const classic: NodeCatalog = {
    ...texts,
    Clip: { input: { required: { text: ["STRING", { multiline: true }] } }, output: ["CONDITIONING"] },
    Sampler: { input: { required: { positive: ["CONDITIONING", {}], negative: ["CONDITIONING", {}] } }, output: ["LATENT"] },
    Math: { input: { required: { expression: ["STRING", { multiline: true }] } }, output: ["FLOAT"] },
    Scaled: { input: { required: { factor: ["FLOAT", {}], cond: ["CONDITIONING", {}] } }, output: ["CONDITIONING"] },
    Shader: { output_node: true, input: { required: { code: ["STRING", { multiline: true }] } }, output: [] },
    Out: { output_node: true, input: { required: { latent: ["LATENT", {}] } }, output: [] },
  };
  const classicTemplate = (): ApiGraph => ({
    "1": { class_type: "Clip", inputs: { text: "a castle on a hill" } },
    "2": { class_type: "Clip", inputs: { text: "blurry, low quality" } },
    "3": { class_type: "Math", inputs: { expression: "a * 2" } },
    "4": { class_type: "Scaled", inputs: { factor: ["3", 0], cond: ["1", 0] } },
    "5": { class_type: "Sampler", inputs: { positive: ["4", 0], negative: ["2", 0] } },
    "6": { class_type: "Out", inputs: { latent: ["5", 0] } },
    "7": { class_type: "Shader", inputs: { code: "void main() {}" } },
  });

  it("is the text that becomes positive conditioning: not the negative prompt, an expression or code", () => {
    const graph = classicTemplate();
    markSamplePrompts(graph, classic);
    expect(unchangedSamplePrompts(graph, classic)).toEqual([{ address: "1.text", text: "a castle on a hill" }]);
    for (const id of ["2", "3", "7"]) expect(graph[id]!._meta).toBeUndefined();
    // Changing only the negative prompt leaves the picture the template's.
    const negativeOnly = applyOperations(graph, [{ op: "set", node: "2", inputs: { text: "ugly" } }], classic).graph;
    expect(unchangedSamplePrompts(negativeOnly, classic)).toHaveLength(1);
  });

  it("is not looked for where no text becomes conditioning", () => {
    const graph: ApiGraph = { "7": { class_type: "Shader", inputs: { code: "void main() {}" } }, "3": { class_type: "Math", inputs: { expression: "a * 2" } } };
    markSamplePrompts(graph, classic);
    expect(unchangedSamplePrompts(graph, classic)).toEqual([]);
  });

  it("names the negative prompt as one, and the prompt before the texts that are none", () => {
    const graph = classicTemplate();
    graph["0"] = { class_type: "Shader", inputs: { code: "void main() {}" } };
    expect(keyInputs(graph, classic)).toBe("prompt: 1.text, 0.code, 3.expression, 7.code; negative prompt: 2.text");
  });

  it("follows the text through the nodes that pass it on, and through nothing else", () => {
    const graph: ApiGraph = {
      "1": { class_type: "Text", inputs: { value: "a castle" } },
      "2": { class_type: "ComfySwitchNode", inputs: { switch: true, on_true: ["1", 0], on_false: "unused" } },
      "3": { class_type: "Encode", inputs: { prompt: ["2", 0], negative_prompt: "" } },
      "4": { class_type: "Save", inputs: { cond: ["3", 0] } },
    };
    markSamplePrompts(graph, classic);
    expect(unchangedSamplePrompts(graph, classic).map((sample) => sample.address)).toEqual(["1.value"]);
    // The expression's number reaches a node that gives conditioning; a number is not a prompt.
    const numbers = classicTemplate();
    markSamplePrompts(numbers, classic);
    expect(numbers["3"]!._meta).toBeUndefined();
  });

  it("counts a text as the prompt when any encoder it feeds is on the positive side", () => {
    const graph: ApiGraph = {
      "1": { class_type: "Text", inputs: { value: "a castle" } },
      "2": { class_type: "Encode", inputs: { prompt: ["1", 0], negative_prompt: "" } },
      "3": { class_type: "Encode", inputs: { prompt: ["1", 0], negative_prompt: "" } },
      "4": { class_type: "Sampler", inputs: { positive: ["2", 0], negative: ["3", 0] } },
      "5": { class_type: "Out", inputs: { latent: ["4", 0] } },
    };
    expect(keyInputs(graph, classic)).toBe("prompt: 1.value; negative prompt: 2.negative_prompt, 3.negative_prompt");
  });

  it("does not call a text negative when nothing takes its conditioning", () => {
    const probe: NodeCatalog = { ...classic, Probe: { output_node: true, input: { required: { text: ["STRING", { multiline: true }] } }, output: ["CONDITIONING"] } };
    expect(keyInputs({ p: { class_type: "Probe", inputs: { text: "a castle" } } }, probe)).toBe("prompt: p.text");
  });

  it("is written by setPrompt where the workflow keeps it, and nowhere else", () => {
    const graph = marked();
    // The second encoder's prompt box is empty, and still a place a prompt could go: it is taken out here.
    delete graph["5"];
    delete graph["6"];
    expect(setPrompt(graph, texts, "a cat on a sofa")).toBe("1.on_false");
    expect(graph["1"]!.inputs["on_false"]).toBe("a cat on a sofa");
    expect(graph["2"]!.inputs["negative_prompt"]).toBe("blurry");
    expect(unchangedSamplePrompts(graph, texts)).toEqual([]);
    const classicGraph = classicTemplate();
    expect(setPrompt(classicGraph, classic, "a tower")).toBe("1.text");
    expect(classicGraph["2"]!.inputs["text"]).toBe("blurry, low quality");
    expect(classicGraph["3"]!.inputs["expression"]).toBe("a * 2");
  });

  it("is not guessed by setPrompt among several, or where there is none", () => {
    const several = template();
    expect(() => setPrompt(several, texts, "a cat")).toThrow("prompt: this workflow has several prompt texts (1.on_false, 5.prompt): write the ones meant with set");
    expect(several["1"]!.inputs["on_false"]).toBe("Greyscale fashion portrait");
    const none: ApiGraph = { "7": { class_type: "Shader", inputs: { code: "void main() {}" } } };
    expect(() => setPrompt(none, classic, "a cat")).toThrow("prompt: this workflow has no prompt to set");
    expect(none["7"]!.inputs["code"]).toBe("void main() {}");
  });

  it("is not reported when one of several sample texts was changed", () => {
    const graph = template();
    graph["5"]!.inputs["prompt"] = "You write image prompts";
    markSamplePrompts(graph, texts);
    expect(unchangedSamplePrompts(graph, texts).map((sample) => sample.address)).toEqual(["1.on_false", "5.prompt"]);
    const changed = applyOperations(graph, [{ op: "set", node: "1.on_false", inputs: { text: "a cat" } }], texts).graph;
    expect(unchangedSamplePrompts(changed, texts)).toEqual([]);
  });
});

describe("naming a node", () => {
  it("splits after the longest id, so a colon in the id and a dot in the input both survive", () => {
    expect(resolveInputRef(workflow(), "459:7.format.bit_depth", "x")).toEqual({ id: "459:7", input: "format.bit_depth" });
    expect(resolveInputRef(workflow(), "459:7", "x")).toEqual({ id: "459:7" });
    expect(resolveInputRef(workflow(), "KSampler.seed", "x")).toEqual({ id: "459:7", input: "seed" });
  });

  it("takes a node written the way the tool lists it", () => {
    // The lab: `before: "5 SaveImage"`, copied from the tool's own list of nodes.
    const graph = workflow();
    expect(resolveNodeRef(graph, "9 SaveImageAdvanced", "x")).toBe("9");
    expect(resolveNodeRef(graph, '9 SaveImageAdvanced "Save Image (Advanced)"', "x")).toBe("9");
    expect(resolveNodeRef(graph, '9 "Save Image (Advanced)"', "x")).toBe("9");
    expect(resolveNodeRef(graph, "9 save image (advanced)", "x")).toBe("9");
    expect(resolveNodeRef(graph, "459:7 KSampler", "x")).toBe("459:7");
    expect(resolveInputRef(graph, "9 SaveImageAdvanced.images", "x")).toEqual({ id: "9", input: "images" });
    expect(resolveInputRef(graph, "9.SaveImageAdvanced", "x")).toEqual({ id: "9" });
    expect(resolveInputRef(graph, "9.Save Image (Advanced)", "x")).toEqual({ id: "9" });
  });

  it("does not take a listed node whose name is another node's", () => {
    expect(() => resolveNodeRef(workflow(), "9 KSampler", "x")).toThrow(/there is no node 9 KSampler/);
    expect(() => resolveNodeRef(workflow(), "77 SaveImageAdvanced", "x")).toThrow(/there is no node 77 SaveImageAdvanced/);
    expect(() => resolveNodeRef(workflow(), "9 SaveImageAdvanced extra", "x")).toThrow(/there is no node/);
  });

  it("keeps an input that is named like the node", () => {
    const graph: ApiGraph = { "1": { class_type: "Probe", inputs: { probe: 1 } } };
    expect(resolveInputRef(graph, "1.probe", "x")).toEqual({ id: "1", input: "probe" });
  });

  it("puts a stage before a node written the way the tool lists it", () => {
    const { graph } = applyOperations(workflow(), [{ op: "insert", class_type: "ImageScale", node: "up", before: "9 SaveImageAdvanced" }], catalog);
    expect(graph["9"]!.inputs["images"]).toEqual(["up", 0]);
    const dotted = applyOperations(workflow(), [{ op: "insert", class_type: "ImageScale", node: "up", before: "9.SaveImageAdvanced" }], catalog).graph;
    expect(dotted["9"]!.inputs["images"]).toEqual(["up", 0]);
  });

  it("takes part of a name only when one node has it", () => {
    const graph = workflow();
    expect(resolveNodeRef(graph, "SaveImage", "x")).toBe("9");
    expect(resolveNodeRef(graph, "save image", "x")).toBe("9");
    expect(() => resolveNodeRef(graph, "Prompt", "x")).toThrow(/fits 2 nodes/);
  });

  it("prefers an exact name over a part of a longer one", () => {
    const graph: ApiGraph = { "1": { class_type: "SaveImage", inputs: {} }, "2": { class_type: "SaveImageAdvanced", inputs: {} } };
    expect(resolveNodeRef(graph, "SaveImage", "x")).toBe("1");
  });

  it("does not guess from a number or a very short word", () => {
    const graph: ApiGraph = { "1": { class_type: "QwenImage21Cache", inputs: {} }, "2": { class_type: "Foo", inputs: {} } };
    expect(() => resolveNodeRef(graph, "21", "x")).toThrow(/there is no node 21/);
    expect(() => resolveNodeRef(graph, "wen", "x")).toThrow(/there is no node wen/);
  });
});

describe("removing a stage and putting another in its place", () => {
  // The official "Image Upscale: Traditional Interpolation" template: the scaled picture is saved and shown against the original.
  const upscaleCatalog: NodeCatalog = {
    ...catalog,
    LoadImage: { input: { required: { image: [["pray.png"], {}] } }, output: ["IMAGE", "MASK"] },
    ImageScaleBy: { input: { required: { image: ["IMAGE", {}], upscale_method: [["lanczos", "bicubic"], {}], scale_by: ["FLOAT", { default: 2 }] } }, output: ["IMAGE"] },
    SaveImage: { output_node: true, input: { required: { images: ["IMAGE", {}], filename_prefix: ["STRING", { default: "ComfyUI" }] } }, output: [] },
    ImageCompare: { output_node: true, input: { required: { image_a: ["IMAGE", {}], image_b: ["IMAGE", {}] } }, output: [] },
  };
  function upscaleTemplate(): ApiGraph {
    return {
      "2": { class_type: "LoadImage", inputs: { image: "pray.png" } },
      "3": { class_type: "ImageScaleBy", inputs: { image: ["2", 0], upscale_method: "lanczos", scale_by: 2 } },
      "5": { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "ComfyUI" } },
      "7": { class_type: "ImageCompare", inputs: { image_a: ["2", 0], image_b: ["3", 0] } },
    };
  }

  it("puts the new stage where the removed one was, with everything it fed", () => {
    // The operations as the lab's image_creator wrote them, invented loader id included.
    const { graph, notes } = applyOperations(upscaleTemplate(), [
      { op: "remove", node: "3" },
      { op: "add", class_type: "UpscaleModelLoader", inputs: { model_name: "RealESRGAN_x4plus.pth" } },
      { op: "insert", class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["13", 0] } },
    ], upscaleCatalog);
    expect(graph["9"]!.inputs).toEqual({ upscale_model: ["8", 0], image: ["2", 0] });
    expect(graph["5"]!.inputs["images"]).toEqual(["9", 0]);
    expect(graph["7"]!.inputs).toEqual({ image_a: ["2", 0], image_b: ["9", 0] });
    expect(notes).toContain("inserted 9 ImageUpscaleWithModel where 3 was (image<-2.0; gives 5.images, 7.image_b)");
    expect(checkGraph(graph, upscaleCatalog).errors).toEqual([]);
    expect(danglingNodes(graph, upscaleCatalog)).toEqual([]);
  });

  it("keeps the chain connected when only a node is removed", () => {
    const { graph, notes } = applyOperations(upscaleTemplate(), [{ op: "remove", node: "ImageScaleBy" }], upscaleCatalog);
    expect(graph["5"]!.inputs["images"]).toEqual(["2", 0]);
    expect(graph["7"]!.inputs).toEqual({ image_a: ["2", 0], image_b: ["2", 0] });
    expect(notes[0]).toBe("removed 3; 5.images, 7.image_b now get 2.0, which went into 3");
    expect(checkGraph(graph, upscaleCatalog).errors).toEqual([]);
  });

  it("cuts what it cannot pass on: a different type, or two inputs of the type", () => {
    const decoded = applyOperations(workflow(), [{ op: "remove", node: "VAEDecode" }], catalog);
    expect(decoded.notes[0]).toBe("removed 459:8; now unconnected: 9.images");
    const graph = upscaleTemplate();
    graph["4"] = { class_type: "ImageBlend", inputs: { image1: ["2", 0], image2: ["3", 0] } };
    graph["5"]!.inputs["images"] = ["4", 0];
    const blended = applyOperations(graph, [{ op: "remove", node: "4" }], upscaleCatalog);
    expect(blended.graph["5"]!.inputs["images"]).toBeUndefined();
    expect(blended.notes[0]).toBe("removed 4; now unconnected: 5.images");
  });

  it("follows a chain removed stage by stage to the place that is left", () => {
    const graph = upscaleTemplate();
    graph["4"] = { class_type: "ImageScaleBy", inputs: { image: ["3", 0], upscale_method: "bicubic", scale_by: 2 } };
    graph["5"]!.inputs["images"] = ["4", 0];
    delete graph["7"];
    const { graph: next } = applyOperations(graph, [
      { op: "remove", node: "3" },
      { op: "remove", node: "4" },
      { op: "insert", class_type: "ImageScale", node: "up" },
    ], upscaleCatalog);
    expect(next["up"]!.inputs["image"]).toEqual(["2", 0]);
    expect(next["5"]!.inputs["images"]).toEqual(["up", 0]);
  });

  it("feeds only what is still there and still waiting", () => {
    const { graph } = applyOperations(upscaleTemplate(), [
      { op: "remove", node: "3" },
      { op: "remove", node: "7" },
      { op: "insert", class_type: "ImageScale", node: "up" },
    ], upscaleCatalog);
    expect(graph["5"]!.inputs["images"]).toEqual(["up", 0]);
    expect(graph["7"]).toBeUndefined();
  });

  it("takes a stage whose input the caller wired, and moves the outputs to it", () => {
    const { graph, notes } = applyOperations(upscaleTemplate(), [
      { op: "remove", node: "3" },
      { op: "insert", class_type: "ImageScale", node: "up", inputs: { image: ["LoadImage", 0] } },
    ], upscaleCatalog);
    expect(graph["up"]!.inputs["image"]).toEqual(["2", 0]);
    expect(graph["5"]!.inputs["images"]).toEqual(["up", 0]);
    expect(graph["7"]!.inputs["image_b"]).toEqual(["up", 0]);
    expect(notes[1]).toBe("inserted up ImageScale where 3 was (gives 5.images, 7.image_b) (defaults for width)");
  });

  it("gives the removed node's input to the socket of its type, not to the first one free", () => {
    const { graph } = applyOperations(upscaleTemplate(), [
      { op: "remove", node: "3" },
      { op: "insert", class_type: "ImageUpscaleWithModel", node: "up" },
    ], upscaleCatalog);
    expect(graph["up"]!.inputs).toEqual({ image: ["2", 0] });
    expect(graph["5"]!.inputs["images"]).toEqual(["up", 0]);
  });

  it("does not fill a place with a stage that gives something else", () => {
    expect(() => applyOperations(upscaleTemplate(), [
      { op: "remove", node: "3" },
      { op: "insert", class_type: "ImageStats" },
    ], upscaleCatalog)).toThrow(/ImageStats fits in front of no output of this workflow/);
  });

  it("leaves an input that was given something else since", () => {
    const { graph } = applyOperations(upscaleTemplate(), [
      { op: "remove", node: "3" },
      { op: "set", node: "5", inputs: { images: ["2", 1] } },
      { op: "insert", class_type: "ImageScale", node: "up" },
    ], upscaleCatalog);
    expect(graph["5"]!.inputs["images"]).toEqual(["2", 1]);
    expect(graph["7"]!.inputs["image_b"]).toEqual(["up", 0]);
  });

  it("cuts what a switch passed on: which of its inputs was meant is not known", () => {
    const graph: ApiGraph = {
      "1": { class_type: "VAEDecode", inputs: { samples: ["2", 0] } },
      "2": { class_type: "KSampler", inputs: {} },
      "3": { class_type: "ComfySwitchNode", inputs: { switch: true, on_false: ["1", 0], on_true: "x" } },
      "4": { class_type: "SaveImageAdvanced", inputs: { images: ["3", 0], filename_prefix: "x" } },
    };
    expect(applyOperations(graph, [{ op: "remove", node: "3" }], catalog).notes[0]).toBe("removed 3; now unconnected: 4.images");
  });

  it("fills a place once", () => {
    expect(() => applyOperations(upscaleTemplate(), [
      { op: "remove", node: "3" },
      { op: "insert", class_type: "ImageScale" },
      { op: "insert", class_type: "ImageScale" },
    ], upscaleCatalog)).toThrow(/operation 3 \(insert\): ImageScale could go before several outputs/);
  });

  it("does not count a plain value in the socket as wiring it", () => {
    expect(() => applyOperations(upscaleTemplate(), [
      { op: "remove", node: "3" },
      { op: "insert", class_type: "ImageScale", inputs: { image: "photo.png" } },
    ], upscaleCatalog)).toThrow(/ImageScale fits in front of no output of this workflow/);
  });

  it("does not guess between two places left open", () => {
    const graph = upscaleTemplate();
    graph["6"] = { class_type: "ImageScaleBy", inputs: { image: ["2", 0], upscale_method: "bicubic", scale_by: 2 } };
    graph["7"]!.inputs["image_b"] = ["6", 0];
    expect(() => applyOperations(graph, [
      { op: "remove", node: "3" },
      { op: "remove", node: "6" },
      { op: "insert", class_type: "ImageScale" },
    ], upscaleCatalog)).toThrow(/could go before several outputs/);
  });

  it("takes the place named in before over the one left open", () => {
    const { graph } = applyOperations(upscaleTemplate(), [
      { op: "remove", node: "3" },
      { op: "insert", class_type: "ImageScale", node: "up", before: "5" },
    ], upscaleCatalog);
    expect(graph["5"]!.inputs["images"]).toEqual(["up", 0]);
    expect(graph["7"]!.inputs["image_b"]).toEqual(["2", 0]);
  });

  it("fills a place only with a stage of the type that flowed there", () => {
    const graph = workflow();
    graph["lora"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "a.safetensors", strength_model: 1 } };
    graph["459:7"]!.inputs["model"] = ["lora", 0];
    const swapped = applyOperations(graph, [
      { op: "remove", node: "lora" },
      { op: "insert", class_type: "LoraLoaderModelOnly", node: "other", inputs: { lora_name: "b.safetensors" } },
    ], catalog);
    expect(swapped.graph["459:7"]!.inputs["model"]).toEqual(["other", 0]);
    expect(swapped.graph["other"]!.inputs["model"]).toEqual(["1", 0]);
    expect(() => applyOperations(upscaleTemplate(), [
      { op: "remove", node: "3" },
      { op: "insert", class_type: "LoraLoaderModelOnly" },
    ], upscaleCatalog)).toThrow(/LoraLoaderModelOnly fits in front of no output of this workflow/);
  });

  it("forgets the place once the call is over", () => {
    const { graph } = applyOperations(upscaleTemplate(), [{ op: "remove", node: "3" }], upscaleCatalog);
    expect(() => applyOperations(graph, [{ op: "insert", class_type: "ImageScale" }], upscaleCatalog))
      .toThrow('could go before several outputs: before: "5" (SaveImage) or before: "7" (ImageCompare)');
  });
});
