import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../tools/registry.js";

/**
 * A memory asked to be kept as a person's own is not stored for every account (found in review,
 * 2026-10-08).
 *
 * memory_store and memory_promote store a 'user' memory to the workspace when the request has no
 * user, a fallback made for one operator's token sessions. Under multi-user auth that workspace is
 * the shared root, whose memories every account's Critical Memory, graph inspector and graph_query
 * read, and requests with no user still reach the tools there (an MCP or federation run, an A2A
 * caller on a shared bearer). There the write is now refused; with one operator it falls back as
 * before.
 */
const tempDir = mkdtempSync(join(tmpdir(), "starlingai-memory-user-scope-"));
const configPath = join(tempDir, "starlingai.json");
process.env["SAI_CONFIG_PATH"] = configPath;
process.env["SAI_USER_MEMORY_PATH"] = join(tempDir, "user-memory");

const account = (username: string) => ({
  username, role: "operator", passwordHash: "scrypt$placeholder-hash-not-used-here", createdAt: "2026-10-08T00:00:00Z",
});

const workspaces: string[] = [];

async function load(authEnabled: boolean) {
  writeFileSync(configPath, JSON.stringify({
    auth: authEnabled ? { enabled: true, users: [account("alice"), account("bob")] } : { enabled: false },
  }), "utf8");
  // Sequential: these modules import each other, and parallel first imports can deadlock.
  const loader = await import("../config/loader.js");
  const registry = await import("../tools/registry.js");
  await import("../tools/memory.js");
  loader.resetConfigForTests();
  loader.loadConfig();
  const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-memory-user-scope-ws-"));
  workspaces.push(workspacePath);
  const ctx: ToolContext = { sessionId: "mcp-session", workspacePath };
  const run = (name: string, args: Record<string, unknown>) => registry.executeTool(name, args, ctx);
  /** As `run`, inside a request whose account rides only the request context, not the tool call. */
  const runInRequestOf = async (userId: string, name: string, args: Record<string, unknown>) =>
    (await import("../runtime/request-context.js")).runWithRequestContext({ userId }, () => run(name, args));
  return { run, runInRequestOf };
}

const preference = {
  key: "custody_counsel",
  subject: "Custody counsel",
  content: "Retained Kanzlei Nordhafen for the custody case.",
  kind: "preference",
  scope: "user",
};

afterEach(async () => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(join(tempDir, "user-memory"), { recursive: true, force: true });
});

afterAll(async () => {
  (await import("../config/loader.js")).resetConfigForTests();
  delete process.env["SAI_CONFIG_PATH"];
  delete process.env["SAI_USER_MEMORY_PATH"];
  rmSync(tempDir, { recursive: true, force: true });
});

describe("a 'user' memory on a request with no user", () => {
  it("under multi-user auth, memory_store stores it nowhere and says so", async () => {
    const { run } = await load(true);
    const stored = await run("memory_store", preference);
    expect(stored.success).toBe(false);
    expect(stored.error).toContain("not stored");

    const shared = await run("memory_search", { query: "Kanzlei Nordhafen", scopes: ["workspace", "user"] });
    expect(shared.output).not.toContain("Nordhafen");
  });

  it("under multi-user auth, memory_promote promotes nothing into the shared workspace in its place", async () => {
    const { run } = await load(true);
    const promoted = await run("memory_promote", { query: "Nordhafen", scopes: ["session"], destinationScope: "user" });
    expect(promoted.success).toBe(false);
    expect(promoted.error).toContain("not stored");
  });

  it("under multi-user auth, a request whose account rides only the request context keeps it in the workspace, as before", async () => {
    const { runInRequestOf } = await load(true);
    const stored = await runInRequestOf("alice", "memory_store", preference);
    expect(stored.success).toBe(true);
    expect(stored.output).toContain("Workspace memory stored");
    expect(stored.metadata?.["requestedScope"]).toBe("user");
  });

  it("with one operator, memory_store keeps it in the workspace and says so, as before", async () => {
    const { run } = await load(false);
    const stored = await run("memory_store", preference);
    expect(stored.success).toBe(true);
    expect(stored.output).toContain("Workspace memory stored");
    expect(stored.output).toContain("no authenticated user");
    expect(stored.metadata?.["scope"]).toBe("workspace");

    const found = await run("memory_search", { query: "Kanzlei Nordhafen", scopes: ["workspace"] });
    expect(found.output).toContain("[workspace/preference]");
  });
});
