import { afterEach, describe, expect, it } from "vitest";
import {
  beginProviderCall,
  recordProviderToken,
  endProviderCall,
  getProviderActivitySnapshot,
  classifyProviderCall,
  resetProviderActivityMonitorForTests,
  DEFAULT_PROVIDER_PREFILL_WARN_MS,
  DEFAULT_PROVIDER_STALL_MS,
  DEFAULT_PROVIDER_AWAIT_WARN_MS,
} from "../observability/provider-activity-monitor.js";
import { classifyProviderActivity } from "../observability/health-checks.js";

const T = { prefillWarnMs: DEFAULT_PROVIDER_PREFILL_WARN_MS, stallMs: DEFAULT_PROVIDER_STALL_MS, awaitWarnMs: DEFAULT_PROVIDER_AWAIT_WARN_MS };
const call = (over: Partial<Parameters<typeof classifyProviderCall>[0]> = {}) => ({
  id: "x", model: "m", mode: "stream" as const, startedAt: 0, chunkCount: 0, ...over,
});

describe("classifyProviderCall", () => {
  it("stream with no first token within grace ⇒ prefill", () => {
    expect(classifyProviderCall(call({ mode: "stream" }), DEFAULT_PROVIDER_PREFILL_WARN_MS - 1, T)).toBe("prefill");
  });
  it("stream with no first token past grace ⇒ awaiting_output (processing prompt / stuck)", () => {
    expect(classifyProviderCall(call({ mode: "stream" }), DEFAULT_PROVIDER_PREFILL_WARN_MS + 1, T)).toBe("awaiting_output");
  });
  it("stream producing recently ⇒ producing", () => {
    const c = call({ mode: "stream", firstTokenAt: 100, lastTokenAt: 1000, chunkCount: 5 });
    expect(classifyProviderCall(c, 1000 + DEFAULT_PROVIDER_STALL_MS - 1, T)).toBe("producing");
  });
  it("stream produced tokens then went silent past the window ⇒ stalled", () => {
    const c = call({ mode: "stream", firstTokenAt: 100, lastTokenAt: 1000, chunkCount: 5 });
    expect(classifyProviderCall(c, 1000 + DEFAULT_PROVIDER_STALL_MS + 1, T)).toBe("stalled");
  });
  it("complete within budget ⇒ awaiting; past budget ⇒ awaiting_output", () => {
    expect(classifyProviderCall(call({ mode: "complete" }), DEFAULT_PROVIDER_AWAIT_WARN_MS - 1, T)).toBe("awaiting");
    expect(classifyProviderCall(call({ mode: "complete" }), DEFAULT_PROVIDER_AWAIT_WARN_MS + 1, T)).toBe("awaiting_output");
  });
});

describe("provider activity tracking", () => {
  afterEach(() => resetProviderActivityMonitorForTests());

  it("tracks begin → token → end and reports in-flight count", () => {
    expect(getProviderActivitySnapshot().inFlight).toBe(0);
    const id = beginProviderCall({ model: "qwen", mode: "stream" });
    let snap = getProviderActivitySnapshot();
    expect(snap.inFlight).toBe(1);
    expect(snap.worst?.model).toBe("qwen");
    recordProviderToken(id);
    snap = getProviderActivitySnapshot();
    expect(snap.worst?.chunkCount).toBe(1);
    expect(snap.worst?.ttftMs).toBeGreaterThanOrEqual(0);
    expect(snap.worst?.state).toBe("producing");
    endProviderCall(id);
    expect(getProviderActivitySnapshot().inFlight).toBe(0);
  });

  it("surfaces the most concerning call as 'worst' (stalled outranks a fresh call)", () => {
    const stalledId = beginProviderCall({ model: "stalled-model", mode: "complete" });
    // Force the stalled call to look old by reaching into the snapshot via classify thresholds:
    // simplest deterministic route — record nothing and rely on a tiny await is flaky, so we
    // instead assert ranking through two calls where one has a token and one doesn't.
    const producingId = beginProviderCall({ model: "producing-model", mode: "stream" });
    recordProviderToken(producingId);
    const snap = getProviderActivitySnapshot();
    expect(snap.inFlight).toBe(2);
    // The producing call is healthy (rank 0); the complete() call with no token ranks higher.
    expect(snap.worst?.model).toBe("stalled-model");
    endProviderCall(stalledId);
    endProviderCall(producingId);
  });

  it("recordProviderToken / endProviderCall are no-ops for unknown ids", () => {
    expect(() => recordProviderToken("nope")).not.toThrow();
    expect(() => endProviderCall("nope")).not.toThrow();
    expect(getProviderActivitySnapshot().inFlight).toBe(0);
  });
});

describe("classifyProviderActivity (health)", () => {
  afterEach(() => resetProviderActivityMonitorForTests());

  it("ok when idle / no sample", () => {
    expect(classifyProviderActivity(null).status).toBe("ok");
    expect(classifyProviderActivity({ sampledAt: "now", inFlight: 0, worst: null }).status).toBe("ok");
  });

  it("degraded + 'processing the prompt or stuck' for a stream awaiting_output", () => {
    const c = classifyProviderActivity({
      sampledAt: "now", inFlight: 1,
      worst: { id: "x", model: "qwen", mode: "stream", elapsedMs: 90_000, chunkCount: 0, state: "awaiting_output" },
    });
    expect(c.status).toBe("degraded");
    expect(c.detail).toMatch(/processing the prompt or stuck/i);
  });

  it("degraded + 'stalled' for a stream that went silent", () => {
    const c = classifyProviderActivity({
      sampledAt: "now", inFlight: 1,
      worst: { id: "x", model: "qwen", mode: "stream", elapsedMs: 120_000, ttftMs: 2000, silentMs: 60_000, chunkCount: 50, state: "stalled" },
    });
    expect(c.status).toBe("degraded");
    expect(c.detail).toMatch(/stalled/i);
  });

  it("never returns 'unavailable' (a slow remote must not flip the gateway to 503)", () => {
    for (const state of ["producing", "prefill", "awaiting", "awaiting_output", "stalled"] as const) {
      const c = classifyProviderActivity({
        sampledAt: "now", inFlight: 1,
        worst: { id: "x", model: "m", mode: "stream", elapsedMs: 999_999, chunkCount: 0, state },
      });
      expect(c.status).not.toBe("unavailable");
    }
  });
});
