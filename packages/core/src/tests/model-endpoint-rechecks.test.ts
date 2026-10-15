import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startModelEndpointRechecks } from "../runtime/model-endpoints.js";

/**
 * 2026-10-15: Docker restarted, the gateway booted before a model server answered, and the dashboard
 * read "1 model endpoint(s) unhealthy" for hours after it did — nothing probed it again.
 */
describe("model endpoints are probed again on their own", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const health = (ok: boolean) => [{ ok } as never];

  it("every minute while one fails, then every ten minutes once all answer", async () => {
    const results = [false, true, true];
    const probe = vi.fn(async () => health(results.shift() ?? true));
    const stop = startModelEndpointRechecks({ initiallyHealthy: false, probe });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(probe).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(1);   // still failing
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledTimes(2);   // answers now
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledTimes(3);
    stop();
  });

  it("keeps going after a probe throws, and stops when told", async () => {
    const probe = vi.fn(async () => { throw new Error("unreachable"); });
    const stop = startModelEndpointRechecks({ initiallyHealthy: true, probe });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);   // a throw counts as unhealthy: a minute
    expect(probe).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
