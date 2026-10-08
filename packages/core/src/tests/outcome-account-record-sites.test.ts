import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutcomeEntry } from "../agent/outcomes.js";
import { PRODUCT } from "../product/index.js";

/**
 * A delegated run's outcome carries the account it ran for (found in review, 2026-10-08).
 *
 * The outcome ledger is one file for the whole deployment. A reader that shows an entry's task or
 * lesson shows it, under multi-user auth, only to the account the entry was recorded for, so the
 * run has to record that account: the user-scope segment of the request it ran in, which a
 * delegated run inherits from the turn that delegated it. These runs are real in-process sub-agent
 * runs against a stubbed model.
 */

const completeMock = vi.fn();

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

const AGENT = "ledger_probe";
const dirs: string[] = [];

/** A deployment root and its config: one probe agent with no tools, multi-user auth on or off. */
function deployment(authEnabled: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "outcome-account-"));
  dirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    ...(authEnabled ? { auth: { enabled: true } } : {}),
    subAgents: {
      [AGENT]: { description: "Probe that records outcomes.", systemPrompt: "You are a probe.", tools: [], maxIterations: 2, turnTimeoutMs: 60_000 },
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  return dir;
}

function ledger(dir: string): OutcomeEntry[] {
  const file = join(dir, PRODUCT.stateDirName, "agent_outcomes.ndjson");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as OutcomeEntry);
}

/** One run of the probe agent on `task`, made in the request context of `userId` (none: no user). */
async function runAs(userId: string | undefined, dir: string, task: string): Promise<void> {
  vi.resetModules();
  (await import("../config/loader.js")).resetConfigForTests();
  completeMock.mockImplementation(() => ({
    content: "The probe finished its task and reports the result here.",
    tool_calls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "stop",
  }));
  const { runWithRequestContext } = await import("../runtime/request-context.js");
  const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
  await runWithRequestContext(userId ? { userId } : {}, () => runSubAgentWithStats({
    agentName: AGENT,
    task,
    parentSessionId: `parent-${Math.random().toString(36).slice(2)}`,
    workspacePath: dir,
  }));
}

describe("a delegated run's outcome and the account it ran for", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("under multi-user auth, records the user-scope segment of the account the run was delegated for", async () => {
    const dir = deployment(true);

    await runAs("bob", dir, "Check the Hamburg ferry times for the commute.");

    const { safeUserSegment } = await import("../runtime/user-scope.js");
    const entries = ledger(dir).filter((entry) => entry.agent === AGENT);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.account).toBe(safeUserSegment("bob"));
  });

  it("records no account for a run with no user, nor with one operator", async () => {
    const multiUser = deployment(true);
    await runAs(undefined, multiUser, "Check the Hamburg ferry times for the commute.");
    const unattended = ledger(multiUser).filter((entry) => entry.agent === AGENT);
    expect(unattended.length).toBeGreaterThan(0);
    for (const entry of unattended) expect(entry).not.toHaveProperty("account");

    const single = deployment(false);
    await runAs("bob", single, "Check the Hamburg ferry times for the commute.");
    const operator = ledger(single).filter((entry) => entry.agent === AGENT);
    expect(operator.length).toBeGreaterThan(0);
    for (const entry of operator) expect(entry).not.toHaveProperty("account");
  });
});
