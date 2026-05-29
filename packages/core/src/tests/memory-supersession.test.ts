import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  storeWorkspaceMemoryRecord,
  listWorkspaceMemoryRecords,
  _clearDurableMemoryCaches,
} from "../memory/service.js";
import { runMemoryConsolidationSweep } from "../memory/driver.js";

/**
 * Temporal supersession + sleep-time consolidation (gap-closure, May 2026).
 * A newer fact about the same explicit subject supersedes the older one so
 * stale values stop resurfacing (Zep/Graphiti-style validity); the idle
 * consolidation sweep is safe and additive.
 */
describe("durable memory — temporal supersession", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    _clearDurableMemoryCaches();
  });
  function ws(): string {
    const dir = mkdtempSync(join(tmpdir(), "starlingai-supersede-"));
    dirs.push(dir);
    return dir;
  }

  it("supersedes an older fact about the same subject and hides it from retrieval", () => {
    const workspacePath = ws();
    storeWorkspaceMemoryRecord(workspacePath, { key: "cloud_v1", subject: "cloud provider", content: "We use AWS for everything." });
    storeWorkspaceMemoryRecord(workspacePath, { key: "cloud_v2", subject: "cloud provider", content: "We migrated to GCP in March." });

    const records = listWorkspaceMemoryRecords(workspacePath);
    const contents = records.map((r) => r.content).join("\n");
    expect(contents).toContain("migrated to GCP");
    expect(contents).not.toContain("use AWS for everything");
    expect(records).toHaveLength(1);
  });

  it("does not supersede records about different subjects", () => {
    const workspacePath = ws();
    storeWorkspaceMemoryRecord(workspacePath, { key: "a", subject: "preferred microphone", content: "INMP441 is the pick." });
    storeWorkspaceMemoryRecord(workspacePath, { key: "b", subject: "preferred mcu", content: "ESP32-S3 is the pick." });

    expect(listWorkspaceMemoryRecords(workspacePath)).toHaveLength(2);
  });

  it("does not supersede when the same subject is re-stated with the same content", () => {
    const workspacePath = ws();
    storeWorkspaceMemoryRecord(workspacePath, { key: "x1", subject: "license", content: "MIT licensed." });
    storeWorkspaceMemoryRecord(workspacePath, { key: "x2", subject: "license", content: "MIT licensed." });
    // Same value under the same subject is not an update → both retained.
    expect(listWorkspaceMemoryRecords(workspacePath)).toHaveLength(2);
  });
});

describe("sleep-time memory consolidation sweep", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    _clearDurableMemoryCaches();
  });
  function ws(): string {
    const dir = mkdtempSync(join(tmpdir(), "starlingai-sweep-"));
    dirs.push(dir);
    return dir;
  }

  it("returns a zeroed result on an empty workspace and never throws", async () => {
    const result = await runMemoryConsolidationSweep(ws());
    expect(result).toEqual({ merged: 0, removed: 0, embeddingsRefreshed: 0 });
  });

  it("runs cleanly over a populated store (no embedding provider in test)", async () => {
    const workspacePath = ws();
    storeWorkspaceMemoryRecord(workspacePath, { key: "k1", subject: "fact one", content: "A durable fact worth keeping around." });
    storeWorkspaceMemoryRecord(workspacePath, { key: "k2", subject: "fact two", content: "Another durable fact, distinct from the first." });
    const result = await runMemoryConsolidationSweep(workspacePath);
    // No provider in test → no embedding backfill; distinct facts → no merge.
    expect(result.embeddingsRefreshed).toBe(0);
    expect(listWorkspaceMemoryRecords(workspacePath).length).toBeGreaterThanOrEqual(1);
  });
});
