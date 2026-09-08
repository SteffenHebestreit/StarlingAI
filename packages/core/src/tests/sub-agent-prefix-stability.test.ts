import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendFlowMemoryEntry } from "../agent/flow-memory.js";

/**
 * THE SUB-AGENT PREFIX IS A CACHE KEY.
 *
 * Measured against the serving cluster on 2026-09-08 (llama.cpp f3f1a8f, Vulkan,
 * deepseek-v4-flash, 4.7k-token prefixes):
 *
 *   identical prefix, repeated .................  0.41 s     4 tok reprocessed
 *   same bytes, REORDERED ...................... 41.63 s  4696 tok reprocessed
 *   40 chars prepended at the HEAD ............. 41.82 s  4720 tok reprocessed
 *   the same 40 chars appended at the TAIL .....  4.18 s   283 tok reprocessed
 *
 * and the cache holds many prefixes at once — six distinct ones stayed simultaneously
 * warm at 0.41 s each — so a per-agent prefix that never changes stays hot across other
 * agents' runs. That makes the head worth ~40 s per sub-agent run on this hardware.
 *
 * The head used to carry flow, skill and memory guidance. All three are RAG retrievals
 * keyed on the TASK TEXT, so they differed on every run, and the tool schema block renders
 * directly behind them — 40,717 chars of it for infrastructure_agent against 2,394 chars
 * of system prompt. Every run paid a full cold prefill to re-read tools that had not moved.
 */

const completeMock = vi.fn();
const rerankSpy = vi.fn();

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

// Spread the real registry: sub-agent.ts also takes getToolsAsLLMDefs / executeTool /
// normalizeToolCall from it, and a bare factory would leave those undefined. Only the
// rerank is intercepted, to record the KEY the ordering is derived from.
vi.mock("../tools/registry.js", async (importActual) => {
  const actual = await importActual<typeof import("../tools/registry.js")>();
  return {
    ...actual,
    rerankToolsForTask: (defs: unknown, key: string, minTools?: number) => {
      rerankSpy(key);
      return actual.rerankToolsForTask(defs as never, key, minTools);
    },
  };
});

const AGENT = "prefix_probe";
const DESCRIPTION = "Probe specialist that exercises prompt-prefix stability.";

/** Two tasks with deliberately disjoint vocabulary, so they retrieve different memories. */
const TASK_NGINX = "Deploy the nginx container to staging and roll back the release on failure.";
const TASK_REVENUE = "Summarise the quarterly revenue spreadsheet and reconcile the totals.";

interface Captured {
  head: string;
  userTurn: string;
  tail: string;
  rerankKey: string | undefined;
  promptChars: number;
}

describe("sub-agent prompt prefix is stable across tasks", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    rerankSpy.mockReset();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
  });

  /**
   * One workspace, seeded with two flow memories that match one task each. Both are scoped
   * to this agent because searchFlowMemory filters on targetAgent before it scores.
   */
  const makeWorkspace = (orchestration?: Record<string, unknown>, seedMemory = true): string => {
    const dir = mkdtempSync(join(tmpdir(), "sai-prefix-"));
    writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
      ...(orchestration ? { orchestration } : {}),
      subAgents: {
        [AGENT]: {
          description: DESCRIPTION,
          systemPrompt: "You are a probe.",
          tools: ["write_file", "edit_file", "read_file", "list_files", "create_dir", "web_search", "web_fetch", "http_request"],
          maxIterations: 2,
          turnTimeoutMs: 60_000,
        },
      },
    }), "utf8");
    if (!seedMemory) return dir;
    appendFlowMemoryEntry(dir, {
      scope: "workflow",
      request: "deploy nginx container staging rollback",
      summary: "Deploying the nginx container to staging needs a rollback step for the release",
      targetAgent: AGENT,
      outcome: "success",
      lesson: "Always stage the nginx rollback before the deploy",
    });
    appendFlowMemoryEntry(dir, {
      scope: "workflow",
      request: "quarterly revenue spreadsheet totals reconcile",
      summary: "Reconciling the quarterly revenue spreadsheet totals requires the ledger export",
      targetAgent: AGENT,
      outcome: "success",
      lesson: "Pull the ledger export before reconciling revenue totals",
    });
    return dir;
  };

  const run = async (task: string, dir: string): Promise<Captured> => {
    process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();

    let systemMessages: string[] = [];
    let userTurn = "";
    completeMock.mockImplementation((messages: Array<{ role: string; content: string }>) => {
      systemMessages = messages.filter((m) => m.role === "system").map((m) => m.content);
      userTurn = messages.find((m) => m.role === "user")?.content ?? "";
      return {
        content: "Done.",
        tool_calls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      };
    });

    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    const result = await runSubAgentWithStats({
      agentName: AGENT,
      task,
      parentSessionId: `parent-${Math.random().toString(36).slice(2)}`,
      workspacePath: dir,
    });

    return {
      head: systemMessages[0] ?? "",
      userTurn,
      tail: systemMessages.slice(1).join("\n\n"),
      rerankKey: rerankSpy.mock.calls.at(-1)?.[0] as string | undefined,
      promptChars: result.stats.promptChars,
    };
  };

  it("sends a BYTE-IDENTICAL head for two different tasks", async () => {
    const dir = makeWorkspace();
    const a = await run(TASK_NGINX, dir);
    const b = await run(TASK_REVENUE, dir);

    // The whole point: not "similar", not "same length". Byte identical, or the tool
    // block behind it re-prefills from scratch.
    expect(a.head).toBe(b.head);
    expect(a.head).toContain("You are a probe.");
  });

  it("keeps every trace of the task out of the head", async () => {
    const dir = makeWorkspace();
    const { head } = await run(TASK_NGINX, dir);

    // The retrieval that matched this task must not have leaked into the cached prefix.
    expect(head).not.toContain("Learned Flow Guidance");
    expect(head).not.toContain("nginx");
    expect(head).not.toContain("rollback");
  });

  it("still DELIVERS the retrieved guidance, with the task", async () => {
    const dir = makeWorkspace();
    const { userTurn } = await run(TASK_NGINX, dir);

    // Guards the lazy version of this fix: deleting the guidance would also make the head
    // stable, and would silently drop what the agent had learned.
    expect(userTurn).toContain("Learned Flow Guidance");
    expect(userTurn).toContain("nginx");
  });

  it("does NOT put run-constant context in a trailing message", async () => {
    const dir = makeWorkspace();
    const { tail } = await run(TASK_NGINX, dir);

    // A trailing message sits behind a history that grows every iteration, so anything
    // constant for the run would be re-prefilled on EVERY call — up to maxIterations times.
    // That recurrence can exceed the single cold head+tool prefill this change saves, which
    // is why the context rides with history[0] instead. The tail is for per-iteration nudges.
    expect(tail).not.toContain("Learned Flow Guidance");
  });

  it("retrieves DIFFERENT guidance per task — so the fixture really discriminates", async () => {
    const dir = makeWorkspace();
    const a = await run(TASK_NGINX, dir);
    const b = await run(TASK_REVENUE, dir);

    // Without this, the head could be identical merely because nothing was ever retrieved,
    // and the first test would pass against the unfixed code too.
    //
    // Compare ONLY the retrieved block. Asserting on the whole user turn is vacuous here: the
    // turn also carries the task, and the tasks themselves contain "nginx" and "revenue", so
    // `toContain("nginx")` passes with the retrieval deleted entirely.
    const guidanceOf = (turn: string): string => {
      const start = turn.indexOf("## Learned Flow Guidance");
      return start === -1 ? "" : turn.slice(start);
    };
    expect(guidanceOf(a.userTurn)).not.toBe("");
    expect(guidanceOf(b.userTurn)).not.toBe("");
    expect(guidanceOf(a.userTurn)).not.toBe(guidanceOf(b.userTurn));
  });

  it("puts the context back in the head when stablePromptPrefix is off", async () => {
    // The kill switch has to actually switch. Same flag name as the orchestrator's, so an
    // operator who turns it off gets the pre-cache-fix shape in BOTH places, not one of them.
    const dir = makeWorkspace({ stablePromptPrefix: false });
    const { head, userTurn } = await run(TASK_NGINX, dir);

    expect(head).toContain("Learned Flow Guidance");
    expect(userTurn).not.toContain("Learned Flow Guidance");
  });

  it("still counts the moved context in promptChars", async () => {
    // promptChars answers one question: how much of the window the INPUT ate, and therefore
    // how little was left for the derived output budget. Moving the retrievals out of the
    // system prompt must not make them invisible to it — that would be a silent under-report
    // that reads as free headroom. Same agent, same task, so the only difference between the
    // two runs is whether anything was retrieved at all.
    const seeded = await run(TASK_NGINX, makeWorkspace(undefined, true));
    const empty = await run(TASK_NGINX, makeWorkspace(undefined, false));

    expect(seeded.userTurn).toContain("Learned Flow Guidance");
    expect(empty.userTurn).not.toContain("Learned Flow Guidance");
    expect(seeded.promptChars).toBeGreaterThan(empty.promptChars);
  });

  it("orders tools by the AGENT's role, not by the task", async () => {
    const dir = makeWorkspace();
    const a = await run(TASK_NGINX, dir);
    const b = await run(TASK_REVENUE, dir);

    // Same key for both runs, and it is the agent's own description — so the tool block
    // is byte-identical across every run of this agent instead of being re-sorted per task.
    expect(a.rerankKey).toBe(DESCRIPTION);
    expect(b.rerankKey).toBe(DESCRIPTION);
  });
});
