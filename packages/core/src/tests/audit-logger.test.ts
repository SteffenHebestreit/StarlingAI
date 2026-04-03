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
});

function readAuditMarkers(filePath: string): string[] {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { data?: { marker?: string } })
    .map((entry) => entry.data?.marker)
    .filter((marker): marker is string => typeof marker === "string");
}