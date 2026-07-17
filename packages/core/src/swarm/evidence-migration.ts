/**
 * EVD-303 slice 1: legacy-to-ledger migration parity.
 *
 * During the shadow phase the legacy shared-facts store remains the
 * authoritative READ path while every write is dual-recorded in the evidence
 * ledger (share_evidence rich claims, FACT: extractions as unverified). This
 * sweep measures whether the two stores actually agree — the DoD's "shadow
 * comparison shows parity" — and BACKFILLS legacy facts the ledger is missing
 * (records that predate the dual-write, or writes whose ledger append failed)
 * as unverified migration claims, so the ledger converges instead of silently
 * drifting. Reads stay legacy until parity holds; rollback is trivial because
 * nothing consumes the ledger for answers yet.
 */
import { getConfig } from "../config/loader.js";
import { logAudit } from "../audit/logger.js";
import { readAllFacts } from "./memory.js";
import { appendEvidenceClaim, canonicalizeSubject, listEvidenceClaims } from "./evidence-ledger.js";

export interface EvidenceMigrationParity {
  /** Facts in the legacy shared-facts store. */
  legacyFacts: number;
  /** Claims in the evidence ledger before this sweep. */
  ledgerClaims: number;
  /** Legacy facts backfilled into the ledger by THIS sweep (as unverified). */
  backfilled: number;
  /** Ledger subjects with no legacy counterpart (expected: rich share_evidence
   *  records use claim sentences as subjects, not fact keys). */
  ledgerOnly: number;
}

/**
 * Compare the legacy shared facts of a root session against its evidence
 * ledger, backfill what the ledger is missing, and emit parity telemetry.
 * Returns null when the evidence ledger is off (nothing to compare against).
 */
export async function sweepEvidenceMigrationParity(rootSessionId: string): Promise<EvidenceMigrationParity | null> {
  if (getConfig().mission.evidence !== "shadow") return null;

  const legacy = await readAllFacts(rootSessionId);
  const claims = await listEvidenceClaims(rootSessionId);
  const ledgerSubjects = new Set(claims.map((claim) => claim.canonicalSubject));

  let backfilled = 0;
  for (const [key, value] of Object.entries(legacy)) {
    if (ledgerSubjects.has(canonicalizeSubject(key))) continue;
    try {
      await appendEvidenceClaim(rootSessionId, {
        subject: key,
        value,
        agent: "evidence_migration_backfill",
        evidenceType: "observed",
        validationState: "unverified",
      });
      backfilled++;
    } catch {
      // Best-effort: a failed backfill shows up again on the next sweep.
    }
  }

  const legacyCanonical = new Set(Object.keys(legacy).map((key) => canonicalizeSubject(key)));
  const ledgerOnly = [...ledgerSubjects].filter((subject) => !legacyCanonical.has(subject)).length;

  const parity: EvidenceMigrationParity = {
    legacyFacts: Object.keys(legacy).length,
    ledgerClaims: claims.length,
    backfilled,
    ledgerOnly,
  };
  // Backfills mean the dual-write missed records — worth a warn while shadow
  // parity is being judged; a clean sweep is quiet routine telemetry.
  logAudit("evidence_migration_parity", { ...parity }, {
    sessionId: rootSessionId,
    severity: backfilled > 0 ? "warn" : "info",
  });
  return parity;
}
