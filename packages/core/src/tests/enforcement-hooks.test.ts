import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Enforcement hooks: a hint after a recurring error, a per-run cap, a write checked at once, applied
 * by the tool registry to every call. The hooks come from a real config file, through the schema.
 */
const audit = vi.hoisted(() => [] as Array<{ type: string; data: Record<string, unknown> }>);
vi.mock("../audit/logger.js", () => ({
  logAudit: (type: string, data: Record<string, unknown>) => { audit.push({ type, data }); },
  subscribeToAudit: () => () => {},
  flushAuditLog: async () => undefined,
}));

let dir = "";
let workspace = "";
let ran: string[] = [];

async function setup(hooks: Record<string, unknown>) {
  dir = mkdtempSync(join(tmpdir(), "sai-hooks-"));
  workspace = join(dir, "ws");
  mkdirSync(join(workspace, "generated"), { recursive: true });
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({ enforcementHooks: hooks }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  (await import("../config/loader.js")).resetConfigForTests();
  const registry = await import("../tools/registry.js");
  (await import("../tools/enforcement-hooks.js")).resetEnforcementHooksForTests();
  ran = [];
  registry.registerTool({
    name: "web_fetch",
    description: "Look up a rate.",
    parameters: { type: "object", properties: {} },
    async execute(args) {
      ran.push("web_fetch");
      return args["fail"] ? { success: false, output: "", error: String(args["fail"]) } : { success: true, output: "1.08" };
    },
  });
  registry.registerTool({
    name: "generate_svg",
    description: "Write a file.",
    parameters: { type: "object", properties: {} },
    async execute(args) {
      const rel = String(args["path"]);
      if (args["body"] !== undefined) writeFileSync(join(workspace, rel), String(args["body"]), "utf8");
      return { success: true, output: `saved ${rel}`, metadata: { outputPath: rel } };
    },
  });
  return registry;
}

afterEach(async () => {
  delete process.env["SAI_CONFIG_PATH"];
  (await import("../config/loader.js")).resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
  audit.length = 0;
});

/** A tool context: a sub-agent's by default, the orchestrator's (no agent name) with `agent: null`. */
const ctx = (sessionId = "sub:root-1:coder:1", agent: string | null = "coder") => ({ sessionId, workspacePath: workspace, ...(agent ? { currentAgentName: agent } : {}) });

describe("cap_tool", () => {
  beforeEach(async () => {
    await setup({ "rate-cap": { action: "cap_tool", tools: ["web_fetch"], agents: ["coder"], maxCalls: 2, message: "Use the rate you have." } });
  });

  it("refuses a call over the cap without running it, per run and per agent", async () => {
    const { executeTool } = await import("../tools/registry.js");
    expect((await executeTool("web_fetch", {}, ctx())).success).toBe(true);
    expect((await executeTool("web_fetch", {}, ctx())).success).toBe(true);
    const third = await executeTool("web_fetch", {}, ctx());
    expect(third).toMatchObject({ success: false, error: expect.stringMatching(/limit of 2 call\(s\) in this run \(enforcement hook rate-cap\)\. Use the rate you have\./) });
    expect(ran).toHaveLength(2);
    expect(audit).toContainEqual({ type: "enforcement_hook_fired", data: expect.objectContaining({ hook: "rate-cap", action: "cap_tool", agent: "coder" }) });
    // Another run starts afresh; another agent is not watched.
    expect((await executeTool("web_fetch", {}, ctx("sub:root-1:coder:2"))).success).toBe(true);
    expect((await executeTool("web_fetch", {}, ctx("sub:root-1:researcher:1", "researcher"))).success).toBe(true);
  });
});

describe("append_hint", () => {
  beforeEach(async () => {
    await setup({
      "rate-hint": { action: "append_hint", tools: ["web_fetch"], errorMatches: "unknown currency", after: 2, hint: "Use ISO codes such as EUR or USD." },
      "broken-regex": { action: "append_hint", tools: ["web_fetch"], errorMatches: "([", hint: "never shown" },
      "switched-off": { action: "append_hint", tools: ["web_fetch"], enabled: false, hint: "never shown either" },
    });
  });

  it("adds the hint once the matching failure recurred, and to nothing else", async () => {
    const { executeTool } = await import("../tools/registry.js");
    const first = await executeTool("web_fetch", { fail: "Unknown currency 'euro'" }, ctx());
    expect(first.error).toBe("Unknown currency 'euro'");
    const other = await executeTool("web_fetch", { fail: "rate service down" }, ctx());
    expect(other.error).toBe("rate service down");
    const second = await executeTool("web_fetch", { fail: "Unknown currency 'dollar'" }, ctx());
    expect(second.error).toBe("Unknown currency 'dollar'\nHint (enforcement hook rate-hint): Use ISO codes such as EUR or USD.");
    const success = await executeTool("web_fetch", {}, ctx());
    expect(success).toMatchObject({ success: true, output: "1.08" });
    expect(success.error).toBeUndefined();
    expect(JSON.stringify(audit)).not.toContain("never shown");
    expect(audit.filter((row) => row.type === "enforcement_hook_fired").map((row) => row.data["hook"])).toEqual(["rate-hint"]);
  });

  it("watches the orchestrator as main_assistant, per turn", async () => {
    await setup({ "main-hint": { action: "append_hint", tools: ["web_fetch"], agents: ["main_assistant"], hint: "Ask the researcher." } });
    const { executeTool } = await import("../tools/registry.js");
    // A hook without a pattern still never touches a call that worked.
    const worked = await executeTool("web_fetch", {}, ctx("session-1", null));
    expect(worked.error).toBeUndefined();
    expect((await executeTool("web_fetch", { fail: "x" }, ctx("session-1", null))).error).toContain("Ask the researcher.");
    expect((await executeTool("web_fetch", { fail: "x" }, ctx())).error).toBe("x");
  });
});

describe("verify_write", () => {
  beforeEach(async () => {
    await setup({ "verify": { action: "verify_write", tools: ["generate_svg", "write_file"] } });
  });

  it.each([
    ["a file that is not there", { path: "generated/missing.txt" }, /but it does not exist/],
    ["an empty file", { path: "generated/empty.txt", body: "" }, /but it is empty/],
    ["JSON that does not parse", { path: "generated/data.json", body: "{\"a\": 1," }, /not valid JSON/],
    ["a cut-off SVG", { path: "generated/logo.svg", body: "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect/>" }, /not a complete SVG/],
    ["a fenced Mermaid file", { path: "generated/flow.mmd", body: "%% Flow\n```mermaid\nflowchart TD\nA-->B\n```\n" }, /does not start with a Mermaid diagram type/],
  ])("turns a reported write of %s into a failure", async (_label, args, problem) => {
    const { executeTool } = await import("../tools/registry.js");
    const result = await executeTool("generate_svg", args, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(problem);
    expect(result.error).toMatch(/enforcement hook verify/);
  });

  it.each([
    ["valid JSON", { path: "generated/data.json", body: "{\"a\": 1}" }],
    ["a whole SVG", { path: "generated/logo.svg", body: "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect/></svg>\n" }],
    ["a Mermaid file with a title, an init line and front matter", { path: "generated/flow.mmd", body: "%% Flow\n%%{init: { \"theme\": \"neutral\" }}%%\n---\ntitle: Flow\n---\nflowchart TD\nA-->B\n" }],
    ["a beta Mermaid type", { path: "generated/arch.mmd", body: "architecture-beta\n  service db(database)[Database]\n" }],
    ["a file of another type", { path: "generated/notes.txt", body: "anything" }],
  ])("passes %s", async (_label, args) => {
    const { executeTool } = await import("../tools/registry.js");
    expect((await executeTool("generate_svg", args, ctx())).success).toBe(true);
  });

  it("holds a file writer to the content it wrote, chunks included", async () => {
    await import("../tools/filesystem.js");
    const { executeTool } = await import("../tools/registry.js");
    const scoped = { ...ctx(), workspaceScope: "generated" as const };
    expect((await executeTool("write_file", { path: "page.html", content: "<html><body>part one" }, scoped)).success).toBe(true);
    // An incomplete page between two chunks is no failure: the form is not checked for a file writer.
    expect((await executeTool("write_file", { path: "page.html", content: " and two</body></html>", mode: "append" }, scoped)).success).toBe(true);
  });

  it("fails a file writer whose content did not land", async () => {
    await setup({ "verify": { action: "verify_write", tools: ["edit_file"] } });
    const registry = await import("../tools/registry.js");
    // An edit that reports success while the file holds something else.
    registry.registerTool({
      name: "edit_file",
      description: "Edit a file.",
      parameters: { type: "object", properties: {} },
      async execute() {
        writeFileSync(join(workspace, "generated/notes.md"), "the old text", "utf8");
        return { success: true, output: "edited", metadata: { outputPath: "generated/notes.md" } };
      },
    });
    const result = await registry.executeTool("edit_file", { path: "notes.md", old_string: "old", new_string: "the new text" }, ctx());
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/the content the call wrote is not in it/) });
  });

  it("checks a write before a hint answers the failure it found", async () => {
    await setup({
      "a-hint": { action: "append_hint", tools: ["generate_svg"], hint: "Close the svg element." },
      "z-verify": { action: "verify_write", tools: ["generate_svg"] },
    });
    const { executeTool } = await import("../tools/registry.js");
    const result = await executeTool("generate_svg", { path: "generated/logo.svg", body: "<svg>" }, ctx());
    expect(result.error).toMatch(/not a complete SVG[\s\S]*Hint \(enforcement hook a-hint\): Close the svg element\./);
  });

  it("checks nothing it cannot place: no reported file, or one outside the workspace", async () => {
    const { executeTool } = await import("../tools/registry.js");
    expect((await executeTool("generate_svg", { path: "../outside.txt" }, ctx())).success).toBe(true);
    expect((await executeTool("web_fetch", {}, ctx())).success).toBe(true);
  });
});
