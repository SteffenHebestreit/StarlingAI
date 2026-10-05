import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A SUB-AGENT'S SETUP, BEFORE ITS FIRST MODEL CALL (finding 2026-10-05).
 *
 * Two things measured on real dispatches of one agent:
 *  - the setup lookups (memory guidance, skill guidance, the tool order, the peer-message claim, the
 *    shared facts) run together, not one after another — observed as the skill lookup starting
 *    while the memory lookup is still out;
 *  - the tool order a run sends is the agent's held ranking: a second dispatch whose embedder fails
 *    sends the same order as the first, instead of falling back to registration order and paying a
 *    cold prefill for a rotated tool block.
 */

const events: string[] = [];
/** A fact a sibling publishes while this run is still setting up (set per test). */
let publishDuringSetup: { session: string; key: string; value: string } | null = null;
const completeMock = vi.fn();
const embedder = { fail: false };

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeMock(messages, tools, signal);
    }
  },
}));

vi.mock("../memory/service.js", async (importActual) => ({
  ...(await importActual<typeof import("../memory/service.js")>()),
  formatScopedMemoryGuidance: async () => {
    events.push("memory:start");
    const publish = publishDuringSetup;
    if (publish) {
      setTimeout(() => {
        void import("../swarm/memory.js").then((memory) => memory.writeSharedFact(publish.session, publish.key, publish.value));
      }, 10);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    events.push("memory:end");
    return "";
  },
}));

vi.mock("../skills/service.js", async (importActual) => ({
  ...(await importActual<typeof import("../skills/service.js")>()),
  formatSkillGuidance: async () => {
    events.push("skill:start");
    await new Promise((resolve) => setTimeout(resolve, 40));
    events.push("skill:end");
    return "";
  },
}));

/** Each tool lands at its own angle; the role statement points somewhere in between. */
function vectorFor(text: string): Float32Array {
  const match = /^Tool: (\S+)/.exec(text);
  if (!match) return new Float32Array([Math.cos(1.1), Math.sin(1.1)]);
  const angle = [...match[1]!].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 157 / 50;
  return new Float32Array([Math.cos(angle), Math.sin(angle)]);
}

vi.mock("../providers/embeddings.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/embeddings.js")>()),
  isEmbeddingAvailable: () => true,
  computeQueryEmbedding: async (text: string) => {
    if (!text.startsWith("Tool: ") && embedder.fail) throw new Error("embedder down");
    return vectorFor(text);
  },
}));

const AGENT = "setup_probe";
const TOOLS = ["write_file", "edit_file", "read_file", "list_files", "create_dir", "web_search", "web_fetch", "http_request"];

describe("sub-agent setup before the first model call", () => {
  let dir = "";
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sai-setup-lookups-"));
    writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
      skillLibrary: { enabled: true },
      subAgents: {
        [AGENT]: {
          description: "Probe specialist that exercises the sub-agent setup.",
          systemPrompt: "You are a probe.",
          tools: TOOLS,
          maxIterations: 2,
          turnTimeoutMs: 60_000,
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    // The agent's tools register on import, as they do in the gateway.
    await import("../tools/filesystem.js");
    await import("../tools/web.js");
    completeMock.mockImplementation(() => ({
      content: "Done.",
      tool_calls: [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    }));
  });
  afterAll(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    (await import("../config/loader.js")).resetConfigForTests();
  });

  /** One dispatch; returns the tool names its first model call was sent, in order. */
  const dispatch = async (task: string, parentSessionId = `parent-${Math.random().toString(36).slice(2)}`): Promise<string[]> => {
    completeMock.mockClear();
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    await runSubAgentWithStats({ agentName: AGENT, task, parentSessionId, workspacePath: dir });
    const tools = (completeMock.mock.calls[0]?.[1] ?? []) as Array<{ name: string }>;
    return tools.map((tool) => tool.name);
  };

  it("starts the skill lookup while the memory lookup is still out", async () => {
    events.length = 0;
    await dispatch("Summarise the quarterly revenue spreadsheet.");
    expect(events.indexOf("skill:start")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("skill:start")).toBeLessThan(events.indexOf("memory:end"));
  });

  it("composes the first message with a fact a sibling published while the run was setting up", async () => {
    // The shared facts are read where the first message is composed, not with the setup lookups at
    // its start: a fact published in between (here 10 ms in, while the memory lookup is still out)
    // otherwise reached the run only after its first tool round, or never.
    const parent = `parent-facts-${Math.random().toString(36).slice(2)}`;
    publishDuringSetup = { session: parent, key: "sibling_finding", value: "PUBLISHED-DURING-SETUP" };
    try {
      await dispatch("Summarise the quarterly revenue spreadsheet.", parent);
    } finally {
      publishDuringSetup = null;
    }
    const firstMessages = (completeMock.mock.calls[0]?.[0] ?? []) as Array<{ role: string; content: unknown }>;
    const firstUser = firstMessages.find((m) => m.role === "user");
    expect(String(firstUser?.content ?? "")).toContain("PUBLISHED-DURING-SETUP");
  });

  it("sends the same tool order on a second dispatch whose embedder fails", async () => {
    const { getToolsAsLLMDefs } = await import("../tools/registry.js");
    const registrationOrder = getToolsAsLLMDefs(TOOLS).map((tool) => tool.name);

    embedder.fail = false;
    const first = await dispatch("Deploy the nginx container to staging.");
    // The discriminator: the ranked order is not the order a failed rerank falls back to.
    expect(first.length).toBeGreaterThan(6);
    expect(first).not.toEqual(registrationOrder);

    embedder.fail = true;
    const second = await dispatch("Reconcile the quarterly revenue totals.");
    expect(second).toEqual(first);
  });
});
