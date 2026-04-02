import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
});