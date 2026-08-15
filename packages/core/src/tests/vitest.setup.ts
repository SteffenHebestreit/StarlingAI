// Suite-wide test isolation, applied before any test module is imported.
//
// Why this exists: audit writes resolve their destination lazily, per write
// (audit/logger.ts enqueueWrite -> resolveAuditLogPath). With SAI_AUDIT_LOG
// unset that falls back to `resolve(process.cwd(), ".starlingai", "audit.jsonl")`
// — and because vitest runs from packages/core, every unisolated test appended
// to the real packages/core/.starlingai/audit.jsonl in the source tree. Only 19
// of ~291 test files set SAI_AUDIT_LOG or mocked the logger themselves, so the
// file had grown into the hundreds of KB of accumulated test events.
//
// Setting a temp default fixes the bulk of it, but ~14 test files `delete
// process.env["SAI_AUDIT_LOG"]` in their own cleanup, and every test shares one
// process (maxWorkers: 1) — so a single delete re-exposed the repo path for
// everything that ran afterwards. Re-asserting the default around each test
// closes that window without editing all 14 files.
//
// Tests that set SAI_AUDIT_LOG themselves still win: resolution happens per
// write, the hooks below only fill in a value when there is none, and this
// file's hooks run before each test file's own. No test asserts the
// process.cwd() fallback, so nothing depends on the variable being unset.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

const FALLBACK_AUDIT_LOG = join(mkdtempSync(join(tmpdir(), "sai-test-audit-")), "audit.jsonl");

function ensureAuditLogRedirected(): void {
  if (!process.env["SAI_AUDIT_LOG"]?.trim()) {
    process.env["SAI_AUDIT_LOG"] = FALLBACK_AUDIT_LOG;
  }
}

ensureAuditLogRedirected();
beforeEach(ensureAuditLogRedirected);
afterEach(ensureAuditLogRedirected);
