import { describe, expect, it } from "vitest";
import {
  GraphOperationError,
  applyOperations,
  checkGraph,
  describeGraph,
  keyInputs,
  readPngWorkflow,
  seedInputs,
  toEditorWorkflow,
  type ApiGraph,
  type NodeCatalog,
} from "../multimodal/comfyui-graph.js";

// Shaped like a real /object_info: KSampler uses the legacy combo spelling ([[choices], {}]),
// UNETLoader the V3 one (["COMBO", {options}]).
const catalog: NodeCatalog = {
  UNETLoader: {
    name: "UNETLoader",
    category: "advanced/loaders",
    input: { required: { unet_name: ["COMBO", { options: ["qwen_image_2.1_int8_convrot.safetensors", "flux3-image-klein-int8-convrot.safetensors"] }] } },
    output: ["MODEL"],
    output_name: ["MODEL"],
  },
  CLIPTextEncode: {
    name: "CLIPTextEncode",
    category: "conditioning",
    input: { required: { text: ["STRING", { multiline: true }], clip: ["CLIP", {}] } },
    output: ["CONDITIONING"],
  },
  CLIPLoader: {
    name: "CLIPLoader",
    category: "advanced/loaders",
    input: { required: { clip_name: [["qwen3vl_8b_int8_convrot.safetensors"], {}], type: [["qwen_image", "flux3"], {}] } },
    output: ["CLIP"],
  },
  EmptyLatentImage: {
    name: "EmptyLatentImage",
    category: "latent",
    input: { required: { width: ["INT", { default: 1024, min: 16, max: 16384 }], height: ["INT", { default: 1024, min: 16, max: 16384 }], batch_size: ["INT", { default: 1, min: 1, max: 4096 }] } },
    output: ["LATENT"],
  },
  KSampler: {
    name: "KSampler",
    category: "sampling",
    input: {
      required: {
        model: ["MODEL", {}],
        seed: ["INT", { default: 0, min: 0, max: 18446744073709551615, control_after_generate: true }],
        steps: ["INT", { default: 20, min: 1, max: 10000 }],
        cfg: ["FLOAT", { default: 8, min: 0, max: 100 }],
        sampler_name: [["euler", "dpmpp_2m"], {}],
        scheduler: [["normal", "simple"], {}],
        positive: ["CONDITIONING", {}],
        negative: ["CONDITIONING", {}],
        latent_image: ["LATENT", {}],
        denoise: ["FLOAT", { default: 1, min: 0, max: 1 }],
      },
    },
    input_order: { required: ["model", "seed", "steps", "cfg", "sampler_name", "scheduler", "positive", "negative", "latent_image", "denoise"] },
    output: ["LATENT"],
  },
  VAEDecode: { name: "VAEDecode", category: "latent", input: { required: { samples: ["LATENT", {}], vae: ["VAE", {}] } }, output: ["IMAGE"] },
  VAELoader: { name: "VAELoader", category: "loaders", input: { required: { vae_name: [["qwen_image_2.1_vae_bf16.safetensors"], {}] } }, output: ["VAE"] },
  SaveImage: {
    name: "SaveImage",
    category: "image",
    output_node: true,
    input: { required: { images: ["IMAGE", {}], filename_prefix: ["STRING", { default: "ComfyUI" }] } },
    output: [],
  },
};

function txt2img(): ApiGraph {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_2.1_int8_convrot.safetensors" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_int8_convrot.safetensors", type: "qwen_image" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "a red fox in snow", clip: ["2", 0] } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] } },
    "6": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
    "7": {
      class_type: "KSampler",
      inputs: { model: ["1", 0], seed: 42, steps: 20, cfg: 1, sampler_name: "euler", scheduler: "simple", positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0], denoise: 1 },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "fox" } },
  };
}

describe("checkGraph", () => {
  it("passes a complete, consistent workflow", () => {
    expect(checkGraph(txt2img(), catalog)).toEqual({ errors: [], warnings: [] });
  });

  it("names the closest model file for a file this server does not have", () => {
    const graph = txt2img();
    graph["1"]!.inputs["unet_name"] = "qwen_image_2.1.safetensors";
    const { errors } = checkGraph(graph, catalog);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('node 1 (UNETLoader).unet_name: "qwen_image_2.1.safetensors" is not one of its choices');
    expect(errors[0]).toContain("closest: qwen_image_2.1_int8_convrot.safetensors");
  });

  it("names the loader that lists a model file given to the wrong one", () => {
    // The lab's image_creator wrote CheckpointLoaderSimple for the Qwen-Image DiT, a UNETLoader file.
    const withCheckpoints: NodeCatalog = {
      ...catalog,
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [[], {}] } }, output: ["MODEL", "CLIP", "VAE"] },
    };
    const graph = txt2img();
    graph["1"] = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "qwen_image_2.1_int8_convrot.safetensors" } };
    expect(checkGraph(graph, withCheckpoints).errors).toEqual([
      'node 1 (CheckpointLoaderSimple).ckpt_name: "qwen_image_2.1_int8_convrot.safetensors" is installed, but as a choice of UNETLoader.unet_name: load it with UNETLoader instead (a template for the model shows the loaders it needs)',
    ]);
  });

  it("reads choices in both combo spellings", () => {
    const graph = txt2img();
    graph["7"]!.inputs["sampler_name"] = "heun";
    expect(checkGraph(graph, catalog).errors.join("\n")).toContain('node 7 (KSampler).sampler_name: "heun" is not one of its choices (euler, dpmpp_2m)');
  });

  it("finds broken links: missing node, missing output, wrong type", () => {
    const graph = txt2img();
    graph["8"]!.inputs["vae"] = ["30", 0];
    graph["9"]!.inputs["images"] = ["8", 1];
    graph["7"]!.inputs["latent_image"] = ["4", 0];
    const { errors } = checkGraph(graph, catalog);
    expect(errors).toContain("node 8.vae links to node 30, which is not in the workflow");
    expect(errors).toContain("node 9.images links to output 1 of node 8 (VAEDecode), which has 1 output(s): 0 IMAGE");
    expect(errors).toContain("node 7.latent_image takes LATENT but output 0 of node 4 (CLIPTextEncode) gives CONDITIONING");
  });

  it("refuses a missing required input, a value where a link belongs, out-of-range numbers and an unknown type", () => {
    const graph = txt2img();
    delete graph["7"]!.inputs["steps"];
    graph["8"]!.inputs["samples"] = 3;
    graph["6"]!.inputs["width"] = 8;
    graph["10"] = { class_type: "KSamplr", inputs: {} };
    const { errors } = checkGraph(graph, catalog);
    expect(errors).toContain('node 7 (KSampler): required input "steps" is missing');
    expect(errors).toContain('node 8.samples takes a LATENT link like ["<node id>", <output index>], not a value');
    expect(errors).toContain("node 6 (EmptyLatentImage).width: 8 is below its minimum 16");
    expect(errors.find((e) => e.startsWith("node 10"))).toContain('no node type "KSamplr" (closest: KSampler');
  });

  it("says when nothing would be saved", () => {
    const graph = txt2img();
    delete graph["9"];
    expect(checkGraph(graph, catalog).errors).toContain("the workflow has no output node (e.g. SaveImage), so ComfyUI would run nothing");
  });

  it("only warns about an input the node type does not declare", () => {
    const graph = txt2img();
    graph["6"]!.inputs["colour"] = "red";
    expect(checkGraph(graph, catalog)).toEqual({ errors: [], warnings: ['node 6 (EmptyLatentImage): "colour" is not an input of this node type; ComfyUI ignores it'] });
  });
});

describe("applyOperations", () => {
  it("adds a node with defaults, wires it and leaves the original untouched", () => {
    const original = txt2img();
    const { graph, notes } = applyOperations(original, [
      { op: "add", class_type: "SaveImage", inputs: { images: ["8", 0] }, title: "Second copy" },
      { op: "set", node: "7", inputs: { steps: 30, seed: 7 } },
    ], catalog);
    expect(graph["10"]).toEqual({ class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["8", 0] }, _meta: { title: "Second copy" } });
    expect(graph["7"]!.inputs["steps"]).toBe(30);
    expect(original["7"]!.inputs["steps"]).toBe(20);
    expect(notes[0]).toBe("added 10 SaveImage (defaults for filename_prefix)");
    expect(checkGraph(graph, catalog).errors).toEqual([]);
  });

  it("removing a node reports the inputs it leaves unconnected", () => {
    const { graph, notes } = applyOperations(txt2img(), [{ op: "remove", node: "2" }], catalog);
    expect(graph["2"]).toBeUndefined();
    expect(notes[0]).toBe("removed 2; now unconnected: 4.clip, 5.clip");
    expect(checkGraph(graph, catalog).errors).toContain('node 4 (CLIPTextEncode): required input "clip" is missing');
  });

  it("names nodes by a type or title only one node has, in links too", () => {
    const { graph } = applyOperations(txt2img(), [
      { op: "add", node: "copy", class_type: "SaveImage", inputs: { images: ["VAEDecode", 0] } },
      { op: "set", node: "KSampler", inputs: { steps: 12 } },
    ], catalog);
    expect(graph["copy"]!.inputs["images"]).toEqual(["8", 0]);
    expect(graph["7"]!.inputs["steps"]).toBe(12);
    expect(() => applyOperations(txt2img(), [{ op: "set", node: "CLIPTextEncode", inputs: { text: "x" } }], catalog))
      .toThrow('operation 1 (set): "CLIPTextEncode" fits 2 nodes (4, 5); use the id');
  });

  it("null removes one input", () => {
    const { graph } = applyOperations(txt2img(), [{ op: "set", node: "9", inputs: { filename_prefix: null } }], catalog);
    expect(graph["9"]!.inputs).toEqual({ images: ["8", 0] });
  });

  it("stops the whole batch at the first operation that cannot apply", () => {
    const original = txt2img();
    expect(() => applyOperations(original, [
      { op: "set", node: "7", inputs: { steps: 30 } },
      { op: "set", node: "77", inputs: { steps: 30 } },
    ], catalog)).toThrow(new GraphOperationError("operation 2 (set): there is no node 77"));
    expect(() => applyOperations(original, [{ op: "add", class_type: "VAEDecoder" }], catalog)).toThrow(/no node type "VAEDecoder" \(closest: VAEDecode/);
    expect(original["7"]!.inputs["steps"]).toBe(20);
  });
});

describe("describeGraph", () => {
  it("writes one line per node with links as <-id.output", () => {
    const lines = describeGraph(txt2img()).split("\n");
    expect(lines).toHaveLength(9);
    expect(lines[6]).toBe('7 KSampler: model<-1.0, seed=42, steps=20, cfg=1, sampler_name="euler", scheduler="simple", positive<-4.0, negative<-5.0, latent_image<-6.0, denoise=1');
  });
});

describe("toEditorWorkflow", () => {
  const workflow = toEditorWorkflow(txt2img(), catalog) as {
    nodes: Array<{ id: number; type: string; pos: [number, number]; inputs: Array<{ name: string; link: number | null }>; outputs: Array<{ links: number[] }>; widgets_values: unknown[] }>;
    links: Array<[number, number, number, number, number, string]>;
    last_node_id: number;
    last_link_id: number;
  };
  const node = (id: number) => workflow.nodes.find((n) => n.id === id)!;

  it("keeps every link, and both ends of each agree", () => {
    expect(workflow.links).toHaveLength(9);
    expect(workflow.last_link_id).toBe(9);
    for (const [linkId, from, fromSlot, to, toSlot, type] of workflow.links) {
      expect(node(to).inputs[toSlot]!.link).toBe(linkId);
      expect(node(from).outputs[fromSlot]!.links).toContain(linkId);
      expect(typeof type).toBe("string");
    }
    // KSampler's sockets in the editor: model, positive, negative, latent_image -> slot 3
    expect(workflow.links.find((l) => l[3] === 7 && l[1] === 6)).toEqual([expect.any(Number), 6, 0, 7, 3, "LATENT"]);
  });

  it("writes widget values in the editor's order, with the seed fixed", () => {
    expect(node(7).widgets_values).toEqual([42, "fixed", 20, 1, "euler", "simple", 1]);
    expect(node(7).inputs.map((i) => i.name)).toEqual(["model", "positive", "negative", "latent_image"]);
    expect(node(9).widgets_values).toEqual(["fox"]);
  });

  it("lays nodes out left to right by depth", () => {
    expect(node(1).pos[0]).toBeLessThan(node(7).pos[0]);
    expect(node(7).pos[0]).toBeLessThan(node(8).pos[0]);
    expect(node(8).pos[0]).toBeLessThan(node(9).pos[0]);
    expect(node(4).pos[0]).toBe(node(5).pos[0]);
    expect(node(4).pos[1]).not.toBe(node(5).pos[1]);
  });

  it("gives ids that are not numbers numeric ones", () => {
    const graph: ApiGraph = {
      loader: { class_type: "VAELoader", inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" } },
      "3": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["loader", 0] } },
    };
    const converted = toEditorWorkflow(graph, catalog) as { nodes: Array<{ id: number; type: string }>; links: unknown[][] };
    expect(converted.nodes.map((n) => [n.id, n.type])).toEqual([[3, "VAEDecode"], [4, "VAELoader"]]);
    expect(converted.links).toContainEqual([expect.any(Number), 4, 0, 3, 1, "VAE"]);
  });
});

describe("keyInputs", () => {
  it("points at the prompt, seed, settings and model files of the nodes that run", () => {
    expect(keyInputs(txt2img(), catalog)).toBe(
      "prompt: 4.text, 5.text; seed: 7.seed; settings: 6.width, 6.height, 6.batch_size, 7.steps; model files: 1.unet_name, 2.clip_name, 3.vae_name",
    );
  });
});

describe("seedInputs", () => {
  it("finds the inputs the editor would re-roll", () => {
    expect(seedInputs(txt2img(), catalog)).toEqual([{ node: "7", input: "seed", max: Number.MAX_SAFE_INTEGER }]);
  });
});

describe("readPngWorkflow", () => {
  function chunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  }

  it("reads the prompt and workflow records ComfyUI writes", () => {
    const png = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      chunk("IHDR", Buffer.alloc(13)),
      chunk("tEXt", Buffer.from(`prompt\0${JSON.stringify(txt2img())}`, "latin1")),
      chunk("iTXt", Buffer.concat([Buffer.from("workflow\0\0\0\0\0", "latin1"), Buffer.from(JSON.stringify({ nodes: [], links: [] }), "utf8")])),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(readPngWorkflow(png)).toEqual({ prompt: txt2img(), workflow: { nodes: [], links: [] } });
  });

  it("returns nothing for a file that is not a PNG or carries no record", () => {
    expect(readPngWorkflow(Buffer.from("not a png"))).toEqual({});
    expect(readPngWorkflow(Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IEND", Buffer.alloc(0))]))).toEqual({});
  });
});
