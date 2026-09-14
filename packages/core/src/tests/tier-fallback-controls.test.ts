import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A TIER-SHAPED CALL WITH NO TIER MUST NOT BORROW THE ORCHESTRATOR.
 *
 * getChatProviderForTier returns null when no tier model is configured — and, since the preset
 * branch was withdrawn, for EVERY call while a model preset is active (the dashboard Local ⇄
 * Claude switch). Under `?? provider` that null sent the call to the turn's orchestrator
 * instance, which runs thinking ON: a final-answer rewrite from evidence already sitting in the
 * context then reasoned its way through a call it has all the material for.
 *
 * The rule now is the same one the sub-agent uses: build from the CALLER'S OWN merged model
 * config with the tier's controls laid over it. forceSynthesis takes a ChatProvider, not a
 * config, so its own config is the orchestrator's — agents.defaults.model with the active preset
 * applied (the main assistant has no model block of its own).
 *
 * The assertion is on the mechanism: the ModelConfig object handed to createChatProvider, and
 * which instance actually received the completion.
 */

const createdConfigs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const orchestratorCompleteMock = vi.hoisted(() => vi.fn(async () => ({
  content: "the orchestrator wrote this",
  tool_calls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
})));
const fallbackCompleteMock = vi.hoisted(() => vi.fn(async () => ({
  content: "the fallback instance wrote this",
  tool_calls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
})));
/** Is a synthesis tier configured? Null is the case under test (and the case under a preset). */
const tierState = vi.hoisted(() => ({ synthesisTierAvailable: false }));
const tierCompleteMock = vi.hoisted(() => vi.fn(async () => ({
  content: "the synthesis tier wrote this",
  tool_calls: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  finishReason: "stop",
})));

vi.mock("../providers/index.js", () => {
  const base = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    stream: () => (async function* () { /* unused */ })(),
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    applyActiveModelPreset: (model: Record<string, unknown>) => model,
    tierModelDefaults: (tier: string) => (tier === "routing" ? { enableThinking: false, reasoningEffort: "none" } : {}),
    resolveProviderEndpoint: () => ({ providerId: "lmstudio", model: "lmstudio/qwen", baseUrl: "http://x/v1", apiKey: "k", priority: "primary" }),
    // The factory under observation: what config does the fallback build from?
    createChatProvider: (modelConfig: Record<string, unknown>) => {
      createdConfigs.push(modelConfig);
      return { ...base, complete: fallbackCompleteMock };
    },
    getChatProvider: () => ({ ...base, complete: orchestratorCompleteMock }),
    getChatProviderWithOverride: () => ({ ...base, complete: orchestratorCompleteMock }),
    getChatProviderForTier: (tier: string) => (tier === "synthesis" && tierState.synthesisTierAvailable
      ? { ...base, complete: tierCompleteMock }
      : null),
  };
});
vi.mock("../audit/logger.js", () => ({ logAudit: vi.fn() }));

async function loadRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "sai-tier-fallback-"));
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    agents: { defaults: { model: { primary: "lmstudio/qwen", contextWindow: 65536, enableThinking: true, temperature: 0.7 } } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  const [{ AgentSession }, runtime] = await Promise.all([
    import("../agent/session.js"),
    import("../agent/runtime.js"),
  ]);
  return { AgentSession, forceSynthesis: runtime.forceSynthesis };
}

describe("forceSynthesis with no synthesis tier — builds its own thinking-off instance", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    createdConfigs.length = 0;
    orchestratorCompleteMock.mockClear();
    fallbackCompleteMock.mockClear();
    tierCompleteMock.mockClear();
    tierState.synthesisTierAvailable = false;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  it("runs the rewrite on a provider built from the orchestrator's own config with thinking off", async () => {
    const { AgentSession, forceSynthesis } = await loadRuntime();
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    session.addMessage({ role: "user", content: "what did the research say?" });
    session.addMessage({ role: "assistant", content: "…" });
    session.addMessage({ role: "tool", content: "evidence: the answer is 42" });

    const orchestrator = { complete: orchestratorCompleteMock } as never;
    const out = await forceSynthesis(session, orchestrator, new AbortController().signal, "Write the final answer.");

    // The call did NOT go to the turn's orchestrator instance.
    expect(orchestratorCompleteMock, "the synthesis rewrite ran on the thinking-on orchestrator").not.toHaveBeenCalled();
    expect(fallbackCompleteMock).toHaveBeenCalledTimes(1);
    expect(out).toBe("the fallback instance wrote this");

    // It went to an instance built from the orchestrator's own merged model config — same model,
    // same context window — with thinking switched off both ways (the qwen family honours
    // enable_thinking; reasoningEffort covers a model swap).
    expect(createdConfigs).toHaveLength(1);
    expect(createdConfigs[0]).toMatchObject({
      primary: "lmstudio/qwen",
      contextWindow: 65536,
      temperature: 0.7,
      enableThinking: false,
      reasoningEffort: "none",
    });
  });

  it("still prefers a configured synthesis tier, and builds nothing when there is one", async () => {
    tierState.synthesisTierAvailable = true;
    const { AgentSession, forceSynthesis } = await loadRuntime();
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    session.addMessage({ role: "user", content: "what did the research say?" });
    session.addMessage({ role: "assistant", content: "…" });
    session.addMessage({ role: "tool", content: "evidence: the answer is 42" });

    const orchestrator = { complete: orchestratorCompleteMock } as never;
    const out = await forceSynthesis(session, orchestrator, new AbortController().signal, "Write the final answer.");

    expect(out).toBe("the synthesis tier wrote this");
    expect(tierCompleteMock).toHaveBeenCalledTimes(1);
    expect(createdConfigs, "a second instance was built while a synthesis tier was configured").toHaveLength(0);
    expect(orchestratorCompleteMock).not.toHaveBeenCalled();
  });
});

describe("the delegation-language normalizer with no routing tier — same rule, in the delegate tools", () => {
  it("builds a routing-shaped instance from the caller's own config instead of the orchestrator", async () => {
    await loadRuntime();
    const { delegationLanguageProvider } = await import("../tools/sub-agent.js");

    const provider = delegationLanguageProvider();

    // Not the orchestrator instance: a translate-and-tag micro-call must not reason.
    expect(createdConfigs).toHaveLength(1);
    expect(createdConfigs[0]).toMatchObject({
      primary: "lmstudio/qwen",
      contextWindow: 65536,
      enableThinking: false,
      reasoningEffort: "none",
    });
    await provider.complete([{ role: "user", content: "x" }], []);
    expect(fallbackCompleteMock).toHaveBeenCalledTimes(1);
    expect(orchestratorCompleteMock).not.toHaveBeenCalled();
  });

  it("is what both delegate tools call — the wiring, not just the helper", () => {
    const source = readFileSync(fileURLToPath(new URL("../tools/sub-agent.ts", import.meta.url)), "utf8");
    // delegate_to_agent and swarm_delegate. A refactor that puts getChatProvider() back keeps the
    // helper test green and silently restores the thinking-on call; this fails instead.
    expect(source.split("provider: delegationLanguageProvider()").length - 1).toBe(2);
    expect(source).not.toContain('getChatProviderForTier("routing") ?? getChatProvider()');
  });
});
