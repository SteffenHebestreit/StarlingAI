/**
 * EVD-303: a SOURCE-BACKED finding shared via share_finding (rather than
 * share_evidence) still carries provenance — it must dual-write to the evidence
 * ledger so that provenance is preserved on the structured claim, instead of
 * being lost until the migration parity sweep backfills a bare unverified claim.
 * A lightweight finding with no provenance (a hostname, a computed value) stays
 * out of the ledger, exactly as share_finding intends.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listEvidenceClaims, resetEvidenceLedgerForTests } from "../swarm/evidence-ledger.js";
import { resetSharedMemoryForTests } from "../swarm/memory.js";

const testState = vi.hoisted(() => ({ evidence: "shadow" as "off" | "shadow" }));

vi.mock("../config/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/loader.js")>();
  return {
    ...original,
    getConfig: () => {
      const config = original.getConfig();
      return { ...config, mission: { ...config.mission, evidence: testState.evidence } };
    },
  };
});

describe("share_finding → evidence-ledger dual-write (EVD-303)", () => {
  beforeAll(async () => {
    await import("../tools/memory.js"); // registers the memory tools
  });

  afterEach(async () => {
    testState.evidence = "shadow";
    await resetEvidenceLedgerForTests();
    await resetSharedMemoryForTests();
  });

  it("dual-writes a SOURCE-BACKED finding (sourceUrl + evidenceType) to the ledger", async () => {
    const { executeTool } = await import("../tools/registry.js");
    const result = await executeTool("share_finding", {
      key: "weather_hamburg",
      value: "Hamburg: 18C, light rain.",
      claim: "Current weather in Hamburg is 18C with light rain.",
      sourceUrl: "https://open-meteo.com/",
      publisher: "Open-Meteo",
      retrievedAt: "2026-07-17",
      evidenceType: "observed",
      accuracyScore: 0.9,
      trustworthinessScore: 0.8,
      validationStatus: "tentative",
    }, { sessionId: "sub:pf-1:researcher:1", workspacePath: "/workspace" });
    expect(result.success).toBe(true);

    const claims = await listEvidenceClaims("pf-1");
    expect(claims).toHaveLength(1);
    expect(claims[0]!.value).toBe("Hamburg: 18C, light rain.");
    expect(claims[0]!.evidenceType).toBe("observed");
    expect(claims[0]!.sourceUrl).toBe("https://open-meteo.com/");
    expect(claims[0]!.validationState).toBe("tentative");
  });

  it("does NOT write a lightweight finding without provenance to the ledger", async () => {
    const { executeTool } = await import("../tools/registry.js");
    const result = await executeTool("share_finding", {
      key: "resolved_base_url",
      value: "https://api.example.com/v2",
    }, { sessionId: "sub:pf-2:coder:1", workspacePath: "/workspace" });
    expect(result.success).toBe(true);

    expect(await listEvidenceClaims("pf-2")).toHaveLength(0);
  });

  it("does NOT dual-write when evidence mode is off, even with provenance", async () => {
    testState.evidence = "off";
    const { executeTool } = await import("../tools/registry.js");
    await executeTool("share_finding", {
      key: "weather_hamburg",
      value: "Hamburg: 18C, light rain.",
      sourceUrl: "https://open-meteo.com/",
      evidenceType: "observed",
    }, { sessionId: "sub:pf-3:researcher:1", workspacePath: "/workspace" });

    expect(await listEvidenceClaims("pf-3")).toHaveLength(0);
  });
});
