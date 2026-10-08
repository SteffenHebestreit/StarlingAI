import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configLoader from "../config/loader.js";
import { appendOutcome } from "../agent/outcomes.js";
import { _clearDurableMemoryCaches, storeWorkspaceMemoryRecord } from "../memory/service.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { getTool } from "../tools/registry.js";
import { userWorkspaceRoot } from "../tools/workspace-path.js";

/**
 * recall_context lists no other account's delegated task (found in review, 2026-10-08).
 *
 * The agent outcome ledger is one file for the whole deployment, and an outcome's subject is the
 * task its lesson was recorded for (record_lesson, a collapsed parallel_delegate), from every
 * account. The memory section searched the agent scope with the others, and a request for the
 * "user" section always adds that section: Bob asking about his own preference got Alice's task.
 */
const ALICE_TASK = "find a divorce lawyer in Hamburg for my custody case";
const QUERY = "Welche Kanzlei in Hamburg bevorzuge ich?";

const dirs: string[] = [];

function withAuth(enabled: boolean): void {
  const real = configLoader.getConfig();
  vi.spyOn(configLoader, "getConfig").mockReturnValue({ ...real, auth: { ...real.auth, enabled } } as typeof real);
}

/** A deployment root whose ledger holds one lesson about Alice's task, and the root Bob works in
 *  holding his own preference. Both mention Hamburg, so either matches the query by word. */
function seed(): { bobRoot: string } {
  const shared = mkdtempSync(join(tmpdir(), "recall-account-"));
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

  it("under multi-user auth, answers about the user from their own memory, without another account's task", async () => {
    withAuth(true);
    const { bobRoot } = seed();

    const output = await recallAsBob(bobRoot, ["user"]);

    expect(output).toContain("Kanzlei Nordhafen");
    expect(output).not.toContain(ALICE_TASK);
  });

  it("under multi-user auth, leaves another account's task out of the full pack too", async () => {
    withAuth(true);
    const { bobRoot } = seed();

    const output = await recallAsBob(bobRoot);

    expect(output).toContain("Kanzlei Nordhafen");
    expect(output).not.toContain(ALICE_TASK);
  });

  it("with one operator, still lists the agents' lessons: the ledger is theirs", async () => {
    withAuth(false);
    const { bobRoot } = seed();

    const output = await recallAsBob(bobRoot, ["memory"]);

    expect(output).toContain(ALICE_TASK);
  });
});
