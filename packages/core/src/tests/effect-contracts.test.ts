/**
 * SEC-106 slice 1: effect contracts — receipts with terminal-or-unknown
 * outcomes, and the shadow/enforce approval policy for external mutations.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeTool, registerTool, unregisterTool, type ToolContext } from "../tools/registry.js";
import { subscribeToAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";

const testState = vi.hoisted(() => ({ effectContracts: "off" as "off" | "shadow" | "enforce" }));

vi.mock("../config/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/loader.js")>();
  return {
    ...original,
    getConfig: vi.fn(() => {
      const config = original.getConfig();
      return { ...config, guardrails: { ...config.guardrails, effectContracts: testState.effectContracts } };
    }),
  };
});

const ctx: ToolContext = { sessionId: "effect-test", workspacePath: "/tmp" };

// Register under `web_search` — a TOOL_TIER_MAP name whose tier requires no
// per-call approval — so the tests isolate the EFFECT policy from the tier
// policy. afterEach unregisters the override.
function registerEffectTool(name: string, opts: {
  reversibility: "pure" | "idempotent" | "compensatable" | "irreversible";
  domain?: "messaging" | "web_mutation" | "local_workspace";
  execute?: () => Promise<{ success: boolean; output: string; error?: string }>;
  timeoutMs?: number;
}): void {
  registerTool({
    name,
    description: "effect test tool",
    parameters: { type: "object", properties: {}, required: [] },
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    effect: {
      domain: opts.domain ?? "web_mutation",
      reversibility: opts.reversibility,
      target: (args) => `host-${String(args["endpoint"] ?? "default")}`,
    },
    execute: opts.execute ?? (async () => ({ success: true, output: "ok" })),
  });
}

function captureAudits(types: string[]): { events: Array<{ type: string; data: Record<string, unknown> }>; stop: () => void } {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const unsubscribe = subscribeToAudit((entry) => {
    if (types.includes(entry.type)) events.push({ type: entry.type, data: entry.data as Record<string, unknown> });
  });
  return { events, stop: unsubscribe };
}

describe("SEC-106 effect contracts", () => {
  afterEach(() => {
    testState.effectContracts = "off";
    unregisterTool("web_search");
    vi.mocked(getConfig).mockClear();
  });

  it("off mode: effect metadata is inert — no receipts, no policy", async () => {
    testState.effectContracts = "off";
    registerEffectTool("web_search", { reversibility: "irreversible" });
    const { events, stop } = captureAudits(["effect_receipt", "effect_approval_would_block"]);
    const result = await executeTool("web_search", {}, ctx);
    stop();
    expect(result.success).toBe(true);
    expect(events).toEqual([]);
  });

  it("shadow mode: executes WITHOUT approval but records the would-block and a succeeded receipt", async () => {
    testState.effectContracts = "shadow";
    registerEffectTool("web_search", { reversibility: "irreversible" });
    const { events, stop } = captureAudits(["effect_receipt", "effect_approval_would_block"]);
    const result = await executeTool("web_search", { endpoint: "prod" }, ctx);
    stop();
    expect(result.success).toBe(true);
    const wouldBlock = events.find((e) => e.type === "effect_approval_would_block");
    expect(wouldBlock?.data["tool"]).toBe("web_search");
    expect(wouldBlock?.data["target"]).toBe("host-prod");
    const receipt = events.find((e) => e.type === "effect_receipt");
    expect(receipt?.data["outcome"]).toBe("succeeded");
    expect(receipt?.data["requestHash"]).toMatch(/^[a-f0-9]{16}$/);
  });

  it("enforce mode: an irreversible external mutation without an approval channel is BLOCKED", async () => {
    testState.effectContracts = "enforce";
    registerEffectTool("web_search", { reversibility: "irreversible" });
    const result = await executeTool("web_search", {}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("approval");
  });

  it("enforce mode: runs when the approval callback approves; denial blocks", async () => {
    testState.effectContracts = "enforce";
    registerEffectTool("web_search", { reversibility: "irreversible" });
    const approved = await executeTool("web_search", {}, { ...ctx, approvalCallback: async () => true });
    expect(approved.success).toBe(true);
    const denied = await executeTool("web_search", {}, { ...ctx, approvalCallback: async () => false });
    expect(denied.success).toBe(false);
  });

  it("enforce mode: PURE and IDEMPOTENT effects do not demand approval", async () => {
    testState.effectContracts = "enforce";
    registerEffectTool("web_search", { reversibility: "idempotent" });
    expect((await executeTool("web_search", {}, ctx)).success).toBe(true);
    unregisterTool("web_search");
    registerEffectTool("web_search", { reversibility: "pure" });
    expect((await executeTool("web_search", {}, ctx)).success).toBe(true);
  });

  it("local_workspace effects never gate and never emit receipts", async () => {
    testState.effectContracts = "enforce";
    registerEffectTool("web_search", { reversibility: "irreversible", domain: "local_workspace" });
    const { events, stop } = captureAudits(["effect_receipt"]);
    const result = await executeTool("web_search", {}, ctx);
    stop();
    expect(result.success).toBe(true);
    expect(events).toEqual([]);
  });

  it("a TIMED-OUT external mutation records outcome UNKNOWN — never assumed un-executed", async () => {
    testState.effectContracts = "shadow";
    registerEffectTool("web_search", {
      reversibility: "idempotent",
      timeoutMs: 50,
      execute: () => new Promise((resolve) => setTimeout(() => resolve({ success: true, output: "late" }), 5_000).unref()),
    });
    const { events, stop } = captureAudits(["effect_receipt"]);
    const result = await executeTool("web_search", {}, ctx);
    stop();
    expect(result.success).toBe(false);
    const receipt = events.find((e) => e.type === "effect_receipt");
    expect(receipt?.data["outcome"]).toBe("unknown");
  });

  it("a FAILED (non-timeout) call records outcome failed", async () => {
    testState.effectContracts = "shadow";
    registerEffectTool("web_search", {
      reversibility: "irreversible",
      execute: async () => ({ success: false, output: "", error: "HTTP 500" }),
    });
    const { events, stop } = captureAudits(["effect_receipt"]);
    await executeTool("web_search", {}, ctx);
    stop();
    expect(events.find((e) => e.type === "effect_receipt")?.data["outcome"]).toBe("failed");
  });

  it("a tool that flags its OWN transport failure as dispatch-uncertain records UNKNOWN — the production path (no registry timeoutMs)", async () => {
    testState.effectContracts = "shadow";
    registerEffectTool("web_search", {
      reversibility: "irreversible",
      execute: async () => ({ success: false, output: "", error: "Webhook failed: AbortError: This operation was aborted", dispatchUncertain: true }),
    });
    const { events, stop } = captureAudits(["effect_receipt"]);
    await executeTool("web_search", {}, ctx);
    stop();
    const receipt = events.find((e) => e.type === "effect_receipt");
    expect(receipt?.data["outcome"]).toBe("unknown");
  });

  it("error TEXT mentioning a timeout does NOT produce unknown — only the structural flag does", async () => {
    testState.effectContracts = "shadow";
    registerEffectTool("web_search", {
      reversibility: "irreversible",
      // A received HTTP response whose body mentions a timeout is a TERMINAL
      // failure — the old substring heuristic misclassified this as unknown.
      execute: async () => ({ success: false, output: "", error: "Webhook returned HTTP 500: database query timed out after 5000ms; nothing written" }),
    });
    const { events, stop } = captureAudits(["effect_receipt"]);
    await executeTool("web_search", {}, ctx);
    stop();
    expect(events.find((e) => e.type === "effect_receipt")?.data["outcome"]).toBe("failed");
  });

  it("a throwing target resolver never breaks the call — the receipt just omits the target", async () => {
    testState.effectContracts = "shadow";
    registerTool({
      name: "web_search",
      description: "effect test tool",
      parameters: { type: "object", properties: {}, required: [] },
      effect: {
        domain: "web_mutation",
        reversibility: "irreversible",
        target: () => { throw new Error("resolver bug"); },
      },
      execute: async () => ({ success: true, output: "ok" }),
    });
    const { events, stop } = captureAudits(["effect_receipt"]);
    const result = await executeTool("web_search", {}, ctx);
    stop();
    expect(result.success).toBe(true);
    const receipt = events.find((e) => e.type === "effect_receipt");
    expect(receipt?.data["outcome"]).toBe("succeeded");
    expect(receipt?.data["target"]).toBeUndefined();
  });
});
