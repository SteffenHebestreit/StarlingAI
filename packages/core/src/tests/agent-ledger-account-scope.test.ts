import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../config/loader.js";
import { appendOutcome } from "../agent/outcomes.js";
import { appendFlowMemoryEntry } from "../agent/flow-memory.js";
import { buildUserProfileEvidence } from "../agent/user-profile-prefetch.js";
import {
  _clearDurableMemoryCaches,
  formatScopedMemoryGuidance,
  listWorkspaceMemoryRecords,
  searchableMemoryScopes,
  storeWorkspaceMemoryRecord,
} from "../memory/service.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { recordAccount, safeUserSegment } from "../runtime/user-scope.js";
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

describe("a busy account and the caller's own lessons", () => {
  beforeAll(async () => { await import("../tools/memory.js"); });

  /** Bob's lesson, then 200 lessons recorded for Alice: more than the 200-entry window a search
   *  used to read before keeping the caller's own. */
  function seedBusy(): { bobRoot: string } {
    const shared = mkdtempSync(join(tmpdir(), "agent-ledger-busy-"));
    dirs.push(shared);
    const lesson = (task: string, account: string, minute: number) => appendOutcome(shared, {
      ts: new Date(Date.UTC(2026, 9, 8, 10, minute)).toISOString(),
      agent: "researcher",
      task,
      outcome: "success",
      iterations: 1,
      totalTokens: 0,
      lesson: "check the primary source",
      account,
    });
    lesson(BOB_TASK, safeUserSegment("bob"), 0);
    for (let i = 1; i <= 200; i++) lesson(`Alice's errand number ${i} in Hamburg`, safeUserSegment("alice"), i);
    return { bobRoot: userWorkspaceRoot(shared, "bob") };
  }

  it("under multi-user auth, a search still finds the caller's own lesson behind 200 of another account's", async () => {
    withAuth(true);
    const { bobRoot } = seedBusy();

    const result = await asBob(() => getTool("memory_search")!.execute(
      { query: "Hamburg", scopes: ["agent"] },
      { sessionId: "busy-account-bob", workspacePath: bobRoot, userId: "bob" },
    ));

    expect(result.output).toContain(BOB_TASK);
    expect(result.output).not.toContain("Alice's errand");
  });

  it("under multi-user auth, a sub-agent's lesson guidance finds it too", async () => {
    withAuth(true);
    const { bobRoot } = seedBusy();

    const guidance = await asBob(() => formatScopedMemoryGuidance(bobRoot, "Hamburg ferry timetables", {
      sessionId: "busy-account-guidance",
      targetAgent: "researcher",
      scopes: ["agent"],
      limit: 4,
      maxChars: 1_400,
    }));

    expect(guidance).toContain(BOB_TASK);
    expect(guidance).not.toContain("Alice's errand");
  });
});

describe("where the caller's own agent-scope records are kept, and how many", () => {
  beforeAll(async () => { await import("../tools/memory.js"); });

  async function agentSearchAsBob(bobRoot: string, query: string): Promise<string> {
    const result = await asBob(() => getTool("memory_search")!.execute(
      { query, scopes: ["agent"], limit: 50 },
      { sessionId: "own-records-bob", workspacePath: bobRoot, userId: "bob" },
    ));
    expect(result.success).toBe(true);
    return result.output;
  }

  it("under multi-user auth, keeps the caller's own lessons before capping at 60, not after", async () => {
    withAuth(true);
    const shared = mkdtempSync(join(tmpdir(), "agent-ledger-cap-"));
    dirs.push(shared);
    const lesson = (task: string, account: string, minute: number) => appendOutcome(shared, {
      ts: new Date(Date.UTC(2026, 9, 8, 10, minute)).toISOString(),
      agent: "researcher", task, outcome: "success", iterations: 1, totalTokens: 0, lesson: "check the primary source", account,
    });
    // Within the first 200-entry read, but behind more than 60 of another account's.
    lesson(BOB_TASK, safeUserSegment("bob"), 0);
    for (let i = 1; i <= 70; i++) lesson(`Alice's errand number ${i} in Hamburg`, safeUserSegment("alice"), i);

    const output = await agentSearchAsBob(userWorkspaceRoot(shared, "bob"), "Hamburg");

    expect(output).toContain(BOB_TASK);
  });

  /** Flow entries where their writers put them, the deployment root (the config assistant's
   *  proposals and POST /api/flow-memory write getConfig().workspacePath): Bob's, then `alice` of
   *  Alice's (by default more than the 120 a search keeps), then one from before entries carried an
   *  account. */
  function seedFlow(alice = 130): { shared: string; bobRoot: string } {
    const shared = mkdtempSync(join(tmpdir(), "agent-ledger-flow-"));
    dirs.push(shared);
    const flow = (summary: string, account?: string) => appendFlowMemoryEntry(shared, {
      scope: "workflow", request: "Hamburg ferry settings", summary, targetAgent: "researcher", actions: [], outcome: "applied",
      ...(account ? { account } : {}),
    });
    flow("Bob tuned the researcher for the Hamburg ferries", safeUserSegment("bob"));
    for (let i = 1; i <= alice; i++) flow(`Alice's Hamburg change number ${i}`, safeUserSegment("alice"));
    flow("A Hamburg change from before accounts");
    return { shared, bobRoot: userWorkspaceRoot(shared, "bob") };
  }

  // The read used the caller's own root, where no flow entry is ever written: under multi-user auth
  // an account never found its own entries (found in review, 2026-10-08).
  it("under multi-user auth, shows the caller's own flow entries only, from the deployment root, chosen before the cap", async () => {
    withAuth(true);
    const { bobRoot } = seedFlow();

    const output = await agentSearchAsBob(bobRoot, "Hamburg");

    expect(output).toContain("Bob tuned the researcher");
    expect(output).not.toContain("Alice's Hamburg change");
    expect(output).not.toContain("from before accounts");
  });

  it("under multi-user auth, a sub-agent's lesson guidance carries the caller's own flow entries too", async () => {
    withAuth(true);
    const { bobRoot } = seedFlow();

    const guidance = await asBob(() => formatScopedMemoryGuidance(bobRoot, "Hamburg ferry settings", {
      sessionId: "flow-guidance-bob",
      targetAgent: "researcher",
      scopes: ["agent"],
      limit: 4,
      maxChars: 1_400,
    }));

    expect(guidance).toContain("Bob tuned the researcher");
    expect(guidance).not.toContain("Alice's Hamburg change");
    expect(guidance).not.toContain("from before accounts");
  });

  it("with one operator, shows every flow entry of the deployment as before", async () => {
    withAuth(false);
    const { shared } = seedFlow(1);

    const output = await agentSearchAsBob(shared, "Hamburg");

    expect(output).toContain("Bob tuned the researcher");
    expect(output).toContain("Alice's Hamburg change number 1");
    expect(output).toContain("from before accounts");
  });
});

describe("the account a ledger entry is written for", () => {
  it("is the user-scope segment of the request's user under multi-user auth, never the raw user id", () => {
    withAuth(true);

    expect(runWithRequestContext({ userId: "bob" }, () => recordAccount())).toBe(safeUserSegment("bob"));
    expect(safeUserSegment("bob")).not.toBe("bob");
  });

  it("is none for a request with no user, with one operator, and when the config cannot be read", () => {
    withAuth(true);
    expect(recordAccount()).toBeUndefined();

    vi.restoreAllMocks();
    withAuth(false);
    expect(runWithRequestContext({ userId: "bob" }, () => recordAccount())).toBeUndefined();

    vi.restoreAllMocks();
    vi.spyOn(configLoader, "getConfig").mockImplementation(() => { throw new Error("config unreadable"); });
    expect(runWithRequestContext({ userId: "bob" }, () => recordAccount())).toBeUndefined();
  });
});

describe("the rule the readers share", () => {
  it("counts a config that cannot be read as multi-user with no user", () => {
    vi.spyOn(configLoader, "getConfig").mockImplementation(() => { throw new Error("config unreadable"); });

    expect(searchableMemoryScopes()).toEqual(["workspace", "user", "session"]);
    expect(searchableMemoryScopes(["agent"])).toEqual([]);
  });
});
