import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../config/loader.js";
import { PRODUCT } from "../product/index.js";
import {
  buildApprovalIdempotencyKey,
  durableApprovalsEnabled,
  lookupApprovalDecision,
  recordApprovalDecision,
  pruneExpiredDecisions,
  _resetDurableApprovalSessionForTests,
} from "../approval/durable-store.js";
import {
  createPendingApproval,
  resolveApproval,
  listPendingApprovals,
} from "../approval/store.js";

let workspacePath: string;

function mockConfig(durableApprovals: boolean): void {
  vi.spyOn(configLoader, "getConfig").mockReturnValue(
    { workspacePath, orchestration: { durableApprovals } } as unknown as ReturnType<typeof configLoader.getConfig>,
  );
}

function approvalsDir(): string {
  return join(workspacePath, PRODUCT.stateDirName, "approvals");
}

/** Simulate a gateway restart: a decision on disk written by a "previous"
 *  process is honoured only after the in-process resolved-set is cleared. */
function simulateRestart(): void {
  _resetDurableApprovalSessionForTests();
}

describe("durable approvals (decision cache)", () => {
  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), "sai-durable-appr-"));
    _resetDurableApprovalSessionForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetDurableApprovalSessionForTests();
    try { rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("builds a stable, key-order-independent, step-scoped idempotency key", () => {
    const a = buildApprovalIdempotencyKey("job1", "http_request", { url: "x", method: "POST" }, "step0");
    const b = buildApprovalIdempotencyKey("job1", "http_request", { method: "POST", url: "x" }, "step0");
    const c = buildApprovalIdempotencyKey("job1", "http_request", { url: "y", method: "POST" }, "step0");
    const d = buildApprovalIdempotencyKey("job1", "http_request", { url: "x", method: "POST" }, "step1");
    expect(a).toBe(b);            // key-order independent
    expect(a).not.toBe(c);        // different args → different key
    expect(a).not.toBe(d);        // different step scope → different key (no collision)
    expect(a.startsWith("job1:step0:http_request:")).toBe(true);
  });

  it("no-ops entirely when the flag is disabled", () => {
    mockConfig(false);
    expect(durableApprovalsEnabled()).toBe(false);
    recordApprovalDecision("k", true);
    simulateRestart();
    expect(lookupApprovalDecision("k")).toBeUndefined();
    expect(existsSync(approvalsDir())).toBe(false); // nothing written to disk
  });

  it("does NOT reuse a decision within the same process (every live gated call re-prompts)", () => {
    mockConfig(true);
    const key = buildApprovalIdempotencyKey("jobA", "http_request", { url: "https://x" }, "step0");
    recordApprovalDecision(key, true, "http_request");
    // Same process → suppressed, so a repeat call in the same run still prompts.
    expect(lookupApprovalDecision(key)).toBeUndefined();
  });

  it("honours a cached approval only after a restart (fresh process reads disk)", () => {
    mockConfig(true);
    const key = buildApprovalIdempotencyKey("jobB", "http_request", { url: "https://y" }, "step0");
    recordApprovalDecision(key, true, "http_request");
    expect(lookupApprovalDecision(key)).toBeUndefined(); // same process
    simulateRestart();
    expect(lookupApprovalDecision(key)).toBe(true);       // post-restart honour
    // An unrelated key is unaffected.
    expect(lookupApprovalDecision("other")).toBeUndefined();
  });

  it("consumes a reused decision ONE-SHOT: a second identical gated call re-prompts", () => {
    mockConfig(true);
    const key = buildApprovalIdempotencyKey("jobC", "http_request", { url: "https://z" }, "step0");
    recordApprovalDecision(key, true, "http_request");
    simulateRestart();
    expect(lookupApprovalDecision(key)).toBe(true);        // first post-restart call reuses the grant
    expect(lookupApprovalDecision(key)).toBeUndefined();   // second call re-prompts (grant consumed)
    // The decision file was deleted on consume: even a further restart (which clears the
    // in-memory resolved-set) cannot resurrect it — proving the on-disk record is gone.
    simulateRestart();
    expect(lookupApprovalDecision(key)).toBeUndefined();
    expect(readdirSync(approvalsDir()).filter((f) => f.startsWith("d_")).length).toBe(0);
  });

  it("caches a GRANTED approval on resolve; a DENIAL is never cached (re-run re-prompts)", () => {
    mockConfig(true);
    const grantKey = buildApprovalIdempotencyKey("jobC", "http_request", { url: "https://ok" }, "step0");
    const denyKey = buildApprovalIdempotencyKey("jobC", "http_request", { url: "https://no" }, "step1");

    const grant = createPendingApproval({ toolName: "http_request", args: { url: "https://ok" }, timeoutMs: 60_000, idempotencyKey: grantKey });
    const deny = createPendingApproval({ toolName: "http_request", args: { url: "https://no" }, timeoutMs: 60_000, idempotencyKey: denyKey });
    expect(listPendingApprovals().some(p => p.id === grant.id)).toBe(true);

    resolveApproval(grant.id, true);
    resolveApproval(deny.id, false);

    return Promise.all([grant.promise, deny.promise]).then(([a, b]) => {
      expect(a).toBe(true);
      expect(b).toBe(false);
      simulateRestart();
      expect(lookupApprovalDecision(grantKey)).toBe(true);      // approval cached
      expect(lookupApprovalDecision(denyKey)).toBeUndefined();  // denial NOT cached
    });
  });

  it("does not persist any pending record or secret to disk", () => {
    mockConfig(true);
    const key = buildApprovalIdempotencyKey("jobD", "http_request", {}, "step0");
    const { id } = createPendingApproval({ toolName: "http_request", args: {}, timeoutMs: 60_000, secret: "s3cr3t", idempotencyKey: key });
    // No p_<id>.json (pending records are never persisted).
    const dir = approvalsDir();
    const files = existsSync(dir) ? readdirSync(dir) : [];
    expect(files.some(f => f.startsWith("p_"))).toBe(false);
    resolveApproval(id, true);
  });

  it("auto-denies (does not cache) on timeout", async () => {
    mockConfig(true);
    const key = buildApprovalIdempotencyKey("jobE", "http_request", {}, "step0");
    const { promise } = createPendingApproval({ toolName: "http_request", args: {}, timeoutMs: 15, idempotencyKey: key });
    const approved = await promise;
    expect(approved).toBe(false);
    simulateRestart();
    expect(lookupApprovalDecision(key)).toBeUndefined(); // timeout is never cached
  });

  it("prunes expired decision files", () => {
    mockConfig(true);
    const dir = approvalsDir();
    mkdirSync(dir, { recursive: true });
    // Hand-write an already-expired decision record.
    const key = buildApprovalIdempotencyKey("jobF", "http_request", {}, "step0");
    recordApprovalDecision(key, true);
    // Overwrite with an expired timestamp.
    const files = readdirSync(dir).filter(f => f.startsWith("d_"));
    expect(files.length).toBe(1);
    writeFileSync(join(dir, files[0]!), JSON.stringify({
      idempotencyKey: key, approved: true,
      resolvedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    }), "utf-8");
    pruneExpiredDecisions();
    expect(readdirSync(dir).filter(f => f.startsWith("d_")).length).toBe(0);
  });
});
