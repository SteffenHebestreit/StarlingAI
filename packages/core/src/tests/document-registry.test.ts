import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as loaderModule from "../config/loader.js";
import {
  registerDocument,
  unregisterDocument,
  listRegistry,
  markDocumentInvalidated,
  type DocumentRegistryEntry,
} from "../retrieval/document-registry.js";

let workspacePath: string;

beforeEach(() => {
  workspacePath = mkdtempSync(join(tmpdir(), "starlingai-doc-registry-"));
  const realConfig = loaderModule.getConfig();
  vi.spyOn(loaderModule, "getConfig").mockReturnValue({ ...realConfig, workspacePath } as typeof realConfig);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(workspacePath, { recursive: true, force: true });
});

function entry(source: string, overrides: Partial<DocumentRegistryEntry> = {}): DocumentRegistryEntry {
  return {
    documentId: "docA",
    scope: source.startsWith("user:") ? "user" : source.startsWith("workspace:") ? "workspace" : "session",
    source,
    filename: "cv.pdf",
    ingestedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("document registry invalidation marker (engram Phase 3)", () => {
  it("markDocumentInvalidated stamps every entry of the document, and only that document", async () => {
    await registerDocument(entry("session:s1"));
    await registerDocument(entry("user:u1"));
    await registerDocument(entry("session:s1", { documentId: "docB", filename: "other.pdf" }));

    await markDocumentInvalidated("docA", "2026-07-06T10:00:00.000Z");

    const entries = await listRegistry();
    const docA = entries.filter((e) => e.documentId === "docA");
    expect(docA).toHaveLength(2);
    expect(docA.every((e) => e.invalidatedAt === "2026-07-06T10:00:00.000Z")).toBe(true);
    expect(entries.find((e) => e.documentId === "docB")?.invalidatedAt).toBeUndefined();
  });

  it("re-registration (re-ingest reinstates) clears the marker on ALL of the document's entries", async () => {
    await registerDocument(entry("session:s1"));
    await registerDocument(entry("user:u1"));
    await markDocumentInvalidated("docA");
    expect((await listRegistry()).every((e) => e.invalidatedAt)).toBe(true);

    // Re-ingest lands under ONE scope, but engram reinstates the whole document —
    // the marker must clear from the other scope's entry too.
    await registerDocument(entry("session:s1"));

    const entries = await listRegistry();
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.invalidatedAt === undefined)).toBe(true);
  });

  it("unregister still works with a marker set, and a marker survives unrelated registrations", async () => {
    await registerDocument(entry("session:s1"));
    await markDocumentInvalidated("docA");
    await registerDocument(entry("session:s2", { documentId: "docB" })); // unrelated doc

    let entries = await listRegistry();
    expect(entries.find((e) => e.documentId === "docA")?.invalidatedAt).toBeDefined();

    const removed = await unregisterDocument("docA");
    expect(removed).toHaveLength(1);
    entries = await listRegistry();
    expect(entries.map((e) => e.documentId)).toEqual(["docB"]);
  });
});
