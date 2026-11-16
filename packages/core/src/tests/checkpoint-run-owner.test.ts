import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../runtime/accounts.js";
import { testAccount } from "./support/test-account.js";

/**
 * The checkpoint a delegated run opens names who the run executes as (found in review, 2026-11-14).
 *
 * The dashboard's checkpoint routes show a checkpoint to that owner (gateway/checkpoint-routes.ts).
 * They went by the chat the run was delegated from, so an account's A2A or MCP run, whose session has
 * no record, and its scene job, once the job's session was pruned, left checkpoints only an admin
 * could see. The owner is the identity the run's tools act as: the turn's, inherited through the
 * request context, or the one the run was started with. These are real in-process sub-agent runs
 * against a stubbed model.
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

/** What each createCheckpoint call was given. */
const opened = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../swarm/checkpoints.js", async (importActual) => {
  const actual = await importActual<typeof import("../swarm/checkpoints.js")>();
  return {
    ...actual,
    createCheckpoint: (opts: Parameters<typeof actual.createCheckpoint>[0]) => {
      opened.push({ ...opts });
      return actual.createCheckpoint(opts);
    },
  };
});

const AGENT = "checkpoint_probe";
const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const FINAL = { content: "The probe finished its task and reports the result here.", tool_calls: [], usage: USAGE, finishReason: "stop" };
const ALICE: Identity = { userId: "alice", account: testAccount("alice").id };
const dirs: string[] = [];

/** A deployment root and its config: the probe agent, under multi-user auth. */
function deployment(): string {
  const dir = mkdtempSync(join(tmpdir(), "checkpoint-run-owner-"));
  dirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    auth: { enabled: true, users: [testAccount("alice").record] },
    subAgents: {
      [AGENT]: { description: "Probe that opens a checkpoint.", systemPrompt: "You are a probe.", tools: [], maxIterations: 3, turnTimeoutMs: 60_000 },
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  return dir;
}

async function load() {
  vi.resetModules();
  (await import("../config/loader.js")).resetConfigForTests();
  const { runWithRequestContext } = await import("../runtime/request-context.js");
  const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
  return { runWithRequestContext, runSubAgentWithStats };
}

describe("the checkpoint a delegated run opens", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    opened.length = 0;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("names the identity the run executes as, from the turn or from the run's own options", async () => {
    const dir = deployment();
    const { runWithRequestContext, runSubAgentWithStats } = await load();
    completeMock.mockImplementation(() => FINAL);

    // Delegated from a chat turn: the turn's identity rides the request context.
    await runWithRequestContext({ identity: ALICE }, () => runSubAgentWithStats({
      agentName: AGENT, task: "Summarise the lab results.", parentSessionId: "chat-of-alice", workspacePath: dir,
    }));
    // Started by an A2A or MCP tasks/send call: the caller on the run's options, in a session no
    // record has.
    await runSubAgentWithStats({
      agentName: AGENT, task: "Draft the referral letter.", parentSessionId: `a2a-in:${ALICE.account}:task-1`, workspacePath: dir,
      userId: "alice", identity: ALICE,
    });

    expect(opened.map((checkpoint) => checkpoint["parentSessionId"])).toEqual(["chat-of-alice", `a2a-in:${ALICE.account}:task-1`]);
    expect(opened.map((checkpoint) => checkpoint["owner"])).toEqual([ALICE, ALICE]);
  });

  it("names nobody for a run that executes as nobody", async () => {
    const dir = deployment();
    const { runSubAgentWithStats } = await load();
    completeMock.mockImplementation(() => FINAL);

    await runSubAgentWithStats({ agentName: AGENT, task: "Check the ferry times.", parentSessionId: "a2a-in:shared-bearer", workspacePath: dir });

    expect(opened).toHaveLength(1);
    expect(opened[0]).not.toHaveProperty("owner");
  });
});
