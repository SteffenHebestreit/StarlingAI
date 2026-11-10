import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForRun, type ComfyUiEndpoint } from "../multimodal/comfyui-client.js";

/**
 * Polling a run while ComfyUI works. A heavy upscale starves its HTTP side: in the lab one /history
 * poll took over 15 s, the tool reported the run as failed, and the 4096x4096 picture was already
 * being written.
 */

const endpoint: ComfyUiEndpoint = { baseUrl: "http://comfyui:8188", editorUrl: "", runTimeoutMs: 20_000 };

const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const finished = reply.bind(null, { p1: { status: { status_str: "success", completed: true, messages: [] }, outputs: { "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] } } } });
const stillRunning = reply.bind(null, {});
const noAnswer = (init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));

function stub(steps: Array<"hang" | "running" | "done">) {
  let index = 0;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const step = steps[Math.min(index++, steps.length - 1)];
    if (step === "hang") return noAnswer(init);
    return step === "done" ? finished() : stillRunning();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const wait = () => waitForRun(endpoint, "p1", 20_000, 1, 5);

describe("waitForRun", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("waits through polls ComfyUI is too busy to answer", async () => {
    const fetchMock = stub(["hang", "hang", "done"]);
    const outcome = await wait();
    expect(outcome.outputs.map((output) => output.filename)).toEqual(["a.png"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up when ComfyUI stays silent", async () => {
    const fetchMock = stub(["hang"]);
    await expect(wait()).rejects.toThrow(/did not answer/);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("counts only silence in a row", async () => {
    const steps = [...Array.from({ length: 7 }, () => "hang" as const), "running" as const, ...Array.from({ length: 7 }, () => "hang" as const), "done" as const];
    const fetchMock = stub(steps);
    const outcome = await wait();
    expect(outcome.outputs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(16);
  });

  it("stops at once when ComfyUI is gone", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const fetchMock = vi.fn(async () => {
      throw refused;
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(wait()).rejects.toThrow(/cannot be reached/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
