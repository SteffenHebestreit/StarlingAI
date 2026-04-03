import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("tool development workflow", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-tooldev-"));
    process.env["SAI_DATA_DIR"] = tempDir;
    process.env["HOME"] = tempDir;
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    writeFileSync(process.env["SAI_CONFIG_PATH"], JSON.stringify({
      toolDevelopment: {
        enabled: true,
        requireApproval: true,
      },
    }), "utf-8");
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env["SAI_DATA_DIR"];
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("deploys an approved tool immediately without rebuild", async () => {
    const { resetConfigForTests } = await import("../config/loader.js");
    resetConfigForTests();
    await import("../tools/tool-develop.js");

    const { executeTool, getTool } = await import("../tools/registry.js");
    const { createToolDevSession, updateCode, recordTestResults, getToolDevSession } = await import("../agent/tool-dev-session.js");

    const session = createToolDevSession({
      toolName: "csv_to_json",
      description: "Convert CSV text into JSON rows",
      parametersSchema: {
        type: "object",
        properties: {
          input: { type: "string" },
        },
        required: ["input"],
      },
      sessionId: "sess-approve",
    });

    updateCode(session.id, "async function execute(args) { return JSON.stringify({ ok: true, input: args.input ?? null }); }");
    recordTestResults(session.id, [
      {
        input: { input: "a,b" },
        actualOutput: '{"ok":true}',
        passed: true,
        durationMs: 5,
      },
    ]);

    const approvalCallback = vi.fn(async () => true);
    const result = await executeTool("tool_dev_submit", { sessionId: session.id }, {
      sessionId: "sess-approve",
      workspacePath: tempDir,
      approvalCallback,
    });

    expect(result.success).toBe(true);
    expect(result.metadata?.["status"]).toBe("approved");
    expect(approvalCallback).toHaveBeenCalledWith(
      "tool_dev_submit",
      expect.objectContaining({
        sessionId: session.id,
        dynamicToolName: "selfdev__csv_to_json",
        toolName: "csv_to_json",
      }),
    );
    expect(getTool("selfdev__csv_to_json")).toBeDefined();
    expect(getToolDevSession(session.id)?.status).toBe("approved");
  });

  it("marks denied submissions as rejected and keeps the tool out of the registry", async () => {
    const { resetConfigForTests } = await import("../config/loader.js");
    resetConfigForTests();
    await import("../tools/tool-develop.js");

    const { executeTool, getTool } = await import("../tools/registry.js");
    const { createToolDevSession, updateCode, recordTestResults, getToolDevSession } = await import("../agent/tool-dev-session.js");

    const session = createToolDevSession({
      toolName: "html_to_markdown",
      description: "Transform simple HTML into markdown",
      parametersSchema: {
        type: "object",
        properties: {
          html: { type: "string" },
        },
        required: ["html"],
      },
      sessionId: "sess-deny",
    });

    updateCode(session.id, "async function execute(args) { return String(args.html ?? ''); }");
    recordTestResults(session.id, [
      {
        input: { html: "<b>x</b>" },
        actualOutput: "x",
        passed: true,
        durationMs: 4,
      },
    ]);

    const approvalCallback = vi.fn(async () => false);
    const result = await executeTool("tool_dev_submit", { sessionId: session.id }, {
      sessionId: "sess-deny",
      workspacePath: tempDir,
      approvalCallback,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("denied");
    expect(getTool("selfdev__html_to_markdown")).toBeUndefined();
    expect(getToolDevSession(session.id)?.status).toBe("rejected");
  });
});

describe("tool-dev warden", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-tooldev-warden-"));
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    writeFileSync(process.env["SAI_CONFIG_PATH"], JSON.stringify({
      toolDevelopment: {
        enabled: true,
      },
    }), "utf-8");
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("does not terminate a dev session solely because iteration count is high", async () => {
    const { resetConfigForTests } = await import("../config/loader.js");
    resetConfigForTests();

    const { createToolDevSession, updateCode, recordActivity, getToolDevSession } = await import("../agent/tool-dev-session.js");
    const { checkSession } = await import("../agent/tool-dev-warden.js");

    const session = createToolDevSession({
      toolName: "deep_refactor",
      description: "Long-running refactor helper",
      parametersSchema: { type: "object", properties: {} },
      sessionId: "sess-warden",
    });

    updateCode(session.id, "async function execute() { return 'ok'; }");
    for (let i = 0; i < 150; i++) {
      recordActivity(session.id);
    }

    checkSession(session.id);

    expect(getToolDevSession(session.id)?.status).toBe("developing");
  });
});