import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ALWAYS_AVAILABLE_MAIN_TOOL_NAMES } from "../agent/default-tools.js";
import { getToolTier, ToolTier } from "../guardrails/tool-tiers.js";
import { executeTool, type ToolContext } from "../tools/registry.js";

/**
 * "SCHALTE AUF CLAUDE UM" CHANGES THE MODEL FOR EVERYONE, AND IT MAY BE A PAID ONE.
 * Driven through the real tool path, with an in-memory config behind the real schema: the approval
 * in front of the tool is part of what is under test, and the proof that a refusal changed nothing
 * is that no write happened.
 */
const state = vi.hoisted(() => ({
  raw: {} as Record<string, unknown>,
  writes: 0,
  audit: [] as Array<Record<string, unknown>>,
}));

vi.mock("../config/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/loader.js")>();
  const { ConfigSchema } = await import("../config/schema.js");
  const parsed = () => ConfigSchema.parse(state.raw);
  return {
    ...original,
    getConfig: vi.fn(parsed),
    updateConfig: vi.fn((mutate: (raw: Record<string, unknown>) => void) => {
      mutate(state.raw);
      state.writes += 1;
      return parsed();
    }),
  };
});

vi.mock("../audit/logger.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../audit/logger.js")>(),
  logAudit: vi.fn((event: string, details: Record<string, unknown>) => {
    if (event === "model_preset_switched") state.audit.push(details);
  }),
}));

vi.mock("../gateway/auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../gateway/auth.js")>(),
  verifyToken: vi.fn(async () => true),
}));

await import("../tools/model-switch.js");
const { registerModelPresetRoutes } = await import("../gateway/model-preset-routes.js");

function configure(options: {
  authEnabled?: boolean;
  anthropic?: boolean;
  active?: string;
  presets?: Record<string, { primary: string; label?: string }>;
} = {}): void {
  state.raw = {
    ...(options.anthropic === false ? {} : { providers: { anthropic: { apiKey: "sk-ant-api03-test", defaultModel: "claude-test" } } }),
    agents: {
      defaults: {
        model: { primary: "lmstudio/qwen" },
        ...(options.active ? { activeModelPreset: options.active } : {}),
        ...(options.presets ? { modelPresets: options.presets } : {}),
      },
    },
    ...(options.authEnabled ? { auth: { enabled: true, token: "x".repeat(32) } } : {}),
  };
  state.writes = 0;
  state.audit = [];
}

const activePreset = (): unknown => (state.raw["agents"] as { defaults: Record<string, unknown> }).defaults["activeModelPreset"];

const approve = vi.fn(async () => true);
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  sessionId: "session-1",
  approvalCallback: approve,
  ...over,
} as ToolContext);

beforeEach(() => {
  configure();
  approve.mockClear();
});

describe("the gate in front of switch_model", () => {
  it("is on the orchestrator's list, at the privileged tier, with approval on every call", () => {
    expect(ALWAYS_AVAILABLE_MAIN_TOOL_NAMES).toContain("switch_model");
    expect(getToolTier("switch_model")).toMatchObject({ tier: ToolTier.THREE_PRIVILEGED, requiresPerCallApproval: true });
  });

  it("asks before it switches, naming the setup", async () => {
    const result = await executeTool("switch_model", { preset: "claude" }, ctx());
    expect(result.success).toBe(true);
    expect(approve).toHaveBeenCalledWith("switch_model", { preset: "claude" });
    expect(activePreset()).toBe("claude");
  });

  it("changes nothing when the user declines", async () => {
    const result = await executeTool("switch_model", { preset: "claude" }, ctx({ approvalCallback: async () => false }));
    expect(result.success).toBe(false);
    expect(state.writes).toBe(0);
  });

  it("changes nothing in a turn nobody can approve in", async () => {
    const result = await executeTool("switch_model", { preset: "claude" }, ctx({ approvalCallback: undefined }));
    expect(result.success).toBe(false);
    expect(state.writes).toBe(0);
  });
});

describe("who may switch", () => {
  it("under multi-user auth an admin may", async () => {
    configure({ authEnabled: true });
    expect((await executeTool("switch_model", { preset: "claude" }, ctx({ userRole: "admin" }))).success).toBe(true);
    expect(activePreset()).toBe("claude");
  });

  it.each([
    ["an operator, every account's default role", "operator"],
    ["a viewer", "viewer"],
    ["a role nobody knows", "someone"],
    ["a turn with no role at all, as on a channel", undefined],
  ])("under multi-user auth %s may not", async (_who, userRole) => {
    configure({ authEnabled: true });
    const result = await executeTool("switch_model", { preset: "claude" }, ctx({ userRole }));
    expect(result.success).toBe(false);
    expect(result.error).toContain("admin");
    // In the lab a retry tripped the blocked-calls brake, which sent a specialist looking for the
    // config files. The refusal has to end it.
    expect(result.error).toContain("do not try again or look for another way");
    expect(state.writes).toBe(0);
  });

  it("without auth there is one operator, and no role to ask for", async () => {
    expect((await executeTool("switch_model", { preset: "claude" }, ctx())).success).toBe(true);
  });
});

describe("what it switches to", () => {
  it("says what now runs, for whom and from when", async () => {
    const result = await executeTool("switch_model", { preset: "Claude" }, ctx());
    expect(activePreset()).toBe("claude");
    expect(result.output).toContain("anthropic/claude-test");
    expect(result.output).toContain("every user");
    expect(result.output).toContain("next message");
    expect(state.audit).toEqual([expect.objectContaining({ from: null, to: "claude", via: "chat" })]);
  });

  it("goes back to the configured models by \"default\"", async () => {
    configure({ active: "claude" });
    const result = await executeTool("switch_model", { preset: "default" }, ctx());
    expect(activePreset()).toBe("");
    expect(result.output).toContain("lmstudio/qwen");
    expect(state.audit).toEqual([expect.objectContaining({ from: "claude", to: null })]);
  });

  it("names what there is when asked for something else, and changes nothing", async () => {
    const result = await executeTool("switch_model", { preset: "gpt" }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("claude, default");
    expect(state.writes).toBe(0);
  });

  it("offers no Claude where none is connected", async () => {
    configure({ anthropic: false });
    const result = await executeTool("switch_model", { preset: "claude" }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("There is: default.");
    expect(state.writes).toBe(0);
  });

  it.each([
    ["the preset already active", { active: "claude" }, "claude"],
    ["the configured models with no preset active", {}, "default"],
  ])("writes nothing for %s", async (_case, options, preset) => {
    configure(options);
    const result = await executeTool("switch_model", { preset }, ctx());
    expect(result.success).toBe(true);
    expect(result.output).toContain("Nothing changed");
    expect(state.writes).toBe(0);
    expect(state.audit).toEqual([]);
  });

  it("reaches a preset someone named \"default\" by that name", async () => {
    configure({ presets: { default: { primary: "openrouter/some-model" } } });
    await executeTool("switch_model", { preset: "default" }, ctx());
    expect(activePreset()).toBe("default");
  });
});

describe("the dashboard's switch, on the same code", () => {
  const app = new Hono();
  registerModelPresetRoutes(app);
  const post = (body: unknown) => app.request("/api/models/preset", {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  it("activates a preset and says it came from there", async () => {
    const res = await post({ preset: "claude" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ active: "claude", activePrimary: "anthropic/claude-test" });
    expect(state.audit).toEqual([expect.objectContaining({ to: "claude", via: "dashboard" })]);
  });

  it("goes back to the default on null", async () => {
    configure({ active: "claude" });
    const res = await post({ preset: null });
    expect(await res.json()).toMatchObject({ active: null, defaultPrimary: "lmstudio/qwen" });
    expect(activePreset()).toBe("");
  });

  it("changes the scope without touching the preset", async () => {
    configure({ active: "claude" });
    const res = await post({ scope: "coordinator_qa" });
    expect(await res.json()).toMatchObject({ active: "claude", scope: "coordinator_qa" });
    expect(state.audit).toEqual([expect.objectContaining({ scopeFrom: "all", scopeTo: "coordinator_qa", to: "claude" })]);
  });

  it("refuses an unknown preset or scope without writing", async () => {
    expect((await post({ preset: "gpt" })).status).toBe(400);
    expect((await post({ scope: "some" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(state.writes).toBe(0);
  });
});
