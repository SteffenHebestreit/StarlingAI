import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

/**
 * The document and knowledge-base routes and the session id a request names (found in review,
 * 2026-10-09).
 *
 * Both took `sessionId` from the query or the body as it came. A session's documents are the ones
 * whose source is that id's, and a session KB is visible to whoever presents its session's id, so a
 * caller who knew another account's session id could list, download, mark outdated or delete that
 * session's documents, upload into it, and list, inspect, re-crawl, edit or delete its KBs, or
 * create one there with ambient retrieval that then fed the owner's turns. Under multi-user auth a
 * session id counts only when the caller may use it (callerMayUseSession). On a route that reads or
 * acts on items, one it may not use counts as no id: the session's items read as not found, and the
 * dashboard, which sends the id of the chat it has open, keeps working when that chat is gone. Where
 * the id is where something is written (an upload, a KB's create or update body) it gets the
 * session routes' opaque 404. With auth off every caller may, as before.
 */
const SESSION_STORE_DIR = vi.hoisted(() => {
  // The session store resolves its path when the module loads; a temp one, not the source tree's.
  const { mkdtempSync: mk } = require("node:fs") as typeof import("node:fs");
  const { tmpdir: tmp } = require("node:os") as typeof import("node:os");
  const { join: j } = require("node:path") as typeof import("node:path");
  const dir = mk(j(tmp(), "doc-kb-routes-sessions-"));
  process.env["SAI_SESSION_STORE"] = j(dir, "sessions.json");
  return dir;
});

/** What reached the document store, the object store and the crawler. */
const reached = vi.hoisted(() => [] as string[]);
/** The documents engram holds: set per test. */
const engramDocs = vi.hoisted(() => ({ list: [] as Array<{ id: string; title: string; chunkCount: number; sources: string[] }> }));

vi.mock("../retrieval/engram.js", async (importActual) => ({
  ...(await importActual<typeof import("../retrieval/engram.js")>()),
  engramListDocuments: async () => engramDocs.list,
  engramConfigured: () => true,
}));
vi.mock("../retrieval/document-registry.js", async (importActual) => ({
  ...(await importActual<typeof import("../retrieval/document-registry.js")>()),
  listRegistry: async () => [],
  getRegistryFileEntry: async (documentId: string) => ({
    documentId, source: "", relativePath: "uploads/notes.md", filename: "notes.md", contentType: "text/markdown",
  }),
}));
vi.mock("../retrieval/document-rag.js", async (importActual) => ({
  ...(await importActual<typeof import("../retrieval/document-rag.js")>()),
  forgetDocument: async () => { reached.push("forgetDocument"); return true; },
  invalidateDocument: async () => { reached.push("invalidateDocument"); return true; },
  ingestDocumentBytes: async () => {
    reached.push("ingestDocumentBytes");
    return { ok: true, result: { documentId: "doc-new", title: "notes", scope: "session", chunkCount: 1, keywords: [], source: "", text: "" } };
  },
}));
vi.mock("../storage/uploads.js", () => ({
  scanAndStoreUpload: async () => { reached.push("scanAndStoreUpload"); return { ok: true }; },
}));
vi.mock("../storage/object-store.js", async (importActual) => ({
  ...(await importActual<typeof import("../storage/object-store.js")>()),
  getUpload: async () => { reached.push("getUpload"); return new TextEncoder().encode("the early ferry leaves at 07:40"); },
}));
vi.mock("../retrieval/kb-crawler.js", async (importActual) => ({
  ...(await importActual<typeof import("../retrieval/kb-crawler.js")>()),
  isCrawlActive: () => false,
  startKbCrawl: async () => { reached.push("startKbCrawl"); return { ok: true }; },
  cancelKbCrawl: async () => { reached.push("cancelKbCrawl"); return true; },
  deleteKnowledgeBase: async () => { reached.push("deleteKnowledgeBase"); return { ok: true, documentsRemoved: 0, documentsFailed: 0 }; },
}));

const account = (username: string) => ({
  username, role: "operator", passwordHash: "scrypt$placeholder-hash-not-used-here", createdAt: "2026-10-09T00:00:00Z",
});

const dirs: string[] = [];

afterEach(async () => {
  reached.length = 0;
  engramDocs.list = [];
  const session = await import("../agent/session.js");
  for (const active of session.getAllSessions()) session.endSession(active.id);
  delete process.env["SAI_CONFIG_PATH"];
  (await import("../config/loader.js")).resetConfigForTests();
  (await import("../gateway/auth.js")).resetAuthStateForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

afterAll(() => {
  delete process.env["SAI_SESSION_STORE"];
  rmSync(SESSION_STORE_DIR, { recursive: true, force: true });
});

interface Deployment {
  request: (as: string, path: string, init?: { method?: string; json?: unknown; form?: FormData }) => Promise<Response>;
  /** A chat session Alice owns. */
  aliceSession: string;
}

/** Alice and Bob as accounts when `authEnabled`, the two route groups as the gateway serves them. */
async function deployment(authEnabled: boolean): Promise<Deployment> {
  const dir = mkdtempSync(join(tmpdir(), "doc-kb-routes-"));
  dirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    gateway: { jwtSecret: "d".repeat(40) },
    ...(authEnabled ? { auth: { enabled: true, users: [account("alice"), account("bob")] } } : {}),
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();

  const [{ registerDocumentRoutes }, { registerKnowledgeBaseRoutes }, auth, session] = await Promise.all([
    import("../gateway/document-routes.js"),
    import("../gateway/knowledge-base-routes.js"),
    import("../gateway/auth.js"),
    import("../agent/session.js"),
  ]);
  const app = new Hono();
  registerDocumentRoutes(app);
  registerKnowledgeBaseRoutes(app);
  const aliceSession = session.createSession({ channel: "webchat", userId: "alice" }).id;

  const request: Deployment["request"] = async (as, path, init = {}) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${await auth.createToken(as, { role: "operator" })}` };
    if (init.json !== undefined) headers["Content-Type"] = "application/json";
    return app.request(path, {
      method: init.method ?? "GET",
      headers,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      ...(init.form ? { body: init.form } : {}),
    });
  };
  return { request, aliceSession };
}

/** A document in Alice's session's library. */
function aliceSessionDocument(aliceSession: string): void {
  engramDocs.list = [{ id: "doc-ferry", title: "Ferry notes", chunkCount: 2, sources: [`session:${aliceSession}`] }];
}

/** An upload of a small Markdown file into `sessionId`'s library. */
function sessionUpload(sessionId: string): FormData {
  const form = new FormData();
  form.append("file", new File(["the early ferry leaves at 07:40"], "notes.md", { type: "text/markdown" }));
  form.append("scope", "session");
  form.append("sessionId", sessionId);
  return form;
}

/** A session KB in Alice's session, with ambient retrieval. */
async function aliceSessionKb(aliceSession: string): Promise<string> {
  const { createKnowledgeBase } = await import("../retrieval/knowledge-bases.js");
  const created = await createKnowledgeBase({
    name: "Ferry timetables", seedUrls: ["https://ferries.example/timetable"], scope: "session", sessionId: aliceSession, ambientRetrieval: true,
  });
  if (!created.ok) throw new Error(created.error);
  return created.value.id;
}

async function expectSessionNotFound(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "Session not found" });
}

async function expectNotFound(response: Response, error: string): Promise<void> {
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error });
}

/** An id no session has: what the dashboard holds for a chat deleted or wiped since. */
const STALE_SESSION = "7d1e2f3a-4b5c-4d6e-8f70-81920a1b2c3d";

describe("document routes and the session a request names", () => {
  it("under multi-user auth, finds nothing of another account's session, uploads nothing into it, and touches nothing", async () => {
    const { request, aliceSession } = await deployment(true);
    aliceSessionDocument(aliceSession);
    const q = `sessionId=${encodeURIComponent(aliceSession)}`;

    const list = await request("bob", `/api/documents?${q}`);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { documents: unknown[] }).documents).toEqual([]);
    await expectNotFound(await request("bob", `/api/documents/doc-ferry/file?${q}`), "No original file is stored for this document");
    await expectNotFound(await request("bob", `/api/documents/doc-ferry/invalidate?${q}`, { method: "POST" }), "Document not found");
    await expectNotFound(await request("bob", `/api/documents/doc-ferry?scope=session&${q}`, { method: "DELETE" }), "Document not found");
    // Her session as the place a file is written to: the session routes' 404.
    await expectSessionNotFound(await request("bob", "/api/documents", { method: "POST", form: sessionUpload(aliceSession) }));
    expect(reached).toEqual([]);
  });

  it("under multi-user auth, acts on a workspace document when the request names a stale session id", async () => {
    // Documents.vue sends the open chat's id when it marks a workspace or user document outdated.
    const { request } = await deployment(true);
    const [{ getConfig }, { workspaceSource }] = await Promise.all([import("../config/loader.js"), import("../retrieval/document-rag.js")]);
    engramDocs.list = [{ id: "doc-harbour", title: "Harbour rules", chunkCount: 4, sources: [workspaceSource(getConfig().retrieval.documentRag.workspaceName)] }];

    const invalidated = await request("bob", `/api/documents/doc-harbour/invalidate?sessionId=${STALE_SESSION}`, { method: "POST" });
    expect(invalidated.status).toBe(200);
    expect(await invalidated.json()).toEqual({ id: "doc-harbour", invalidated: true });
    expect((await request("bob", `/api/documents?sessionId=${STALE_SESSION}`)).status).toBe(200);
    expect(reached).toEqual(["invalidateDocument"]);
    // An upload into a session no one has is still refused.
    await expectSessionNotFound(await request("bob", "/api/documents", { method: "POST", form: sessionUpload(STALE_SESSION) }));
  });

  it("under multi-user auth, still serves the session's owner", async () => {
    const { request, aliceSession } = await deployment(true);
    aliceSessionDocument(aliceSession);
    const q = `sessionId=${encodeURIComponent(aliceSession)}`;

    const list = await request("alice", `/api/documents?${q}`);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { documents: Array<{ id: string }> }).documents.map((d) => d.id)).toEqual(["doc-ferry"]);
    expect((await request("alice", `/api/documents/doc-ferry/file?${q}`)).status).toBe(200);
    expect((await request("alice", `/api/documents/doc-ferry?scope=session&${q}`, { method: "DELETE" })).status).toBe(200);
    expect((await request("alice", "/api/documents", { method: "POST", form: sessionUpload(aliceSession) })).status).toBe(200);
    expect(reached).toEqual(["getUpload", "forgetDocument", "scanAndStoreUpload", "ingestDocumentBytes"]);
  });

  it("under multi-user auth, lists of a shared document only the sources the caller may manage", async () => {
    // A document is stored once, shared by every scope that holds it. Its entry listed every source,
    // so bob's list named alice's session id and showed that she holds the same file (review,
    // 2026-10-09).
    const { request, aliceSession } = await deployment(true);
    engramDocs.list = [{ id: "doc-shared", title: "Ferry notes", chunkCount: 2, sources: ["user:bob", `session:${aliceSession}`, "user:alice"] }];

    const list = await request("bob", "/api/documents");
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toContain(aliceSession);
    expect(text).not.toContain("user:alice");
    expect((JSON.parse(text) as { documents: Array<{ id: string; scopes: Array<{ scope: string; source: string }> }> }).documents)
      .toEqual([expect.objectContaining({ id: "doc-shared", scopes: [{ scope: "user", source: "user:bob" }] })]);
  });

  it("with one operator, lists every source of a document, as before", async () => {
    const { request, aliceSession } = await deployment(false);
    engramDocs.list = [{ id: "doc-shared", title: "Ferry notes", chunkCount: 2, sources: ["user:bob", `session:${aliceSession}`, "user:alice"] }];

    const list = await request("bob", "/api/documents");
    const documents = ((await list.json()) as { documents: Array<{ scopes: Array<{ source: string }> }> }).documents;
    expect(documents[0]?.scopes.map((scope) => scope.source)).toEqual(["user:bob", `session:${aliceSession}`, "user:alice"]);
  });

  it("with one operator, takes the session id as it comes, as before", async () => {
    const { request, aliceSession } = await deployment(false);
    aliceSessionDocument(aliceSession);
    const q = `sessionId=${encodeURIComponent(aliceSession)}`;

    expect((await request("bob", `/api/documents?${q}`)).status).toBe(200);
    expect((await request("bob", `/api/documents/doc-ferry/invalidate?${q}`, { method: "POST" })).status).toBe(200);
    expect((await request("bob", `/api/documents/doc-ferry?scope=session&${q}`, { method: "DELETE" })).status).toBe(200);
    expect((await request("bob", "/api/documents", { method: "POST", form: sessionUpload(aliceSession) })).status).toBe(200);
    expect(reached).toEqual(["invalidateDocument", "forgetDocument", "scanAndStoreUpload", "ingestDocumentBytes"]);
  });
});

describe("knowledge-base routes and the session a request names", () => {
  it("under multi-user auth, finds no KB of another account's session, puts none into it, and changes nothing", async () => {
    const { request, aliceSession } = await deployment(true);
    const kbId = await aliceSessionKb(aliceSession);
    const q = `sessionId=${encodeURIComponent(aliceSession)}`;

    await expectNotFound(await request("bob", `/api/knowledge-bases/${kbId}?${q}`), "Knowledge base not found");
    await expectNotFound(await request("bob", `/api/knowledge-bases/${kbId}?${q}`, { method: "PATCH", json: { name: "Mine now" } }), "Knowledge base not found");
    await expectNotFound(await request("bob", `/api/knowledge-bases/${kbId}/crawl?${q}`, { method: "POST" }), "Knowledge base not found");
    await expectNotFound(await request("bob", `/api/knowledge-bases/${kbId}/cancel?${q}`, { method: "POST" }), "Knowledge base not found");
    await expectNotFound(await request("bob", `/api/knowledge-bases/${kbId}?${q}`, { method: "DELETE" }), "Knowledge base not found");
    expect(reached).toEqual([]);

    // Nor may he put a KB into her session, new or his own.
    await expectSessionNotFound(await request("bob", "/api/knowledge-bases", {
      method: "POST",
      json: { name: "Ferry strikes", seedUrls: ["https://strikes.example/"], scope: "session", sessionId: aliceSession, ambientRetrieval: true, crawlNow: false },
    }));
    const own = await request("bob", "/api/knowledge-bases", {
      method: "POST", json: { name: "Bob's ferries", seedUrls: ["https://bob.example/"], scope: "user", crawlNow: false },
    });
    expect(own.status).toBe(201);
    const ownId = ((await own.json()) as { id: string }).id;
    await expectSessionNotFound(await request("bob", `/api/knowledge-bases/${ownId}`, {
      method: "PATCH", json: { scope: "session", sessionId: aliceSession, ambientRetrieval: true },
    }));

    const { listKnowledgeBases } = await import("../retrieval/knowledge-bases.js");
    const kbs = await listKnowledgeBases();
    expect(kbs.map((kb) => [kb.id, kb.name, kb.scope, kb.sessionId ?? null])).toEqual([
      [kbId, "Ferry timetables", "session", aliceSession],
      [ownId, "Bob's ferries", "user", null],
    ]);
  });

  it("under multi-user auth, lists for another account's or a stale session id as if none had been given", async () => {
    // The list is what the dashboard's KB page loads, always with the id of the chat it has open. A
    // 404 for an id the caller may not use emptied the page whenever that chat was gone (deleted,
    // or a stale id after a wipe). It now answers with what the caller may see, and nothing of the
    // named session's.
    const { request, aliceSession } = await deployment(true);
    const { createKnowledgeBase } = await import("../retrieval/knowledge-bases.js");
    const shared = await createKnowledgeBase({ name: "Harbour rules", seedUrls: ["https://harbour.example/rules"] });
    const bobs = await createKnowledgeBase({ name: "Bob's ferries", seedUrls: ["https://bob.example/"], scope: "user", ownerId: "bob" });
    const alices = await createKnowledgeBase({ name: "Alice's ferries", seedUrls: ["https://alice.example/"], scope: "user", ownerId: "alice" });
    if (!shared.ok || !bobs.ok || !alices.ok) throw new Error("seeding the KB store failed");
    const sessionKb = await aliceSessionKb(aliceSession);
    const listed = async (path: string): Promise<string[]> => {
      const response = await request("bob", path);
      expect(response.status, path).toBe(200);
      return ((await response.json()) as { knowledgeBases: Array<{ id: string }> }).knowledgeBases.map((kb) => kb.id);
    };

    const bobsList = await listed("/api/knowledge-bases");
    expect(bobsList).toEqual([shared.value.id, bobs.value.id]);
    expect(await listed(`/api/knowledge-bases?sessionId=${encodeURIComponent(aliceSession)}`)).toEqual(bobsList);
    expect(await listed(`/api/knowledge-bases?sessionId=${STALE_SESSION}`)).toEqual(bobsList);

    await expectNotFound(await request("bob", `/api/knowledge-bases/${sessionKb}?sessionId=${encodeURIComponent(aliceSession)}`), "Knowledge base not found");
  });

  it("under multi-user auth, reads, crawls and deletes a workspace KB when the request names a stale session id", async () => {
    // KnowledgeBases.vue sends the open chat's id on every call, for workspace and own KBs too.
    const { request } = await deployment(true);
    const { createKnowledgeBase, listKnowledgeBases } = await import("../retrieval/knowledge-bases.js");
    const shared = await createKnowledgeBase({ name: "Harbour rules", seedUrls: ["https://harbour.example/rules"] });
    if (!shared.ok) throw new Error(shared.error);
    const q = `sessionId=${STALE_SESSION}`;

    const detail = await request("bob", `/api/knowledge-bases/${shared.value.id}?${q}`);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { knowledgeBase: { id: string } }).knowledgeBase.id).toBe(shared.value.id);
    expect((await request("bob", `/api/knowledge-bases/${shared.value.id}?${q}`, { method: "PATCH", json: { description: "Port of Kiel" } })).status).toBe(200);
    expect((await request("bob", `/api/knowledge-bases/${shared.value.id}/crawl?${q}`, { method: "POST" })).status).toBe(200);
    expect((await request("bob", `/api/knowledge-bases/${shared.value.id}?${q}`, { method: "DELETE" })).status).toBe(200);
    expect(reached).toEqual(["startKbCrawl", "deleteKnowledgeBase"]);
    expect((await listKnowledgeBases())[0]?.description).toBe("Port of Kiel");
    // A KB put into a session no one has is still refused.
    await expectSessionNotFound(await request("bob", "/api/knowledge-bases", {
      method: "POST", json: { name: "Ferry strikes", seedUrls: ["https://strikes.example/"], scope: "session", sessionId: STALE_SESSION, crawlNow: false },
    }));
  });

  it("under multi-user auth, still serves the session's owner", async () => {
    const { request, aliceSession } = await deployment(true);
    const kbId = await aliceSessionKb(aliceSession);
    const q = `sessionId=${encodeURIComponent(aliceSession)}`;

    const list = await request("alice", `/api/knowledge-bases?${q}`);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { knowledgeBases: Array<{ id: string }> }).knowledgeBases.map((kb) => kb.id)).toEqual([kbId]);
    expect((await request("alice", `/api/knowledge-bases/${kbId}/crawl?${q}`, { method: "POST" })).status).toBe(200);
    expect((await request("alice", "/api/knowledge-bases", {
      method: "POST",
      json: { name: "Ferry strikes", seedUrls: ["https://strikes.example/"], scope: "session", sessionId: aliceSession, crawlNow: false },
    })).status).toBe(201);
  });

  it("with one operator, takes the session id as it comes, as before", async () => {
    const { request, aliceSession } = await deployment(false);
    const kbId = await aliceSessionKb(aliceSession);
    const q = `sessionId=${encodeURIComponent(aliceSession)}`;

    const list = await request("bob", `/api/knowledge-bases?${q}`);
    expect(((await list.json()) as { knowledgeBases: Array<{ id: string }> }).knowledgeBases.map((kb) => kb.id)).toEqual([kbId]);
    expect((await request("bob", `/api/knowledge-bases/${kbId}/crawl?${q}`, { method: "POST" })).status).toBe(200);
    expect((await request("bob", "/api/knowledge-bases", {
      method: "POST",
      json: { name: "Ferry strikes", seedUrls: ["https://strikes.example/"], scope: "session", sessionId: aliceSession, crawlNow: false },
    })).status).toBe(201);
    expect(reached).toEqual(["startKbCrawl"]);
  });
});
