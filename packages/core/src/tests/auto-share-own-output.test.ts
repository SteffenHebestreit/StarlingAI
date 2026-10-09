import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const completeMock = vi.fn();
const sharedFindings: { key: string; value: string }[] = [];

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

// Only shareFinding is replaced — the rest of the module (and the tool registrations it
// carries) has to stay real, the same reason the provider mock above spreads the actual.
vi.mock("../tools/memory.js", async (importActual) => ({
  ...(await importActual<typeof import("../tools/memory.js")>()),
  shareFinding: async (_sessionId: string, key: string, value: string) => {
    sharedFindings.push({ key, value });
  },
}));

/** Long enough to clear the 180-char auto-share floor and survive the low-value gate. */
const REPORT_BODY = [
  "# Anthropic subscription plans 2026",
  "",
  "The Max tier is offered at two levels, billed monthly, with usage limits scaling between",
  "them. Pricing shown excludes tax. Team seats are billed separately and require a minimum",
  "seat count. This section was composed by this agent from the evidence ledger available at",
  "the time of writing, and carries no external citation of its own.",
].join("\n");

const UPLOADED_SOURCE = [
  "Vendor price list, retrieved 2026-09-01.",
  "Individual tier: 20 EUR per month. Advanced tier: 90 EUR per month. Top tier: 180 EUR per",
  "month, excluding VAT. Annual billing applies a discount of two months across all tiers.",
  "Seat minimums apply to team contracts only, and are listed in the appendix of this sheet.",
].join("\n");

function writeTempConfig(config: unknown): { tempDir: string; configPath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-auto-share-own-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  return { tempDir, configPath };
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    content: "",
    tool_calls: [{ id, name, arguments: args }],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "tool_calls",
  };
}

const DONE = {
  content: "Report written.",
  tool_calls: [],
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  finishReason: "stop",
};

/**
 * A RUN'S OWN OUTPUT MUST NOT RE-ENTER THE EVIDENCE LEDGER (session 00b3675d, 2026-09-07).
 *
 * paper_author wrote a report, read it back as its FINISH step, and that read auto-shared as
 * `auto_paper_author_read_file_15g6ems`. Its next report cited that key as corroboration for a
 * plan it had itself labelled "UNVERIFIED — no official source confirms this plan exists" and
 * "Source of report: User testimony only" — while the user had just stated, correctly, that
 * they hold the plan. The agent's own doubt came back as independent verification of itself.
 */
describe("auto-share must not launder a run's own output into shared facts", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeMock.mockReset();
    sharedFindings.length = 0;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  const CONFIG = {
    subAgents: {
      paper_author: {
        description: "Drafts documents from an already-collected evidence ledger.",
        systemPrompt: "Write the report from collected evidence.",
        tools: ["write_file", "read_file", "web_search"],
        maxIterations: 12,
      },
    },
  };

  it("skips the read-back of a file this run wrote, but still shares real gathering", async () => {
    const { tempDir, configPath } = writeTempConfig(CONFIG);
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const responses = [
      toolCall("w1", "write_file", { path: "report.md", content: REPORT_BODY }),
      // The staged-build FINISH step: read the artifact back to confirm it is complete —
      // spelled as the outputPath write_file HANDED BACK, not as the path it was given.
      // That asymmetry is the normal case (write_file roots a bare name under generated/)
      // and it is why both sides go through the write resolver rather than being compared
      // as raw strings.
      toolCall("r1", "read_file", { path: "generated/report.md" }),
      toolCall("s1", "web_search", { query: "anthropic subscription plans pricing" }),
      DONE,
    ];
    completeMock.mockImplementation(async () => responses.shift() ?? DONE);

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "write_file", description: "Write a workspace file.",
      parameters: { type: "object", properties: {} },
      async execute(args) {
        return {
          success: true,
          output: `File written: ${String(args.path)} (${REPORT_BODY.length} chars)`,
          metadata: { artifactKind: "workspace_file", path: String(args.path), outputPath: `generated/${String(args.path)}` },
        };
      },
    });
    registerTool({
      name: "read_file", description: "Read a workspace file.",
      parameters: { type: "object", properties: {} },
      async execute(args) {
        return { success: true, output: String(args.path).endsWith("report.md") ? REPORT_BODY : UPLOADED_SOURCE };
      },
    });
    registerTool({
      name: "web_search", description: "Search the web.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: UPLOADED_SOURCE };
      },
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      await runSubAgentWithStats({
        agentName: "paper_author",
        task: "Write a report on subscription pricing from the collected evidence.",
        parentSessionId: "parent-auto-share-own",
        workspacePath: "/workspace",
      });

      const keys = sharedFindings.map((f) => f.key);
      // The read-back of its own report is not evidence.
      expect(keys.some((k) => k.includes("read_file"))).toBe(false);
      expect(sharedFindings.some((f) => f.value.includes("composed by this agent"))).toBe(false);
      // …but the gathering it actually did still lands, so the guard is not "never share".
      expect(keys.some((k) => k.includes("web_search"))).toBe(true);
    } finally {
      for (const t of ["write_file", "read_file", "web_search"]) unregisterTool(t);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("still shares a read of a file this run did NOT write", async () => {
    // The distinguishing case. Reading an uploaded document or another agent's output IS
    // gathering, and excluding read_file wholesale would silently drop it.
    const { tempDir, configPath } = writeTempConfig(CONFIG);
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();

    const responses = [
      toolCall("w1", "write_file", { path: "report.md", content: REPORT_BODY }),
      toolCall("r1", "read_file", { path: "uploads/vendor-price-list.txt" }),
      DONE,
    ];
    completeMock.mockImplementation(async () => responses.shift() ?? DONE);

    const { registerTool, unregisterTool } = await import("../tools/registry.js");
    registerTool({
      name: "write_file", description: "Write a workspace file.",
      parameters: { type: "object", properties: {} },
      async execute(args) {
        return { success: true, output: `File written: ${String(args.path)}`, metadata: { path: String(args.path) } };
      },
    });
    registerTool({
      name: "read_file", description: "Read a workspace file.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { success: true, output: UPLOADED_SOURCE };
      },
    });

    try {
      const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
      await runSubAgentWithStats({
        agentName: "paper_author",
        task: "Read the supplied price list and draft the comparison.",
        parentSessionId: "parent-auto-share-other",
        workspacePath: "/workspace",
      });

      expect(sharedFindings.some((f) => f.key.includes("read_file"))).toBe(true);
      expect(sharedFindings.some((f) => f.value.includes("Vendor price list"))).toBe(true);
    } finally {
      for (const t of ["write_file", "read_file"]) unregisterTool(t);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
