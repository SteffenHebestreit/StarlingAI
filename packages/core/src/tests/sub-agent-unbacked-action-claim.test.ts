/**
 * The narrated-action-claim check in SHADOW mode (design-tool-bridge §12). A sub-agent that held a
 * consequential tool (one whose tier requires per-call approval and is not read-only) and had NONE
 * of those tools succeed, yet whose answer states an action identifier — a git commit/tag hash or
 * an http(s) URL — that no input of the run contained, is narrating an action that did not happen.
 * Shadow writes one sub_agent_unbacked_action_claim audit row and changes neither the answer nor
 * the outcome.
 *
 * Revert proof, each case fails without its line restored:
 *   - the check itself: reverted, the flagged case writes no row (first test);
 *   - the success premise: the committing agent's git_commit returns output that does NOT contain
 *     the hash the answer states, so the ONLY thing keeping the row away is "a consequential tool
 *     succeeded" — drop `succeededConsequentialTools.add` or `if (succeeded.length > 0) return` and
 *     the test flags it;
 *   - the pre-trim absorb gate (Finding 1): a web specialist that holds an approval-gated tool but
 *     no sandbox tool (tracksFigures=false, checksActionClaims=true) fetches a page whose URL the
 *     context trim then clamps out of history — absorbed only by the end pass the URL is already
 *     gone, so the gate must absorb before each trim for both checks, not figures alone;
 *   - the own-claim identifier set (Finding 4): a FAILED git_commit echoes the run's own commit
 *     message (with a URL the model invented) back in its error text, and that must not back the
 *     answer that narrates the commit as done.
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
        // Holds an approval-gated tool (http_request) but NO sandbox tool, so checksActionClaims is
        // true while tracksFigures is false — the exact shape Finding 1's absorb gate is about. A
        // tiny context window makes the trim clamp the first (oversized) fetch result out of history
        // after one more turn, so an identifier it carried survives only if it was absorbed before
        // the trim ran.
        web_dev: {
          description: "Fetches pages and calls HTTP endpoints.",
          systemPrompt: "WEB-KQ Fetch pages and report what you found.",
          tools: ["web_fetch", "http_request"],
          maxIterations: 4,
          model: { contextWindow: 4000 },
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

  const runAgent = async (agentName: string, task: string) => {
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    return runSubAgentWithStats({
      agentName,
      task,
      parentSessionId: "parent-unbacked-claim",
      workspacePath: tempDir,
      approvalCallback: async () => true,
    });
  };
  const runGitDev = (task: string) => runAgent("git_dev", task);

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

  it("does NOT flag when a consequential tool actually succeeded (success premise, not input)", async () => {
    // The fake output deliberately omits the hash the answer states, so the answer is NOT backed by
    // the tool result. Only the success premise — git_commit completed — keeps the row away.
    await registerTools({
      git_commit: () => ({ success: true, output: " 1 file changed, 2 insertions(+)", metadata: { sandboxed: true } }),
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

  it("flags a URL the FAILED git_commit only echoed back from the run's own commit message (Finding 4)", async () => {
    // runGitInSandbox returns "Exit code N: Command failed: … git commit -m <message>" on failure,
    // so a URL the model wrote into its own commit message comes back in the error text. That echo
    // is the run's own claim, not an input, so the answer that narrates the commit as done is
    // flagged. Without ownClaimIdentifierKeys the echoed URL counts as received and the row is lost.
    await registerTools({
      git_commit: (args) => ({
        success: false,
        output: "",
        error: `Exit code 1: Command failed: docker run --rm --network=none sai-sandbox git commit -m ${String(args["message"] ?? "")}`,
        metadata: { sandboxed: true },
      }),
    });
    const message = "Revert, see https://github.com/octo/repo/pull/4217";
    completeMock.mockImplementation(async (messages: Message[]) =>
      scripted([{ tool: "git_commit", args: { message } }],
        "Committed the revert; details at https://github.com/octo/repo/pull/4217.")(messages));
    const audit = await captureClaims();
    try {
      await runGitDev("Revert the last change and commit it.");
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({ agentName: "git_dev", consequentialToolsSucceeded: 0 });
      expect(Number(audit.rows[0]!["identifiers"])).toBeGreaterThanOrEqual(1);
    } finally {
      audit.unsubscribe();
    }
  });

  it("does NOT flag a URL received in a fetch that the context trim later clamped away (Finding 1)", async () => {
    // web_dev holds http_request (approval-gated) but no sandbox tool, so checksActionClaims is true
    // and tracksFigures is false. The first fetch returns an oversized page whose URL sits past the
    // 4 KB pin, so the next iteration's overflow clamp drops it out of history. The run genuinely
    // received the URL, so it must not be flagged — which holds only if the identifier was absorbed
    // on the pre-trim pass, before the clamp ran.
    const receivedUrl = "https://docs.example.com/api/v2/widgets";
    const bigPage = `${"x".repeat(9000)}\nSee ${receivedUrl} for the schema.\n${"y".repeat(16000)}`;
    await registerTools({
      web_fetch: () => ({ success: true, output: bigPage, metadata: {} }),
    });
    completeMock.mockImplementation(async (messages: Message[]) =>
      scripted([{ tool: "web_fetch", args: { url: "https://example.com/start" } }],
        `The widget schema is documented at ${receivedUrl}.`)(messages));
    const audit = await captureClaims();
    try {
      const result = await runAgent("web_dev", "Find the widget schema docs URL.");
      expect(result.output).toContain(receivedUrl);
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
