import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../config/loader.js";
import { appendOutcome } from "../agent/outcomes.js";
import { _clearDurableMemoryCaches, storeWorkspaceMemoryRecord } from "../memory/service.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { safeUserSegment } from "../runtime/user-scope.js";
import { getTool, type ToolContext, type ToolResult } from "../tools/registry.js";
import { userWorkspaceRoot } from "../tools/workspace-path.js";

/**
 * memory_search shows each account its own agent lessons and no one else's (found in review,
 * 2026-10-08).
 *
 * Its agent scope reads the deployment's outcome ledger, one file for every account, where a
 * lesson's subject is the task it was recorded for. With no scopes the tool searched all four, and
 * the model can name the agent scope itself: Bob's search listed Alice's task. Each entry now
 * carries the account it was recorded for, and under multi-user auth a search shows the caller's
 * own; an entry from before that (no account) is shown to no one.
 */
const ALICE_TASK = "find a divorce lawyer in Hamburg for my custody case";
const BOB_TASK = "compare the Hamburg harbour ferry timetables for my commute";
const LEGACY_TASK = "draft a Hamburg tenancy complaint about the landlord";
const QUERY = "Kanzlei Hamburg";
const NOT_SEARCHED = "Agent lessons are searchable only by the account they were recorded for";

const dirs: string[] = [];

function withAuth(enabled: boolean): void {
  const real = configLoader.getConfig();
  vi.spyOn(configLoader, "getConfig").mockReturnValue({ ...real, auth: { ...real.auth, enabled } } as typeof real);
}

/** A deployment ledger holding one lesson recorded for Alice, one for Bob and one written before
 *  entries carried an account; and the root Bob works in, holding his own note. Everything
 *  mentions Hamburg, so each matches the query by word. */
function seed(): { shared: string; bobRoot: string } {
  const shared = mkdtempSync(join(tmpdir(), "memory-search-account-"));
  dirs.push(shared);
  const lesson = (task: string, text: string, account?: string) => appendOutcome(shared, {
    ts: new Date().toISOString(),
    agent: "researcher",
    task,
    outcome: "success",
    iterations: 1,
    totalTokens: 0,
    lesson: text,
    ...(account ? { account } : {}),
  });
  lesson(ALICE_TASK, "search the bar association register first", safeUserSegment("alice"));
  lesson(BOB_TASK, "the harbour operator's site lists the ferry times", safeUserSegment("bob"));
  lesson(LEGACY_TASK, "cite the local rent index");
  const bobRoot = userWorkspaceRoot(shared, "bob");
  storeWorkspaceMemoryRecord(bobRoot, { key: "law_firm", subject: "Kanzlei", content: "Bob bevorzugt die Kanzlei Nordhafen in Hamburg", kind: "preference" });
  return { shared, bobRoot };
}

function search(ctx: ToolContext, scopes?: string[]): Promise<ToolResult> {
  return getTool("memory_search")!.execute({ query: QUERY, ...(scopes ? { scopes } : {}) }, ctx);
}

async function searchAsBob(bobRoot: string, scopes?: string[]): Promise<ToolResult> {
  const result = await runWithRequestContext({ userId: "bob" }, () => search(
    { sessionId: "memory-search-account-bob", workspacePath: bobRoot, userId: "bob" },
    scopes,
  ));
  expect(result.success).toBe(true);
  return result;
}

describe("memory_search and the deployment's agent ledger", () => {
  beforeAll(async () => { await import("../tools/memory.js"); });
  afterEach(() => {
    vi.restoreAllMocks();
    _clearDurableMemoryCaches();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("under multi-user auth, finds the caller's own lessons by default and no one else's", async () => {
    withAuth(true);
    const { bobRoot } = seed();

    const result = await searchAsBob(bobRoot);

    expect(result.output).toContain("Kanzlei Nordhafen");
    expect(result.output).toContain(BOB_TASK);
    expect(result.output).not.toContain(ALICE_TASK);
    expect(result.output).not.toContain(LEGACY_TASK);
    expect(result.output).not.toContain(NOT_SEARCHED);
    expect(result.metadata?.["scopes"]).toEqual(["workspace", "user", "session", "agent"]);
  });

  it("under multi-user auth, an agent-scope search by name finds the caller's own lessons only", async () => {
    withAuth(true);
    const { bobRoot } = seed();

    const result = await searchAsBob(bobRoot, ["agent"]);

    expect(result.output).toContain(`**[agent/lesson] ${BOB_TASK}**`);
    expect(result.output).not.toContain(ALICE_TASK);
    expect(result.output).not.toContain(LEGACY_TASK);
    expect(result.output).not.toContain(NOT_SEARCHED);
    expect(result.metadata?.["scopes"]).toEqual(["agent"]);
  });

  it("under multi-user auth with no user in the request, leaves the agent scope out and says so when it was asked for", async () => {
    withAuth(true);
    const { shared } = seed();
    const anonymous: ToolContext = { sessionId: "memory-search-account-anonymous", workspacePath: shared };

    const agentOnly = await search(anonymous, ["agent"]);
    expect(agentOnly.success).toBe(true);
    for (const task of [ALICE_TASK, BOB_TASK, LEGACY_TASK]) expect(agentOnly.output).not.toContain(task);
    expect(agentOnly.output).toContain(NOT_SEARCHED);
    expect(agentOnly.metadata?.["scopes"]).toEqual([]);

    const every = await search(anonymous);
    for (const task of [ALICE_TASK, BOB_TASK, LEGACY_TASK]) expect(every.output).not.toContain(task);
    expect(every.output).not.toContain(NOT_SEARCHED);
    expect(every.metadata?.["scopes"]).toEqual(["workspace", "user", "session"]);
  });

  it("with one operator, searches the agent scope as before: the ledger is theirs", async () => {
    withAuth(false);
    const { bobRoot } = seed();

    const every = await searchAsBob(bobRoot);
    for (const task of [ALICE_TASK, BOB_TASK, LEGACY_TASK]) expect(every.output).toContain(task);
    expect(every.output).toContain("Kanzlei Nordhafen");
    expect(every.output).not.toContain(NOT_SEARCHED);
    expect(every.metadata?.["scopes"]).toEqual(["workspace", "user", "session", "agent"]);

    const agentOnly = await searchAsBob(bobRoot, ["agent"]);
    expect(agentOnly.output).toContain(`**[agent/lesson] ${ALICE_TASK}**`);
    expect(agentOnly.output).not.toContain(NOT_SEARCHED);
    expect(agentOnly.metadata?.["scopes"]).toEqual(["agent"]);
  });
});
