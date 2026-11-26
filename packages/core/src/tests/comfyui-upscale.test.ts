/**
 * THE EDIT PATCH'S UPSCALE ON COMFYUI: OPTIONAL, BOUNDED, NEVER A FAILURE.
 *
 * An edit's changed region is enlarged by the server's upscaling model when there is one
 * (image-edit-composite.ts). Without ComfyUI, without a model, or with a server that errors, the
 * caller gets nothing back and interpolates; the edit itself never fails on it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  endpoint: null as null | { baseUrl: string; editorUrl: string; runTimeoutMs: number },
  listModels: vi.fn(),
  uploadInputImage: vi.fn(),
  submitGraph: vi.fn(),
  waitForRun: vi.fn(),
  fetchOutput: vi.fn(),
}));

vi.mock("../multimodal/comfyui-client.js", () => ({
  comfyUiEndpoint: () => client.endpoint,
  listModels: client.listModels,
  uploadInputImage: client.uploadInputImage,
  submitGraph: client.submitGraph,
  waitForRun: client.waitForRun,
  fetchOutput: client.fetchOutput,
}));

const { upscaleWithComfyModel, resetUpscaleModelLookupForTests } = await import("../multimodal/comfyui-upscale.js");

const PATCH = Buffer.from("patch-png");
const ENLARGED = Buffer.from("enlarged-png");

beforeEach(() => {
  resetUpscaleModelLookupForTests();
  client.endpoint = { baseUrl: "http://comfy.test:8188", editorUrl: "", runTimeoutMs: 900_000 };
  for (const mock of [client.listModels, client.uploadInputImage, client.submitGraph, client.waitForRun, client.fetchOutput]) mock.mockReset();
  client.listModels.mockResolvedValue(["RealESRGAN_x2plus.pth", "RealESRGAN_x4plus.pth"]);
  client.uploadInputImage.mockResolvedValue("starlingai/edit-patch.png");
  client.submitGraph.mockResolvedValue({ promptId: "p1", skipped: [] });
  client.waitForRun.mockResolvedValue({ outputs: [{ nodeId: "preview", kind: "images", filename: "x.png", subfolder: "", type: "temp" }], texts: {}, cached: [] });
  client.fetchOutput.mockResolvedValue({ bytes: ENLARGED, contentType: "image/png" });
});

describe("upscaleWithComfyModel", () => {
  it("enlarges by the model that enlarges most, through a graph that keeps nothing in ComfyUI's outputs", async () => {
    expect(await upscaleWithComfyModel(PATCH)).toBe(ENLARGED);

    expect(client.uploadInputImage).toHaveBeenCalledWith(client.endpoint, PATCH, "edit-patch.png", "starlingai");
    const graph = client.submitGraph.mock.calls[0]![1] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    expect(graph["model"]!.inputs["model_name"]).toBe("RealESRGAN_x4plus.pth");
    expect(Object.values(graph).map((node) => node.class_type)).toEqual(["LoadImage", "UpscaleModelLoader", "ImageUpscaleWithModel", "PreviewImage"]);
  });

  it("gives nothing without ComfyUI, and asks it nothing", async () => {
    client.endpoint = null;

    expect(await upscaleWithComfyModel(PATCH)).toBeUndefined();
    expect(client.listModels).not.toHaveBeenCalled();
  });

  it("gives nothing when the server has no upscaling model, and does not ask again for a while", async () => {
    client.listModels.mockResolvedValue([]);

    expect(await upscaleWithComfyModel(PATCH)).toBeUndefined();
    expect(await upscaleWithComfyModel(PATCH)).toBeUndefined();
    expect(client.listModels).toHaveBeenCalledTimes(1);
    expect(client.submitGraph).not.toHaveBeenCalled();
  });

  it("gives nothing, instead of failing, when the run fails", async () => {
    client.waitForRun.mockRejectedValue(new Error("The workflow failed: node upscale (ImageUpscaleWithModel) failed: out of memory"));

    expect(await upscaleWithComfyModel(PATCH)).toBeUndefined();
  });

  it("gives nothing once its time is up, however long the server takes", async () => {
    client.waitForRun.mockImplementation(() => new Promise(() => { /* never answers */ }));
    const started = Date.now();

    expect(await upscaleWithComfyModel(PATCH, 50)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);
});
