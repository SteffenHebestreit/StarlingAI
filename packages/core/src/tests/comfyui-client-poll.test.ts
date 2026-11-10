import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForRun, type ComfyUiEndpoint } from "../multimodal/comfyui-client.js";

/**
 * Polling a run while ComfyUI works. A heavy job starves its HTTP side: a 4992x3328 upscale on a
 * full GPU answered no /history poll for over two minutes, the tool reported the run as failed,
 * and the picture was done four minutes later.
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

  it("waits through silence however long, while the run's own time allows", async () => {
    const fetchMock = stub([...Array.from({ length: 30 }, () => "hang" as const), "done" as const]);
    const outcome = await wait();
    expect(outcome.outputs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(31);
  });

  it("ends with the run's time limit, not before, when ComfyUI stays silent", async () => {
    const fetchMock = stub(["hang"]);
    const started = Date.now();
    await expect(waitForRun(endpoint, "p1", 600, 1, 5)).rejects.toThrow("The workflow did not finish within 1 s and was cancelled in ComfyUI");
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    // Past the eight unanswered polls that used to end the wait (timers here are coarse, so only a floor).
    const polls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/history/")).length;
    expect(polls).toBeGreaterThan(8);
  });

  it("stops at once when ComfyUI is gone", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const fetchMock = vi.fn(async () => {
      throw refused;
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(waitForRun(endpoint, "p1", 300, 1, 5)).rejects.toThrow(/cannot be reached/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
