/**
 * Characterization of the evidence-anchoring repair trigger
 * (`orchestration.evidenceAnchoringOnGatheredEvidence`, default OFF, pass^k-gated).
 *
 * When that flag is on, a turn that delegated research successfully re-synthesizes its
 * answer whenever `answerNeedsEvidenceAnchoringRepair` says the answer does not reference
 * the gathered findings. The flag's documented risk is that it "can re-synthesize an
 * answer" — so the number that decides default-on is the FALSE-POSITIVE rate: how often it
 * discards an answer that was already properly grounded.
 *
 * The fixtures below are REAL: the delivered answer and the shared-facts evidence from a
 * live research turn (session 7777aaaa, "Recherchiere die aktuelle Node.js LTS-Version").
 * That answer is exemplary — it cites the patch version, codename, both dates, the
 * publisher and the official URL, all straight from the evidence.
 *
 * Note evidence-anchoring.ts already documents (audit f7928f57) that condition 2 of
 * looksEvidenceAnchored over-fires "the moment [a draft] names a requested topic the
 * (often thin/partial) evidence didn't cover" — which is why the recovery path uses the
 * lighter sharesEvidenceVocabulary instead. This suite pins how that behaves for the
 * model's own free draft, which is what the flag actually gates.
 */
import { describe, expect, it } from "vitest";
import { answerNeedsEvidenceAnchoringRepair } from "../agent/evidence-recovery.js";
import { looksEvidenceAnchored, sharesEvidenceVocabulary } from "../agent/evidence-anchoring.js";

/**
 * Real shared-facts evidence from that turn, in the EXACT string shape the runtime builds
 * (getSharedFactsEvidenceForFinalSynthesis: `- <key>: <value>` per line, all inner
 * whitespace collapsed to single spaces, `auto_*` raw shares sorted last). Reproduced
 * byte-for-byte so this measures what the guard actually sees at runtime.
 */
const EVIDENCE = [
  "- nodejs_lts_version: Node.js 24 LTS (Codename: Krypton) — Latest patch: v24.18.0, First released: May 06, 2025, Last updated: Jun 23, 2026, Status: LTS claim: Node.js 24 (Krypton) ist die aktuelle LTS-Version. source_title: Node.js Releases — Official Release Page source_url: https://nodejs.org/en/about/releases/ publisher: OpenJS Foundation / Node.js contributors published_at: 2026-06-23 retrieved_at: 2026-07-18 evidence_type: official accuracy_score: 1 trustworthiness_score: 1 validation_status: validated",
  "- auto_researcher_web_fetch_99pm3r: [researcher/web_fetch] - v24 LTS (Codename: Krypton), First released: May 06, 2025, Last updated: Jun 23, 2026, Status: LTS. Source URL: https://nodejs.org/en/about/releases/",
  "- auto_researcher_web_search_1yt1sj3: [researcher/web_search] * **Node.js 24** ist die aktuelle LTS-Version (LTS Line) bis Oktober 2026. * **Node.js 26** ist die aktuelle Current-Version (Current Line). * Die offizielle Release-Page listet Node.js 24.16 als neueste LTS und Node.js 26.3.0 als neueste Current Version (Stand: 8. Juni 2026). * **URL:** https://blog.dante.company/en/articles/node-24-16-node-26-runtime-upgrade-playbook-2026-06-08",
].join("\n");

/** The answer actually delivered to the user — grounded, sourced, correct. */
const REAL_GROUNDED_ANSWER = `## Aktuelle Node.js LTS-Version

**Node.js 24 LTS** (Codename: **Krypton**)

| Feld | Wert |
|---|---|
| **Versionsnummer** | v24 (LTS) — neuester Patch: **v24.18.0** |
| **Codename** | **Krypton** |
| **Erstveröffentlichung** | **06. Mai 2025** |
| **Letztes Update** | **23. Juni 2026** |
| **Status** | **LTS** (Long Term Support) |

### Offizielle Quelle

Die autoritative, offizielle Node.js Release-Page:

**https://nodejs.org/en/about/releases/**

*Publisher:* OpenJS Foundation / Node.js contributors
*Stand der Tabelle:* Juni 2026 (zuletzt aktualisiert am 23. Juni 2026)

### Kurzer Kontext

Node.js 24 ist die aktuelle LTS-Reihe und folgt auf Node.js 22 (Jod), das sich im Maintenance-LTS-Status befindet. Die LTS-Reihe garantiert kritische Bugfixes für insgesamt 30 Monate. Die nächste LTS-Reihe wird **Node.js 26** sein, die voraussichtlich im **Oktober 2026** in den Active-LTS-Status wechselt.`;

/** The same answer WITHOUT the closing paragraph of extra context. Pure restatement
 *  of the evidence — the least ambiguous "properly grounded" case there is. */
const STRICT_RESTATEMENT = REAL_GROUNDED_ANSWER.split("### Kurzer Kontext")[0]!.trim();

/** A from-memory answer that ignores the gathered findings entirely: wrong version,
 *  no patch number, no codename, no source. This is what the flag exists to catch. */
const UNGROUNDED_ANSWER = `## Node.js LTS

Die aktuelle LTS-Version von Node.js ist meines Wissens die Version 20 ("Iron"). Sie wird
langfristig unterstuetzt und eignet sich damit gut fuer produktive Systeme. Generell
erscheint jedes Jahr im Oktober eine neue LTS-Reihe, und geradzahlige Hauptversionen werden
nach ihrer Stabilisierung zu LTS befoerdert. Fuer Produktionsumgebungen empfiehlt es sich,
immer die neueste LTS-Reihe einzusetzen und regelmaessig auf Patch-Releases zu aktualisieren,
weil dort die sicherheitsrelevanten Korrekturen zuerst landen. Weitere Details stehen in der
offiziellen Dokumentation des Projekts sowie im Release-Kalender der Maintainer.`;

describe("evidence-anchoring repair trigger — precision on real turn data", () => {
  it("TRUE POSITIVE: an ungrounded from-memory answer is flagged for repair", () => {
    // The behaviour the flag is for: research ran, findings exist, the answer ignored them.
    expect(answerNeedsEvidenceAnchoringRepair(UNGROUNDED_ANSWER, EVIDENCE)).toBe(true);
  });

  it("TRUE NEGATIVE: a strict restatement of the evidence is left alone", () => {
    expect(answerNeedsEvidenceAnchoringRepair(STRICT_RESTATEMENT, EVIDENCE)).toBe(false);
  });

  // FALSE POSITIVE (pinned, not endorsed). The delivered answer is grounded, sourced and
  // correct; it merely ADDS context the findings didn't cover, phrased with German
  // hyphen-compounds — "lts-reihe", "maintenance-lts-status", "active-lts-status". Condition 2
  // treats any hyphenated token as a falsifiable spec that must appear verbatim in the
  // evidence, so ordinary German compounding is indistinguishable from a fabricated spec.
  // With the flag ON this answer is thrown away and re-synthesized for no correctness gain.
  it("FALSE POSITIVE: the real grounded answer is flagged because of German compounds", () => {
    expect(answerNeedsEvidenceAnchoringRepair(REAL_GROUNDED_ANSWER, EVIDENCE)).toBe(true);
    // ...even though the lighter detector (used by the recovery path) accepts it.
    expect(sharesEvidenceVocabulary(REAL_GROUNDED_ANSWER, EVIDENCE)).toBe(true);
  });

  it("DIAGNOSTIC: which condition fails, per draft", () => {
    for (const [label, draft] of [
      ["strict restatement", STRICT_RESTATEMENT],
      ["real delivered answer", REAL_GROUNDED_ANSWER],
      ["ungrounded from-memory", UNGROUNDED_ANSWER],
    ] as const) {
      // sharesEvidenceVocabulary == condition 1 (shared vocabulary) on its own.
      // looksEvidenceAnchored == condition 1 AND condition 2 (spec-token consistency).
      // So cond1=true + anchored=false isolates the failure to condition 2.
      const cond1 = sharesEvidenceVocabulary(draft, EVIDENCE);
      const anchored = looksEvidenceAnchored(draft, EVIDENCE);
      const needsRepair = answerNeedsEvidenceAnchoringRepair(draft, EVIDENCE);
      // eslint-disable-next-line no-console
      console.log(
        `[anchor-diag] ${label.padEnd(24)} len=${String(draft.length).padStart(4)} `
        + `cond1(vocab)=${String(cond1).padEnd(5)} anchored=${String(anchored).padEnd(5)} needsRepair=${needsRepair}`,
      );
      expect(typeof needsRepair).toBe("boolean");
    }
  });

  // The decisive case for default-on. This answer is grounded, sourced and correct; it
  // merely ADDS context the findings did not cover (Node 22's codename, the 30-month LTS
  // window, when 26 becomes Active LTS). If the trigger fires here, enabling the flag
  // re-synthesizes good answers — cost with no correctness gain.
  it("FALSE POSITIVE CHECK: the real, well-grounded delivered answer", () => {
    const needsRepair = answerNeedsEvidenceAnchoringRepair(REAL_GROUNDED_ANSWER, EVIDENCE);
    const anchored = looksEvidenceAnchored(REAL_GROUNDED_ANSWER, EVIDENCE);
    const sharesVocab = sharesEvidenceVocabulary(REAL_GROUNDED_ANSWER, EVIDENCE);
    // eslint-disable-next-line no-console
    console.log(
      `\n[anchoring precision] real grounded answer -> needsRepair=${needsRepair} `
      + `looksEvidenceAnchored=${anchored} sharesEvidenceVocabulary=${sharesVocab}\n`,
    );
    // Pin whatever the current behaviour is, so a change to the detector is visible.
    expect(typeof needsRepair).toBe("boolean");
    // The lighter detector (used by the recovery path) must accept this answer.
    expect(sharesVocab).toBe(true);
  });

  // Control: is the failure cross-language (German answer over English findings), or
  // does the detector mis-fire even when answer and evidence share a language?
  it("CONTROL: all-English answer over all-English evidence", () => {
    const enEvidence = [
      "- nodejs_lts_version: Node.js 24 LTS (Codename: Krypton) - Latest patch: v24.18.0, First released: May 06, 2025, Last updated: Jun 23, 2026, Status: LTS",
      "claim: Node.js 24 (Krypton) is the current LTS version.",
      "source_url: https://nodejs.org/en/about/releases/",
      "publisher: OpenJS Foundation",
    ].join("\n");
    const enGrounded = `## Current Node.js LTS version

The current LTS release is **Node.js 24** (codename Krypton). The latest patch is v24.18.0.
It was first released on May 06, 2025 and last updated on Jun 23, 2026, and its status is LTS.

Source: https://nodejs.org/en/about/releases/ (OpenJS Foundation).`;
    const enUngrounded = `## Node.js LTS

The current long term support release is, as far as I recall, version 20, which carries the
codename Iron. It receives security patches for a good while and is generally the safe pick
for production deployments. New major releases appear every year and the even numbered ones
are promoted once they stabilise, so upgrading regularly is sensible practice for most teams.`;

    for (const [label, draft] of [["en grounded", enGrounded], ["en ungrounded", enUngrounded]] as const) {
      const cond1 = sharesEvidenceVocabulary(draft, enEvidence);
      const anchored = looksEvidenceAnchored(draft, enEvidence);
      const needsRepair = answerNeedsEvidenceAnchoringRepair(draft, enEvidence);
      // eslint-disable-next-line no-console
      console.log(
        `[anchor-diag EN] ${label.padEnd(14)} cond1(vocab)=${String(cond1).padEnd(5)} `
        + `anchored=${String(anchored).padEnd(5)} needsRepair=${needsRepair}`,
      );
    }
    // A grounded English answer is correctly left alone.
    expect(answerNeedsEvidenceAnchoringRepair(enGrounded, enEvidence)).toBe(false);
    // FALSE NEGATIVE (pinned, not endorsed): the fabricated "version 20 / Iron" answer is
    // judged anchored. It is pure prose — no spec-shaped token for condition 2 to falsify —
    // and it shares ≥3 generic vocabulary tokens with the evidence, so condition 1 passes.
    // This is the exact failure the flag exists to catch, and it slips through.
    expect(answerNeedsEvidenceAnchoringRepair(enUngrounded, enEvidence)).toBe(false);
  });

  it("length-scaling makes the trigger strictly more aggressive, never less", () => {
    for (const draft of [REAL_GROUNDED_ANSWER, STRICT_RESTATEMENT, UNGROUNDED_ANSWER]) {
      const plain = answerNeedsEvidenceAnchoringRepair(draft, EVIDENCE, false);
      const scaled = answerNeedsEvidenceAnchoringRepair(draft, EVIDENCE, true);
      if (plain) expect(scaled).toBe(true);
    }
  });
});
