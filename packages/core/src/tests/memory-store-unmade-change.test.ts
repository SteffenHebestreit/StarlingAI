import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tools/registry.js";

/**
 * A STORED FACT IS NOT HOW A CHANGE IS MADE.
 *
 * E2E 2026-10-22: asked to update a heading in a file that did not exist, the orchestrator first
 * stored "the heading … was updated to …" as a workspace fact, then looked and found no file. Its
 * reply was honest; the fact stayed, for later turns to recall.
 */
const { getTool } = await import("../tools/registry.js");
await import("../tools/memory.js");
const { createSession, resetSessionsForTests } = await import("../agent/session.js");
const { _clearDurableMemoryCaches, listWorkspaceMemoryRecords } = await import("../memory/service.js");

const UPDATE = "Aktualisiere die Datei generated/aktionen/herbst.html: Die Hauptüberschrift soll „Herbstaktion 2026“ lauten. Lege dafür keine neue Datei an.";
const CLAIM = "Die Hauptüberschrift der Datei generated/aktionen/herbst.html wurde auf „Herbstaktion 2026“ aktualisiert.";

describe("memory_store on a turn that asked for a change", () => {
  let workspace = "";
  beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), "sai-memory-unmade-")); });
  afterEach(() => {
    resetSessionsForTests();
    _clearDurableMemoryCaches();
    rmSync(workspace, { recursive: true, force: true });
  });

  const turn = (request: string) => {
    const session = createSession({ channel: "test", workspacePath: workspace, systemPrompt: "You are a test agent." });
    session.addMessage({ role: "user", content: request });
    return session;
  };
  const store = (sessionId: string, content: string) =>
    getTool("memory_store")!.execute({ key: "herbstaktion_heading", content, kind: "fact" }, { sessionId, workspacePath: workspace } as ToolContext);
  const stored = () => listWorkspaceMemoryRecords(workspace).map((record) => record.key);

  it("refuses to record the change as done before anything was changed", async () => {
    const session = turn(UPDATE);
    const result = await store(session.id, CLAIM);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Not stored: this states the change the user asked for as done/);
    expect(stored()).toEqual([]);
  });

  it("records it once this turn has produced the file", async () => {
    const session = turn(UPDATE);
    session.addMessage({ role: "assistant", content: "", tool_calls: [{ id: "d1", type: "function", function: { name: "delegate_to_agent", arguments: "{}" } }] });
    session.addMessage({ role: "tool", tool_call_id: "d1", content: "Delegated result from web_coder — TASK COMPLETED.", metadata: { artifacts: [{ outputPath: "generated/aktionen/herbst.html", filename: "herbst.html" }] } });
    expect((await store(session.id, CLAIM)).success).toBe(true);
    expect(stored()).toEqual(["herbstaktion_heading"]);
  });

  it("records what actually happened", async () => {
    const session = turn(UPDATE);
    const result = await store(session.id, "Die Datei generated/aktionen/herbst.html existiert nicht; die Überschrift wurde nicht geändert.");
    expect(result.success).toBe(true);
  });

  it("records a fact on a turn that asked for no change", async () => {
    const session = turn("Merk dir bitte: die Herbstaktion startet am 1. Oktober.");
    expect((await store(session.id, CLAIM)).success).toBe(true);
  });

  it("leaves a specialist's write alone: its file reaches the turn only when its delegation returns", async () => {
    const session = turn(UPDATE);
    expect((await store(`sub:${session.id}:web_coder:1`, CLAIM)).success).toBe(true);
  });
});
