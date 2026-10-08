import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../config/loader.js";
import { appendOutcome } from "../agent/outcomes.js";
import { _clearDurableMemoryCaches, storeWorkspaceMemoryRecord } from "../memory/service.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { safeUserSegment } from "../runtime/user-scope.js";
import { getTool } from "../tools/registry.js";
import { userWorkspaceRoot } from "../tools/workspace-path.js";

/**
 * recall_context lists no other account's delegated task (found in review, 2026-10-08).
 *
 * The agent outcome ledger is one file for the whole deployment, and an outcome's subject is the
 * task its lesson was recorded for (record_lesson, a collapsed parallel_delegate), from every
 * account. The memory section searched the agent scope with the others, and a request for the
 * "user" section always adds that section: Bob asking about his own preference got Alice's task.
 * Each entry now carries the account it was recorded for, and under multi-user auth the section
 * lists the caller's own lessons: not Alice's, and not one from before entries carried an account.
 */
const ALICE_TASK = "find a divorce lawyer in Hamburg for my custody case";
const BOB_TASK = "compare the Hamburg harbour ferry timetables for my commute";
const LEGACY_TASK = "draft a Hamburg tenancy complaint about the landlord";
const QUERY = "Welche Kanzlei in Hamburg bevorzuge ich?";

const dirs: string[] = [];

function withAuth(enabled: boolean): void {
  const real = configLoader.getConfig();
  vi.spyOn(configLoader, "getConfig").mockReturnValue({ ...real, auth: { ...real.auth, enabled } } as typeof real);
}

/** A deployment ledger holding a lesson recorded for Alice, one for Bob and one written before
 *  entries carried an account; and the root Bob works in, holding his own preference. Everything
 *  mentions Hamburg, so each matches the query by word. */
function seed(): { bobRoot: string } {
  const shared = mkdtempSync(join(tmpdir(), "recall-account-"));
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
  return { bobRoot };
}

async function recallAsBob(bobRoot: string, include?: string[]): Promise<string> {
  const result = await runWithRequestContext({ userId: "bob" }, () => getTool("recall_context")!.execute(
    { query: QUERY, ...(include ? { include } : {}) },
    { sessionId: "recall-account-bob", workspacePath: bobRoot, userId: "bob" },
  ));
  expect(result.success).toBe(true);
  return result.output;
}

describe("recall_context and the deployment's agent ledger", () => {
  beforeAll(async () => { await import("../tools/recall-context.js"); });
  afterEach(() => {
    vi.restoreAllMocks();
    _clearDurableMemoryCaches();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("under multi-user auth, answers about the user from their own memory and lessons, without another account's task", async () => {
    withAuth(true);
    const { bobRoot } = seed();

    const output = await recallAsBob(bobRoot, ["user"]);

    expect(output).toContain("Kanzlei Nordhafen");
    expect(output).toContain(BOB_TASK);
    expect(output).not.toContain(ALICE_TASK);
    expect(output).not.toContain(LEGACY_TASK);
  });

  it("under multi-user auth, leaves another account's task out of the full pack too", async () => {
    withAuth(true);
    const { bobRoot } = seed();

    const output = await recallAsBob(bobRoot);

    expect(output).toContain("Kanzlei Nordhafen");
    expect(output).toContain(BOB_TASK);
    expect(output).not.toContain(ALICE_TASK);
    expect(output).not.toContain(LEGACY_TASK);
  });

  it("with one operator, still lists the agents' lessons: the ledger is theirs", async () => {
    withAuth(false);
    const { bobRoot } = seed();

    const output = await recallAsBob(bobRoot, ["memory"]);

    for (const task of [ALICE_TASK, BOB_TASK, LEGACY_TASK]) expect(output).toContain(task);
  });
});
