import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("audit logger", () => {
  afterEach(() => {
    delete process.env["SAI_AUDIT_LOG"];
    vi.resetModules();
  });

  it("honors updated SAI_AUDIT_LOG paths between writes", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-audit-logger-"));
    const firstAuditPath = join(tempDir, "first", "audit.jsonl");
    const secondAuditPath = join(tempDir, "second", "audit.jsonl");

    try {
      process.env["SAI_AUDIT_LOG"] = firstAuditPath;
      const audit = await import("../audit/logger.js");

      audit.logAudit("auth_failure", { marker: "first" }, { severity: "warn" });
      await audit.flushAuditLog();

      process.env["SAI_AUDIT_LOG"] = secondAuditPath;
      audit.logAudit("auth_failure", { marker: "second" }, { severity: "warn" });
      await audit.flushAuditLog();

      expect(readAuditMarkers(firstAuditPath)).toEqual(["first"]);
      expect(readAuditMarkers(secondAuditPath)).toEqual(["second"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("redacts sensitive keys and secret-shaped values before writing or publishing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-audit-redaction-"));
    const auditPath = join(tempDir, "audit.jsonl");
    try {
      process.env["SAI_AUDIT_LOG"] = auditPath;
      const audit = await import("../audit/logger.js");
      const received: unknown[] = [];
      const unsubscribe = audit.subscribeToAudit((event) => received.push(event.data));
      audit.logAudit("tool_call_requested", {
        authorization: "Bearer should-not-persist",
        nested: { apiKey: "also-hidden" },
        providerOutput: "token=ghp_abcdefghijklmnopqrstuvwxyz1234567890",
        marker: "safe",
      });
      await audit.flushAuditLog();
      unsubscribe();

      const written = readFileSync(auditPath, "utf8");
      expect(written).not.toContain("should-not-persist");
      expect(written).not.toContain("also-hidden");
      expect(written).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
      expect(written).toContain("safe");
      expect(JSON.stringify(received)).not.toContain("should-not-persist");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("tracks queued audit writes for readiness consumers", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-audit-status-"));
    try {
      process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
      const audit = await import("../audit/logger.js");
      await audit.flushAuditLog(); // drain any writes from sibling tests first
      audit.logAudit("auth_failure", { marker: "status" });
      // The write is enqueued synchronously but completes asynchronously, so it
      // must be counted as pending before the flush drains it.
      expect(audit.getAuditWriteStatus().pendingWrites).toBeGreaterThanOrEqual(1);
      await audit.flushAuditLog();
      expect(audit.getAuditWriteStatus().pendingWrites).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves non-secret telemetry fields whose names include token", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-audit-telemetry-"));
    try {
      process.env["SAI_AUDIT_LOG"] = join(tempDir, "audit.jsonl");
      const audit = await import("../audit/logger.js");
      audit.logAudit("turn_performance", { promptTokens: 42, completionTokens: 7, apiToken: "hide-me" });
      await audit.flushAuditLog();
      const body = readFileSync(process.env["SAI_AUDIT_LOG"]!, "utf8");
      expect(body).toContain('"promptTokens":42');
      expect(body).toContain('"completionTokens":7');
      expect(body).not.toContain("hide-me");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function readAuditMarkers(filePath: string): string[] {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { data?: { marker?: string } })
    .map((entry) => entry.data?.marker)
    .filter((marker): marker is string => typeof marker === "string");
}