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
});