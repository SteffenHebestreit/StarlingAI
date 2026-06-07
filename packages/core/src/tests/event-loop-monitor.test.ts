import { afterEach, describe, expect, it } from "vitest";
import {
  startEventLoopMonitor,
  stopEventLoopMonitor,
  sampleEventLoopLag,
  getEventLoopLagSnapshot,
  resetEventLoopMonitorForTests,
  DEFAULT_WARN_MS,
  DEFAULT_SEVERE_MS,
} from "../observability/event-loop-monitor.js";
import { classifyEventLoopLag } from "../observability/health-checks.js";

const baseSnap = (overrides: Partial<Parameters<typeof classifyEventLoopLag>[0] & object> = {}) => ({
  sampledAt: new Date().toISOString(),
  windowMs: 5_000,
  meanMs: 2,
  maxMs: 8,
  p99Ms: 5,
  peakMs: 8,
  ...overrides,
});

describe("classifyEventLoopLag", () => {
  it("reports ok when there is no sample yet", () => {
    const c = classifyEventLoopLag(null);
    expect(c.status).toBe("ok");
    expect(c.name).toBe("event_loop");
    expect(c.detail).toContain("no sample");
  });

  it("reports ok for a calm loop (worst stall below the warn floor)", () => {
    const c = classifyEventLoopLag(baseSnap({ maxMs: DEFAULT_WARN_MS - 50 }));
    expect(c.status).toBe("ok");
  });

  it("reports degraded (elevated) once the worst stall crosses the warn floor", () => {
    const c = classifyEventLoopLag(baseSnap({ maxMs: DEFAULT_WARN_MS + 10 }));
    expect(c.status).toBe("degraded");
    expect(c.detail).toMatch(/elevated loop lag/i);
  });

  it("reports degraded (blocked) and names a sync hotspot for a severe stall", () => {
    const c = classifyEventLoopLag(baseSnap({ maxMs: DEFAULT_SEVERE_MS + 500, peakMs: DEFAULT_SEVERE_MS + 500 }));
    expect(c.status).toBe("degraded");
    expect(c.detail).toMatch(/synchronous main-thread hotspot/i);
  });

  it("never returns 'unavailable' (a transient spike must not flip the gateway to 503)", () => {
    for (const maxMs of [0, DEFAULT_WARN_MS, DEFAULT_SEVERE_MS, DEFAULT_SEVERE_MS * 100]) {
      expect(classifyEventLoopLag(baseSnap({ maxMs })).status).not.toBe("unavailable");
    }
  });
});

describe("event-loop monitor lifecycle", () => {
  afterEach(() => resetEventLoopMonitorForTests());

  it("has no snapshot before start and sampling is a no-op", () => {
    expect(getEventLoopLagSnapshot()).toBeNull();
    expect(sampleEventLoopLag()).toBeNull();
  });

  it("produces a well-formed snapshot after a sampled window", async () => {
    // Long window so the internal timer doesn't sample on its own; we drive it.
    startEventLoopMonitor({ windowMs: 60_000, warnMs: 1, severeMs: 5_000 });
    // Give the loop something to measure, then let a libuv tick record the gap.
    const until = Date.now() + 30;
    while (Date.now() < until) { /* busy-block the loop briefly */ }
    await new Promise((resolve) => setTimeout(resolve, 40));

    const snap = sampleEventLoopLag();
    expect(snap).not.toBeNull();
    expect(getEventLoopLagSnapshot()).toEqual(snap);
    for (const key of ["meanMs", "maxMs", "p99Ms", "peakMs", "windowMs"] as const) {
      expect(typeof snap![key]).toBe("number");
      expect(snap![key]).toBeGreaterThanOrEqual(0);
    }
    expect(snap!.peakMs).toBeGreaterThanOrEqual(snap!.maxMs);
  });

  it("start is idempotent and reset clears the snapshot", async () => {
    startEventLoopMonitor({ windowMs: 60_000 });
    startEventLoopMonitor({ windowMs: 60_000 }); // second call is a no-op
    await new Promise((resolve) => setTimeout(resolve, 10));
    sampleEventLoopLag();
    expect(getEventLoopLagSnapshot()).not.toBeNull();

    resetEventLoopMonitorForTests();
    expect(getEventLoopLagSnapshot()).toBeNull();
    stopEventLoopMonitor(); // safe when already stopped
  });
});
