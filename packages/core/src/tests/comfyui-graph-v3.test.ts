import { describe, expect, it } from "vitest";
import {
  applySubgraphWidgetValues,
  checkGraph,
  graphDifferences,
  nodeInputs,
  runnableGraph,
  toEditorWorkflow,
  type ApiGraph,
  type NodeCatalog,
} from "../multimodal/comfyui-graph.js";

// ComfyUI's V3 inputs and a few classic nodes, shaped like the live /object_info of v0.44.
const v3: NodeCatalog = {
  EmptyLatentImage: {
    input: { required: { width: ["INT", { default: 1024, min: 16, max: 16384 }], height: ["INT", { default: 1024, min: 16, max: 16384 }], batch_size: ["INT", { default: 1, min: 1, max: 4096 }] } },
    output: ["LATENT"],
  },
  VAELoader: { input: { required: { vae_name: [["qwen_image_2.1_vae_bf16.safetensors"], {}] } }, output: ["VAE"] },
  VAEDecode: { input: { required: { samples: ["LATENT", {}], vae: ["VAE", {}] } }, output: ["IMAGE"] },
  CLIPLoader: { input: { required: { clip_name: [["qwen3vl_8b_int8_convrot.safetensors"], {}], type: [["qwen_image"], {}] } }, output: ["CLIP"] },
  CLIPTextEncode: { input: { required: { text: ["STRING", { multiline: true }], clip: ["CLIP", {}] } }, output: ["CONDITIONING"] },
  SaveImageAdvanced: {
    output_node: true,
    input: {
      required: {
        images: ["IMAGE", {}],
        filename_prefix: ["STRING", { default: "ComfyUI" }],
        format: ["COMFY_DYNAMICCOMBO_V3", { options: [
          { key: "png", inputs: { required: { bit_depth: ["COMBO", { default: "8-bit", options: ["8-bit", "16-bit"] }] } } },
          { key: "webp", inputs: { required: { quality: ["INT", { default: 90, min: 1, max: 100 }] } } },
        ] }],
      },
    },
    output: [],
  },
  BatchImagesNode: {
    input: { required: { images: ["COMFY_AUTOGROW_V3", { template: { input: { required: { image: ["IMAGE", {}] } }, prefix: "image", min: 1, max: 50 } }] } },
    output: ["IMAGE"],
  },
  ReferenceMultiLatent: {
    input: { optional: { images: ["COMFY_AUTOGROW_V3", { template: { input: { required: {}, optional: { image: ["IMAGE", {}] } }, prefix: "image", min: 1, max: 100 } }] } },
    output: ["LATENT"],
  },
  ComfySwitchNode: {
    input: {
      required: { switch: ["BOOLEAN", {}] },
      optional: { on_false: ["COMFY_MATCHTYPE_V3", { lazy: true }], on_true: ["COMFY_MATCHTYPE_V3", { lazy: true }] },
    },
    input_order: { required: ["switch"], optional: ["on_false", "on_true"] },
    output: ["*"],
  },
  PreviewAny: { output_node: true, input: { required: { source: ["*", {}] } }, output: [] },
  ImageCompare: {
    output_node: true,
    input: { required: { compare_view: ["IMAGECOMPARE", { socketless: true }] }, optional: { image_a: ["IMAGE", {}], image_b: ["IMAGE", {}] } },
    output: [],
  },
  SaveVideo: {
    output_node: true,
    input: {
      required: { video: ["VIDEO", {}], filename_prefix: ["STRING", { default: "video/ComfyUI" }] },
      optional: { codec: ["COMFY_DYNAMICCOMBO_V3", { hidden: true, options: [{ key: "auto", inputs: { required: {} } }] }] },
    },
    output: [],
  },
  PrimitiveStringMultiline: { input: { required: { value: ["STRING", { multiline: true }] } }, output: ["STRING"] },
};

describe("V3 inputs", () => {
  it("a dynamic combo's choice brings its own sub-inputs", () => {
    const names = (values?: Record<string, unknown>) => nodeInputs(v3["SaveImageAdvanced"]!, values).map((i) => `${i.name}:${i.type}`);
    expect(names()).toEqual(["images:IMAGE", "filename_prefix:STRING", "format:COMBO", "format.bit_depth:COMBO"]);
    expect(names({ format: "webp" })).toEqual(["images:IMAGE", "filename_prefix:STRING", "format:COMBO", "format.quality:INT"]);
  });

  it("a growing list is numbered after its prefix from 0, its slot found under required or optional", () => {
    expect(nodeInputs(v3["BatchImagesNode"]!).slice(0, 2).map((i) => [i.name, i.required])).toEqual([["images.image0", true], ["images.image1", false]]);
    expect(nodeInputs(v3["ReferenceMultiLatent"]!)[0]!.name).toBe("images.image0");
  });

  it("leaves out an input the node type hides", () => {
    expect(nodeInputs(v3["SaveVideo"]!).map((i) => i.name)).toEqual(["video", "filename_prefix"]);
  });

  it("checks V3 nodes without false alarms, and still catches a wrong sub-value", () => {
    const graph: ApiGraph = {
      "1": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" } },
      "2": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["1", 0] } },
      "9": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
      "3": { class_type: "BatchImagesNode", inputs: { "images.image0": ["2", 0] } },
      "4": { class_type: "SaveImageAdvanced", inputs: { images: ["3", 0], filename_prefix: "x", format: "png", "format.bit_depth": "16-bit" } },
      "5": { class_type: "ComfySwitchNode", inputs: { switch: false, on_false: "a prompt typed on the subgraph" } },
      "6": { class_type: "PreviewAny", inputs: { source: ["5", 0] } },
    };
    expect(checkGraph(graph, v3)).toEqual({ errors: [], warnings: [] });
    graph["4"]!.inputs["format.bit_depth"] = "12-bit";
    expect(checkGraph(graph, v3).errors).toEqual(['node 4 (SaveImageAdvanced).format.bit_depth: "12-bit" is not one of its choices (8-bit, 16-bit)']);
  });
});

describe("applySubgraphWidgetValues", () => {
  // A subgraph node as the official templates save it: widgets_values holds one value per WIDGET
  // input of the subgraph, in its order; the IMAGE input has none.
  const editor = {
    nodes: [
      { id: 459, type: "sg-1", inputs: [{ name: "picture", link: 12 }, { name: "prompt", widget: { name: "prompt" }, link: null }], widgets_values: ["a lighthouse", 7, false] },
    ],
    definitions: {
      subgraphs: [{
        id: "sg-1",
        inputs: [
          { name: "picture", type: "IMAGE", linkIds: [1] },
          { name: "prompt", type: "STRING", linkIds: [2, 3] },
          { name: "seed", type: "INT", linkIds: [4] },
          { name: "switch", type: "BOOLEAN", linkIds: [5] },
        ],
        links: [
          { id: 1, origin_id: -10, target_id: 10, target_slot: 0 },
          { id: 2, origin_id: -10, target_id: 20, target_slot: 1 },
          { id: 3, origin_id: -10, target_id: 30, target_slot: 0 },
          { id: 4, origin_id: -10, target_id: 40, target_slot: 1 },
          { id: 5, origin_id: -10, target_id: 20, target_slot: 0 },
        ],
        nodes: [
          { id: 10, type: "ImageScale", inputs: [{ name: "image", link: 1 }] },
          { id: 20, type: "ComfySwitchNode", inputs: [{ name: "switch", widget: { name: "switch" }, link: 5 }, { name: "on_false", link: 2 }] },
          { id: 30, type: "TextGenerate", inputs: [{ name: "prompt", widget: { name: "prompt" }, link: 3 }] },
          { id: 40, type: "KSampler", inputs: [{ name: "model", link: null }, { name: "seed", widget: { name: "seed" }, link: 4 }] },
        ],
      }],
    },
  };

  it("fills each inner input from the value typed on the subgraph's node, counting widget inputs only", () => {
    const graph: ApiGraph = {
      "459:20": { class_type: "ComfySwitchNode", inputs: { switch: true } },
      "459:30": { class_type: "TextGenerate", inputs: { prompt: "" } },
      "459:40": { class_type: "KSampler", inputs: { seed: 0 } },
      "459:10": { class_type: "ImageScale", inputs: { image: ["5", 0] } },
    };
    const filled = applySubgraphWidgetValues(editor, graph);
    expect(graph["459:20"]!.inputs).toEqual({ switch: false, on_false: "a lighthouse" });
    expect(graph["459:30"]!.inputs["prompt"]).toBe("a lighthouse");
    expect(graph["459:40"]!.inputs["seed"]).toBe(7);
    expect(graph["459:10"]!.inputs["image"]).toEqual(["5", 0]);
    expect(filled).toEqual(["459:20.on_false", "459:30.prompt", "459:40.seed", "459:20.switch"]);
  });

  it("leaves an input alone that the subgraph's node receives by link", () => {
    const linked = structuredClone(editor);
    linked.nodes[0]!.inputs[1]!.link = 99;
    const graph: ApiGraph = { "459:30": { class_type: "TextGenerate", inputs: { prompt: ["7", 0] } } };
    applySubgraphWidgetValues(linked, graph);
    expect(graph["459:30"]!.inputs["prompt"]).toEqual(["7", 0]);
  });
});

describe("runnableGraph", () => {
  const graph: ApiGraph = {
    "1": { class_type: "CLIPLoader", inputs: { clip_name: "a 9 GB enhancer nobody installed", type: "qwen_image" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "rewrite this", clip: ["1", 0] } },
    "3": { class_type: "ComfySwitchNode", inputs: { switch: false, on_true: ["2", 0], on_false: "the user's prompt" } },
    "4": { class_type: "PreviewAny", inputs: { source: ["3", 0] } },
    "5": { class_type: "ImageCompare", inputs: { image_a: ["6", 0] } },
    "6": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["8", 0] } },
    "7": { class_type: "EmptyLatentImage", inputs: { width: 64, height: 64, batch_size: 1 } },
    "8": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" } },
  };

  it("runs only the branch a fixed switch picks, and drops what no output needs", () => {
    const { graph: runnable, skipped } = runnableGraph(graph, v3);
    expect(runnable["4"]!.inputs["source"]).toBe("the user's prompt");
    expect(Object.keys(runnable).sort()).toEqual(["4", "5", "6", "7", "8"]);
    expect(skipped).toEqual(["switch 3 (off) resolved", "2 node(s) no output uses: 1 CLIPLoader, 2 CLIPTextEncode"]);
    expect(graph["3"]).toBeDefined();
    expect(checkGraph(runnable, v3).errors).toEqual([]);
  });

  it("follows a switch that is on, and gives an editor-drawn required input a value", () => {
    const on = structuredClone(graph);
    on["3"]!.inputs["switch"] = true;
    const { graph: runnable } = runnableGraph(on, v3);
    expect(runnable["4"]!.inputs["source"]).toEqual(["2", 0]);
    expect(runnable["1"]).toBeDefined();
    expect(runnable["5"]!.inputs["compare_view"]).toBe("");
  });
});

describe("the editor export", () => {
  it("a plain value on a socket survives as a Primitive node, and the read-back compares equal", () => {
    const graph: ApiGraph = {
      "3": { class_type: "ComfySwitchNode", inputs: { switch: false, on_false: "the prompt" } },
      "4": { class_type: "PreviewAny", inputs: { source: ["3", 0] } },
    };
    const editor = toEditorWorkflow(graph, v3) as { nodes: Array<{ type: string; widgets_values: unknown[] }> };
    expect(editor.nodes.find((n) => n.type === "PrimitiveStringMultiline")?.widgets_values).toEqual(["the prompt"]);
    // What the server makes of that copy: the same workflow, with the value behind a Primitive.
    const readBack: ApiGraph = {
      "1": { class_type: "ComfySwitchNode", inputs: { switch: false, on_false: ["9", 0] } },
      "2": { class_type: "PreviewAny", inputs: { source: ["1", 0] } },
      "9": { class_type: "PrimitiveStringMultiline", inputs: { value: "the prompt" } },
    };
    expect(graphDifferences(graph, readBack, v3)).toEqual([]);
    readBack["9"]!.inputs["value"] = "another prompt";
    expect(graphDifferences(graph, readBack, v3)).toEqual([
      'only in the workflow: ComfySwitchNode {"on_false":"the prompt","switch":false}',
      'only in the editor copy: ComfySwitchNode {"on_false":"another prompt","switch":false}',
    ]);
  });

  it("writes a dynamic combo's sub-values right after its choice, and no socket for an editor-drawn input", () => {
    const graph: ApiGraph = {
      "1": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" } },
      "2": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["1", 0] } },
      "3": { class_type: "EmptyLatentImage", inputs: { width: 64, height: 64, batch_size: 1 } },
      "4": { class_type: "SaveImageAdvanced", inputs: { images: ["2", 0], filename_prefix: "x", format: "webp", "format.quality": 80 } },
      "5": { class_type: "ImageCompare", inputs: { image_a: ["2", 0] } },
    };
    const editor = toEditorWorkflow(graph, v3) as { nodes: Array<{ type: string; widgets_values: unknown[]; inputs: Array<{ name: string }> }> };
    expect(editor.nodes.find((n) => n.type === "SaveImageAdvanced")?.widgets_values).toEqual(["x", "webp", 80]);
    expect(editor.nodes.find((n) => n.type === "ImageCompare")?.inputs.map((i) => i.name)).toEqual(["image_a", "image_b"]);
  });
});
