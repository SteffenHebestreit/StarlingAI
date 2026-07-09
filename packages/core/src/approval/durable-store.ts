/**
 * Durable approval DECISION cache (opt-in, async channels).
 *
 * The in-memory approval store keeps each pending approval as a Promise
 * resolver, so a gateway restart while a slack/outbound_webhook approval is
 * outstanding loses the wait and the scene worker re-prompts when it re-runs
 * the interrupted step. When `orchestration.durableApprovals` is enabled, this
 * module caches the resolved DECISION (approvals only) keyed by a STABLE
 * idempotency key (job + step + tool + args) under the same on-disk state dir
 * as swarm checkpoints. On a restart the scene worker's re-run of the step
 * consults the cache and honours an already-granted approval instead of
 * re-prompting.
 *
 * Deliberately does NOT persist the pending approval itself (id / secret /
 * args): the cache only needs the outcome, and keeping approval secrets out of
 * disk preserves the pre-existing "approval material never touches disk"
 * property. Reuse is limited to CROSS-RESTART — a decision recorded in THIS
 * process is not reused within it (see `_resolvedThisSession`), so every gated
 * call in a live run is still prompted. Denials are never cached (a re-run
 * re-prompts), and cached approvals expire after 24h (fail-closed: a much-later
 * re-run prompts fresh). All file I/O is best-effort and never throws into the
 * approval path; every function no-ops unless the flag is enabled.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { childLogger } from "../logger.js";
import { getConfig } from "../config/loader.js";
import { PRODUCT } from "../product/index.js";

const log = childLogger("approval:durable");

/** How long a cached approval is honoured for a step re-run before a fresh
 *  prompt is required. Bounded so a much-later requeue re-prompts (fail-safe). */
const DECISION_TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours

interface DecisionRecord {
  idempotencyKey: string;
  approved: boolean;
  toolName?: string;
  resolvedAt: string;
  expiresAt: string;
}

/** Keys resolved in THIS process. A decision made now must NOT short-circuit a
 *  later identical gated call in the same run — only a genuine restart (fresh
 *  process, empty set) may reuse a decision persisted to disk. */
const _resolvedThisSession = new Set<string>();

export function durableApprovalsEnabled(): boolean {
  return getConfig().orchestration?.durableApprovals === true;
}

function approvalsDir(): string {
  return join(getConfig().workspacePath, PRODUCT.stateDirName, "approvals");
}

function ensureDir(): string {
  const dir = approvalsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function keyHash(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
}

function decisionPath(dir: string, idempotencyKey: string): string {
  return join(dir, `d_${keyHash(idempotencyKey)}.json`);
}

/**
 * Cache a GRANTED approval keyed by its stable idempotency key. Callers pass
 * only approvals here — denials are intentionally never cached so a re-run
 * re-prompts rather than being auto-denied on a stale decision.
 */
export function recordApprovalDecision(idempotencyKey: string, approved: boolean, toolName?: string): void {
  if (!durableApprovalsEnabled()) return;
  // Mark as resolved-this-process so a later identical gated call in the SAME
  // run is not silently short-circuited (only a restart may reuse it).
  _resolvedThisSession.add(idempotencyKey);
  try {
    const dir = ensureDir();
    const rec: DecisionRecord = {
      idempotencyKey,
      approved,
      toolName,
      resolvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + DECISION_TTL_MS).toISOString(),
    };
    writeFileSync(decisionPath(dir, idempotencyKey), JSON.stringify(rec, null, 2), "utf-8");
  } catch (err) {
    log.debug({ err }, "Failed to persist approval decision");
  }
}

/**
 * Look up a cached decision for a stable idempotency key. Returns the boolean outcome
 * only when a fresh (unexpired) decision from a PREVIOUS process exists, and CONSUMES it
 * (one-shot): the record is deleted and the key marked resolved, so a second lookup
 * re-prompts. Returns undefined within the same process (so a live run always re-prompts),
 * when absent/expired, or once already consumed. Expired records are pruned on read.
 */
export function lookupApprovalDecision(idempotencyKey: string): boolean | undefined {
  if (!durableApprovalsEnabled()) return undefined;
  // A decision made in THIS process must not suppress a later gated call here.
  if (_resolvedThisSession.has(idempotencyKey)) return undefined;
  const p = decisionPath(approvalsDir(), idempotencyKey);
  if (!existsSync(p)) return undefined;
  try {
    const rec = JSON.parse(readFileSync(p, "utf-8")) as DecisionRecord;
    if (new Date(rec.expiresAt).getTime() <= Date.now()) {
      try { unlinkSync(p); } catch { /* ignore */ }
      return undefined;
    }
    // CONSUME the decision — one-shot cross-restart reuse. Mark it resolved for this
    // process AND delete the file, so a SECOND identical gated call (later in this
    // restarted run, or after a further restart) re-prompts a human instead of the one
    // pre-restart grant silently auto-approving every identical call for the full TTL.
    // That preserves the module's own invariant that a live run always re-prompts.
    _resolvedThisSession.add(idempotencyKey);
    try { unlinkSync(p); } catch { /* ignore */ }
    return rec.approved;
  } catch {
    try { unlinkSync(p); } catch { /* ignore */ }
    return undefined;
  }
}

/** Delete expired decision files (housekeeping; called from the store sweep). */
export function pruneExpiredDecisions(): void {
  if (!durableApprovalsEnabled()) return;
  const dir = approvalsDir();
  if (!existsSync(dir)) return;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const file of files) {
    if (!file.startsWith("d_") || !file.endsWith(".json")) continue;
    const full = join(dir, file);
    try {
      const rec = JSON.parse(readFileSync(full, "utf-8")) as DecisionRecord;
      if (new Date(rec.expiresAt).getTime() <= now) unlinkSync(full);
    } catch {
      try { unlinkSync(full); } catch { /* ignore */ }
    }
  }
}

/**
 * Stable idempotency key for a scene/job approval: job + step-scope + tool +
 * args digest. The step scope keeps two DISTINCT gated steps that call the same
 * tool with the same args from sharing a decision; the job id + digest keep it
 * stable across a restart re-run of the SAME step.
 */
export function buildApprovalIdempotencyKey(
  jobId: string,
  toolName: string,
  args: Record<string, unknown>,
  scope?: string,
): string {
  let argsDigest = "0";
  try {
    argsDigest = createHash("sha256").update(stableStringify(args)).digest("hex").slice(0, 16);
  } catch { /* fall through with the placeholder digest */ }
  return `${jobId}:${scope ?? "turn"}:${toolName}:${argsDigest}`;
}

/** Deterministic JSON with sorted keys so equal args hash equally across runs. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Test-only: clear the in-process resolved-key set (simulate a fresh process). */
export function _resetDurableApprovalSessionForTests(): void {
  _resolvedThisSession.clear();
}
