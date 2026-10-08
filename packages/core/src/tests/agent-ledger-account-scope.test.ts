import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../config/loader.js";
import { appendOutcome } from "../agent/outcomes.js";
import { buildUserProfileEvidence } from "../agent/user-profile-prefetch.js";
import {
  _clearDurableMemoryCaches,
  formatScopedMemoryGuidance,
  listWorkspaceMemoryRecords,
  storeWorkspaceMemoryRecord,
} from "../memory/service.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { getTool } from "../tools/registry.js";
import { userWorkspaceRoot } from "../tools/workspace-path.js";

/**
 * No reader of the memory service hands one account another account's delegated task (found in
 * review, 2026-10-08).
 *
 * The agent scope reads the deployment's outcome ledger, one file for every account, where a
 * lesson's subject is the task it was recorded for. memory_search and recall_context were the
 * search tools (memory-search-account-scope.test.ts, recall-context-account-scope.test.ts); these
 * are the other readers of the scope: memory_promote, a sub-agent's memory guidance, and the
 * user-profile prefetch.
 */
const ALICE_TASK = "find a divorce lawyer in Hamburg for my custody case";
const QUERY = "Kanzlei Hamburg";

const dirs: string[] = [];

function withAuth(enabled: boolean): void {
  const real = configLoader.getConfig();
  vi.spyOn(configLoader, "getConfig").mockReturnValue({ ...real, auth: { ...real.auth, enabled } } as typeof real);
}

/** A deployment root whose ledger holds one lesson the researcher recorded on Alice's task, and the
 *  root Bob works in holding his own preference. Both mention Hamburg, so either matches by word. */
function seed(): { bobRoot: string } {
  const shared = mkdtempSync(join(tmpdir(), "agent-ledger-account-"));
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

function asBob<T>(run: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ userId: "bob" }, run);
}

afterEach(() => {
  vi.restoreAllMocks();
  _clearDurableMemoryCaches();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("memory_promote and the deployment's agent ledger", () => {
  beforeAll(async () => { await import("../tools/memory.js"); });

  async function promoteAsBob(bobRoot: string): Promise<string> {
    const result = await asBob(() => getTool("memory_promote")!.execute(
      { query: QUERY },
      { sessionId: "promote-account-bob", workspacePath: bobRoot, userId: "bob" },
    ));
    expect(result.success).toBe(true);
    return result.output;
  }

  it("under multi-user auth, neither names another account's task nor copies it into the caller's memory", async () => {
    withAuth(true);
    const { bobRoot } = seed();

    const output = await promoteAsBob(bobRoot);

    expect(output).not.toContain(ALICE_TASK);
    expect(listWorkspaceMemoryRecords(bobRoot).map((record) => record.subject)).not.toContain(ALICE_TASK);
  });

  it("with one operator, still promotes the agents' lessons: the ledger is theirs", async () => {
    withAuth(false);
    const { bobRoot } = seed();

    const output = await promoteAsBob(bobRoot);

    expect(output).toContain(ALICE_TASK);
  });
});

describe("a sub-agent's memory guidance and the deployment's agent ledger", () => {
  /** The options agent/sub-agent.ts passes for the run's own memory guidance. */
  function guidanceForBobsResearcher(bobRoot: string): Promise<string> {
    return asBob(() => formatScopedMemoryGuidance(bobRoot, "Find a law firm in Hamburg", {
      sessionId: "sub-agent-account-bob",
      targetAgent: "researcher",
      scopes: ["session", "workspace", "user", "agent"],
      limit: 4,
      maxChars: 1_400,
    }));
  }

  it("under multi-user auth, carries the caller's own memory without another account's task", async () => {
    withAuth(true);
    const { bobRoot } = seed();

    const guidance = await guidanceForBobsResearcher(bobRoot);

    expect(guidance).toContain("Kanzlei Nordhafen");
    expect(guidance).not.toContain(ALICE_TASK);
  });

  it("with one operator, still carries the agent's own lessons", async () => {
    withAuth(false);
    const { bobRoot } = seed();

    const guidance = await guidanceForBobsResearcher(bobRoot);

    expect(guidance).toContain(ALICE_TASK);
  });
});

describe("the user-profile prefetch and the deployment's agent ledger", () => {
  function evidenceForBob(bobRoot: string): Promise<string> {
    return asBob(() => buildUserProfileEvidence(bobRoot, QUERY, "profile-account-bob", "bob", { skipDocRetrieval: true }));
  }

  it("under multi-user auth, presents the caller's own memory without another account's task", async () => {
    withAuth(true);
    const { bobRoot } = seed();

    const evidence = await evidenceForBob(bobRoot);

    expect(evidence).toContain("Kanzlei Nordhafen");
    expect(evidence).not.toContain(ALICE_TASK);
  });

  it("with one operator, searches as before", async () => {
    withAuth(false);
    const { bobRoot } = seed();

    const evidence = await evidenceForBob(bobRoot);

    expect(evidence).toContain(ALICE_TASK);
  });
});
