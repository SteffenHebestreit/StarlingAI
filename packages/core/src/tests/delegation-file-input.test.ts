import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where a delegation's file can be, as the routed-candidate gate asks it (agent/delegation-file-input.ts).
 * Review of 891f902b: the gate dropped document_intake for files it did not see — an upload a
 * compacted history no longer shows, one the dashboard stored, a bare or non-ASCII name, an absolute
 * path, a folder, an upload held only by the S3 store. The gate-level cases are in
 * routed-upload-reader-gate.test.ts; these pin the tokenizer and the store's folder probe.
 */
const s3 = vi.hoisted(() => ({ sent: [] as Array<Record<string, unknown>>, answer: (() => ({ KeyCount: 0 })) as () => unknown }));
vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class ListObjectsV2Command extends Command {}
  class S3Client {
    async send(command: Command): Promise<unknown> {
      s3.sent.push({ command: command.constructor.name, ...command.input });
      return s3.answer();
    }
  }
  return { S3Client, ListObjectsV2Command };
});

describe("namedFileCandidates", () => {
  it("reads names in any script, whole, and quoted names with spaces", async () => {
    const { namedFileCandidates } = await import("../agent/delegation-file-input.js");
    // The ASCII path token read "ller.pdf" out of this.
    expect(namedFileCandidates("Bitte Lieferschein_Müller.pdf auslesen.")).toEqual(["Lieferschein_Müller.pdf"]);
    expect(namedFileCandidates("Die Datei „Lieferschein Müller.pdf“ auslesen")).toContain("Lieferschein Müller.pdf");
    expect(namedFileCandidates("Die Datei \"Bericht Q3.docx\" lesen")).toContain("Bericht Q3.docx");
  });

  it("keeps paths and folders, absolute or relative, without the punctuation around them", async () => {
    const { namedFileCandidates } = await import("../agent/delegation-file-input.js");
    expect(namedFileCandidates("Alles in (uploads/inbox/), dann /workspace/uploads/a.pdf.")).toEqual(["uploads/inbox/", "/workspace/uploads/a.pdf"]);
  });

  it("takes nothing from a URL", async () => {
    const { namedFileCandidates } = await import("../agent/delegation-file-input.js");
    expect(namedFileCandidates("Fetch http://www.nordlicht-werkzeuge.test/lager.html and https://x.test/a/b.pdf")).toEqual([]);
  });
});

describe("uploadFolderHoldsFile", () => {
  let workspace = "";

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), "sai-upload-folder-"));
    writeFileSync(join(workspace, "starlingai.json"), JSON.stringify({ workspacePath: workspace }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(workspace, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    s3.sent.length = 0;
    s3.answer = () => ({ KeyCount: 0 });
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    (await import("../config/loader.js")).resetConfigForTests();
    rmSync(workspace, { recursive: true, force: true });
    vi.resetModules();
  });

  it("on the local backend, finds a file a few levels down and none in an empty or missing folder", async () => {
    const { uploadFolderHoldsFile } = await import("../storage/object-store.js");
    mkdirSync(join(workspace, "uploads", "chat-a", "nested"), { recursive: true });
    writeFileSync(join(workspace, "uploads", "chat-a", "nested", "1760000000000-a.pdf"), "x");
    mkdirSync(join(workspace, "uploads", "chat-b"), { recursive: true });

    expect(await uploadFolderHoldsFile("uploads/chat-a")).toBe(true);
    expect(await uploadFolderHoldsFile("uploads/chat-b")).toBe(false);
    expect(await uploadFolderHoldsFile("uploads/chat-missing")).toBe(false);
    // A folder outside the caller's root is not one it may ask about.
    expect(await uploadFolderHoldsFile("../elsewhere")).toBeNull();
    expect(s3.sent).toEqual([]);
  });

  it("on S3, where no disk holds the upload, lists the folder's prefix for one key", async () => {
    const { getConfig } = await import("../config/loader.js");
    getConfig().storage.backend = "s3";
    const { uploadFolderHoldsFile } = await import("../storage/object-store.js");

    s3.answer = () => ({ KeyCount: 1, Contents: [{ Key: "uploads/chat-a/1760000000000-a.pdf" }] });
    expect(await uploadFolderHoldsFile("uploads/chat-a")).toBe(true);
    expect(s3.sent).toEqual([expect.objectContaining({ command: "ListObjectsV2Command", Prefix: "uploads/chat-a/", MaxKeys: 1 })]);

    s3.answer = () => ({ KeyCount: 0 });
    expect(await uploadFolderHoldsFile("uploads/chat-a")).toBe(false);

    // A store that does not answer cannot say there is none.
    s3.answer = () => { throw new Error("connection refused"); };
    expect(await uploadFolderHoldsFile("uploads/chat-a")).toBeNull();
  });
});

describe("delegationHasUserFile", () => {
  let workspace = "";

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), "sai-delegation-file-"));
    writeFileSync(join(workspace, "starlingai.json"), JSON.stringify({ workspacePath: workspace }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(workspace, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  afterEach(async () => {
    (await import("../agent/session.js")).resetSessionsForTests();
    delete process.env["SAI_CONFIG_PATH"];
    (await import("../config/loader.js")).resetConfigForTests();
    rmSync(workspace, { recursive: true, force: true });
    vi.resetModules();
  });

  const probe = (sessionId: string, task: string) => ({ sessionId, workspacePath: workspace, texts: [task] });

  it("takes a store that cannot tell for a folder that holds a file, and asks only this conversation's folder", async () => {
    const { createSession } = await import("../agent/session.js");
    const { delegationHasUserFile } = await import("../agent/delegation-file-input.js");
    createSession({ sessionId: "chat-x", channel: "test", workspacePath: workspace }).addMessage({ role: "user", content: "Briefing bitte." });
    const asked: string[] = [];
    const answering = (answer: boolean | null) => async (dir: string) => { asked.push(dir); return answer; };

    expect(await delegationHasUserFile(probe("workflow:chat-x:brief:1", "Die Website lesen."), answering(false))).toBe(false);
    expect(await delegationHasUserFile(probe("workflow:chat-x:brief:1", "Die Website lesen."), answering(null))).toBe(true);
    expect(await delegationHasUserFile(probe("sub:workflow:chat-x:brief:1:researcher:7", "Die Website lesen."), answering(true))).toBe(true);
    expect(asked).toEqual(["uploads/chat-x", "uploads/chat-x", "uploads/chat-x"]);
  });
});
