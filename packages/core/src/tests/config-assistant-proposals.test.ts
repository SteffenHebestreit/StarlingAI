import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAIN_ASSISTANT_PROMPT_TARGET,
  applyPromptChange,
  appendConversationConfigProposalFeedback,
  applyObjectPath,
  configChangeRefusal,
  createConversationConfigProposal,
  getConversationConfigProposal,
  hasPromptTarget,
  isProtectedConfigChange,
  isProtectedConfigPath,
  listConversationConfigProposals,
  updateConversationConfigProposal,
} from "../agent/config-assistant-proposals.js";

describe("config assistant proposals", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists proposals, feedback, and applies object-path updates", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-config-proposals-"));
    dirs.push(workspacePath);

    const proposal = createConversationConfigProposal(workspacePath, {
      status: "pending",
      mode: "prompt",
      request: "Make the browser agent stop looping on stable pages",
      summary: "Append a stop condition to the browser agent prompt.",
      assistantAgent: "prompt_optimizer",
      targetAgent: "browser_agent",
      configChanges: [{
        path: "retrieval.search.backend",
        value: "duckduckgo",
        reason: "Use a simpler fallback backend during troubleshooting.",
      }],
      promptChanges: [{
        agentName: "browser_agent",
        strategy: "append",
        prompt: "Treat stable page state as a stop signal and hand off interpretation.",
        rationale: "Prevents repeat-click loops.",
      }],
      validations: ["Review the prompt wording before applying."],
      tags: ["browser", "prompt"],
      lesson: "Stop retrying when the page state is unchanged.",
    });

    expect(getConversationConfigProposal(workspacePath, proposal.id)?.summary).toContain("Append a stop condition");
    expect(listConversationConfigProposals(workspacePath, 10)).toHaveLength(1);

    const withFeedback = appendConversationConfigProposalFeedback(workspacePath, proposal.id, {
      outcome: "partial",
      lesson: "The prompt helped, but the browser agent still needs a stronger evidence handoff rule.",
    });
    expect(withFeedback?.feedbackHistory).toHaveLength(1);

    const applied = updateConversationConfigProposal(workspacePath, proposal.id, (current) => ({
      ...current,
      status: "applied",
      appliedAt: "2026-03-30T12:00:00.000Z",
    }));
    expect(applied?.status).toBe("applied");

    const raw: Record<string, unknown> = {};
    applyObjectPath(raw, "subAgents.browser_agent.systemPrompt", "Updated prompt");
    expect(raw).toEqual({
      subAgents: {
        browser_agent: {
          systemPrompt: "Updated prompt",
        },
      },
    });

    const promptRaw: Record<string, unknown> = {
      agents: {
        mainAssistant: {
          customInstructions: "Keep answers terse.",
        },
      },
    };
    applyPromptChange(promptRaw, {
      agentName: MAIN_ASSISTANT_PROMPT_TARGET,
      strategy: "append",
      prompt: "Ask for confirmation before destructive changes.",
      rationale: "Add a stronger safety cue for the primary assistant.",
    });
    expect(promptRaw).toEqual({
      agents: {
        mainAssistant: {
          customInstructions: "Keep answers terse.\n\nAsk for confirmation before destructive changes.",
        },
      },
    });

    expect(isProtectedConfigPath("providers.lmstudio.apiKey")).toBe(true);
    expect(isProtectedConfigPath("subAgents.browser_agent.systemPrompt")).toBe(false);
    expect(isProtectedConfigPath("agents.mainAssistant.customInstructions")).toBe(false);
    expect(hasPromptTarget({}, MAIN_ASSISTANT_PROMPT_TARGET)).toBe(true);
  });

  it("merges an object value into what is at its path, so a change sets only what it names", () => {
    // Replaced whole, a map copied from the assistant's snapshot (each agent shown only in part) took
    // every agent's systemPrompt and tools, and a sub-agent's model lost its contextWindow (final
    // review of the leftovers, 1).
    const raw: Record<string, unknown> = {
      subAgents: {
        coder: { description: "Writes code.", systemPrompt: "Be exact.", tools: ["write_file"], model: { primary: "lmstudio/a", contextWindow: 32768, temperature: 0.7 } },
        researcher: { description: "Finds facts.", systemPrompt: "Cite.", tools: ["web_search"] },
      },
    };
    applyObjectPath(raw, "subAgents.coder.model", { primary: "lmstudio/b", temperature: 0.2 });
    applyObjectPath(raw, "subAgents", { coder: { description: "Writes careful code." } });
    expect(raw["subAgents"]).toEqual({
      coder: { description: "Writes careful code.", systemPrompt: "Be exact.", tools: ["write_file"], model: { primary: "lmstudio/b", contextWindow: 32768, temperature: 0.2 } },
      researcher: { description: "Finds facts.", systemPrompt: "Cite.", tools: ["web_search"] },
    });
    // null clears; arrays and scalars replace.
    applyObjectPath(raw, "subAgents.coder", { tools: ["read_file"], model: { temperature: null } });
    applyObjectPath(raw, "subAgents.researcher", null);
    expect(raw["subAgents"]).toEqual({
      coder: { description: "Writes careful code.", systemPrompt: "Be exact.", tools: ["read_file"], model: { primary: "lmstudio/b", contextWindow: 32768 } },
    });
  });

  it("reads a path as the setter does, and says why a misplaced sub-agent path is refused", () => {
    // Split raw, "agents. subAgents" passed the check and was written as agents.subAgents all the
    // same (final review of the leftovers, 2).
    for (const path of ["agents. subAgents.coder.model.temperature", "agents..subAgents.coder", "agents.subAgents .coder", " Agents.SubAgents"]) {
      expect(isProtectedConfigPath(path), path).toBe(true);
    }
    // In words the person can act on, not "a protected path" (final review of the leftovers, 4).
    expect(configChangeRefusal({ path: "agents.subAgents.coder.model.temperature", value: 0.2 }))
      .toBe("'agents.subAgents.coder.model.temperature' is not where sub-agents live: their settings are at subAgents.<name>, so this change would do nothing.");
    expect(configChangeRefusal({ path: "providers.lmstudio.baseUrl", value: "x" })).toBe("'providers.lmstudio.baseUrl' is a protected path or sets a credential.");
    expect(configChangeRefusal({ path: "subAgents.coder.model.temperature", value: 0.2 })).toBeUndefined();
  });

  it("counts a field as a credential only when its name ends in one", () => {
    // Matched anywhere in the name, "token" caught maxTokens — a knob the assistant's snapshot
    // lists — and a proposal that set it was refused as a protected path.
    expect(isProtectedConfigPath("subAgents.coder.model.maxTokens")).toBe(false);
    expect(isProtectedConfigChange({ path: "subAgents.coder.model", value: { primary: "lmstudio/x", temperature: 0.2, maxTokens: 4096 } })).toBe(false);
    expect(isProtectedConfigChange({ path: "subAgents.new_agent", value: { description: "d", model: { maxTokens: 8000 } } })).toBe(false);
    expect(isProtectedConfigPath("agents.defaults.model.embeddingApiKey")).toBe(true);
    expect(isProtectedConfigPath("subAgents.coder.model.apiKey")).toBe(true);
    expect(isProtectedConfigChange({ path: "subAgents.coder.model", value: { primary: "lmstudio/x", apiKey: "k" } })).toBe(true);
    expect(isProtectedConfigChange({ path: "subAgents.coder", value: { model: { authToken: "t" } } })).toBe(true);
  });
});

/**
 * Drafting filtered by path only, while Apply also refuses a value that carries a credential
 * field: the page offered `subAgents.x.model = { apiKey }` as applyable and Apply then refused it.
 * Now both ask isProtectedConfigChange.
 */
describe("config assistant drafting", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.doUnmock("../providers/index.js");
    (await import("../config/loader.js")).resetConfigForTests();
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_MUTABLE_CONFIG_PATH"];
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("offers exactly what Apply accepts", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-config-draft-"));
    dirs.push(tempDir);
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      gateway: { jwtSecret: "s".repeat(40) },
      workspacePath: tempDir,
      subAgents: { coder: { description: "Writes code.", model: { primary: "lmstudio/coder" } } },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    process.env["SAI_MUTABLE_CONFIG_PATH"] = configPath;
    const configChanges = [
      { path: "subAgents.coder.model", value: { primary: "lmstudio/coder", apiKey: "sk-in-a-value" }, reason: "Give the coder its own key." },
      { path: "subAgents.coder.model.maxTokens", value: 4096, reason: "Longer answers." },
    ];
    vi.resetModules();
    vi.doMock("../providers/index.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../providers/index.js")>()),
      createChatProvider: () => ({
        complete: async () => ({ content: JSON.stringify({ summary: "Tune the coder.", configChanges }) }),
      }),
    }));
    const { proposeConversationConfigChange } = await import("../agent/config-assistant.js");
    const { draft } = await proposeConversationConfigChange({ request: "tune the coder", mode: "enhancement", workspacePath: tempDir });
    expect(draft.configChanges.map((change) => change.path)).toEqual(["subAgents.coder.model.maxTokens"]);
    expect(draft.configChanges.every((change) => !isProtectedConfigChange(change))).toBe(true);
    expect(draft.validations.join(" ")).toContain("'subAgents.coder.model'");
  });

  // A peer's agent is loaded but not saved, so a change aimed at it was offered and Apply refused it
  // as a proposal that "does not leave a valid config" (r5 A-security).
  it("leaves out a change aimed at an A2A peer's agent, and says why", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-config-draft-peer-"));
    dirs.push(tempDir);
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      gateway: { jwtSecret: "s".repeat(40) },
      workspacePath: tempDir,
      subAgents: { coder: { description: "Writes code." } },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    process.env["SAI_MUTABLE_CONFIG_PATH"] = configPath;
    const reply = {
      summary: "Terser answers.",
      configChanges: [
        { path: "subAgents.a2a__peer__skill.model.temperature", value: 0.2, reason: "Steadier." },
        { path: "subAgents.coder.model.temperature", value: 0.2, reason: "Steadier." },
      ],
      promptChanges: [
        { agentName: "a2a__peer__skill", strategy: "append", prompt: "Be terser.", rationale: "Asked for." },
        { agentName: "coder", strategy: "append", prompt: "Be terser.", rationale: "Asked for." },
      ],
    };
    vi.resetModules();
    vi.doMock("../providers/index.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../providers/index.js")>()),
      createChatProvider: () => ({ complete: async () => ({ content: JSON.stringify(reply) }) }),
    }));
    // As the A2A client registers a peer's skill.
    (await import("../config/loader.js")).setRuntimeSubAgent("a2a__peer__skill", { description: "[A2A:peer] A peer's skill.", tools: [] } as never);
    const { proposeConversationConfigChange } = await import("../agent/config-assistant.js");
    const { draft } = await proposeConversationConfigChange({ request: "be terser", mode: "enhancement", workspacePath: tempDir });
    expect(draft.configChanges.map((change) => change.path)).toEqual(["subAgents.coder.model.temperature"]);
    expect(draft.promptChanges.map((change) => change.agentName)).toEqual(["coder"]);
    const said = "Agent 'a2a__peer__skill' is bridged in from an A2A peer and runs there, so its prompt and settings are the peer's to change, not ours.";
    expect(draft.validations).toEqual(expect.arrayContaining([`Excluded 'subAgents.a2a__peer__skill.model.temperature': ${said}`, `Prompt proposal ignored: ${said}`]));
  });

  // Told apart as "loaded but not on disk", each check parsed the config on disk again, and an agent
  // deleted on disk but not yet reloaded was called a peer's (review of r6 leftovers, 2).
  it("calls an agent a peer's only when the A2A client bridged it in, whatever the config on disk says", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-config-peer-check-"));
    dirs.push(tempDir);
    const configPath = join(tempDir, "starlingai.json");
    const saved = { gateway: { jwtSecret: "s".repeat(40) }, workspacePath: tempDir };
    writeFileSync(configPath, JSON.stringify({ ...saved, subAgents: { coder: { description: "Writes code." } } }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    process.env["SAI_MUTABLE_CONFIG_PATH"] = configPath;
    vi.resetModules();
    const loader = await import("../config/loader.js");
    const { peerAgentRefusal } = await import("../agent/config-assistant-proposals.js");
    loader.setRuntimeSubAgent("a2a__peer__skill", { description: "[A2A:peer] A peer's skill.", tools: [] } as never);
    // The coder deleted on disk, and not yet reloaded.
    writeFileSync(configPath, JSON.stringify({ ...saved, subAgents: {} }), "utf8");
    expect(loader.getConfig().subAgents["coder"]).toBeDefined();
    expect(peerAgentRefusal(["coder"])).toBeUndefined();
    // Nor is the disk read: with the file unreadable, the peer's agent is still refused.
    writeFileSync(configPath, "{ not json", "utf8");
    expect(peerAgentRefusal(["coder", "a2a__peer__skill"])).toContain("Agent 'a2a__peer__skill' is bridged in from an A2A peer");
  });

  // A change to the whole sub-agent map named no agent, so it was offered even when it wrote a peer's
  // agent into the saved config (review of r6 leftovers, 3). Leaving the peers' agents out is no
  // hazard — a save cannot drop one, the next load lays it back over — and counting those refused
  // every whole-map change while any peer was bridged (round 2 of that review, LOW 1).
  it("leaves out a change to the whole sub-agent map that writes a peer's agent, and only that", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-config-draft-map-"));
    dirs.push(tempDir);
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      gateway: { jwtSecret: "s".repeat(40) },
      workspacePath: tempDir,
      subAgents: { coder: { description: "Writes code." } },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    process.env["SAI_MUTABLE_CONFIG_PATH"] = configPath;
    let configChanges: Array<{ path: string; value: unknown; reason: string }> = [];
    vi.resetModules();
    vi.doMock("../providers/index.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../providers/index.js")>()),
      createChatProvider: () => ({ complete: async () => ({ content: JSON.stringify({ summary: "Replace the agents.", configChanges }) }) }),
    }));
    const loader = await import("../config/loader.js");
    const { proposeConversationConfigChange } = await import("../agent/config-assistant.js");
    const draftMap = async (value: unknown) => {
      configChanges = [{ path: "subAgents", value, reason: "Asked for." }];
      return (await proposeConversationConfigChange({ request: "replace the agents", mode: "enhancement", workspacePath: tempDir })).draft;
    };
    const coderOnly = { coder: { description: "Writes code." } };
    // With no peer's agent bridged in, it is offered.
    expect((await draftMap(coderOnly)).configChanges.map((change) => change.path)).toEqual(["subAgents"]);
    loader.setRuntimeSubAgent("a2a__peer__skill", { description: "[A2A:peer] A peer's skill.", tools: [] } as never);
    const said = "Excluded 'subAgents': Agent 'a2a__peer__skill' is bridged in from an A2A peer and runs there, so its prompt and settings are the peer's to change, not ours.";
    // The map that leaves the peer's agent out is still offered.
    expect((await draftMap(coderOnly)).configChanges.map((change) => change.path)).toEqual(["subAgents"]);
    const draft = await draftMap({ ...coderOnly, a2a__peer__skill: { description: "Mine now.", tools: [] } });
    expect(draft.configChanges).toEqual([]);
    expect(draft.validations).toContain(said);
  });

  // The snapshot once showed sub-agents under `agents`, so the assistant drafted agents.subAgents.*
  // changes: applied without error, read by nothing (round 2 of the leftovers review, 2).
  it("refuses a change under agents.subAgents, which is not where the config keeps sub-agents", () => {
    expect(isProtectedConfigPath("agents.subAgents.coder.model.temperature")).toBe(true);
    expect(isProtectedConfigPath("agents.subAgents")).toBe(true);
    expect(isProtectedConfigPath("subAgents.coder.model.temperature")).toBe(false);
    expect(isProtectedConfigPath("agents.defaults.model.temperature")).toBe(false);
  });

  // Drafting leaves out every change aimed at a peer's agent, so shown one, the assistant drafted
  // changes that could never be offered (review of r6 leftovers, 4).
  it("shows the assistant no agent bridged in from an A2A peer", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-config-snapshot-peer-"));
    dirs.push(tempDir);
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      gateway: { jwtSecret: "s".repeat(40) },
      workspacePath: tempDir,
      subAgents: { coder: { description: "Writes code." } },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    process.env["SAI_MUTABLE_CONFIG_PATH"] = configPath;
    const prompts: string[] = [];
    vi.resetModules();
    vi.doMock("../providers/index.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../providers/index.js")>()),
      createChatProvider: () => ({
        complete: async (messages: Array<{ content: string }>) => {
          prompts.push(messages.map((message) => message.content).join("\n"));
          return { content: JSON.stringify({ summary: "Nothing to change.", configChanges: [] }) };
        },
      }),
    }));
    const loader = await import("../config/loader.js");
    loader.setRuntimeSubAgent("a2a__peer__skill", { description: "[A2A:peer] A peer's skill.", tools: [] } as never);
    const { proposeConversationConfigChange } = await import("../agent/config-assistant.js");
    await proposeConversationConfigChange({ request: "tune the agents", mode: "enhancement", workspacePath: tempDir });
    expect(loader.getConfig().subAgents["a2a__peer__skill"]).toBeDefined();
    const snapshot = JSON.parse(prompts[0]!.split("Safe configuration snapshot:\n")[1]!) as { subAgents: Record<string, unknown>; agents: Record<string, unknown> };
    expect(Object.keys(snapshot.subAgents)).toEqual(["coder"]);
    // At the top level, where the config keeps them — not under agents.
    expect(snapshot.agents["subAgents"]).toBeUndefined();
  });

  it("shows the assistant maxTokens in its snapshot, and none of the keys", async () => {
    // Redacted by "token" anywhere in the name, maxTokens never reached the snapshot the assistant
    // drafts from, though it is a knob drafting and Apply accept (r3 A-security #5).
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-config-snapshot-"));
    dirs.push(tempDir);
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      gateway: { jwtSecret: "s".repeat(40) },
      workspacePath: tempDir,
      agents: { defaults: { model: { primary: "lmstudio/orch", maxTokens: 2048, apiKey: "sk-default-key" } } },
      subAgents: { coder: { description: "Writes code.", model: { primary: "lmstudio/coder", maxTokens: 4096, apiKey: "sk-coder-key" } } },
      retrieval: { reranker: { enabled: false, baseUrl: "http://rerank.local/v1", apiKey: "sk-rerank-key" } },
      infrastructure: { virtualization: { profiles: {
        pve: { type: "proxmox", apiUrl: "https://pve.local:8006", node: "pve", password: "pve-password", tokenSecret: "pve-token-secret" },
        hook: { type: "webhook", url: "https://hook.local/vm", headers: { Authorization: "Bearer hook-header-secret" } },
      } } },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    process.env["SAI_MUTABLE_CONFIG_PATH"] = configPath;
    const prompts: string[] = [];
    vi.resetModules();
    vi.doMock("../providers/index.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../providers/index.js")>()),
      createChatProvider: () => ({
        complete: async (messages: Array<{ content: string }>) => {
          prompts.push(messages.map((message) => message.content).join("\n"));
          return { content: JSON.stringify({ summary: "Nothing to change.", configChanges: [] }) };
        },
      }),
    }));
    const { proposeConversationConfigChange } = await import("../agent/config-assistant.js");
    await proposeConversationConfigChange({ request: "tune the coder", mode: "enhancement", workspacePath: tempDir });
    expect(prompts).toHaveLength(1);
    const snapshot = JSON.parse(prompts[0]!.split("Safe configuration snapshot:\n")[1]!) as {
      agents: { defaults: { model: Record<string, unknown> } };
      subAgents: Record<string, { model: Record<string, unknown> }>;
    };
    expect(snapshot.agents.defaults.model.maxTokens).toBe(2048);
    expect(snapshot.subAgents["coder"]?.model.maxTokens).toBe(4096);
    for (const secret of ["sk-default-key", "sk-coder-key", "sk-rerank-key", "pve-password", "pve-token-secret", "hook-header-secret", "s".repeat(40)]) {
      expect(prompts[0]).not.toContain(secret);
    }
  });
});
