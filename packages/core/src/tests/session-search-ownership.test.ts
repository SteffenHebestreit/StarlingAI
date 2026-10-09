import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as loaderModule from "../config/loader.js";
import { createSession, resetSessionsForTests } from "../agent/session.js";
import { searchSessions } from "../agent/session-search.js";
import { runWithRequestContext } from "../runtime/request-context.js";

/**
 * Security finding S2 (2026-10-05): search_sessions and recall_context's sessions section
 * searched every session in the process — one authenticated user's question pulled snippets of
 * another user's conversations into their context. Under multi-user auth a search returns only
 * the requesting user's own sessions (unowned ones included in that "not yours"); with auth off
 * (one operator) nothing changes.
 */

const MARKER = "quandrifex";
const ALICE = "own-alice-01";   // ids are 12 chars: the tools print id.slice(0, 12)
const BOB = "own-bob-0001";
const UNOWNED = "unowned-0001";

const workspaces: string[] = [];

function seed(id: string, userId: string | undefined, secret: string): void {
  const workspacePath = mkdtempSync(join(tmpdir(), "sai-sess-owner-"));
  workspaces.push(workspacePath);
  const session = createSession({ sessionId: id, channel: "webchat", ...(userId ? { userId } : {}), workspacePath });
  session.addMessage({ role: "user", content: `Plan the ${MARKER} rollout — ${secret}` });
  session.addMessage({ role: "assistant", content: `Done: the ${MARKER} plan is drafted.` });
}

function withAuth(enabled: boolean): void {
  const real = loaderModule.getConfig();
  vi.spyOn(loaderModule, "getConfig").mockReturnValue({
    ...real,
    auth: { ...real.auth, enabled },
  } as typeof real);
}

async function tool(name: string, module: string) {
  const [{ getTool }] = await Promise.all([import("../tools/registry.js"), import(module)]);
  const found = getTool(name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

const sessionIds = (metadata: Record<string, unknown> | undefined): string[] =>
  ((metadata?.["sessionMatches"] as Array<{ id: string }> | undefined) ?? []).map((m) => m.id).sort();

describe("session search is scoped to the requesting user", () => {
  beforeEach(() => {
    resetSessionsForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSessionsForTests();
    for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function seedAll(): void {
    seed(ALICE, "alice", "alice-private-note");
    seed(BOB, "bob", "bob-private-salary-figure");
    seed(UNOWNED, undefined, "channel-private-address");
  }

  it("auth off: every session is searchable, exactly as before", async () => {
    withAuth(false);
    seedAll();
    expect(searchSessions(MARKER, { limit: 10 }).map((r) => r.id).sort()).toEqual([ALICE, BOB, UNOWNED].sort());

    const r = await (await tool("search_sessions", "../tools/session-search.js"))
      .execute({ query: MARKER, limit: 10 }, { sessionId: "current", workspacePath: workspaces[0]!, userId: "alice" });
    expect(sessionIds(r.metadata)).toEqual([ALICE, BOB, UNOWNED].sort());
  });

  it("auth on: search_sessions returns only the caller's own sessions", async () => {
    withAuth(true);
    seedAll();
    const t = await tool("search_sessions", "../tools/session-search.js");

    const alice = await t.execute({ query: MARKER, limit: 10 }, { sessionId: "current", workspacePath: workspaces[0]!, userId: "alice" });
    expect(sessionIds(alice.metadata)).toEqual([ALICE]);
    expect(String(alice.output)).not.toContain("bob-private-salary-figure");
    expect(String(alice.output)).not.toContain("channel-private-address");

    const bob = await t.execute({ query: MARKER, limit: 10 }, { sessionId: "current", workspacePath: workspaces[0]!, userId: "bob" });
    expect(sessionIds(bob.metadata)).toEqual([BOB]);
  });

  it("auth on: a sub-agent context without userId falls back to the turn's ambient user", async () => {
    withAuth(true);
    seedAll();
    const t = await tool("search_sessions", "../tools/session-search.js");
    const r = await runWithRequestContext({ userId: "bob" }, () =>
      t.execute({ query: MARKER, limit: 10 }, { sessionId: "sub:current:researcher:1", workspacePath: workspaces[0]! }));
    expect(sessionIds(r.metadata)).toEqual([BOB]);
  });

  it("auth on: no requesting user at all sees no session, unowned ones included", async () => {
    withAuth(true);
    seedAll();
    expect(searchSessions(MARKER, { limit: 10 })).toEqual([]);
    const r = await (await tool("search_sessions", "../tools/session-search.js"))
      .execute({ query: MARKER, limit: 10 }, { sessionId: "current", workspacePath: workspaces[0]! });
    expect(sessionIds(r.metadata)).toEqual([]);
  });

  it("auth on: recall_context's sessions section holds only the caller's own sessions", async () => {
    withAuth(true);
    seedAll();
    const t = await tool("recall_context", "../tools/recall-context.js");
    const r = await t.execute(
      { query: `${MARKER} rollout`, include: ["sessions"], limit: 10 },
      { sessionId: "current", workspacePath: workspaces[0]!, userId: "alice" },
    );
    expect(r.success).toBe(true);
    expect(r.metadata?.["sessions"]).toBe(1);
    expect(String(r.output)).toContain(ALICE);
    expect(String(r.output)).not.toContain(BOB);
    expect(String(r.output)).not.toContain(UNOWNED);
  });

  it("auth off: recall_context still recalls every session", async () => {
    withAuth(false);
    seedAll();
    const t = await tool("recall_context", "../tools/recall-context.js");
    const r = await t.execute(
      { query: `${MARKER} rollout`, include: ["sessions"], limit: 10 },
      { sessionId: "current", workspacePath: workspaces[0]!, userId: "alice" },
    );
    expect(r.metadata?.["sessions"]).toBe(3);
  });
});
