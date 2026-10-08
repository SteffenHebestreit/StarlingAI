import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../config/loader.js";
import { appendOutcome, type OutcomeEntry } from "../agent/outcomes.js";
import { buildUserProfileEvidence } from "../agent/user-profile-prefetch.js";
import {
  _clearDurableMemoryCaches,
  formatScopedMemoryGuidance,
  listWorkspaceMemoryRecords,
  searchableMemoryScopes,
  storeWorkspaceMemoryRecord,
} from "../memory/service.js";
import { PRODUCT } from "../product/index.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { safeUserSegment } from "../runtime/user-scope.js";
import { getTool } from "../tools/registry.js";
import { userWorkspaceRoot } from "../tools/workspace-path.js";

/**
 * Every reader of the agent scope shows each account its own lessons and no one else's (found in
 * review, 2026-10-08).
 *
 * The agent scope reads the deployment's outcome ledger, one file for every account, where a
 * lesson's subject is the task it was recorded for. memory_search and recall_context are the search
 * tools (memory-search-account-scope.test.ts, recall-context-account-scope.test.ts); these are the
 * other readers: memory_promote, a sub-agent's memory guidance, and the user-profile prefetch. Each
 * entry carries the account it was recorded for; under multi-user auth a reader shows the caller's
 * own, an entry from before that (no account) to no one, and nothing to a request with no user.
 */
const ALICE_TASK = "find a divorce lawyer in Hamburg for my custody case";
const BOB_TASK = "compare the Hamburg harbour ferry timetables for my commute";
const LEGACY_TASK = "draft a Hamburg tenancy complaint about the landlord";
const QUERY = "Kanzlei Hamburg";

const dirs: string[] = [];

function withAuth(enabled: boolean): void {
  const real = configLoader.getConfig();
  vi.spyOn(configLoader, "getConfig").mockReturnValue({ ...real, auth: { ...real.auth, enabled } } as typeof real);
}

/** A deployment ledger holding one lesson the researcher recorded for Alice, one for Bob and one
 *  written before entries carried an account; and the root Bob works in, holding his own
 *  preference. Everything mentions Hamburg, so each matches the query by word. */
function seed(): { shared: string; bobRoot: string } {
  const shared = mkdtempSync(join(tmpdir(), "agent-ledger-account-"));
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

function asBob<T>(run: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ userId: "bob" }, run);
}

/** Bob's own task and no one else's: under multi-user auth, for a request made as Bob. */
function expectOnlyBobs(text: string): void {
  expect(text).toContain(BOB_TASK);
  expect(text).not.toContain(ALICE_TASK);
  expect(text).not.toContain(LEGACY_TASK);
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

  it("under multi-user auth, promotes the caller's own lessons and no one else's into the caller's memory", async () => {
    withAuth(true);
    const { bobRoot } = seed();

    const output = await promoteAsBob(bobRoot);

    expectOnlyBobs(output);
    expectOnlyBobs(listWorkspaceMemoryRecords(bobRoot).map((record) => record.subject).join("\n"));
  });

  it("with one operator, still promotes every lesson: the ledger is theirs", async () => {
    withAuth(false);
    const { bobRoot } = seed();

    const output = await promoteAsBob(bobRoot);

    for (const task of [ALICE_TASK, BOB_TASK, LEGACY_TASK]) expect(output).toContain(task);
  });
});

describe("a sub-agent's memory guidance and the deployment's agent ledger", () => {
  /** The options agent/sub-agent.ts passes for the run's own memory guidance. */
  function guidanceFor(root: string): Promise<string> {
    return formatScopedMemoryGuidance(root, "Find a law firm in Hamburg", {
      sessionId: "sub-agent-account",
      targetAgent: "researcher",
      scopes: ["session", "workspace", "user", "agent"],
      limit: 4,
      maxChars: 1_400,
    });
  }

  it("under multi-user auth, carries the caller's own memory and lessons and no one else's", async () => {
    withAuth(true);
    const { bobRoot } = seed();

    const guidance = await asBob(() => guidanceFor(bobRoot));

    expect(guidance).toContain("Kanzlei Nordhafen");
    expectOnlyBobs(guidance);
  });

  it("under multi-user auth with no user in the request, carries no lesson at all", async () => {
    withAuth(true);
    const { shared } = seed();

    const guidance = await guidanceFor(shared);

    for (const task of [ALICE_TASK, BOB_TASK, LEGACY_TASK]) expect(guidance).not.toContain(task);
  });

  it("with one operator, still carries every lesson of the agent", async () => {
    withAuth(false);
    const { bobRoot } = seed();

    const guidance = await guidanceFor(bobRoot);

    for (const task of [ALICE_TASK, BOB_TASK, LEGACY_TASK]) expect(guidance).toContain(task);
  });
});

describe("the user-profile prefetch and the deployment's agent ledger", () => {
  function evidenceForBob(bobRoot: string): Promise<string> {
    return asBob(() => buildUserProfileEvidence(bobRoot, QUERY, "profile-account-bob", "bob", { skipDocRetrieval: true }));
  }

  it("under multi-user auth, presents the caller's own memory and lessons and no one else's", async () => {
    withAuth(true);
    const { bobRoot } = seed();

    const evidence = await evidenceForBob(bobRoot);

    expect(evidence).toContain("Kanzlei Nordhafen");
    expectOnlyBobs(evidence);
  });

  it("with one operator, searches as before", async () => {
    withAuth(false);
    const { bobRoot } = seed();

    const evidence = await evidenceForBob(bobRoot);

    expect(evidence).toContain(ALICE_TASK);
  });
});

describe("the ledger records whose run it was", () => {
  function lastEntryLine(shared: string): string {
    return readFileSync(join(shared, PRODUCT.stateDirName, "agent_outcomes.ndjson"), "utf8").trim().split("\n").at(-1)!;
  }

  const run: OutcomeEntry = { ts: "2026-10-08T12:00:00.000Z", agent: "researcher", task: "check the ferry times", outcome: "success", iterations: 2, totalTokens: 10 };

  it("under multi-user auth, stamps the account of the request the run belongs to, never the raw user id", () => {
    withAuth(true);
    const shared = mkdtempSync(join(tmpdir(), "agent-ledger-stamp-"));
    dirs.push(shared);

    runWithRequestContext({ userId: "bob" }, () => appendOutcome(shared, run));

    const line = lastEntryLine(shared);
    expect(JSON.parse(line)).toMatchObject({ ...run, account: safeUserSegment("bob") });
    expect(line).not.toContain("\"bob\"");
  });

  it("stamps no account on a run with no user, and with one operator writes the entry as before", () => {
    withAuth(true);
    const shared = mkdtempSync(join(tmpdir(), "agent-ledger-stamp-"));
    dirs.push(shared);
    appendOutcome(shared, run);
    expect(JSON.parse(lastEntryLine(shared))).not.toHaveProperty("account");

    vi.restoreAllMocks();
    withAuth(false);
    runWithRequestContext({ userId: "bob" }, () => appendOutcome(shared, run));
    expect(lastEntryLine(shared)).toBe(JSON.stringify(run));
  });
});

describe("the rule the readers share", () => {
  it("counts a config that cannot be read as multi-user with no user", () => {
    vi.spyOn(configLoader, "getConfig").mockImplementation(() => { throw new Error("config unreadable"); });

    expect(searchableMemoryScopes()).toEqual(["workspace", "user", "session"]);
    expect(searchableMemoryScopes(["agent"])).toEqual([]);
  });
});
