import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testAccount, testAccountId } from "./support/test-account.js";

/**
 * A user's document corpus is keyed by the account id under multi-user auth (S2).
 *
 * It was `user:<username>` with auth on too, and so was the upload folder `uploads/user-<username>`:
 * an account deleted and created again under the same name read, listed and deleted the old
 * account's documents, and so did a channel sender whose id was the name. Under multi-user auth the
 * corpus is `user:<segment>` (an account's id, a principal's segment) and the folder
 * `uploads/user-<segment>`; an account also reads the pre-id corpora the account migration let it
 * adopt (document-aliases.json), and no other account does. With one operator both are what they
 * were, byte for byte.
 */

const stored = vi.hoisted(() => [] as string[]);
vi.mock("../storage/uploads.js", () => ({
  scanAndStoreUpload: async (relativePath: string) => {
    stored.push(relativePath);
    return { ok: true };
  },
}));

const ingested = vi.hoisted(() => [] as Array<{ source: string | null; relativePath?: string }>);
vi.mock("../retrieval/document-rag.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../retrieval/document-rag.js")>();
  return {
    ...actual,
    ingestDocumentBytes: async (input: Parameters<typeof actual.ingestDocumentBytes>[0]) => {
      ingested.push({ source: actual.resolveScopeSource(input.scope, input.ctx), relativePath: input.relativePath });
      return { ok: true, result: { documentId: "doc-1", title: "t", scope: input.scope, chunkCount: 1, keywords: [], source: "", text: "" } };
    },
  };
});

const FILE_DIR = mkdtempSync(join(tmpdir(), "starlingai-doc-source-"));
const CONFIG_PATH = join(FILE_DIR, "starlingai.json");
let workspace = "";

async function loadModules() {
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway: { jwtSecret: "d".repeat(40) } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_SESSION_STORE"] = join(FILE_DIR, "sessions.json");
  process.env["SAI_AUDIT_LOG"] = join(FILE_DIR, "audit.jsonl");
  const loader = await import("../config/loader.js");
  const registry = await import("../runtime/account-registry.js");
  const rag = await import("../retrieval/document-rag.js");
  const aliases = await import("../retrieval/document-aliases.js");
  const scope = await import("../runtime/user-scope.js");
  const auth = await import("../gateway/auth.js");
  const routes = await import("../gateway/document-routes.js");
  return { loader, registry, rag, aliases, scope, auth, routes };
}

let mods: Awaited<ReturnType<typeof loadModules>>;

beforeAll(async () => {
  mods = await loadModules();
});

afterAll(() => {
  mods.loader.resetConfigForTests();
  for (const key of ["SAI_CONFIG_PATH", "SAI_MUTABLE_CONFIG_PATH", "SAI_SESSION_STORE", "SAI_AUDIT_LOG"]) delete process.env[key];
  rmSync(FILE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  stored.length = 0;
  ingested.length = 0;
});

const ALICE = testAccountId("alice");
const RECREATED_ALICE = `alice-${"5".repeat(16)}`;

/** This test's configuration, with an alias file that lets ALICE read the pre-id corpus of "alice". */
function configure(authEnabled: boolean, users = [testAccount("alice").record]): void {
  workspace = mkdtempSync(join(FILE_DIR, "ws-"));
  mkdirSync(join(workspace, ".starlingai"), { recursive: true });
  writeFileSync(join(workspace, ".starlingai", "document-aliases.json"), JSON.stringify({ version: 1, aliases: { [ALICE]: ["user:alice"] } }), "utf8");
  writeFileSync(CONFIG_PATH, JSON.stringify({
    gateway: { jwtSecret: "d".repeat(40) },
    workspacePath: workspace,
    auth: { enabled: authEnabled, users },
    retrieval: { documentRag: { includeUserDocs: true, includeWorkspaceDocs: true } },
  }), "utf8");
  mods.loader.resetConfigForTests();
  mods.loader.loadConfig();
  mods.registry.resetAccountRegistryForTests();
  mods.aliases.resetDocumentAliasesForTests();
}

describe("the user corpus a caller reads and writes", () => {
  it("is the account's id under multi-user auth, with the corpora it adopted", () => {
    configure(true);
    const alice = { sessionId: "s-1", userId: "alice", identity: { userId: "alice", account: ALICE } };
    expect(mods.rag.resolveScopeSource("user", alice)).toBe(`user:${ALICE}`);
    expect(mods.rag.activeScopeSources(alice)).toEqual(["session:s-1", `user:${ALICE}`, "user:alice", "workspace:workspace"]);
    expect([...mods.rag.callerManageableSources(alice)].sort()).toEqual(["session:s-1", `user:${ALICE}`, "user:alice", "workspace:workspace"].sort());
  });

  it("gives an account created again under the name its own corpus, and none of the old one's", () => {
    configure(true, [{ ...testAccount("alice").record, id: RECREATED_ALICE }]);
    const alice = { sessionId: "s-2", userId: "alice", identity: { userId: "alice", account: RECREATED_ALICE } };
    expect(mods.rag.activeScopeSources(alice)).toEqual(["session:s-2", `user:${RECREATED_ALICE}`, "workspace:workspace"]);
    expect(mods.rag.callerManageableSources(alice).has("user:alice")).toBe(false);
    expect(mods.rag.callerManageableSources(alice).has(`user:${ALICE}`)).toBe(false);
  });

  it("keys a principal's corpus by its own segment, never by its raw name", () => {
    configure(true);
    const sender = { sessionId: "s-3", userId: "555", identity: { userId: "555", principal: "channel" as const } };
    expect(mods.rag.resolveScopeSource("user", sender)).toBe(`user:${mods.scope.safeUserSegment("555")}`);
  });

  it("is `user:<userId>` with one operator, as it always was, and reads no alias", () => {
    configure(false);
    const ctx = { sessionId: "s-4", userId: "alice", identity: { userId: "alice", account: ALICE } };
    expect(mods.rag.resolveScopeSource("user", ctx)).toBe("user:alice");
    expect(mods.rag.activeScopeSources(ctx)).toEqual(["session:s-4", "user:alice", "workspace:workspace"]);
    expect([...mods.rag.callerManageableSources({ userId: "alice", sessionId: "s-4" })].sort()).toEqual(["session:s-4", "user:alice", "workspace:workspace"]);
  });
});

describe("POST /api/documents with scope user", () => {
  async function upload(token: string): Promise<Response> {
    const app = new Hono();
    mods.routes.registerDocumentRoutes(app);
    const form = new FormData();
    form.set("file", new File(["hello"], "cv.txt", { type: "text/plain" }));
    form.set("scope", "user");
    return app.request("/api/documents", { method: "POST", body: form, headers: { Authorization: `Bearer ${token}` } });
  }

  it("stores and ingests under the account's id with multi-user auth", async () => {
    configure(true);
    const response = await upload(await mods.auth.createToken("alice", testAccount("alice").claims));
    expect(response.status).toBe(200);
    expect(stored).toEqual([expect.stringMatching(new RegExp(`^uploads/user-${ALICE}/\\d+-cv\\.txt$`))]);
    expect(ingested).toEqual([{ source: `user:${ALICE}`, relativePath: stored[0] }]);
  });

  it("stores and ingests under the username with one operator, as before", async () => {
    configure(false);
    const response = await upload(await mods.auth.createToken("alice", { role: "operator" }));
    expect(response.status).toBe(200);
    expect(stored).toEqual([expect.stringMatching(/^uploads\/user-alice\/\d+-cv\.txt$/)]);
    expect(ingested).toEqual([{ source: "user:alice", relativePath: stored[0] }]);
  });
});
