import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { PRODUCT } from "../product/index.js";
import { testAccount } from "./support/test-account.js";

/**
 * The upload store and every fallback that reads through it, under multi-user auth.
 *
 * Each account's agents work in `<shared>/users/<id>`, and a tool that misses a file on that disk
 * asks the store, because under S3 an attachment is nowhere else. The store took the path the
 * caller computed against ITS OWN root and joined it to the SHARED root (S3: one flat namespace),
 * so account A's extract_file_content("users/<B>/generated/x.pdf") missed on A's disk and was then
 * answered with B's file; ".starlingai/users/<B>/memory/..." read B's memory. The same key went
 * into the document registry, from which removing a document deleted the file at that path under
 * the shared root, and the download route served whichever account's entry came first.
 */

const s3Sent = vi.hoisted(() => [] as Array<{ command: string; key: unknown }>);
vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class PutObjectCommand extends Command {}
  class GetObjectCommand extends Command {}
  class DeleteObjectCommand extends Command {}
  class HeadBucketCommand extends Command {}
  class CreateBucketCommand extends Command {}
  class S3Client {
    async send(command: Command): Promise<unknown> {
      s3Sent.push({ command: command.constructor.name, key: command.input["Key"] });
      if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => new TextEncoder().encode("from-s3") } };
      return {};
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand };
});

const SECRET = "u".repeat(40);
const FILE_DIR = mkdtempSync(join(tmpdir(), "starlingai-upload-namespace-"));
const CONFIG_PATH = join(FILE_DIR, "starlingai.json");
const alice = testAccount("alice");
const bob = testAccount("bob");
const ALICE = { userId: "alice", account: alice.id };
const BOB = { userId: "bob", account: bob.id };
const BOB_FILE = `users/${bob.id}/generated/secret.pdf`;
const BOB_MEMORY = `${PRODUCT.stateDirName}/users/${bob.id}/memory/k.json`;
let shared = "";
let port = 0;

async function loadModules() {
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: SECRET } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_SESSION_STORE"] = join(FILE_DIR, "sessions.json");
  process.env["SAI_MASTER_KEY"] = "m".repeat(32);
  process.env["SAI_CRED_STORE"] = join(FILE_DIR, PRODUCT.stateDirName, "credentials.enc");
  process.env["SAI_JOB_WAKE_DISABLED"] = "1";
  process.env["SAI_AUDIT_LOG"] = join(FILE_DIR, "audit.jsonl");
  const loader = await import("../config/loader.js");
  const registry = await import("../runtime/account-registry.js");
  const auth = await import("../gateway/auth.js");
  const context = await import("../runtime/request-context.js");
  const store = await import("../storage/object-store.js");
  const rag = await import("../retrieval/document-rag.js");
  const engram = await import("../retrieval/engram.js");
  const sessions = await import("../agent/session.js");
  const tools = await import("../tools/registry.js");
  await import("../tools/multimodal.js");
  await import("../tools/documents.js");
  return { loader, registry, auth, context, store, rag, engram, sessions, tools };
}

let mods: Awaited<ReturnType<typeof loadModules>>;

beforeAll(async () => {
  mods = await loadModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  s3Sent.length = 0;
  mods.sessions.resetSessionsForTests();
  mods.auth.resetAuthStateForTests();
});

afterAll(() => {
  mods.loader.resetConfigForTests();
  for (const key of ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_SESSION_STORE", "SAI_MASTER_KEY", "SAI_CRED_STORE", "SAI_JOB_WAKE_DISABLED", "SAI_AUDIT_LOG"]) delete process.env[key];
  rmSync(FILE_DIR, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/** A fresh deployment: Bob's file and memory in place, and the registry every account shares. */
function configure(backend: "local" | "s3"): void {
  shared = mkdtempSync(join(FILE_DIR, "ws-"));
  port = 19700 + Math.floor(Math.random() * 90);
  writeFileSync(CONFIG_PATH, JSON.stringify({
    gateway: { jwtSecret: SECRET, port, turnTimeoutMs: 30_000 },
    workspacePath: shared,
    auth: { enabled: true, users: [alice.record, bob.record] },
    storage: { backend, s3: { endpoint: "http://seaweed.test:8333", bucket: "uploads-test" } },
    retrieval: { documentRag: { enabled: true, autoIngestAttachments: true, injectContext: false } },
    multimodal: {
      files: { baseUrl: "http://files.test", timeoutMs: 5_000, toolName: "file_to_markdown" },
      tts: { baseUrl: "http://tts.test", api: "qwen-compatible", timeoutMs: 5_000 },
    },
  }), "utf8");
  mods.loader.resetConfigForTests();
  mods.loader.loadConfig();
  mods.registry.resetAccountRegistryForTests();
  mods.store._resetObjectStoreForTests();
  write(join(shared, BOB_FILE), "BOB-SECRET-PDF");
  write(join(shared, BOB_MEMORY), "BOB-MEMORY");
  write(join(shared, "uploads", ".registry.json"), "{\"entries\":[]}\n");
}

const rootOf = (who: { account: string }) => join(shared, "users", who.account);
const as = <T>(who: typeof ALICE, fn: () => Promise<T>): Promise<T> => mods.context.runWithRequestContext({ identity: who }, fn);
const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);

/** The file-conversion service: echoes the file it is sent as its markdown, and records it. */
function stubConversion(): string[] {
  const converted: string[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("http://files.test")) return realFetch(input, init);
    const file = (init?.body as FormData).get("file") as Blob;
    const content = await file.text();
    converted.push(content);
    return new Response(JSON.stringify({ markdown: `# converted\n\n${content}` }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return converted;
}

describe("the upload store answers each account from its own root", () => {
  it("finds nothing of another account's, of the state directory or of the shared registry", async () => {
    configure("local");
    for (const path of [BOB_FILE, BOB_MEMORY, "uploads/.registry.json", `../${bob.id}/generated/secret.pdf`, `/${BOB_FILE}`]) {
      expect(text(await as(ALICE, () => mods.store.getUpload(path))), path).toBeNull();
    }
    // Bob's own read of the same file is his: the namespace is the account's, not a lock-out.
    expect(text(await as(BOB, () => mods.store.getUpload("generated/secret.pdf")))).toBe("BOB-SECRET-PDF");
  });

  it("refuses a path under users/ to a caller with no identity, and leaves it the shared root's other files", async () => {
    configure("local");
    // No request context: under multi-user auth such a caller resolves at the shared root.
    expect(text(await mods.store.getUpload(BOB_FILE))).toBeNull();
    expect(text(await mods.store.getUpload(`USERS/${bob.id}/generated/secret.pdf`))).toBeNull();
    await expect(mods.store.putUpload(`users/${bob.id}/generated/planted.txt`, new TextEncoder().encode("X"), "text/plain"))
      .rejects.toThrow(/no signed-in account/);
    expect(existsSync(join(rootOf(BOB), "generated", "planted.txt"))).toBe(false);
    // The segment that counts is the first one AFTER resolving: `uploads/../users/<B>` is B's root.
    for (const path of [`uploads/../users/${bob.id}/generated/secret.pdf`, `./uploads/..\\Users/${bob.id}/generated/secret.pdf`]) {
      expect(text(await mods.store.getUpload(path)), path).toBeNull();
    }
    await expect(mods.store.putUpload(`uploads/../users/${bob.id}/generated/planted.txt`, new TextEncoder().encode("X"), "text/plain"))
      .rejects.toThrow(/no signed-in account/);
    expect(existsSync(join(rootOf(BOB), "generated", "planted.txt"))).toBe(false);
    const key = await mods.store.putUpload("uploads/webhook/run.txt", new TextEncoder().encode("SHARED"), "text/plain");
    expect(key).toBe("uploads/webhook/run.txt");
    expect(text(await mods.store.getUpload("uploads/webhook/run.txt"))).toBe("SHARED");
  });

  it("stores an account's upload in its own root, where only it reads it back", async () => {
    configure("local");
    const key = await as(ALICE, () => mods.store.putUpload("uploads/s-a/cv.pdf", new TextEncoder().encode("ALICE-CV"), "application/pdf"));
    expect(key).toBe(`users/${alice.id}/uploads/s-a/cv.pdf`);
    expect(readFileSync(join(rootOf(ALICE), "uploads", "s-a", "cv.pdf"), "utf8")).toBe("ALICE-CV");
    expect(existsSync(join(shared, "uploads", "s-a", "cv.pdf"))).toBe(false);
    expect(text(await as(ALICE, () => mods.store.getUpload("uploads/s-a/cv.pdf")))).toBe("ALICE-CV");
    expect(await as(BOB, () => mods.store.getUpload("uploads/s-a/cv.pdf"))).toBeNull();
    expect(await as(BOB, () => mods.store.getUpload(`users/${alice.id}/uploads/s-a/cv.pdf`))).toBeNull();
  });

  it("refuses what read_file refuses, and a link out of the caller's root", async () => {
    configure("local");
    write(join(rootOf(ALICE), ".env"), "ALICE_KEY=1");
    write(join(rootOf(ALICE), PRODUCT.stateDirName, "jwt"), "x");
    expect(await as(ALICE, () => mods.store.getUpload(".env"))).toBeNull();
    expect(await as(ALICE, () => mods.store.getUpload(`${PRODUCT.stateDirName}/jwt`))).toBeNull();
    await expect(as(ALICE, () => mods.store.putUpload(".env", new Uint8Array([1]), "text/plain"))).rejects.toThrow(/protected workspace data/);
    // A directory link inside Alice's root that points into Bob's: a junction needs no privilege on Windows.
    mkdirSync(join(rootOf(ALICE), "generated"), { recursive: true });
    symlinkSync(join(rootOf(BOB), "generated"), join(rootOf(ALICE), "generated", "peek"), "junction");
    expect(await as(ALICE, () => mods.store.getUpload("generated/peek/secret.pdf"))).toBeNull();
    await expect(as(ALICE, () => mods.store.putUpload("generated/peek/planted.pdf", new Uint8Array([1]), "application/pdf")))
      .rejects.toThrow(/out of your own workspace/);
    expect(existsSync(join(rootOf(BOB), "generated", "planted.pdf"))).toBe(false);
    await as(ALICE, () => mods.store.deleteUpload("generated/peek/secret.pdf"));
    expect(readFileSync(join(shared, BOB_FILE), "utf8")).toBe("BOB-SECRET-PDF");
  });

  it("keys every S3 object under the account's own namespace", async () => {
    configure("s3");
    await as(ALICE, () => mods.store.putUpload("uploads/s-a/cv.pdf", new Uint8Array([1]), "application/pdf"));
    await as(ALICE, () => mods.store.getUpload(`users/${bob.id}/uploads/s-b/cv.pdf`));
    await as(ALICE, () => mods.store.getUpload(BOB_MEMORY));
    await as(BOB, () => mods.store.getUpload("uploads/s-b/cv.pdf"));
    expect(s3Sent).toEqual([
      { command: "PutObjectCommand", key: `users/${alice.id}/uploads/s-a/cv.pdf` },
      { command: "GetObjectCommand", key: `users/${alice.id}/users/${bob.id}/uploads/s-b/cv.pdf` },
      // BOB_MEMORY names the state directory: refused before anything is sent.
      { command: "GetObjectCommand", key: `users/${bob.id}/uploads/s-b/cv.pdf` },
    ]);
  });
});

describe("the fallbacks that read through the store", () => {
  const ctxOf = (who: typeof ALICE) => ({ sessionId: "s-tools", workspacePath: rootOf(who), userId: who.userId, identity: who });

  it("extract_file_content does not answer another account's path from its root", async () => {
    configure("local");
    const converted = stubConversion();
    const tool = mods.tools.getTool("extract_file_content")!;
    for (const path of [BOB_FILE, BOB_MEMORY]) {
      const result = await as(ALICE, () => tool.execute({ path }, ctxOf(ALICE) as never));
      expect(result.success, path).toBe(false);
    }
    expect(converted).toEqual([]);
    // Her own attachment, stored through the store, still comes back.
    await as(ALICE, () => mods.store.putUpload("uploads/s-a/cv.pdf", new TextEncoder().encode("ALICE-CV"), "application/pdf"));
    const own = await as(ALICE, () => tool.execute({ path: "uploads/s-a/cv.pdf" }, ctxOf(ALICE) as never));
    expect(own.success).toBe(true);
    expect(converted).toEqual(["ALICE-CV"]);
  });

  it("ingest_document does not ingest another account's file", async () => {
    configure("local");
    const converted = stubConversion();
    const ingest = vi.spyOn(mods.engram, "engramIngest").mockResolvedValue({ documentId: "doc-b", chunkCount: 1 } as never);
    const result = await as(ALICE, () => mods.tools.getTool("ingest_document")!.execute({ path: BOB_FILE }, ctxOf(ALICE) as never));
    expect(result.success).toBe(false);
    expect(converted).toEqual([]);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("an attachment naming another account's file is not read for the turn", async () => {
    configure("local");
    const converted = stubConversion();
    const ingest = vi.spyOn(mods.engram, "engramIngest").mockResolvedValue({ documentId: "doc-b", chunkCount: 1 } as never);
    const aug = await as(ALICE, () => mods.rag.augmentTurnWithDocuments({
      ctx: { sessionId: "s-a", userId: "alice", identity: ALICE },
      workspacePath: rootOf(ALICE),
      query: "summarise it",
      attachments: [{ filename: "secret.pdf", relativePath: BOB_FILE, contentType: "application/pdf" }],
    }));
    expect(aug).toMatchObject({ ingested: 0, failed: 1 });
    expect(converted).toEqual([]);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("removing a document deletes the caller's own file, never one a recorded path names elsewhere", async () => {
    configure("local");
    vi.spyOn(mods.engram, "engramDeleteDocument").mockResolvedValue(true);
    // An entry recorded before store keys, whose path a client named: under the shared root it is Bob's.
    write(join(shared, "uploads", ".registry.json"), JSON.stringify({ entries: [{
      documentId: "doc-x", scope: "session", source: "session:s-a", filename: "secret.pdf",
      relativePath: BOB_FILE, ingestedAt: "2026-10-11T00:00:00Z",
    }] }));
    expect(await as(ALICE, () => mods.rag.forgetDocument("doc-x", "session", { sessionId: "s-a", userId: "alice", identity: ALICE }))).toBe(true);
    expect(readFileSync(join(shared, BOB_FILE), "utf8")).toBe("BOB-SECRET-PDF");

    // One she ingested is recorded with its key in her namespace, and goes when she removes it.
    stubConversion();
    vi.spyOn(mods.engram, "engramIngest").mockResolvedValue({ documentId: "doc-a", chunkCount: 1 } as never);
    await as(ALICE, () => mods.store.putUpload("uploads/s-a/cv.pdf", new TextEncoder().encode("ALICE-CV"), "application/pdf"));
    await as(ALICE, () => mods.rag.ingestDocumentBytes({
      bytes: new TextEncoder().encode("ALICE-CV"), filename: "cv.pdf", contentType: "application/pdf",
      scope: "session", ctx: { sessionId: "s-a", userId: "alice", identity: ALICE }, relativePath: "uploads/s-a/cv.pdf",
    }));
    const registry = JSON.parse(readFileSync(join(shared, "uploads", ".registry.json"), "utf8")) as { entries: Array<{ documentId: string; storeKey?: string }> };
    expect(registry.entries.find((entry) => entry.documentId === "doc-a")?.storeKey).toBe(`users/${alice.id}/uploads/s-a/cv.pdf`);
    await as(ALICE, () => mods.rag.forgetDocument("doc-a", "session", { sessionId: "s-a", userId: "alice", identity: ALICE }));
    expect(existsSync(join(rootOf(ALICE), "uploads", "s-a", "cv.pdf"))).toBe(false);
  });

  it("the download route serves the file of a source the caller holds, by its recorded key", async () => {
    configure("local");
    stubConversion();
    vi.spyOn(mods.engram, "engramIngest").mockResolvedValue({ documentId: "doc-cv", chunkCount: 1 } as never);
    const aliceSession = mods.sessions.createSession({ channel: "webchat", ...ALICE }).id;
    await as(ALICE, async () => {
      await mods.store.putUpload("uploads/s-a/cv.pdf", new TextEncoder().encode("ALICE-CV"), "application/pdf");
      await mods.rag.ingestDocumentBytes({
        bytes: new TextEncoder().encode("ALICE-CV"), filename: "cv.pdf", contentType: "application/pdf",
        scope: "session", ctx: { sessionId: aliceSession, userId: "alice", identity: ALICE }, relativePath: "uploads/s-a/cv.pdf",
      });
    });
    // Bob holds the same text in his own library, ingested without a file of his.
    const bobSource = mods.rag.callerUserSource({ userId: "bob", identity: BOB })!;
    vi.spyOn(mods.engram, "engramListDocuments").mockResolvedValue([
      { id: "doc-cv", title: "cv.pdf", chunkCount: 1, sources: [`session:${aliceSession}`, bobSource] },
    ] as never);

    const { registerDocumentRoutes } = await import("../gateway/document-routes.js");
    const app = new Hono();
    app.use("/api/*", async (c, next) => {
      const user = await mods.auth.authenticatedUser(c.req.header("Authorization"));
      return mods.context.runWithRequestContext({ identity: mods.auth.callerIdentity(user) }, () => next());
    });
    registerDocumentRoutes(app);
    const get = async (who: TestAccountLike, path: string) => app.request(path, {
      headers: { Authorization: `Bearer ${await mods.auth.createToken(who.name, who.account.claims)}` },
    });

    const own = await get({ name: "alice", account: alice }, `/api/documents/doc-cv/file?sessionId=${aliceSession}`);
    expect(own.status).toBe(200);
    expect(await own.text()).toBe("ALICE-CV");
    const other = await get({ name: "bob", account: bob }, "/api/documents/doc-cv/file");
    expect(other.status).toBe(404);
    expect(await other.text()).not.toContain("ALICE-CV");
  });
});

interface TestAccountLike {
  name: string;
  account: ReturnType<typeof testAccount>;
}

describe("the TTS route's audio sample", () => {
  it("is read from the caller's own root, never another account's", { timeout: 60_000 }, async () => {
    configure("local");
    write(join(rootOf(BOB), "voices", "bob.wav"), "BOB-VOICE");
    write(join(rootOf(ALICE), "voices", "me.wav"), "ALICE-VOICE");
    const samples: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("http://tts.test")) return realFetch(input, init);
      if (init?.body instanceof FormData) {
        const blobs: Blob[] = [];
        init.body.forEach((value) => { if (value instanceof Blob) blobs.push(value); });
        for (const blob of blobs) samples.push(await blob.text());
      }
      return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200, headers: { "Content-Type": "audio/wav" } });
    });

    const { createGateway } = await import("../gateway/index.js");
    const gateway = createGateway();
    await gateway.start();
    try {
      const speak = async (audioExamplePath: string) => realFetch(`http://127.0.0.1:${port}/api/multimodal/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await mods.auth.createToken("alice", alice.claims)}` },
        body: JSON.stringify({ text: "Hallo", audioExamplePath }),
      });
      for (const path of [`users/${bob.id}/voices/bob.wav`, `../${bob.id}/voices/bob.wav`, BOB_MEMORY]) {
        expect((await speak(path)).status, path).toBe(502);
      }
      expect(samples).not.toContain("BOB-VOICE");
      expect(samples).not.toContain("BOB-MEMORY");
      expect((await speak("voices/me.wav")).status).toBe(200);
      expect(samples).toContain("ALICE-VOICE");
    } finally {
      await gateway.stop();
    }
  });
});
