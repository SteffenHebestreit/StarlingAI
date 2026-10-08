import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutcomeEntry } from "../agent/outcomes.js";
import { PRODUCT } from "../product/index.js";

/**
 * A delegated run's outcomes carry the run's own task and account (found in review, 2026-10-08).
 *
 * The outcome ledger is one file for the whole deployment. A reader that shows an entry's task or
 * lesson shows it, under multi-user auth, only to the account the entry was recorded for, so the
 * run has to record that account: the user-scope segment of the request it ran in, which a
 * delegated run inherits from the turn that delegated it. And a lesson the run records belongs
 * under the run's own task. These are real in-process sub-agent runs against a stubbed model.
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
const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const FINAL = { content: "The probe finished its task and reports the result here.", tool_calls: [], usage: USAGE, finishReason: "stop" };
const dirs: string[] = [];

type Message = { role: string; content: unknown };

/** A deployment root and its config: the probe agent with the given tools, multi-user auth on or off. */
function deployment(authEnabled: boolean, tools: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "outcome-account-"));
  dirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    ...(authEnabled ? { auth: { enabled: true } } : {}),
    subAgents: {
      [AGENT]: { description: "Probe that records outcomes.", systemPrompt: "You are a probe.", tools, maxIterations: 3, turnTimeoutMs: 60_000 },
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

/** Loads the modules once for the deployment last configured; `run` makes one run of the probe
 *  agent on `task` in the request context of `userId` (none: no user). */
async function load(dir: string): Promise<{ run: (userId: string | undefined, task: string) => Promise<void>; segment: (userId: string) => string }> {
  vi.resetModules();
  (await import("../config/loader.js")).resetConfigForTests();
  const { runWithRequestContext } = await import("../runtime/request-context.js");
  const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
  const { safeUserSegment } = await import("../runtime/user-scope.js");
  return {
    run: async (userId, task) => {
      await runWithRequestContext(userId ? { userId } : {}, () => runSubAgentWithStats({
        agentName: AGENT,
        task,
        parentSessionId: `parent-${Math.random().toString(36).slice(2)}`,
        workspacePath: dir,
      }));
    },
    segment: safeUserSegment,
  };
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
    const { run, segment } = await load(dir);
    completeMock.mockImplementation(() => FINAL);

    await run("bob", "Check the Hamburg ferry times for the commute.");

    const entries = ledger(dir).filter((entry) => entry.agent === AGENT);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.account).toBe(segment("bob"));
  });

  it("records no account for a run with no user, nor with one operator", async () => {
    const multiUser = deployment(true);
    completeMock.mockImplementation(() => FINAL);
    await (await load(multiUser)).run(undefined, "Check the Hamburg ferry times for the commute.");
    const unattended = ledger(multiUser).filter((entry) => entry.agent === AGENT);
    expect(unattended.length).toBeGreaterThan(0);
    for (const entry of unattended) expect(entry).not.toHaveProperty("account");

    const single = deployment(false);
    await (await load(single)).run("bob", "Check the Hamburg ferry times for the commute.");
    const operator = ledger(single).filter((entry) => entry.agent === AGENT);
    expect(operator.length).toBeGreaterThan(0);
    for (const entry of operator) expect(entry).not.toHaveProperty("account");
  });
});

describe("record_lesson and the run that records it", () => {
  const TASK_A = "Find a family-law firm in Hamburg for the custody hearing.";
  const TASK_B = "Compare the Hamburg harbour ferry timetables for the commute.";
  const LESSON_A = "The bar association register lists family-law specialists by district.";

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Run A of the probe agent starts; run B of the same agent runs to its end while A is still at
   * its first step; then A records a lesson. B's outcome is now the newest ledger entry for the
   * agent's name, which is what record_lesson used to file the lesson under.
   */
  async function interleave(authEnabled: boolean, userA: string | undefined, userB: string | undefined): Promise<{ dir: string; segment: (userId: string) => string }> {
    const dir = deployment(authEnabled, ["record_lesson"]);
    const { run, segment } = await load(dir);
    let finishB!: () => void;
    const bFinished = new Promise<void>((resolve) => { finishB = resolve; });
    let aAtFirstStep = false;
    completeMock.mockImplementation(async (messages: Message[]) => {
      const isRunA = messages.some((message) => message.role === "user" && String(message.content).includes(TASK_A));
      const lessonRecorded = messages.some((message) => message.role === "tool");
      if (!isRunA || lessonRecorded) return FINAL;
      aAtFirstStep = true;
      await bFinished;
      return {
        content: null,
        tool_calls: [{ id: "lesson-a", name: "record_lesson", arguments: { lesson: LESSON_A, outcome: "success" } }],
        usage: USAGE,
        finishReason: "tool_calls",
      };
    });

    const runA = run(userA, TASK_A);
    await vi.waitFor(() => expect(aAtFirstStep).toBe(true), { timeout: 30_000 });
    await run(userB, TASK_B);
    finishB();
    await runA;
    return { dir, segment };
  }

  it("files the lesson under its own run's task and account, though another account's run of the agent finished in between", async () => {
    const { dir, segment } = await interleave(true, "alice", "bob");

    const entries = ledger(dir);
    expect(entries.find((entry) => entry.task === TASK_B)).toMatchObject({ account: segment("bob") });
    const lesson = entries.find((entry) => entry.lesson === LESSON_A);
    expect(lesson).toMatchObject({ agent: AGENT, task: TASK_A, account: segment("alice") });
  });

  it("with one operator, files the lesson under its own run's task, though another task's run finished in between", async () => {
    const { dir } = await interleave(false, undefined, undefined);

    const lesson = ledger(dir).find((entry) => entry.lesson === LESSON_A);
    expect(lesson).toMatchObject({ agent: AGENT, task: TASK_A });
    expect(lesson).not.toHaveProperty("account");
  });
});
