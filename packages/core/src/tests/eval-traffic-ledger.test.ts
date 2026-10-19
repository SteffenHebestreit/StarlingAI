import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutcomeEntry } from "../agent/outcomes.js";
import { PRODUCT } from "../product/index.js";

/**
 * Eval traffic stays out of the stores the live swarm learns from (LRN-403). An eval turn already
 * left skill statistics and its own retrieval credit alone, but the runs it delegated to still wrote
 * the outcome ledger (routing weights, adaptive timeouts, the per-agent performance note) and
 * credited their retrieved memories, and so did agents:evaluate runs. Real in-process sub-agent runs
 * against a stubbed model.
 */

const completeMock = vi.fn();
const usefulMock = vi.fn(async () => 0);
const unhelpfulMock = vi.fn(async () => 0);

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));
vi.mock("../memory/graph-service.js", async (importActual) => ({
  ...(await importActual<typeof import("../memory/graph-service.js")>()),
  graphMarkSessionRetrievalsUseful: usefulMock,
  graphMarkSessionRetrievalsUnhelpful: unhelpfulMock,
}));

const AGENT = "ledger_probe";
const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const FINAL = { content: "The probe finished its task and reports the result here.", tool_calls: [], usage: USAGE, finishReason: "stop" };
const LESSON = { content: null, tool_calls: [{ id: "lesson-1", name: "record_lesson", arguments: { lesson: "Shorter queries work better.", outcome: "success" } }], usage: USAGE, finishReason: "tool_calls" };
const dirs: string[] = [];

type Message = { role: string; content: unknown };

function deployment(): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-ledger-"));
  dirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    workspacePath: dir,
    subAgents: {
      [AGENT]: { description: "Probe that records outcomes.", systemPrompt: "You are a probe.", tools: ["record_lesson"], maxIterations: 3, turnTimeoutMs: 60_000 },
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

async function runProbe(dir: string, opts: { evalContext?: boolean; parentSessionId?: string } = {}): Promise<void> {
  vi.resetModules();
  (await import("../config/loader.js")).resetConfigForTests();
  const { runWithRequestContext } = await import("../runtime/request-context.js");
  const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
  await runWithRequestContext(opts.evalContext ? { evalTraffic: true } : {}, () => runSubAgentWithStats({
    agentName: AGENT,
    task: "Check the ferry times for the commute.",
    parentSessionId: opts.parentSessionId ?? `parent-${Math.random().toString(36).slice(2)}`,
    workspacePath: dir,
  }));
}

describe("eval traffic and the outcome ledger", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    usefulMock.mockClear();
    unhelpfulMock.mockClear();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** One lesson, then the final answer. */
  function lessonThenFinal(): void {
    completeMock.mockImplementation(async (messages: Message[]) => (messages.some((m) => m.role === "tool") ? FINAL : LESSON));
  }

  it("a live run writes its outcome and its lesson, and credits its retrievals", async () => {
    const dir = deployment();
    lessonThenFinal();
    await runProbe(dir);
    const entries = ledger(dir).filter((entry) => entry.agent === AGENT);
    expect(entries.some((entry) => entry.lesson === "Shorter queries work better.")).toBe(true);
    expect(entries.some((entry) => !entry.lesson)).toBe(true);
    expect(usefulMock.mock.calls.length + unhelpfulMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("a run inside an eval turn writes neither, and leaves its retrievals alone", async () => {
    const dir = deployment();
    lessonThenFinal();
    await runProbe(dir, { evalContext: true });
    expect(ledger(dir)).toEqual([]);
    expect(usefulMock).not.toHaveBeenCalled();
    expect(unhelpfulMock).not.toHaveBeenCalled();
  });

  it("an agents:evaluate run (parent eval:<uuid>) writes neither", async () => {
    const dir = deployment();
    lessonThenFinal();
    await runProbe(dir, { parentSessionId: "eval:0b5f3d2e" });
    expect(ledger(dir)).toEqual([]);
    expect(usefulMock).not.toHaveBeenCalled();
  });
});
