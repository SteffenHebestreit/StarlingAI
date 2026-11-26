/**
 * A PICTURE MADE LARGER BY AN UPSCALING MODEL, ON THE COMFYUI SERVER.
 *
 * An edit of a phone photo is drawn at about one megapixel and the changed regions are laid back
 * onto the full-size original (image-edit-composite.ts). Scaled up by interpolation, a patch is
 * three to four times softer than the photo around it: the car taken out of a 4000x3000 picture
 * left pavement that looked out of focus. An upscaling model (Real-ESRGAN and its kin) draws the
 * detail back in. Measured on this stack's ComfyUI: a 640x480 crop came back 2560x1920 in 2.9 s,
 * 1000x750 came back 4000x3000 in 6.2 s, against the ~150 s the edit itself takes.
 *
 * Optional by design: without ComfyUI, without an upscaling model, or when the server does not
 * answer in time, there is no upscale and the caller interpolates as before.
 */
import { childLogger } from "../logger.js";
import {
  comfyUiEndpoint,
  fetchOutput,
  listModels,
  submitGraph,
  uploadInputImage,
  waitForRun,
  type ComfyUiEndpoint,
} from "./comfyui-client.js";

const log = childLogger("multimodal:comfyui-upscale");

const UPSCALE_MODEL_FOLDER = "upscale_models";
/** How long a looked-up model name is trusted, and how long a server with none (or no answer) is left alone. */
const MODEL_KNOWN_MS = 10 * 60_000;
const MODEL_MISSING_MS = 60_000;
/** The whole upscale, upload to download; past it the caller interpolates. */
export const UPSCALE_TIMEOUT_MS = 60_000;
/** One input file, overwritten each time: the runs below are one at a time, and ComfyUI's input folder does not fill up. */
const INPUT_FOLDER = "starlingai";
const INPUT_NAME = "edit-patch.png";

let modelLookup: { baseUrl: string; model: string | null; until: number } | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** The upscaling model to use: the one that enlarges most by its name (x4 before x2), else the first. */
async function upscaleModel(endpoint: ComfyUiEndpoint): Promise<string | null> {
  if (modelLookup && modelLookup.baseUrl === endpoint.baseUrl && Date.now() < modelLookup.until) return modelLookup.model;
  const models = await listModels(endpoint, UPSCALE_MODEL_FOLDER).catch(() => [] as string[]);
  // "RealESRGAN_x4plus", "4x-UltraSharp", "ESRGAN_2x": the factor is the digit beside the x.
  const factor = (name: string) => {
    const match = /(\d)x|x(\d)/i.exec(name);
    return Number(match?.[1] ?? match?.[2] ?? 0);
  };
  const model = [...models].sort((a, b) => factor(b) - factor(a))[0] ?? null;
  modelLookup = { baseUrl: endpoint.baseUrl, model, until: Date.now() + (model ? MODEL_KNOWN_MS : MODEL_MISSING_MS) };
  return model;
}

async function upscaleOnce(endpoint: ComfyUiEndpoint, png: Buffer, timeoutMs: number): Promise<Buffer | undefined> {
  const model = await upscaleModel(endpoint);
  if (!model) return undefined;
  const image = await uploadInputImage(endpoint, png, INPUT_NAME, INPUT_FOLDER);
  const { promptId } = await submitGraph(endpoint, {
    load: { class_type: "LoadImage", inputs: { image } },
    model: { class_type: "UpscaleModelLoader", inputs: { model_name: model } },
    upscale: { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["model", 0], image: ["load", 0] } },
    // A preview lands in ComfyUI's temp folder, which it clears itself; nothing is kept in its outputs.
    preview: { class_type: "PreviewImage", inputs: { images: ["upscale", 0] } },
  });
  const run = await waitForRun(endpoint, promptId, timeoutMs, 500);
  const picture = run.outputs.find((output) => output.kind === "images") ?? run.outputs[0];
  if (!picture) return undefined;
  return (await fetchOutput(endpoint, picture)).bytes;
}

/**
 * `png` enlarged by the server's upscaling model (by the model's own factor, usually 4), or
 * undefined when there is no ComfyUI, no upscaling model, or no answer within `timeoutMs`.
 * Never throws.
 */
export async function upscaleWithComfyModel(png: Buffer, timeoutMs = UPSCALE_TIMEOUT_MS): Promise<Buffer | undefined> {
  const endpoint = comfyUiEndpoint();
  if (!endpoint) return undefined;
  const started = Date.now();
  const turn = queue.then(async () => {
    const left = timeoutMs - (Date.now() - started);
    if (left <= 0) return undefined;
    let timer: NodeJS.Timeout | undefined;
    // A little past the run's own limit, so waitForRun can take the run out of ComfyUI's queue first.
    const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), left + Math.min(5_000, left)); });
    try {
      return await Promise.race([upscaleOnce(endpoint, png, left), late]);
    } finally {
      clearTimeout(timer);
    }
  });
  queue = turn.catch(() => undefined);
  try {
    const bytes = await turn;
    log.debug({ ms: Date.now() - started, upscaled: Boolean(bytes) }, "Edit patch upscale");
    return bytes;
  } catch (error) {
    log.warn({ err: error, ms: Date.now() - started }, "Upscaling the edit patch on ComfyUI failed; interpolating instead");
    return undefined;
  }
}

/** For tests: forget the model looked up. */
export function resetUpscaleModelLookupForTests(): void {
  modelLookup = undefined;
}
