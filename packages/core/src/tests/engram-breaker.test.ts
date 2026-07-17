/**
 * Engram circuit breaker: after a network failure, per-turn document-RAG calls
 * fast-fail for a cooldown instead of re-timing-out every turn (the ~8s/turn
 * stall when engram is down / the `rag` compose profile is off). The explicit
 * /health probe bypasses the breaker so recovery is detected promptly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  engramListDocuments,
  engramHealth,
  invalidateEngramDocListCache,
  _resetEngramBreakerForTests,
} from "../retrieval/engram.js";

// Make engram "configured" (enabled + base URL) regardless of the loaded config.
vi.mock("../config/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/loader.js")>();
  return {
    ...original,
    getConfig: () => {
      const cfg = original.getConfig();
      return {
        ...cfg,
        retrieval: {
          ...cfg.retrieval,
          documentRag: { ...cfg.retrieval.documentRag, enabled: true, engramBaseUrl: "http://engram:8088" },
        },
      };
    },
  };
});

describe("engram circuit breaker", () => {
  const realFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetEngramBreakerForTests();
    invalidateEngramDocListCache();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    _resetEngramBreakerForTests();
    invalidateEngramDocListCache();
  });

  it("opens after a network failure and fast-fails subsequent calls WITHOUT hitting the network", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED engram down"));

    // First call reaches the network, fails, and opens the breaker.
    expect(await engramListDocuments()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second and third calls short-circuit — the breaker is open, so no more
    // network calls (and no more per-turn timeout stalls) within the cooldown.
    invalidateEngramDocListCache();
    expect(await engramListDocuments()).toBeNull();
    invalidateEngramDocListCache();
    expect(await engramListDocuments()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // still 1 — the breaker held
  });

  it("a reachable response clears the breaker (recovery)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("down"));
    expect(await engramListDocuments()).toBeNull(); // opens breaker
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulate the cooldown elapsing, then engram comes back.
    _resetEngramBreakerForTests();
    invalidateEngramDocListCache();
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] } as unknown as Response);
    expect(await engramListDocuments()).toEqual([]); // reachable → succeeds
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("engramHealth bypasses the breaker so recovery can be probed while it is open", async () => {
    fetchMock.mockRejectedValueOnce(new Error("down"));
    expect(await engramListDocuments()).toBeNull(); // opens breaker
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The breaker is open — a per-turn list call would short-circuit, but the
    // explicit health probe still hits the network (bypassBreaker).
    fetchMock.mockResolvedValueOnce({ ok: true } as unknown as Response);
    expect(await engramHealth()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2); // health probed despite the open breaker
  });
});
