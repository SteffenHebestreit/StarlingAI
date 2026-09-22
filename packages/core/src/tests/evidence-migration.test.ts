/**
 * EVD-303 slice 1: legacy-to-ledger migration parity sweep + backfill.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { sweepEvidenceMigrationParity } from "../swarm/evidence-migration.js";
import {
  appendEvidenceClaim,
  listDisputedSubjects,
  listEvidenceClaims,
  resetEvidenceLedgerForTests,
  sweepEvidenceConflicts,
} from "../swarm/evidence-ledger.js";
import { writeSharedFact, resetSharedMemoryForTests } from "../swarm/memory.js";

const testState = vi.hoisted(() => ({ evidence: "shadow" as "off" | "shadow" }));
const auditRows = vi.hoisted(() => [] as Array<{ type: string; sessionId?: string; severity?: string }>);

vi.mock("../audit/logger.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../audit/logger.js")>();
  return {
    ...original,
    logAudit: vi.fn((type: string, _data: unknown, opts?: { sessionId?: string; severity?: string }) => {
      auditRows.push({ type, sessionId: opts?.sessionId, severity: opts?.severity });
    }),
  };
});

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
    auditRows.length = 0;
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

  it("VALUE divergence between stores becomes a first-class disputed conflict, not a silent split", async () => {
    await writeSharedFact("em-5", "gpu_price", "549 EUR");
    await appendEvidenceClaim("em-5", { subject: "gpu_price", value: "499 EUR", evidenceType: "primary" });

    const parity = await sweepEvidenceMigrationParity("em-5");
    expect(parity).toMatchObject({ valueDivergences: 1, backfilled: 0 });

    const claims = await listEvidenceClaims("em-5");
    expect(claims).toHaveLength(2);
    // The write-time conflict detector marked the divergent append disputed.
    expect(claims.find((c) => c.agent === "evidence_migration_divergence")?.validationState).toBe("disputed");

    // Idempotent: the divergent value is now IN the ledger — no re-append.
    const second = await sweepEvidenceMigrationParity("em-5");
    expect(second?.valueDivergences).toBe(0);
    expect(await listEvidenceClaims("em-5")).toHaveLength(2);
  });

  it("a last-writer-wins pointer overwritten across turns SUPERSEDES its earlier values instead of disputing them", async () => {
    // latest_image is rewritten after every generated image. Each overwrite used
    // to land as a divergence, so three undated `observed` values became a
    // MATERIAL dispute and the QA reviewer failed an answer that asserted none.
    const sid = "em-7";
    const [p1, p2, p3] = ["/shared/image-1.png", "/shared/image-2.png", "/shared/image-3.png"];
    await writeSharedFact(sid, "latest_image", p1);
    expect(await sweepEvidenceMigrationParity(sid)).toMatchObject({ backfilled: 1, superseded: 0 });
    await writeSharedFact(sid, "latest_image", p2);
    expect(await sweepEvidenceMigrationParity(sid)).toMatchObject({ backfilled: 0, valueDivergences: 0, superseded: 1 });
    await writeSharedFact(sid, "latest_image", p3);
    expect(await sweepEvidenceMigrationParity(sid)).toMatchObject({ backfilled: 0, valueDivergences: 0, superseded: 1 });

    expect(await listDisputedSubjects(sid)).not.toContain("latest_image");
    expect((await sweepEvidenceConflicts(sid)).filter((r) => r.outcome === "material")).toEqual([]);
    const history = await listEvidenceClaims(sid, { subject: "latest_image" });
    expect(history.map((c) => c.value)).toEqual([p1, p2, p3]); // append-only history kept
    expect(history.some((c) => c.validationState === "disputed")).toBe(false);
    expect(auditRows.filter((r) => r.sessionId === sid && r.type === "evidence_conflict_detected")).toEqual([]);
    // A superseded pointer is the legacy store working as designed, not drift.
    const parityRows = auditRows.filter((r) => r.sessionId === sid && r.type === "evidence_migration_parity");
    expect(parityRows.map((r) => r.severity)).toEqual(["warn", "info", "info"]);

    // Idempotent: nothing new was written, so nothing is superseded.
    expect(await sweepEvidenceMigrationParity(sid)).toMatchObject({ superseded: 0 });
    // A→B→A: going back to an earlier value is still a new write of the pointer.
    await writeSharedFact(sid, "latest_image", p1);
    expect(await sweepEvidenceMigrationParity(sid)).toMatchObject({ valueDivergences: 0, superseded: 1 });
    expect(await listEvidenceClaims(sid, { subject: "latest_image" })).toHaveLength(4);
    expect(await listDisputedSubjects(sid)).toEqual([]);
  });

  it("a subject the ledger also holds a DIRECT claim for keeps conflict detection when the legacy value moves", async () => {
    const sid = "em-8";
    await writeSharedFact(sid, "k", "v1");
    await sweepEvidenceMigrationParity(sid); // backfill
    await appendEvidenceClaim(sid, { subject: "k", value: "v1", agent: "researcher", evidenceType: "primary" });
    await writeSharedFact(sid, "k", "v2");

    const parity = await sweepEvidenceMigrationParity(sid);
    expect(parity).toMatchObject({ valueDivergences: 1, superseded: 0 });
    expect(await listDisputedSubjects(sid)).toEqual(["k"]);
  });

  it("two legacy keys that canonicalize alike stay disputed and do not flip-flop across sweeps", async () => {
    // They hold two values at once, so neither overwrote the other.
    const sid = "em-9";
    await writeSharedFact(sid, "GPU price", "499 EUR");
    await writeSharedFact(sid, "gpu price", "549 EUR");
    await sweepEvidenceMigrationParity(sid);
    for (let i = 0; i < 3; i++) {
      expect(await sweepEvidenceMigrationParity(sid)).toMatchObject({ backfilled: 0, valueDivergences: 0, superseded: 0 });
    }
    expect(await listEvidenceClaims(sid)).toHaveLength(2);
    expect(await listDisputedSubjects(sid)).toEqual(["gpu price"]);
  });

  it("a SOURCED key known only through the sweep still disputes a changed value", async () => {
    // share_evidence writes its ledger claim under the claim sentence, so its KEY subject only
    // ever holds sweep claims. What marks it as sourced is the provenance it stores in the
    // value; two such values are two sources disagreeing, not an overwrite.
    const sid = "em-10";
    const record = (finding: string, url: string) =>
      `${finding}\n\nrecord_type: evidence\nclaim: GPU list price\nsource_url: ${url}\nevidence_type: primary`;
    await writeSharedFact(sid, "gpu_price", record("499 EUR", "https://vendor.example/a"));
    await sweepEvidenceMigrationParity(sid);
    await writeSharedFact(sid, "gpu_price", record("549 EUR", "https://shop.example/b"));

    const parity = await sweepEvidenceMigrationParity(sid);
    expect(parity).toMatchObject({ valueDivergences: 1, superseded: 0 });
    expect(await listDisputedSubjects(sid)).toEqual(["gpu_price"]);
  });

  it("a legacy value that returns to a SUPERSEDED value is a divergence, not agreement", async () => {
    // latest_image p1 -> p2 supersedes p1. An agent then records a direct claim, so the subject
    // is no longer sweep-only; the legacy value goes back to p1. p1 is history, not a live value,
    // so matching it must not count as the two stores agreeing.
    const sid = "em-11";
    await writeSharedFact(sid, "latest_image", "generated/p1.png");
    await sweepEvidenceMigrationParity(sid);
    await writeSharedFact(sid, "latest_image", "generated/p2.png");
    expect(await sweepEvidenceMigrationParity(sid)).toMatchObject({ superseded: 1 });
    await appendEvidenceClaim(sid, { subject: "latest_image", value: "generated/p2.png", agent: "image_creator", evidenceType: "observed" });
    await writeSharedFact(sid, "latest_image", "generated/p1.png");

    expect(await sweepEvidenceMigrationParity(sid)).toMatchObject({ valueDivergences: 1 });
  });

  it("agreeing values across stores are NOT divergences", async () => {
    await writeSharedFact("em-6", "release", "March 2026");
    await appendEvidenceClaim("em-6", { subject: "release", value: "  march   2026 ", evidenceType: "secondary" });
    const parity = await sweepEvidenceMigrationParity("em-6");
    expect(parity).toMatchObject({ valueDivergences: 0, backfilled: 0 });
  });

  it("returns null (and writes nothing) when the evidence ledger is off", async () => {
    testState.evidence = "off";
    await writeSharedFact("em-4", "k", "v");
    expect(await sweepEvidenceMigrationParity("em-4")).toBeNull();
    expect(await listEvidenceClaims("em-4")).toHaveLength(0);
  });
});
