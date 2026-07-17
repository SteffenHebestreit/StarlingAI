/**
 * EVD-303 slice 1: legacy-to-ledger migration parity sweep + backfill.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { sweepEvidenceMigrationParity } from "../swarm/evidence-migration.js";
import { appendEvidenceClaim, listEvidenceClaims, resetEvidenceLedgerForTests } from "../swarm/evidence-ledger.js";
import { writeSharedFact, resetSharedMemoryForTests } from "../swarm/memory.js";

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

describe("evidence migration parity (EVD-303)", () => {
  afterEach(async () => {
    testState.evidence = "shadow";
    await resetEvidenceLedgerForTests();
    await resetSharedMemoryForTests();
  });

  it("backfills legacy facts the ledger is missing, as UNVERIFIED migration claims", async () => {
    await writeSharedFact("em-1", "gpu_price", "499 EUR");
    await writeSharedFact("em-1", "release_date", "March 2026");
    // One fact already dual-written — must not be duplicated by the sweep.
    await appendEvidenceClaim("em-1", { subject: "gpu_price", value: "499 EUR", evidenceType: "observed" });

    const parity = await sweepEvidenceMigrationParity("em-1");
    expect(parity).toMatchObject({ legacyFacts: 2, ledgerClaims: 1, backfilled: 1, ledgerOnly: 0 });

    const claims = await listEvidenceClaims("em-1");
    expect(claims).toHaveLength(2);
    const backfilledClaim = claims.find((c) => c.agent === "evidence_migration_backfill");
    expect(backfilledClaim?.validationState).toBe("unverified");
    expect(backfilledClaim?.evidenceType).toBe("observed");
  });

  it("is idempotent: a second sweep backfills nothing", async () => {
    await writeSharedFact("em-2", "k", "v");
    const first = await sweepEvidenceMigrationParity("em-2");
    expect(first?.backfilled).toBe(1);
    const second = await sweepEvidenceMigrationParity("em-2");
    expect(second?.backfilled).toBe(0);
    expect(await listEvidenceClaims("em-2")).toHaveLength(1);
  });

  it("counts ledger-only subjects (rich share_evidence claims) without treating them as drift", async () => {
    await appendEvidenceClaim("em-3", { subject: "The API rate limit is 100 rps", value: "100 rps", evidenceType: "primary" });
    const parity = await sweepEvidenceMigrationParity("em-3");
    expect(parity).toMatchObject({ legacyFacts: 0, ledgerClaims: 1, backfilled: 0, ledgerOnly: 1 });
  });

  it("returns null (and writes nothing) when the evidence ledger is off", async () => {
    testState.evidence = "off";
    await writeSharedFact("em-4", "k", "v");
    expect(await sweepEvidenceMigrationParity("em-4")).toBeNull();
    expect(await listEvidenceClaims("em-4")).toHaveLength(0);
  });
});
