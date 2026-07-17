import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admitToProvider,
  getEndpointCapacitySnapshot,
  releaseProviderPermit,
  renewProviderPermit,
  resetCapacityBrokerForTests,
} from "../swarm/capacity-broker.js";
import { getConfig } from "../config/loader.js";

vi.mock("../config/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/loader.js")>();
  return {
    ...original,
    getConfig: vi.fn(() => ({
      ...original.getConfig(),
      mission: {
        ...original.getConfig().mission,
        capacity: { mode: "enforce", endpointUnits: 2, acquireTimeoutMs: 600, permitTtlMs: 5_000 },
      },
    })),
  };
});

const ENDPOINT = "http://model-host:1234/v1::qwen/test";
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("provider capacity broker (CAP-204, local backend)", () => {
  afterEach(async () => {
    await resetCapacityBrokerForTests();
    vi.mocked(getConfig).mockClear();
  });

  it("admits up to the endpoint's unit capacity, then refuses within the wait budget", async () => {
    const first = await admitToProvider(ENDPOINT, { timeoutMs: 0 });
    const second = await admitToProvider(ENDPOINT, { timeoutMs: 0 });
    const third = await admitToProvider(ENDPOINT, { timeoutMs: 0 });
    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(true);
    expect(third.admitted).toBe(false);
    if (!third.admitted) expect(third.reason).toBe("saturated");
  });

  it("a released permit frees the slot for a waiting admission", async () => {
    const first = await admitToProvider(ENDPOINT, { timeoutMs: 0 });
    const second = await admitToProvider(ENDPOINT, { timeoutMs: 0 });
    expect(first.admitted && second.admitted).toBe(true);
    if (!first.admitted) return;
    // Free one slot mid-wait: the pending admission gets it before timing out.
    const pending = admitToProvider(ENDPOINT, { timeoutMs: 2_000 });
    await pause(300);
    await releaseProviderPermit(first.permit);
    const result = await pending;
    expect(result.admitted).toBe(true);
    expect(result.waitedMs).toBeGreaterThan(0);
  });

  it("weighted admissions count against the same units", async () => {
    const heavy = await admitToProvider(ENDPOINT, { weight: 2, timeoutMs: 0 });
    expect(heavy.admitted).toBe(true);
    const blocked = await admitToProvider(ENDPOINT, { timeoutMs: 0 });
    expect(blocked.admitted).toBe(false);
    expect((await getEndpointCapacitySnapshot(ENDPOINT)).heldUnits).toBe(2);
  });

  it("a crashed holder's permit expires via TTL and frees the units; renewal keeps a healthy one alive", async () => {
    // The broker reads only mission.capacity from config.
    vi.mocked(getConfig).mockImplementation(() => ({
      mission: { capacity: { mode: "enforce", endpointUnits: 1, acquireTimeoutMs: 600, permitTtlMs: 1_000 } },
    }) as unknown as ReturnType<typeof getConfig>);
    const holder = await admitToProvider(ENDPOINT, { timeoutMs: 0 });
    expect(holder.admitted).toBe(true);
    if (!holder.admitted) return;
    // Healthy holder renews and stays exclusive...
    await pause(700);
    expect(await renewProviderPermit(holder.permit)).toBe(true);
    expect((await admitToProvider(ENDPOINT, { timeoutMs: 0 })).admitted).toBe(false);
    // ...then "crashes" (no more renewals): the permit expires and the slot frees.
    await pause(1_100);
    expect((await admitToProvider(ENDPOINT, { timeoutMs: 0 })).admitted).toBe(true);
  });

  it("endpoints are independent", async () => {
    await admitToProvider(ENDPOINT, { weight: 2, timeoutMs: 0 });
    const other = await admitToProvider("http://other-host:1234/v1::model", { timeoutMs: 0 });
    expect(other.admitted).toBe(true);
  });
});
