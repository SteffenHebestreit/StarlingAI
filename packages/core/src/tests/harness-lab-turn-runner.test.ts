import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One harness-lab attempt end to end, on a stubbed model: the candidate's prompt is the one the
 * model is shown, the deployment's comes back afterwards, an outward tool is recorded and not run,
 * the turn's checks and audit rows are the attempt's own.
 */

const streamMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn(async () => ({
  content: "synthesized",
  tool_calls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
})));

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    complete: (...args: Parameters<typeof completeMock>) => completeMock(...args),
    stream: (...args: unknown[]) => streamMock(...args),
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    applyActiveModelPreset: (model: unknown) => model,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: () => null,
    createChatProvider: () => provider,
    tierModelDefaults: (tier: string) => (tier === "routing" ? { enableThinking: false, reasoningEffort: "none" } : {}),
  };
});
vi.mock("../guardrails/rate-limiter.js", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("../guardrails/moderation.js", () => ({
  moderateInputText: vi.fn(async () => null),
  moderateToolResultText: vi.fn(async () => null),
}));

import type { HarnessTask } from "../harness-lab/task-schema.js";

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function task(expect: HarnessTask["turns"][number]["expect"]): HarnessTask {
  return {
    id: "report-mail",
    title: "Send the weekly report",
    origin: "manual",
    tags: [],
    domain: "general",
    role: "both",
    requires: [],
    turns: [{ message: "Send the weekly report to the team.", expect }],
  };
}

/** The model stores a note once, then answers. */
function storeThenAnswer(): void {
  let calls = 0;
  streamMock.mockImplementation(() => {
    calls += 1;
    if (calls === 1) {
      return (async function* () {
        yield { type: "tool_call_start", toolCallId: "m1", toolName: "memory_store" };
        yield { type: "tool_call_delta", toolCallId: "m1", argumentsDelta: JSON.stringify({ key: "weekly-report", value: "Sent to the team." }) };
        yield { type: "done", finishReason: "tool_calls", usage: USAGE };
      })();
    }
    return (async function* () {
      yield { type: "text_delta", content: "The weekly report went out to the team." };
      yield { type: "done", finishReason: "stop", usage: USAGE };
    })();
  });
}

const memoryStore = vi.fn(async () => ({ success: true, output: "stored for real" }));

/** The modules, loaded for the config the test just wrote: the loader resolves its source on import. */
async function load() {
  vi.resetModules();
  const loader = await import("../config/loader.js");
  loader.resetConfigForTests();
  const registry = await import("../tools/registry.js");
  (await import("../harness-lab/tool-policy.js")).applyLabToolPolicy();
  const { runLabAttempt } = await import("../harness-lab/turn-runner.js");
  // Registered after the policy, as a late import would: the policy still stubs it.
  registry.registerTool({
    name: "memory_store",
    description: "Store a note.",
    parameters: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } } },
    execute: memoryStore,
  });
  const session = await import("../agent/session.js");
  return { loader, runLabAttempt, session };
}

describe("a harness-lab attempt", () => {
  beforeEach(() => {
    process.env["SAI_HARNESS_LAB_PROCESS"] = "1";
    const dir = tmp("lab-runner-config-");
    process.env["SAI_AUDIT_LOG"] = join(dir, "audit.jsonl");
    process.env["SAI_SESSION_STORE"] = join(dir, "sessions.json");
    writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
      workspacePath: dir,
      agents: { mainAssistant: { customInstructions: "BASE RULE: answer briefly." } },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  });

  afterEach(async () => {
    const session = await import("../agent/session.js");
    await session.flushSessionStore();
    session.resetSessionsForTests();
    for (const key of ["SAI_HARNESS_LAB_PROCESS", "SAI_AUDIT_LOG", "SAI_SESSION_STORE", "SAI_CONFIG_PATH"]) delete process.env[key];
    streamMock.mockReset();
    memoryStore.mockClear();
    (await import("../config/loader.js")).resetConfigForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("shows the model the candidate's prompt, records the outward call, and puts the deployment back", async () => {
    storeThenAnswer();
    const { loader, runLabAttempt } = await load();
    const liveWorkspace = loader.getConfig().workspacePath;
    const scratchRoot = tmp("lab-runner-scratch-");

    const record = await runLabAttempt(
      task({ reply: { includes: ["weekly report"] }, tools: { mustCall: ["memory_store"] } }),
      { name: "cand-1", mainAssistantInstructions: "CANDIDATE RULE: name every recipient." },
      { runId: "run-1", attempt: 1, scratchRoot, graceMs: 20 },
    );

    const system = JSON.stringify((streamMock.mock.calls[0]?.[0] as unknown[]).slice(0, 2));
    expect(system).toContain("CANDIDATE RULE: name every recipient.");
    expect(system).not.toContain("BASE RULE");
    expect(loader.getConfig().agents.mainAssistant.customInstructions).toBe("BASE RULE: answer briefly.");
    expect(loader.getConfig().workspacePath).toBe(liveWorkspace);

    expect(memoryStore).not.toHaveBeenCalled();
    expect(record.stubbedCalls).toEqual([expect.objectContaining({ tool: "memory_store", args: { key: "weekly-report", value: "Sent to the team." } })]);
    const [turn] = record.turns;
    expect(turn?.status).toBe("ok");
    expect(turn?.reply).toBe("The weekly report went out to the team.");
    expect(turn?.toolCalls.find((call) => call.name === "memory_store")?.result).toContain("[harness-lab]");
    expect(turn?.checkFailures).toEqual([]);
    expect(turn?.scorecard?.learningBasis).toBe("no_verdict");
    expect(turn?.events.length).toBeGreaterThan(0);
    expect(turn?.events.every((event) => event.sessionId?.includes(record.sessionId))).toBe(true);
    expect(record.unscored).toBeUndefined();
  });

  it("runs as eval traffic, so the runs it delegates keep out of the live learning stores", async () => {
    let calls = 0;
    streamMock.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return (async function* () {
          yield { type: "tool_call_start", toolCallId: "w1", toolName: "memory_search" };
          yield { type: "tool_call_delta", toolCallId: "w1", argumentsDelta: JSON.stringify({ query: "ferry times" }) };
          yield { type: "done", finishReason: "tool_calls", usage: USAGE };
        })();
      }
      return (async function* () {
        yield { type: "text_delta", content: "The ferries leave every hour." };
        yield { type: "done", finishReason: "stop", usage: USAGE };
      })();
    });
    const { runLabAttempt } = await load();
    const registry = await import("../tools/registry.js");
    const { currentIsEvalTraffic } = await import("../runtime/request-context.js");
    const seen: boolean[] = [];
    registry.registerTool({
      name: "memory_search",
      description: "Search memory.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      execute: async () => { seen.push(currentIsEvalTraffic()); return { success: true, output: "Ferries leave hourly." }; },
    });
    await runLabAttempt(task(undefined), { name: "base" }, { runId: "run-4", attempt: 1, scratchRoot: tmp("lab-runner-scratch-"), graceMs: 20 });
    expect(seen).toEqual([true]);
  });

  // The chat sets autoApprove for --auto, and the runtime read that as "unattended" too. The lab
  // approves through its own callback, so its --auto turns ran as attended ones: never forced to
  // their first call, ask_user without its unattended answer.
  it("an --auto task runs unattended, as in the chat, and still approves only through its own callback", async () => {
    const seen: Array<{ unattended?: boolean; autoApprove?: boolean; asks: boolean; approves: string[] }> = [];
    const searchThenAnswer = () => {
      let calls = 0;
      streamMock.mockImplementation(() => {
        calls += 1;
        if (calls === 1) {
          return (async function* () {
            yield { type: "tool_call_start", toolCallId: "w1", toolName: "memory_search" };
            yield { type: "tool_call_delta", toolCallId: "w1", argumentsDelta: JSON.stringify({ query: "report" }) };
            yield { type: "done", finishReason: "tool_calls", usage: USAGE };
          })();
        }
        return (async function* () {
          yield { type: "text_delta", content: "Done." };
          yield { type: "done", finishReason: "stop", usage: USAGE };
        })();
      });
    };
    const { runLabAttempt } = await load();
    const registry = await import("../tools/registry.js");
    registry.registerTool({
      name: "memory_search",
      description: "Search memory.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      execute: async (_args, ctx) => {
        seen.push({
          ...(ctx.unattended !== undefined ? { unattended: ctx.unattended } : {}),
          ...(ctx.autoApprove !== undefined ? { autoApprove: ctx.autoApprove } : {}),
          asks: typeof ctx.inputCallback === "function",
          approves: [],
        });
        for (const tool of ["shell_exec", "mail_send_draft"]) {
          if ((await ctx.approvalCallback?.(tool, {})) === true) seen.at(-1)!.approves.push(tool);
        }
        return { success: true, output: "nothing" };
      },
    });
    const withMessage = (message: string): HarnessTask => ({ ...task(undefined), turns: [{ message }] });

    searchThenAnswer();
    await runLabAttempt(withMessage("Send the weekly report to the team. --auto"), { name: "base" }, { runId: "run-5", attempt: 1, scratchRoot: tmp("lab-runner-scratch-"), graceMs: 20 });
    searchThenAnswer();
    await runLabAttempt(withMessage("Send the weekly report to the team."), { name: "base" }, { runId: "run-6", attempt: 1, scratchRoot: tmp("lab-runner-scratch-"), graceMs: 20 });

    expect(seen).toEqual([
      { unattended: true, autoApprove: false, asks: true, approves: ["shell_exec"] },
      { unattended: false, autoApprove: false, asks: false, approves: [] },
    ]);
  });

  it("reports the task's checks that failed", async () => {
    storeThenAnswer();
    const { runLabAttempt } = await load();
    const record = await runLabAttempt(
      task({ reply: { includes: ["invoice"] }, tools: { mustNotCall: ["memory_store"] } }),
      { name: "base" },
      { runId: "run-2", attempt: 1, scratchRoot: tmp("lab-runner-scratch-"), graceMs: 20 },
    );
    expect(record.turns[0]?.checkFailures.length).toBe(2);
    expect(record.turns[0]?.checked).toBe(true);
  });

  it("an unreachable model backend makes the attempt unscored", async () => {
    streamMock.mockImplementation(() => { throw new Error("connect ECONNREFUSED 10.0.0.5:8080"); });
    const { runLabAttempt } = await load();
    const record = await runLabAttempt(task(undefined), { name: "base" }, { runId: "run-3", attempt: 1, scratchRoot: tmp("lab-runner-scratch-"), graceMs: 20 });
    expect(record.turns[0]?.status).toBe("blocked");
    expect(record.unscored).toBe("model backend unreachable: ECONNREFUSED 10.0.0.5:8080");
  });
});
