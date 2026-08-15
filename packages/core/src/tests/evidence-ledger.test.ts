import { afterEach, describe, expect, it } from "vitest";
import {
  appendEvidenceClaim,
  canonicalizeSubject,
  formatEvidenceForPrompt,
  listDisputedSubjects,
  listEvidenceClaims,
  normalizeValue,
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

  it("UNDATED same-tier claims stay MATERIAL even when appended across a clock tick — ingestion order is not freshness", async () => {
    // Regression for a flake the EVL-402 pack runner caught: with no explicit
    // publishedAt/retrievedAt, the auto-stamped observedAt made whichever claim
    // landed a millisecond later "decisively fresher".
    await appendEvidenceClaim("cf-6", { subject: "s", value: "x", evidenceType: "observed" });
    await new Promise((r) => setTimeout(r, 5)); // force distinct observedAt stamps
    await appendEvidenceClaim("cf-6", { subject: "s", value: "y", evidenceType: "observed" });
    const result = await resolveSubjectConflict("cf-6", "s");
    expect(result.outcome).toBe("material");
  });

  it("ONE dated claim against an undated same-tier claim is still MATERIAL — freshness needs both sides dated", async () => {
    await appendEvidenceClaim("cf-7", { subject: "s", value: "x", evidenceType: "secondary", retrievedAt: "2026-07-01" });
    await appendEvidenceClaim("cf-7", { subject: "s", value: "y", evidenceType: "secondary" });
    const result = await resolveSubjectConflict("cf-7", "s");
    expect(result.outcome).toBe("material");
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

describe("evidence ledger — numeric value normalization (same quantity, different rendering)", () => {
  const same = (a: string, b: string): boolean => normalizeValue(a) === normalizeValue(b);

  it("folds currency symbol, thousands separator and trailing zeros into one form", () => {
    expect(same("$1,299", "1299 USD")).toBe(true);
    expect(same("$1,299", "USD 1299.00")).toBe(true);
    expect(same("1299", "1,299.0")).toBe(true);
    expect(same("€2.500,50", "2500.5 EUR")).toBe(true);
  });

  it("keeps genuinely different quantities and different currencies apart", () => {
    expect(same("$1,299", "$1,300")).toBe(false);
    // Same number, different currency is a REAL conflict — must not be folded.
    expect(same("1299 USD", "1299 EUR")).toBe(false);
    expect(same("$1,299", "1299 EUR")).toBe(false);
  });

  it("refuses to guess on the ambiguous one-separator-plus-3-digits case", () => {
    // "1,299" is 1299 in en-US and 1.299 in de-DE. Merging would be a guess, so
    // these stay distinct (today's behavior) rather than risk hiding a conflict.
    expect(normalizeValue("1,299")).not.toBe(normalizeValue("1.299"));
  });

  it("leaves non-numeric and mixed values to plain text comparison", () => {
    expect(same("Acme Corp", "acme corp")).toBe(true);
    expect(same("about 5 units", "about 5 units")).toBe(true);
    expect(same("released 2024", "released 2025")).toBe(false);
    // Contradictory decoration is not silently resolved.
    expect(normalizeValue("$100 EUR")).toBe("$100 eur");
  });

  it("is idempotent — normalizing an already-normalized value is a no-op", () => {
    for (const v of ["$1,299", "1299 USD", "Acme Corp", "1.299", "€2.500,50"]) {
      expect(normalizeValue(normalizeValue(v))).toBe(normalizeValue(v));
    }
  });
});
