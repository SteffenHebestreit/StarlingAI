/**
 * The restatement rescue fires where routing found nothing, and nowhere else.
 *
 * The measurement that motivates it: on 138 live queries (88 DE / 50 EN), routing the
 * classifier's English restatement after an EMPTY first pass rescued 20 queries outright —
 * raw recall 87 -> 107, recall at the discovery capsule 84 -> 97, zero regressions. Every one
 * of those gains came from a query the raw pass had left empty; restating the 49 queries that
 * were already working added 0 recall for 49 extra calls.
 *
 * So the tests here are mostly about the cases where it must NOT act. A rescue that fires
 * broadly would spend a routing-tier call per turn to reproduce results retrieval already
 * had, which is the failure this design exists to avoid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const complete = vi.fn<(...args: unknown[]) => Promise<{ content: string }>>();

vi.mock("../agent/routing-tier-provider.js", () => ({
  resolveRoutingTierProvider: () => ({ complete }),
}));

const { attemptRestatementRescue } = await import("../agent/routing-restatement.js");

/** A triage verdict as the routing tier returns it: JSON text, one field of which matters. */
function verdict(queryEn: string): { content: string } {
  return {
    content: JSON.stringify({
      // These must be REAL enum members. With invented ones the verdict fails to parse and
      // every case below returns null for the wrong reason — which is exactly what the first
      // draft of this file did, and only the happy-path test noticed.
      mode: "ACT",
      domain: ["infra_ops"],
      deliverable: "config_change",
      decision: "single_agent",
      query_en: queryEn,
      language: "de",
      confidence: 0.9,
    }),
  };
}

/** Stands in for an AgentRoutingResolution; only `results` is read by the caller contract. */
const FOUND = { results: [{ name: "infrastructure_agent" }] };
const EMPTY = { results: [] as Array<{ name: string }> };

describe("the English-restatement rescue", () => {
  beforeEach(() => { complete.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("routes the restatement and returns what it found", async () => {
    complete.mockResolvedValue(verdict("roll out the certificate to production"));
    const resolve = vi.fn(async () => FOUND);

    const rescue = await attemptRestatementRescue("kannst du das zertifikat ausrollen", {
      resolve,
      admitted: (r) => r.results.length > 0,
    });

    expect(rescue?.restatement).toBe("roll out the certificate to production");
    expect(rescue?.resolution).toBe(FOUND);
    expect(resolve).toHaveBeenCalledExactlyOnceWith("roll out the certificate to production");
  });

  it("does NOT re-run retrieval when the restatement is the same request", async () => {
    // An English query restates to itself. Routing it again would spend an embedding
    // round-trip to reproduce the miss that just happened. The check is structural —
    // punctuation and case only — so it needs no per-language rules, which is the one thing
    // this codebase has decided routing must never grow.
    complete.mockResolvedValue(verdict("Deploy the TLS certificate!"));
    const resolve = vi.fn(async () => FOUND);

    const rescue = await attemptRestatementRescue("deploy the tls certificate", {
      resolve,
      admitted: (r) => r.results.length > 0,
    });

    expect(rescue).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns null when the second pass also finds nothing", async () => {
    // 2 of the 138 corpus queries did exactly this. The caller must then report its original
    // miss, not a rescue that rescued nothing.
    complete.mockResolvedValue(verdict("something no agent covers"));

    const rescue = await attemptRestatementRescue("irgendwas das niemand kann", {
      resolve: async () => EMPTY,
      admitted: (r) => r.results.length > 0,
    });

    expect(rescue).toBeNull();
  });

  it("honours the caller's own admission rule, not just a non-empty list", async () => {
    // The delegation path excludes the calling agent from its own routing. Without this the
    // rescue could hand a coordinator back the very agent the router refused to offer it.
    complete.mockResolvedValue(verdict("coordinate the rollout"));

    const rescue = await attemptRestatementRescue("koordiniere den rollout", {
      resolve: async () => ({ results: [{ name: "mission_coordinator" }] }),
      admitted: (r) => r.results.some((entry) => entry.name !== "mission_coordinator"),
    });

    expect(rescue).toBeNull();
  });

  it("gives up quietly when the routing tier produces no verdict", async () => {
    // A routing tier that is down or slow must degrade to the original miss message, never
    // to an exception: this runs on a path that is already reporting a failure.
    complete.mockResolvedValue({ content: "I'm sorry, I can't do that." });
    const resolve = vi.fn(async () => FOUND);

    const rescue = await attemptRestatementRescue("kannst du das zertifikat ausrollen", {
      resolve,
      admitted: (r) => r.results.length > 0,
    });

    expect(rescue).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not throw when the routing tier call itself rejects", async () => {
    complete.mockRejectedValue(new Error("routing tier unreachable"));

    await expect(attemptRestatementRescue("kannst du das zertifikat ausrollen", {
      resolve: async () => FOUND,
      admitted: (r) => r.results.length > 0,
    })).resolves.toBeNull();
  });
});
