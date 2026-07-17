import { afterEach, describe, expect, it } from "vitest";
import {
  appendEvidenceClaim,
  canonicalizeSubject,
  formatEvidenceForPrompt,
  listDisputedSubjects,
  listEvidenceClaims,
  resetEvidenceLedgerForTests,
  resolveSubjectConflict,
  sweepEvidenceConflicts,
} from "../swarm/evidence-ledger.js";

describe("evidence ledger (EVD-301, local backend)", () => {
  afterEach(async () => {
    await resetEvidenceLedgerForTests();
  });

  it("appends immutable claims; nothing is overwritten by a same-subject write", async () => {
    await appendEvidenceClaim("ev-1", { subject: "GPU price", value: "499 EUR", agent: "researcher" });
    await appendEvidenceClaim("ev-1", { subject: "gpu   PRICE", value: "499 EUR", agent: "verifier" });
    const claims = await listEvidenceClaims("ev-1", { subject: "GPU Price" });
    expect(claims).toHaveLength(2); // both retained (same canonical subject, same value)
    expect(new Set(claims.map((c) => c.claimId)).size).toBe(2);
    expect(canonicalizeSubject("gpu   PRICE")).toBe("gpu price");
  });

  it("a same-subject DIFFERENT-value write marks the subject disputed and both claims coexist", async () => {
    const first = await appendEvidenceClaim("ev-2", { subject: "release date", value: "2026-03-01", validationState: "validated" });
    expect(first.conflictWith).toBeUndefined();
    const second = await appendEvidenceClaim("ev-2", { subject: "Release Date", value: "2026-05-15" });
    expect(second.conflictWith).toEqual([first.claim.claimId]);
    expect(second.claim.validationState).toBe("disputed");
    expect(await listDisputedSubjects("ev-2")).toEqual(["release date"]);
    expect(await listEvidenceClaims("ev-2")).toHaveLength(2); // conflict preserved, not merged
  });

  it("prompt projection is bounded and flags disputes; the record itself is never truncated", async () => {
    const longValue = "x".repeat(5_000);
    await appendEvidenceClaim("ev-3", { subject: "big finding", value: longValue });
    await appendEvidenceClaim("ev-3", { subject: "hot topic", value: "A" });
    await appendEvidenceClaim("ev-3", { subject: "hot topic", value: "B" });
    const stored = await listEvidenceClaims("ev-3", { subject: "big finding" });
    expect(stored[0]?.value).toHaveLength(5_000); // canonical record intact
    const projection = await formatEvidenceForPrompt("ev-3", { maxChars: 900 });
    expect(projection.length).toBeLessThanOrEqual(900);
    expect(projection).toContain("DISPUTED");
  });

  it("sessions are isolated", async () => {
    await appendEvidenceClaim("ev-a", { subject: "s", value: "1" });
    expect(await listEvidenceClaims("ev-b")).toEqual([]);
  });
});

describe("evidence conflict & freshness engine (EVD-302)", () => {
  afterEach(async () => {
    await resetEvidenceLedgerForTests();
  });

  it("a higher source authority supersedes decisively; losers stay in the log", async () => {
    await appendEvidenceClaim("cf-1", { subject: "max power", value: "450 W", evidenceType: "secondary", sourceUrl: "https://blog.example" });
    await appendEvidenceClaim("cf-1", { subject: "Max Power", value: "500 W", evidenceType: "official", sourceUrl: "https://vendor.example/spec" });
    const result = await resolveSubjectConflict("cf-1", "max power");
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    expect(result.winner.value).toBe("500 W");
    expect(result.reason).toContain("authority");
    expect(await listEvidenceClaims("cf-1", { subject: "max power" })).toHaveLength(2); // nothing deleted
    expect(await listDisputedSubjects("cf-1")).toEqual([]); // resolved, no longer disputed
  });

  it("within one authority tier, the decisively fresher dated claim supersedes", async () => {
    await appendEvidenceClaim("cf-2", { subject: "price", value: "499 EUR", evidenceType: "primary", publishedAt: "2026-01-10" });
    await appendEvidenceClaim("cf-2", { subject: "price", value: "479 EUR", evidenceType: "primary", publishedAt: "2026-06-01" });
    const result = await resolveSubjectConflict("cf-2", "price");
    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    expect(result.winner.value).toBe("479 EUR");
    expect(result.reason).toContain("fresher");
  });

  it("equal authority without decisive freshness is a MATERIAL conflict → verification work", async () => {
    const sameDate = "2026-03-03";
    await appendEvidenceClaim("cf-3", { subject: "release", value: "March", evidenceType: "secondary", publishedAt: sameDate });
    await appendEvidenceClaim("cf-3", { subject: "release", value: "May", evidenceType: "secondary", publishedAt: sameDate });
    const result = await resolveSubjectConflict("cf-3", "release");
    expect(result.outcome).toBe("material");
    if (result.outcome !== "material") return;
    expect(result.claims).toHaveLength(2); // both surfaced for verification, neither collapsed
    expect(await listDisputedSubjects("cf-3")).toEqual(["release"]); // still disputed
  });

  it("sweep resolves every disputed subject and reports the queue", async () => {
    await appendEvidenceClaim("cf-4", { subject: "a", value: "1", evidenceType: "secondary" });
    await appendEvidenceClaim("cf-4", { subject: "a", value: "2", evidenceType: "official" });
    await appendEvidenceClaim("cf-4", { subject: "b", value: "x", evidenceType: "observed" });
    await appendEvidenceClaim("cf-4", { subject: "b", value: "y", evidenceType: "observed" });
    const results = await sweepEvidenceConflicts("cf-4");
    const byOutcome = Object.fromEntries(results.map((r) => [r.subject, r.outcome]));
    expect(byOutcome["a"]).toBe("resolved");
    expect(byOutcome["b"]).toBe("material");
  });
});
