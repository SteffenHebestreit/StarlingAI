import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeWorkspaceMemoryRecord } from "../memory/service.js";
import { computeMemoryCurationReport } from "../memory/steward.js";

describe("memory steward", () => {
  const dirs: string[] = [];
  let prevUserPath: string | undefined;

  beforeEach(() => {
    // Isolate user memory so the report doesn't read this machine's real store.
    prevUserPath = process.env["SAI_USER_MEMORY_PATH"];
    const userDir = mkdtempSync(join(tmpdir(), "starlingai-steward-user-"));
    dirs.push(userDir);
    process.env["SAI_USER_MEMORY_PATH"] = userDir;
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (prevUserPath === undefined) delete process.env["SAI_USER_MEMORY_PATH"];
    else process.env["SAI_USER_MEMORY_PATH"] = prevUserPath;
  });

  function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "starlingai-steward-"));
    dirs.push(dir);
    return dir;
  }

  it("reports no nudge for a clean store", () => {
    const ws = workspace();
    storeWorkspaceMemoryRecord(ws, { key: "fact-1", subject: "Project name", content: "The project is StarlingAI." });
    const report = computeMemoryCurationReport(ws);
    expect(report.totalRecords).toBe(1);
    expect(report.removableDuplicates).toBe(0);
    expect(report.nudge).toBe("");
  });

  it("detects duplicate clusters and emits a nudge", () => {
    const ws = workspace();
    const content = "The deployment runs nightly at 02:00 UTC and uploads to cold storage.";
    storeWorkspaceMemoryRecord(ws, { key: "dep-1", subject: "Deployment schedule", content });
    storeWorkspaceMemoryRecord(ws, { key: "dep-2", subject: "Deployment schedule", content });

    const report = computeMemoryCurationReport(ws);
    expect(report.removableDuplicates).toBeGreaterThanOrEqual(1);
    expect(report.nudge.toLowerCase()).toContain("duplicate");
    expect(report.nudge).toContain("curate_memory");
  });
});
