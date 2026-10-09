/**
 * The narrated-action-claim check in SHADOW mode (design-tool-bridge §12). A sub-agent that held a
 * consequential tool (one whose tier requires per-call approval and is not read-only) and had NONE
 * of those tools succeed, yet whose answer states an action identifier — a git commit/tag hash or
 * an http(s) URL — that no input of the run contained, is narrating an action that did not happen.
 * Shadow writes one sub_agent_unbacked_action_claim audit row and changes neither the answer nor
 * the outcome.
 *
 * Revert proof: with the check reverted the flagged case writes no row and the first test fails.
 * Discrimination: a successful git_commit, an honest "nothing was committed" with no identifier,
 * and a hash a git_log result quoted are each NOT flagged; and under the default "off" mode even
 * the fabricated-hash answer writes no row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../tools/registry.js";

const completeMock = vi.fn();

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

type Message = { role: string; content?: string | null };
type Handler = (args: Record<string, unknown>) => ToolResult;
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const call = (id: string, name: string, args: Record<string, unknown>) =>
  ({ content: "", tool_calls: [{ id, name, arguments: args }], usage, finishReason: "tool_calls" });
const answer = (content: string) => ({ content, tool_calls: [], usage, finishReason: "stop" });
const toolResultsIn = (messages: Message[]) => messages.filter((m) => m.role === "tool").length;
const scripted = (calls: Array<{ tool: string; args: Record<string, unknown> }>, finalAnswer: string) =>
  (messages: Message[]) => {
    const done = toolResultsIn(messages);
    const next = calls[done];
    return next ? call(`c${done + 1}`, next.tool, next.args) : answer(finalAnswer);
  };

describe("narrated-action-claim shadow check", () => {
  let tempDir = "";

  const writeConfig = (mode: "off" | "shadow") => {
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      workspacePath: tempDir,
      orchestration: { unbackedActionClaims: mode },
      subAgents: {
        git_dev: {
          description: "Runs git operations.",
          systemPrompt: "GIT-KQ Operate on the repository and report what happened.",
          tools: ["git_status", "git_log", "git_commit", "git_push", "share_finding", "read_shared_facts"],
          maxIterations: 4,
        },
      },
    }), "utf8");
  };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-unbacked-claim-"));
    writeConfig("shadow");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  const registerTools = async (handlers: Record<string, Handler>) => {
    await import("../tools/sub-agent.js");
    await Promise.all([import("../tools/git.js"), import("../tools/memory.js")]);
    const { registerTool } = await import("../tools/registry.js");
    for (const [name, execute] of Object.entries(handlers)) {
      registerTool({ name, description: `Fake ${name}.`, parameters: { type: "object", properties: {} }, async execute(args) { return execute(args); } });
    }
  };

  const runGitDev = async (task: string) => {
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    return runSubAgentWithStats({
      agentName: "git_dev",
      task,
      parentSessionId: "parent-unbacked-claim",
      workspacePath: tempDir,
      approvalCallback: async () => true,
    });
  };

  const captureClaims = async () => {
    const rows: Array<Record<string, unknown>> = [];
    const { subscribeToAudit } = await import("../audit/logger.js");
    const unsubscribe = subscribeToAudit((event) => {
      if (event.type === "sub_agent_unbacked_action_claim") rows.push(event.data as Record<string, unknown>);
    });
    return { rows, unsubscribe };
  };

  it("flags a fabricated commit hash when no consequential tool succeeded", async () => {
    await registerTools({});
    completeMock.mockImplementation(async () =>
      answer("Done. I committed the change as 3f9c2ab and pushed it to origin/main."));
    const audit = await captureClaims();
    try {
      const result = await runGitDev("Commit the staged change and give me the hash.");
      // Shadow is audit-only: the answer is returned verbatim, the invented hash still present.
      expect(result.output).toContain("3f9c2ab");
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        agentName: "git_dev",
        mode: "shadow",
        consequentialToolsSucceeded: 0,
      });
      expect(Number(audit.rows[0]!["identifiers"])).toBeGreaterThanOrEqual(1);
      expect(Number(audit.rows[0]!["consequentialToolsHeld"])).toBeGreaterThanOrEqual(1);
    } finally {
      audit.unsubscribe();
    }
  });

  it("does NOT flag when a consequential tool actually succeeded", async () => {
    await registerTools({
      git_commit: () => ({ success: true, output: "[main 4f3c2a1] change\n 1 file changed", metadata: { sandboxed: true } }),
    });
    completeMock.mockImplementation(async (messages: Message[]) =>
      scripted([{ tool: "git_commit", args: { message: "change" } }], "Committed as 4f3c2a1.")(messages));
    const audit = await captureClaims();
    try {
      await runGitDev("Commit the staged change and give me the hash.");
      expect(audit.rows).toHaveLength(0);
    } finally {
      audit.unsubscribe();
    }
  });

  it("does NOT flag an honest 'nothing was committed' answer with no identifier", async () => {
    await registerTools({});
    completeMock.mockImplementation(async () =>
      answer("Approval was denied, so nothing was committed and no hash exists."));
    const audit = await captureClaims();
    try {
      await runGitDev("Commit the staged change and give me the hash.");
      expect(audit.rows).toHaveLength(0);
    } finally {
      audit.unsubscribe();
    }
  });

  it("does NOT flag a hash a read-only git_log result already contained", async () => {
    await registerTools({
      git_log: () => ({ success: true, output: "commit 3f9c2ab1c0ffee0012345\nAuthor: x\n\n  change\n", metadata: { sandboxed: true } }),
    });
    completeMock.mockImplementation(async (messages: Message[]) =>
      scripted([{ tool: "git_log", args: {} }], "The last commit is 3f9c2ab.")(messages));
    const audit = await captureClaims();
    try {
      await runGitDev("What is the last commit hash?");
      // git_log is read-only (not consequential) and its output backs the abbreviated hash.
      expect(audit.rows).toHaveLength(0);
    } finally {
      audit.unsubscribe();
    }
  });

  it("writes no row under the default 'off' mode even for a fabricated hash", async () => {
    writeConfig("off");
    (await import("../config/loader.js")).resetConfigForTests();
    await registerTools({});
    completeMock.mockImplementation(async () =>
      answer("Done. I committed the change as 3f9c2ab and pushed it to origin/main."));
    const audit = await captureClaims();
    try {
      await runGitDev("Commit the staged change and give me the hash.");
      expect(audit.rows).toHaveLength(0);
    } finally {
      audit.unsubscribe();
    }
  });
});
