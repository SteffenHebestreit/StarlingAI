/**
 * Canonical evidence ledger (EVD-301, ADR-006).
 *
 * Append-only structured claims replace last-writer-wins string facts: nothing
 * is ever overwritten or silently truncated in the canonical record. A write
 * whose canonical subject matches an existing claim with a DIFFERENT normalized
 * value marks both sides disputed (visible conflict, `evidence_conflict_detected`
 * audit) instead of collapsing to one value. Prompts get a bounded projection;
 * truncation lives ONLY there. Rollout: `mission.evidence` (off | shadow) —
 * shadow dual-writes from share_evidence while legacy readers stay authoritative.
 */
import { randomUUID } from "node:crypto";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";

const log = childLogger("swarm:evidence-ledger");

const SESSION_TTL_S = 4 * 60 * 60;
const claimsKey = (sid: string) => `starlingai:evidence:${sid}:claims`;
const subjectsKey = (sid: string) => `starlingai:evidence:${sid}:subjects`;
const CLAIMS_MAX = 500;

export type EvidenceValidationState = "unverified" | "tentative" | "validated" | "disputed";
export type EvidenceRelationKind = "supports" | "contradicts" | "supersedes" | "derived_from";

export interface EvidenceClaimInput {
  subject: string;
  value: string;
  agent?: string;
  /** Source authority tier: official | primary | secondary | observed | derived. */
  evidenceType?: string;
  sourceTitle?: string;
  sourceUrl?: string;
  publisher?: string;
  publishedAt?: string;
  retrievedAt?: string;
  confidence?: { accuracy?: number; trustworthiness?: number; corroboration?: number };
  validationState?: EvidenceValidationState;
  relations?: Partial<Record<EvidenceRelationKind, string[]>>;
}

export interface EvidenceClaim extends EvidenceClaimInput {
  claimId: string;
  canonicalSubject: string;
  valueNorm: string;
  validationState: EvidenceValidationState;
  observedAt: string;
}

interface SubjectIndexEntry {
  claimIds: string[];
  valueNorms: string[];
  disputed: boolean;
  /** EVD-302: a decisive resolution (authority or recency supersession). The
   *  losing claims stay in the log — resolution is recorded, never deleted. */
  resolution?: { winnerClaimId: string; reason: string; at: string };
}

export function canonicalizeSubject(subject: string): string {
  return subject.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Currency symbol → ISO code. Symbols only: this is a rendering difference, not a
 *  semantic one. Currency CODES are deliberately left alone so USD vs EUR stays a
 *  real conflict — folding those would hide a genuine disagreement. */
// Plain strings, not /g regexes: `RegExp.test` on a global regex advances lastIndex,
// so reusing one across calls silently alternates between true and false.
const CURRENCY_SYMBOLS: ReadonlyArray<readonly [string, string]> = [
  ["$", "usd"], ["€", "eur"], ["£", "gbp"], ["¥", "jpy"], ["₹", "inr"], ["₽", "rub"],
];

/**
 * Canonicalize a numeric magnitude written in any locale, or null when the string
 * is not unambiguously one number.
 *
 * Separator disambiguation is structural, not locale-guessed:
 * - Both `.` and `,` present → the LAST one is the decimal mark (true in every
 *   common convention), the other is a group separator.
 * - One separator type, appearing more than once → group separator (1.234.567).
 * - One separator, once, followed by exactly 3 digits → depends on context:
 *   ambiguous for a BARE number ("1,299" is 1299 in en-US, 1.299 in de-DE), so it
 *   returns null rather than guess — reading it wrong would silently equate values
 *   1000x apart, which is far worse than leaving a formatting difference flagged.
 *   With `hasCurrency`, it is a GROUP separator: none of the currencies recognized
 *   here use 3 decimal places, so a 3-digit tail cannot be a fraction. That is what
 *   lets "$1,299" and "1299 USD" collapse without guessing.
 * - One separator, once, followed by 1-2 or 4+ digits → decimal mark.
 */
function canonicalNumber(raw: string, hasCurrency: boolean): string | null {
  if (!/^[0-9][0-9.,\s]*$/.test(raw)) return null;
  const s = raw.replace(/\s/g, "");
  const dot = s.lastIndexOf("."), comma = s.lastIndexOf(",");
  const dots = (s.match(/\./g) ?? []).length, commas = (s.match(/,/g) ?? []).length;

  let intPart: string, fracPart = "";
  if (dots > 0 && commas > 0) {
    const decIdx = Math.max(dot, comma);
    intPart = s.slice(0, decIdx).replace(/[.,]/g, "");
    fracPart = s.slice(decIdx + 1);
  } else if (dots + commas === 0) {
    intPart = s;
  } else if (dots > 1 || commas > 1) {
    intPart = s.replace(/[.,]/g, "");
  } else {
    const idx = Math.max(dot, comma);
    const after = s.length - idx - 1;
    if (after === 3) {
      if (!hasCurrency) return null; // bare number: genuinely ambiguous — do not merge
      intPart = s.replace(/[.,]/g, ""); // currency: 3-digit tail must be a group
    } else {
      intPart = s.slice(0, idx);
      fracPart = s.slice(idx + 1);
    }
  }
  if (!/^\d+$/.test(intPart) || (fracPart && !/^\d+$/.test(fracPart))) return null;
  const normFrac = fracPart.replace(/0+$/, "");
  const normInt = intPart.replace(/^0+(?=\d)/, "");
  return normFrac ? `${normInt}.${normFrac}` : normInt;
}

/**
 * Normalize a claim value for same-subject conflict detection.
 *
 * Beyond case/whitespace folding this canonicalizes NUMERIC values so that the same
 * quantity written differently stops registering as a contradiction: "$1,299",
 * "1299 USD" and "USD 1299.00" all collapse to `usd 1299`.
 *
 * Why it matters: the ledger's one behavioral consumer injects a "DISPUTED EVIDENCE …
 * an answer stating any of these as settled fact WITHOUT acknowledging the conflict
 * FAILS" block into the QA reviewer prompt. A purely textual comparison therefore
 * turned formatting variance into a hard QA failure on a CORRECT answer, plus a
 * wasted re-synthesis round.
 *
 * Fail-safe direction: when a value is not unambiguously numeric — including the
 * genuinely ambiguous "one separator + 3 digits" case — it falls through to the
 * original text normalization, so the pair stays distinct and is still flagged.
 * Over-merging would HIDE real conflicts, which is the worse failure; this only
 * removes cases where the values are provably the same number.
 */
export function normalizeValue(value: string): string {
  const text = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (!/\d/.test(text)) return text;

  let currency = "";
  let rest = text;
  for (const [symbol, code] of CURRENCY_SYMBOLS) {
    if (rest.includes(symbol)) { currency = code; rest = rest.split(symbol).join(" "); }
  }
  const codeMatch = rest.match(/\b(usd|eur|gbp|jpy|inr|rub|chf|cad|aud|cny)\b/);
  if (codeMatch) {
    // A symbol AND a different code (e.g. "$100 EUR") is contradictory on its face —
    // leave it to text comparison rather than silently picking one.
    if (currency && currency !== codeMatch[1]) return text;
    currency = codeMatch[1]!;
    rest = rest.replace(codeMatch[0], " ");
  }

  const numeric = canonicalNumber(rest.trim(), currency !== "");
  if (numeric === null) return text;
  return currency ? `${currency} ${numeric}` : numeric;
}

// ── Storage (Redis list+hash, local fallback) ───────────────────────────────

const _localClaims = new Map<string, EvidenceClaim[]>();
const _localSubjects = new Map<string, Map<string, SubjectIndexEntry>>();

let _redis: any = null;
let _redisReady = false;
let _redisConnecting: Promise<unknown | null> | null = null;

async function getRedis(): Promise<unknown | null> {
  if (_redisReady) return _redis;
  if (_redisConnecting) return _redisConnecting;
  const url = process.env["REDIS_URL"];
  if (!url) return null;
  _redisConnecting = (async () => {
    try {
      const ioredis = await import("ioredis") as any;
      const IORedis = ioredis.default ?? ioredis;
      _redis = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
      await (_redis as { connect: () => Promise<void> }).connect();
      _redisReady = true;
      return _redis;
    } catch (error) {
      log.warn({ error }, "Evidence ledger Redis connection failed — using in-process ledger");
      try { (_redis as { disconnect?: () => void } | null)?.disconnect?.(); } catch { /* ignore */ }
      _redis = null;
      return null;
    } finally {
      _redisConnecting = null;
    }
  })();
  return _redisConnecting;
}

async function readSubjectEntry(sessionId: string, canonicalSubject: string): Promise<SubjectIndexEntry | null> {
  const redis = await getRedis();
  if (redis) {
    try {
      const raw = await (redis as { hget: (k: string, f: string) => Promise<string | null> }).hget(subjectsKey(sessionId), canonicalSubject);
      return raw ? JSON.parse(raw) as SubjectIndexEntry : null;
    } catch { return null; }
  }
  return _localSubjects.get(sessionId)?.get(canonicalSubject) ?? null;
}

async function writeSubjectEntry(sessionId: string, canonicalSubject: string, entry: SubjectIndexEntry): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    try {
      const r = redis as { hset: (k: string, f: string, v: string) => Promise<number>; expire: (k: string, ttl: number) => Promise<number> };
      await r.hset(subjectsKey(sessionId), canonicalSubject, JSON.stringify(entry));
      await r.expire(subjectsKey(sessionId), SESSION_TTL_S);
      return;
    } catch { /* fall through to local */ }
  }
  const map = _localSubjects.get(sessionId) ?? new Map<string, SubjectIndexEntry>();
  map.set(canonicalSubject, entry);
  _localSubjects.set(sessionId, map);
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface AppendEvidenceResult {
  claim: EvidenceClaim;
  /** Set when this write surfaced a same-subject, different-value conflict. */
  conflictWith?: string[];
}

/** Append one immutable claim; conflicts are marked, never merged or overwritten. */
export async function appendEvidenceClaim(sessionId: string, input: EvidenceClaimInput): Promise<AppendEvidenceResult> {
  const canonicalSubject = canonicalizeSubject(input.subject);
  const valueNorm = normalizeValue(input.value);
  const existing = await readSubjectEntry(sessionId, canonicalSubject);
  const conflict = Boolean(existing && existing.valueNorms.length > 0 && !existing.valueNorms.includes(valueNorm));

  const claim: EvidenceClaim = {
    ...input,
    claimId: randomUUID(),
    canonicalSubject,
    valueNorm,
    validationState: conflict ? "disputed" : (input.validationState ?? "unverified"),
    observedAt: new Date().toISOString(),
  };

  const redis = await getRedis();
  if (redis) {
    try {
      const r = redis as {
        rpush: (k: string, v: string) => Promise<number>;
        ltrim: (k: string, s: number, e: number) => Promise<unknown>;
        expire: (k: string, ttl: number) => Promise<number>;
      };
      await r.rpush(claimsKey(sessionId), JSON.stringify(claim));
      await r.ltrim(claimsKey(sessionId), -CLAIMS_MAX, -1);
      await r.expire(claimsKey(sessionId), SESSION_TTL_S);
    } catch (error) {
      log.warn({ error, sessionId }, "Evidence claim Redis append failed — using in-process");
      const list = _localClaims.get(sessionId) ?? [];
      list.push(claim);
      if (list.length > CLAIMS_MAX) list.splice(0, list.length - CLAIMS_MAX);
      _localClaims.set(sessionId, list);
    }
  } else {
    const list = _localClaims.get(sessionId) ?? [];
    list.push(claim);
    if (list.length > CLAIMS_MAX) list.splice(0, list.length - CLAIMS_MAX);
    _localClaims.set(sessionId, list);
  }

  const nextEntry: SubjectIndexEntry = {
    claimIds: [...(existing?.claimIds ?? []), claim.claimId].slice(-20),
    valueNorms: existing?.valueNorms.includes(valueNorm) ? existing.valueNorms : [...(existing?.valueNorms ?? []), valueNorm].slice(-10),
    disputed: conflict || (existing?.disputed ?? false),
  };
  await writeSubjectEntry(sessionId, canonicalSubject, nextEntry);

  if (conflict) {
    logAudit("evidence_conflict_detected", {
      subject: canonicalSubject,
      newClaimId: claim.claimId,
      conflictingClaimIds: existing?.claimIds ?? [],
      agent: input.agent,
    }, { sessionId, severity: "warn" });
    return { claim, conflictWith: existing?.claimIds ?? [] };
  }
  return { claim };
}

export async function listEvidenceClaims(
  sessionId: string,
  opts: { subject?: string; limit?: number } = {},
): Promise<EvidenceClaim[]> {
  const limit = Math.max(1, Math.min(CLAIMS_MAX, opts.limit ?? CLAIMS_MAX));
  const redis = await getRedis();
  let claims: EvidenceClaim[];
  if (redis) {
    try {
      const raw = await (redis as { lrange: (k: string, s: number, e: number) => Promise<string[]> }).lrange(claimsKey(sessionId), 0, -1);
      claims = raw.map((value) => { try { return JSON.parse(value) as EvidenceClaim; } catch { return null; } })
        .filter((claim): claim is EvidenceClaim => claim !== null);
    } catch { claims = [...(_localClaims.get(sessionId) ?? [])]; }
  } else {
    claims = [...(_localClaims.get(sessionId) ?? [])];
  }
  if (opts.subject) {
    const canonical = canonicalizeSubject(opts.subject);
    claims = claims.filter((claim) => claim.canonicalSubject === canonical);
  }
  return claims.slice(-limit);
}

/** Disputed subjects for a session (the conflict engine's EVD-302 work queue). */
export async function listDisputedSubjects(sessionId: string): Promise<string[]> {
  const redis = await getRedis();
  let entries: Array<[string, SubjectIndexEntry]> = [];
  if (redis) {
    try {
      const raw = await (redis as { hgetall: (k: string) => Promise<Record<string, string>> }).hgetall(subjectsKey(sessionId));
      entries = Object.entries(raw ?? {}).map(([subject, value]) => {
        try { return [subject, JSON.parse(value) as SubjectIndexEntry] as [string, SubjectIndexEntry]; } catch { return null; }
      }).filter((entry): entry is [string, SubjectIndexEntry] => entry !== null);
    } catch { /* fall through */ }
  }
  if (entries.length === 0) entries = [...(_localSubjects.get(sessionId) ?? new Map()).entries()];
  return entries.filter(([, entry]) => entry.disputed).map(([subject]) => subject);
}

/**
 * Bounded prompt projection — truncation lives HERE, never in the record.
 * Disputed subjects surface both values explicitly instead of one silently.
 */
export async function formatEvidenceForPrompt(sessionId: string, opts: { maxChars?: number } = {}): Promise<string> {
  const maxChars = Math.max(300, Math.min(6_000, opts.maxChars ?? 2_000));
  const claims = await listEvidenceClaims(sessionId);
  if (claims.length === 0) return "";
  const disputed = new Set(await listDisputedSubjects(sessionId));
  const lines: string[] = ["## Evidence Claims (append-only; conflicts shown, not merged)"];
  // Newest first; one line per claim, source-attributed.
  for (const claim of [...claims].reverse()) {
    const source = claim.sourceUrl ? ` [${claim.sourceTitle ?? claim.sourceUrl}]` : "";
    const flag = disputed.has(claim.canonicalSubject) ? " ⚠DISPUTED" : "";
    const line = `- ${claim.subject}: ${claim.value.slice(0, 240)}${source} (${claim.validationState}${flag})`;
    if (lines.join("\n").length + line.length + 1 > maxChars) break;
    lines.push(line);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

// ── EVD-302: conflict & freshness engine ─────────────────────────────────────

/** Source authority ranking (plan: official > primary > secondary > observed > derived). */
const AUTHORITY_RANK: Record<string, number> = { official: 5, primary: 4, secondary: 3, observed: 2, derived: 1 };

function authorityOf(claim: EvidenceClaim): number {
  // A validated state is a mild boost WITHIN a tier; it never beats a tier gap.
  const base = AUTHORITY_RANK[claim.evidenceType ?? ""] ?? 0;
  return base * 10 + (claim.validationState === "validated" ? 1 : 0);
}

/** Ordering freshness: prefers explicit source dates, falls back to the ledger's
 *  own observedAt stamp — used only to order claims stably, NEVER to decide. */
function freshnessOf(claim: EvidenceClaim): number {
  const dated = claim.publishedAt ?? claim.retrievedAt ?? claim.observedAt;
  const ts = Date.parse(dated ?? "");
  return Number.isFinite(ts) ? ts : 0;
}

/** Decisive freshness: ONLY dates the SOURCE carries (published/retrieved).
 *  The auto-stamped observedAt is ingestion order, not evidence freshness — two
 *  undated same-tier claims appended milliseconds apart must stay a MATERIAL
 *  conflict, not resolve to whichever landed on the later millisecond (a flake
 *  the EVL-402 pack runner caught live). */
function explicitFreshnessOf(claim: EvidenceClaim): number {
  const dated = claim.publishedAt ?? claim.retrievedAt;
  const ts = Date.parse(dated ?? "");
  return Number.isFinite(ts) ? ts : 0;
}

export type ConflictResolution =
  | { subject: string; outcome: "resolved"; winner: EvidenceClaim; losers: EvidenceClaim[]; reason: string }
  | { subject: string; outcome: "material"; claims: EvidenceClaim[] }
  | { subject: string; outcome: "no_conflict" };

/**
 * Resolve one disputed subject: higher source authority supersedes; within the
 * same authority tier a decisively fresher claim supersedes; otherwise the
 * conflict is MATERIAL and becomes verification work (`evidence_verification_needed`
 * audit) — it is never silently collapsed. Losing claims remain in the log.
 */
export async function resolveSubjectConflict(sessionId: string, subject: string): Promise<ConflictResolution> {
  const canonical = canonicalizeSubject(subject);
  const claims = await listEvidenceClaims(sessionId, { subject: canonical });
  const distinctValues = new Set(claims.map((claim) => claim.valueNorm));
  if (distinctValues.size <= 1) return { subject: canonical, outcome: "no_conflict" };

  // One champion per distinct value: the strongest claim carrying that value.
  const champions = [...distinctValues].map((valueNorm) => {
    const carriers = claims.filter((claim) => claim.valueNorm === valueNorm);
    return carriers.sort((a, b) => authorityOf(b) - authorityOf(a) || freshnessOf(b) - freshnessOf(a))[0]!;
  });
  const ranked = [...champions].sort((a, b) => authorityOf(b) - authorityOf(a) || freshnessOf(b) - freshnessOf(a));
  const [top, runnerUp] = ranked;

  const authorityGap = authorityOf(top!) - authorityOf(runnerUp!);
  const topFresh = explicitFreshnessOf(top!);
  const runnerFresh = explicitFreshnessOf(runnerUp!);
  // Decisive: a strictly higher authority TIER (>=10 after scaling), or same tier
  // with both claims carrying EXPLICIT source dates and the winner strictly fresher.
  const decisive = authorityGap >= 10 || (authorityGap >= 0 && topFresh > 0 && runnerFresh > 0 && topFresh > runnerFresh);

  const existing = await readSubjectEntry(sessionId, canonical);
  if (decisive) {
    const reason = authorityGap >= 10
      ? "higher source authority supersedes"
      : "fresher claim from equal-or-higher authority supersedes";
    const losers = champions.filter((claim) => claim.claimId !== top!.claimId);
    await writeSubjectEntry(sessionId, canonical, {
      claimIds: existing?.claimIds ?? champions.map((claim) => claim.claimId),
      valueNorms: existing?.valueNorms ?? [...distinctValues],
      disputed: false,
      resolution: { winnerClaimId: top!.claimId, reason, at: new Date().toISOString() },
    });
    logAudit("evidence_conflict_resolved", {
      subject: canonical,
      winnerClaimId: top!.claimId,
      supersededClaimIds: losers.map((claim) => claim.claimId),
      reason,
    }, { sessionId, severity: "info" });
    return { subject: canonical, outcome: "resolved", winner: top!, losers, reason };
  }

  logAudit("evidence_verification_needed", {
    subject: canonical,
    claimIds: champions.map((claim) => claim.claimId),
    values: champions.map((claim) => claim.value.slice(0, 120)),
  }, { sessionId, severity: "warn" });
  return { subject: canonical, outcome: "material", claims: champions };
}

/** Sweep every disputed subject; material conflicts are the verification queue. */
export async function sweepEvidenceConflicts(sessionId: string): Promise<ConflictResolution[]> {
  const subjects = await listDisputedSubjects(sessionId);
  const results: ConflictResolution[] = [];
  for (const subject of subjects) {
    results.push(await resolveSubjectConflict(sessionId, subject));
  }
  return results;
}

/** Reset all state — for use in tests only. */
export async function resetEvidenceLedgerForTests(): Promise<void> {
  _localClaims.clear();
  _localSubjects.clear();
  if (_redis) {
    try { await (_redis as { quit: () => Promise<void> }).quit(); } catch { /* ignore */ }
  }
  _redis = null;
  _redisReady = false;
  _redisConnecting = null;
}
