import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../config/loader.js";
import { appendOutcome } from "../agent/outcomes.js";
import { _clearDurableMemoryCaches, storeWorkspaceMemoryRecord } from "../memory/service.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { getTool, type ToolResult } from "../tools/registry.js";
import { userWorkspaceRoot } from "../tools/workspace-path.js";

/**
 * memory_search lists no other account's delegated task (found in review, 2026-10-08).
 *
 * Its agent scope reads the deployment's outcome ledger, one file for every account, where a
 * lesson's subject is the task it was recorded for. With no scopes the tool searched all four, and
 * the model can name the agent scope itself: Bob's search listed Alice's task. recall_context had
 * the same exposure (recall-context-account-scope.test.ts).
 */
const ALICE_TASK = "find a divorce lawyer in Hamburg for my custody case";
const QUERY = "Kanzlei Hamburg";
const NOT_SEARCHED = "Agent lessons are not searchable on a multi-user deployment";

const dirs: string[] = [];

function withAuth(enabled: boolean): void {
  const real = configLoader.getConfig();
  vi.spyOn(configLoader, "getConfig").mockReturnValue({ ...real, auth: { ...real.auth, enabled } } as typeof real);
}

/** A deployment root whose ledger holds one lesson about Alice's task, and the root Bob works in
 *  holding his own note. Both mention Hamburg, so either matches the query by word. */
function seed(): { bobRoot: string } {
  const shared = mkdtempSync(join(tmpdir(), "memory-search-account-"));
  dirs.push(shared);
  appendOutcome(shared, {
    ts: new Date().toISOString(),
    agent: "researcher",
    task: ALICE_TASK,
    outcome: "success",
    iterations: 1,
    totalTokens: 0,
    lesson: "search the bar association register first",
  });
  const bobRoot = userWorkspaceRoot(shared, "bob");
  storeWorkspaceMemoryRecord(bobRoot, { key: "law_firm", subject: "Kanzlei", content: "Bob bevorzugt die Kanzlei Nordhafen in Hamburg", kind: "preference" });
  return { bobRoot };
}

async function searchAsBob(bobRoot: string, scopes?: string[]): Promise<ToolResult> {
  const result = await runWithRequestContext({ userId: "bob" }, () => getTool("memory_search")!.execute(
    { query: QUERY, ...(scopes ? { scopes } : {}) },
    { sessionId: "memory-search-account-bob", workspacePath: bobRoot, userId: "bob" },
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

  it("under multi-user auth, searches the caller's own scopes by default, without another account's task", async () => {
    withAuth(true);
    const { bobRoot } = seed();

    const result = await searchAsBob(bobRoot);

    expect(result.output).toContain("Kanzlei Nordhafen");
    expect(result.output).not.toContain(ALICE_TASK);
    expect(result.metadata?.["scopes"]).toEqual(["workspace", "user", "session"]);
  });

  it("under multi-user auth, leaves the agent scope out when it is asked for by name, and says so", async () => {
    withAuth(true);
    const { bobRoot } = seed();

    const agentOnly = await searchAsBob(bobRoot, ["agent"]);
    expect(agentOnly.output).not.toContain(ALICE_TASK);
    expect(agentOnly.output).toContain(NOT_SEARCHED);
    expect(agentOnly.metadata?.["scopes"]).toEqual([]);

    const withWorkspace = await searchAsBob(bobRoot, ["workspace", "agent"]);
    expect(withWorkspace.output).toContain("Kanzlei Nordhafen");
    expect(withWorkspace.output).not.toContain(ALICE_TASK);
    expect(withWorkspace.output).toContain(NOT_SEARCHED);
    expect(withWorkspace.metadata?.["scopes"]).toEqual(["workspace"]);
  });

  it("with one operator, searches the agent scope as before: the ledger is theirs", async () => {
    withAuth(false);
    const { bobRoot } = seed();

    const every = await searchAsBob(bobRoot);
    expect(every.output).toContain(ALICE_TASK);
    expect(every.output).toContain("Kanzlei Nordhafen");
    expect(every.output).not.toContain(NOT_SEARCHED);
    expect(every.metadata?.["scopes"]).toEqual(["workspace", "user", "session", "agent"]);

    const agentOnly = await searchAsBob(bobRoot, ["agent"]);
    expect(agentOnly.output).toContain(`**[agent/lesson] ${ALICE_TASK}**`);
    expect(agentOnly.output).not.toContain(NOT_SEARCHED);
    expect(agentOnly.metadata?.["scopes"]).toEqual(["agent"]);
  });
});
