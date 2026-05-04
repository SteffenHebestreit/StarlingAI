import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

describe("tool registry approval enforcement", () => {
  beforeAll(async () => {
    await import("../tools/http-request.js");
    await import("../tools/git.js");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fails closed when a per-call approval tool has no approval channel", async () => {
    const { executeTool } = await import("../tools/registry.js");

    const result = await executeTool("http_request", {
      url: "https://example.com/healthz",
    }, {
      sessionId: "approval-none",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Tool 'http_request' requires human approval but no approval channel is available");
  });

  it("returns a denial error when the approval callback rejects a privileged tool", async () => {
    const approvalCallback = vi.fn(async () => false);
    const { executeTool } = await import("../tools/registry.js");

    const result = await executeTool("http_request", {
      url: "https://example.com/healthz",
    }, {
      sessionId: "approval-denied",
      workspacePath: "/workspace",
      approvalCallback,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Tool 'http_request' execution denied by user");
    expect(approvalCallback).toHaveBeenCalledWith("http_request", { url: "https://example.com/healthz" });
  });

  it("enforces scene human-in-the-loop approval even for a read-only tool", async () => {
    const approvalCallback = vi.fn(async () => false);
    const { executeTool } = await import("../tools/registry.js");

    const result = await executeTool("git_status", {
      path: "packages/core",
    }, {
      sessionId: "approval-scene-gate",
      workspacePath: "/workspace",
      approvalCallback,
      humanInLoopSteps: ["git_status"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Tool 'git_status' execution denied by user");
    expect(approvalCallback).toHaveBeenCalledWith("git_status", { path: "packages/core" });
  });

  it("propagates a rejection from the approval callback (e.g. timeout) as the tool error", async () => {
    // rpc.ts rejects the approval promise on timeout rather than resolving false,
    // so the error message says "timed out" instead of "denied by user".
    // The try-catch in registry.ts must propagate the rejection message directly.
    const approvalCallback = vi.fn(() =>
      Promise.reject(new Error("Tool 'http_request' approval timed out (no response within 60 s)")),
    );
    const { executeTool } = await import("../tools/registry.js");

    const result = await executeTool("http_request", {
      url: "https://example.com/healthz",
    }, {
      sessionId: "approval-timeout",
      workspacePath: "/workspace",
      approvalCallback,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    expect(result.error).not.toContain("denied by user");
  });

  // Regression: audit session 5b7a67ba (May 2026).  run_workflow called
  // resolveJobSteps which threw "Job step references unknown scene: X" when
  // the scene was missing.  executeTool didn't catch handler exceptions —
  // the throw propagated out of the tool dispatcher in agent/runtime.ts,
  // the turn died silently, and the audit pipeline never logged
  // tool_call_failed (only the leading tool_call_requested).  Now the
  // executor catches all handler throws and returns a normal failure
  // ToolResult so the runtime can react and the audit can record it.
  it("catches handler exceptions and returns a failure ToolResult", async () => {
    const { executeTool, registerTool, unregisterTool, getTool } = await import("../tools/registry.js");

    // Use an allow-listed tool name so registerTool's tier check passes.
    // share_finding is tier 0 and safe to overwrite for the duration of
    // this test — the original handler is restored in finally.
    const toolName = "share_finding";
    const original = getTool(toolName);
    registerTool({
      name: toolName,
      description: "Test override that throws synchronously to verify executeTool catches it.",
      parameters: {},
      async execute() {
        throw new Error("simulated handler failure");
      },
    });
    try {
      const result = await executeTool(toolName, {}, {
        sessionId: "exec-catch",
        workspacePath: "/workspace",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("threw an exception");
      expect(result.error).toContain("simulated handler failure");
    } finally {
      if (original) {
        registerTool(original);
      } else {
        unregisterTool(toolName);
      }
    }
  });
});