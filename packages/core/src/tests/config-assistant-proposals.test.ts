import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAIN_ASSISTANT_PROMPT_TARGET,
  applyPromptChange,
  appendConversationConfigProposalFeedback,
  applyObjectPath,
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
      agents: { defaults: { model: Record<string, unknown> }; subAgents: Record<string, { model: Record<string, unknown> }> };
    };
    expect(snapshot.agents.defaults.model.maxTokens).toBe(2048);
    expect(snapshot.agents.subAgents["coder"]?.model.maxTokens).toBe(4096);
    for (const secret of ["sk-default-key", "sk-coder-key", "sk-rerank-key", "pve-password", "pve-token-secret", "hook-header-secret", "s".repeat(40)]) {
      expect(prompts[0]).not.toContain(secret);
    }
  });
});
